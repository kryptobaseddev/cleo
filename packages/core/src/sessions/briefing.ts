/**
 * Session briefing computation.
 *
 * Aggregates session-start context from multiple sources for quick agent
 * orientation. This is the READ side of the handoff/briefing pair.
 *
 * Data sources:
 * - Last session handoff (session.handoff)
 * - Current focus (tasks.current)
 * - Top-N next tasks (tasks.next leverage-scored)
 * - Open bugs (tasks with origin:bug-report or label:bug)
 * - Blocked tasks (tasks.blockers)
 * - Active epics status (tasks.tree filtered)
 * - Pipeline stage data (from T4912)
 * - Docs context (task-attached references, ADR registrations, llmtxt summaries)
 *
 * @task T4916
 * @epic T4914
 */

import type {
  AttachmentMetadata,
  RetrievalBundle,
  SessionBriefingShowParams,
  Task,
  TaskWorkState,
} from '@cleocode/contracts';
import type { SessionMemoryContext } from '../memory/session-memory.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';
import { depsReady } from '../tasks/deps-ready.js';
import { getLastHandoff, type HandoffData } from './handoff.js';
import type { TaskWorkStateExt } from './types.js';

/**
 * Task summary for briefing output.
 */
export interface BriefingTask {
  id: string;
  title: string;
  leverage: number;
  score: number;
}

/**
 * Bug summary for briefing output.
 */
export interface BriefingBug {
  id: string;
  title: string;
  priority: string;
}

/**
 * Blocked task summary for briefing output.
 */
export interface BriefingBlockedTask {
  id: string;
  title: string;
  blockedBy: string[];
}

/**
 * Active epic summary for briefing output.
 */
export interface BriefingEpic {
  id: string;
  title: string;
  completionPercent: number;
}

/**
 * Pipeline stage data for briefing output.
 */
export interface PipelineStageInfo {
  currentStage: string;
  stageStatus: string;
}

/**
 * A single document reference entry for briefing output.
 *
 * Represents one attachment associated with a task: a file path, URL,
 * blob, or generated llms.txt summary that is surfaced in the briefing
 * so new orchestrator runs have immediate access to rationale and references.
 */
