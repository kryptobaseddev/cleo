/**
 * Human-readable renderers for system/utility CLI commands.
 *
 * Covers: doctor, stats, next, blockers, tree, start, stop, current, session, version.
 *
 * Tree and wave rendering is delegated to the pure core formatters
 * (`@cleocode/core/formatters`) via a CLI-specific `colorize` adapter that
 * injects ANSI escape codes.  This keeps all presentation logic in core and
 * the CLI renderers as thin adapters.
 *
 * @task T4666
 * @epic T4663
 */

import type { Task } from '@cleocode/contracts';
import type { ColorStyle } from '@cleocode/core/formatters';
import { formatTree, formatWaves } from '@cleocode/core/formatters';
import {
  BLUE,
  BOLD,
  DIM,
  GREEN,
  NC,
  priorityColor,
  RED,
  statusColor,
  statusSymbol,
  YELLOW,
} from './colors.js';

// ---------------------------------------------------------------------------
// CLI colorize adapter — maps core ColorStyle tokens to ANSI escape codes
// ---------------------------------------------------------------------------

/**
 * Wrap `text` with the ANSI escape code for `style`, followed by a reset.
 *
 * This adapter is passed as the `colorize` option to {@link formatTree} and
 * {@link formatWaves} so that all ANSI concerns stay in the CLI package while
 * the core formatters remain presentation-agnostic.
 *
 * When ANSI is disabled (e.g. `NO_COLOR` is set, or stdout is not a TTY),
 * the ANSI constants exported by `colors.ts` are empty strings, so this
 * function effectively returns `text` unchanged — output is identical to
 * the plain-text modes used by core tests.
 *
 * @param text  - The text to colorize.
 * @param style - A {@link ColorStyle} token produced by the core formatter.
 */
