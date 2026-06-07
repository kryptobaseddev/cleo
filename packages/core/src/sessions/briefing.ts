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
  BriefingFieldContract,
  ContractViolation,
  RetrievalBundle,
  SessionBriefingShowParams,
  Task,
} from '@cleocode/contracts';
import type { SessionMemoryContext } from '../memory/session-memory.js';
import { truncateString } from '../render/helpers.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { depsReady } from '../tasks/deps-ready.js';
import { readFocusState } from './focus-state-store.js';
import { getLastHandoff, type HandoffData } from './handoff.js';
import { resolveSessionIdFromEnv } from './session-id.js';
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
 * Urgent task summary for briefing output (T9905).
 *
 * One entry per task that matches the unified urgency predicate:
 *
 *   `priority IN ('critical','high') OR severity IN ('P0','P1')`
 *
 * `priority` is always populated; `severity` is included only when the task
 * row sets it (null otherwise). Sorted by axis class (P0 wins over critical
 * wins over P1 wins over high) so the most-urgent row surfaces first.
 *
 * @task T9905
 */
export interface BriefingUrgentTask {
  id: string;
  title: string;
  priority: string;
  severity?: string | null;
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
  /**
   * Human-readable kebab-case slug for this attachment (when set).
   * Only entries with a slug are surfaced in the default briefing diet;
   * entries without a slug are dropped as they cannot be fetched by name.
   *
   * @task T9964
   */
  slug?: string;
  /**
   * Document type classification (e.g. "adr", "spec", "handoff", "research").
   * Set when the attachment was created with an explicit type annotation.
   *
   * @task T9964
   */
  type?: string;
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
  /**
   * Tasks matching the unified urgency predicate (T9905):
   *   `priority IN ('critical','high') OR severity IN ('P0','P1')`.
   *
   * Always present (empty array when nothing is urgent). Surfaces both
   * urgency axes in one section so a fresh orchestrator session sees
   * urgent work without scanning openBugs + nextTasks separately.
   *
   * @task T9905
   */
  urgentTasks: BriefingUrgentTask[];
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
  /**
   * Contract violations detected during briefing computation (T1905 / BBTT-W1-3).
   *
   * Present when a `BriefingFieldContract` is evaluated and at least one violation
   * is found. Consumers can inspect violations directly; `cleo briefing --strict`
   * exits non-zero when this array is non-empty.
   */
  contractViolations?: ContractViolation[];
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
  const accessor = await getTaskAccessor(projectRoot);
  const { tasks } = await accessor.queryTasks({});
  // T11345 — read the PER-SESSION focus_state for the briefing's session.
  // Precedence: explicit params.activeSessionId (env-resolved by the engine-op)
  // → env-first resolver → legacy global key (backward-compat fallback inside
  // readFocusState). This scopes the "current task" line to the CALLER's agent.
  const focusSessionId = params.activeSessionId ?? resolveSessionIdFromEnv();
  const focus = ((await readFocusState(accessor, focusSessionId)) ?? undefined) as
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

  // 3. Next tasks (leverage-scored) — default capped at 3 (T9974)
  const nextTasks = computeNextTasks(tasks, taskMap, focus, {
    maxTasks: params.maxNextTasks ?? 3,
    scopeTaskIds,
  });

  // 4. Open bugs
  const openBugs = computeOpenBugs(tasks, taskMap, {
    maxBugs: params.maxBugs ?? 10,
    scopeTaskIds,
  });

  // 5. Blocked tasks — default diet cap of 3 (T9964)
  const blockedTasks = computeBlockedTasks(tasks, taskMap, {
    maxBlocked: params.maxBlocked ?? MAX_BLOCKED_TASKS_DIET,
    scopeTaskIds,
    truncateTitles: true,
  });

  // 6. Active epics — deduped against nextTasks (T9974), diet cap of 3 (T9964)
  const nextTaskIdSet = new Set(nextTasks.map((t) => t.id));
  const rawActiveEpics = computeActiveEpics(tasks, taskMap, {
    maxEpics: params.maxEpics ?? MAX_ACTIVE_EPICS_DIET,
    scopeTaskIds,
    truncateTitles: true,
  });
  // Remove epics already surfaced in nextTasks to avoid duplicate signal
  const activeEpics = rawActiveEpics.filter((e) => !nextTaskIdSet.has(e.id));

  // 6.5. Urgent tasks — unified urgency surface (T9905).
  // Combines the two orthogonal urgency axes (priority + severity) into a
  // single section so a fresh orchestrator session sees urgent work without
  // having to scan openBugs + nextTasks separately.
  const urgentTasks = computeUrgentTasks(tasks, {
    maxUrgent: MAX_URGENT_TASKS_DIET,
    scopeTaskIds,
    truncateTitles: true,
  });

  // 7. Pipeline stage (optional - may not be available)
  const pipelineStage = await computePipelineStage(focus);

