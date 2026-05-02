/**
 * Session Domain Operations (15 operations)
 *
 * Query operations: 8 (status, list, show, find, decision.log, context.drift, handoff.show, briefing.show)
 * Mutate operations: 7 (start, end, resume, suspend, gc, record.decision, record.assumption)
 *
 * SYNC: Canonical domain types live in packages/contracts/src/session.ts.
 * These operation types are the API contract (wire format) for the dispatch layer.
 *
 * @task T975 — typed-dispatch migration (Wave D · T962)
 */

import type { Session, SessionStartResult } from '../session.js';
import type { MemoryCompactHit, RetrievalBundle } from './memory.js';

// ---------------------------------------------------------------------------
// Common session types (simplified wire-format representation)
// ---------------------------------------------------------------------------

/**
 * Minimal session representation for wire-format responses.
 * Used in results that return simplified session data.
 */
export interface SessionOp {
  id: string;
  name: string;
  scope: string;
  started: string;
  ended?: string;
  startedTask?: string;
  status: 'active' | 'suspended' | 'ended';
  notes?: string[];
}

// ---------------------------------------------------------------------------
// Query Operations
// ---------------------------------------------------------------------------

// session.status
/** Parameters for `session.status` — no params required. */
export type SessionStatusParams = Record<string, never>;

/**
 * Result of `session.status`.
 *
 * @remarks
 * Re-synced to match the envelope returned by `sessionStatus` in
 * `packages/cleo/src/dispatch/engines/session-engine.ts`.
 *
 * @task T963 — contract↔impl drift reconciliation (T910 audit)
 */
export interface SessionStatusResult {
  /** True when a session is currently active. */
  hasActiveSession: boolean;
  /** Active session record or `null` when none active. */
  session?: Session | null;
  /** Current task work state from `meta.focus_state`. */
  taskWork?: import('../task.js').TaskWorkState | null;
}

// session.list
/** Parameters for `session.list`. */
export interface SessionListParams {
  active?: boolean;
  status?: string;
  limit?: number;
  offset?: number;
}
/** Result of `session.list`. */
export interface SessionListResult {
  sessions: Session[];
  total: number;
  filtered: number;
}

// session.show
/** Parameters for `session.show`. */
export interface SessionShowParams {
  sessionId: string;
  /** When set to 'debrief', returns debrief data instead of the raw session. */
  include?: string;
}
/**
 * Wire-format debrief payload returned by `session.show` when
 * `include='debrief'` is specified (T5615 — debrief.show absorption).
 *
 * Mirrors the fields of `DebriefData` from
 * `packages/core/src/sessions/handoff.ts` that are exposed over the wire.
 * The nested `handoff` field is kept opaque (`Record<string, unknown>`) to
 * avoid pulling `HandoffData` internals into the contracts package.
 */
export interface SessionDebriefData {
  /** The session that produced this debrief. */
  sessionId: string;
  /** Agent / conversation identifier (if known). */
  agentIdentifier: string | null;
  /** Session start time (ISO 8601). */
  startedAt: string;
  /** Session end time (ISO 8601). */
  endedAt: string;
  /** Duration in minutes. */
  durationMinutes: number;
  /** Decisions captured during the session. */
  decisions: Array<{
    /** Decision statement. */
    decision: string;
    /** Rationale for the decision. */
    rationale: string;
    /** Alternatives considered. */
    alternatives?: string[];
    /** ISO 8601 timestamp. */
    timestamp: string;
  }>;
  /** Standard handoff payload (backward-compat opaque shape). */
  handoff: Record<string, unknown>;
  /** Git state at session end (best-effort; null when git unavailable). */
  gitState: Record<string, unknown> | null;
  /** Position of this session in the session chain (1-based). */
  chainPosition: number;
  /** Total length of the session chain. */
  chainLength: number;
}

/**
 * Result of `session.show`.
 *
 * @remarks
 * Returns the raw `Session` record for standard queries. When
 * `include='debrief'` is specified, returns a `SessionDebriefData` envelope
 * instead (T5615 — `debrief.show` was absorbed into `session.show`).
 *
 * @see SessionDebriefData
 */
export type SessionShowResult = Session | SessionDebriefData;

