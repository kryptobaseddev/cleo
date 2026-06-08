/**
 * deriveOutputContract — generic per-operation OUTPUT contract producer.
 *
 * Closes the COVERAGE half of DHQ-057 / T11692 (the symptom-fix half — the
 * `--field` remediation loop — is ST-4). The hand-authored {@link OUTPUT_CONTRACTS}
 * registry covers only the 7 highest-traffic `tasks.*` operations. Every other
 * operation in the 411-row {@link OPERATIONS} registry has NO machine-readable
 * description of its result `data` shape, so an agent asking `cleo <op>
 * --describe` (or hitting `E_FIELD_NOT_FOUND` on a bad `--field` pointer) gets
 * nothing back for ~404 ops.
 *
 * Rather than hand-write 404 more contracts (unmaintainable, drifts instantly),
 * this module DERIVES an {@link OperationOutputContract} for an operation from
 * three shape registries that ALREADY exist:
 *
 * | Source registry        | Home                     | Derives                                                  |
 * |------------------------|--------------------------|----------------------------------------------------------|
 * | {@link OPERATION_RESULT_SCHEMAS} | `@cleocode/contracts`  | precise top-level data keys for the 5 workgraph reads     |
 * | {@link PROJECTION_PLANS}         | `./mvi-projection.js`  | the data PATH (`tasks.show→task`, `docs.list→attachments`) for projected reads |
 * | {@link MinimalMutateEnvelope}    | `./mutate-projection.js` | the shared `{count, created, updated, deleted}` shape for ALL mutate ops |
 *
 * Resolution precedence inside {@link deriveOutputContract} (most-precise first):
 *
 *   1. workgraph result schema  → precise key-derived contract
 *   2. read op with projection plan → path-rooted contract
 *   3. mutate op (`gateway==='mutate'`) → shared minimal-mutate contract
 *   4. any other registered query op → a GENERIC object contract (data is an
 *      object; no specific `--field` pointers, but a `shapeNote` telling the
 *      agent to `--full`/`--describe`).
 *
 * A `null` return means the operation is NOT in {@link OPERATIONS} at all
 * (genuinely unknown). Per T10400 §6.3 R6.7 a `null` output contract is
 * "unverified shape", NEVER an error — callers MUST treat it as absent, not
 * throw.
 *
 * ## Boundary
 *
 * This producer lives in `core/src/dispatch` (NOT `contracts`) because it reads
 * `PROJECTION_PLANS` / `MUTATE_PROJECTION_PLANS`, which are core-resident, and
 * because it is a bodied runtime helper (the contracts-purity Gate 10 forbids
 * net-new bodied functions in `contracts`). It is import-time side-effect-free:
 * it builds nothing at module load, only on call.
 *
 * @packageDocumentation
 * @module @cleocode/core/dispatch/contracts/derive-output-contract
 *
 * @epic T11679
 * @task T11762 ST-3 — DHQ-057: generic per-op output schema coverage backfill
 */

import {
  OPERATION_RESULT_SCHEMAS,
  OPERATIONS,
  type OperationDef,
  type OperationOutputContract,
} from '@cleocode/contracts';
import { PROJECTION_PLANS, type ProjectionPlan } from '../mvi-projection.js';

// ---------------------------------------------------------------------------
// Operation-def resolution (mirrors describe-operation.ts:resolveOperationDef)
// ---------------------------------------------------------------------------

/**
 * Resolve the {@link OperationDef} for a canonical `<domain>.<verb>` key.
 *
 * Mirrors `resolveOperationDef` in `describe-operation.ts`: an undotted key is
 * matched by operation name only (and only when unambiguous); a dotted key is
 * split at the FIRST dot into `<domain>.<rest>` so multi-segment operation
 * names like `workgraph.audit` (key `tasks.workgraph.audit`) resolve correctly.
 *
 * @param operation - Canonical `<domain>.<verb>` operation identifier.
 * @returns The matching definition, or `null` when no operation matches.
 *
 * @internal
 */
function resolveOperationDef(operation: string): OperationDef | null {
  const dotIdx = operation.indexOf('.');
  if (dotIdx === -1) {
    const matches = OPERATIONS.filter((op) => op.operation === operation);
    return matches.length === 1 ? (matches[0] ?? null) : null;
  }
  const domain = operation.slice(0, dotIdx);
  const op = operation.slice(dotIdx + 1);
  return OPERATIONS.find((o) => o.domain === domain && o.operation === op) ?? null;
}

// ---------------------------------------------------------------------------
// 1. Workgraph result schemas → precise top-level-key contract
// ---------------------------------------------------------------------------

