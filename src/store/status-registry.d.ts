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
export declare const TASK_STATUSES: readonly ["pending", "active", "blocked", "done", "cancelled", "archived"];
export declare const SESSION_STATUSES: readonly ["active", "ended", "orphaned", "suspended"];
export declare const LIFECYCLE_PIPELINE_STATUSES: readonly ["active", "completed", "blocked", "failed", "cancelled", "aborted"];
export declare const LIFECYCLE_STAGE_STATUSES: readonly ["not_started", "in_progress", "blocked", "completed", "skipped", "failed"];
export declare const ADR_STATUSES: readonly ["proposed", "accepted", "superseded", "deprecated"];
export declare const GATE_STATUSES: readonly ["pending", "passed", "failed", "waived"];
export declare const MANIFEST_STATUSES: readonly ["completed", "partial", "blocked", "archived"];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export type PipelineStatus = (typeof LIFECYCLE_PIPELINE_STATUSES)[number];
export type StageStatus = (typeof LIFECYCLE_STAGE_STATUSES)[number];
export type AdrStatus = (typeof ADR_STATUSES)[number];
export type GateStatus = (typeof GATE_STATUSES)[number];
export type ManifestStatus = (typeof MANIFEST_STATUSES)[number];
export declare const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus>;
export declare const TERMINAL_PIPELINE_STATUSES: ReadonlySet<PipelineStatus>;
export declare const TERMINAL_STAGE_STATUSES: ReadonlySet<StageStatus>;
export type EntityType = 'task' | 'session' | 'lifecycle_pipeline' | 'lifecycle_stage' | 'adr' | 'gate' | 'manifest';
export declare const STATUS_REGISTRY: Record<EntityType, readonly string[]>;
export declare function isValidStatus(entityType: EntityType, value: string): boolean;
/**
 * Pipeline status → Unicode progress icon.
 * Used wherever lifecycle pipeline status is rendered to a terminal.
 */
export declare const PIPELINE_STATUS_ICONS: Record<PipelineStatus, string>;
/**
 * Stage status → Unicode progress icon.
 * Used wherever pipeline stage status is rendered to a terminal.
 */
export declare const STAGE_STATUS_ICONS: Record<StageStatus, string>;
/**
 * Task status → Unicode symbol (rich terminal / Unicode-enabled).
 * Falls back to TASK_STATUS_SYMBOLS_ASCII when Unicode is unavailable.
 */
export declare const TASK_STATUS_SYMBOLS_UNICODE: Record<TaskStatus, string>;
/**
 * Task status → ASCII fallback symbol (non-Unicode terminals, CI output).
 */
export declare const TASK_STATUS_SYMBOLS_ASCII: Record<TaskStatus, string>;
//# sourceMappingURL=status-registry.d.ts.map