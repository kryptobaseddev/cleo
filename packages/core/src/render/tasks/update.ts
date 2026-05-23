/**
 * Human-readable renderer for `cleo update` — task updated.
 *
 * Migrated verbatim from `packages/cleo/src/cli/renderers/tasks.ts` per the
 * Human Render Contract (ADR-077). Behavior unchanged.
 *
 * @task T10133
 * @epic T10114
 */

import type { Task } from '@cleocode/contracts';
import { BOLD, DIM, GREEN, NC } from './colors.js';

/** Render update result. */
export function renderUpdate(data: Record<string, unknown>, quiet: boolean): string {
  const task = data['task'] as Task | undefined;
  const changes = data['changes'] as string[] | Record<string, unknown> | undefined;

  if (!task) return 'No task updated.';
  if (quiet) return task.id;

  const lines: string[] = [];
  lines.push(`${GREEN}Updated:${NC} ${BOLD}${task.id}${NC} ${task.title}`);

  if (Array.isArray(changes) && changes.length > 0) {
    lines.push(`  ${DIM}Changed:${NC} ${changes.join(', ')}`);
  } else if (changes && typeof changes === 'object' && Object.keys(changes).length > 0) {
    for (const [key, val] of Object.entries(changes)) {
      lines.push(`  ${DIM}${key}:${NC} ${String(val)}`);
    }
  }

  return lines.join('\n');
}
