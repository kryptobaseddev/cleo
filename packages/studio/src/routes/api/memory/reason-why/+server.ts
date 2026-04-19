/**
 * Memory causal-trace (reason.why) API endpoint (T990 Wave 1D).
 *
 * GET /api/memory/reason-why?taskId=<id>
 *
 * Returns an unresolved-blocker walk for the given task: starting from
 * the task's dependencies that are still `pending` or `blocked`, recurse
 * through their blockers to a fixed depth. Leaf blockers (no further
 * unresolved upstream deps) are flagged as root causes.
 *
 * Implementation note: the canonical `memory.reason.why` CLI op uses the
 * CLEO core facade to join tasks + decisions. For Studio we materialise
 * the trace against tasks.db + brain.db directly so we can ship the UI
 * without the SDK-backed dispatch layer. The response shape mirrors
 * `MemoryReasonWhyResult` from contracts so a future switch is a swap,
 * not a rewrite.
 *
 * @task T990
 * @wave 1D
 */

import { json } from '@sveltejs/kit';
import { getBrainDb, getTasksDb } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

/** A single decision node in the trace. */
export interface ReasonDecisionNode {
  id: string;
  title: string;
  rationale: string;
}

/** A single blocker node in the causal trace. */
export interface ReasonBlockerNode {
  taskId: string;
  status: string;
  title: string;
  reason: string | null;
  depth: number;
  decisions: ReasonDecisionNode[];
}

/** Response shape for GET /api/memory/reason-why. */
export interface ReasonWhyResponse {
  taskId: string;
  blockers: ReasonBlockerNode[];
  rootCauses: string[];
  depth: number;
}

const MAX_DEPTH = 5;
const UNRESOLVED_STATUSES = new Set(['pending', 'blocked', 'proposed', 'active']);

export const GET: RequestHandler = ({ locals, url }) => {
  const taskId = (url.searchParams.get('taskId') ?? '').trim();

  if (!taskId) {
    return json({ taskId: '', blockers: [], rootCauses: [], depth: 0 } satisfies ReasonWhyResponse);
  }

  const tasksDb = getTasksDb(locals.projectCtx);
  const brainDb = getBrainDb(locals.projectCtx);

  if (!tasksDb) {
    return json({ taskId, blockers: [], rootCauses: [], depth: 0 } satisfies ReasonWhyResponse);
  }

  try {
    /** Existence check. */
    const rootRow = tasksDb
      .prepare('SELECT id, status, title FROM tasks WHERE id = ?')
      .get(taskId) as { id: string; status: string; title: string } | undefined;

    if (!rootRow) {
      return json({ taskId, blockers: [], rootCauses: [], depth: 0 } satisfies ReasonWhyResponse);
    }

    // BFS walk through dependencies (tasks.dependencies.dep_id) for
    // unresolved parents.
    const visited = new Set<string>();
    const blockers: ReasonBlockerNode[] = [];
    const rootCauses: string[] = [];

    interface Frame {
      taskId: string;
      depth: number;
    }
    const queue: Frame[] = [{ taskId, depth: 0 }];
    let maxDepth = 0;

    while (queue.length > 0) {
      const frame = queue.shift();
      if (!frame) break;
      if (visited.has(frame.taskId)) continue;
      visited.add(frame.taskId);

      if (frame.depth > MAX_DEPTH) continue;
      maxDepth = Math.max(maxDepth, frame.depth);

      // Read children = dependencies (things this task depends on).
      let depIds: string[] = [];
      try {
        const depRows = tasksDb
          .prepare('SELECT dep_id FROM task_dependencies WHERE task_id = ?')
          .all(frame.taskId) as Array<{ dep_id: string }>;
        depIds = depRows.map((r) => r.dep_id);
      } catch {
        depIds = [];
      }

      const unresolvedChildren: string[] = [];
      for (const depId of depIds) {
        const row = tasksDb
          .prepare('SELECT id, status, title FROM tasks WHERE id = ?')
          .get(depId) as { id: string; status: string; title: string } | undefined;
        if (!row) continue;
        if (!UNRESOLVED_STATUSES.has(row.status.toLowerCase())) continue;

        unresolvedChildren.push(row.id);

        // Attach decisions referencing this task.
        let decisions: ReasonDecisionNode[] = [];
        if (brainDb) {
          try {
            const decRows = brainDb
              .prepare(
                `SELECT id, decision, rationale
                 FROM brain_decisions
                 WHERE context_task_id = ?
                   AND invalid_at IS NULL
                 ORDER BY created_at DESC
                 LIMIT 5`,
              )
              .all(row.id) as Array<{ id: string; decision: string; rationale: string }>;
            decisions = decRows.map((d) => ({
              id: d.id,
              title: d.decision,
              rationale: d.rationale,
            }));
          } catch {
            decisions = [];
          }
        }

        blockers.push({
          taskId: row.id,
          status: row.status,
          title: row.title,
          reason: null,
          depth: frame.depth + 1,
          decisions,
        });

        queue.push({ taskId: row.id, depth: frame.depth + 1 });
      }

      // Leaf (no unresolved children) that is itself unresolved → root cause.
      if (frame.depth > 0 && unresolvedChildren.length === 0) {
        rootCauses.push(frame.taskId);
      }
    }

    return json({
      taskId,
      blockers,
      rootCauses,
      depth: maxDepth,
    } satisfies ReasonWhyResponse);
  } catch {
    return json({ taskId, blockers: [], rootCauses: [], depth: 0 } satisfies ReasonWhyResponse);
  }
};
