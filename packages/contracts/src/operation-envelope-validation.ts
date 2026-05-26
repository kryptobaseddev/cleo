/**
 * Operation-aware LAFS envelope validation.
 *
 * The base LAFS shape proves that an envelope is structurally valid. This
 * module adds the dispatch-layer contract checks that require `_meta.operation`
 * to resolve to a registered CLEO operation and, when a result schema is known,
 * validates successful payloads against that operation's result contract.
 *
 * @task T10610
 * @saga T10538
 */

import type { OperationDef } from './dispatch/operation-def.js';
import { OPERATIONS } from './dispatch/operations-registry.js';
import type { LAFSEnvelope, LAFSErrorCategory, LAFSTransport, MVILevel } from './lafs.js';
import {
  tasksFrontierResultSchema,
  tasksRollupResultSchema,
  tasksTraverseResultSchema,
  tasksTreeResultSchema,
  tasksWorkGraphAuditResultSchema,
} from './workgraph.js';

interface SafeParseIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly code?: string;
}

interface SafeParseError {
  readonly issues: readonly SafeParseIssue[];
}

interface ResultSchema {
  safeParse(
    input: unknown,
  ): { success: true; data: unknown } | { success: false; error: SafeParseError };
}

/** Stable issue code emitted when `_meta.operation` is absent or unknown. */
export const E_LAFS_OPERATION_UNREGISTERED = 'E_LAFS_OPERATION_UNREGISTERED';

/** Stable issue code emitted when an operation result fails its contract schema. */
export const E_LAFS_OPERATION_RESULT_SCHEMA = 'E_LAFS_OPERATION_RESULT_SCHEMA';

/** Stable issue code emitted when success/error envelope invariants are violated. */
export const E_LAFS_OPERATION_ERROR_SHAPE = 'E_LAFS_OPERATION_ERROR_SHAPE';

/** Dot-delimited operation name, e.g. `tasks.frontier`. */
export type OperationEnvelopeName = `${string}.${string}`;

/** One issue produced by operation-aware envelope validation. */
export interface OperationEnvelopeValidationIssue {
  /** JSON Pointer path into the envelope. */
  readonly path: string;
  /** Stable machine-readable issue code. */
  readonly code: string;
  /** Human-readable validation failure. */
  readonly message: string;
  /** Optional underlying schema keyword or parser code. */
  readonly keyword?: string;
}

/** Result of validating a LAFS envelope against the dispatch operation registry. */
export interface OperationEnvelopeValidationResult {
  /** True only when base LAFS shape, registry lookup, and result schema checks pass. */
  readonly valid: boolean;
  /** Base LAFS structural verdict. */
  readonly envelopeValid: boolean;
  /** Resolved operation definition, if `_meta.operation` matched the registry. */
  readonly operation?: OperationDef;
  /** Result schema key that was enforced, when available. */
  readonly resultSchemaOperation?: OperationEnvelopeName;
  /** Structured issue list, including base LAFS and operation-aware issues. */
  readonly issues: readonly OperationEnvelopeValidationIssue[];
  /** Human-readable issue messages for CLI/reporting callers. */
  readonly errors: readonly string[];
}

/** Options for operation-aware LAFS validation. */
export interface OperationEnvelopeValidationOptions {
  /** Registry to resolve `_meta.operation` against. Defaults to canonical OPERATIONS. */
  readonly operations?: readonly OperationDef[];
  /** Per-operation result schemas. Defaults to the currently contracted WorkGraph reads. */
  readonly resultSchemas?: ReadonlyMap<OperationEnvelopeName, ResultSchema>;
}

/** Canonical result schemas currently promoted to operation-aware LAFS validation. */
export const OPERATION_RESULT_SCHEMAS: ReadonlyMap<OperationEnvelopeName, ResultSchema> = new Map<
  OperationEnvelopeName,
  ResultSchema
