/**
 * renderTaskTreeText / renderTaskTreeMermaid — pure-functional tree renderers.
 *
 * Convert a scoped dependency graph into a human-readable ASCII tree or a
 * Mermaid graph TD block. Both renderers are stateless and produce a string.
 *
 * @arch SDK Tool (Category B) — pure, no side effects, contracts-typed
 * @task T10068
 * @epic T9835
 */

import type { RenderTaskTreeInput } from '@cleocode/contracts';

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
 * Render a simple ASCII dependency tree.
 *
 * Root tasks (no dependencies within the scoped set) are listed first.
 * Tasks on the critical path are marked with `**`.
 *
 * @param input - Nodes, edges, and critical path
 * @returns ASCII text block
 *
 * @example
 * ```typescript
 * const text = renderTaskTreeText({ nodes, edges, criticalPath: ['T1', 'T2'] });
 * // "Dep tree:\n  [ ] T1: Setup **\n  [ ] T2: Build **\n  ..."
 * ```
 */
export function renderTaskTreeText(input: RenderTaskTreeInput): string {
  const { nodes, edges: _edges, criticalPath } = input;
  const cpSet = new Set(criticalPath);
  const lines: string[] = [];

  const roots = nodes.filter((n) => n.depends.length === 0);
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
 * Render a Mermaid `graph TD` block.
 *
 * Escapes double-quotes and brackets in task titles to prevent parse errors.
 * Tasks on the critical path are styled with an orange-red highlight.
 *
 * @param input - Nodes, edges, and critical path
 * @returns Mermaid graph TD string
 *
 * @example
 * ```typescript
 * const mermaid = renderTaskTreeMermaid({ nodes, edges, criticalPath: ['T1'] });
 * // "graph TD\n  T1[\"T1: Setup (pending)\"]\n  ..."
 * ```
 */
export function renderTaskTreeMermaid(input: RenderTaskTreeInput): string {
  const { nodes, edges, criticalPath } = input;
  const cpSet = new Set(criticalPath);
  const lines: string[] = ['graph TD'];

  for (const n of nodes) {
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
