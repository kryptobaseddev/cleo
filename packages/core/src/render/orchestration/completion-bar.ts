/**
 * Render a simple ASCII progress bar for completion percentage.
 *
 * Migrated from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6).
 *
 * @task T10131
 */

import { GREEN, NC, YELLOW } from '../colors.js';

/** Render a simple ASCII progress bar for completion percentage. */
export function renderCompletionBar(percent: number): string {
  const width = 20;
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const color = percent >= 75 ? GREEN : percent >= 50 ? YELLOW : '';
  return `${color}[${bar}]${NC}`;
}
