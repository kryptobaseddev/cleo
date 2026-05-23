/**
 * Human renderer for `cleo plan`.
 *
 * Migrated from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6).
 *
 * @task T10131
 */

import { BOLD, DIM, NC, priorityColor, RED } from '../colors.js';
import { renderCompletionBar } from './completion-bar.js';

export function renderPlan(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) {
    const readyCount = (data['ready'] as Array<unknown> | undefined)?.length ?? 0;
    return String(readyCount);
  }

  const lines: string[] = [];
  lines.push(`${BOLD}Planning View${NC}`);
  lines.push('');

  // In-Progress Epics
  const inProgress = data['inProgress'] as Array<Record<string, unknown>> | undefined;
  if (inProgress && inProgress.length > 0) {
    lines.push(`${BOLD}In-Progress Epics (${inProgress.length})${NC}`);
    for (const epic of inProgress) {
      const completion = epic['completionPercent'] as number;
      const completionBar = renderCompletionBar(completion);
      lines.push(`  ${BOLD}${epic['epicId']}${NC} ${epic['epicTitle']}`);
      lines.push(`    ${completionBar} ${completion}% (${epic['activeTasks']} active)`);
    }
    lines.push('');
  }

  // Ready Tasks
  const ready = data['ready'] as Array<Record<string, unknown>> | undefined;
  if (ready && ready.length > 0) {
    lines.push(`${BOLD}Ready Tasks (${ready.length})${NC}  ${DIM}ordered by leverage score${NC}`);
    for (const task of ready.slice(0, 10)) {
      const pCol = priorityColor(String(task['priority'] ?? 'medium'));
      lines.push(`  ${BOLD}${task['id']}${NC} ${pCol}[${task['priority']}]${NC} ${task['title']}`);
      lines.push(
        `    ${DIM}leverage:${NC} ${task['leverage']}  ${DIM}score:${NC} ${task['score']}`,
      );
      const reasons = task['reasons'] as string[] | undefined;
      if (reasons && reasons.length > 0) {
        lines.push(`    ${DIM}${reasons.join(', ')}${NC}`);
      }
    }
    if (ready.length > 10) {
      lines.push(`  ${DIM}... and ${ready.length - 10} more${NC}`);
    }
    lines.push('');
  }

  // Blocked Tasks
  const blocked = data['blocked'] as Array<Record<string, unknown>> | undefined;
  if (blocked && blocked.length > 0) {
    lines.push(`${RED}${BOLD}Blocked Tasks (${blocked.length})${NC}`);
    for (const task of blocked.slice(0, 10)) {
      lines.push(`  ${RED}⊗${NC} ${BOLD}${task['id']}${NC} ${task['title']}`);
      const blockedBy = task['blockedBy'] as string[] | undefined;
      if (blockedBy && blockedBy.length > 0) {
        lines.push(`    ${DIM}Blocked by: ${blockedBy.join(', ')}${NC}`);
      }
      if ((task['blocksCount'] as number) > 0) {
        lines.push(`    ${DIM}Blocks: ${task['blocksCount']} task(s)${NC}`);
      }
    }
    if (blocked.length > 10) {
      lines.push(`  ${DIM}... and ${blocked.length - 10} more${NC}`);
    }
    lines.push('');
  }

  // Open Bugs
  const openBugs = data['openBugs'] as Array<Record<string, unknown>> | undefined;
  if (openBugs && openBugs.length > 0) {
    lines.push(`${RED}${BOLD}Open Bugs (${openBugs.length})${NC}`);
    for (const bug of openBugs.slice(0, 10)) {
      const pCol = priorityColor(String(bug['priority'] ?? 'medium'));
      lines.push(
        `  ${RED}●${NC} ${BOLD}${bug['id']}${NC} ${pCol}[${bug['priority']}]${NC} ${bug['title']}`,
      );
    }
    if (openBugs.length > 10) {
      lines.push(`  ${DIM}... and ${openBugs.length - 10} more${NC}`);
    }
    lines.push('');
  }

  // Metrics
  const metrics = data['metrics'] as Record<string, number> | undefined;
  if (metrics) {
    lines.push(`${BOLD}Metrics${NC}`);
    lines.push(
      `  ${DIM}Total Epics:${NC} ${metrics['totalEpics']} (${metrics['activeEpics']} active)`,
    );
    lines.push(`  ${DIM}Total Tasks:${NC} ${metrics['totalTasks']}`);
    lines.push(
      `  ${DIM}Actionable:${NC} ${metrics['actionable']}  ${DIM}Blocked:${NC} ${metrics['blocked']}  ${DIM}Open Bugs:${NC} ${metrics['openBugs']}`,
    );
    lines.push(`  ${DIM}Avg Leverage:${NC} ${metrics['avgLeverage']}`);
  }

  return lines.join('\n');
}