  // 8. Brain memory context (optional, best-effort)
  // T9964: truncate title fields to MAX_MEMORY_TITLE_LEN_DIET in default mode.
  let memoryContext: SessionMemoryContext | undefined;
  try {
    const { getSessionMemoryContext } = await import('../memory/session-memory.js');
    const rawMemoryContext = await getSessionMemoryContext(projectRoot, scopeFilter);
    if (!params.memoryDetail) {
      // Truncate title fields to 80 chars to reduce token count.
      // BrainCompactHit has a `title` string field — we map over arrays.
      const truncHits = <T extends { title: string }>(hits: T[]): T[] =>
        hits.map((h) => ({ ...h, title: truncateString(h.title, MAX_MEMORY_TITLE_LEN_DIET) }));
      memoryContext = {
        ...rawMemoryContext,
        recentLearnings: truncHits(rawMemoryContext.recentLearnings),
        recentObservations: truncHits(rawMemoryContext.recentObservations),
        relevantPatterns: truncHits(rawMemoryContext.relevantPatterns),
        recentDecisions: truncHits(rawMemoryContext.recentDecisions),
      };
    } else {
      memoryContext = rawMemoryContext;
    }
  } catch {
    // Brain memory not available -- proceed without
  }

  // 9. PSYCHE Wave 4 multi-pass retrieval bundle (optional, best-effort — T1091)
  // T9974: post-process bundle to suppress noise fields in default mode.
  //   - peerPatterns: only included when params.debug is true
  //   - cold.userProfile: only included when params.withProfile is true
  //   - hot.sessionNarrative: dropped when empty string (avoids `"sessionNarrative": ""` noise)
  let bundle: RetrievalBundle | undefined;
  try {
    const { buildRetrievalBundle } = await import('../memory/brain-retrieval.js');

    // T9975/T11640: Resolve the CALLER's session via explicit param → identity
    // resolution (connection-handle → CLEO_SESSION_ID → most-recent-active).
    // `resolveCurrentSession` honours the env-named session in the engine layer
    // before calling computeBriefing; here we prefer whatever
    // `params.activeSessionId` was passed down, then fall back to the resolver.
    let activeSessionObj = params.activeSessionId
      ? await (async () => {
          const sessions = await accessor.loadSessions();
          return sessions.find((s) => s.id === params.activeSessionId) ?? null;
        })()
      : await accessor.resolveCurrentSession();
    // Display fallback (SCAN-meaning): if the resolved/pinned session is
    // ended/missing, revert to the most-recent ACTIVE row so the briefing still
    // surfaces *a* live session rather than an ended one.
    if (!activeSessionObj || activeSessionObj.status !== 'active') {
      activeSessionObj = await accessor.getActiveSession();
    }
    const activeSessionId = activeSessionObj?.id ?? '';
    const activePeerId =
      ((activeSessionObj as Record<string, unknown> | null)?.['activePeerId'] as
        | string
        | undefined) ?? 'global';

    if (activeSessionId) {
      const rawBundle = await buildRetrievalBundle(
        {
          peerId: activePeerId,
          sessionId: activeSessionId,
          passMask: { cold: true, warm: true, hot: true },
        },
        projectRoot,
      );
      bundle = applyBriefingDiet(rawBundle, {
        debug: params.debug ?? false,
        withProfile: params.withProfile ?? false,
        memoryDetail: params.memoryDetail ?? false,
      });
    }
  } catch {
    // Retrieval bundle not available -- proceed without
  }

  // 10. Docs context — third pillar: task-attached references (optional, best-effort — T1616)
  // T9974: relatedDocs capped at 5 entries with 7-day recency filter
  // T9967: relatedDocs ranked so scope-relevant docs surface first before the cap.
  let docsContext: BriefingDocsContext | undefined;
  try {
    const rawDocsContext = await computeDocsContext(
      projectRoot,
      focus?.currentTask ?? undefined,
      tasks,
      scopeTaskIds,
      scopeFilter,
    );
    if (rawDocsContext) {
      docsContext = applyDocsFilter(rawDocsContext, params.scope);
    }
  } catch {
    // Docs context not available -- proceed without
  }

  // T9964: Strip empty arrays from lastSession.handoff to reduce token noise.
  // Empty `tasksCompleted`, `tasksCreated`, `nextSuggested`, `openBlockers`,
  // `openBugs` add JSON weight without actionable content.
  const cleanedLastSession: LastSessionInfo | null = lastSession
    ? {
        ...lastSession,
        handoff: cleanHandoff(lastSession.handoff),
      }
    : null;

  // Compute warnings
  const warnings: string[] = [];
  if (currentTaskInfo?.blockedBy?.length) {
    warnings.push(
      `Focused task ${currentTaskInfo.id} is blocked by: ${currentTaskInfo.blockedBy.join(', ')}`,
    );
  }

  // Build partial briefing for contract assertion
  const partialBriefing: SessionBriefing = {
    lastSession: cleanedLastSession,
    currentTask: currentTaskInfo,
    nextTasks,
    openBugs,
    blockedTasks,
    activeEpics,
    urgentTasks,
    ...(pipelineStage && { pipelineStage }),
    ...(warnings.length > 0 && { warnings }),
    ...(memoryContext && { memoryContext }),
    ...(bundle && { bundle }),
    ...(docsContext && { docsContext }),
  };

