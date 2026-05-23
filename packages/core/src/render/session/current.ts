/**
 * Human renderer for `cleo current`.
 *
 * Migrated from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6).
 *
 * @task T4666
 * @task T10131
 */

import type { Task } from '@cleocode/contracts';
import { BOLD, NC, statusColor, statusSymbol } from '../colors.js';

export function renderCurrent(data: Record<string, unknown>, quiet: boolean): string {
  const task = data['task'] as Task | undefined;
  const currentTask = data['currentTask'] as string | undefined;
  const id = task?.id ?? currentTask ?? '';

  if (!id) {
    return quiet ? '' : 'No task currently active.';
  }

  if (quiet) return id;

  const sCol = statusColor(task?.status ?? 'active');
  const sSym = statusSymbol(task?.status ?? 'active');
  return `${BOLD}Current:${NC} ${sCol}${sSym}${NC} ${BOLD}${id}${NC}${task?.title ? ` ${task.title}` : ''}`;
}
