/**
 * `/studio/[projectId]/[sagaId]` — server load for the saga operator-console
 * shell (T11797 · E6-RESKIN-SHELL).
 *
 * Resolves the project from the `[projectId]` route param (NOT just the active
 * cookie, so a deep-link to any project's saga works), then loads the SHARED,
 * gateway-backed {@link loadExplorerBundle} ONCE. The shell projects that one
 * bundle into BOTH the workgraph pane ({@link WorkGraphView}, scoped to the
 * saga via the adapter's ancestor walk) and the kanban pane — exactly the
 * one-round-trip contract the `/tasks` explorer uses.
 *
 * The saga identity (`sagaTask`) is resolved from the bundle so the shell can
 * render the saga title + a "not found" state without a second query.
 *
 * @task T11797
 * @epic T11561 — E6-RESKIN-SHELL
 * @saga T11555
 */

import type { Task } from '@cleocode/contracts';
import { resolveProjectContext } from '$lib/server/project-context.js';
import { type ExplorerBundle, loadExplorerBundle } from '$lib/server/tasks/explorer-loader.js';
import type { PageServerLoad } from './$types';

/** The payload the shell page renders. */
export interface SagaShellData {
  /** The resolved project id (echoed for the breadcrumb). */
  projectId: string;
  /** Human-readable project name, or the id when unresolved. */
  projectName: string;
  /** The saga (or scope-root) id this shell is bound to. */
  sagaId: string;
  /** The resolved saga task identity, or null when not found in the bundle. */
  saga: Pick<Task, 'id' | 'title' | 'type' | 'status'> | null;
  /** The shared explorer bundle (tasks + deps) — both panes project this. */
  explorer: ExplorerBundle | null;
  /** Set when the project / tasks.db could not be read. */
  error?: string;
}

export const load: PageServerLoad = async ({ params, locals }): Promise<SagaShellData> => {
  const { projectId, sagaId } = params;

  // Resolve the project from the route param first; fall back to the active
  // context (cookie) when the param matches it — this lets a deep link target
  // ANY registered project, not just the currently-selected one.
  const ctx =
    locals.projectCtx.projectId === projectId
      ? locals.projectCtx
      : (resolveProjectContext(projectId) ?? null);

  if (!ctx?.tasksDbExists) {
    return {
      projectId,
      projectName: ctx?.name ?? projectId,
      sagaId,
      saga: null,
      explorer: null,
      error: `Project "${projectId}" is not registered or has no tasks database.`,
    };
  }

  try {
    const explorer = await loadExplorerBundle({ projectCtx: ctx });
    const sagaTask = explorer.tasks.find((t) => t.id === sagaId) ?? null;
    return {
      projectId,
      projectName: ctx.name,
      sagaId,
      saga: sagaTask
        ? { id: sagaTask.id, title: sagaTask.title, type: sagaTask.type, status: sagaTask.status }
        : null,
      explorer,
    };
  } catch (e) {
    return {
      projectId,
      projectName: ctx.name,
      sagaId,
      saga: null,
      explorer: null,
      error: e instanceof Error ? e.message : 'Failed to load the saga workgraph bundle.',
    };
  }
};
