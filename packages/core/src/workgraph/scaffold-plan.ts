/**
 * WorkGraph planning doc generator — produces markdown planning documents
 * from saga WorkGraph structures with agent and maintainer audience modes.
 *
 * @task T10634
 * @saga T10538
 * @epic T10547
 */

import type { Task } from '@cleocode/contracts';
import { resolveSagaMemberIds } from '../sagas/storage.js';
import { getTaskAccessor } from '../store/data-accessor.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Audience mode controlling output style and detail level. */
export type PlanningDocAudience = 'agent' | 'maintainer';

/** Parameters for generating a planning document from a saga WorkGraph. */
export interface PlanningDocParams {
  /** Saga task ID to generate the plan for. */
  readonly sagaId: string;
  /** Output audience mode. Defaults to 'maintainer'. */
  readonly audience?: PlanningDocAudience;
  /** Maximum estimated token budget for agent-mode output. */
  readonly tokenBudget?: number;
}

/** A single epic entry in the planning document. */
export interface PlanningDocEpicEntry {
  epicId: string;
  title: string;
  status: string;
  completionPct: number;
  totalChildren: number;
  doneChildren: number;
  activeChildren: number;
  blockedChildren: number;
  pendingChildren: number;
}

/** A ready task entry in the planning document. */
export interface PlanningDocReadyTask {
  id: string;
  title: string;
  priority: string;
  epicId: string;
  depends: string[];
}

/** A blocked task entry in the planning document. */
export interface PlanningDocBlockedTask {
  id: string;
  title: string;
  status: string;
  blockedBy: string[];
  blocksCount: number;
}

/** Structured result of plan generation. */
export interface PlanningDocResult {
  /** The generated markdown document. */
  readonly markdown: string;
  /** Estimated token count of the output. */
  readonly estimatedTokens: number;
  /** Audience mode used for generation. */
  readonly audience: PlanningDocAudience;
  /** ISO 8601 timestamp of generation. */
  readonly generatedAt: string;
  /** Saga ID the plan was generated from. */
  readonly sagaId: string;
  /** Saga title. */
  readonly sagaTitle: string;
  /** Structured epic entries (for SSoT attachment). */
  readonly epics: readonly PlanningDocEpicEntry[];
  /** Ready task entries. */
  readonly readyTasks: readonly PlanningDocReadyTask[];
  /** Blocked task entries. */
  readonly blockedTasks: readonly PlanningDocBlockedTask[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ESTIMATED_TOKENS_PER_CHAR = 0.25;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length * ESTIMATED_TOKENS_PER_CHAR);
}

function statusEmoji(status: string): string {
  switch (status) {
    case 'done':
      return '✅';
    case 'active':
      return '🔄';
    case 'blocked':
      return '🚫';
    case 'pending':
      return '⏳';
    case 'cancelled':
      return '❌';
    default:
      return '⬜';
  }
}

function priorityEmoji(priority: string): string {
  switch (priority) {
    case 'critical':
      return '🔴';
    case 'high':
      return '🟠';
    case 'medium':
      return '🟡';
    case 'low':
      return '🟢';
    default:
      return '⚪';
  }
}

async function buildEpicEntry(epic: Task, children: Task[]): Promise<PlanningDocEpicEntry> {
  let done = 0;
  let active = 0;
  let blocked = 0;
  let pending = 0;

  for (const child of children) {
    switch (child.status) {
      case 'done':
        done++;
        break;
      case 'active':
        active++;
        break;
      case 'blocked':
        blocked++;
        break;
      case 'cancelled':
        break;
      default:
        pending++;
        break;
    }
  }

  const total = children.length;
  const completionPct = total > 0 ? Math.round((done / total) * 100) : 0;

  return {
    epicId: epic.id,
    title: epic.title,
    status: epic.status,
    completionPct,
    totalChildren: total,
    doneChildren: done,
    activeChildren: active,
    blockedChildren: blocked,
    pendingChildren: pending,
  };
}

