/**
 * computeCriticalPath — pure-functional longest-path finder for a dependency DAG.
 *
 * Uses Kahn's topological sort + dynamic programming to find the longest path.
 * Returns an empty array when the graph contains a cycle.
 *
 * @arch SDK Tool (Category B) — pure, no side effects, contracts-typed
 * @task T10068
 * @epic T9835
 */

import type { CriticalPathEdge, CriticalPathNode, CriticalPathResult } from '@cleocode/contracts';

/**
 * Compute the critical (longest) path through a dependency DAG.
 *
 * The `epicId` node is excluded from end-node selection so the path represents
 * the deepest leaf work, not the epic container itself. Returns task IDs from
 * path start to end; returns an empty path when the graph has cycles.
 *
 * @param nodes - All task nodes in the scoped graph
 * @param edges - Directed edges (dependency → dependent)
 * @param epicId - Epic container ID to exclude from end-node selection
 * @returns Critical path result with ordered IDs and length
 *
 * @example
 * ```typescript
 * const nodes = [
 *   { id: 'T1', title: 'Setup', status: 'done', depends: [] },
 *   { id: 'T2', title: 'Build', status: 'pending', depends: ['T1'] },
 *   { id: 'T3', title: 'Test',  status: 'pending', depends: ['T2'] },
 * ];
 * const edges = [{ from: 'T1', to: 'T2' }, { from: 'T2', to: 'T3' }];
 * const { path } = computeCriticalPath(nodes, edges, 'E1');
 * // path === ['T1', 'T2', 'T3']
 * ```
 */
export function computeCriticalPath(
  nodes: CriticalPathNode[],
  edges: CriticalPathEdge[],
  epicId: string,
): CriticalPathResult {
  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  for (const n of nodes) {
    if (!forward.has(n.id)) forward.set(n.id, []);
    if (!backward.has(n.id)) backward.set(n.id, []);
  }
  for (const e of edges) {
    (forward.get(e.from) ?? []).push(e.to);
    (backward.get(e.to) ?? []).push(e.from);
  }

  // Kahn's topological sort
  const inDegree = new Map<string, number>();
  for (const n of nodes) inDegree.set(n.id, (backward.get(n.id) ?? []).length);

  const longest = new Map<string, number>();
  const prev = new Map<string, string | null>();
  for (const n of nodes) {
    longest.set(n.id, 1);
    prev.set(n.id, null);
  }

  const topo: string[] = [];
  const remaining = new Map(inDegree);
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  while (queue.length > 0) {
    const cur = queue.shift()!;
    topo.push(cur);
    for (const next of forward.get(cur) ?? []) {
      const curLen = (longest.get(cur) ?? 1) + 1;
      if (curLen > (longest.get(next) ?? 1)) {
        longest.set(next, curLen);
        prev.set(next, cur);
      }
      const deg = (remaining.get(next) ?? 1) - 1;
      remaining.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }

  if (topo.length === 0) return { path: [], length: 0 };

  // Find end node with maximum longest-path value (excluding epicId)
  let maxLen = 0;
  let endNode = '';
  for (const [id, len] of longest) {
    if (id === epicId) continue;
    if (len > maxLen) {
      maxLen = len;
      endNode = id;
    }
  }

  if (!endNode) return { path: [], length: 0 };

  // Trace back from endNode
  const path: string[] = [];
  let cur: string | null = endNode;
  while (cur) {
    path.unshift(cur);
    cur = prev.get(cur) ?? null;
  }

  return { path, length: path.length };
}
