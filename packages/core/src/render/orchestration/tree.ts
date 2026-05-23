/**
 * Tree renderer for `cleo tree` / `cleo deps tree` / `cleo orchestrate`.
 *
 * Handles four data shapes returned by the `deps`/`tree` dispatcher:
 * - `data.waves`     — enriched wave array from `orchestrate.waves`
 * - `data.tree`      — recursive `FlatTreeNode[]` from `tasks.tree`
 * - `data.rendered`  — pre-formatted text/mermaid string from `tasks.deps.tree`
 * - `data.tasks`     — flat `Task[]` fallback
 *
 * When `data.waves` is present, delegates to {@link renderWaves}.
 * When `data.rendered` is a string, emits it as-is — CORE has already produced
 * the canonical text/mermaid output; this renderer is a thin wrapper that just
 * prints it.
 *
 * Migrated from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6).
 *
 * @task T10131
 */

import type { Task } from '@cleocode/contracts';
import { type FlatTreeNode, formatTree } from '../../formatters/index.js';
import { cliColorize } from '../cli-colorize.js';
import { BOLD, DIM, NC, statusSymbol } from '../colors.js';
import { getTreeContext } from '../tree-context.js';
import { renderWaves } from './waves.js';

/**
 * Render the task dependency tree or wave plan.
 *
 * @param data  - Normalised response payload.
 * @param quiet - When true, emit only IDs with no decoration.
 */
export function renderTree(data: Record<string, unknown>, quiet: boolean): string {
  const waves = data['waves'] as Array<Record<string, unknown>> | undefined;
  const tree = data['tree'] as FlatTreeNode[] | undefined;
  const tasks = data['tasks'] as Task[] | undefined;
  const rendered = data['rendered'];
  const nodes = data['nodes'] as Array<Record<string, unknown>> | undefined;

  if (waves) {
    const epicId = data['epicId'] as string | undefined;
    const totalWaves = data['totalWaves'] as number | undefined;
    const totalTasks = data['totalTasks'] as number | undefined;

    if (quiet) {
      return renderWaves(data, { mode: 'quiet' });
    }

    const header = epicId
      ? `${BOLD}Waves for ${epicId}${NC}  ${DIM}(${totalWaves ?? waves.length} waves, ${totalTasks ?? '?'} tasks)${NC}`
      : `${BOLD}Execution Waves${NC}`;
    const body = renderWaves(data, { mode: 'rich', epicId, totalWaves, totalTasks });
    return `${header}\n\n${body}`;
  }

  if (tree) {
    // Delegate to core formatTree, injecting the CLI ANSI colorize adapter.
    // withDeps and withBlockers are read from the tree context set by treeCommand
    // (T1205 / T1206).
    const { withDeps, withBlockers } = getTreeContext();
    return formatTree(tree, {
      mode: quiet ? 'quiet' : 'rich',
      colorize: cliColorize,
      withDeps,
      withBlockers,
    });
  }

  // tasks.deps.tree shape: { epicId, format, rendered, nodes, edges, criticalPath }
  // Core has already produced the formatted text or mermaid string — emit it directly.
  if (typeof rendered === 'string' && rendered.length > 0) {
    if (quiet) {
      return nodes ? nodes.map((n) => String(n['id'])).join('\n') : '';
    }
    return rendered;
  }

  // Fallback: flat task list rendered as indented tree
  if (tasks) {
    if (quiet) return tasks.map((t) => t.id).join('\n');
    return tasks
      .map((t) => {
        const sSym = statusSymbol(t.status);
        return `  ${sSym} ${BOLD}${t.id}${NC} ${t.title}`;
      })
      .join('\n');
  }

  return quiet ? '' : 'No tree data.';
}
