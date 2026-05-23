/**
 * Human renderer for `cleo next`.
 *
 * Migrated from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6).
 *
 * @task T4666
 * @task T10131
 */

import { BOLD, DIM, NC, priorityColor } from '../colors.js';

export function renderNext(data: Record<string, unknown>, quiet: boolean): string {
  const suggestion = data['suggestion'] as Record<string, unknown> | null | undefined;
  const suggestions = data['suggestions'] as Array<Record<string, unknown>> | undefined;
  const totalCandidates = data['totalCandidates'] as number | undefined;

  // Single suggestion
  if (suggestion !== undefined) {
    if (suggestion === null) {
      return quiet ? '' : 'No pending tasks with satisfied dependencies.';
    }
    if (quiet) return String(suggestion['id']);
    const pCol = priorityColor(String(suggestion['priority'] ?? ''));
    const lines = [
      `${BOLD}Next:${NC} ${BOLD}${suggestion['id']}${NC} ${pCol}[${suggestion['priority']}]${NC} ${suggestion['title']}`,
    ];
    if (suggestion['phase']) lines.push(`  ${DIM}Phase:${NC} ${suggestion['phase']}`);
    if (suggestion['reasons']) {
      const reasons = suggestion['reasons'] as string[];
      for (const r of reasons) lines.push(`  ${DIM}${r}${NC}`);
    }
    if (totalCandidates) lines.push(`  ${DIM}(${totalCandidates} candidates)${NC}`);
    return lines.join('\n');
  }

  // Multiple suggestions
  if (suggestions) {
    if (quiet) return suggestions.map((s) => String(s['id'])).join('\n');
    const lines: string[] = [];
    lines.push(`${BOLD}Top suggestions:${NC}  ${DIM}(${totalCandidates} candidates)${NC}`);
    for (const s of suggestions) {
      const pCol = priorityColor(String(s['priority'] ?? ''));
      lines.push(
        `  ${BOLD}${s['id']}${NC} ${pCol}[${s['priority']}]${NC} ${s['title']}  ${DIM}score: ${s['score']}${NC}`,
      );
    }
    return lines.join('\n');
  }

  return 'No suggestions available.';
}