// ---------------------------------------------------------------------------
// Document generators
// ---------------------------------------------------------------------------

function generateAgentDoc(
  saga: Task,
  epics: PlanningDocEpicEntry[],
  readyTasks: PlanningDocReadyTask[],
  blockedTasks: PlanningDocBlockedTask[],
): string {
  const lines: string[] = [];

  // Header — compact
  const summaryLine = epics
    .map((e) => {
      const icon = e.status === 'done' ? '✓' : e.status === 'active' ? '~' : '○';
      return `${e.epicId}:${icon}${e.completionPct}%`;
    })
    .join(' ');
  lines.push(`## ${saga.title}`);
  lines.push(`Saga: ${saga.id} | Status: ${saga.status} | ${epics.length} epics`);
  lines.push(summaryLine);
  lines.push('');

  // Epic breakdown — one line each
  lines.push('### Epics');
  for (const epic of epics) {
    const pctBar = epic.completionPct >= 80 ? '██' : epic.completionPct >= 40 ? '▓▓' : '░░';
    lines.push(
      `- ${epic.epicId} ${pctBar} ${epic.completionPct}% ` +
        `(${epic.doneChildren}/${epic.totalChildren} done) ` +
        `${epic.title.slice(0, 80)}`,
    );
  }
  lines.push('');

  // Ready tasks — compact list
  if (readyTasks.length > 0) {
    lines.push('### Ready');
    for (const task of readyTasks.slice(0, 20)) {
      const deps = task.depends.length > 0 ? ` [dep:${task.depends.join(',')}]` : '';
      lines.push(`- ${task.id} (${task.priority}) ${task.title.slice(0, 80)}${deps}`);
    }
    if (readyTasks.length > 20) {
      lines.push(`  ... +${readyTasks.length - 20} more`);
    }
    lines.push('');
  }

  // Blocked tasks
  if (blockedTasks.length > 0) {
    lines.push('### Blocked');
    for (const task of blockedTasks.slice(0, 15)) {
      const by = task.blockedBy.join(',');
      const blocks = task.blocksCount > 0 ? ` (blocks ${task.blocksCount})` : '';
      lines.push(`- ${task.id} ← ${by}${blocks} : ${task.title.slice(0, 60)}`);
    }
    if (blockedTasks.length > 15) {
      lines.push(`  ... +${blockedTasks.length - 15} more`);
    }
    lines.push('');
  }

  // Metrics footer
  const totalDone = epics.reduce((s, e) => s + e.doneChildren, 0);
  const totalTasks = epics.reduce((s, e) => s + e.totalChildren, 0);
  const overallPct = totalTasks > 0 ? Math.round((totalDone / totalTasks) * 100) : 0;
  lines.push(`---`);
  lines.push(
    `Overall: ${overallPct}% (${totalDone}/${totalTasks} done) | ` +
      `Ready: ${readyTasks.length} | Blocked: ${blockedTasks.length}`,
  );

  return lines.join('\n');
}

