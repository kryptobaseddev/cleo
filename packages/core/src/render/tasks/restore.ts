/**
 * Human-readable renderer for `cleo restore` — task restored.
 *
 * Migrated verbatim from `packages/cleo/src/cli/renderers/tasks.ts` per the
 * Human Render Contract (ADR-077). Behavior unchanged.
 *
 * @task T10133
 * @epic T10114
 */

import type { Task } from '@cleocode/contracts';
import { BOLD, GREEN, NC } from './colors.js';

/** Render restore result. */
export function renderRestore(data: Record<string, unknown>, quiet: boolean): string {
  const task = data['task'] as Task | undefined;
  const restoredTask = data['restoredTask'] as Task | undefined;
  const t = task ?? restoredTask;

  if (!t) return 'No task restored.';
  if (quiet) return t.id;

  return `${GREEN}Restored:${NC} ${BOLD}${t.id}${NC} ${t.title}`;
}
