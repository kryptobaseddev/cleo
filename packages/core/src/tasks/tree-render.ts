/**
 * Dep-tree text and Mermaid rendering helpers.
 * @task T10064
 * @epic T9834
 */

/** Node shape used by rendering helpers. */
export interface TreeNode {
  id: string;
  title: string;
  status: string;
  depends: string[];
}

/** Edge shape. */
export interface TreeEdge {
  from: string;
  to: string;
}

/** Status symbol for text output. */
function statusSymbol(status: string): string {
  switch (status) {
    case 'done':
      return '[x]';
    case 'cancelled':
      return '[-]';
    case 'active':
      return '[>]';
    default:
      return '[ ]';
  }
}

/**
 * Compute the critical (longest) path through a dep DAG using topological DP.
 * Returns task IDs from the path start to end.
 *
 * @param nodes   - DAG nodes.
 * @param edges   - DAG edges (from dep to dependent).
 * @param epicId  - Root epic ID to exclude from end-node selection.
 */
export function computeCriticalPath(
  nodes: TreeNode[],
  edges: TreeEdge[],
  epicId: string,
): string[] {
  // Build adjacency: from → [to, ...] (dependency → dependent)
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

  // Topological sort (Kahn's)
  const inDegree = new Map<string, number>();
  for (const n of nodes) inDegree.set(n.id, (backward.get(n.id) ?? []).length);

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const longest = new Map<string, number>();
  const prev = new Map<string, string | null>();
  for (const n of nodes) {
    longest.set(n.id, 1);
    prev.set(n.id, null);
  }

  const topo: string[] = [];
  const remaining = new Map(inDegree);
  const q = [...queue];
  while (q.length > 0) {
    const cur = q.shift()!;
    topo.push(cur);
    for (const next of forward.get(cur) ?? []) {
      const curLen = (longest.get(cur) ?? 1) + 1;
      if (curLen > (longest.get(next) ?? 1)) {
        longest.set(next, curLen);
        prev.set(next, cur);
      }
      const deg = (remaining.get(next) ?? 1) - 1;
      remaining.set(next, deg);
      if (deg === 0) q.push(next);
    }
  }

  if (topo.length === 0) return []; // cycle — skip

  // Find the node with the maximum longest-path value
  let maxLen = 0;
  let endNode = '';
  for (const [id, len] of longest) {
    if (id === epicId) continue; // exclude the epic root from end selection
    if (len > maxLen) {
      maxLen = len;
      endNode = id;
    }
  }

  if (!endNode) return [];

  // Trace back from endNode
  const path: string[] = [];
  let cur: string | null = endNode;
  while (cur) {
    path.unshift(cur);
    cur = prev.get(cur) ?? null;
  }

  return path;
}

/**
 * Render a simple ASCII dep tree.
 * Groups tasks by their immediate deps (roots first, then dependents).
 *
 * @param nodes        - DAG nodes.
 * @param _edges       - DAG edges (unused in text rendering).
 * @param criticalPath - IDs on the critical path (marked with **).
 */
export function renderTextTree(
  nodes: TreeNode[],
  _edges: TreeEdge[],
  criticalPath: string[],
): string {
  const cpSet = new Set(criticalPath);
  const lines: string[] = [];

  // Roots (no deps inside the scoped set)
  const roots = nodes.filter((n) => n.depends.length === 0);
  // Non-roots
  const nonRoots = nodes.filter((n) => n.depends.length > 0);

  lines.push('Dep tree:');
  for (const n of roots) {
    const cp = cpSet.has(n.id) ? ' **' : '';
    lines.push(`  ${statusSymbol(n.status)} ${n.id}: ${n.title}${cp}`);
  }
  if (nonRoots.length > 0) {
    lines.push('  Dependencies:');
    for (const n of nonRoots) {
      const cp = cpSet.has(n.id) ? ' **' : '';
      lines.push(`  ${statusSymbol(n.status)} ${n.id}: ${n.title}${cp}`);
      for (const depId of n.depends) {
        lines.push(`    <- ${depId}`);
      }
    }
  }

  if (criticalPath.length > 0) {
    lines.push(`\nCritical path (** marked): ${criticalPath.join(' -> ')}`);
  }

  return lines.join('\n');
}

/**
 * Render a Mermaid graph TD block.
 * Escapes double-quotes in task titles to prevent parse errors.
 *
 * @param nodes        - DAG nodes.
 * @param edges        - DAG edges.
 * @param criticalPath - IDs on the critical path (styled with critical class).
 */
export function renderMermaidTree(
  nodes: TreeNode[],
  edges: TreeEdge[],
  criticalPath: string[],
): string {
  const cpSet = new Set(criticalPath);
  const lines: string[] = ['graph TD'];

  for (const n of nodes) {
    // Escape quotes and brackets in titles for Mermaid safety
    const safeTitle = n.title.replace(/"/g, "'").replace(/[[\]]/g, '');
    lines.push(`  ${n.id}["${n.id}: ${safeTitle} (${n.status})"]`);
  }

  for (const e of edges) {
    lines.push(`  ${e.from} --> ${e.to}`);
  }

  if (cpSet.size > 0) {
    lines.push('  classDef critical fill:#f96,stroke:#c00;');
    for (const id of cpSet) {
      lines.push(`  class ${id} critical;`);
    }
  }

  return lines.join('\n');
}
