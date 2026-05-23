/**
 * Human renderer for `cleo start`.
 *
 * Migrated from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6).
 *
 * @task T4666
 * @task T10131
 */

import type { Task } from '@cleocode/contracts';
import { BOLD, GREEN, NC } from '../colors.js';

export function renderStart(data: Record<string, unknown>, quiet: boolean): string {
  const task = data['task'] as Task | undefined;
  const taskId = data['taskId'] as string | undefined;
  const id = task?.id ?? taskId ?? String(data['currentTask'] ?? '');
  const title = task?.title ?? String(data['title'] ?? '');

  if (quiet) return id;

  return `${GREEN}▶ Started:${NC} ${BOLD}${id}${NC} ${title}`;
}
