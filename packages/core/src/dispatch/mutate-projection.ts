/**
 * Minimal-by-default mutate envelope projection (T9931 / Saga T9855 / E9.4).
 *
 * For state-modifying ops (`tasks.add`, `tasks.add-batch`, `tasks.update`,
 * `tasks.complete`, `tasks.delete`) the dispatcher used to return the full
 * post-mutation task record — title, description, acceptance, verification,
 * createdAt, updatedAt, labels, the entire row. Agents almost never need any
 * of that to keep working; they only need enough information to confirm the
 * mutation landed and to feed the next operation. This module strips the
 * payload down to `{count, created[], updated[], deleted[]}` (and, for
 * single-task ops, a few extra routing keys like `status`, `completedAt`, or
 * `changes`). A deprecated `ids[]` alias remains for existing field pointers.
 *
 * This is the mutate-side analogue to {@link applyProjectionPlan} for read
 * ops in `./mvi-projection.ts`. The two modules use the same opt-out signal
 * (`--full` / `--verbose` / `--human`) so a single CLI flag restores verbose
 * behaviour everywhere.
 *
 * @packageDocumentation
 * @module @cleocode/core/dispatch/mutate-projection
 *
 * @epic T9855 (Saga)
 * @task T9931 (E9.4)
 */

import type { ProjectionMode } from './mvi-projection.js';

/**
 * Minimal envelope shape returned for batch-style mutate ops.
 *
 * Always includes a count and operation-specific affected task IDs. For
 * single-task ops (`add`, `update`, `complete`, `delete`) `count` is `1` and
 * exactly one of `created`, `updated`, or `deleted` contains the affected ID.
 * For `add-batch`, `created` reflects the entire transaction.
 */
export interface MinimalMutateEnvelope {
  /** Number of records the mutation affected. */
  count: number;
  /** Task IDs created by the mutation, in operation order. */
  created: string[];
  /** Task IDs updated by the mutation, in operation order. */
  updated: string[];
  /** Task IDs deleted by the mutation, in operation order. */
  deleted: string[];
  /**
   * Deprecated legacy alias for the non-empty created/updated/deleted set.
   * Kept so `/data/ids/0` remains script-compatible while callers migrate.
   */
  ids: string[];
  /** Machine-readable hints for deprecated field paths. */
  fieldPathHints: Record<string, string>;
  /**
   * Per-op routing extras kept for single-task ops:
   * - `status` — post-mutation task status (add, update, complete)
   * - `completedAt` — ISO timestamp (complete only)
   * - `changes` — list of fields that changed (update only)
   * - `dryRun` — true when no DB write occurred (add, add-batch)
   *
   * Index signature is intentionally open so future ops can attach their
   * own minimal extras without expanding the type registry.
   */
  [key: string]: unknown;
}

/**
 * Plan describing how to derive a {@link MinimalMutateEnvelope} from a raw
 * mutate op data payload.
 *
 * `extract` runs against `response.data` (NOT the full response) and must
 * return a fresh object — callers treat the result as immutable.
 */
export interface MutateProjectionPlan {
  /** Canonical `<domain>.<operation>` key this plan applies to. */
  operation: string;
  /**
   * Extractor that turns the raw mutate result into the minimal envelope.
   *
   * Implementations MUST be defensive: the raw shape may be missing fields
   * when the underlying core op returned partial data (e.g. a dry-run path
   * that returned synthetic IDs). When the extractor cannot determine an
   * ID it returns `count: 0, ids: []` rather than throwing — the original
   * envelope is then returned unchanged by {@link applyMutateProjection}.
   */
  extract: (data: Record<string, unknown>) => MinimalMutateEnvelope;
}

/**
 * Read a task `id` from a possibly-nested record shape.
 *
 * Several core ops wrap the task under `data.task` / `data.deletedTask`
 * while others return the task fields at the root. This helper centralises
 * the lookup so each plan stays trivial.
 *
 * @internal
 */
function readTaskId(record: unknown): string | undefined {
  if (record === null || typeof record !== 'object') return undefined;
  const obj = record as Record<string, unknown>;
  const id = obj['id'];
  return typeof id === 'string' ? id : undefined;
}

/**
 * Read a string-typed field from a record.
 *
 * @internal
 */
function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

