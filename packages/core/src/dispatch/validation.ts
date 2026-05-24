/**
 * SSoT input validator over {@link OperationInputContract}.
 *
 * This module is the SINGLE SOURCE OF TRUTH for validating raw operation
 * payloads against the schema-first {@link OperationInputContract} surface
 * introduced by T9914. It powers the `mutate(operation, input)` DX (Saga
 * T9855 / E7) and feeds into the CLI transport adapter (T9916) plus every
 * future per-operation retrofit (T9917+).
 *
 * Implementation notes:
 * - Uses AJV draft-07 with `allErrors: true` so callers get every failure
 *   in a single pass — never bail on the first.
 * - Caches compiled validators in a Map keyed by `contract.operation`
 *   because re-compiling AJV per invocation is the dominant hot-path cost.
 * - Maps AJV errors into the wire-stable {@link ValidationError} shape with
 *   JSON Pointer paths, per-keyword human-readable expected/received/fix
 *   text, stable `E_VAL_<KEYWORD>` codes, and `x-fix-hint` overrides walked
 *   off the contract schema by `schemaPath`.
 *
 * @packageDocumentation
 * @module @cleocode/core/dispatch/validation
 *
 * @epic T9855
 * @task T9915
 */

import type {
  OperationInputContract,
  ValidationError,
  ValidationResult,
} from '@cleocode/contracts';
import type { Ajv as AjvInstance, ErrorObject, ValidateFunction } from 'ajv';
import { default as AjvImport } from 'ajv';
import { default as addFormatsImport } from 'ajv-formats';

// ---------------------------------------------------------------------------
// AJV ESM/CJS interop (matches packages/core/src/json-schema-validator.ts)
// ---------------------------------------------------------------------------

const ajvMod = AjvImport as Record<string, unknown>;
const Ajv = (typeof ajvMod.default === 'function' ? ajvMod.default : AjvImport) as new (
  opts?: Record<string, unknown>,
) => AjvInstance;
const fmtMod = addFormatsImport as Record<string, unknown>;
const addFormats = (typeof fmtMod.default === 'function' ? fmtMod.default : addFormatsImport) as (
  ajv: AjvInstance,
) => AjvInstance;

// ---------------------------------------------------------------------------
// Lazy singleton AJV instance — shared across all compiled validators.
// ---------------------------------------------------------------------------

let ajvInstance: AjvInstance | null = null;

function getAjv(): AjvInstance {
  if (!ajvInstance) {
    ajvInstance = new Ajv({
      allErrors: true,
      strict: false,
      allowUnionTypes: true,
    });
    addFormats(ajvInstance);
  }
  return ajvInstance;
}

// ---------------------------------------------------------------------------
// Compiled-validator cache keyed by contract.operation
// ---------------------------------------------------------------------------

const compiledCache = new Map<string, ValidateFunction>();

/**
 * Reset the compiled-validator cache. Intended for tests that want to
 * assert AJV compilation behaviour across runs; production callers should
 * never need this.
 *
 * @internal
 */
export function _resetValidationCache(): void {
  compiledCache.clear();
}

function getCompiled<T>(contract: OperationInputContract<T>): ValidateFunction {
  const cached = compiledCache.get(contract.operation);
  if (cached) {
    return cached;
  }
  const compiled = getAjv().compile(contract.schema as Record<string, unknown>);
  compiledCache.set(contract.operation, compiled);
  return compiled;
}

// ---------------------------------------------------------------------------
// Error mapping helpers
// ---------------------------------------------------------------------------

/**
 * Normalize an AJV `instancePath` (JSON Pointer fragment, may be `''`)
 * into the canonical leading-slash form used in {@link ValidationError}.
 * AJV already emits JSON Pointer paths beginning with `/`, but missing-
 * required errors anchor at the parent, so we keep the empty-root form
 * intact and only ensure a single leading slash otherwise.
 */
function normalizePath(instancePath: string): string {
  if (instancePath === '' || instancePath === '/') {
    return '';
  }
  return instancePath.startsWith('/') ? instancePath : `/${instancePath}`;
}

/**
 * Describe a runtime value by type/cardinality WITHOUT leaking its raw
 * contents — matches the {@link ValidationError.received} contract.
 */
