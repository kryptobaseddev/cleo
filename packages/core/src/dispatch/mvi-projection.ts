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
 * @task T11351 (Epic T11285 EP-MVI-PRIMITIVE) — generalized budget-aware projector
 */

import { TokenEstimator } from '@cleocode/lafs';

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
  task: new Set([
    'id',
    'title',
    'status',
    'priority',
    'parentId',
    'type',
    'kind',
    'relationCounts',
  ]),
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
 * Generic identity/routing field allow-list applied to UNKNOWN kinds.
 *
 * When the projector meets a record kind that is not in {@link MVI_FIELDS}, it
 * must NOT leak the full payload (the pre-T11351 `projectMvi` passthrough did
 * exactly that). Instead it keeps only these universally-safe identity and
 * control-flow keys — the intersection an agent needs to route on any record.
 *
 * @task T11351
 */
const GENERIC_MVI_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'title',
  'name',
  'slug',
  'status',
  'priority',
  'type',
  'kind',
  'parentId',
]);

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
 * Options for the generalized {@link projectMVI} projector.
 *
 * @task T11351
 */
export interface ProjectMVIOptions {
  /**
   * Record kind. Known kinds (`task`/`epic`/`saga`/`doc`) use their
   * {@link MVI_FIELDS} allow-list; `'unknown'` (or any unrecognized value)
   * degrades to the {@link GENERIC_MVI_FIELDS} identity/routing set rather than
   * leaking the full record.
   */
  kind: ProjectionKind;
  /**
   * Projection mode. `'full'` is a no-op (returns the record unchanged);
   * `'mvi'` applies field selection. Defaults to `'mvi'`.
   */
  mode?: ProjectionMode;
  /**
   * Optional hard token budget. When set, the projected record is measured by
   * the LAFS {@link TokenEstimator} and trailing fields are dropped until it
   * fits. `id` is preserved as the last-resort minimum so the result is always
   * routable. Omit for field-allow-listing only (no token enforcement).
   */
  budget?: number;
}

/**
 * Drop trailing keys from a record until the LAFS token estimate fits `budget`.
 *
 * Iterates keys in insertion order, dropping from the end. `id` is treated as
 * sticky — it is never dropped while any other field could be — so the reduced
 * record stays routable. When even `{ id }` exceeds budget the record is
 * returned with just `id` (best effort; the LAFS budget chokepoint is the
 * coarser backstop for truly pathological cases).
 *
 * @internal
 */
function reduceToBudget<T extends Record<string, unknown>>(
  record: Partial<T>,
  budget: number,
  estimator: TokenEstimator,
): Partial<T> {
  if (estimator.estimate(record) <= budget) return record;

  const keys = Object.keys(record);
  // Drop non-id keys from the end until we fit (or only id remains).
  const droppable = keys.filter((k) => k !== 'id');
  for (let drop = 1; drop <= droppable.length; drop++) {
    const keep = new Set<string>(keys);
    for (let i = 0; i < drop; i++) {
      const victim = droppable[droppable.length - 1 - i];
      if (victim !== undefined) keep.delete(victim);
    }
    const candidate: Partial<T> = {};
    for (const key of keys) {
      if (keep.has(key)) (candidate as Record<string, unknown>)[key] = record[key];
    }
    if (estimator.estimate(candidate) <= budget) return candidate;
  }

  // Last resort: id only (or empty when there is no id).
  const minimal: Partial<T> = {};
  if ('id' in record) {
    (minimal as Record<string, unknown>)['id'] = (record as Record<string, unknown>)['id'];
  }
  return minimal;
}

/**
 * The single, generalized, budget-aware MVI projector.
 *
 * Supersedes the kind-only {@link projectMvi} for callers that need (a) graceful
 * degradation on unknown kinds and (b) a real token budget rather than pure
 * field-allow-listing:
 *
 * 1. `mode: 'full'` → returns the record unchanged.
 * 2. Known kind → keeps the kind's {@link MVI_FIELDS} allow-list.
 * 3. Unknown kind → keeps only {@link GENERIC_MVI_FIELDS} (never the full
 *    payload — this closes the pre-T11351 unknown-kind leak).
 * 4. If `budget` is set → delegates to the LAFS {@link TokenEstimator} and drops
 *    trailing fields until the projected record fits, keeping `id` as the
 *    last-resort minimum.
 *
 * @typeParam T - The record shape.
 * @param record  - The record to project. Non-object inputs are returned as-is.
 * @param options - {@link ProjectMVIOptions}.
 * @returns A new projected (and possibly budget-reduced) record.
 *
 * @example
 * ```ts
 * // Known kind, no budget — same field set as projectMvi(record, 'task').
 * projectMVI(taskRecord, { kind: 'task' });
 *
 * // Unknown kind — generic identity fields only, never the full payload.
 * projectMVI(weirdRecord, { kind: 'unknown' });
 *
 * // Budget-aware — reduces below 20 tokens.
 * projectMVI(bigRecord, { kind: 'task', budget: 20 });
 * ```
 *
 * @task T11351
 * @epic T11285
 */
export function projectMVI<T extends Record<string, unknown>>(
  record: T,
  options: ProjectMVIOptions,
): Partial<T> {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return record;
  }
  const mode = options.mode ?? 'mvi';
  if (mode === 'full') return record;

  // Step 1+2+3: field selection (known allow-list or generic fallback).
  const allow =
    options.kind === 'unknown' || !(options.kind in MVI_FIELDS)
      ? GENERIC_MVI_FIELDS
      : MVI_FIELDS[options.kind as Exclude<ProjectionKind, 'unknown'>];
  const projected = pickFields(record, allow);

  // Step 4: optional token-budget reduction via the LAFS estimator.
  if (typeof options.budget === 'number' && options.budget > 0) {
    return reduceToBudget(projected, options.budget, new TokenEstimator());
  }
  return projected;
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
