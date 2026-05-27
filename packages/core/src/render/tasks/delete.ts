/**
 * Human-readable renderer for `cleo delete` / `cleo rm` — task deleted.
 *
 * Migrated verbatim from `packages/cleo/src/cli/renderers/tasks.ts` per the
 * Human Render Contract (ADR-077). Behavior unchanged.
 *
 * @task T10133
 * @epic T10114
 */

import type { Task } from '@cleocode/contracts';
import { BOLD, DIM, NC, RED } from './colors.js';

/** Render delete result. */
export function renderDelete(data: Record<string, unknown>, quiet: boolean): string {
  const deletedTask = data['deletedTask'] as Task | undefined;
  const cascadeDeleted = data['cascadeDeleted'] as Task[] | undefined;

  if (!deletedTask) return 'No task deleted.';
  if (quiet) return deletedTask.id;

  const lines: string[] = [];
  lines.push(`${RED}✗ Deleted:${NC} ${BOLD}${deletedTask.id}${NC} ${deletedTask.title}`);

  if (cascadeDeleted?.length) {
    lines.push(
      `  ${DIM}Cascade-deleted ${cascadeDeleted.length} child task${cascadeDeleted.length > 1 ? 's' : ''}:${NC}`,
    );
    for (const child of cascadeDeleted) {
      lines.push(`    ${child.id} ${child.title}`);
    }
  }

  return lines.join('\n');
}
