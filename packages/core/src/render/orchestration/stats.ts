/**
 * Human renderer for `cleo stats`.
 *
 * Migrated from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6).
 *
 * @task T4666
 * @task T10131
 */

import { BOLD, DIM, NC } from '../colors.js';
import { formatLabel } from '../format-label.js';

export function renderStats(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) {
    const total = data['totalTasks'] as number | undefined;
    return String(total ?? 0);
  }

  const lines: string[] = [];
  lines.push(`${BOLD}Project Statistics${NC}`);
  lines.push('');

  for (const [key, val] of Object.entries(data)) {
    if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      lines.push(`  ${BOLD}${formatLabel(key)}:${NC}`);
      for (const [subKey, subVal] of Object.entries(val as Record<string, unknown>)) {
        lines.push(`    ${DIM}${formatLabel(subKey)}:${NC} ${String(subVal)}`);
      }
    } else {
      lines.push(`  ${DIM}${formatLabel(key)}:${NC} ${String(val)}`);
    }
  }

  return lines.join('\n');
}