type MutationBucket = 'created' | 'updated' | 'deleted';

const IDS_DEPRECATION_HINT =
  '/data/ids is deprecated; use /data/created/0, /data/updated/0, or /data/deleted/0 for operation-specific IDs.';

/** Build the standardized mutate envelope with all mutation buckets present. */
function makeEnvelope(bucket: MutationBucket, ids: string[]): MinimalMutateEnvelope {
  return {
    count: ids.length,
    created: bucket === 'created' ? ids : [],
    updated: bucket === 'updated' ? ids : [],
    deleted: bucket === 'deleted' ? ids : [],
    ids,
    fieldPathHints: { '/data/ids': IDS_DEPRECATION_HINT, '/data/ids/0': IDS_DEPRECATION_HINT },
  };
}

/**
 * SSoT mapping of mutate operation → projection plan.
 *
 * The keys MUST match the canonical `<domain>.<operation>` identifier used
 * by the dispatcher. Ops absent from this table opt OUT of minimal projection
 * (the original payload flows through untouched).
 */
export const MUTATE_PROJECTION_PLANS: Readonly<Record<string, MutateProjectionPlan>> = {
  'tasks.add': {
    operation: 'tasks.add',
    extract: (data) => {
      const task = data['task'];
      const id = readTaskId(task);
      const status =
        task && typeof task === 'object' ? (task as Record<string, unknown>)['status'] : undefined;
      const envelope = makeEnvelope('created', id ? [id] : []);
      if (typeof status === 'string') envelope['status'] = status;
      const createdIds = data['createdIds'];
      if (createdIds && typeof createdIds === 'object') {
        const acceptanceCriteria = (createdIds as Record<string, unknown>)['acceptanceCriteria'];
        if (Array.isArray(acceptanceCriteria)) {
          envelope['acceptanceCriteriaIds'] = acceptanceCriteria.filter(
            (entry): entry is string => typeof entry === 'string',
          );
        }
      }
      if (data['duplicate'] === true) envelope['duplicate'] = true;
      if (data['dryRun'] === true) envelope['dryRun'] = true;
      return envelope;
    },
  },
  'tasks.add-batch': {
    operation: 'tasks.add-batch',
    extract: (data) => {
      const tasksField = data['tasks'];
      const ids: string[] = [];
      if (Array.isArray(tasksField)) {
        for (const entry of tasksField) {
          if (entry === null || typeof entry !== 'object') continue;
          const inner = (entry as Record<string, unknown>)['task'];
          const id = readTaskId(inner) ?? readTaskId(entry);
          if (id) ids.push(id);
        }
      }
      const isDryRun = data['dryRun'] === true;
      const createdRaw = data['created'];
      const created = typeof createdRaw === 'number' ? createdRaw : ids.length;
      // T10599: in dry-run mode the meaningful count is wouldCreate, not the
      // always-zero `created` field. Fall back to ids.length when absent.
      const wouldCreateRaw = data['wouldCreate'];
      const wouldCreate = typeof wouldCreateRaw === 'number' ? wouldCreateRaw : undefined;
      const effectiveCount = isDryRun ? (wouldCreate ?? ids.length) : created;
      const envelope = makeEnvelope('created', ids);
      envelope.count = effectiveCount;
      if (isDryRun) {
        envelope['dryRun'] = true;
        // wouldCreate — predicted write count (AC1/AC2)
        if (wouldCreate !== undefined) envelope['wouldCreate'] = wouldCreate;
        // wouldAffect — generic dry-run affected count. Prefer Core's explicit
        // value, otherwise mirror the effective count for legacy callers.
        const wouldAffectRaw = data['wouldAffect'];
        envelope['wouldAffect'] =
          typeof wouldAffectRaw === 'number' ? wouldAffectRaw : effectiveCount;
        // insertedCount — always 0 in dry-run (AC2: kept separate from wouldCreate)
        const insertedCountRaw = data['insertedCount'];
        envelope['insertedCount'] =
          typeof insertedCountRaw === 'number' ? insertedCountRaw : 0;
        // validatedCount — specs that passed validation (AC3)
        const validatedCountRaw = data['validatedCount'];
        if (typeof validatedCountRaw === 'number') {
          envelope['validatedCount'] = validatedCountRaw;
        }
        // validationFindings — per-spec warnings (AC3)
        const findings = data['validationFindings'];
        if (Array.isArray(findings) && findings.length > 0) {
          envelope['validationFindings'] = findings;
        }
      } else {
        // Live run: expose insertedCount for parity (AC2)
        const insertedCountRaw = data['insertedCount'];
        if (typeof insertedCountRaw === 'number') {
          envelope['insertedCount'] = insertedCountRaw;
        }
      }
      return envelope;
    },
  },
  'tasks.update': {
    operation: 'tasks.update',
    extract: (data) => {
      const task = data['task'];
      const id = readTaskId(task);
      const envelope = makeEnvelope('updated', id ? [id] : []);
      const changes = data['changes'];
      if (Array.isArray(changes)) envelope['changes'] = changes;
      if (task && typeof task === 'object') {
        const status = (task as Record<string, unknown>)['status'];
        if (typeof status === 'string') envelope['status'] = status;
      }
      return envelope;
    },
  },
  'tasks.complete': {
    operation: 'tasks.complete',
    extract: (data) => {
      const task = data['task'];
      const id = readTaskId(task);
      const envelope = makeEnvelope('updated', id ? [id] : []);
      if (task && typeof task === 'object') {
        const inner = task as Record<string, unknown>;
        const status = inner['status'];
        const completedAt = inner['completedAt'];
        if (typeof status === 'string') envelope['status'] = status;
        if (typeof completedAt === 'string') envelope['completedAt'] = completedAt;
      }
      const autoCompleted = data['autoCompleted'];
      if (Array.isArray(autoCompleted) && autoCompleted.length > 0) {
        envelope['autoCompleted'] = autoCompleted;
      }
      return envelope;
    },
  },
  'tasks.delete': {
    operation: 'tasks.delete',
    extract: (data) => {
      const deleted = data['deletedTask'] ?? data['task'];
      const id = readTaskId(deleted);
      const envelope = makeEnvelope('deleted', id ? [id] : []);
      if (deleted && typeof deleted === 'object') {
        const status = readString(deleted as Record<string, unknown>, 'status');
        if (status) envelope['status'] = status;
      }
      const cascadeDeleted = data['cascadeDeleted'];
      if (Array.isArray(cascadeDeleted) && cascadeDeleted.length > 0) {
        envelope['cascadeDeleted'] = cascadeDeleted;
        const cascadeIds = cascadeDeleted.filter((x): x is string => typeof x === 'string');
        envelope['count'] = envelope['count'] + cascadeIds.length;
        envelope['ids'] = [...envelope['ids'], ...cascadeIds];
        envelope['deleted'] = [...envelope['deleted'], ...cascadeIds];
      }
      return envelope;
    },
  },
};

