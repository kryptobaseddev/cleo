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

import { ExitCode, type RecordProjectionDisclosure } from '@cleocode/contracts';
import { projectionFieldBytes, TokenEstimator } from '@cleocode/lafs';
import { CleoError } from '../errors.js';

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
 * Envelope key naming every field the projection withheld.
 *
 * Why this exists (T12121 · GH #1243)
 * -----------------------------------
 * The MVI projection dropped non-allow-listed fields with NO record of having
 * done so, and `description` is not on the task allow-list. So
 * `cleo show <id>` returned a task whose 1440-character description was not
 * truncated, not null — the key was simply ABSENT. An absent key and an empty
 * value are indistinguishable to every consumer, so the idiomatic, careful
 * read reported a populated field as empty:
 *
 * ```python
 * desc = task.get('description') or ''   # -> '' for a 1440-char description
 * ```
 *
 * That turned a read defect into a DATA-LOSS defect on 2026-09-12: one agent
 * filed T289 with a full mechanism description; a second ran `cleo show T289`
 * without `--full`, read nothing, correctly-by-its-own-logic concluded the
 * task was a title-only stub, and overwrote the description. It also broke
 * CLEO's own documented recovery for a killed write ("query before retrying"),
 * because querying without `--full` reports the record as empty — so the
 * recommended recovery step is exactly what authorises the clobber.
 *
 * The invariant this key restores: **a field that exists on the record is
 * present in the envelope, or is explicitly marked as withheld.** The marker
 * carries each withheld field's content size, which is the signal that
 * distinguishes the two cases the incident confused — a genuine stub has no
 * marker at all, while a populated record reports `{ description: 1440 }`.
 *
 * A withheld field's VALUE is deliberately not reproduced here, truncated or
 * otherwise. A truncated copy under the real field name would be worse than
 * absence: a consumer that read it and wrote it back would silently corrupt
 * the record, where absence only risks an overwrite with fresh text.
 *
 * @task T12121
 */
export const WITHHELD_KEY = '_withheld';

/**
 * Domain facts that must survive record projection and envelope budgeting.
 * Uses the shared knowledge coverage, authority, diagnostic and repair field
 * names; callers pass this policy into LAFS's domain-neutral requiredFields.
 */
export const MVI_TRUTH_FIELDS: readonly string[] = [
  'id',
  'identity',
  'scope',
  'projectId',
  'sourceRoot',
  'coverage',
  'knowledgeCoverage',
  'knowledgeHealth',
  'health',
  'sourceDiagnostics',
  'authority',
  'corrections',
  'warnings',
  'findings',
  'reasonCount',
  'evidenceCount',
  'findingCount',
  'findingStates',
  'detailsCommand',
  'maintenanceState',
  'nextAction',
  'limitations',
  'assessedRevision',
  'indexedRevision',
  'assessedAt',
  'precision',
  'population',
  'match',
  'searchType',
  // A population count cannot outlive the rows it describes under a budget.
  'tasks',
  'results',
];
const mandatoryFields = new Set(MVI_TRUTH_FIELDS);

/** Read a previous projection's omission facts without losing its provenance. */
function previousWithheld(record: Record<string, unknown>): Record<string, number> {
  const marker = record[WITHHELD_KEY];
  const withheld: Record<string, number> = {};
  if (marker && typeof marker === 'object' && !Array.isArray(marker)) {
    for (const [key, size] of Object.entries(marker)) {
      if (typeof size === 'number' && Number.isFinite(size) && size >= 0) withheld[key] = size;
    }
  }
  return withheld;
}

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
 * Retain omission provenance when an SDK constructs its own compact shape.
 * Uses the same field accounting, mandatory truth and prior-omission rules as
 * dispatch projection. Synthetic fields remain present; source fields omitted
 * by successive projections remain named with their original byte sizes.
 */
export function discloseProjection<
  Source extends Record<string, unknown>,
  Projected extends Record<string, unknown>,
>(source: Source, projected: Projected): Projected & RecordProjectionDisclosure {
  const { picked, withheld } = pickFields(source, new Set(Object.keys(projected)));
  return { ...projected, ...withWithheldMarker({ ...picked, ...projected }, withheld) };
}

/**
 * Pick the MVI-allow-listed keys out of a record, reporting what was withheld.
 *
 * @returns `picked` — the allow-listed subset; `withheld` — a field→byte-size
 *          map of every key present on the source record but absent from
 *          `picked`, including null/empty fields and previous omissions.
 *
 * @internal
 */
function pickFields<T extends Record<string, unknown>>(
  record: T,
  allow: ReadonlySet<string>,
): { picked: Partial<T>; withheld: Record<string, number> } {
  const picked: Partial<T> = {};
  const withheld = previousWithheld(record);
  for (const key of Object.keys(record)) {
    if (allow.has(key) || mandatoryFields.has(key)) {
      // Index assertion is safe: `key` came from Object.keys(record).
      (picked as Record<string, unknown>)[key] = record[key];
      delete withheld[key];
      continue;
    }
    if (key === WITHHELD_KEY) continue;
    withheld[key] = projectionFieldBytes(record[key]);
  }
  return { picked, withheld };
}

/**
 * Attach the {@link WITHHELD_KEY} marker to a projected record.
 *
 * The marker is inserted immediately after `id` so that, under a token budget,
 * the drop-from-the-end order sacrifices content fields
 * before the statement of what is missing. A record that admits it is partial
 * is more useful than one extra field with no warning.
 *
 * @internal
 */
function withWithheldMarker<T extends Record<string, unknown>>(
  projected: Partial<T>,
  withheld: Record<string, number>,
): Partial<T> {
  if (Object.keys(withheld).length === 0) return projected;
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(withheld).sort()) {
    const bytes = withheld[key];
    if (bytes !== undefined) sorted[key] = bytes;
  }

  const source = projected as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if ('id' in source) out['id'] = source['id'];
  out[WITHHELD_KEY] = sorted;
  for (const key of Object.keys(source)) {
    if (key === 'id' || key === WITHHELD_KEY) continue;
    out[key] = source[key];
  }
  return out as Partial<T>;
}