/**
 * A Zod object schema exposes its top-level field map under `.shape`. The
 * {@link OPERATION_RESULT_SCHEMAS} values are typed loosely (`safeParse` only),
 * so this guard recovers the introspectable shape at runtime without coupling
 * the derive module to a specific Zod typings import.
 *
 * @internal
 */
function readZodTopLevelKeys(schema: unknown): string[] | null {
  if (schema === null || typeof schema !== 'object') return null;
  const shape = (schema as { shape?: unknown }).shape;
  if (shape === null || typeof shape !== 'object') return null;
  const keys = Object.keys(shape as Record<string, unknown>);
  return keys.length > 0 ? keys : null;
}

/**
 * Derive a contract for a workgraph read whose result shape is contracted in
 * {@link OPERATION_RESULT_SCHEMAS}. The top-level data keys become both the
 * `dataSchema` properties and the `/data/<key>` field pointers.
 *
 * @internal
 */
function deriveFromResultSchema(operation: string): OperationOutputContract | null {
  const schema = OPERATION_RESULT_SCHEMAS.get(operation as `${string}.${string}`);
  if (schema === undefined) return null;
  const keys = readZodTopLevelKeys(schema);
  if (keys === null) {
    // Schema present but not introspectable — fall back to a generic object
    // contract rather than dropping coverage for a known workgraph op.
    return genericObjectContract(operation, 'workgraph result');
  }
  const properties: Record<string, { type: 'object' | 'array' | 'string' | 'number' | 'boolean' }> =
    {};
  for (const key of keys) properties[key] = { type: 'object' };
  return {
    operation,
    shapeNote: `Workgraph result — top-level keys: ${keys.join(', ')}. Pointers are rooted at /data/<key>.`,
    dataSchema: {
      type: 'object',
      required: keys,
      additionalProperties: true,
      properties,
    },
    fieldPointers: keys.map((k) => `/data/${k}`),
  };
}

// ---------------------------------------------------------------------------
// 2. Projection-plan reads → path-rooted contract
// ---------------------------------------------------------------------------

/**
 * Derive a contract for a read op that has a {@link PROJECTION_PLANS} entry.
 * The plan tells us WHERE the records live in `data` (`plan.path`) and whether
 * the payload at that path is a list. We root the field pointers there:
 *
 *   - list plan  → `/data/<path>/0/id`, `/data/<path>/0/title`
 *   - single plan → `/data/<path>/id`, `/data/<path>/title`
 *   - `$` path   → records are the data root itself.
 *
 * @internal
 */
function deriveFromProjectionPlan(
  operation: string,
  plan: ProjectionPlan,
): OperationOutputContract {
  const atRoot = plan.path === '$';
  const base = atRoot ? '/data' : `/data/${plan.path}`;
  const recordPointer = plan.list ? `${base}/0` : base;
  const fieldPointers = [`${recordPointer}/id`, `${recordPointer}/title`];

  const recordSchema = {
    type: 'object' as const,
    description: `A ${plan.kind} record.`,
  };
  const pathValueSchema = plan.list
    ? { type: 'array' as const, items: recordSchema, description: `Array of ${plan.kind} records.` }
    : recordSchema;

  const dataSchema = atRoot
    ? pathValueSchema
    : {
        type: 'object' as const,
        required: [plan.path],
        additionalProperties: true,
        properties: { [plan.path]: pathValueSchema },
      };

  const shapeNote = atRoot
    ? `Records (${plan.kind}) are the /data ${plan.list ? 'array' : 'object'} itself.`
    : `Records (${plan.kind}) are under /data/${plan.path}${plan.list ? ' (array)' : ''}. ` +
      `Use ${recordPointer}/<field>.`;

  return { operation, shapeNote, dataSchema, fieldPointers };
}

// ---------------------------------------------------------------------------
// 3. Mutate ops → shared MinimalMutateEnvelope contract
// ---------------------------------------------------------------------------

/**
 * The shared `data` schema for the minimal mutate projection envelope
 * (`MinimalMutateEnvelope` — mutate-projection.ts). `created`/`updated`/
 * `deleted` are arrays of BARE TASK ID STRINGS (not objects), so
 * `/data/created/0` resolves to e.g. `"T11692"` directly.
 *
 * @internal
 */
