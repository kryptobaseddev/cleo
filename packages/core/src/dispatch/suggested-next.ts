/**
 * `attachSuggestedNext` — envelope-construction helper for the
 * envelope-wide `meta.suggestedNext` field promoted in T9920.
 *
 * Before T9920, only the nexus domain stamped a structured
 * `meta._nexus.suggestedNext: ReadonlyArray<SuggestedNextOp>` block on
 * dispatch responses. T9920 promotes a flat `ReadonlyArray<string>`
 * projection to {@link CliMeta.suggestedNext} so every operation
 * (mutate, query, decorator) can attach chained-reasoning hints
 * without leaking the richer nexus-internal shape across domain
 * boundaries.
 *
 * This helper is intentionally tiny — it deep-clones `envelope.meta`
 * and overwrites `suggestedNext`. The original envelope is never
 * mutated (immutability is a stronger guarantee than the type
 * system's `Readonly` markers, which only prevent direct assignment).
 *
 * @module @cleocode/core/dispatch/suggested-next
 *
 * @epic T9919
 * @task T9920
 * @saga T9855
 */

import type { CliEnvelope } from '@cleocode/lafs';

// ---------------------------------------------------------------------------
// Per-op suggestion builders (T9921 — Saga T9855 / E8.2)
//
// Co-located with `attachSuggestedNext` so the SSoT for "what does each
// tasks.* mutate op emit as `meta.suggestedNext`" lives next to the helper
// that consumes it. The dispatch layer in `packages/cleo/src/dispatch/`
// imports `buildTasksSuggestedNext` and stamps the result onto
// `DispatchResponse.meta.suggestedNext` after a successful handler run.
//
// Builders are pure functions: `(params, data) => string[]`. They never
// throw, never read the filesystem, never depend on env. When no concrete
// follow-up makes sense (e.g. `tasks.find` with zero results), they
// return `[]` — renderers hide empty arrays from human output.
// ---------------------------------------------------------------------------

/** Result shape returned by `tasks.add` — minimal subset needed for suggestions. */
interface TasksAddResultShape {
  task?: { id?: string };
}

/** Result shape returned by `tasks.update` and `tasks.complete`. */
interface TasksTaskResultShape {
  task?: { id?: string };
}

/** Result shape returned by `tasks.find`. */
interface TasksFindResultShape {
  results?: ReadonlyArray<{ id?: string }>;
}

/** Param shape for `tasks.add-batch` — only `defaultParent` is needed here. */
interface TasksAddBatchParamsShape {
  defaultParent?: unknown;
}

/**
 * Operation-specific suggestion builder. Returns an array of copy-pasteable
 * CLI commands the agent may run next. Empty arrays are valid — they signal
 * "I considered this and no follow-up applies".
 *
 * @typeParam P - Operation params payload (raw `Record<string, unknown>` at the boundary).
 * @typeParam D - Operation result payload type.
 *
 * @public
 */
export type SuggestedNextBuilder = (params: Record<string, unknown>, data: unknown) => string[];

/**
 * Build a `suggestedNext` array for the `tasks.add` operation.
 *
 * Suggests inspecting the newly-created task and focusing the agent on it.
 * Returns `[]` when the result payload does not expose a task id.
 *
 * @param _params - Raw dispatch params (unused; preserved for builder signature uniformity).
 * @param data    - The `AddTaskResult` returned by the engine.
 * @returns Suggested follow-up CLI commands.
 *
 * @task T9921
 *
 * @public
 */
export function buildTasksAddSuggestedNext(
  _params: Record<string, unknown>,
  data: unknown,
): string[] {
  const id = (data as TasksAddResultShape | undefined)?.task?.id;
  if (typeof id !== 'string' || id.length === 0) return [];
  return [`cleo show ${id}`, `cleo focus ${id}`];
}

/**
 * Build a `suggestedNext` array for the `tasks.add-batch` operation.
 *
 * Suggests listing the parent's children (so the operator sees the newly
 * inserted tasks in context) and surfacing the ready wave for the parent
 * epic. The parent id is read from `params.defaultParent` first, and falls
 * back to the first inserted task's `parentId` is NOT inspected here —
 * `defaultParent` is the canonical batch-level wire field.
 *
 * Returns `[]` when no `defaultParent` was supplied (per-task `parent`
 * overrides cannot be aggregated into one suggestion).
 *
 * @param params - Raw dispatch params; only `defaultParent` is read.
 * @param _data  - The `AddBatchResult` returned by the engine.
 * @returns Suggested follow-up CLI commands.
 *
 * @task T9921
 *
 * @public
 */
export function buildTasksAddBatchSuggestedNext(
  params: Record<string, unknown>,
  _data: unknown,
): string[] {
  const parentId = (params as TasksAddBatchParamsShape).defaultParent;
  if (typeof parentId !== 'string' || parentId.length === 0) return [];
  return [`cleo list --parent ${parentId}`, `cleo orchestrate ready --epic ${parentId}`];
}

