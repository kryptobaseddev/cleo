/**
 * `/studio/[projectId]` — the saga picker for the operator-console shell
 * (T11558 · E3-WORKGRAPH-VIEW · navigation project ▸ saga ▸ workgraph).
 *
 * Lists the project's sagas (and standalone epics) so an operator can drill
 * from a project into a saga's `/studio/[projectId]/[sagaId]` workgraph shell.
 * Projects the SHARED, gateway-backed {@link loadExplorerBundle} — the same
 * one-round-trip source the explorer + shell use — so no second query and no
 * direct DB read.
 *
 * @task T11558
 * @epic T11558 — E3-WORKGRAPH-VIEW
 * @saga T11555
 */

import { resolveProjectContext } from '$lib/server/project-context.js';
import { loadExplorerBundle } from '$lib/server/tasks/explorer-loader.js';
import type { PageServerLoad } from './$types';

/** One pickable root in the saga picker. */
export interface SagaPickRow {
  /** Task id. */
  id: string;
  /** Title. */
  title: string;
  /** Root type — `saga` or standalone `epic`. */
  type: string;
  /** Lifecycle status. */
  status: string;
  /** Count of descendant tasks (subtree size, for the chip). */
  descendantCount: number;
}

/** The payload the picker renders. */
export interface SagaPickerData {
  /** Resolved project id (echo). */
  projectId: string;
  /** Project display name. */
  projectName: string;
  /** Sagas + standalone epics, sorted by descendant count desc. */
  roots: SagaPickRow[];
  /** Set when the project / tasks.db could not be read. */
  error?: string;
}

export const load: PageServerLoad = async ({ params, locals }): Promise<SagaPickerData> => {
  const { projectId } = params;

  const ctx =
    locals.projectCtx.projectId === projectId
      ? locals.projectCtx
      : (resolveProjectContext(projectId) ?? null);

  if (!ctx?.tasksDbExists) {
    return {
      projectId,
      projectName: ctx?.name ?? projectId,
      roots: [],
      error: `Project "${projectId}" is not registered or has no tasks database.`,
    };
  }

  try {
    const explorer = await loadExplorerBundle({ projectCtx: ctx });

    // Build a parent → children adjacency once, then count each root's subtree.
    const childrenOf = new Map<string, string[]>();
    for (const t of explorer.tasks) {
      if (!t.parentId) continue;
      const list = childrenOf.get(t.parentId);
      if (list) list.push(t.id);
      else childrenOf.set(t.parentId, [t.id]);
    }

    const subtreeCount = (rootId: string): number => {
      let count = 0;
      const stack = [...(childrenOf.get(rootId) ?? [])];
      const seen = new Set<string>();
      while (stack.length > 0) {
        const id = stack.pop();
        if (id === undefined || seen.has(id)) continue;
        seen.add(id);
        count += 1;
        const kids = childrenOf.get(id);
        if (kids) stack.push(...kids);
      }
      return count;
    };

    const roots: SagaPickRow[] = explorer.tasks
      .filter((t) => t.type === 'saga' || (t.type === 'epic' && !t.parentId))
      .map((t) => ({
        id: t.id,
        title: t.title,
        type: t.type ?? 'task',
        status: t.status,
        descendantCount: subtreeCount(t.id),
      }))
      .sort((a, b) => b.descendantCount - a.descendantCount || a.id.localeCompare(b.id));

    return { projectId, projectName: ctx.name, roots };
  } catch (e) {
    return {
      projectId,
      projectName: ctx.name,
      roots: [],
      error: e instanceof Error ? e.message : 'Failed to load the saga list.',
    };
  }
};
