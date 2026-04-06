import { createRequire } from 'node:module';
import envelopeSchema from '../schemas/v1/envelope.schema.json' with { type: 'json' };
import { getNativeModule } from './native-loader.js';
import type { LAFSEnvelope } from './types.js';

// ── AJV Fallback (loaded lazily, only when native binding unavailable) ──

let ajvValidate: {
  (input: unknown): boolean;
  errors?: Array<{
    instancePath?: string;
    keyword?: string;
    message?: string;
    params?: Record<string, unknown>;
  }>;
} | null = null;

function getAjvValidate(): typeof ajvValidate {
  if (ajvValidate) return ajvValidate;

  const require = createRequire(import.meta.url);
  const AjvModule = require('ajv') as
    | { default?: new (opts: object) => unknown }
    | (new (
        opts: object,
      ) => unknown);
  const AddFormatsModule = require('ajv-formats') as
    | { default?: (ajv: unknown) => void }
    | ((ajv: unknown) => void);

  const AjvCtor = (typeof AjvModule === 'function' ? AjvModule : AjvModule.default) as new (
    opts: object,
  ) => {
    compile: (schema: unknown) => typeof ajvValidate;
  };

  const addFormats = (
    typeof AddFormatsModule === 'function' ? AddFormatsModule : AddFormatsModule.default
  ) as (ajv: unknown) => void;

  const ajv = new AjvCtor({ allErrors: true, strict: true, allowUnionTypes: true });
  addFormats(ajv);
  ajvValidate = ajv.compile(envelopeSchema);
  return ajvValidate;
}

/**
 * Structured representation of a single validation error from AJV.
 *
 * @remarks
 * Normalizes the raw AJV error shape into a predictable structure
 * with guaranteed non-optional fields.
 */
export interface StructuredValidationError {
  /** JSON Pointer path to the property that failed validation (e.g., `"/_meta/mvi"`). */
  path: string;
  /** The AJV validation keyword that triggered the error (e.g., `"required"`, `"type"`). */
  keyword: string;
  /** Human-readable description of the validation failure. */
  message: string;
  /** Keyword-specific parameters from AJV (e.g., `{ missingProperty: "success" }`). */
  params: Record<string, unknown>;
}

/**
 * Result of validating a value against the LAFS envelope JSON Schema.
 *
 * @remarks
 * Contains both human-readable error strings and structured error objects
 * for programmatic consumption.
 */
export interface EnvelopeValidationResult {
  /** True when the input fully conforms to the envelope schema. */
  valid: boolean;
  /** Flattened human-readable error messages (empty when valid). */
  errors: string[];
  /** Structured error objects with path, keyword, and params (empty when valid). */
  structuredErrors: StructuredValidationError[];
}

/**
 * Validates an unknown input against the LAFS envelope JSON Schema (Draft-07).
 *
 * @remarks
 * Uses a pre-compiled AJV validator with `allErrors: true` so every
 * violation is reported, not just the first. The compiled schema is
 * shared across calls for performance.
 *
 * @param input - The raw value to validate.
 * @returns An {@link EnvelopeValidationResult} with validity status and any errors.
 *
 * @example
 * ```ts
 * const result = validateEnvelope(JSON.parse(rawJson));
 * if (!result.valid) {
 *   console.error(result.errors);
 * }
 * ```
 */
export function validateEnvelope(input: unknown): EnvelopeValidationResult {
  // Try native Rust binding first (faster, schema embedded at compile time)
  const native = getNativeModule();
  if (native) {
    const payload = JSON.stringify(input);
    const result = native.lafsValidateEnvelope(payload);
    return {
      valid: result.valid,
      errors: result.errors,
      structuredErrors: result.structuredErrors.map((se) => ({
        path: se.path,
        keyword: se.keyword,
        message: se.message,
        params: se.params,
      })),
    };
  }

  // AJV fallback when native binding is unavailable
  const validate = getAjvValidate();
  if (!validate) {
    return { valid: false, errors: ['Validation unavailable'], structuredErrors: [] };
  }

  const valid = validate(input);
  if (valid) {
    return { valid: true, errors: [], structuredErrors: [] };
  }

  const structuredErrors: StructuredValidationError[] = (validate.errors ?? []).map(
    (error: {
      instancePath?: string;
      keyword?: string;
      message?: string;
      params?: Record<string, unknown>;
    }) => ({
      path: error.instancePath || '/',
      keyword: error.keyword ?? 'unknown',
      message: error.message ?? 'validation error',
      params: error.params ?? {},
    }),
  );

  const errors = structuredErrors.map((se) => `${se.path} ${se.message}`.trim());

  return { valid: false, errors, structuredErrors };
}

/**
 * Validates input and throws on schema failure, returning a typed envelope on success.
 *
 * @remarks
 * Thin wrapper around {@link validateEnvelope} that converts a non-valid
 * result into a thrown `Error`. The error message includes all validation
 * errors joined by semicolons.
 *
 * @param input - The raw value to validate as a LAFS envelope.
 * @returns The input cast to {@link LAFSEnvelope} when schema validation passes.
 * @throws {Error} When the input does not conform to the envelope schema.
 *
 * @example
 * ```ts
 * const envelope = assertEnvelope(parsed);
 * console.log(envelope.success);
 * ```
 */
export function assertEnvelope(input: unknown): LAFSEnvelope {
  const result = validateEnvelope(input);
  if (!result.valid) {
    throw new Error(`Invalid LAFS envelope: ${result.errors.join('; ')}`);
  }
  return input as LAFSEnvelope;
}
