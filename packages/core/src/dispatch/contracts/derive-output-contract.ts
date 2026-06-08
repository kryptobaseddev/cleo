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
 * | {@link MUTATE_PROJECTION_PLANS}  | `./mutate-projection.js` | the shared `{count, created, updated, deleted}` shape — but ONLY for the 6 ops that actually project it |
 *
 * Resolution precedence inside {@link deriveOutputContract} (most-precise first):
 *
 *   1. workgraph result schema  → precise key-derived contract
 *   2. read op with projection plan → path-rooted contract
 *   3. mutate op WITH a {@link MUTATE_PROJECTION_PLANS} entry → shared
 *      minimal-mutate contract. An unplanned `gateway==='mutate'` op is NOT
 *      rewritten by the dispatch middleware (it returns its raw domain payload),
 *      so it must NOT advertise `/data/created/0` — it falls through to (4).
 *   4. any other registered op (unplanned mutate or plain query) → a GENERIC
 *      object contract (data is an object; no specific `--field` pointers, but a
 *      `shapeNote` telling the agent to `--full`/`--describe`).
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
import { MUTATE_PROJECTION_PLANS } from '../mutate-projection.js';
import { PROJECTION_PLANS, type ProjectionKind, type ProjectionPlan } from '../mvi-projection.js';

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
 * Map a {@link ProjectionKind} to the secondary identity field that pairs with
 * `id` in the derived field pointers.
 *
 * Task-shaped records (`task`/`epic`/`saga`) carry a `title`; doc-shaped records
 * (`doc`) carry NO `title` — their human-readable handle is `slug` (see
 * `AttachmentMetadata` and the doc MVI field-set in `mvi-projection.ts`, which
 * expose `slug`/`description` but never `title`). Hardcoding `/title` for doc
 * plans produced an invalid `--field /data/.../title` pointer that fails with
 * `E_FIELD_NOT_FOUND` — the very class of failure this contract exists to
 * prevent. `'unknown'` falls back to `title` (the generic record convention),
 * matching the {@link GENERIC_MVI_FIELDS} routing keys.
 *
 * @internal
 */
function secondaryPointerField(kind: ProjectionKind): 'title' | 'slug' {
  return kind === 'doc' ? 'slug' : 'title';
}

/**
 * Derive a contract for a read op that has a {@link PROJECTION_PLANS} entry.
 * The plan tells us WHERE the records live in `data` (`plan.path`) and whether
 * the payload at that path is a list. We root the field pointers there:
 *
 *   - task-kind list plan  → `/data/<path>/0/id`, `/data/<path>/0/title`
 *   - doc-kind list plan   → `/data/<path>/0/id`, `/data/<path>/0/slug`
 *   - single plan          → `/data/<path>/id`, `/data/<path>/{title|slug}`
 *   - `$` path             → records are the data root itself.
 *
 * The secondary pointer is chosen per {@link ProjectionKind}
 * ({@link secondaryPointerField}): task-shaped records expose `title`, doc
 * records expose `slug` (they have no `title`).
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
  const secondaryField = secondaryPointerField(plan.kind);
  const fieldPointers = [`${recordPointer}/id`, `${recordPointer}/${secondaryField}`];

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
 * Derive the shared minimal-mutate-envelope contract for a mutate op that
 * actually projects the `{count, created[], updated[], deleted[]}` shape.
 *
 * IMPORTANT: only the 6 ops with a {@link MUTATE_PROJECTION_PLANS} entry
 * (`tasks.add`, `tasks.add-batch`, `tasks.saga.create`, `tasks.update`,
 * `tasks.complete`, `tasks.delete`) are rewritten into the minimal envelope by
 * the dispatch middleware — `applyMutateProjection` / `mutate-minimal-envelope`
 * return the RAW domain payload untouched for every unplanned mutate op. The
 * caller ({@link deriveOutputContract}) therefore gates this on plan presence;
 * the ~169 unplanned mutate ops (`memory.observe`, `session.start`, `docs.add`,
 * `release.plan`, …) fall through to {@link genericObjectContract} so we never
 * advertise `/data/created/0` for a result that does not carry it.
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
 * projection-plan read → planned mutate op → generic registered op (unplanned
 * mutate or plain query) → `null`.
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
 * deriveOutputContract('tasks.add');         // shared minimal-mutate envelope (planned)
 * deriveOutputContract('memory.observe');    // generic object (UNPLANNED mutate)
 * deriveOutputContract('session.start');     // generic object contract
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

  // 3. Mutate op that ACTUALLY projects the minimal-mutate envelope. Only the
  //    ops with a MUTATE_PROJECTION_PLANS entry are rewritten into
  //    `{count, created[], updated[], deleted[]}` by the dispatch middleware;
  //    every other `gateway==='mutate'` op returns its own domain-specific
  //    result shape untouched, so advertising `/data/created/0` for them would
  //    steer agents at a pointer that resolves nothing (DHQ-057 loop).
  if (def.gateway === 'mutate' && MUTATE_PROJECTION_PLANS[key] !== undefined) {
    return deriveMutateContract(key);
  }

  // 4. Any other registered op (unplanned mutate or plain query) → generic
  //    object contract: honest "shape not individually contracted" rather than
  //    a misleading pointer set.
  return genericObjectContract(key);
}
