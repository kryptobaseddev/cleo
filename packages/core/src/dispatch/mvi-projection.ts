/**
 * MVI (Minimum Viable Information) record projection.
 *
 * Strips verbose record fields down to the essentials agents need for control
 * flow: id, title, status, and a handful of routing keys. The full record is
 * available again via the `--verbose` / `--human` / `--full` opt-out flag, which
 * the CLI translates into `_projection: 'full'` on the dispatch request.
 *
 * This is distinct from the LAFS envelope-level projection in
 * `@cleocode/lafs/mviProjection` (which strips envelope chrome like `$schema`
 * / `_meta`), from the tier-based domain-access gate in
 * `packages/cleo/src/dispatch/middleware/projection.ts` (which gates which
 * domains are reachable), and from the JSON Pointer extractor in
 * `./projection.ts` (T9929 — `--field` flag). This module trims the DATA
 * payload itself per record kind so `cleo show T###` returns ~150 bytes
 * instead of ~1.6 KB.
 *
 * @packageDocumentation
 * @module @cleocode/core/dispatch/mvi-projection
 *
 * @epic T9855 (Saga)
 * @task T9922 (E8.3)
 */

/**
 * Mode of projection applied to a single record.
 *
 * - `'mvi'`: only the fields essential for agent control flow are kept.
 * - `'full'`: the record is returned unchanged.
 */
export type ProjectionMode = 'mvi' | 'full';

/**
 * Recognized record kinds for MVI projection.
 *
 * `'unknown'` is the safe fallback — when the dispatcher cannot identify the
 * record shape, the record is passed through untouched (no field stripping).
 */
export type ProjectionKind = 'task' | 'epic' | 'saga' | 'doc' | 'unknown';

/**
 * Allow-list of fields kept for each known kind under `'mvi'` mode.
 *
 * Keep these sets small — every field added here defeats the purpose of MVI
 * projection. The CLI `--verbose` / `--human` / `--full` flag is the
 * documented escape hatch for callers who need the full record.
 */
const MVI_FIELDS: Record<Exclude<ProjectionKind, 'unknown'>, ReadonlySet<string>> = {
  task: new Set(['id', 'title', 'status', 'priority', 'parentId', 'type', 'kind']),
  epic: new Set(['id', 'title', 'status', 'priority', 'parentId', 'type', 'kind', 'childRollup']),
  saga: new Set(['id', 'title', 'status', 'priority', 'type', 'label', 'childRollup']),
  doc: new Set([
    'id',
    'slug',
    'type',
    'kind',
    'sha256',
    'mime',
    'size',
    'createdAt',
    'refCount',
    'description',
  ]),
};

/**
 * Pick the MVI-allow-listed keys out of a record.
 *
 * @internal
 */
function pickFields<T extends Record<string, unknown>>(
  record: T,
  allow: ReadonlySet<string>,
): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(record)) {
    if (allow.has(key)) {
      // Index assertion is safe: `key` came from Object.keys(record).
      (out as Record<string, unknown>)[key] = record[key];
    }
  }
  return out;
}

/**
 * Project a single record down to its MVI field-set for the given kind.
 *
 * Non-object inputs (null, primitives, arrays) are returned unchanged — this
 * function operates on a single record, not a collection. Use
 * {@link projectMviList} for arrays.
 *
 * @param record - The record to project (typically a task, epic, or doc row).
 * @param kind   - The record kind. Unknown kinds pass through unchanged so
 *                 callers don't accidentally strip fields off shapes the
 *                 projection table does not understand.
 * @returns A new object containing only the MVI-essential fields when `kind`
 *          is recognized, or the original `record` reference otherwise.
 *
 * @example
 * ```ts
 * const mvi = projectMvi(taskRecord, 'task');
 * // { id: 'T9922', title: '...', status: 'pending', priority: 'high', ... }
 * ```
 */
export function projectMvi<T extends Record<string, unknown>>(
  record: T,
  kind: ProjectionKind,
): Partial<T> {
  if (kind === 'unknown') return record;
  const allow = MVI_FIELDS[kind];
  return pickFields(record, allow);
}

/**
 * Project every element of an array via {@link projectMvi}.
 *
 * @param records - Array of records to project. Empty arrays are returned
 *                  as-is.
 * @param kind    - The record kind applied to every element.
 * @returns A new array of projected records.
 *
 * @example
 * ```ts
 * const projected = projectMviList(tasks, 'task');
 * ```
 */
