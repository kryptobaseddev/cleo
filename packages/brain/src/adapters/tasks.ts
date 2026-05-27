/**
 * TASKS substrate adapter for the Living Brain API.
 *
 * Queries tasks.db and returns BrainNodes/BrainEdges for tasks and sessions.
 * Prioritises critical/high priority tasks and active sessions.
 *
 * Node IDs are prefixed with "tasks:" to prevent collisions.
 */

import { allTyped, getTasksDb } from '../db-connections.js';
import { resolveDefaultProjectContext } from '../project-context.js';
import type { BrainEdge, BrainNode, BrainQueryOptions } from '../types.js';

/** Raw row from tasks table. */
interface TaskRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  type: string;
  parent_id: string | null;
  created_at: string;
}

/** Raw row from sessions table. */
interface SessionRow {
  id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
}

/** Raw row from task_relations. */
interface TaskRelationRow {
  task_id: string;
  related_task_id: string;
  relation_type: string;
}

/** Raw row from task_dependencies. */
interface TaskDepRow {
  task_id: string;
  depends_on_task_id: string;
}

/** Maps priority string to numeric weight for BrainNode.weight. */
function priorityWeight(priority: string): number {
  const map: Record<string, number> = {
    critical: 1.0,
    high: 0.75,
    medium: 0.5,
    low: 0.25,
  };
  return map[priority] ?? 0.25;
}

/**
 * Returns all BrainNodes and BrainEdges sourced from tasks.db.
 *
 * Fetches tasks ordered by priority, plus recent sessions.
 * Synthesizes parent→child, dependency, and relation edges.
 *
 * @param options - Query options (limit, minWeight).
 * @returns Nodes and edges from the TASKS substrate.
 */
export function getTasksSubstrate(options: BrainQueryOptions = {}): {
  nodes: BrainNode[];
  edges: BrainEdge[];
} {
  const ctx = options.projectCtx ?? resolveDefaultProjectContext();
  const db = getTasksDb(ctx);
  if (!db) return { nodes: [], edges: [] };

  const perSubstrateLimit = Math.ceil((options.limit ?? 500) / 5);
  const minWeight = options.minWeight ?? 0;

  const nodes: BrainNode[] = [];
  const edges: BrainEdge[] = [];

  try {
    // Tasks (prioritised by severity, then recency)
    const taskRows = allTyped<TaskRow>(
      db.prepare(
        `SELECT id, title, status, priority, type, parent_id, created_at
         FROM tasks
         WHERE status NOT IN ('archived', 'cancelled')
         ORDER BY
           CASE priority
             WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3
           END,
           created_at DESC
         LIMIT ?`,
      ),
      Math.ceil(perSubstrateLimit * 0.8),
    );

    const taskIds = new Set<string>();
    for (const row of taskRows) {
      const weight = priorityWeight(row.priority);
      if (weight < minWeight) continue;
      taskIds.add(row.id);
      nodes.push({
        id: `tasks:${row.id}`,
        kind: 'task',
        substrate: 'tasks',
        label: row.title,
        weight,
        createdAt: row.created_at,
        meta: {
          status: row.status,
          priority: row.priority,
          type: row.type,
          parent_id: row.parent_id,
          created_at: row.created_at,
        },
      });
    }

    // Sessions (most recent)
    const sessionRows = allTyped<SessionRow>(
      db.prepare(
        `SELECT id, status, started_at, ended_at
         FROM sessions
         ORDER BY started_at DESC
         LIMIT ?`,
      ),
      Math.ceil(perSubstrateLimit * 0.2),
    );

    const sessionIds = new Set<string>();
    for (const row of sessionRows) {
      sessionIds.add(row.id);
      nodes.push({
        id: `tasks:${row.id}`,
        kind: 'session',
        substrate: 'tasks',
        label: `Session ${row.id.slice(-8)}`,
        weight: row.status === 'active' ? 0.9 : 0.4,
        createdAt: row.started_at,
        meta: {
          status: row.status,
          started_at: row.started_at,
          ended_at: row.ended_at,
        },
      });
    }

    // Parent → child task edges
    for (const row of taskRows) {
      if (row.parent_id && taskIds.has(row.parent_id)) {
        edges.push({
          source: `tasks:${row.parent_id}`,
          target: `tasks:${row.id}`,
          type: 'parent_of',
          weight: 0.9,
          substrate: 'tasks',
        });
      }
    }

    // Task relations
    if (taskIds.size > 0) {
      const placeholders = [...taskIds].map(() => '?').join(',');
      const relRows = allTyped<TaskRelationRow>(
        db.prepare(
          `SELECT task_id, related_task_id, relation_type
           FROM task_relations
           WHERE task_id IN (${placeholders})
             AND related_task_id IN (${placeholders})`,
        ),
        ...taskIds,
        ...taskIds,
      );

      for (const row of relRows) {
        edges.push({
          source: `tasks:${row.task_id}`,
          target: `tasks:${row.related_task_id}`,
          type: row.relation_type,
          weight: 0.7,
          substrate: 'tasks',
        });
      }

      // Task dependencies
      const depRows = allTyped<TaskDepRow>(
        db.prepare(
          `SELECT task_id, depends_on_task_id
           FROM task_dependencies
           WHERE task_id IN (${placeholders})
             AND depends_on_task_id IN (${placeholders})`,
        ),
        ...taskIds,
        ...taskIds,
      );

      for (const row of depRows) {
        edges.push({
          source: `tasks:${row.task_id}`,
          target: `tasks:${row.depends_on_task_id}`,
          type: 'depends_on',
          weight: 0.85,
          substrate: 'tasks',
        });
      }
    }
  } catch {
    // Return partial results on error
  }

  return { nodes, edges };
}
