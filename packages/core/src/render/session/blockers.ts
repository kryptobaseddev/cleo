/**
 * Human renderer for `cleo blockers`.
 *
 * Migrated from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6).
 *
 * @task T9393
 * @task T10131
 */

import { BOLD, DIM, NC, priorityColor, RED } from '../colors.js';

export function renderBlockers(data: Record<string, unknown>, quiet: boolean): string {
  // T9393-followup: dispatcher returns `blockedTasks` (not `blockers`/`tasks`),
  // plus `criticalBlockers`, `summary`, `total`, `limit`. The previous keys
  // never matched so `cleo blockers --human` printed "No blocked tasks" while
  // JSON had hundreds.
  const blockedTasks =
    (data['blockedTasks'] as Array<Record<string, unknown>> | undefined) ??
    (data['blockers'] as Array<Record<string, unknown>> | undefined) ??
    (data['tasks'] as Array<Record<string, unknown>> | undefined);
  const criticalBlockers = data['criticalBlockers'] as Array<Record<string, unknown>> | undefined;
  const summary = data['summary'] as string | undefined;
  const total = data['total'] as number | undefined;
  const limit = data['limit'] as number | undefined;

  if (!blockedTasks || blockedTasks.length === 0) {
    return quiet ? '' : (summary ?? 'No blocked tasks.');
  }

  if (quiet) {
    return blockedTasks.map((b) => String(b['id'])).join('\n');
  }

  const lines: string[] = [];
  const shown = blockedTasks.length;
  const totalLabel = typeof total === 'number' && total !== shown ? ` of ${total}` : '';
  lines.push(`${RED}${BOLD}Blocked Tasks (${shown}${totalLabel})${NC}`);
  if (summary && summary !== `${shown} blocked task(s)`) {
    lines.push(`${DIM}${summary}${NC}`);
  }
  lines.push('');

  if (criticalBlockers && criticalBlockers.length > 0) {
    lines.push(`${RED}${BOLD}Critical Blockers (${criticalBlockers.length})${NC}`);
    for (const cb of criticalBlockers) {
      const id = String(cb['id'] ?? cb['taskId'] ?? '');
      const title = String(cb['title'] ?? '');
      const blocks = cb['blocks'] as string[] | undefined;
      lines.push(`  ${RED}⊗${NC} ${BOLD}${id}${NC} ${title}`);
      if (blocks && blocks.length > 0) {
        lines.push(`    ${DIM}Blocks: ${blocks.join(', ')}${NC}`);
      }
    }
    lines.push('');
  }

  for (const item of blockedTasks) {
    const id = String(item['id']);
    const title = String(item['title'] ?? '');
    const priority = item['priority'] as string | undefined;
    const blockedBy = item['blockedBy'] as string[] | string | undefined;
    const blockedByStr = Array.isArray(blockedBy) ? blockedBy.join(', ') : (blockedBy ?? '');
    const pBadge = priority ? `${priorityColor(priority)}[${priority}]${NC} ` : '';
    lines.push(`  ${RED}⊗${NC} ${BOLD}${id}${NC} ${pBadge}${title}`);
    if (blockedByStr) lines.push(`    ${DIM}Blocked by: ${blockedByStr}${NC}`);
  }

  if (typeof limit === 'number' && typeof total === 'number' && total > shown) {
    lines.push('');
    lines.push(`${DIM}─── ${shown} of ${total} (--limit ${limit}, --json for full set) ───${NC}`);
  }

  return lines.join('\n');
}
