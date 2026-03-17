/**
 * Unified Status Registry — single source of truth for all status enums.
 *
 * ADR-018: All status constants and types MUST be defined here.
 * No other file may define status enum arrays as constants.
 *
 * Dependency direction:
 *   status-registry.ts → schema.ts, types/task.ts, validation/engine.ts,
 *                         mcp/lib/security.ts, dispatch/lib/security.ts, ...
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
];
export const SESSION_STATUSES = ['active', 'ended', 'orphaned', 'suspended'];
export const LIFECYCLE_PIPELINE_STATUSES = [
    'active',
    'completed',
    'blocked',
    'failed',
    'cancelled',
    'aborted',
];
export const LIFECYCLE_STAGE_STATUSES = [
    'not_started',
    'in_progress',
    'blocked',
    'completed',
    'skipped',
    'failed',
];
// === GOVERNANCE NAMESPACE ===
// Statuses for decisions and approvals.
export const ADR_STATUSES = ['proposed', 'accepted', 'superseded', 'deprecated'];
export const GATE_STATUSES = ['pending', 'passed', 'failed', 'waived'];
// === MANIFEST NAMESPACE ===
// Statuses for protocol output artifacts.
// NOTE: 'complete' was the old value — it is now 'completed' everywhere.
export const MANIFEST_STATUSES = ['completed', 'partial', 'blocked', 'archived'];
// === TERMINAL STATE SETS ===
export const TERMINAL_TASK_STATUSES = new Set([
    'done',
    'cancelled',
    'archived',
]);
export const TERMINAL_PIPELINE_STATUSES = new Set([
    'completed',
    'failed',
    'cancelled',
    'aborted',
]);
export const TERMINAL_STAGE_STATUSES = new Set([
    'completed',
    'skipped',
    'failed',
]);
export const STATUS_REGISTRY = {
    task: TASK_STATUSES,
    session: SESSION_STATUSES,
    lifecycle_pipeline: LIFECYCLE_PIPELINE_STATUSES,
    lifecycle_stage: LIFECYCLE_STAGE_STATUSES,
    adr: ADR_STATUSES,
    gate: GATE_STATUSES,
    manifest: MANIFEST_STATUSES,
};
export function isValidStatus(entityType, value) {
    return STATUS_REGISTRY[entityType].includes(value);
}
// === DISPLAY ICONS ===
// Typed Record maps — exhaustiveness is enforced by the compiler.
// All icon consumers MUST import from here instead of hardcoding comparisons.
/**
 * Pipeline status → Unicode progress icon.
 * Used wherever lifecycle pipeline status is rendered to a terminal.
 */
export const PIPELINE_STATUS_ICONS = {
    active: '▶', // pipeline is running
    completed: '✓', // all stages done successfully
    blocked: '⏸', // cannot advance; waiting
    failed: '✗', // terminal failure
    cancelled: '⊘', // user-initiated abandonment
    aborted: '⏹', // system-forced termination
};
/**
 * Stage status → Unicode progress icon.
 * Used wherever pipeline stage status is rendered to a terminal.
 */
export const STAGE_STATUS_ICONS = {
    not_started: '⏹', // not yet entered
    in_progress: '▶', // actively running
    blocked: '⏸', // paused / waiting
    completed: '✓', // finished successfully
    skipped: '⏭', // intentionally bypassed
    failed: '✗', // terminal failure
};
/**
 * Task status → Unicode symbol (rich terminal / Unicode-enabled).
 * Falls back to TASK_STATUS_SYMBOLS_ASCII when Unicode is unavailable.
 */
export const TASK_STATUS_SYMBOLS_UNICODE = {
    pending: '○', // ○  not yet started
    active: '◉', // ◉  in progress
    blocked: '⊗', // ⊗  cannot advance
    done: '✓', // ✓  complete
    cancelled: '✗', // ✗  abandoned
    archived: '▣', // ▣  stored, inactive
};
/**
 * Task status → ASCII fallback symbol (non-Unicode terminals, CI output).
 */
export const TASK_STATUS_SYMBOLS_ASCII = {
    pending: '-',
    active: '*',
    blocked: 'x',
    done: '+',
    cancelled: '~',
    archived: '#',
};
//# sourceMappingURL=status-registry.js.map