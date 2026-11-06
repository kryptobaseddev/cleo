/**
 * Unified Status Registry — single source of truth for all status enums.
 *
 * ADR-018: All status constants and types MUST be defined here.
 * No other file may define status enum arrays as constants.
 *
 * Dependency direction:
 *   status-registry.ts → schema.ts, types/task.ts, validation/engine.ts,
 *                         dispatch/lib/security.ts, ...
 */

// === WORKFLOW NAMESPACE ===
// Statuses for entities representing work being performed.

export const TASK_STATUSES = [
  'pending',
  'active',
  'blocked',
  'done',
  'cancelled',
  'archived',
  'proposed',
] as const;

export const SESSION_STATUSES = ['active', 'ended', 'orphaned', 'suspended'] as const;

export const LIFECYCLE_PIPELINE_STATUSES = [
  'active',
  'completed',
  'blocked',
  'failed',
  'cancelled',
  'aborted',
] as const;

export const LIFECYCLE_STAGE_STATUSES = [
  'not_started',
  'in_progress',
  'blocked',
  'completed',
  'skipped',
  'failed',
] as const;

// === GOVERNANCE NAMESPACE ===
// Statuses for decisions and approvals.

export const ADR_STATUSES = ['proposed', 'accepted', 'superseded', 'deprecated'] as const;

export const GATE_STATUSES = ['pending', 'passed', 'failed', 'waived'] as const;

// === MANIFEST NAMESPACE ===
// Statuses for protocol output artifacts.
// NOTE: 'complete' was the old value — it is now 'completed' everywhere.

export const MANIFEST_STATUSES = ['completed', 'partial', 'blocked', 'archived'] as const;

// === DERIVED TYPES ===

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export type PipelineStatus = (typeof LIFECYCLE_PIPELINE_STATUSES)[number];
export type StageStatus = (typeof LIFECYCLE_STAGE_STATUSES)[number];
export type AdrStatus = (typeof ADR_STATUSES)[number];
export type GateStatus = (typeof GATE_STATUSES)[number];
export type ManifestStatus = (typeof MANIFEST_STATUSES)[number];

// === TERMINAL STATE SETS ===

export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'done',
  'cancelled',
  'archived',
]);

/** A child status that needs no more work: `done`, `cancelled` or `archived`. */
export type SettledTaskStatus = 'done' | 'cancelled' | 'archived';

/**
 * Whether a child task is settled: it needs no more work (`done`, `cancelled`
 * or `archived`, the {@link TERMINAL_TASK_STATUSES}). The one predicate every
 * parent-terminal path uses (T14266): cancel and its cascade, archive and
 * update to cancelled (via `countActiveChildren`, which filters on the same
 * set in SQL), complete's premature-close guard and rollups, and the `done`
 * epic plan. A settled `cancelled` child still needs a waiver before a parent
 * can roll up over it; settled only means no work remains.
 *
 * @param status - The child's status.
 * @returns True when the child needs no more work.
 */
export function isSettledChild(status: TaskStatus): status is SettledTaskStatus {
  return TERMINAL_TASK_STATUSES.has(status);
}

/**
 * Why a task was cancelled (T14267, owner decision D11229). `superseded` and
 * `duplicate` name a replacement (`replacedBy`); once it is done the cancelled
 * child counts as covered in a parent rollup with no waiver. `abandoned` and
 * `obsolete` work was not delivered, so a parent still needs the audited
 * `--waive-cancelled-children` waiver.
 */
export const CANCELLATION_KINDS = ['abandoned', 'superseded', 'duplicate', 'obsolete'] as const;

/** One of {@link CANCELLATION_KINDS}. */
export type CancellationKind = (typeof CANCELLATION_KINDS)[number];

/** The cancellation kinds a done replacement covers (T14267, D11229). */
export const REPLACED_CANCELLATION_KINDS: ReadonlySet<CancellationKind> = new Set([
  'superseded',
  'duplicate',
]);

export const TERMINAL_PIPELINE_STATUSES: ReadonlySet<PipelineStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'aborted',
]);

export const TERMINAL_STAGE_STATUSES: ReadonlySet<StageStatus> = new Set([
  'completed',
  'skipped',
  'failed',
]);

// === REGISTRY (for runtime queryability) ===

export type EntityType =
  | 'task'
  | 'session'
  | 'lifecycle_pipeline'
  | 'lifecycle_stage'
  | 'adr'
  | 'gate'
  | 'manifest';

export const STATUS_REGISTRY: Record<EntityType, readonly string[]> = {
  task: TASK_STATUSES,
  session: SESSION_STATUSES,
  lifecycle_pipeline: LIFECYCLE_PIPELINE_STATUSES,
  lifecycle_stage: LIFECYCLE_STAGE_STATUSES,
  adr: ADR_STATUSES,
  gate: GATE_STATUSES,
  manifest: MANIFEST_STATUSES,
} as const;

export function isValidStatus(entityType: EntityType, value: string): boolean {
  return (STATUS_REGISTRY[entityType] as readonly string[]).includes(value);
}

// === DISPLAY ICONS ===
// Typed Record maps — exhaustiveness is enforced by the compiler.
// All icon consumers MUST import from here instead of hardcoding comparisons.

/**
 * Pipeline status → Unicode progress icon.
 * Used wherever lifecycle pipeline status is rendered to a terminal.
 */
export const PIPELINE_STATUS_ICONS: Record<PipelineStatus, string> = {
  active: '\u25b6', // pipeline is running
  completed: '\u2713', // all stages done successfully
  blocked: '\u23f8', // cannot advance; waiting
  failed: '\u2717', // terminal failure
  cancelled: '\u2298', // user-initiated abandonment
  aborted: '\u23f9', // system-forced termination
};

/**
 * Stage status → Unicode progress icon.
 * Used wherever pipeline stage status is rendered to a terminal.
 */
export const STAGE_STATUS_ICONS: Record<StageStatus, string> = {
  not_started: '\u23f9', // not yet entered
  in_progress: '\u25b6', // actively running
  blocked: '\u23f8', // paused / waiting
  completed: '\u2713', // finished successfully
  skipped: '\u23ed', // intentionally bypassed
  failed: '\u2717', // terminal failure
};

/**
 * Task status → Unicode symbol (rich terminal / Unicode-enabled).
 * Falls back to TASK_STATUS_SYMBOLS_ASCII when Unicode is unavailable.
 */
export const TASK_STATUS_SYMBOLS_UNICODE: Record<TaskStatus, string> = {
  pending: '\u25cb', // ○  not yet started
  active: '\u25c9', // ◉  in progress
  blocked: '\u2297', // ⊗  cannot advance
  done: '\u2713', // ✓  complete
  cancelled: '\u2717', // ✗  abandoned
  archived: '\u25a3', // ▣  stored, inactive
  proposed: '\u25c7', // ◇  tier-2 proposal queue (T946)
};

/**
 * Task status → ASCII fallback symbol (non-Unicode terminals, CI output).
 */
export const TASK_STATUS_SYMBOLS_ASCII: Record<TaskStatus, string> = {
  pending: '-',
  active: '*',
  blocked: 'x',
  done: '+',
  cancelled: '~',
  archived: '#',
  proposed: '?',
};