function generateMaintainerDoc(
  saga: Task,
  epics: PlanningDocEpicEntry[],
  readyTasks: PlanningDocReadyTask[],
  blockedTasks: PlanningDocBlockedTask[],
): string {
  const lines: string[] = [];

  // Header with overview
  const totalDone = epics.reduce((s, e) => s + e.doneChildren, 0);
  const totalTasks = epics.reduce((s, e) => s + e.totalChildren, 0);
  const overallPct = totalTasks > 0 ? Math.round((totalDone / totalTasks) * 100) : 0;
  const doneEpics = epics.filter((e) => e.status === 'done').length;

  lines.push(`# Planning Document: ${saga.title}`);
  lines.push('');
  lines.push(`**Saga ID:** ${saga.id}`);
  lines.push(`**Status:** ${saga.status}`);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`## Overview`);
  lines.push('');
  lines.push(
    `${overallPct}% complete — ${doneEpics}/${epics.length} epics finalized, ` +
      `${totalDone}/${totalTasks} tasks done across all epics. ` +
      `${readyTasks.length} tasks ready to start, ${blockedTasks.length} blocked.`,
  );
  lines.push('');

  // Epic breakdown with detail
  lines.push(`## Epic Breakdown`);
  lines.push('');
  for (const epic of epics) {
    const icon = statusEmoji(epic.status);
    lines.push(`### ${icon} ${epic.epicId}: ${epic.title}`);
    lines.push('');
    lines.push(`- **Status:** ${epic.status}`);
    lines.push(
      `- **Completion:** ${epic.completionPct}% (${epic.doneChildren}/${epic.totalChildren} tasks done)`,
    );

    if (epic.activeChildren > 0) {
      lines.push(`- **Active tasks:** ${epic.activeChildren} in progress`);
    }
    if (epic.blockedChildren > 0) {
      lines.push(`- **Blocked tasks:** ${epic.blockedChildren} waiting on dependencies`);
    }
    if (epic.pendingChildren > 0) {
      lines.push(`- **Pending tasks:** ${epic.pendingChildren} not yet started`);
    }
    lines.push('');
  }

  // Ready tasks with detail
  if (readyTasks.length > 0) {
    lines.push(`## Ready to Start (${readyTasks.length} tasks)`);
    lines.push('');
    for (const task of readyTasks) {
      const prioIcon = priorityEmoji(task.priority);
      lines.push(`- ${prioIcon} **${task.id}** — ${task.title}`);
      lines.push(`  - Priority: ${task.priority} | Epic: ${task.epicId}`);
      if (task.depends.length > 0) {
        lines.push(`  - Depends on: ${task.depends.join(', ')}`);
      }
    }
    lines.push('');
  }

  // Blocked tasks with detail
  if (blockedTasks.length > 0) {
    lines.push(`## Blocked (${blockedTasks.length} tasks)`);
    lines.push('');
    for (const task of blockedTasks) {
      lines.push(`- 🚫 **${task.id}** — ${task.title}`);
      lines.push(`  - Status: ${task.status} | Blocked by: ${task.blockedBy.join(', ')}`);
      if (task.blocksCount > 0) {
        lines.push(`  - This task is itself blocking ${task.blocksCount} other task(s)`);
      }
    }
    lines.push('');
  }

  // Recommendations
  lines.push(`## Recommendations`);
  lines.push('');

  if (readyTasks.length > 0) {
    const highReady = readyTasks.filter((t) => t.priority === 'high' || t.priority === 'critical');
    if (highReady.length > 0) {
      lines.push(
        `- **Start with ${highReady[0].id}** — ` +
          `highest-priority ready task (${highReady[0].priority}).`,
      );
    }
    if (readyTasks.length >= 3) {
      lines.push(
        `- **Parallelize:** ${readyTasks.length} ready tasks — ` +
          `consider dispatching up to 3 in parallel if independent.`,
      );
    }
  }

  if (blockedTasks.length > 0) {
    lines.push(
      `- **Unblock:** ${blockedTasks.length} tasks are blocked — ` +
        `resolve upstream dependencies to unlock them.`,
    );
  }

  const bottleneckEpics = epics.filter((e) => e.blockedChildren > 0 && e.status !== 'done');
  if (bottleneckEpics.length > 0) {
    lines.push(
      `- **Focus:** Epics ${bottleneckEpics.map((e) => e.epicId).join(', ')} ` +
        `have blocked children — prioritize unblocking work here.`,
    );
  }

  lines.push('');
  lines.push(`---`);
  lines.push(
    `*Generated by CLEO WorkGraph planning doc generator (T10634). ` +
      `Saga ${saga.id}, ${new Date().toISOString()}.*`,
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a planning document from a saga WorkGraph structure.
 *
 * Reads saga membership, epic statuses, and child task data to produce
 * a structured markdown planning document. Supports two audience modes:
 *
 * - `agent`: Compact, token-efficient output for LLM consumption.
 *   Prioritizes structured lists over prose, uses icons/symbols, and
 *   caps output at ~1500 tokens.
 *
 * - `maintainer` (default): Human-readable markdown with descriptive
 *   prose, headers, status emojis, and actionable recommendations.
 *
 * The result includes structured entries suitable for attachment to the
 * docs SSoT via `cleo docs add`.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params - Saga ID and audience configuration.
 * @returns Structured planning document with markdown and metadata.
 */
export async function generatePlanningDoc(
  projectRoot: string,
  params: PlanningDocParams,
): Promise<PlanningDocResult> {
  const { sagaId, audience = 'maintainer' } = params;
  const generatedAt = new Date().toISOString();
  const accessor = await getTaskAccessor(projectRoot);

  try {
    // Load saga
    const saga = await accessor.loadSingleTask(sagaId);
    if (!saga) {
      throw new Error(`Saga '${sagaId}' not found`);
    }

    // Resolve member epic IDs
    const memberIds = await resolveSagaMemberIds(accessor, sagaId);
    if (memberIds === null) {
      throw new Error(`Saga '${sagaId}' not found or is not a saga`);
    }

    // Load all member epics + their children
    const epicTasks = await accessor.loadTasks(memberIds);
    const epicEntries: PlanningDocEpicEntry[] = [];
    const readyTasks: PlanningDocReadyTask[] = [];
    const blockedTasks: PlanningDocBlockedTask[] = [];

    for (const epic of epicTasks) {
      const children = await accessor.getChildren(epic.id);
      const entry = await buildEpicEntry(epic, children);
      epicEntries.push(entry);

      // Collect ready and blocked tasks from children
      for (const child of children) {
        const depends = child.depends ?? [];

        // Ready: pending with no unsatisfied deps
        if (child.status === 'pending' && depends.length === 0) {
          readyTasks.push({
            id: child.id,
            title: child.title,
            priority: child.priority,
            epicId: epic.id,
            depends,
          });
        } else if (
          (child.status === 'pending' || child.status === 'blocked') &&
          depends.length > 0
        ) {
          blockedTasks.push({
            id: child.id,
            title: child.title,
            status: child.status,
            blockedBy: depends,
            blocksCount: 0, // computed below
          });
        }
      }
    }

    // Sort entries
    epicEntries.sort((a, b) => a.epicId.localeCompare(b.epicId));

    // Sort ready tasks: priority then id
    const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    readyTasks.sort(
      (a, b) =>
        (priorityOrder[a.priority] ?? 99) - (priorityOrder[b.priority] ?? 99) ||
        a.id.localeCompare(b.id),
    );

    // Compute blocksCount for blocked tasks
    const idToBlocked = new Map(blockedTasks.map((t) => [t.id, t]));
    for (const task of blockedTasks) {
      for (const depId of task.blockedBy) {
        const dep = idToBlocked.get(depId);
        if (dep) dep.blocksCount++;
      }
    }
    blockedTasks.sort(
      (a, b) => b.blockedBy.length - a.blockedBy.length || a.id.localeCompare(b.id),
    );

    // Generate markdown
    let markdown: string;
    switch (audience) {
      case 'agent':
        markdown = generateAgentDoc(saga, epicEntries, readyTasks, blockedTasks);
        break;
      case 'maintainer':
      default:
        markdown = generateMaintainerDoc(saga, epicEntries, readyTasks, blockedTasks);
        break;
    }

    return {
      markdown,
      estimatedTokens: estimateTokens(markdown),
      audience,
      generatedAt,
      sagaId,
      sagaTitle: saga.title,
      epics: epicEntries,
      readyTasks,
      blockedTasks,
    };
  } finally {
    await accessor.close();
  }
}
