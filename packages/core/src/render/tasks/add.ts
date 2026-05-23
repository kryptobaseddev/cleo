/**
 * Human-readable renderer for `cleo add` — task created.
 *
 * Migrated verbatim from `packages/cleo/src/cli/renderers/tasks.ts` per the
 * Human Render Contract (ADR-077). Behavior unchanged.
 *
 * @task T10133
 * @epic T10114
 */

import type { Task } from '@cleocode/contracts';
import { BOLD, GREEN, NC, YELLOW } from './colors.js';

/** Render add result. */
export function renderAdd(data: Record<string, unknown>, quiet: boolean): string {
  const task = data['task'] as Task | undefined;
  const duplicate = data['duplicate'] as boolean | undefined;
  const dryRun = data['dryRun'] as boolean | undefined;

  if (!task) return 'No task created.';

  if (quiet) return task.id;

  const prefix = dryRun
    ? `${YELLOW}[DRY RUN]${NC} Would create:`
    : duplicate
      ? `${YELLOW}[DUPLICATE]${NC} Created:`
      : `${GREEN}Created:${NC}`;

  return `${prefix} ${BOLD}${task.id}${NC} ${task.title} [${task.priority}]`;
}
