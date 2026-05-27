/**
 * Human-readable renderer for `cleo find` / `cleo search` — search results.
 *
 * Migrated verbatim from `packages/cleo/src/cli/renderers/tasks.ts` per the
 * Human Render Contract (ADR-077). Behavior unchanged.
 *
 * @task T10133
 * @epic T10114
 */

import type { Task } from '@cleocode/contracts';
import { BOLD, DIM, NC, priorityColor, statusColor, statusSymbol } from './colors.js';

/** Render search results. */
export function renderFind(data: Record<string, unknown>, quiet: boolean): string {
  const results = (data['results'] as Task[] | undefined) ?? [];
  const total = (data['total'] as number | undefined) ?? results.length;

  if (results.length === 0) {
    return quiet ? '' : 'No matching tasks found.';
  }

  if (quiet) {
    return results.map((t) => `${t.id} ${t.title}`).join('\n');
  }

  const lines: string[] = [];
  lines.push(`${BOLD}Found ${total} result${total !== 1 ? 's' : ''}${NC}`);
  lines.push('');

  for (const t of results) {
    const sCol = statusColor(t.status);
    const sSym = statusSymbol(t.status);
    const pCol = priorityColor(t.priority);
    lines.push(`  ${BOLD}${t.id}${NC} ${sCol}${sSym}${NC} ${pCol}[${t.priority}]${NC} ${t.title}`);
    if (t.description) {
      const short = t.description.length > 60 ? t.description.slice(0, 57) + '...' : t.description;
      lines.push(`       ${DIM}${short}${NC}`);
    }
  }

  return lines.join('\n');
}