function describeReceived(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array of ${value.length}`;
  if (typeof value === 'string') {
    return value.length === 0 ? 'empty string' : `string of length ${value.length}`;
  }
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return `object with ${keys.length} field${keys.length === 1 ? '' : 's'}`;
  }
  return typeof value;
}

/**
 * Read the value at a JSON-Pointer-style `instancePath` from a raw
 * payload. AJV's `instancePath` is RFC 6901 with `~0` → `~`, `~1` → `/`.
 */
function readAtPath(root: unknown, instancePath: string): unknown {
  if (instancePath === '' || instancePath === '/') return root;
  const segments = instancePath
    .split('/')
    .slice(1)
    .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cursor: unknown = root;
  for (const seg of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx)) return undefined;
      cursor = cursor[idx];
      continue;
    }
    if (typeof cursor === 'object') {
      cursor = (cursor as Record<string, unknown>)[seg];
      continue;
    }
    return undefined;
  }
  return cursor;
}

/**
 * Walk a contract schema by an AJV `schemaPath` (e.g.
 * `#/properties/title/minLength`) and return the schema NODE that
 * produced the error — used to detect `x-fix-hint` overrides.
 */
function walkSchema(schema: Record<string, unknown>, schemaPath: string): unknown {
  if (!schemaPath || schemaPath === '#') return schema;
  const segments = schemaPath
    .replace(/^#\/?/, '')
    .split('/')
    .filter((s) => s.length > 0)
    .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cursor: unknown = schema;
  for (const seg of segments) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

/**
 * If the schema node addressed by `schemaPath` (or its parent for
 * leaf-keyword errors) carries an `x-fix-hint: string`, return it.
 * Walks one step up from the keyword leaf so a hint on
 * `properties.title` can override the `minLength` failure on
 * `#/properties/title/minLength`.
 */
function findFixHint(contract: OperationInputContract<unknown>, schemaPath: string): string | null {
  const schema = contract.schema as Record<string, unknown>;

  const direct = walkSchema(schema, schemaPath);
  if (direct && typeof direct === 'object') {
    const hint = (direct as Record<string, unknown>)['x-fix-hint'];
    if (typeof hint === 'string') return hint;
  }

  // Walk up one level — leaf-keyword errors point at the keyword itself
  // (e.g. `.../minLength`), but authors put hints on the field schema.
  const parentPath = schemaPath.replace(/\/[^/]+$/, '');
  if (parentPath && parentPath !== schemaPath) {
    const parent = walkSchema(schema, parentPath);
    if (parent && typeof parent === 'object') {
      const hint = (parent as Record<string, unknown>)['x-fix-hint'];
      if (typeof hint === 'string') return hint;
    }
  }

  return null;
}

interface KeywordParams {
  readonly missingProperty?: string;
  readonly type?: string | string[];
  readonly allowedValues?: ReadonlyArray<unknown>;
  readonly limit?: number;
  readonly additionalProperty?: string;
}

function paramsOf(err: ErrorObject): KeywordParams {
  return (err.params ?? {}) as KeywordParams;
}

function expectedFor(err: ErrorObject): string {
  const params = paramsOf(err);
  switch (err.keyword) {
    case 'required':
      return `object with field ${params.missingProperty ?? '<unknown>'}`;
    case 'type': {
      const t = params.type;
      return Array.isArray(t) ? t.join('|') : (t ?? 'unknown type');
    }
    case 'enum': {
      const allowed = (params.allowedValues ?? []).map((v) => JSON.stringify(v));
      return `one of: ${allowed.join('|')}`;
    }
    case 'minLength':
      return `string with length >= ${params.limit ?? 0}`;
    case 'maxLength':
      return `string with length <= ${params.limit ?? 0}`;
    case 'minimum':
      return `number >= ${params.limit ?? 0}`;
    case 'maximum':
      return `number <= ${params.limit ?? 0}`;
    case 'minItems':
      return `array with length >= ${params.limit ?? 0}`;
    case 'maxItems':
      return `array with length <= ${params.limit ?? 0}`;
    case 'additionalProperties':
      return 'no extra fields';
    default:
      return err.message ?? err.keyword;
  }
}

function fixFor(err: ErrorObject): string {
  const params = paramsOf(err);
  switch (err.keyword) {
    case 'required':
      return `add the ${params.missingProperty ?? '<missing>'} field`;
    case 'type': {
      const t = Array.isArray(params.type) ? params.type[0] : params.type;
      if (t === 'string') return 'wrap value in quotes';
      if (t === 'array') return 'wrap value in [...]';
      if (t === 'number' || t === 'integer') return 'remove quotes if it is a number literal';
      if (t === 'boolean') return 'use literal true or false';
      if (t === 'object') return 'wrap value in { ... }';
      return `change value to type ${t ?? 'unknown'}`;
    }
    case 'enum': {
      const allowed = (params.allowedValues ?? []).map((v) =>
        typeof v === 'string' ? v : JSON.stringify(v),
      );
      return `use one of: ${allowed.join(', ')}`;
    }
    case 'additionalProperties':
      return `remove the extra field ${params.additionalProperty ?? ''}`.trim();
    case 'minLength':
      return `provide at least ${params.limit ?? 1} character(s)`;
    case 'maxLength':
      return `shorten to at most ${params.limit ?? 0} character(s)`;
    case 'minimum':
      return `provide a value >= ${params.limit ?? 0}`;
    case 'maximum':
      return `provide a value <= ${params.limit ?? 0}`;
    default:
      return `see ${err.schemaPath}`;
  }
}

function errorCodeFor(err: ErrorObject): string {
  return `E_VAL_${err.keyword.toUpperCase()}`;
}

function mapAjvError(
  contract: OperationInputContract<unknown>,
  rawInput: unknown,
  err: ErrorObject,
): ValidationError {
  // For `required` errors AJV anchors `instancePath` at the parent
  // object, not the missing child. Synthesise the child pointer so the
  // error path actually points at the field the caller forgot.
  const params = paramsOf(err);
  let path = normalizePath(err.instancePath);
  if (err.keyword === 'required' && params.missingProperty) {
    path = `${path}/${params.missingProperty}`;
  }

  const receivedValue =
    err.keyword === 'required' ? undefined : readAtPath(rawInput, err.instancePath);

  const customHint = findFixHint(contract, err.schemaPath);

  return {
    path,
    expected: expectedFor(err),
    received: describeReceived(receivedValue),
    fix: customHint ?? fixFor(err),
    errorCode: errorCodeFor(err),
    schemaPath: err.schemaPath,
  };
}

// ---------------------------------------------------------------------------
// Public API — validateOperationInput
// ---------------------------------------------------------------------------

/**
 * Validate a raw operation payload against an {@link OperationInputContract}
 * and return a strongly-typed {@link ValidationResult}.
 *
 * On success the result is `{ ok: true, value: rawInput as T }` — the
 * validator does NOT clone or coerce the payload, it only narrows the
 * type. On failure the result is `{ ok: false, errors: ValidationError[] }`
 * with one entry per AJV error (AJV is configured with `allErrors: true`
 * so callers see every problem in one pass).
 *
 * Compiled AJV validators are cached by `contract.operation` — the hot
 * path therefore avoids re-compilation entirely.
 *
 * @typeParam T - The validated input shape produced on success.
 * @param contract - Schema-first input contract (see T9914).
 * @param rawInput - Raw, untrusted payload to validate.
 * @returns Discriminated {@link ValidationResult} narrowed on `ok`.
 *
 * @example
 * ```ts
 * const result = validateOperationInput(createTaskContract, payload);
 * if (result.ok) {
 *   await dispatch.tasks.create(result.value);
 * } else {
 *   for (const e of result.errors) console.error(`${e.path}: ${e.fix}`);
 * }
 * ```
 *
 * @epic T9855
 * @task T9915
 */
export function validateOperationInput<T>(
  contract: OperationInputContract<T>,
  rawInput: unknown,
): ValidationResult<T> {
  const validate = getCompiled(contract);
  if (validate(rawInput)) {
    return { ok: true, value: rawInput as T };
  }
  const ajvErrors: ReadonlyArray<ErrorObject> = validate.errors ?? [];
  const errors: ValidationError[] = ajvErrors.map((err) =>
    mapAjvError(contract as OperationInputContract<unknown>, rawInput, err),
  );
  return { ok: false, errors };
}