// session.find
/** Parameters for `session.find` — lightweight session discovery. */
export interface SessionFindParams {
  status?: string;
  scope?: string;
  query?: string;
  limit?: number;
}
/** Result of `session.find` — minimal session records. */
export interface SessionFindResult {
  sessions: Array<{
    id: string;
    name: string;
    status: string;
    startedAt: string;
    scope: unknown;
  }>;
}

// session.decision.log
/** Parameters for `session.decision.log`. */
export interface SessionDecisionLogParams {
  sessionId?: string;
  taskId?: string;
}
/** A single decision record in the audit trail. */
export interface DecisionRecord {
  id: string;
  sessionId: string;
  taskId: string;
  decision: string;
  rationale: string;
  alternatives?: string[];
  timestamp: string;
}
/** Result of `session.decision.log`. */
export type SessionDecisionLogResult = DecisionRecord[];

// session.context.drift
/** Parameters for `session.context.drift`. */
export interface SessionContextDriftParams {
  sessionId?: string;
}
/** Result of `session.context.drift`. */
export interface SessionContextDriftResult {
  score: number;
  factors: string[];
  completedInScope: number;
  totalInScope: number;
  outOfScope: number;
}

// session.handoff.show
/** Parameters for `session.handoff.show`. */
export interface SessionHandoffShowParams {
  /**
   * Scope filter string. Use 'global' for global scope or 'epic:<id>' for
   * epic-scoped handoff data.
   */
  scope?: string;
}
/** Result of `session.handoff.show`. */
export interface SessionHandoffShowResult {
  sessionId: string;
  handoff: unknown;
}

// session.briefing.show
/** Parameters for `session.briefing.show`. */
export interface SessionBriefingShowParams {
  maxNextTasks?: number;
  maxBugs?: number;
  maxBlocked?: number;
  maxEpics?: number;
  scope?: string;
}

/** Compact task entry in a session briefing's next-tasks list. */
export interface SessionBriefingTask {
  /** Task identifier. */
  id: string;
  /** Task title. */
  title: string;
  /** Leverage-derived priority score (higher = higher priority). */
  leverage: number;
  /** Composite relevance score used for ordering. */
  score: number;
}

/** Compact bug entry in a session briefing. */
export interface SessionBriefingBug {
  /** Task identifier. */
  id: string;
  /** Bug title. */
  title: string;
  /** Priority level. */
  priority: string;
}

/** Compact blocked-task entry in a session briefing. */
export interface SessionBriefingBlockedTask {
  /** Task identifier. */
  id: string;
  /** Task title. */
  title: string;
  /** IDs of tasks blocking this one. */
  blockedBy: string[];
}

/** Compact active-epic entry in a session briefing. */
export interface SessionBriefingEpic {
  /** Epic task identifier. */
  id: string;
  /** Epic title. */
  title: string;
  /** Completion percentage [0–100]. */
  completionPercent: number;
}

/** Pipeline stage snapshot surfaced in a session briefing. */
export interface SessionBriefingPipelineStage {
  /** Current pipeline stage name (e.g. `'implementation'`). */
  currentStage: string;
  /** Stage lifecycle status. */
  stageStatus: string;
}

