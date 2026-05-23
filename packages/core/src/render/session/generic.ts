/**
 * Generic human renderer for commands without a specific renderer.
 *
 * Migrated from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6).
 *
 * @task T4666
 * @task T10131
 */

import { BOLD, DIM, NC } from '../colors.js';
import { formatLabel } from '../format-label.js';

/**
 * Generic human renderer for commands that don't have a specific renderer.
 * Renders data as indented key-value pairs.
 */
export function renderGeneric(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';

  const lines: string[] = [];
  for (const [key, val] of Object.entries(data)) {
    if (val === null || val === undefined) continue;

    if (Array.isArray(val)) {
      lines.push(`${BOLD}${formatLabel(key)}:${NC} (${val.length})`);
      for (const item of val.slice(0, 20)) {
        if (typeof item === 'object' && item !== null) {
          const obj = item as Record<string, unknown>;
          const id = obj['id'] ?? '';
          const title = obj['title'] ?? obj['name'] ?? '';
          lines.push(`  ${id}${title ? ` ${title}` : ''}`);
        } else {
          lines.push(`  ${String(item)}`);
        }
      }
      if (val.length > 20) {
        lines.push(`  ${DIM}... and ${val.length - 20} more${NC}`);
      }
    } else if (typeof val === 'object') {
      lines.push(`${BOLD}${formatLabel(key)}:${NC}`);
      for (const [subKey, subVal] of Object.entries(val as Record<string, unknown>)) {
        lines.push(`  ${DIM}${formatLabel(subKey)}:${NC} ${String(subVal)}`);
      }
    } else {
      lines.push(`${DIM}${formatLabel(key)}:${NC} ${String(val)}`);
    }
  }

  return lines.join('\n') || 'OK';
}
