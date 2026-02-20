/**
 * Human-readable renderers for system/utility CLI commands.
 *
 * Covers: doctor, stats, next, blockers, tree, start, stop, current, session, version.
 *
 * @task T4666
 * @epic T4663
 */

import type { Task } from '../../types/task.js';
import {
  BOLD, DIM, NC, RED, GREEN, YELLOW,
  statusSymbol, statusColor, priorityColor,
} from './colors.js';

// ---------------------------------------------------------------------------
// doctor: diagnostic checks
// ---------------------------------------------------------------------------

export function renderDoctor(data: Record<string, unknown>, quiet: boolean): string {
  const healthy = data['healthy'] as boolean | undefined;
  const errors = data['errors'] as number | undefined;
  const warnings = data['warnings'] as number | undefined;
  const checks = data['checks'] as Array<Record<string, unknown>> | undefined;

  if (quiet) {
    return healthy ? 'healthy' : 'unhealthy';
  }

  const lines: string[] = [];
  const statusText = healthy
    ? `${GREEN}${BOLD}HEALTHY${NC}`
    : `${RED}${BOLD}UNHEALTHY${NC}`;

  lines.push(`System Status: ${statusText}`);
  if ((errors ?? 0) > 0) lines.push(`  ${RED}Errors: ${errors}${NC}`);
  if ((warnings ?? 0) > 0) lines.push(`  ${YELLOW}Warnings: ${warnings}${NC}`);
  lines.push('');

  if (checks) {
    for (const check of checks) {
      const status = check['status'] as string;
      const message = check['message'] as string;
      const icon = status === 'ok' ? `${GREEN}\u2713${NC}` : status === 'warning' ? `${YELLOW}\u26A0${NC}` : `${RED}\u2717${NC}`;
      lines.push(`  ${icon} ${message}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// stats: project statistics
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// next: task suggestion
// ---------------------------------------------------------------------------

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
    if (quiet) return suggestions.map(s => String(s['id'])).join('\n');
    const lines: string[] = [];
    lines.push(`${BOLD}Top suggestions:${NC}  ${DIM}(${totalCandidates} candidates)${NC}`);
    for (const s of suggestions) {
      const pCol = priorityColor(String(s['priority'] ?? ''));
      lines.push(`  ${BOLD}${s['id']}${NC} ${pCol}[${s['priority']}]${NC} ${s['title']}  ${DIM}score: ${s['score']}${NC}`);
    }
    return lines.join('\n');
  }

  return 'No suggestions available.';
}

// ---------------------------------------------------------------------------
// blockers: blocked tasks
// ---------------------------------------------------------------------------

export function renderBlockers(data: Record<string, unknown>, quiet: boolean): string {
  const blockers = data['blockers'] as Array<Record<string, unknown>> | undefined;
  const tasks = data['tasks'] as Task[] | undefined;
  const items = blockers ?? tasks;

  if (!items || items.length === 0) {
    return quiet ? '' : 'No blocked tasks.';
  }

  if (quiet) {
    return items.map(b => String((b as Record<string, unknown>)['id'] ?? (b as Task).id)).join('\n');
  }

  const lines: string[] = [];
  lines.push(`${RED}${BOLD}Blocked Tasks (${items.length})${NC}`);
  lines.push('');

  for (const item of items) {
    const t = item as Task & Record<string, unknown>;
    const id = t.id ?? String(t['id']);
    const title = t.title ?? String(t['title']);
    const blockedBy = t.blockedBy ?? String(t['blockedBy'] ?? '');
    lines.push(`  ${RED}\u2297${NC} ${BOLD}${id}${NC} ${title}`);
    if (blockedBy) lines.push(`    ${DIM}Blocked by: ${blockedBy}${NC}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// tree: dependency tree
// ---------------------------------------------------------------------------

export function renderTree(data: Record<string, unknown>, quiet: boolean): string {
  const tree = data['tree'] as Array<Record<string, unknown>> | undefined;
  const tasks = data['tasks'] as Task[] | undefined;

  if (tree) {
    return renderTreeNodes(tree, '', quiet);
  }

  // Fallback: flat task list rendered as indented tree
  if (tasks) {
    if (quiet) return tasks.map(t => t.id).join('\n');
    return tasks.map(t => {
      const sSym = statusSymbol(t.status);
      return `  ${sSym} ${BOLD}${t.id}${NC} ${t.title}`;
    }).join('\n');
  }

  return quiet ? '' : 'No tree data.';
}

function renderTreeNodes(nodes: Array<Record<string, unknown>>, prefix: string, quiet: boolean): string {
  const lines: string[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const isLast = i === nodes.length - 1;
    const connector = isLast ? '\u2514\u2500\u2500 ' : '\u251C\u2500\u2500 ';
    const childPrefix = isLast ? '    ' : '\u2502   ';

    const id = String(node['id'] ?? '');
    const title = String(node['title'] ?? '');
    const status = String(node['status'] ?? '');
    const sSym = statusSymbol(status);

    if (quiet) {
      lines.push(`${prefix}${id}`);
    } else {
      lines.push(`${prefix}${connector}${sSym} ${BOLD}${id}${NC} ${title}`);
    }

    const children = node['children'] as Array<Record<string, unknown>> | undefined;
    if (children?.length) {
      lines.push(renderTreeNodes(children, prefix + childPrefix, quiet));
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// start / stop / current: task work commands
// ---------------------------------------------------------------------------

export function renderStart(data: Record<string, unknown>, quiet: boolean): string {
  const task = data['task'] as Task | undefined;
  const taskId = data['taskId'] as string | undefined;
  const id = task?.id ?? taskId ?? String(data['currentTask'] ?? '');
  const title = task?.title ?? String(data['title'] ?? '');

  if (quiet) return id;

  return `${GREEN}\u25B6 Started:${NC} ${BOLD}${id}${NC} ${title}`;
}

export function renderStop(data: Record<string, unknown>, quiet: boolean): string {
  const task = data['task'] as Task | undefined;
  const taskId = data['taskId'] as string | undefined;
  const previousTask = data['previousTask'] as string | undefined;
  const id = task?.id ?? taskId ?? previousTask ?? '';

  if (quiet) return id;

  if (!id) return 'No task was active.';
  return `${YELLOW}\u25A0 Stopped:${NC} ${BOLD}${id}${NC}${task?.title ? ` ${task.title}` : ''}`;
}

export function renderCurrent(data: Record<string, unknown>, quiet: boolean): string {
  const task = data['task'] as Task | undefined;
  const currentTask = data['currentTask'] as string | undefined;
  const id = task?.id ?? currentTask ?? '';

  if (!id) {
    return quiet ? '' : 'No task currently active.';
  }

  if (quiet) return id;

  const sCol = statusColor(task?.status ?? 'active');
  const sSym = statusSymbol(task?.status ?? 'active');
  return `${BOLD}Current:${NC} ${sCol}${sSym}${NC} ${BOLD}${id}${NC}${task?.title ? ` ${task.title}` : ''}`;
}

// ---------------------------------------------------------------------------
// session: session info
// ---------------------------------------------------------------------------

export function renderSession(data: Record<string, unknown>, quiet: boolean): string {
  const sessionId = data['sessionId'] as string | undefined;
  const status = data['status'] as string | undefined;
  const sessions = data['sessions'] as Array<Record<string, unknown>> | undefined;

  // Session list
  if (sessions) {
    if (quiet) return sessions.map(s => String(s['id'])).join('\n');
    const lines: string[] = [];
    lines.push(`${BOLD}Sessions (${sessions.length})${NC}`);
    for (const s of sessions) {
      const active = s['active'] as boolean | undefined;
      const icon = active ? `${GREEN}\u25CF${NC}` : `${DIM}\u25CB${NC}`;
      lines.push(`  ${icon} ${BOLD}${s['id']}${NC}${active ? ' (active)' : ''}`);
    }
    return lines.join('\n');
  }

  // Single session
  if (!sessionId) {
    return quiet ? '' : 'No active session.';
  }

  if (quiet) return sessionId;

  const lines: string[] = [];
  lines.push(`${BOLD}Session:${NC} ${sessionId}`);
  if (status) lines.push(`  ${DIM}Status:${NC} ${status}`);

  // Render any other fields
  for (const [key, val] of Object.entries(data)) {
    if (key === 'sessionId' || key === 'status') continue;
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      lines.push(`  ${DIM}${formatLabel(key)}:${NC} ${String(val)}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------

export function renderVersion(data: Record<string, unknown>, quiet: boolean): string {
  const version = data['version'] as string | undefined;
  if (quiet) return version ?? '';
  return `Cleo v${version}`;
}

// ---------------------------------------------------------------------------
// Generic fallback renderer
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert camelCase to Title Case for display. */
function formatLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, s => s.toUpperCase())
    .trim();
}
