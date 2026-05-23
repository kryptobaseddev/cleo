/**
 * Human renderer for `cleo brain purge`.
 *
 * Migrated from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6).
 *
 * @task T1722
 * @task T10131
 */

import { BOLD, DIM, GREEN, NC } from '../colors.js';

export function renderBrainPurge(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) {
    const total =
      ((data['patternsDeleted'] as number) ?? 0) +
      ((data['learningsDeleted'] as number) ?? 0) +
      ((data['decisionsDeleted'] as number) ?? 0) +
      ((data['observationsDeleted'] as number) ?? 0);
    return String(total);
  }

  const lines: string[] = [];
  const after = data['after'] as Record<string, unknown> | undefined;

  lines.push(`${GREEN}${BOLD}Purge complete.${NC}`);
  lines.push(`  ${DIM}Patterns deleted:${NC}     ${data['patternsDeleted']}`);
  lines.push(`  ${DIM}Learnings deleted:${NC}    ${data['learningsDeleted']}`);
  lines.push(`  ${DIM}Decisions deleted:${NC}    ${data['decisionsDeleted']}`);
  lines.push(`  ${DIM}Observations deleted:${NC} ${data['observationsDeleted']}`);

  if (after) {
    lines.push('');
    lines.push(`${BOLD}Post-purge counts:${NC}`);
    lines.push(`  ${DIM}Patterns:${NC}     ${after['patterns']}`);
    lines.push(`  ${DIM}Learnings:${NC}    ${after['learnings']}`);
    lines.push(`  ${DIM}Decisions:${NC}    ${after['decisions']}`);
    lines.push(`  ${DIM}Observations:${NC} ${after['observations']}`);
  }
  lines.push(`  ${DIM}FTS5 rebuilt:${NC} ${data['fts5Rebuilt']}`);

  return lines.join('\n');
}
