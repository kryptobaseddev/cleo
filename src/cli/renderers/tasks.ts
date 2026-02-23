/**
 * Human-readable renderers for task-related CLI commands.
 *
 * Each renderer takes the same data shape that would be passed to formatSuccess()
 * and returns a string suitable for terminal display.
 *
 * @task T4666
 * @epic T4663
 */

import type { Task } from '../../types/task.js';
import {
  BOLD, DIM, NC, RED, GREEN, YELLOW,
  BOX, hRule,
  statusSymbol, statusColor, prioritySymbol, priorityColor, shortDate,
} from './colors.js';

// ---------------------------------------------------------------------------
// show: single task detail
// ---------------------------------------------------------------------------

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
  if (task.type) lines.push(`${BOX.v}  ${DIM}Type:${NC}        ${task.type}`);
  if (task.phase) lines.push(`${BOX.v}  ${DIM}Phase:${NC}       ${task.phase}`);
  if (task.size) lines.push(`${BOX.v}  ${DIM}Size:${NC}        ${task.size}`);
  if (task.labels?.length) lines.push(`${BOX.v}  ${DIM}Labels:${NC}      ${task.labels.join(', ')}`);
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
      lines.push(`${BOX.v}    \u2022 ${short}`);
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
      lines.push(`${BOX.v}    \u2610 ${criterion}`);
    }
  }

  // Footer
  lines.push(`${BOX.bl}${hr}${BOX.br}`);
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// list: task list
// ---------------------------------------------------------------------------

