/**
 * OperationInputContract — schema-first input contract for CLEO operations.
 *
 * This module is the SINGLE SOURCE OF TRUTH for the schema-first input
 * validation surface that powers the `mutate(operation, input)` DX
 * (Saga T9855 / E7). Every CLEO operation that accepts structured input
 * MUST be describable as an {@link OperationInputContract}: a JSON Schema
 * draft-07 document, a stable operation identifier, and at least one
 * worked example payload.
 *
 * Validators consume an {@link OperationInputContract} and produce a
 * {@link ValidationResult} discriminated union — either the typed value
 * (`ok: true`) or an array of {@link ValidationError} entries with
 * actionable, JSON-Pointer-anchored remediation hints (`ok: false`).
 *
 * ZERO runtime dependencies: `contracts` is a leaf package. JSON Schema
 * documents are modeled as the loose alias {@link JsonSchema} so this
 * module does not pull in a JSON Schema typings package.
 *
 * @packageDocumentation
 * @module @cleocode/contracts/operations/input-contract
 *
 * @see {@link https://json-schema.org/draft-07/schema}
 *
 * @epic T9855
 * @task T9914
 */

// ---------------------------------------------------------------------------
// JSON Schema
// ---------------------------------------------------------------------------

/**
 * Loose alias for a JSON Schema draft-07 document.
 *
 * Intentionally typed as `Record<string, unknown>` to keep the contracts
 * package free of any JSON Schema typings runtime/type dependency. The
 * actual draft-07 shape is enforced by the validator implementation
 * (T9915) at the point of use, not by the type system here.
 *
 * @example
 * ```ts
 * const titleSchema: JsonSchema = {
 *   type: 'object',
 *   required: ['title'],
 *   properties: {
 *     title: { type: 'string', minLength: 1 },
 *   },
 * };
 * ```
 */
export type JsonSchema = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

/**
 * A single worked example payload for an {@link OperationInputContract}.
 *
 * Examples are MANDATORY (the contract requires at least one) — they
 * double as documentation for human readers AND as conformance fixtures
 * for the validator self-test that ships with every CLEO release.
 *
 * @typeParam T - The validated, typed input shape produced by the contract.
 *
 * @example
 * ```ts
 * const example: OperationInputExample<{ title: string }> = {
 *   name: 'minimal',
 *   value: { title: 'Ship saga T9855' },
 *   description: 'Smallest valid input — title is the only required field.',
 * };
 * ```
 */
export interface OperationInputExample<T> {
  /**
   * Short, human-readable identifier for the example. Conventionally
   * kebab-case (`'minimal'`, `'with-all-fields'`, `'edge-empty-array'`).
   */
  name: string;

  /**
   * A concrete value that validates successfully against the contract's
   * {@link OperationInputContract.schema | schema}. Strongly typed via
   * the `T` generic so example tables stay in sync with the operation
   * payload shape at compile time.
   */
  value: T;

  /**
   * Optional prose explaining why this example matters — what edge case
   * it covers, what default it exercises, etc. Surfaced in generated docs.
   */
  description?: string;
}

// ---------------------------------------------------------------------------
// OperationInputContract
// ---------------------------------------------------------------------------

/**
 * Schema-first input contract for a single CLEO operation.
 *
 * Pairs a stable operation identifier with the JSON Schema draft-07
 * document that describes the operation's accepted input shape, plus a
 * non-empty (by convention) catalogue of worked examples. The validator
 * implementation (T9915) ingests an {@link OperationInputContract} and a
 * raw payload, returning a {@link ValidationResult}.
 *
 * Together with the {@link OperationInputContractRegistry}, this type is
 * the foundation of the schema-first `mutate(operation, input)` DX
 * surface (Saga T9855 / E7).
 *
 * @typeParam T - The validated, typed input shape produced when the
 * raw payload passes validation. The generic propagates through
 * {@link ValidationResult} so callers receive a strongly-typed `value`
 * in the success branch.
 *
 * @example
 * ```ts
 * interface CreateTaskInput {
 *   title: string;
 *   acceptance: string;
 * }
 *
 * const createTaskContract: OperationInputContract<CreateTaskInput> = {
 *   operation: 'tasks.create',
 *   schema: {
 *     type: 'object',
 *     required: ['title', 'acceptance'],
 *     properties: {
 *       title: { type: 'string', minLength: 1, maxLength: 200 },
 *       acceptance: { type: 'string', minLength: 1 },
 *     },
 *     additionalProperties: false,
 *   },
 *   examples: [
 *     {
 *       name: 'minimal',
 *       value: { title: 'Ship E7', acceptance: 'PR merged' },
 *     },
 *   ],
 * };
 * ```
 */
