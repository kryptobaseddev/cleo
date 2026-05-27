/**
 * Human renderer for `cleo stop`.
 *
 * Migrated from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6).
 *
 * @task T4666
 * @task T10131
 */

import type { Task } from '@cleocode/contracts';
import { BOLD, NC, YELLOW } from '../colors.js';

export function renderStop(data: Record<string, unknown>, quiet: boolean): string {
  const task = data['task'] as Task | undefined;
  const taskId = data['taskId'] as string | undefined;
  const previousTask = data['previousTask'] as string | undefined;
  const id = task?.id ?? taskId ?? previousTask ?? '';

  if (quiet) return id;

  if (!id) return 'No task was active.';
  return `${YELLOW}■ Stopped:${NC} ${BOLD}${id}${NC}${task?.title ? ` ${task.title}` : ''}`;
}
