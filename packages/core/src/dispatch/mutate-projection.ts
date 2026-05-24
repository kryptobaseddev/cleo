/**
 * Minimal-by-default mutate envelope projection (T9931 / Saga T9855 / E9.4).
 *
 * For state-modifying ops (`tasks.add`, `tasks.add-batch`, `tasks.update`,
 * `tasks.complete`, `tasks.delete`) the dispatcher used to return the full
 * post-mutation task record — title, description, acceptance, verification,
 * createdAt, updatedAt, labels, the entire row. Agents almost never need any
 * of that to keep working; they only need enough information to confirm the
 * mutation landed and to feed the next operation. This module strips the
 * payload down to `{count, ids[]}` (and, for single-task ops, a few extra
 * routing keys like `status`, `completedAt`, or `changes`).
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
 * Always includes a count and the affected task IDs. For single-task ops
 * (`add`, `update`, `complete`, `delete`) `count` is `1` and `ids` is a
 * single-element array. For `add-batch` `count` and `ids` reflect the entire
 * transaction.
 */
export interface MinimalMutateEnvelope {
  /** Number of records the mutation affected. */
  count: number;
  /** Affected task IDs, in the order the operation processed them. */
  ids: string[];
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
      const envelope: MinimalMutateEnvelope = {
        count: id ? 1 : 0,
        ids: id ? [id] : [],
      };
      if (typeof status === 'string') envelope['status'] = status;
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
      const createdRaw = data['created'];
      const created = typeof createdRaw === 'number' ? createdRaw : ids.length;
      const envelope: MinimalMutateEnvelope = {
        count: created,
        ids,
      };
      if (data['dryRun'] === true) envelope['dryRun'] = true;
      return envelope;
    },
  },
  'tasks.update': {
    operation: 'tasks.update',
    extract: (data) => {
      const task = data['task'];
      const id = readTaskId(task);
      const envelope: MinimalMutateEnvelope = {
        count: id ? 1 : 0,
        ids: id ? [id] : [],
      };
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
      const envelope: MinimalMutateEnvelope = {
        count: id ? 1 : 0,
        ids: id ? [id] : [],
      };
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
      const envelope: MinimalMutateEnvelope = {
        count: id ? 1 : 0,
        ids: id ? [id] : [],
      };
      if (deleted && typeof deleted === 'object') {
        const status = readString(deleted as Record<string, unknown>, 'status');
        if (status) envelope['status'] = status;
      }
      const cascadeDeleted = data['cascadeDeleted'];
      if (Array.isArray(cascadeDeleted) && cascadeDeleted.length > 0) {
        envelope['cascadeDeleted'] = cascadeDeleted;
        envelope['count'] = envelope['count'] + cascadeDeleted.length;
        envelope['ids'] = [
          ...envelope['ids'],
          ...cascadeDeleted.filter((x): x is string => typeof x === 'string'),
        ];
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
