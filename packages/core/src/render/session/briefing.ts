/**
 * Human renderer for `cleo briefing`.
 *
 * Renders a {@link SessionBriefing} payload as readable text.
 *
 * Source of truth is TASKS + BRAIN (`tasks.db` + `brain.db`); this renderer
 * is a pure formatter that NEVER touches the filesystem. Sections render
 * only when their backing data is non-empty so a quiet briefing stays quiet.
 *
 * Sections (in order):
 * 1. Last session — handoff note, completed/created tasks, decisions
 * 2. Current task
 * 3. Active blockers
 * 4. Next suggested
 * 5. Open epics
 * 6. Recent decisions / observations from BRAIN
 *
 * Migrated from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6).
 *
 * @task T1593
 * @task T10131
 */

import { BOLD, DIM, NC, priorityColor, RED, statusColor, statusSymbol, YELLOW } from '../colors.js';

export function renderBriefing(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) {
    // Quiet mode: emit only IDs of next-suggested tasks (one per line).
    const next = (data['nextTasks'] as Array<Record<string, unknown>> | undefined) ?? [];
    return next.map((t) => String(t['id'] ?? '')).join('\n');
  }

  const lines: string[] = [];
  lines.push(`${BOLD}CLEO Session Briefing${NC}  ${DIM}(source: tasks.db + brain.db)${NC}`);
  lines.push('');

  // 1. Last session
  const lastSession = data['lastSession'] as Record<string, unknown> | null | undefined;
  if (lastSession) {
    const handoff = (lastSession['handoff'] as Record<string, unknown>) ?? {};
    const endedAt = String(lastSession['endedAt'] ?? '');
    const duration = lastSession['duration'] as number | undefined;
    lines.push(`${BOLD}Last Session${NC}`);
    if (endedAt) lines.push(`  ${DIM}Ended:${NC} ${endedAt}`);
    if (typeof duration === 'number') lines.push(`  ${DIM}Duration:${NC} ${duration} min`);
    const completed = (handoff['tasksCompleted'] as string[] | undefined) ?? [];
    const created = (handoff['tasksCreated'] as string[] | undefined) ?? [];
    if (completed.length > 0) {
      lines.push(`  ${DIM}Completed:${NC} ${completed.length} task(s) — ${completed.join(', ')}`);
    }
    if (created.length > 0) {
      lines.push(`  ${DIM}Created:${NC} ${created.length} task(s) — ${created.join(', ')}`);
    }
    const decisions = handoff['decisionsRecorded'] as number | undefined;
    if (typeof decisions === 'number' && decisions > 0) {
      lines.push(`  ${DIM}Decisions recorded:${NC} ${decisions}`);
    }
    if (handoff['note']) {
      lines.push(`  ${DIM}Note:${NC} ${String(handoff['note'])}`);
    }
    if (handoff['nextAction']) {
      lines.push(`  ${DIM}Next action:${NC} ${String(handoff['nextAction'])}`);
    }
    lines.push('');
  } else {
    lines.push(`${BOLD}Last Session${NC}  ${DIM}(none — fresh session)${NC}`);
    lines.push('');
  }

  // 2. Current task
  const currentTask = data['currentTask'] as Record<string, unknown> | null | undefined;
  if (currentTask) {
    const sCol = statusColor(String(currentTask['status'] ?? ''));
    const sSym = statusSymbol(String(currentTask['status'] ?? ''));
    lines.push(
      `${BOLD}Current Task:${NC} ${sCol}${sSym}${NC} ${BOLD}${currentTask['id']}${NC} ${currentTask['title'] ?? ''}`,
    );
    const blockedBy = currentTask['blockedBy'] as string[] | undefined;
    if (blockedBy && blockedBy.length > 0) {
      lines.push(`  ${RED}Blocked by:${NC} ${blockedBy.join(', ')}`);
    }
    lines.push('');
  }

  // 3. Active blockers
  const blockedTasks = (data['blockedTasks'] as Array<Record<string, unknown>> | undefined) ?? [];
  if (blockedTasks.length > 0) {
    lines.push(`${RED}${BOLD}Active Blockers (${blockedTasks.length})${NC}`);
    for (const t of blockedTasks.slice(0, 10)) {
      const bb = ((t['blockedBy'] as string[] | undefined) ?? []).join(', ');
      lines.push(`  ${RED}⊗${NC} ${BOLD}${t['id']}${NC} ${t['title'] ?? ''}`);
      if (bb) lines.push(`    ${DIM}Blocked by: ${bb}${NC}`);
    }
    if (blockedTasks.length > 10) {
      lines.push(`  ${DIM}... and ${blockedTasks.length - 10} more${NC}`);
    }
    lines.push('');
  }

  // 4. Next suggested
  const nextTasks = (data['nextTasks'] as Array<Record<string, unknown>> | undefined) ?? [];
  if (nextTasks.length > 0) {
    lines.push(`${BOLD}Next Suggested (${nextTasks.length})${NC}  ${DIM}leverage-scored${NC}`);
    for (const t of nextTasks) {
      lines.push(
        `  ${BOLD}${t['id']}${NC} ${t['title'] ?? ''}  ${DIM}leverage: ${t['leverage'] ?? 0}, score: ${t['score'] ?? 0}${NC}`,
      );
    }
    lines.push('');
  }

  // 5. Open epics
  const activeEpics = (data['activeEpics'] as Array<Record<string, unknown>> | undefined) ?? [];
  if (activeEpics.length > 0) {
    lines.push(`${BOLD}Open Epics (${activeEpics.length})${NC}`);
    for (const e of activeEpics) {
      const pct = (e['completionPercent'] as number) ?? 0;
      lines.push(`  ${BOLD}${e['id']}${NC} ${e['title'] ?? ''}  ${DIM}(${pct}% complete)${NC}`);
    }
    lines.push('');
  }

  // 6. Open bugs
  const openBugs = (data['openBugs'] as Array<Record<string, unknown>> | undefined) ?? [];
  if (openBugs.length > 0) {
    lines.push(`${RED}${BOLD}Open Bugs (${openBugs.length})${NC}`);
    for (const b of openBugs.slice(0, 10)) {
      const pCol = priorityColor(String(b['priority'] ?? 'medium'));
      lines.push(
        `  ${RED}●${NC} ${BOLD}${b['id']}${NC} ${pCol}[${b['priority']}]${NC} ${b['title'] ?? ''}`,
      );
    }
    lines.push('');
  }

  // 7. Memory context (recent decisions + observations from BRAIN)
  const memoryContext = data['memoryContext'] as Record<string, unknown> | undefined;
  if (memoryContext) {
    const recentDecisions =
      (memoryContext['recentDecisions'] as Array<Record<string, unknown>> | undefined) ?? [];
    const recentObservations =
      (memoryContext['recentObservations'] as Array<Record<string, unknown>> | undefined) ?? [];
    if (recentDecisions.length > 0) {
      lines.push(`${BOLD}Recent Decisions (${recentDecisions.length})${NC}  ${DIM}from BRAIN${NC}`);
      for (const d of recentDecisions.slice(0, 5)) {
        lines.push(`  ${BOLD}${d['id']}${NC} ${d['title'] ?? ''}  ${DIM}(${d['date'] ?? ''})${NC}`);
      }
      lines.push('');
    }
    if (recentObservations.length > 0) {
      lines.push(
        `${BOLD}Recent Observations (${recentObservations.length})${NC}  ${DIM}from BRAIN${NC}`,
      );
      for (const o of recentObservations.slice(0, 5)) {
        lines.push(`  ${BOLD}${o['id']}${NC} ${o['title'] ?? ''}  ${DIM}(${o['date'] ?? ''})${NC}`);
      }
      lines.push('');
    }
  }

  // 8. Warnings
  const warnings = data['warnings'] as string[] | undefined;
  if (warnings && warnings.length > 0) {
    lines.push(`${YELLOW}${BOLD}Warnings${NC}`);
    for (const w of warnings) lines.push(`  ${YELLOW}!${NC} ${w}`);
    lines.push('');
  }

  lines.push(
    `${DIM}Tip: pass --json for the full structured payload. All fields read from tasks.db + brain.db.${NC}`,
  );

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}