/** Render a list of tasks (mirrors bash list.sh text output). */
export function renderList(data: Record<string, unknown>, quiet: boolean): string {
  const tasks = (data['tasks'] as Task[] | undefined) ?? [];
  const total = (data['total'] as number | undefined) ?? tasks.length;

  if (tasks.length === 0) {
    return quiet ? '' : 'No tasks found.';
  }

  if (quiet) {
    return tasks.map(t => `${t.id} ${statusSymbol(t.status)} ${t.title}`).join('\n');
  }

  const lines: string[] = [];

  // Group by priority
  const groups: Record<string, Task[]> = { critical: [], high: [], medium: [], low: [] };
  for (const t of tasks) {
    const key = t.priority ?? 'medium';
    if (!groups[key]) groups[key] = [];
    groups[key]!.push(t);
  }

  for (const prio of ['critical', 'high', 'medium', 'low'] as const) {
    const group = groups[prio];
    if (!group || group.length === 0) continue;

    const pSym = prioritySymbol(prio);
    const pCol = priorityColor(prio);
    lines.push('');
    lines.push(`${pCol}${pSym} ${prio.toUpperCase()} (${group.length})${NC}`);

    for (const t of group) {
      const sCol = statusColor(t.status);
      const sSym = statusSymbol(t.status);
      lines.push(`  ${BOLD}${t.id}${NC} ${sCol}${sSym} ${t.status}${NC}`);
      lines.push(`      ${BOLD}${t.title}${NC}`);
      if (t.labels?.length) {
        lines.push(`      ${DIM}# ${t.labels.join(', ')}${NC}`);
      }
    }
  }

  lines.push('');
  lines.push(`${DIM}${hRule(40)}${NC}`);
  lines.push(`Total: ${total} tasks`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// find: search results
// ---------------------------------------------------------------------------

/** Render search results. */
export function renderFind(data: Record<string, unknown>, quiet: boolean): string {
  const results = (data['results'] as Array<Record<string, unknown>> | undefined) ?? [];
  const total = (data['total'] as number | undefined) ?? results.length;

  if (results.length === 0) {
    return quiet ? '' : 'No matching tasks found.';
  }

  if (quiet) {
    return results.map(r => {
      const t = r as unknown as Task;
      return `${t.id} ${t.title}`;
    }).join('\n');
  }

  const lines: string[] = [];
  lines.push(`${BOLD}Found ${total} result${total !== 1 ? 's' : ''}${NC}`);
  lines.push('');

  for (const r of results) {
    const t = r as unknown as Task;
    const sCol = statusColor(t.status);
    const sSym = statusSymbol(t.status);
    const pCol = priorityColor(t.priority);
    lines.push(`  ${BOLD}${t.id}${NC} ${sCol}${sSym}${NC} ${pCol}[${t.priority}]${NC} ${t.title}`);
    if (t.description) {
      const short = t.description.length > 60 ? t.description.slice(0, 57) + '...' : t.description;
      lines.push(`       ${DIM}${short}${NC}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// add: task created
// ---------------------------------------------------------------------------

/** Render add result. */
export function renderAdd(data: Record<string, unknown>, quiet: boolean): string {
  const task = data['task'] as Task | undefined;
  const duplicate = data['duplicate'] as boolean | undefined;
  const dryRun = data['dryRun'] as boolean | undefined;

  if (!task) return 'No task created.';

  if (quiet) return task.id;

  const prefix = dryRun
    ? `${YELLOW}[DRY RUN]${NC} Would create:`
    : duplicate
      ? `${YELLOW}[DUPLICATE]${NC} Created:`
      : `${GREEN}Created:${NC}`;

  return `${prefix} ${BOLD}${task.id}${NC} ${task.title} [${task.priority}]`;
}

// ---------------------------------------------------------------------------
// update: task updated
// ---------------------------------------------------------------------------

/** Render update result. */
export function renderUpdate(data: Record<string, unknown>, quiet: boolean): string {
  const task = data['task'] as Task | undefined;
  const changes = data['changes'] as string[] | Record<string, unknown> | undefined;

  if (!task) return 'No task updated.';
  if (quiet) return task.id;

  const lines: string[] = [];
  lines.push(`${GREEN}Updated:${NC} ${BOLD}${task.id}${NC} ${task.title}`);

  if (Array.isArray(changes) && changes.length > 0) {
    lines.push(`  ${DIM}Changed:${NC} ${changes.join(', ')}`);
  } else if (changes && typeof changes === 'object' && Object.keys(changes).length > 0) {
    for (const [key, val] of Object.entries(changes)) {
      lines.push(`  ${DIM}${key}:${NC} ${String(val)}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// complete: task completed
// ---------------------------------------------------------------------------

/** Render complete result. */
export function renderComplete(data: Record<string, unknown>, quiet: boolean): string {
  const task = data['task'] as Task | undefined;
  const autoCompleted = data['autoCompleted'] as Task[] | undefined;

  if (!task) return 'No task completed.';
  if (quiet) return task.id;

  const lines: string[] = [];
  lines.push(`${GREEN}\u2713 Completed:${NC} ${BOLD}${task.id}${NC} ${task.title}`);

  if (autoCompleted?.length) {
    lines.push(`  ${DIM}Auto-completed ${autoCompleted.length} child task${autoCompleted.length > 1 ? 's' : ''}:${NC}`);
    for (const child of autoCompleted) {
      lines.push(`    ${child.id} ${child.title}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// delete: task deleted
// ---------------------------------------------------------------------------

/** Render delete result. */
export function renderDelete(data: Record<string, unknown>, quiet: boolean): string {
  const deletedTask = data['deletedTask'] as Task | undefined;
  const cascadeDeleted = data['cascadeDeleted'] as Task[] | undefined;

  if (!deletedTask) return 'No task deleted.';
  if (quiet) return deletedTask.id;

  const lines: string[] = [];
  lines.push(`${RED}\u2717 Deleted:${NC} ${BOLD}${deletedTask.id}${NC} ${deletedTask.title}`);

  if (cascadeDeleted?.length) {
    lines.push(`  ${DIM}Cascade-deleted ${cascadeDeleted.length} child task${cascadeDeleted.length > 1 ? 's' : ''}:${NC}`);
    for (const child of cascadeDeleted) {
      lines.push(`    ${child.id} ${child.title}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// archive: tasks archived
// ---------------------------------------------------------------------------

/** Render archive result. */
export function renderArchive(data: Record<string, unknown>, quiet: boolean): string {
  const count = data['archivedCount'] as number | undefined;
  const dryRun = data['dryRun'] as boolean | undefined;
  const tasks = data['archivedTasks'] as Task[] | undefined;

  if (quiet) return String(count ?? 0);

  if (dryRun) {
    return `${YELLOW}[DRY RUN]${NC} Would archive ${count ?? 0} task${count !== 1 ? 's' : ''}`;
  }

  const lines: string[] = [];
  lines.push(`${GREEN}Archived ${count ?? 0} task${count !== 1 ? 's' : ''}${NC}`);

  if (tasks?.length) {
    for (const t of tasks.slice(0, 10)) {
      lines.push(`  ${t.id} ${t.title}`);
    }
    if (tasks.length > 10) {
      lines.push(`  ${DIM}... and ${tasks.length - 10} more${NC}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// restore: task restored
// ---------------------------------------------------------------------------

/** Render restore result. */
export function renderRestore(data: Record<string, unknown>, quiet: boolean): string {
  const task = data['task'] as Task | undefined;
  const restoredTask = data['restoredTask'] as Task | undefined;
  const t = task ?? restoredTask;

  if (!t) return 'No task restored.';
  if (quiet) return t.id;

  return `${GREEN}Restored:${NC} ${BOLD}${t.id}${NC} ${t.title}`;
}