export interface OperationInputContract<T> {
  /**
   * Stable, fully-qualified operation identifier in
   * `<domain>.<verb>` form (e.g. `'tasks.create'`, `'docs.publish'`).
   * Used as the registry key in {@link OperationInputContractRegistry}.
   */
  operation: string;

  /**
   * JSON Schema draft-07 document describing the accepted input shape.
   * The validator MUST treat absent properties as not-present (it does
   * NOT inject `default` values) so callers can distinguish "user
   * omitted" from "user supplied default".
   */
  schema: JsonSchema;

  /**
   * Catalogue of worked example payloads. Conventionally non-empty so
   * generated docs always have at least one runnable sample. Each
   * example's {@link OperationInputExample.value | value} is statically
   * typed to the contract's `T` parameter.
   */
  examples: ReadonlyArray<OperationInputExample<T>>;
}

// ---------------------------------------------------------------------------
// ValidationError
// ---------------------------------------------------------------------------

/**
 * A single validation failure produced by the input validator.
 *
 * Every field is REQUIRED — there are no optional remediation hints.
 * This shape is the wire format the `mutate` DX surface returns to
 * callers, so it MUST be stable, machine-parseable, AND human-readable.
 *
 * @example
 * ```ts
 * const err: ValidationError = {
 *   path: '/title',
 *   expected: 'string with minLength 1',
 *   received: 'empty string',
 *   fix: 'Provide a non-empty title (1-200 chars).',
 *   errorCode: 'E_INPUT_MIN_LENGTH',
 *   schemaPath: '#/properties/title/minLength',
 * };
 * ```
 */
export interface ValidationError {
  /**
   * RFC 6901 JSON Pointer to the failing input location, anchored at
   * the root of the payload (e.g. `'/title'`, `'/owners/0/email'`).
   * An empty string `''` denotes the root document itself.
   */
  path: string;

  /**
   * Human-readable description of what the validator expected at
   * {@link ValidationError.path | path} (e.g. `'string'`,
   * `'integer >= 0'`, `'one of: pending | active | done'`).
   */
  expected: string;

  /**
   * Human-readable description of what was actually received at
   * {@link ValidationError.path | path}. NEVER includes the raw value
   * itself — describes type/cardinality only — so logs of errors do
   * not accidentally leak user payloads.
   */
  received: string;

  /**
   * Actionable, imperative remediation hint targeted at the caller
   * (e.g. `'Provide a non-empty title (1-200 chars).'`). Surfaced
   * directly in CLI output and validator return envelopes.
   */
  fix: string;

  /**
   * Stable, screaming-snake-case error code (e.g.
   * `'E_INPUT_MIN_LENGTH'`, `'E_INPUT_REQUIRED'`). Stable across
   * releases so callers can branch on it programmatically.
   */
  errorCode: string;

  /**
   * RFC 6901 JSON Pointer into the contract's
   * {@link OperationInputContract.schema | schema} that produced the
   * failure (e.g. `'#/properties/title/minLength'`). Lets tooling jump
   * straight to the offending schema clause.
   */
  schemaPath: string;
}

// ---------------------------------------------------------------------------
// ValidationResult
// ---------------------------------------------------------------------------

/**
 * Discriminated union returned by the input validator.
 *
 * Narrows on the `ok` boolean: when `ok === true`, the strongly-typed
 * `value` is present; when `ok === false`, a non-empty `errors` array
 * lists every failure (validators are encouraged to surface ALL errors
 * in one pass, not bail on the first).
 *
 * @typeParam T - The validated, typed input shape produced on success.
 *
 * @example
 * ```ts
 * function handle(result: ValidationResult<{ title: string }>) {
 *   if (result.ok) {
 *     // result.value is { title: string }
 *     return createTask(result.value);
 *   }
 *   // result.errors is ValidationError[]
 *   for (const e of result.errors) {
 *     console.error(`${e.path}: ${e.fix}`);
 *   }
 * }
 * ```
 */
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: ValidationError[] };

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Registry of every {@link OperationInputContract} known to the CLEO
 * runtime, keyed by the contract's `operation` identifier (e.g.
 * `'tasks.create'`).
 *
 * The value type uses `unknown` for the contract's generic so registry
 * lookups stay assignable across operations with different input
 * shapes. Callers that need the concrete `T` MUST narrow via an
 * operation-specific accessor — direct `registry[op]` reads are
 * intentionally not type-narrowed by operation name.
 *
 * @example
 * ```ts
 * const registry: OperationInputContractRegistry = {
 *   'tasks.create': createTaskContract,
 *   'docs.publish': publishDocsContract,
 * };
 *
 * const contract = registry['tasks.create'];
 * if (contract) {
 *   // validate(contract, payload) → ValidationResult<unknown>
 * }
 * ```
 */
export type OperationInputContractRegistry = Record<string, OperationInputContract<unknown>>;