export interface BriefingDocRef {
  /** ID of the task that owns this attachment. */
  taskId: string;
  /** Attachment identifier (UUID-like string). */
  attachmentId: string;
  /** Attachment kind (local-file, url, blob, llms-txt, llmtxt-doc). */
  kind: string;
  /** Optional human-readable description of the attachment. */
  description?: string;
  /** Optional labels for categorisation (e.g. ["adr", "spec"]). */
  labels?: string[];
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

/**
 * Docs context for briefing output — the third pillar (state + rationale + references).
 *
 * Contains task-attached document references for the active task and any
 * in-scope tasks that have attachments. Surfaced so `cleo briefing` IS the
 * complete knowledge surface: a new orchestrator run gets state (tasks),
 * rationale (brain memory), and references (docs) in a single call.
 */
export interface BriefingDocsContext {
  /** Document references for the currently focused task. */
  currentTaskDocs: BriefingDocRef[];
  /** Document references for in-scope tasks with at least one attachment. */
  relatedDocs: BriefingDocRef[];
  /** Total number of document references surfaced. */
  totalDocs: number;
}

/**
 * Last session info with handoff data.
 */
export interface LastSessionInfo {
  endedAt: string;
  duration: number;
  handoff: HandoffData;
}

/**
 * Currently active task info.
 */
export interface CurrentTaskInfo {
  id: string;
  title: string;
  status: string;
  blockedBy?: string[];
}

/**
 * Session briefing result.
 */
export interface SessionBriefing {
  lastSession: LastSessionInfo | null;
  currentTask: CurrentTaskInfo | null;
  nextTasks: BriefingTask[];
  openBugs: BriefingBug[];
  blockedTasks: BriefingBlockedTask[];
  activeEpics: BriefingEpic[];
  pipelineStage?: PipelineStageInfo;
  warnings?: string[];
  /** Brain memory context -- decisions/patterns/observations relevant to this scope. */
  memoryContext?: SessionMemoryContext;
  /**
   * PSYCHE Wave 4 multi-pass retrieval bundle.
   *
   * Contains cold (user profile), warm (peer memory), and hot (session state)
   * context assembled by `buildRetrievalBundle` from `brain-retrieval.ts`.
   * Present when the active session and peer ID are resolvable; omitted
   * (undefined) when retrieval fails or is disabled.
   *
   * Consumers may use `bundle` instead of — or in addition to — `memoryContext`
   * for richer structured context. The existing `memoryContext` field is preserved
   * for backward compatibility.
   *
   * @task T1091
   * @epic T1083
   */
  bundle?: RetrievalBundle;
  /**
   * Docs context — the third briefing pillar (references).
   *
   * Surfaces task-attached document references (ADR registrations, llmtxt
   * summaries, URL refs, local files) so `cleo briefing` delivers the complete
   * knowledge surface in one call: state + rationale + references.
   *
   * Present when at least one in-scope task has an attachment; omitted
   * (undefined) when the attachment store is unavailable or no attachments exist.
   *
   * @task T1616
   * @epic T1611
   */
  docsContext?: BriefingDocsContext;
}

/**
 * Options for computing session briefing.
 */
/** @deprecated Use SessionBriefingShowParams from @cleocode/contracts. */
export type BriefingOptions = SessionBriefingShowParams;

const PRIORITY_SCORE: Record<string, number> = {
  critical: 100,
  high: 75,
  medium: 50,
  low: 25,
};

/**
 * Compute the complete session briefing.
 * Normalized Core signature: (projectRoot, params) → Result.
 * Aggregates data from all 6+ sources.
 * @task T1450
 */
export async function computeBriefing(
  projectRoot: string,
  params: SessionBriefingShowParams = {},
): Promise<SessionBriefing> {
  const accessor = await getAccessor(projectRoot);
  const { tasks } = await accessor.queryTasks({});
  const focus = (await accessor.getMetaValue<TaskWorkState>('focus_state')) as
    | TaskWorkStateExt
    | undefined;

  // Build task map for quick lookups
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  // Determine scope
  const scopeFilter = await parseScope(params.scope, accessor);

  // Compute in-scope task IDs (undefined = all tasks in scope)
  const scopeTaskIds = getScopeTaskIdSet(scopeFilter, tasks);

  // 1. Last session handoff
  const lastSession = await computeLastSession(projectRoot, scopeFilter);

  // 2. Current active task
  const currentTaskInfo = computeCurrentTask(focus, taskMap);

  // 3. Next tasks (leverage-scored)
  const nextTasks = computeNextTasks(tasks, taskMap, focus, {
    maxTasks: params.maxNextTasks ?? 5,
    scopeTaskIds,
  });

  // 4. Open bugs
  const openBugs = computeOpenBugs(tasks, taskMap, {
    maxBugs: params.maxBugs ?? 10,
    scopeTaskIds,
  });

  // 5. Blocked tasks
  const blockedTasks = computeBlockedTasks(tasks, taskMap, {
    maxBlocked: params.maxBlocked ?? 10,
    scopeTaskIds,
  });

  // 6. Active epics
  const activeEpics = computeActiveEpics(tasks, taskMap, {
    maxEpics: params.maxEpics ?? 5,
    scopeTaskIds,
  });

  // 7. Pipeline stage (optional - may not be available)
  const pipelineStage = await computePipelineStage(focus);

  // 8. Brain memory context (optional, best-effort)
  let memoryContext: SessionMemoryContext | undefined;
  try {
    const { getSessionMemoryContext } = await import('../memory/session-memory.js');
    memoryContext = await getSessionMemoryContext(projectRoot, scopeFilter);
  } catch {
    // Brain memory not available -- proceed without
  }

  // 9. PSYCHE Wave 4 multi-pass retrieval bundle (optional, best-effort — T1091)
  let bundle: RetrievalBundle | undefined;
  try {
    const { buildRetrievalBundle } = await import('../memory/brain-retrieval.js');

    // Resolve active session ID and peer ID from session state.
    // Peer ID defaults to 'global' when no CANT agent is active.
    const activeSessionObj = await accessor.getActiveSession();
    const activeSessionId = activeSessionObj?.id ?? '';
    const activePeerId =
      ((activeSessionObj as Record<string, unknown> | null)?.['activePeerId'] as
        | string
        | undefined) ?? 'global';

    if (activeSessionId) {
      bundle = await buildRetrievalBundle(
        {
          peerId: activePeerId,
          sessionId: activeSessionId,
          passMask: { cold: true, warm: true, hot: true },
        },
        projectRoot,
      );
    }
  } catch {
    // Retrieval bundle not available -- proceed without
  }

  // 10. Docs context — third pillar: task-attached references (optional, best-effort — T1616)
  let docsContext: BriefingDocsContext | undefined;
  try {
    docsContext = await computeDocsContext(
      projectRoot,
      focus?.currentTask ?? undefined,
      tasks,
      scopeTaskIds,
    );
  } catch {
    // Docs context not available -- proceed without
  }

  // Compute warnings
  const warnings: string[] = [];
  if (currentTaskInfo?.blockedBy?.length) {
    warnings.push(
      `Focused task ${currentTaskInfo.id} is blocked by: ${currentTaskInfo.blockedBy.join(', ')}`,
    );
  }

  return {
    lastSession,
    currentTask: currentTaskInfo,
    nextTasks,
    openBugs,
    blockedTasks,
    activeEpics,
    ...(pipelineStage && { pipelineStage }),
    ...(warnings.length > 0 && { warnings }),
    ...(memoryContext && { memoryContext }),
    ...(bundle && { bundle }),
    ...(docsContext && { docsContext }),
  };
}

/**
 * Parse scope string into filter config.
 * Uses getActiveSession() to auto-detect scope when no explicit scope is provided.
 */
async function parseScope(
  scopeStr: string | undefined,
  accessor: DataAccessor,
): Promise<{ type: 'global' | 'epic'; epicId?: string } | undefined> {
  if (!scopeStr) {
    // Auto-detect from active session
    const activeSession = await accessor.getActiveSession();
    if (activeSession?.scope?.type === 'epic') {
      return { type: 'epic', epicId: activeSession.scope.rootTaskId };
    }
    if (activeSession?.scope?.type === 'global') {
      return { type: 'global' };
    }
    return undefined;
  }

  if (scopeStr === 'global') {
    return { type: 'global' };
  }
  const match = scopeStr.match(/^epic:(T\d+)$/);
  if (match) {
    return { type: 'epic', epicId: match[1] };
  }
  return undefined;
}

/**
 * Compute the set of in-scope task IDs for briefing filtering.
 * Returns undefined for global/unscoped (meaning all tasks are in scope).
 */
function getScopeTaskIdSet(
  scopeFilter: { type: 'global' | 'epic'; epicId?: string } | undefined,
  tasks: Task[],
): Set<string> | undefined {
  if (!scopeFilter || scopeFilter.type === 'global') {
    return undefined; // All tasks in scope
  }

  const rootId = scopeFilter.epicId;
  if (!rootId) return undefined;

  const taskIds = new Set<string>();
  const addDescendants = (taskId: string) => {
    taskIds.add(taskId);
    for (const t of tasks) {
      if (t.parentId === taskId) {
        addDescendants(t.id);
      }
    }
  };
  addDescendants(rootId);
  return taskIds;
}

/**
 * Compute last session info with handoff data.
 */
async function computeLastSession(
  projectRoot: string,
  scopeFilter: { type: 'global' | 'epic'; epicId?: string } | undefined,
): Promise<LastSessionInfo | null> {
  try {
    const scope = scopeFilter ? { type: scopeFilter.type, epicId: scopeFilter.epicId } : undefined;

    const handoffResult = await getLastHandoff(projectRoot, scope);
    if (!handoffResult) return null;

    const { sessionId, handoff } = handoffResult;

    // Load sessions to get endedAt
    const accessor = await getAccessor(projectRoot);
    const allSessions = await accessor.loadSessions();

    const session = allSessions.find((s) => s.id === sessionId);
    if (!session?.endedAt) return null;

    // Calculate duration if startedAt is available
    let duration = 0;
    if (session.startedAt) {
      duration = Math.round(
        (new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) / 60000,
      );
    }

    return {
      endedAt: session.endedAt,
      duration,
      handoff,
    };
  } catch {
    return null;
  }
}

/**
 * Compute current active task from task file.
 */
function computeCurrentTask(
  focus: TaskWorkStateExt | undefined,
  taskMap: Map<string, unknown>,
): CurrentTaskInfo | null {
  const focusTaskId = focus?.currentTask;
  if (!focusTaskId) return null;

  const task = taskMap.get(focusTaskId) as
    | { id: string; title: string; status: string; depends?: string[] }
    | undefined;
  if (!task) return null;

  const info: CurrentTaskInfo = {
    id: task.id,
    title: task.title,
    status: task.status,
  };

  // Check for unresolved dependencies on the focused task
  if (task.depends?.length) {
    const unresolved = task.depends.filter((depId) => {
      const dep = taskMap.get(depId) as { status?: string } | undefined;
      return dep && dep.status !== 'done' && dep.status !== 'cancelled';
    });
    if (unresolved.length > 0) {
      info.blockedBy = unresolved;
    }
  }

  return info;
}

/**
 * Compute leverage for a task.
 */
function calculateLeverage(taskId: string, taskMap: Map<string, unknown>): number {
  let leverage = 0;
  for (const task of taskMap.values()) {
    const t = task as { depends?: string[] };
    if (t.depends?.includes(taskId)) {
      leverage++;
    }
  }
  return leverage;
}

/**
 * Compute next tasks sorted by leverage and score.
 */
function computeNextTasks(
  tasks: unknown[],
  taskMap: Map<string, unknown>,
  focus: TaskWorkStateExt | undefined,
  options: { maxTasks: number; scopeTaskIds?: Set<string> },
): BriefingTask[] {
  const pendingTasks = tasks.filter((t) => {
    const task = t as { id?: string; status?: string };
    return (
      task.status === 'pending' && (!options.scopeTaskIds || options.scopeTaskIds.has(task.id!))
    );
  });

  const scored: BriefingTask[] = [];
  const currentPhase = focus?.currentPhase;

  for (const task of pendingTasks) {
    const t = task as {
      id: string;
      title: string;
      priority?: string;
      phase?: string;
      createdAt?: string;
      depends?: string[];
    };

    if (!depsReady(t.depends, taskMap)) continue;

    const leverage = calculateLeverage(t.id, taskMap);
    let score = PRIORITY_SCORE[t.priority || 'medium'] ?? 50;

    // Phase alignment bonus
    if (currentPhase && t.phase === currentPhase) {
      score += 20;
    }

    // Dependencies satisfied bonus
    if (t.depends && t.depends.length > 0) {
      score += 10;
    }

    // Age bonus
    if (t.createdAt) {
      const ageMs = Date.now() - new Date(t.createdAt).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      if (ageDays > 7) {
        score += Math.min(15, Math.floor(ageDays / 7));
      }
    }

    // Leverage bonus
    if (leverage > 0) {
      score += leverage * 5;
    }

    scored.push({ id: t.id, title: t.title, leverage, score });
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, options.maxTasks);
}

/**
 * Compute open bugs.
 */
function computeOpenBugs(
  tasks: unknown[],
  _taskMap: Map<string, unknown>,
  options: { maxBugs: number; scopeTaskIds?: Set<string> },
): BriefingBug[] {
  const bugs: BriefingBug[] = [];

  for (const task of tasks) {
    const t = task as {
      id: string;
      title: string;
      status?: string;
      priority?: string;
      origin?: string;
      labels?: string[];
    };

    const isBug = t.origin === 'bug-report' || t.labels?.includes('bug');
    const isOpen = t.status !== 'done' && t.status !== 'cancelled';

    if (isBug && isOpen && (!options.scopeTaskIds || options.scopeTaskIds.has(t.id))) {
      bugs.push({
        id: t.id,
        title: t.title,
        priority: t.priority || 'medium',
      });
    }
  }

  // Sort by priority
  const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  bugs.sort((a, b) => (priorityOrder[a.priority] ?? 99) - (priorityOrder[b.priority] ?? 99));

  return bugs.slice(0, options.maxBugs);
}

/**
 * Compute blocked tasks.
 */
function computeBlockedTasks(
  tasks: unknown[],
  taskMap: Map<string, unknown>,
  options: { maxBlocked: number; scopeTaskIds?: Set<string> },
): BriefingBlockedTask[] {
  const blocked: BriefingBlockedTask[] = [];

  for (const task of tasks) {
    const t = task as {
      id: string;
      title: string;
      status?: string;
      depends?: string[];
      blockedBy?: string;
    };

    if (options.scopeTaskIds && !options.scopeTaskIds.has(t.id)) continue;

    const blockedBy: string[] = [];

    // Check blocked status
    if (t.status === 'blocked' && t.blockedBy) {
      blockedBy.push(t.blockedBy);
    }

    // Check unresolved dependencies
    if (t.depends && t.depends.length > 0) {
      for (const depId of t.depends) {
        const dep = taskMap.get(depId) as { status?: string } | undefined;
        if (dep && dep.status !== 'done' && dep.status !== 'cancelled') {
          if (!blockedBy.includes(depId)) {
            blockedBy.push(depId);
          }
        }
      }
    }

    if (blockedBy.length > 0) {
      blocked.push({
        id: t.id,
        title: t.title,
        blockedBy,
      });
    }
  }

  return blocked.slice(0, options.maxBlocked);
}

/**
 * Compute active epics.
 */
function computeActiveEpics(
  tasks: unknown[],
  taskMap: Map<string, unknown>,
  options: { maxEpics: number; scopeTaskIds?: Set<string> },
): BriefingEpic[] {
  const epics: BriefingEpic[] = [];

  for (const task of tasks) {
    const t = task as {
      id: string;
      title: string;
      type?: string;
      status?: string;
    };

    if (options.scopeTaskIds && !options.scopeTaskIds.has(t.id)) continue;

    if (t.type === 'epic' && t.status === 'active') {
      const completionPercent = calculateEpicCompletion(t.id, taskMap);
      epics.push({
        id: t.id,
        title: t.title,
        completionPercent,
      });
    }
  }

  // Sort by completion (ascending - less complete first)
  epics.sort((a, b) => a.completionPercent - b.completionPercent);

  return epics.slice(0, options.maxEpics);
}

/**
 * Calculate completion percentage for an epic.
 */
function calculateEpicCompletion(epicId: string, taskMap: Map<string, unknown>): number {
  let totalTasks = 0;
  let completedTasks = 0;

  // Collect all descendant tasks
  const collectTasks = (parentId: string): void => {
    for (const task of taskMap.values()) {
      const t = task as { parentId?: string; id: string; status?: string };
      if (t.parentId === parentId) {
        totalTasks++;
        if (t.status === 'done' || t.status === 'cancelled') {
          completedTasks++;
        }
        collectTasks(t.id);
      }
    }
  };

  collectTasks(epicId);

  return totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
}

/**
 * Compute pipeline stage info from task file metadata.
 */
async function computePipelineStage(
  focus: TaskWorkStateExt | undefined,
): Promise<PipelineStageInfo | undefined> {
  const taskId = focus?.currentTask;
  if (!taskId) return undefined;

  try {
    const { getPipeline } = await import('../lifecycle/pipeline.js');
    const pipeline = await getPipeline(taskId);
    if (!pipeline) return undefined;

    return {
      currentStage: pipeline.currentStage,
      stageStatus: pipeline.isActive ? 'active' : (pipeline.status ?? 'completed'),
    };
  } catch {
    return undefined;
  }
}

// ─── Max per-task doc refs in briefing output ─────────────────────────────────
const MAX_DOCS_PER_TASK = 10;
/** Maximum number of related-task doc entries in the briefing (across all tasks). */
const MAX_RELATED_DOCS = 20;

/**
 * Compute the docs context pillar for the session briefing.
 *
 * Queries the attachment store (tasks.db) for:
 * - Attachments on the currently focused task (if any).
 * - Attachments on any in-scope task that has at least one attachment,
 *   up to {@link MAX_RELATED_DOCS} entries total.
 *
 * All queries are best-effort: individual task failures are swallowed so
 * that a corrupt attachment ref never blocks the briefing.
 *
 * @param projectRoot  - Absolute path to the project root.
 * @param currentTaskId - ID of the currently focused task (may be undefined).
 * @param tasks        - All tasks loaded by computeBriefing.
 * @param scopeTaskIds - Optional set of in-scope task IDs (undefined = all).
 * @returns Docs context with current-task refs and related refs, or undefined
 *          when no attachments exist.
 *
 * @task T1616
 * @epic T1611
 */
async function computeDocsContext(
  projectRoot: string,
  currentTaskId: string | undefined,
  tasks: unknown[],
  scopeTaskIds: Set<string> | undefined,
): Promise<BriefingDocsContext | undefined> {
  // Dynamically import the attachment store to avoid mandatory hard deps.
  const { createAttachmentStore } = await import('../store/attachment-store.js');
  const store = createAttachmentStore();

  /**
   * Convert one AttachmentMetadata record into a BriefingDocRef.
   */
  function toDocRef(taskId: string, meta: AttachmentMetadata): BriefingDocRef {
    const att = meta.attachment;
    return {
      taskId,
      attachmentId: meta.id,
      kind: att.kind,
      ...(att.description ? { description: att.description } : {}),
      ...(att.labels?.length ? { labels: att.labels } : {}),
      createdAt: meta.createdAt,
    };
  }

  // 1. Fetch attachments for the currently focused task.
  const currentTaskDocs: BriefingDocRef[] = [];
  if (currentTaskId) {
    try {
      const metas = await store.listByOwner('task', currentTaskId, projectRoot);
      for (const meta of metas.slice(0, MAX_DOCS_PER_TASK)) {
        currentTaskDocs.push(toDocRef(currentTaskId, meta));
      }
    } catch {
      // Attachment store unavailable for this task — proceed without
    }
  }

  // 2. Fetch attachments for in-scope tasks (excluding the current task).
  const relatedDocs: BriefingDocRef[] = [];

  const candidateTasks = tasks.filter((t) => {
    const task = t as { id?: string };
    return task.id && task.id !== currentTaskId && (!scopeTaskIds || scopeTaskIds.has(task.id));
  });

  for (const t of candidateTasks) {
    if (relatedDocs.length >= MAX_RELATED_DOCS) break;

    const task = t as { id: string };
    try {
      const metas = await store.listByOwner('task', task.id, projectRoot);
      for (const meta of metas.slice(0, MAX_DOCS_PER_TASK)) {
        if (relatedDocs.length >= MAX_RELATED_DOCS) break;
        relatedDocs.push(toDocRef(task.id, meta));
      }
    } catch {
      // Attachment store unavailable for this task — proceed without
    }
  }

  const totalDocs = currentTaskDocs.length + relatedDocs.length;

  // Return undefined when no docs exist — avoids polluting the briefing with an
  // empty docs pillar when the attachment store is empty.
  if (totalDocs === 0) return undefined;

  return { currentTaskDocs, relatedDocs, totalDocs };
}
