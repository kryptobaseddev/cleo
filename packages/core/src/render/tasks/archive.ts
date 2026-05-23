/**
 * Human-readable renderer for `cleo archive` — tasks archived.
 *
 * Migrated verbatim from `packages/cleo/src/cli/renderers/tasks.ts` per the
 * Human Render Contract (ADR-077). Behavior unchanged.
 *
 * @task T10133
 * @epic T10114
 */

import type { Task } from '@cleocode/contracts';
import { DIM, GREEN, NC, YELLOW } from './colors.js';

/** Render archive result. */
export function renderArchive(data: Record<string, unknown>, quiet: boolean): string {
  const count = data['archivedCount'] as number | undefined;
  const dryRun = data['dryRun'] as boolean | undefined;
  const tasks = data['archivedTasks'] as Task[] | undefined;

  if (quiet) return String(count ?? 0);

  if (dryRun) {
    return `${YELLOW}[DRY RUN]${NC} Would archive ${count ?? 0} task${count !== 1 ? 's' : ''}`;
  }

  const lines: string[] = [];
  lines.push(`${GREEN}Archived ${count ?? 0} task${count !== 1 ? 's' : ''}${NC}`);

  if (tasks?.length) {
    for (const t of tasks.slice(0, 10)) {
      lines.push(`  ${t.id} ${t.title}`);
    }
    if (tasks.length > 10) {
      lines.push(`  ${DIM}... and ${tasks.length - 10} more${NC}`);
    }
  }

  return lines.join('\n');
}