/** A single document reference included in the briefing docs-context pillar. */
export interface SessionBriefingDocRef {
  /** Task that owns this attachment. */
  taskId: string;
  /** Attachment identifier. */
  attachmentId: string;
  /** Attachment kind (local-file, url, blob, llms-txt, llmtxt-doc). */
  kind: string;
  /** Optional human-readable description. */
  description?: string;
  /** Optional categorisation labels. */
  labels?: string[];
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

/** Docs-context pillar of the session briefing (T1616). */
export interface SessionBriefingDocsContext {
  /** Document references for the currently focused task. */
  currentTaskDocs: SessionBriefingDocRef[];
  /** Document references for other in-scope tasks. */
  relatedDocs: SessionBriefingDocRef[];
  /** Total document references surfaced. */
  totalDocs: number;
}

/** Brain memory context included in the session briefing when available. */
export interface SessionBriefingMemoryContext {
  /** Recent decisions relevant to the current scope. */
  recentDecisions: MemoryCompactHit[];
  /** Patterns relevant to the current scope. */
  relevantPatterns: MemoryCompactHit[];
  /** Recent observations from prior sessions. */
  recentObservations: MemoryCompactHit[];
  /** Recent learnings relevant to the current scope. */
  recentLearnings: MemoryCompactHit[];
  /** Estimated token weight of this context block. */
  tokensEstimated: number;
}

/** Info about the last ended session, for session-start continuity. */
export interface SessionBriefingLastSession {
  /** ISO 8601 end timestamp. */
  endedAt: string;
  /** Duration in minutes. */
  duration: number;
  /** Handoff data (opaque shape from `HandoffData`). */
  handoff: Record<string, unknown>;
}

/** Info about the currently active task in the briefing. */
export interface SessionBriefingCurrentTask {
  /** Task identifier. */
  id: string;
  /** Task title. */
  title: string;
  /** Current lifecycle status. */
  status: string;
  /** IDs of tasks blocking this one, if any. */
  blockedBy?: string[];
}

/**
 * Result of `session.briefing.show`.
 *
 * @remarks
 * Mirrors `SessionBriefing` from
 * `packages/core/src/sessions/briefing.ts`. Three pillars:
 * - state: `currentTask` + `nextTasks` + `blockedTasks` + `activeEpics` + `openBugs`
 * - rationale: `memoryContext` + `bundle` (PSYCHE Wave 4 retrieval)
 * - references: `docsContext` (T1616)
 *
 * All optional fields (`pipelineStage`, `warnings`, `memoryContext`, `bundle`,
 * `docsContext`) are omitted when the data source is unavailable or empty.
 *
 * @task T1091 — PSYCHE Wave 4 `bundle`
 * @task T1616 — docs context pillar
 */
export interface SessionBriefingShowResult {
  /** Last ended session info, or null when no previous session exists. */
  lastSession: SessionBriefingLastSession | null;
  /** Currently active task, or null when no task is focused. */
  currentTask: SessionBriefingCurrentTask | null;
  /** Ordered list of next tasks to work on (leverage-sorted). */
  nextTasks: SessionBriefingTask[];
  /** Open bugs relevant to the current scope. */
  openBugs: SessionBriefingBug[];
  /** Tasks currently blocked (up to `maxBlocked`). */
  blockedTasks: SessionBriefingBlockedTask[];
  /** Active epics with completion rollup. */
  activeEpics: SessionBriefingEpic[];
  /** Current pipeline stage snapshot (omitted when no lifecycle active). */
  pipelineStage?: SessionBriefingPipelineStage;
  /** Non-fatal warnings emitted during briefing computation. */
  warnings?: string[];
  /** Brain memory context (omitted when memory store unavailable). */
  memoryContext?: SessionBriefingMemoryContext;
  /**
   * PSYCHE Wave 4 multi-pass retrieval bundle.
   *
   * Contains cold (user-profile + peer instructions), warm (peer-scoped
   * memory), and hot (live session state) passes. Present when the active
   * session and peer ID are resolvable; omitted otherwise.
   *
   * @task T1091
   */
  bundle?: RetrievalBundle;
  /**
   * Docs-context pillar — task-attached document references (T1616).
   *
   * Present when at least one in-scope task has attachments; omitted
   * when the attachment store is unavailable or no attachments exist.
   */
  docsContext?: SessionBriefingDocsContext;
}

// session.history (query — not in primary handler but exported for completeness)
/** Parameters for `session.history`. */
export interface SessionHistoryParams {
  /** Specific session id to filter to. */
  sessionId?: string;
  /** Maximum number of sessions to return. */
  limit?: number;
}
/** A single session history entry. */
export interface SessionHistoryEntry {
  sessionId: string;
  name: string;
  started: string;
  ended: string;
  tasksCompleted: number;
  duration: string;
}
/** Result of `session.history`. */
export type SessionHistoryResult = SessionHistoryEntry[];

// ---------------------------------------------------------------------------
// Mutate Operations
// ---------------------------------------------------------------------------

// session.start
/** Parameters for `session.start`. */
export interface SessionStartParams {
  scope: string;
  name?: string;
  autoStart?: boolean;
  startTask?: string;
  /** Enable full query+mutation audit logging for behavioral grading. */
  grade?: boolean;
  /**
   * HMAC-SHA256 owner-auth token for L4a override authentication (T1118).
   *
   * Derived from HMAC-SHA256(key=password, data=sessionId) during
   * `cleo session start --owner-auth`. Stored in sessions.owner_auth_token
   * and validated on every `CLEO_OWNER_OVERRIDE` call.
   */
  ownerAuthToken?: string;
}
// session.end
/** Parameters for `session.end`. */
export interface SessionEndParams {
  note?: string;
  nextAction?: string;
  /**
   * Structured session summary for direct ingestion into brain.db.
   * When provided, CLEO persists key learnings, decisions, patterns, and next actions.
   * @task T140 @epic T134
   */
  sessionSummary?: import('../config.js').SessionSummaryInput;
}
/** Result of `session.end`. */
export interface SessionEndResult {
  sessionId: string;
  ended: boolean;
  /**
   * A summarization prompt built from this session's debrief data.
   * Populated when `brain.summarization.enabled` is true.
   * @task T140 @epic T134
   */
  memoryPrompt?: string;
}

// session.resume
/** Parameters for `session.resume`. */
export interface SessionResumeParams {
  sessionId: string;
}
/** Result of `session.resume` — the resumed session. */
export type SessionResumeResult = Session;

// session.suspend
/** Parameters for `session.suspend`. */
export interface SessionSuspendParams {
  sessionId: string;
  reason?: string;
}
/** Result of `session.suspend` — the suspended session. */
export type SessionSuspendResult = Session;

// session.gc
/** Parameters for `session.gc`. */
export interface SessionGcParams {
  maxAgeDays?: number;
}
/** Result of `session.gc`. */
export interface SessionGcResult {
  orphaned: string[];
  removed: string[];
}

// session.record.decision
/** Parameters for `session.record.decision`. */
export interface SessionRecordDecisionParams {
  sessionId?: string;
  taskId: string;
  decision: string;
  rationale: string;
  alternatives?: string[];
}
/** Result of `session.record.decision`. */
export type SessionRecordDecisionResult = DecisionRecord;

// session.record.assumption
/** Parameters for `session.record.assumption`. */
export interface SessionRecordAssumptionParams {
  sessionId?: string;
  taskId?: string;
  assumption: string;
  confidence: 'high' | 'medium' | 'low';
}
/** Result of `session.record.assumption`. */
export interface SessionRecordAssumptionResult {
  id: string;
  sessionId: string;
  taskId: string | null;
  assumption: string;
  confidence: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Typed operation record (Wave D adapter — T975)
// ---------------------------------------------------------------------------

/**
 * Typed operation record for the session domain.
 *
 * Maps each operation name (as dispatched by the registry — no domain prefix)
 * to its `[Params, Result]` tuple. Used by `TypedDomainHandler<SessionOps>`
 * in the dispatch layer to provide compile-time narrowing of params.
 *
 * @task T975 — Wave D typed-dispatch migration
 */
export type SessionOps = {
  readonly status: readonly [SessionStatusParams, SessionStatusResult];
  readonly list: readonly [SessionListParams, SessionListResult];
  readonly show: readonly [SessionShowParams, SessionShowResult];
  readonly find: readonly [SessionFindParams, SessionFindResult];
  readonly 'decision.log': readonly [SessionDecisionLogParams, SessionDecisionLogResult];
  readonly 'context.drift': readonly [SessionContextDriftParams, SessionContextDriftResult];
  readonly 'handoff.show': readonly [SessionHandoffShowParams, SessionHandoffShowResult | null];
  readonly 'briefing.show': readonly [SessionBriefingShowParams, SessionBriefingShowResult];
  readonly start: readonly [SessionStartParams, SessionStartResult];
  readonly end: readonly [SessionEndParams, SessionEndResult];
  readonly resume: readonly [SessionResumeParams, SessionResumeResult];
  readonly suspend: readonly [SessionSuspendParams, SessionSuspendResult];
  readonly gc: readonly [SessionGcParams, SessionGcResult];
  readonly 'record.decision': readonly [SessionRecordDecisionParams, SessionRecordDecisionResult];
  readonly 'record.assumption': readonly [
    SessionRecordAssumptionParams,
    SessionRecordAssumptionResult,
  ];
};