export function projectMviList<T extends Record<string, unknown>>(
  records: readonly T[],
  kind: ProjectionKind,
): Partial<T>[] {
  return records.map((r) => projectMvi(r, kind));
}

/**
 * Routing table that maps a canonical `<domain>.<operation>` identifier to the
 * projection plan for that op's response data.
 *
 * The plan tells the dispatch middleware which key inside the envelope data
 * carries the record(s) to project and what kind they are. A missing entry
 * means "no projection" — the op opts out by default.
 *
 * @remarks
 * Keep this map tight: only the read ops named in the T9922 acceptance
 * criteria (`tasks.show`, `tasks.list`, `tasks.find`, `docs.list`,
 * `docs.fetch`) are wired here. Adding new ops is a deliberate act — the
 * caller must reason about what an agent actually needs from the response.
 */
export interface ProjectionPlan {
  /**
   * The path inside `response.data` to project. Use `'$'` to project the
   * top-level data object itself. Dot-separated paths drill into nested
   * objects (e.g. `'task'` projects `data.task`).
   */
  path: string;
  /** The kind to apply at that path. */
  kind: ProjectionKind;
  /**
   * When `true`, treat the value at `path` as an array and project each
   * element. When `false`, treat it as a single record.
   */
  list: boolean;
}

/** SSoT for which ops get MVI-projected by default. */
export const PROJECTION_PLANS: Readonly<Record<string, ProjectionPlan>> = {
  'tasks.show': { path: 'task', kind: 'task', list: false },
  'tasks.list': { path: 'tasks', kind: 'task', list: true },
  'tasks.find': { path: 'results', kind: 'task', list: true },
  'docs.list': { path: 'attachments', kind: 'doc', list: true },
  'docs.fetch': { path: 'metadata', kind: 'doc', list: false },
};

/**
 * Apply the {@link PROJECTION_PLANS} entry for a given operation to a data
 * envelope.
 *
 * Mutation safety: the returned value is a new top-level object when the plan
 * matches; the original record references inside arrays are replaced with
 * projected copies. When the operation has no plan, the original `data`
 * reference is returned unchanged.
 *
 * Plans that point at a missing path (e.g. an empty list result that lacks
 * `tasks`) are no-ops — projection never throws on unexpected shapes.
 *
 * @param data      - The dispatch response `data` payload.
 * @param operation - The canonical `<domain>.<operation>` identifier.
 * @param mode      - `'mvi'` applies the plan; `'full'` is a no-op.
 * @returns The (possibly new) data payload after projection.
 */
export function applyProjectionPlan(
  data: unknown,
  operation: string,
  mode: ProjectionMode,
): unknown {
  if (mode === 'full') return data;
  const plan = PROJECTION_PLANS[operation];
  if (!plan) return data;
  if (data === null || data === undefined) return data;
  // `$` targets the data root directly.
  if (plan.path === '$') {
    if (plan.list && Array.isArray(data)) {
      return projectMviList(data as readonly Record<string, unknown>[], plan.kind);
    }
    if (!plan.list && typeof data === 'object') {
      return projectMvi(data as Record<string, unknown>, plan.kind);
    }
    return data;
  }
  if (typeof data !== 'object') return data;
  const container = data as Record<string, unknown>;
  const target = container[plan.path];
  if (target === undefined || target === null) return data;
  if (plan.list) {
    if (!Array.isArray(target)) return data;
    return {
      ...container,
      [plan.path]: projectMviList(target as readonly Record<string, unknown>[], plan.kind),
    };
  }
  if (typeof target !== 'object') return data;
  return {
    ...container,
    [plan.path]: projectMvi(target as Record<string, unknown>, plan.kind),
  };
}

/**
 * Resolve the projection mode for a request based on the opt-out signal.
 *
 * The CLI surfaces three flags that all mean "give me the full record":
 * `--verbose`, `--human`, and `--full`. Any of them flips the mode to
 * `'full'`; otherwise MVI is the default for the ops listed in
 * {@link PROJECTION_PLANS}.
 *
 * @param signal - The request-level opt-out signal. May arrive as a boolean
 *                 (when the CLI parsed a flag) or `undefined` (no flag set).
 * @returns The resolved {@link ProjectionMode}.
 */
export function resolveProjectionMode(signal: boolean | undefined): ProjectionMode {
  return signal === true ? 'full' : 'mvi';
}