const MINIMAL_MUTATE_DATA_SCHEMA = {
  type: 'object',
  required: ['count', 'created', 'updated', 'deleted'],
  additionalProperties: true,
  properties: {
    count: { type: 'number', description: 'Number of records the mutation affected.' },
    created: {
      type: 'array',
      description: 'Task IDs created (bare strings, e.g. "T11692"). Empty for update/delete-only.',
      items: { type: 'string' },
    },
    updated: {
      type: 'array',
      description: 'Task IDs updated (bare strings). Empty for create/delete-only.',
      items: { type: 'string' },
    },
    deleted: {
      type: 'array',
      description: 'Task IDs deleted (bare strings). Empty for create/update-only.',
      items: { type: 'string' },
    },
    ids: {
      type: 'array',
      description: 'Deprecated alias for the non-empty bucket. Prefer created/updated/deleted.',
      items: { type: 'string' },
    },
  },
} as const;

/**
 * Derive the shared minimal-mutate-envelope contract for any `gateway==='mutate'`
 * operation. All mutate ops share the `{count, created[], updated[], deleted[]}`
 * default projection (mutate-projection.ts), so one derived shape covers them.
 *
 * @internal
 */
function deriveMutateContract(operation: string): OperationOutputContract {
  return {
    operation,
    shapeNote:
      'Mutate envelope: affected task IDs are bare strings under /data/created, ' +
      '/data/updated, or /data/deleted (e.g. /data/created/0 → "T11692"). /data/count is the total. ' +
      'Pass --full for the verbose post-mutation record.',
    dataSchema: { ...MINIMAL_MUTATE_DATA_SCHEMA },
    fieldPointers: ['/data/count', '/data/created/0', '/data/updated/0', '/data/deleted/0'],
  };
}

// ---------------------------------------------------------------------------
// 4. Generic fallback — any other registered query op
// ---------------------------------------------------------------------------

/**
 * Derive a GENERIC object contract for a registered query op that has neither a
 * workgraph result schema nor a projection plan. This keeps coverage high (most
 * read ops return an object `data`) while being honest that the precise shape is
 * not contracted: no specific `--field` pointers, just a `shapeNote` pointing
 * the agent at `--describe` / `--full`.
 *
 * @internal
 */
function genericObjectContract(operation: string, kindHint = 'query'): OperationOutputContract {
  return {
    operation,
    shapeNote:
      `Generic ${kindHint} result — the precise /data shape is not individually contracted. ` +
      'Run with --full to see the verbose record, or --describe for the operation contract.',
    dataSchema: { type: 'object', additionalProperties: true },
    fieldPointers: [],
  };
}

// ---------------------------------------------------------------------------
// Public producer
// ---------------------------------------------------------------------------

/**
 * Derive an {@link OperationOutputContract} for an operation from the existing
 * shape registries, or `null` when the operation is genuinely unknown.
 *
 * Used as the SECOND tier of {@link getOutputContract}'s resolution order
 * (hand-authored {@link OUTPUT_CONTRACTS} → `deriveOutputContract` → `null`).
 * The hand-authored 7 stay authoritative; this lifts coverage to near-100% for
 * the remaining ~404 ops without hand-authoring sprawl.
 *
 * Resolution precedence (most-precise first): workgraph result schema →
 * projection-plan read → mutate op → generic registered query op → `null`.
 *
 * A `null` return MUST be treated as "no contract / unverified shape", NOT an
 * error (T10400 §6.3 R6.7).
 *
 * @param operation - Canonical `<domain>.<verb>` operation identifier.
 * @returns A derived contract, or `null` when the operation is not registered.
 *
 * @example
 * ```ts
 * deriveOutputContract('tasks.tree');        // precise workgraph keys
 * deriveOutputContract('tasks.show');        // projection-plan path (`task`)
 * deriveOutputContract('tasks.add');         // shared minimal-mutate envelope
 * deriveOutputContract('sessions.start');    // generic object contract
 * deriveOutputContract('does.not-exist');    // null
 * ```
 *
 * @task T11762 ST-3
 */
export function deriveOutputContract(operation: string): OperationOutputContract | null {
  const def = resolveOperationDef(operation);
  if (def === null) return null;

  // Re-derive the canonical key from the resolved def so a non-canonical input
  // (e.g. an undotted unambiguous op name) still yields canonical pointers.
  const key = `${def.domain}.${def.operation}`;

  // 1. Precise workgraph result schema.
  const fromSchema = deriveFromResultSchema(key);
  if (fromSchema !== null) return fromSchema;

  // 2. Read op with a projection plan.
  const plan = PROJECTION_PLANS[key];
  if (plan !== undefined) return deriveFromProjectionPlan(key, plan);

  // 3. Mutate op → shared minimal-mutate envelope.
  if (def.gateway === 'mutate') return deriveMutateContract(key);

  // 4. Any other registered query op → generic object contract.
  return genericObjectContract(key);
}