>([
  ['tasks.traverse', tasksTraverseResultSchema as ResultSchema],
  ['tasks.tree', tasksTreeResultSchema as ResultSchema],
  ['tasks.rollup', tasksRollupResultSchema as ResultSchema],
  ['tasks.frontier', tasksFrontierResultSchema as ResultSchema],
  ['tasks.workgraph.audit', tasksWorkGraphAuditResultSchema as ResultSchema],
]);

const LAFS_SCHEMA_URL = 'https://lafs.dev/schemas/v1/envelope.schema.json';
const LAFS_TRANSPORTS: ReadonlySet<LAFSTransport> = new Set(['cli', 'http', 'grpc', 'sdk']);
const LAFS_MVI_LEVELS: ReadonlySet<MVILevel> = new Set(['minimal', 'standard', 'full', 'custom']);
const LAFS_ERROR_CATEGORIES: ReadonlySet<LAFSErrorCategory> = new Set([
  'VALIDATION',
  'AUTH',
  'PERMISSION',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMIT',
  'TRANSIENT',
  'INTERNAL',
  'CONTRACT',
  'MIGRATION',
]);

function issue(path: string, message: string, keyword = 'type'): OperationEnvelopeValidationIssue {
  return { path, code: `LAFS_SCHEMA_${keyword.toUpperCase()}`, keyword, message };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function validateBaseLafsEnvelope(input: unknown): OperationEnvelopeValidationIssue[] {
  if (!isRecord(input)) return [issue('/', 'LAFS envelope must be an object')];

  const issues: OperationEnvelopeValidationIssue[] = [];
  if (input.$schema !== LAFS_SCHEMA_URL) {
    issues.push(issue('/$schema', `must equal ${LAFS_SCHEMA_URL}`, 'const'));
  }

  if (!isRecord(input._meta)) {
    issues.push(issue('/_meta', 'must be an object'));
  } else {
    const meta = input._meta;
    for (const field of ['specVersion', 'schemaVersion', 'timestamp', 'operation', 'requestId']) {
      if (typeof meta[field] !== 'string' || meta[field].length === 0) {
        issues.push(issue(`/_meta/${field}`, 'must be a non-empty string'));
      }
    }
    if (
      typeof meta.transport !== 'string' ||
      !LAFS_TRANSPORTS.has(meta.transport as LAFSTransport)
    ) {
      issues.push(issue('/_meta/transport', 'must be a valid LAFS transport', 'enum'));
    }
    if (typeof meta.strict !== 'boolean') {
      issues.push(issue('/_meta/strict', 'must be a boolean'));
    }
    if (typeof meta.mvi !== 'string' || !LAFS_MVI_LEVELS.has(meta.mvi as MVILevel)) {
      issues.push(issue('/_meta/mvi', 'must be a valid LAFS MVI level', 'enum'));
    }
    if (!Number.isInteger(meta.contextVersion) || Number(meta.contextVersion) < 0) {
      issues.push(issue('/_meta/contextVersion', 'must be a non-negative integer'));
    }
  }

  if (typeof input.success !== 'boolean') {
    issues.push(issue('/success', 'must be a boolean'));
  }
  if (!('result' in input)) {
    issues.push(issue('/result', 'is required', 'required'));
  } else if (input.result !== null && !isRecord(input.result) && !Array.isArray(input.result)) {
    issues.push(issue('/result', 'must be an object, array, or null'));
  }

  if (input.error !== null && input.error !== undefined) {
    if (!isRecord(input.error)) {
      issues.push(issue('/error', 'must be an object or null'));
    } else {
      const error = input.error;
      if (typeof error.code !== 'string' || error.code.length === 0) {
        issues.push(issue('/error/code', 'must be a non-empty string'));
      }
      if (typeof error.message !== 'string' || error.message.length === 0) {
        issues.push(issue('/error/message', 'must be a non-empty string'));
      }
      if (
        typeof error.category !== 'string' ||
        !LAFS_ERROR_CATEGORIES.has(error.category as LAFSErrorCategory)
      ) {
        issues.push(issue('/error/category', 'must be a valid LAFS error category', 'enum'));
      }
      if (typeof error.retryable !== 'boolean') {
        issues.push(issue('/error/retryable', 'must be a boolean'));
      }
      if (
        error.retryAfterMs !== null &&
        error.retryAfterMs !== undefined &&
        (!Number.isInteger(error.retryAfterMs) || Number(error.retryAfterMs) < 0)
      ) {
        issues.push(issue('/error/retryAfterMs', 'must be a non-negative integer or null'));
      }
      if (!isRecord(error.details)) {
        issues.push(issue('/error/details', 'must be an object'));
      }
    }
  }

  return issues;
}

function pointer(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '/result';
  return `/result/${path
    .map((segment) => String(segment).split('~').join('~0').split('/').join('~1'))
    .join('/')}`;
}

function resolveOperation(
  operationName: string,
  operations: readonly OperationDef[],
): OperationDef | undefined {
  return operations.find(
    (candidate) => `${candidate.domain}.${candidate.operation}` === operationName,
  );
}

function hasCanonicalSuccessShape(envelope: LAFSEnvelope): OperationEnvelopeValidationIssue[] {
  if (envelope.success) {
    if (envelope.result === null) {
      return [
        {
          path: '/result',
          code: E_LAFS_OPERATION_ERROR_SHAPE,
          message: 'successful LAFS envelopes must include a non-null result payload',
        },
      ];
    }
    if (envelope.error !== null && envelope.error !== undefined) {
      return [
        {
          path: '/error',
          code: E_LAFS_OPERATION_ERROR_SHAPE,
          message: 'successful LAFS envelopes must not include an error payload',
        },
      ];
    }
    return [];
  }

  const issues: OperationEnvelopeValidationIssue[] = [];
  if (envelope.error === null || envelope.error === undefined) {
    issues.push({
      path: '/error',
      code: E_LAFS_OPERATION_ERROR_SHAPE,
      message: 'failed LAFS envelopes must include the canonical error payload',
    });
  }
  if (envelope.result !== null) {
    issues.push({
      path: '/result',
      code: E_LAFS_OPERATION_ERROR_SHAPE,
      message: 'failed LAFS envelopes must set result to null',
    });
  }
  return issues;
}

/**
 * Validate a LAFS envelope against the dispatch operation registry and known
 * operation result contracts.
 */
export function validateOperationEnvelope(
  input: unknown,
  options: OperationEnvelopeValidationOptions = {},
): OperationEnvelopeValidationResult {
  const issues: OperationEnvelopeValidationIssue[] = validateBaseLafsEnvelope(input);

  if (issues.length > 0) {
    return {
      valid: false,
      envelopeValid: false,
      issues,
      errors: issues.map((issue) => `${issue.path} ${issue.message}`.trim()),
    };
  }

  const envelope = input as LAFSEnvelope;
  const operationName = envelope._meta.operation;
  const operations = options.operations ?? OPERATIONS;
  const resultSchemas = options.resultSchemas ?? OPERATION_RESULT_SCHEMAS;
  const operation = resolveOperation(operationName, operations);

  if (operation === undefined) {
    issues.push({
      path: '/_meta/operation',
      code: E_LAFS_OPERATION_UNREGISTERED,
      message: `unknown LAFS operation '${operationName}'`,
    });
  }

  issues.push(...hasCanonicalSuccessShape(envelope));

  const schema = resultSchemas.get(operationName as OperationEnvelopeName);
  if (envelope.success && schema !== undefined && envelope.result !== null) {
    const parsed = schema.safeParse(envelope.result);
    if (!parsed.success) {
      for (const zodIssue of parsed.error.issues) {
        issues.push({
          path: pointer(zodIssue.path),
          code: E_LAFS_OPERATION_RESULT_SCHEMA,
          keyword: zodIssue.code,
          message: zodIssue.message,
        });
      }
    }
  }

  return {
    valid: issues.length === 0,
    envelopeValid: true,
    operation,
    resultSchemaOperation:
      schema === undefined ? undefined : (operationName as OperationEnvelopeName),
    issues,
    errors: issues.map((issue) => `${issue.path} ${issue.message}`.trim()),
  };
}