/**
 * Build a `suggestedNext` array for the `tasks.update` operation.
 *
 * Suggests inspecting the just-updated task so the operator can confirm
 * field changes landed as expected.
 *
 * @param _params - Raw dispatch params (unused).
 * @param data    - The `UpdateTaskResult` returned by the engine.
 * @returns Suggested follow-up CLI commands.
 *
 * @task T9921
 *
 * @public
 */
export function buildTasksUpdateSuggestedNext(
  _params: Record<string, unknown>,
  data: unknown,
): string[] {
  const id = (data as TasksTaskResultShape | undefined)?.task?.id;
  if (typeof id !== 'string' || id.length === 0) return [];
  return [`cleo show ${id}`];
}

/**
 * Build a `suggestedNext` array for the `tasks.complete` operation.
 *
 * Suggests advancing to the next task in the ready wave and recording a
 * memory observation about the just-completed work. Both suggestions are
 * always-applicable — no concrete id is needed beyond `cleo next` defaults.
 *
 * @param _params - Raw dispatch params (unused).
 * @param _data   - The `CompleteTaskResult` returned by the engine.
 * @returns Suggested follow-up CLI commands.
 *
 * @task T9921
 *
 * @public
 */
export function buildTasksCompleteSuggestedNext(
  _params: Record<string, unknown>,
  _data: unknown,
): string[] {
  return ['cleo next', 'cleo memory observe "..." --title "..."'];
}

/**
 * Build a `suggestedNext` array for the `tasks.find` operation.
 *
 * Suggests showing the first matching task and focusing the agent on it.
 * Returns `[]` when the search produced zero results — no concrete id is
 * available to interpolate.
 *
 * @param _params - Raw dispatch params (unused).
 * @param data    - The `FindTasksResult` returned by the engine.
 * @returns Suggested follow-up CLI commands.
 *
 * @task T9921
 *
 * @public
 */
export function buildTasksFindSuggestedNext(
  _params: Record<string, unknown>,
  data: unknown,
): string[] {
  const first = (data as TasksFindResultShape | undefined)?.results?.[0];
  const id = first?.id;
  if (typeof id !== 'string' || id.length === 0) return [];
  return [`cleo show ${id}`, `cleo focus ${id}`];
}

/**
 * Registry mapping `tasks.<op>` operation keys to their suggestion builders.
 *
 * The dispatch layer calls `TASKS_SUGGESTED_NEXT_BUILDERS[op]?.(params, data)`
 * after a successful handler run to derive the `suggestedNext` array.
 * Operations not present in the registry simply emit no suggestions —
 * `meta.suggestedNext` is absent on the response.
 *
 * @task T9921
 *
 * @public
 */
export const TASKS_SUGGESTED_NEXT_BUILDERS: Readonly<Record<string, SuggestedNextBuilder>> = {
  add: buildTasksAddSuggestedNext,
  'add-batch': buildTasksAddBatchSuggestedNext,
  update: buildTasksUpdateSuggestedNext,
  complete: buildTasksCompleteSuggestedNext,
  find: buildTasksFindSuggestedNext,
};

/**
 * Attach a list of suggested follow-up CLI commands to an envelope's
 * canonical {@link CliMeta.suggestedNext} field.
 *
 * The returned envelope is a shallow copy with a fresh `meta` object —
 * the input envelope is never mutated. Existing meta fields (including
 * `_nexus.suggestedNext` if present) are preserved verbatim; only the
 * top-level `meta.suggestedNext` array is replaced.
 *
 * Empty arrays are preserved (not dropped) so callers can explicitly
 * signal "I considered this and there are no follow-ups" — renderers
 * are responsible for hiding the field from human output when empty.
 *
 * @typeParam T - The envelope's `data` payload type.
 * @param envelope - The envelope to enrich. Not mutated.
 * @param suggestions - Copy-pasteable CLI command strings the agent may run next.
 * @returns A new envelope with `meta.suggestedNext` populated.
 *
 * @example
 * ```ts
 * import { attachSuggestedNext } from '@cleocode/core/dispatch/suggested-next';
 *
 * const enriched = attachSuggestedNext(envelope, [
 *   'cleo focus T1234',
 *   'cleo verify T1234 --gate implemented --evidence "commit:abc123"',
 * ]);
 * ```
 *
 * @public
 */
export function attachSuggestedNext<T>(
  envelope: CliEnvelope<T>,
  suggestions: ReadonlyArray<string>,
): CliEnvelope<T> {
  return {
    ...envelope,
    meta: {
      ...envelope.meta,
      suggestedNext: [...suggestions],
    },
  };
}
