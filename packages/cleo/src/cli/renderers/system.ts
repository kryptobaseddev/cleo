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
import type { ColorStyle, FlatTreeNode } from '@cleocode/core/formatters';
import { formatTree, formatWaves } from '@cleocode/core/formatters';
import { getTreeContext } from '../tree-context.js';
import {
  BLUE,
  BOLD,
  CYAN,
  DIM,
  GREEN,
  MAGENTA,
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
    case 'magenta':
      return `${MAGENTA}${text}${NC}`;
    case 'cyan':
      return `${CYAN}${text}${NC}`;
    case 'reset':
      return `${NC}${text}`;
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
  const tree = data['tree'] as FlatTreeNode[] | undefined;
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
    // withDeps and withBlockers are read from the tree context set by treeCommand
    // (T1205 / T1206).
    const { withDeps, withBlockers } = getTreeContext();
    return formatTree(tree, {
      mode: quiet ? 'quiet' : 'rich',
      colorize: cliColorize,
      withDeps,
      withBlockers,
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
// briefing: composite session-start context (T1593)
// ---------------------------------------------------------------------------

/**
 * Render a {@link SessionBriefing} payload as readable text.
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
 * @task T1593
 */
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

// ---------------------------------------------------------------------------
// brain-maintenance: brain maintenance results
// ---------------------------------------------------------------------------

/**
 * Render the result of `cleo brain maintenance`.
 *
 * @task T1722
 */
export function renderBrainMaintenance(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return String(data['duration'] ?? '');

  const lines: string[] = [];
  lines.push(`${GREEN}${BOLD}Maintenance complete.${NC}`);
  lines.push(`  ${DIM}Duration:${NC} ${data['duration']}ms`);

  const decay = data['decay'] as Record<string, unknown> | undefined;
  if (decay) {
    lines.push(`  ${DIM}Decay:${NC}         ${decay['affected']} learning(s) updated`);
  }

  const consolidation = data['consolidation'] as Record<string, unknown> | undefined;
  if (consolidation) {
    lines.push(
      `  ${DIM}Consolidation:${NC} ${consolidation['merged']} merged, ${consolidation['removed']} archived`,
    );
  }

  const tierPromotion = data['tierPromotion'] as Record<string, unknown> | undefined;
  if (tierPromotion) {
    lines.push(
      `  ${DIM}Tier promotion:${NC} ${tierPromotion['promoted']} promoted, ${tierPromotion['evicted']} evicted`,
    );
  }

  const reconciliation = data['reconciliation'] as Record<string, unknown> | undefined;
  if (reconciliation) {
    lines.push(
      `  ${DIM}Reconcile:${NC}     ${reconciliation['decisionsFixed']} decisions, ${reconciliation['observationsFixed']} observations, ${reconciliation['linksRemoved']} links`,
    );
  }

  const embeddings = data['embeddings'] as Record<string, unknown> | undefined;
  if (embeddings) {
    lines.push(
      `  ${DIM}Embeddings:${NC}    ${embeddings['processed']} processed, ${embeddings['skipped']} skipped, ${embeddings['errors']} errors`,
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// brain-backfill: brain graph backfill results
// ---------------------------------------------------------------------------

/**
 * Render the result of `cleo brain backfill`.
 *
 * @task T1722
 */
export function renderBrainBackfill(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return String(data['nodesInserted'] ?? '');

  const lines: string[] = [];
  const before = data['before'] as Record<string, unknown> | undefined;
  const after = data['after'] as Record<string, unknown> | undefined;
  const byType = data['byType'] as Record<string, unknown> | undefined;

  lines.push(`${GREEN}${BOLD}Back-fill complete.${NC}`);
  if (before) {
    lines.push(`  ${DIM}Before:${NC} ${before['nodes']} nodes, ${before['edges']} edges`);
    lines.push(
      `  ${DIM}Source:${NC} ${before['decisions']} decisions, ${before['patterns']} patterns, ${before['learnings']} learnings, ${before['observations']} observations, ${before['stickyNotes']} stickies`,
    );
  }
  lines.push(
    `  ${DIM}Nodes inserted:${NC} ${data['nodesInserted']} (including ${data['stubsCreated']} stub nodes)`,
  );
  lines.push(`  ${DIM}Edges inserted:${NC} ${data['edgesInserted']}`);
  if (after) {
    lines.push(`  ${DIM}After:${NC}  ${after['nodes']} nodes, ${after['edges']} edges`);
  }

  if (byType && Object.keys(byType).length > 0) {
    lines.push('\n  By type:');
    for (const [type, count] of Object.entries(byType)) {
      lines.push(`    ${DIM}${type}:${NC} ${count}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// brain-purge: brain purge results
// ---------------------------------------------------------------------------

/**
 * Render the result of `cleo brain purge`.
 *
 * @task T1722
 */
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

// ---------------------------------------------------------------------------
// brain-plasticity-stats: STDP plasticity stats
// ---------------------------------------------------------------------------

/**
 * Render the result of `cleo brain plasticity stats`.
 *
 * @task T1722
 */
export function renderBrainPlasticityStats(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return String(data['totalEvents'] ?? '');

  const lines: string[] = [];
  const recentEvents = data['recentEvents'] as Array<Record<string, unknown>> | undefined;
  const limit = data['limit'] as number | undefined;

  lines.push(`${BOLD}Brain Plasticity Stats (STDP)${NC}`);
  lines.push('═'.repeat(41));
  lines.push(`  ${DIM}Total events:${NC}       ${data['totalEvents']}`);
  lines.push(`  ${DIM}LTP (potentiation):${NC} ${data['ltpCount']}`);
  lines.push(`  ${DIM}LTD (depression):${NC}   ${data['ltdCount']}`);

  const netDeltaW = (data['netDeltaW'] as number) ?? 0;
  const sign = netDeltaW >= 0 ? '+' : '';
  lines.push(`  ${DIM}Net Δw:${NC}             ${sign}${netDeltaW.toFixed(4)}`);
  lines.push(`  ${DIM}Last event:${NC}         ${data['lastEventAt'] ?? '(none)'}`);

  if (recentEvents && recentEvents.length > 0) {
    lines.push(`\n${BOLD}Recent Events (newest first, limit=${limit ?? 20})${NC}`);
    for (const ev of recentEvents) {
      const evSign = (ev['deltaW'] as number) >= 0 ? '+' : '';
      const src = String(ev['sourceNode'] ?? '')
        .slice(0, 30)
        .padEnd(30);
      const tgt = String(ev['targetNode'] ?? '')
        .slice(0, 30)
        .padEnd(30);
      lines.push(
        `  ${DIM}[${String(ev['kind'] ?? '').toUpperCase()}]${NC} ${src} → ${tgt}  ${DIM}Δw=${evSign}${(ev['deltaW'] as number).toFixed(4)}${NC}  ${ev['timestamp']}`,
      );
    }
  } else {
    lines.push('');
    lines.push(`  ${DIM}No plasticity events recorded yet.${NC}`);
    lines.push(
      `  ${DIM}Run \`cleo brain maintenance\` or \`cleo session end\` to trigger STDP.${NC}`,
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// brain-quality: memory quality report
// ---------------------------------------------------------------------------

/**
 * Render the result of `cleo brain quality`.
 *
 * @task T1722
 */
export function renderBrainQuality(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) {
    const usageRate = (data['usageRate'] as number) ?? 0;
    return `${(usageRate * 100).toFixed(1)}%`;
  }

  const lines: string[] = [];
  const qualityDistribution = data['qualityDistribution'] as Record<string, unknown> | undefined;
  const tierDistribution = data['tierDistribution'] as Record<string, unknown> | undefined;
  const topRetrieved = data['topRetrieved'] as Array<Record<string, unknown>> | undefined;
  const neverRetrieved = data['neverRetrieved'] as Array<Record<string, unknown>> | undefined;

  const usageRate = (data['usageRate'] as number) ?? 0;
  const noiseRatio = (data['noiseRatio'] as number) ?? 0;

  lines.push(`${BOLD}Brain Memory Quality Report${NC}`);
  lines.push('═'.repeat(42));
  lines.push(`  ${DIM}Total retrievals:${NC}       ${data['totalRetrievals']}`);
  lines.push(`  ${DIM}Unique entries hit:${NC}     ${data['uniqueEntriesRetrieved']}`);
  lines.push(`  ${DIM}Usage rate:${NC}             ${(usageRate * 100).toFixed(1)}%`);
  lines.push(`  ${DIM}Noise ratio:${NC}            ${(noiseRatio * 100).toFixed(1)}%`);

  if (qualityDistribution) {
    lines.push('');
    lines.push(`${BOLD}Quality Distribution${NC}`);
    lines.push(`  ${DIM}Low  (<0.3):${NC}    ${qualityDistribution['low']}`);
    lines.push(`  ${DIM}Med  (0.3-0.6):${NC} ${qualityDistribution['medium']}`);
    lines.push(`  ${DIM}High (>0.6):${NC}    ${qualityDistribution['high']}`);
  }

  if (tierDistribution) {
    lines.push('');
    lines.push(`${BOLD}Tier Distribution${NC}`);
    lines.push(`  ${DIM}Short:${NC}   ${tierDistribution['short']}`);
    lines.push(`  ${DIM}Medium:${NC}  ${tierDistribution['medium']}`);
    lines.push(`  ${DIM}Long:${NC}    ${tierDistribution['long']}`);
    if ((tierDistribution['unknown'] as number) > 0) {
      lines.push(`  ${DIM}Unknown:${NC} ${tierDistribution['unknown']}`);
    }
  }

  if (topRetrieved && topRetrieved.length > 0) {
    lines.push('');
    lines.push(`${BOLD}Top 10 Most Retrieved${NC}`);
    for (const e of topRetrieved) {
      lines.push(
        `  ${CYAN}[${e['citationCount']}x]${NC} ${DIM}${e['id']}${NC}  ${String(e['title'] ?? '').slice(0, 60)}`,
      );
    }
  }

  if (neverRetrieved && neverRetrieved.length > 0) {
    lines.push('');
    lines.push(`${YELLOW}${BOLD}Never Retrieved (pruning candidates)${NC}`);
    for (const e of neverRetrieved) {
      lines.push(
        `  ${DIM}q=${(e['qualityScore'] as number).toFixed(2)}${NC}  ${DIM}${e['id']}${NC}  ${String(e['title'] ?? '').slice(0, 60)}`,
      );
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// brain-export: export result (file-write path only)
// ---------------------------------------------------------------------------

/**
 * Render the result of `cleo brain export` when writing to a file.
 *
 * @task T1722
 */
export function renderBrainExport(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return String(data['outputFile'] ?? '');

  return (
    `${GREEN}Exported to ${data['outputFile']}:${NC} ` +
    `${data['nodeCount']} nodes, ${data['edgeCount']} edges ` +
    `(${String(data['format'] ?? '').toUpperCase()})`
  );
}

// ---------------------------------------------------------------------------
// Generic fallback renderer
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// audit reconstruct: lineage summary (T1729)
// ---------------------------------------------------------------------------

/**
 * Human renderer for `cleo audit reconstruct` output.
 *
 * Renders the {@link ReconstructResult} fields as a readable lineage summary
 * including direct commits, inferred children, child commits, and release tags.
 *
 * @task T1729
 * @epic T1691
 */
export function renderAuditReconstruct(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';

  const taskId = data['taskId'] as string | undefined;
  const directCommits = (data['directCommits'] as Array<Record<string, unknown>>) ?? [];
  const childIdRange = data['childIdRange'] as { min: string; max: string } | null | undefined;
  const childCommits =
    (data['childCommits'] as Record<string, Array<Record<string, unknown>>>) ?? {};
  const releaseTags = (data['releaseTags'] as Array<Record<string, unknown>>) ?? [];
  const inferredChildren = (data['inferredChildren'] as string[]) ?? [];
  const firstSeenAt = data['firstSeenAt'] as string | null | undefined;
  const lastSeenAt = data['lastSeenAt'] as string | null | undefined;

  const lines: string[] = [
    `${BOLD}Lineage for ${taskId ?? '?'}${NC}`,
    '='.repeat(40),
    '',
    `${DIM}Direct commits:${NC} ${directCommits.length}`,
  ];

  for (const c of directCommits) {
    const sha = typeof c['sha'] === 'string' ? c['sha'].slice(0, 10) : '?';
    const subject = typeof c['subject'] === 'string' ? c['subject'] : '';
    lines.push(`  ${CYAN}${sha}${NC}  ${subject}`);
  }

  lines.push('');
  if (childIdRange) {
    lines.push(
      `${DIM}Inferred children:${NC} ${inferredChildren.join(', ')} (${childIdRange.min} → ${childIdRange.max})`,
    );
  } else {
    lines.push(`${DIM}Inferred children:${NC} none`);
  }

  const childEntries = Object.entries(childCommits);
  if (childEntries.length > 0) {
    lines.push('');
    lines.push(`${BOLD}Child commits:${NC}`);
    for (const [childId, commits] of childEntries) {
      lines.push(`  ${CYAN}${childId}${NC}: ${commits.length} commit(s)`);
      for (const c of commits) {
        const sha = typeof c['sha'] === 'string' ? c['sha'].slice(0, 10) : '?';
        const subject = typeof c['subject'] === 'string' ? c['subject'] : '';
        lines.push(`    ${DIM}${sha}${NC}  ${subject}`);
      }
    }
  }

  lines.push('');
  if (releaseTags.length > 0) {
    lines.push(`${BOLD}Release tags (${releaseTags.length}):${NC}`);
    for (const t of releaseTags) {
      const tag = typeof t['tag'] === 'string' ? t['tag'] : '?';
      const sha = typeof t['commitSha'] === 'string' ? t['commitSha'].slice(0, 10) : '?';
      const subject = typeof t['subject'] === 'string' ? t['subject'] : '';
      lines.push(`  ${GREEN}${tag}${NC}  ${DIM}${sha}${NC}  ${subject}`);
    }
  } else {
    lines.push(`${DIM}Release tags:${NC} none found`);
  }

  lines.push('');
  lines.push(`${DIM}First seen:${NC} ${firstSeenAt ?? 'n/a'}`);
  lines.push(`${DIM}Last seen: ${NC} ${lastSeenAt ?? 'n/a'}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// schema: operation introspection (T1729)
// ---------------------------------------------------------------------------

/**
 * Human renderer for `cleo schema <operation>` output.
 *
 * Renders the OperationSchema as a formatted summary table including params,
 * gates, and examples — matching the inline `renderSchemaHuman` logic previously
 * in commands/schema.ts.
 *
 * @task T1729
 * @epic T1691
 */
export function renderSchemaCommand(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';

  const lines: string[] = [];

  lines.push(`Operation : ${String(data['operation'] ?? '')}`);
  lines.push(`Gateway   : ${String(data['gateway'] ?? '')}`);
  lines.push(`Description: ${String(data['description'] ?? '')}`);
  lines.push('');

  const params = (data['params'] as Array<Record<string, unknown>>) ?? [];
  lines.push('Parameters:');
  if (params.length === 0) {
    lines.push('  (none declared)');
  } else {
    for (const p of params) {
      const req = p['required'] ? '[required]' : '[optional]';
      const enumVal = p['enum'] as string[] | undefined;
      const enumStr = enumVal ? `  enum: ${enumVal.join(' | ')}` : '';
      const cli = p['cli'] as Record<string, unknown> | undefined;
      let cliStr = '';
      if (cli) {
        const parts: string[] = [];
        if (cli['positional']) parts.push('positional');
        if (cli['short']) parts.push(`short: ${String(cli['short'])}`);
        if (cli['flag']) parts.push(`flag: --${String(cli['flag'])}`);
        if (parts.length > 0) cliStr = `  cli: ${parts.join(', ')}`;
      }
      lines.push(`  ${String(p['name'] ?? '')} (${String(p['type'] ?? '')}) ${req}`);
      lines.push(`    ${String(p['description'] ?? '')}${enumStr}${cliStr}`);
    }
  }

  const gates = data['gates'] as Array<Record<string, unknown>> | undefined;
  if (gates !== undefined) {
    lines.push('');
    lines.push('Gates:');
    if (gates.length === 0) {
      lines.push('  (none declared — see note on static gate table)');
    } else {
      for (const g of gates) {
        lines.push(`  ${String(g['name'] ?? '')} → ${String(g['errorCode'] ?? '')}`);
        lines.push(`    ${String(g['description'] ?? '')}`);
        const triggers = (g['triggers'] as string[]) ?? [];
        for (const t of triggers) {
          lines.push(`    - ${t}`);
        }
      }
    }
  }

  const examples = data['examples'] as Array<Record<string, unknown>> | undefined;
  if (examples !== undefined && examples.length > 0) {
    lines.push('');
    lines.push('Examples:');
    for (const ex of examples) {
      lines.push(`  ${String(ex['command'] ?? '')}`);
      lines.push(`    ${String(ex['description'] ?? '')}`);
    }
  }

  return lines.join('\n');
}

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