/**
 * Apply the {@link MUTATE_PROJECTION_PLANS} entry for an operation, returning
 * the minimal envelope when a plan exists and `mode` is `'mvi'`.
 *
 * Behaviour table:
 *
 * | mode    | plan present? | extractor returned count? | output                |
 * |---------|---------------|---------------------------|-----------------------|
 * | `full`  | any           | any                       | original `data`       |
 * | `mvi`   | no            | n/a                       | original `data`       |
 * | `mvi`   | yes           | `count > 0`               | minimal envelope      |
 * | `mvi`   | yes           | `count === 0`             | original `data`       |
 *
 * The last row guards against silent data loss: if the extractor could not
 * find any ID in the raw payload (e.g. an unexpected shape from a future
 * core op revision) the caller still sees the full payload rather than an
 * empty `{count:0, ids:[]}` envelope.
 *
 * @param data      - The dispatch response `data` payload.
 * @param operation - The canonical `<domain>.<operation>` identifier.
 * @param mode      - `'mvi'` applies the plan; `'full'` is a no-op.
 * @returns Either the minimal envelope or the original `data` reference.
 */
export function applyMutateProjection(
  data: unknown,
  operation: string,
  mode: ProjectionMode,
): unknown {
  if (mode === 'full') return data;
  const plan = MUTATE_PROJECTION_PLANS[operation];
  if (!plan) return data;
  if (data === null || data === undefined || typeof data !== 'object') return data;
  const envelope = plan.extract(data as Record<string, unknown>);
  if (envelope.count === 0 && envelope.ids.length === 0) return data;
  return envelope;
}
