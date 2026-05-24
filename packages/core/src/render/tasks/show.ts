/**
 * Human-readable renderer for `cleo show` — single task detail.
 *
 * Migrated verbatim from `packages/cleo/src/cli/renderers/tasks.ts` per the
 * Human Render Contract (ADR-077). Behavior unchanged.
 *
 * @task T10133
 * @epic T10114
 */

import type { Task } from '@cleocode/contracts';
import {
  BOLD,
  BOX,
  DIM,
  hRule,
  NC,
  priorityColor,
  RED,
  shortDate,
  statusSymbol,
} from './colors.js';

/** Render a single task in a box format (mirrors bash display_text). */
export function renderShow(data: Record<string, unknown>, quiet: boolean): string {
  const task = data['task'] as Task | undefined;
  if (!task) return 'No task found.';
  if (quiet) return renderShowQuiet(task);
  return renderShowFull(task);
}

function renderShowQuiet(task: Task): string {
  const sym = statusSymbol(task.status);
  const pLabel = `[${task.priority}]`;
  return `${task.id} ${sym} ${task.title} ${pLabel}\nStatus: ${task.status}`;
}

function renderShowFull(task: Task): string {
  const lines: string[] = [];
  const w = 65;
  const hr = hRule(w);
  const pCol = priorityColor(task.priority);
  const sym = statusSymbol(task.status);

  // Header box
  lines.push('');
  lines.push(`${BOX.tl}${hr}${BOX.tr}`);
  lines.push(`${BOX.v}  ${BOLD}${task.id}${NC} ${sym} ${pCol}[${task.priority}]${NC}`);
  lines.push(`${BOX.v}  ${task.title}`);
  lines.push(`${BOX.ml}${hr}${BOX.mr}`);

  // Core fields
  lines.push(`${BOX.v}  ${DIM}Status:${NC}      ${task.status}`);
  lines.push(`${BOX.v}  ${DIM}Priority:${NC}    ${task.priority}`);
  // T9905: dual-axis urgency surface — render the orthogonal axes side-by-side.
  // `severity` is often null/undefined; emit an em-dash placeholder so the
  // relationship is visible even when only one axis carries data.
  const severityDisplay = task.severity ?? '—';
  lines.push(
    `${BOX.v}  ${DIM}Urgency:${NC}     priority=${task.priority} severity=${severityDisplay}`,
  );
  if (task.type) lines.push(`${BOX.v}  ${DIM}Type:${NC}        ${task.type}`);
  if (task.phase) lines.push(`${BOX.v}  ${DIM}Phase:${NC}       ${task.phase}`);
  if (task.size) lines.push(`${BOX.v}  ${DIM}Size:${NC}        ${task.size}`);
  if (task.labels?.length)
    lines.push(`${BOX.v}  ${DIM}Labels:${NC}      ${task.labels.join(', ')}`);
  if (task.parentId) lines.push(`${BOX.v}  ${DIM}Parent:${NC}      ${task.parentId}`);

  const created = shortDate(task.createdAt);
  if (created) lines.push(`${BOX.v}  ${DIM}Created:${NC}     ${created}`);
  const completed = shortDate(task.completedAt);
  if (completed) lines.push(`${BOX.v}  ${DIM}Completed:${NC}   ${completed}`);

  // Description
  if (task.description) {
    lines.push(`${BOX.ml}${hr}${BOX.mr}`);
    lines.push(`${BOX.v}  ${BOLD}Description${NC}`);
    for (const line of task.description.split('\n')) {
      lines.push(`${BOX.v}    ${line}`);
    }
  }

  // Dependencies
  if (task.depends?.length) {
    lines.push(`${BOX.ml}${hr}${BOX.mr}`);
    lines.push(`${BOX.v}  ${BOLD}Depends On${NC}`);
    lines.push(`${BOX.v}    ${task.depends.join(', ')}`);
  }

  // Blocked by
  if (task.blockedBy) {
    lines.push(`${BOX.v}  ${BOLD}Blocked By${NC}`);
    lines.push(`${BOX.v}    ${RED}${task.blockedBy}${NC}`);
  }

  // Notes
  if (task.notes?.length) {
    lines.push(`${BOX.ml}${hr}${BOX.mr}`);
    lines.push(`${BOX.v}  ${BOLD}Notes${NC} (${task.notes.length})`);
    const shown = task.notes.slice(-5);
    for (const note of shown) {
      const short = note.length > 58 ? note.slice(0, 55) + '...' : note;
      lines.push(`${BOX.v}    • ${short}`);
    }
    if (task.notes.length > 5) {
      lines.push(`${BOX.v}    ${DIM}... and ${task.notes.length - 5} more${NC}`);
    }
  }

  // Files
  if (task.files?.length) {
    lines.push(`${BOX.ml}${hr}${BOX.mr}`);
    lines.push(`${BOX.v}  ${BOLD}Files${NC}`);
    lines.push(`${BOX.v}    ${task.files.join(', ')}`);
  }

  // Acceptance criteria
  if (task.acceptance?.length) {
    lines.push(`${BOX.ml}${hr}${BOX.mr}`);
    lines.push(`${BOX.v}  ${BOLD}Acceptance Criteria${NC}`);
    for (const criterion of task.acceptance) {
      lines.push(`${BOX.v}    ☐ ${criterion}`);
    }
  }

  // Footer
  lines.push(`${BOX.bl}${hr}${BOX.br}`);
  lines.push('');

  return lines.join('\n');
}
