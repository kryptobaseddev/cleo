/**
 * Human-readable renderer for `cleo list` / `cleo ls` — grouped task list.
 *
 * Migrated verbatim from `packages/cleo/src/cli/renderers/tasks.ts` per the
 * Human Render Contract (ADR-077). Behavior unchanged.
 *
 * @task T10133
 * @epic T10114
 */

import type { Task } from '@cleocode/contracts';
import {
  BOLD,
  DIM,
  hRule,
  NC,
  priorityColor,
  prioritySymbol,
  statusColor,
  statusSymbol,
} from './colors.js';

/** Render a list of tasks (mirrors bash list.sh text output). */
export function renderList(data: Record<string, unknown>, quiet: boolean): string {
  const tasks = (data['tasks'] as Task[] | undefined) ?? [];
  const total = (data['total'] as number | undefined) ?? tasks.length;

  if (tasks.length === 0) {
    return quiet ? '' : 'No tasks found.';
  }

  if (quiet) {
    return tasks.map((t) => `${t.id} ${statusSymbol(t.status)} ${t.title}`).join('\n');
  }

  const lines: string[] = [];

  // Group by priority
  const groups: Record<string, Task[]> = { critical: [], high: [], medium: [], low: [] };
  for (const t of tasks) {
    const key = t.priority ?? 'medium';
    if (!groups[key]) groups[key] = [];
    groups[key]!.push(t);
  }

  for (const prio of ['critical', 'high', 'medium', 'low'] as const) {
    const group = groups[prio];
    if (!group || group.length === 0) continue;

    const pSym = prioritySymbol(prio);
    const pCol = priorityColor(prio);
    lines.push('');
    lines.push(`${pCol}${pSym} ${prio.toUpperCase()} (${group.length})${NC}`);

    for (const t of group) {
      const sCol = statusColor(t.status);
      const sSym = statusSymbol(t.status);
      lines.push(`  ${BOLD}${t.id}${NC} ${sCol}${sSym} ${t.status}${NC}`);
      lines.push(`      ${BOLD}${t.title}${NC}`);
      if (t.labels?.length) {
        lines.push(`      ${DIM}# ${t.labels.join(', ')}${NC}`);
      }
    }
  }

  lines.push('');
  lines.push(`${DIM}${hRule(40)}${NC}`);
  lines.push(`Total: ${total} tasks`);

  return lines.join('\n');
}