  // T1905 / BBTT-W1-3: Evaluate default briefing contract.
  // Always runs; violations surface as warnings + contractViolations field.
  const defaultContract: BriefingFieldContract = {
    nextTasks: { dedupBy: 'id' },
    openBugs: { dedupBy: 'id' },
    blockedTasks: { dedupBy: 'id' },
    activeEpics: { dedupBy: 'id' },
  };
  const contractViolations = assertBriefingContract(partialBriefing, defaultContract);
  const briefing: SessionBriefing =
    contractViolations.length > 0
      ? {
          ...partialBriefing,
          warnings: [
            ...(partialBriefing.warnings ?? []),
            ...contractViolations.map((v) => `[contract:${v.kind}] ${v.message}`),
          ],
          contractViolations,
        }
      : partialBriefing;

  // Opportunistic dream trigger — T1904 W2-3
  // The existing 5-minute cooldown + dreamInFlight guard in dream-cycle.ts
  // prevent over-firing. Gated by config flag briefing.opportunisticDream
  // (defaults to true).
  //
  // T9948 contention contract:
  //   - The fire-and-forget path inside `dispatchDream` uses
  //     `setImmediate(...).unref()` so this trigger MUST NOT delay process
  //     exit. The structured trace below logs the trigger to the `briefing`
  //     subsystem logger (silent by default; `LOG_LEVEL=info` opt-in) so
  //     contention investigations can correlate writer-lock holders with
  //     opportunistic dream firings.
  //
  // T11655 one-shot guard:
  //   - A one-shot read command (`cleo briefing`) must NOT spawn main-thread
  //     consolidation/embedding. In the published CLI bundle the embedding
  //     worker file is unresolvable, so `runConsolidation` falls back to inline
  //     transformers.js embeddings on the MAIN thread — pinning the CPU (state
  //     Rl) and holding the brain WAL open (the 2.1GB-bloat regression).
  //   - The dream therefore fires ONLY when (a) the caller explicitly opts in
  //     (`params.allowOpportunisticDream`), or (b) we are running inside a
  //     long-lived sentient host (CLEO_SENTIENT_DAEMON / CLEO_SENTIENT_SPAWN).
  //     The sentient daemon's tick loop owns consolidation directly via
  //     `checkAndDream`, so this gate does not affect that path.
  const inLongLivedHost =
    process.env['CLEO_SENTIENT_DAEMON'] === '1' || process.env['CLEO_SENTIENT_SPAWN'] === '1';
  const dreamAllowed = params.allowOpportunisticDream === true || inLongLivedHost;
  try {
    const { loadConfig } = await import('../config.js');
    const cfg = await loadConfig(projectRoot).catch(() => undefined);
    const enabled = (cfg?.briefing?.opportunisticDream ?? true) && dreamAllowed;
    if (enabled) {
      const { checkAndDream } = await import('../memory/dream-cycle.js');
      const { getLogger } = await import('../logger.js');
      const log = getLogger('briefing');
      // T9948 AC3: emit a structured trace BEFORE firing so a stuck PID
      // can be correlated to the opportunistic dream trigger via the log
      // ring buffer or pino transport.
      log.debug(
        { event: 'opportunistic-dream-trigger', projectRoot, task: 'T9948' },
        'briefing: scheduling opportunistic dream (fire-and-forget, non-keepalive)',
      );
      // Fire async (inline=false) — must never block the briefing response,
      // and per T9948 must not keep the process alive (see dispatchDream
      // `.unref()`).
      checkAndDream(projectRoot, { inline: false }).catch(() => undefined);
    }
  } catch {
    // Best-effort — briefing must never fail due to dream-cycle errors.
  }

  return briefing;
}

/**
 * Parse scope string into filter config.
 * Uses resolveCurrentSession() to auto-detect the CALLER's scope when no
 * explicit scope is provided (T11640 — identity, not most-recent-active).
 */
