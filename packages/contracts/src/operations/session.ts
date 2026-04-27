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

import type { Session } from '../session.js';

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
 * Result of `session.show`.
 *
 * @remarks
 * `unknown` because `show` with `include='debrief'` returns opaque debrief
 * data (DebriefData | fallback object) rather than a Session record.
 */
export type SessionShowResult = unknown;

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
/**
 * Result of `session.briefing.show` — composite session-start context.
 * The full shape is defined in `@cleocode/core/internal.SessionBriefing`.
 */
export type SessionBriefingShowResult = unknown;

// session.history (query — not in primary handler but exported for completeness)
/** Parameters for `session.history`. */
export interface SessionHistoryParams {
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
/** Result of `session.start` — the newly created session. */
export type SessionStartResult = Session;

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
