/**
 * Human-readable renderer for `cleo complete` / `cleo done` — task completed.
 *
 * Migrated verbatim from `packages/cleo/src/cli/renderers/tasks.ts` per the
 * Human Render Contract (ADR-077). Behavior unchanged.
 *
 * @task T10133
 * @epic T10114
 */

import type { Task } from '@cleocode/contracts';
import { BOLD, DIM, GREEN, NC } from './colors.js';

/** Render complete result. */
export function renderComplete(data: Record<string, unknown>, quiet: boolean): string {
  const task = data['task'] as Task | undefined;
  const autoCompleted = data['autoCompleted'] as Task[] | undefined;

  if (!task) return 'No task completed.';
  if (quiet) return task.id;

  const lines: string[] = [];
  lines.push(`${GREEN}✓ Completed:${NC} ${BOLD}${task.id}${NC} ${task.title}`);

  if (autoCompleted?.length) {
    lines.push(
      `  ${DIM}Auto-completed ${autoCompleted.length} child task${autoCompleted.length > 1 ? 's' : ''}:${NC}`,
    );
    for (const child of autoCompleted) {
      lines.push(`    ${child.id} ${child.title}`);
    }
  }

  return lines.join('\n');
}