function cliColorize(text: string, style: ColorStyle): string {
  switch (style) {
    case 'bold':
      return `${BOLD}${text}${NC}`;
    case 'dim':
      return `${DIM}${text}${NC}`;
    case 'red':
      return `${RED}${text}${NC}`;
    case 'green':
      return `${GREEN}${text}${NC}`;
    case 'yellow':
      return `${YELLOW}${text}${NC}`;
    case 'blue':
      return `${BLUE}${text}${NC}`;
    case 'reset':
      return `${NC}${text}`;
    // magenta and cyan are not used by tree/wave formatters but are included
    // for completeness in case future formatters add style tokens.
    default:
      return text;
  }
}

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
  const statusText = healthy ? `${GREEN}${BOLD}HEALTHY${NC}` : `${RED}${BOLD}UNHEALTHY${NC}`;

  lines.push(`System Status: ${statusText}`);
  if ((errors ?? 0) > 0) lines.push(`  ${RED}Errors: ${errors}${NC}`);
  if ((warnings ?? 0) > 0) lines.push(`  ${YELLOW}Warnings: ${warnings}${NC}`);
  lines.push('');

  if (checks) {
    for (const check of checks) {
      const status = check['status'] as string;
      const message = check['message'] as string;
      const icon =
        status === 'ok'
          ? `${GREEN}\u2713${NC}`
          : status === 'warning'
            ? `${YELLOW}\u26A0${NC}`
            : `${RED}\u2717${NC}`;
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
    return items
      .map((b) => String((b as Record<string, unknown>)['id'] ?? (b as Task).id))
      .join('\n');
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
// tree: dependency tree and wave visualization
// ---------------------------------------------------------------------------

/**
 * Output mode for {@link renderWaves}.
 *
 * - `'rich'`     — Full terminal output with ANSI colors, wave headers,
 *                  status badges, priority colors, and blocker indicators.
 * - `'json'`     — Passthrough: returns `JSON.stringify({ waves })` so the
 *                  caller receives machine-readable data.
 * - `'markdown'` — GitHub-flavored Markdown: `## Wave N — status\n- [status] ID Title`
 * - `'quiet'`    — One `<waveNumber>\t<taskId>` line per task (script-extractable).
 */
export type RenderWavesMode = 'rich' | 'json' | 'markdown' | 'quiet';

/**
 * Options for {@link renderWaves}.
 */
export interface RenderWavesOptions {
  /**
   * Output mode.
   *
   * @defaultValue `'rich'`
   */
  mode?: RenderWavesMode;
  /** Epic ID displayed in the rich-mode header (e.g. `"T100"`). */
  epicId?: string;
  /** Total number of waves, used in the rich-mode header. */
  totalWaves?: number;
  /** Total number of tasks, used in the rich-mode header. */
  totalTasks?: number;
}

/**
 * Render wave data from `orchestrate.waves` / `deps waves` output.
 *
 * Supports four output modes controlled by `opts.mode`:
 *
 * - **rich** (default): Terminal-friendly output with wave headers, ANSI
 *   status badges, priority-colored titles, and blocker indicators.
 * - **json**: Returns `JSON.stringify({ waves })` — a raw passthrough for
 *   machine-readable consumers that have already obtained the data payload.
 * - **markdown**: GitHub-flavored Markdown suitable for issue comments or
 *   documentation. Format: `## Wave N — status\n- [status] TID Title\n`.
 * - **quiet**: One `<waveNumber>\t<taskId>` line per task across all waves,
 *   with no decoration — safe for `awk` / `cut` / shell pipelines.
 *
 * The function is the canonical wave renderer. {@link renderTree} delegates
 * to it when `data.waves` is present.
 *
 * @param data - Normalized response payload containing `data.waves`.
 * @param opts - Rendering options.
 */
export function renderWaves(data: Record<string, unknown>, opts?: RenderWavesOptions): string {
  // Delegate to the core formatter, injecting the CLI ANSI colorize adapter.
  // The data shape is compatible: waves.ts accepts { waves?: EnrichedWave[] }
  // and data has the same structure (waves key).
  return formatWaves(data as Parameters<typeof formatWaves>[0], {
    mode: opts?.mode ?? 'rich',
    colorize: cliColorize,
  });
}

/**
 * Render the task dependency tree or wave plan.
 *
 * Handles three data shapes returned by the `deps`/`tree` dispatcher:
 * - `data.waves`  — enriched wave array from `orchestrate.waves`
 * - `data.tree`   — recursive `FlatTreeNode[]` from `tasks.tree`
 * - `data.tasks`  — flat `Task[]` fallback
 *
 * When `data.waves` is present, delegates to {@link renderWaves}.
 *
 * @param data  - Normalised response payload.
 * @param quiet - When true, emit only IDs with no decoration.
 */
export function renderTree(data: Record<string, unknown>, quiet: boolean): string {
  const waves = data['waves'] as Array<Record<string, unknown>> | undefined;
  const tree = data['tree'] as Array<Record<string, unknown>> | undefined;
  const tasks = data['tasks'] as Task[] | undefined;

  if (waves) {
    const epicId = data['epicId'] as string | undefined;
    const totalWaves = data['totalWaves'] as number | undefined;
    const totalTasks = data['totalTasks'] as number | undefined;

    if (quiet) {
      return renderWaves(data, { mode: 'quiet' });
    }

    const header = epicId
      ? `${BOLD}Waves for ${epicId}${NC}  ${DIM}(${totalWaves ?? waves.length} waves, ${totalTasks ?? '?'} tasks)${NC}`
      : `${BOLD}Execution Waves${NC}`;
    const body = renderWaves(data, { mode: 'rich', epicId, totalWaves, totalTasks });
    return `${header}\n\n${body}`;
  }

  if (tree) {
    // Delegate to core formatTree, injecting the CLI ANSI colorize adapter.
    return formatTree(tree as Parameters<typeof formatTree>[0], {
      mode: quiet ? 'quiet' : 'rich',
      colorize: cliColorize,
    });
  }

  // Fallback: flat task list rendered as indented tree
  if (tasks) {
    if (quiet) return tasks.map((t) => t.id).join('\n');
    return tasks
      .map((t) => {
        const sSym = statusSymbol(t.status);
        return `  ${sSym} ${BOLD}${t.id}${NC} ${t.title}`;
      })
      .join('\n');
  }

  return quiet ? '' : 'No tree data.';
}

// ---------------------------------------------------------------------------
// Note: blockerIndicator and renderTreeNodes were removed in T1204.
// This logic now lives in @cleocode/core/formatters (tree.ts) and is
// invoked via formatTree() with the cliColorize adapter above.
// ---------------------------------------------------------------------------
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
    if (quiet) return sessions.map((s) => String(s['id'])).join('\n');
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
// plan: composite planning view
// ---------------------------------------------------------------------------

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

/** Render a simple ASCII progress bar for completion percentage. */
function renderCompletionBar(percent: number): string {
  const width = 20;
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const color = percent >= 75 ? GREEN : percent >= 50 ? YELLOW : '';
  return `${color}[${bar}]${NC}`;
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
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}