async function parseScope(
  scopeStr: string | undefined,
  accessor: DataAccessor,
): Promise<{ type: 'global' | 'epic'; epicId?: string } | undefined> {
  if (!scopeStr) {
    // Auto-detect from the caller's resolved session
    const activeSession = await accessor.resolveCurrentSession();
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
 *
 * Resolution order:
 * 1. `getLastHandoff` — looks for a session whose stored scope matches the
 *    requested scope (fastest path, zero extra I/O when found).
 * 2. Docs-based fallback (T9967) — when scope is set but no matching session
 *    exists, query the attachment store for the most recent doc with
 *    `type='handoff'` attached to any task in the scope. Synthesises a
 *    minimal `HandoffData` so callers never receive `lastSession = null`
 *    when scope-specific handoff docs exist.
 */
async function computeLastSession(
  projectRoot: string,
  scopeFilter: { type: 'global' | 'epic'; epicId?: string } | undefined,
): Promise<LastSessionInfo | null> {
  try {
    const scope = scopeFilter ? { type: scopeFilter.type, epicId: scopeFilter.epicId } : undefined;

    const handoffResult = await getLastHandoff(projectRoot, scope);
    if (handoffResult) {
      const { sessionId, handoff } = handoffResult;

      // Load sessions to get endedAt
      const accessor = await getTaskAccessor(projectRoot);
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
    }

    // ── T9967: Docs-based handoff fallback ──────────────────────────────────
    // When no matching session exists for the requested scope, look for a
    // handoff-type doc attached to a task in scope. This covers the case where
    // the orchestrator wrote a handoff via `cleo docs add` but did not end a
    // session with a matching scope.
    if (scope?.type === 'epic' && scope.epicId) {
      return await resolveHandoffFromDocs(projectRoot, scope.epicId);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Synthesise a `LastSessionInfo` from the most recent handoff-type doc
 * attached to any task that is a descendant of `epicId`.
 *
 * Returns `null` when no such doc exists or the attachment store is
 * unavailable.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param epicId      - Root task ID of the scope (e.g., `"T9831"`).
 *
 * @task T9967
 */
async function resolveHandoffFromDocs(
  projectRoot: string,
  epicId: string,
): Promise<LastSessionInfo | null> {
  try {
    const { createAttachmentStore } = await import('../store/attachment-store.js');
    const store = createAttachmentStore();

    // Load all handoff-type docs in the project.
    const allHandoffDocs = await store.listAllInProject(projectRoot, { type: 'handoff' });
    if (allHandoffDocs.length === 0) return null;

    // Build the set of task IDs in scope (epic root + all descendants).
    const accessor = await getTaskAccessor(projectRoot);
    const { tasks } = await accessor.queryTasks({});
    const scopeTaskIds = new Set<string>();
    const addDescendants = (taskId: string): void => {
      scopeTaskIds.add(taskId);
      for (const t of tasks) {
        if (t.parentId === taskId) {
          addDescendants(t.id);
        }
      }
    };
    addDescendants(epicId);

    // Filter to docs owned by a task in scope.
    const scopedDocs = allHandoffDocs.filter(
      (row) => row.ownerType === 'task' && scopeTaskIds.has(row.ownerId),
    );
    if (scopedDocs.length === 0) return null;

    // Pick the most recent doc (sort by createdAt DESC).
    scopedDocs.sort(
      (a, b) => new Date(b.metadata.createdAt).getTime() - new Date(a.metadata.createdAt).getTime(),
    );
    const latest = scopedDocs[0];
    if (!latest) return null;

    const att = latest.metadata.attachment;
    const description = att.description ?? `${att.kind} handoff doc`;

    const handoff: import('./handoff.js').HandoffData = {
      lastTask: latest.ownerId,
      tasksCompleted: [],
      tasksCreated: [],
      decisionsRecorded: 0,
      nextSuggested: [],
      openBlockers: [],
      openBugs: [],
      note: description,
    };

    return {
      endedAt: latest.metadata.createdAt,
      duration: 0,
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
 * Compute the unified urgency surface (T9905).
 *
 * Filters open tasks for the disjunctive predicate
 *
 *   `priority IN ('critical','high') OR severity IN ('P0','P1')`
 *
 * and sorts by an urgency tier so the most-urgent rows surface first:
 *
 *   1. severity=P0     (tier 0)
 *   2. priority=critical (tier 1)
 *   3. severity=P1     (tier 2)
 *   4. priority=high   (tier 3)
 *
 * A task carrying BOTH a high priority AND a P0 severity inherits the
 * stronger tier (0). Completed / cancelled tasks never appear.
 *
 * @task T9905
 */
function computeUrgentTasks(
  tasks: unknown[],
  options: { maxUrgent: number; scopeTaskIds?: Set<string>; truncateTitles?: boolean },
): BriefingUrgentTask[] {
  const urgencyTier = (priority: string, severity: string | null | undefined): number | null => {
    if (severity === 'P0') return 0;
    if (priority === 'critical') return 1;
    if (severity === 'P1') return 2;
    if (priority === 'high') return 3;
    return null;
  };

  const buckets: Array<BriefingUrgentTask & { tier: number }> = [];

  for (const task of tasks) {
    const t = task as {
      id: string;
      title: string;
      status?: string;
      priority?: string;
      severity?: string | null;
    };

    if (options.scopeTaskIds && !options.scopeTaskIds.has(t.id)) continue;
    if (t.status === 'done' || t.status === 'cancelled' || t.status === 'archived') continue;

    const priority = t.priority ?? 'medium';
    const severity = t.severity ?? null;
    const tier = urgencyTier(priority, severity);
    if (tier === null) continue;

    buckets.push({
      id: t.id,
      title: options.truncateTitles ? truncateString(t.title, MAX_TITLE_LEN_DIET) : t.title,
      priority,
      ...(severity ? { severity } : {}),
      tier,
    });
  }

  buckets.sort((a, b) => a.tier - b.tier);
  return buckets.slice(0, options.maxUrgent).map(({ tier: _tier, ...rest }) => rest);
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
  options: { maxBlocked: number; scopeTaskIds?: Set<string>; truncateTitles?: boolean },
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
        title: options.truncateTitles ? truncateString(t.title, MAX_TITLE_LEN_DIET) : t.title,
        blockedBy,
      });
    }
  }

  return blocked.slice(0, options.maxBlocked);
}

/**
 * Heuristic filter: returns true for rows that look like test-fixture epics
 * and should be excluded from the active-epics list.
 *
 * Matches:
 *   - id  matching ^E\d+$ or ^T\d+EP$  (legacy test-epic id patterns)
 *   - title containing "Test Epic", "with no files", "standalone epic", or "fixture"
 *
 * @remarks
 * This is a **temporary heuristic** pending the W3-1 origin column that will
 * allow structural identification of test fixtures. Remove this function once
 * the origin column is in production and all fixture rows carry `origin='test'`.
 *
 * @task T1894
 */
function isTestFixtureEpic(id: string, title: string): boolean {
  if (/^E\d+$/.test(id) || /^T\d+EP$/.test(id)) return true;
  const lower = title.toLowerCase();
  return (
    lower.includes('test epic') ||
    lower.includes('with no files') ||
    lower.includes('standalone epic') ||
    lower.includes('fixture')
  );
}

/**
 * Compute active epics.
 */
function computeActiveEpics(
  tasks: unknown[],
  taskMap: Map<string, unknown>,
  options: { maxEpics: number; scopeTaskIds?: Set<string>; truncateTitles?: boolean },
): BriefingEpic[] {
  const epics: BriefingEpic[] = [];

  for (const task of tasks) {
    const t = task as {
      id: string;
      title: string;
      type?: string;
      status?: string;
      origin?: string | null;
    };

    if (options.scopeTaskIds && !options.scopeTaskIds.has(t.id)) continue;

    if (t.type !== 'epic') continue;
    if (t.status === 'done' || t.status === 'cancelled' || t.status === 'archived') continue;

    // T1899: if origin is set, use it as authoritative filter.
    // origin='test-fixture' rows are excluded; origin='production'/'imported'/'migrated' are included.
    if (t.origin === 'test-fixture') continue;
    // If origin is explicitly set to a non-fixture value, include it (skip heuristic).
    if (t.origin != null && t.origin !== 'test-fixture') {
      // origin is set and not test-fixture — include without heuristic check
    } else {
      // T1894: fallback heuristic for rows without origin set
      if (isTestFixtureEpic(t.id, t.title)) continue;
    }

    const completionPercent = calculateEpicCompletion(t.id, taskMap);
    epics.push({
      id: t.id,
      title: options.truncateTitles ? truncateString(t.title, MAX_TITLE_LEN_DIET) : t.title,
      completionPercent,
    });
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

// ---------------------------------------------------------------------------
// T9974 / T9964: Briefing diet helpers — noise suppression for default mode
// ---------------------------------------------------------------------------

/** Maximum relatedDocs entries in the default (diet) briefing output. */
const MAX_RELATED_DOCS_DIET = 5;
/** Recency window (ms) for relatedDocs in diet mode — 7 days. */
const RELATED_DOCS_RECENCY_MS = 7 * 24 * 60 * 60 * 1000;

/** Maximum peerLearnings entries in the default (diet) briefing output. */
const MAX_PEER_LEARNINGS_DIET = 3;
/** Maximum decisions entries in the default (diet) briefing output. */
const MAX_DECISIONS_DIET = 3;
/** Maximum blockedTasks entries in the default (diet) briefing output. */
const MAX_BLOCKED_TASKS_DIET = 3;
/** Maximum activeEpics entries in the default (diet) briefing output. */
const MAX_ACTIVE_EPICS_DIET = 3;
/**
 * Maximum urgentTasks entries in the default (diet) briefing output (T9905).
 *
 * Five matches the relatedDocs cap — enough to surface the top urgent slice
 * without exploding the briefing token budget. Operators who need the full
 * urgent backlog should run `cleo find --urgent`.
 */
const MAX_URGENT_TASKS_DIET = 5;
/** Maximum title length (chars) for blockedTasks/activeEpics entries in diet mode. */
const MAX_TITLE_LEN_DIET = 60;
/** Maximum memoryContext title length (chars) in diet mode. */
const MAX_MEMORY_TITLE_LEN_DIET = 80;

/**
 * Strip empty arrays from a handoff data object.
 *
 * Empty `tasksCompleted`, `tasksCreated`, `nextSuggested`, `openBlockers`,
 * and `openBugs` arrays add JSON weight without actionable content for a new
 * orchestrator session. This function removes only the zero-length arrays;
 * non-empty ones are preserved as-is.
 *
 * @param handoff - Raw handoff data from the last session.
 * @returns Handoff with empty array fields omitted.
 *
 * @task T9964
 */
function cleanHandoff(handoff: HandoffData): HandoffData {
  // Build a mutable copy. We cast to a plain record to permit `delete` on
  // optional array fields — `HandoffData` keys are all declared non-optional
  // but the runtime intent is to drop zero-length arrays before serialisation.
  const cleaned = { ...handoff } as unknown as Record<string, unknown>;
  const arrayKeys: ReadonlyArray<keyof HandoffData> = [
    'tasksCompleted',
    'tasksCreated',
    'nextSuggested',
    'openBlockers',
    'openBugs',
  ];
  for (const key of arrayKeys) {
    const val = cleaned[key];
    if (Array.isArray(val) && val.length === 0) {
      delete cleaned[key];
    }
  }
  return cleaned as unknown as HandoffData;
}

/**
 * Post-process a `RetrievalBundle` to suppress noisy fields in default mode.
 *
 * Rules applied (T9974 / T9964):
 * - `warm.peerPatterns`: stripped unless `debug` is true
 * - `cold.userProfile`: stripped unless `withProfile` is true
 * - `warm.peerLearnings`: stripped to `{id, insight_title, createdAt, _next}`
 *   unless `memoryDetail` is true. Capped at {@link MAX_PEER_LEARNINGS_DIET}.
 *   The `insight` body field is renamed to `insight_title` and is a truncated
 *   preview (first 80 chars) for orientation. Full text via `--memory-detail`.
 * - `warm.decisions`: stripped to `{id, decision_title, createdAt, _next}`
 *   unless `memoryDetail` is true. Capped at {@link MAX_DECISIONS_DIET}.
 * - `hot.sessionNarrative`: the key is retained in the type but callers
 *   building the final envelope should omit it when empty.
 * - Token counts are recomputed from the diet output so consumers see the
 *   actual post-diet token estimate.
 *
 * This keeps `buildRetrievalBundle` unchanged (backward-compat) and applies
 * the diet at the briefing layer only.
 *
 * @param bundle - Raw bundle from `buildRetrievalBundle`.
 * @param opts   - Diet options.
 * @returns A new bundle with noise fields suppressed.
 *
 * @task T9974
 * @task T9964
 */
function applyBriefingDiet(
  bundle: RetrievalBundle,
  opts: { debug: boolean; withProfile: boolean; memoryDetail: boolean },
): RetrievalBundle {
  // peerLearnings: in diet mode emit {id, insight (80-char preview), createdAt}
  // with a _next hint for fetching full text. Full insight is preserved when memoryDetail=true.
  // RetrievalLearning does not declare _next — cast to include the extension field.
  type DietLearning = import('@cleocode/contracts').RetrievalLearning & {
    _next?: Record<string, string>;
  };
  const peerLearnings: DietLearning[] = opts.memoryDetail
    ? bundle.warm.peerLearnings
    : bundle.warm.peerLearnings.slice(0, MAX_PEER_LEARNINGS_DIET).map(
        (l): DietLearning => ({
          id: l.id,
          insight: truncateString(l.insight, MAX_MEMORY_TITLE_LEN_DIET),
          createdAt: l.createdAt,
          ...(l.provenanceClass !== undefined ? { provenanceClass: l.provenanceClass } : {}),
          _next: { fetch: `cleo memory fetch ${l.id}` },
        }),
      );

  // decisions: in diet mode emit {id, decision (80-char preview), createdAt}
  // with a _next hint for fetching full text. Full body preserved when memoryDetail=true.
  // RetrievalDecision does not declare _next — cast to include the extension field.
  type DietDecision = import('@cleocode/contracts').RetrievalDecision & {
    _next?: Record<string, string>;
  };
  const decisions: DietDecision[] = opts.memoryDetail
    ? bundle.warm.decisions
    : bundle.warm.decisions.slice(0, MAX_DECISIONS_DIET).map(
        (d): DietDecision => ({
          id: d.id,
          decision: truncateString(d.decision, MAX_MEMORY_TITLE_LEN_DIET),
          createdAt: d.createdAt,
          ...(d.provenanceClass !== undefined ? { provenanceClass: d.provenanceClass } : {}),
          _next: { fetch: `cleo memory fetch ${d.id}` },
        }),
      );

  // RetrievalBundle.warm expects the base types; DietLearning/DietDecision are
  // structural supertypes so the cast is safe — the extra `_next` field is
  // present at runtime and surfaced in JSON serialisation.
  const dietBundle: RetrievalBundle = {
    cold: {
      userProfile: opts.withProfile ? bundle.cold.userProfile : [],
      peerInstructions: bundle.cold.peerInstructions,
      sigilCard: bundle.cold.sigilCard,
    },
    warm: {
      peerLearnings: peerLearnings as import('@cleocode/contracts').RetrievalLearning[],
      peerPatterns: opts.debug ? bundle.warm.peerPatterns : [],
      decisions: decisions as import('@cleocode/contracts').RetrievalDecision[],
    },
    hot: {
      // Drop sessionNarrative entirely when it is an empty string — keeps the
      // serialised envelope clean (avoids `"sessionNarrative": ""`).
      sessionNarrative: bundle.hot.sessionNarrative,
      recentObservations: bundle.hot.recentObservations,
      activeTasks: bundle.hot.activeTasks,
    },
    tokenCounts: bundle.tokenCounts,
  };

  // Recompute token estimates after diet so consumers see post-diet cost.
  // Simple heuristic: 1 token ≈ 4 chars (conservative, consistent with
  // the estimateTokens() function in brain-retrieval.ts).
  const estimate = (s: string): number => Math.ceil(s.length / 4);
  let warmTokens = 0;
  for (const l of dietBundle.warm.peerLearnings) warmTokens += estimate(l.insight);
  for (const p of dietBundle.warm.peerPatterns) warmTokens += estimate(p.pattern);
  for (const d of dietBundle.warm.decisions) warmTokens += estimate(d.decision);
  let coldTokens = 0;
  for (const t of dietBundle.cold.userProfile)
    coldTokens += estimate(`${t.traitKey}:${t.traitValue}`);
  coldTokens += estimate(dietBundle.cold.peerInstructions);
  let hotTokens = estimate(dietBundle.hot.sessionNarrative);
  for (const o of dietBundle.hot.recentObservations) hotTokens += estimate(o.narrative || o.title);
  for (const t of dietBundle.hot.activeTasks) hotTokens += estimate(`${t.id} ${t.title}`);

  dietBundle.tokenCounts = {
    cold: coldTokens,
    warm: warmTokens,
    hot: hotTokens,
    total: coldTokens + warmTokens + hotTokens,
  };

  return dietBundle;
}

/**
 * Apply the diet filter to `BriefingDocsContext`:
 * - drop `relatedDocs` entries that have no `slug` (cannot be fetched by name)
 * - cap `relatedDocs` at {@link MAX_RELATED_DOCS_DIET}
 * - filter out `relatedDocs` entries older than {@link RELATED_DOCS_RECENCY_MS}
 *   when a scope is active (no-scope = no recency filter, avoids over-trimming
 *   global breadth views)
 *
 * `currentTaskDocs` are left untouched — they are always relevant.
 *
 * @param ctx   - Raw docs context from `computeDocsContext`.
 * @param scope - Optional scope string from briefing params.
 * @returns Filtered docs context.
 *
 * @task T9974
 * @task T9964
 */
function applyDocsFilter(ctx: BriefingDocsContext, scope: string | undefined): BriefingDocsContext {
  const now = Date.now();
  const applyRecency = scope !== undefined && scope !== 'global';

  // T9964: drop entries without a slug — useless to a fresh agent that cannot
  // fetch the doc by name (only attachmentId would remain, which is opaque).
  let filtered = ctx.relatedDocs.filter((doc) => Boolean(doc.slug));

  if (applyRecency) {
    filtered = filtered.filter((doc) => {
      const ageMs = now - new Date(doc.createdAt).getTime();
      return ageMs <= RELATED_DOCS_RECENCY_MS;
    });
  }

  // Always cap to MAX_RELATED_DOCS_DIET regardless of recency filter
  filtered = filtered.slice(0, MAX_RELATED_DOCS_DIET);

  const totalDocs = ctx.currentTaskDocs.length + filtered.length;

  return {
    currentTaskDocs: ctx.currentTaskDocs,
    relatedDocs: filtered,
    totalDocs,
  };
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
 * When a `scopeFilter` is provided, `relatedDocs` are ranked so that
 * docs owned by tasks that fall within the scope appear before unrelated
 * docs (T9967). Within each group the ordering is `createdAt DESC` so the
 * most-recent scope-relevant doc wins when the 5-entry cap is applied by
 * {@link applyDocsFilter}.
 *
 * All queries are best-effort: individual task failures are swallowed so
 * that a corrupt attachment ref never blocks the briefing.
 *
 * @param projectRoot   - Absolute path to the project root.
 * @param currentTaskId - ID of the currently focused task (may be undefined).
 * @param tasks         - All tasks loaded by computeBriefing.
 * @param scopeTaskIds  - Optional set of in-scope task IDs (undefined = all).
 * @param scopeFilter   - Optional scope filter used to rank relatedDocs (T9967).
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
  scopeFilter?: { type: 'global' | 'epic'; epicId?: string },
): Promise<BriefingDocsContext | undefined> {
  // Dynamically import the attachment store to avoid mandatory hard deps.
  const { createAttachmentStore } = await import('../store/attachment-store.js');
  const store = createAttachmentStore();

  /**
   * Convert one AttachmentMetadata record into a BriefingDocRef.
   *
   * T9964: Also fetches slug + type from the extras column so consumers can
   * identify documents by name (not just opaque attachmentId). Entries without
   * a slug are returned with slug=undefined so callers can drop them when the
   * identifier is required for a `cleo docs fetch` operation.
   */
  async function toDocRef(taskId: string, meta: AttachmentMetadata): Promise<BriefingDocRef> {
    const att = meta.attachment;
    const base: BriefingDocRef = {
      taskId,
      attachmentId: meta.id,
      kind: att.kind,
      ...(att.description ? { description: att.description } : {}),
      ...(att.labels?.length ? { labels: att.labels } : {}),
      createdAt: meta.createdAt,
    };
    // Best-effort: fetch slug + type extras; failure is non-fatal.
    try {
      const extras = await store.getExtras(meta.id, projectRoot);
      if (extras?.slug) base.slug = extras.slug;
      if (extras?.type) base.type = extras.type;
    } catch {
      // extras unavailable — proceed without slug/type
    }
    return base;
  }

  // 1. Fetch attachments for the currently focused task.
  const currentTaskDocs: BriefingDocRef[] = [];
  if (currentTaskId) {
    try {
      const metas = await store.listByOwner('task', currentTaskId, projectRoot);
      for (const meta of metas.slice(0, MAX_DOCS_PER_TASK)) {
        currentTaskDocs.push(await toDocRef(currentTaskId, meta));
      }
    } catch {
      // Attachment store unavailable for this task — proceed without
    }
  }

  // 2. Fetch attachments for in-scope tasks (excluding the current task).
  // Guard: only populate relatedDocs when there is a focused task — without a
  // currentTaskId the filter `task.id !== currentTaskId` is trivially satisfied
  // for every task, causing all attachments in the project to be shipped.
  const relatedDocs: BriefingDocRef[] = [];

  if (currentTaskId === undefined) {
    return currentTaskDocs.length > 0
      ? { currentTaskDocs, relatedDocs, totalDocs: currentTaskDocs.length }
      : undefined;
  }

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
        relatedDocs.push(await toDocRef(task.id, meta));
      }
    } catch {
      // Attachment store unavailable for this task — proceed without
    }
  }

  // ── T9967: Rank relatedDocs so scope-relevant docs surface first ────────────
  // When a scope is active (auto-detected or explicit), docs owned by tasks in
  // that scope are ranked above unrelated docs. Within each group, entries are
  // ordered by createdAt DESC so the most-recent doc wins when applyDocsFilter
  // applies the 5-entry cap.
  //
  // This ranking happens before the cap so that scope-relevant docs are not
  // accidentally pushed out by older unrelated docs that happen to sort earlier
  // in the task iteration order.
  if (scopeFilter?.type === 'epic' && scopeFilter.epicId) {
    // Build a ranking scope that includes the epic root and all its descendants.
    // When scopeTaskIds is already set it covers exactly this set — reuse it.
    // When scopeTaskIds is undefined (global mode but auto-detected epic scope),
    // build the ranking set on the fly without modifying the filter.
    const rankingScope: Set<string> =
      scopeTaskIds ??
      (() => {
        const ids = new Set<string>();
        const addDescendants = (tid: string): void => {
          ids.add(tid);
          for (const t of tasks) {
            const task = t as { id?: string; parentId?: string };
            if (task.parentId === tid && task.id) {
              addDescendants(task.id);
            }
          }
        };
        addDescendants(scopeFilter.epicId!);
        return ids;
      })();

    relatedDocs.sort((a, b) => {
      const aInScope = rankingScope.has(a.taskId) ? 0 : 1;
      const bInScope = rankingScope.has(b.taskId) ? 0 : 1;
      if (aInScope !== bInScope) return aInScope - bInScope;
      // Within the same group, sort by createdAt DESC (most recent first).
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }

  const totalDocs = currentTaskDocs.length + relatedDocs.length;

  // Return undefined when no docs exist — avoids polluting the briefing with an
  // empty docs pillar when the attachment store is empty.
  if (totalDocs === 0) return undefined;

  return { currentTaskDocs, relatedDocs, totalDocs };
}

// ---------------------------------------------------------------------------
// BriefingFieldContract assertion (T1905 / BBTT-W1-3)
// ---------------------------------------------------------------------------

/**
 * Evaluate a {@link BriefingFieldContract} against a computed briefing and
 * return an array of {@link ContractViolation} entries.
 *
 * Each named rule in `contract` is checked against the corresponding section
 * of `briefing`. Violations are emitted for:
 * - `stale` — any item whose `capturedAt` / `createdAt` timestamp is older
 *   than `rule.maxAgeDays`.
 * - `duplicate` — two or more items share the same value for `rule.dedupBy`.
 * - `excluded-provenance` — any item whose `provenance` property matches a
 *   tag in `rule.excludeProvenance`.
 *
 * Returns an empty array when the briefing satisfies all rules.
 *
 * @param briefing  - The output of {@link computeBriefing}.
 * @param contract  - Field-level constraint rules.
 * @returns Array of violations (empty = compliant).
 *
 * @task T1905
 */
export function assertBriefingContract(
  briefing: SessionBriefing,
  contract: BriefingFieldContract,
): ContractViolation[] {
  const violations: ContractViolation[] = [];
  const nowMs = Date.now();

  for (const [field, rule] of Object.entries(contract)) {
    if (!rule) continue;

    // Resolve the field value from the briefing (supports nested paths via dot notation)
    const items = resolveBriefingField(briefing, field);
    if (!Array.isArray(items)) continue;

    // 1. Staleness check
    if (rule.maxAgeDays !== undefined) {
      const maxAgeMs = rule.maxAgeDays * 24 * 60 * 60 * 1000;
      for (const item of items) {
        const ts =
          (item as Record<string, unknown>)['capturedAt'] ??
          (item as Record<string, unknown>)['createdAt'];
        if (typeof ts === 'string') {
          const ageMs = nowMs - new Date(ts).getTime();
          if (ageMs > maxAgeMs) {
            violations.push({
              field,
              message: `${field} contains item older than ${rule.maxAgeDays}d (age: ${Math.round(ageMs / 86_400_000)}d)`,
              kind: 'stale',
              severity: 'P1',
            });
            break; // one violation per field
          }
        }
      }
    }

    // 2. Duplicate check
    if (rule.dedupBy) {
      const seen = new Set<unknown>();
      for (const item of items) {
        const key = (item as Record<string, unknown>)[rule.dedupBy];
        if (key !== undefined) {
          if (seen.has(key)) {
            violations.push({
              field,
              message: `${field} contains duplicate items with ${rule.dedupBy}=${String(key)}`,
              kind: 'duplicate',
              severity: 'P1',
            });
            break;
          }
          seen.add(key);
        }
      }
    }

    // 3. Excluded-provenance check
    if (rule.excludeProvenance && rule.excludeProvenance.length > 0) {
      const banned = new Set(rule.excludeProvenance);
      for (const item of items) {
        const prov = (item as Record<string, unknown>)['provenance'];
        if (typeof prov === 'string' && banned.has(prov as never)) {
          violations.push({
            field,
            message: `${field} contains item with excluded provenance "${prov}"`,
            kind: 'excluded-provenance',
            severity: 'P0',
          });
          break;
        }
      }
    }
  }

  return violations;
}

/**
 * Resolve a briefing field by name (dot-notation supported).
 * Returns the value or undefined when not found.
 */
function resolveBriefingField(briefing: SessionBriefing, field: string): unknown {
  const parts = field.split('.');
  let cur: unknown = briefing;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