/**
 * Project under a hard token budget, retaining every omission and mandatory
 * knowledge fact. Budgets too small for these facts fail explicitly.
 */
function projectWithinBudget<T extends Record<string, unknown>>(
  original: T,
  picked: Partial<T>,
  budget: number,
  estimator: TokenEstimator,
): Partial<T> {
  const candidate = { ...picked };
  const withheld = previousWithheld(original);
  for (const key of Object.keys(original)) {
    if (key === WITHHELD_KEY) continue;
    if (key in candidate) delete withheld[key];
    else withheld[key] = projectionFieldBytes(original[key]);
  }
  const droppable = Object.keys(candidate).filter(
    (key) => key !== WITHHELD_KEY && !mandatoryFields.has(key),
  );
  for (;;) {
    const marked = withWithheldMarker(candidate, withheld);
    if (estimator.estimate(marked) <= budget) return marked;
    const key = droppable.pop();
    if (key === undefined) {
      throw new CleoError(
        ExitCode.VALIDATION_ERROR,
        'MVI budget is too small for mandatory truth fields and omission disclosure',
        {
          details: { field: 'budget', actual: budget, expected: estimator.estimate(marked) },
          fix: 'Raise the budget or request fewer records; omitted fields cannot be hidden.',
        },
      );
    }
    withheld[key] = projectionFieldBytes(candidate[key]);
    delete candidate[key];
  }
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
  const { picked, withheld } = pickFields(record, allow);
  return withWithheldMarker(picked, withheld);
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
   * fits without dropping truth fields or omission disclosure. An insufficient
   * budget throws a validation error. Omit for field-allow-listing only.
   */
  budget?: number;
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
 *    optional fields until the record fits; fail if mandatory facts cannot fit.
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
 * // Budget-aware — keeps mandatory truth fields or rejects the budget.
 * projectMVI(bigRecord, { kind: 'task', budget: 200 });
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
  const { picked, withheld } = pickFields(record, allow);

  // Budgeting must retain the same omission provenance as field selection.
  if (options.budget !== undefined) {
    if (!Number.isFinite(options.budget) || options.budget < 0) {
      throw new CleoError(
        ExitCode.VALIDATION_ERROR,
        'MVI budget must be a finite non-negative number',
      );
    }
    return projectWithinBudget(record, picked, options.budget, new TokenEstimator());
  }
  return withWithheldMarker(picked, withheld);
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
