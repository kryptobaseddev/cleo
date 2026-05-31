/**
 * Project-scope `cleo.db` — consolidated **runtime** domain (chain · agents ·
 * playbooks · 6 tables).
 *
 * Part of the consolidated PROJECT-scope `cleo.db` target shape authored for
 * SG-DB-SUBSTRATE-V2 (saga T11242, epic T11245/E2, task T11360). Target-shape
 * authoring only — physical names carry the `tasks_` domain prefix. The live
 * runtime modules `schema/{chain-schema,agent-schema,playbooks}.ts` keep their
 * UNPREFIXED names until the exodus migration (T11248) swaps the substrate.
 *
 * Tables: tasks_warp_chains · tasks_warp_chain_instances · tasks_agent_instances ·
 * tasks_agent_error_log · tasks_playbook_runs · tasks_playbook_approvals.
 *
 * ## E10 §3b — boolean non-conformer
 *
 * `playbook_approvals.auto_passed` (untyped INTEGER 0/1) →
 * `integer({ mode: 'boolean' })`. (`warp_chains.validated`,
 * `agent_error_log.resolved` were already typed boolean — preserved.)
 *
 * ## E10 §5b — enum-like bare-TEXT → { enum } (from named const arrays, §5a)
 *
 *   - `warp_chain_instances.status` → { enum: WARP_CHAIN_INSTANCE_STATUSES }
 *   - `playbook_runs.status`        → { enum: PLAYBOOK_RUN_STATUSES } (minted here
 *     from the `PlaybookRunStatus` contracts union — a CLOSED 5-state set)
 *   - `playbook_approvals.status`   → { enum: PLAYBOOK_APPROVAL_STATUSES } (minted
 *     here from the `PlaybookApprovalStatus` contracts union — a CLOSED 3-state set)
 *   - `agent_error_log.error_type`  → { enum: AGENT_ERROR_TYPES } (promoted from
 *     the inline literal, §5a)
 *
 * The playbook status sets are SAFE to freeze (unlike the conduit §5b cases):
 * `@cleocode/contracts` declares them as exhaustive string-literal unions
 * (`PlaybookRunStatus`/`PlaybookApprovalStatus`), so the const arrays minted
 * here are the complete legal set by construction — verified to match below.
 *
 * ## E10 §4 / §6a
 *
 * All timestamps are already canonical TEXT ISO8601 (no epoch non-conformers).
 * `warp_chains.definition`, instance `variables`/`stage_to_task`/`gate_results`,
 * `agent_instances.metadata_json`, `playbook_runs.{bindings,iteration_counts}`
 * stay serialized TEXT per the JSON-Column Audit.
 *
 * @task T11360
 * @epic T11245
 * @saga T11242
 * @see docs/migration/sqlite-schema-canonical.md §3b · §4 · §5b · §6a
 * @see docs/migration/sqlite-schema-columns.json (per-column affinity SSoT)
 */

import type { PlaybookApprovalStatus, PlaybookRunStatus } from '@cleocode/contracts';
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { AGENT_INSTANCE_STATUSES, AGENT_TYPES } from '../agent-schema.js';
import { WARP_CHAIN_INSTANCE_STATUSES } from '../chain-schema.js';

/**
 * Agent-error classification — promoted from the inline literal on
 * `agent_error_log.error_type` to a named const array (§5a).
 */
export const AGENT_ERROR_TYPES = ['retriable', 'permanent', 'unknown'] as const;

/**
 * Playbook-run FSM states — minted from the `PlaybookRunStatus` contracts union
 * so the §5b CHECK derivation references an identifier (§5a). The
 * `satisfies readonly PlaybookRunStatus[]` assertion makes the compiler reject
 * this array if it ever drifts from the canonical contracts union.
 */
export const PLAYBOOK_RUN_STATUSES = [
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const satisfies readonly PlaybookRunStatus[];

/**
 * Playbook-approval states — minted from the `PlaybookApprovalStatus` contracts
 * union (compiler-checked complete via `satisfies`).
 */
export const PLAYBOOK_APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
] as const satisfies readonly PlaybookApprovalStatus[];

// ---------------------------------------------------------------------------
// WarpChain
// ---------------------------------------------------------------------------

/**
 * `tasks_warp_chains` — stored WarpChain definitions.
 *
 * @task T11360 (target shape) · T5403 (original)
 */
export const tasksWarpChains = sqliteTable(
  'tasks_warp_chains',
  {
    /** Chain id. */
    id: text('id').primaryKey(),
    /** Chain name. */
    name: text('name').notNull(),
    /** Chain version. */
    version: text('version').notNull(),
    /** Optional description. */
    description: text('description'),
    /** JSON-serialized WarpChain definition (TEXT per JSON audit). */
    definition: text('definition').notNull(),
    /** Whether the definition validated. §3a boolean — already typed, preserved. */
    validated: integer('validated', { mode: 'boolean' }).default(false),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-update instant (canonical TEXT, §4). */
    updatedAt: text('updated_at').default(sql`(datetime('now'))`),
  },
  (table) => [index('idx_tasks_warp_chains_name').on(table.name)],
);

/**
 * `tasks_warp_chain_instances` — runtime chain instances bound to epics.
 *
 * @task T11360 (target shape) · T5403 (original)
 */
export const tasksWarpChainInstances = sqliteTable(
  'tasks_warp_chain_instances',
  {
    /** Instance id. */
    id: text('id').primaryKey(),
    /** FK → `tasks_warp_chains.id`. ON DELETE CASCADE. */
    chainId: text('chain_id')
      .notNull()
      .references(() => tasksWarpChains.id, { onDelete: 'cascade' }),
    /** Bound epic id (cross-table soft ref → `tasks_tasks.id`). */
    epicId: text('epic_id').notNull(),
    /** JSON variables (TEXT per JSON audit). */
    variables: text('variables'),
    /** JSON stage→task map (TEXT per JSON audit). */
    stageToTask: text('stage_to_task'),
    /** Instance status — E10 §5b CHECK-backed via {@link WARP_CHAIN_INSTANCE_STATUSES}. */
    status: text('status', { enum: WARP_CHAIN_INSTANCE_STATUSES }).notNull().default('pending'),
    /** Current stage pointer. */
    currentStage: text('current_stage'),
    /** JSON array of gate results (TEXT per JSON audit). */
    gateResults: text('gate_results'),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-update instant (canonical TEXT, §4). */
    updatedAt: text('updated_at').default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_tasks_warp_chain_instances_chain').on(table.chainId),
    index('idx_tasks_warp_chain_instances_epic').on(table.epicId),
    index('idx_tasks_warp_chain_instances_status').on(table.status),
  ],
);

// ---------------------------------------------------------------------------
// Agents (DB-backed runtime instance registry)
// ---------------------------------------------------------------------------

/**
 * `tasks_agent_instances` — live agent-process runtime registry.
 *
 * @task T11360 (target shape)
 */
export const tasksAgentInstances = sqliteTable(
  'tasks_agent_instances',
  {
    /** Instance identity (cross-DB soft FK → signaldock agents). */
    id: text('id').primaryKey(),
    /** Agent type — CHECK-backed via {@link AGENT_TYPES}. */
    agentType: text('agent_type', { enum: AGENT_TYPES }).notNull(),
    /** Instance status — CHECK-backed via {@link AGENT_INSTANCE_STATUSES}. */
    status: text('status', { enum: AGENT_INSTANCE_STATUSES }).notNull().default('starting'),
    /** Intra-DB soft ref → `tasks_sessions.id`. */
    sessionId: text('session_id'),
    /** Intra-DB soft ref → `tasks_tasks.id`. */
    taskId: text('task_id'),
    /** ISO-8601 UTC start instant (canonical TEXT, §4). */
    startedAt: text('started_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-heartbeat instant (canonical TEXT, §4). */
    lastHeartbeat: text('last_heartbeat').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC stop instant (canonical TEXT, §4). */
    stoppedAt: text('stopped_at'),
    /** Error count. */
    errorCount: integer('error_count').notNull().default(0),
    /** Total tasks completed by this instance. */
    totalTasksCompleted: integer('total_tasks_completed').notNull().default(0),
    /** Capacity weight (TEXT, e.g. "1.0"). */
    capacity: text('capacity').notNull().default('1.0'),
    /** JSON metadata object (TEXT per JSON audit; empty-object default). */
    metadataJson: text('metadata_json').default('{}'),
    /** Parent agent id (cross-DB soft FK → signaldock agents). */
    parentAgentId: text('parent_agent_id'),
  },
  (table) => [
    index('idx_tasks_agent_instances_status').on(table.status),
    index('idx_tasks_agent_instances_agent_type').on(table.agentType),
    index('idx_tasks_agent_instances_session_id').on(table.sessionId),
    index('idx_tasks_agent_instances_task_id').on(table.taskId),
    index('idx_tasks_agent_instances_parent_agent_id').on(table.parentAgentId),
    index('idx_tasks_agent_instances_last_heartbeat').on(table.lastHeartbeat),
  ],
);

/**
 * `tasks_agent_error_log` — agent error history.
 *
 * @task T11360 (target shape)
 */
export const tasksAgentErrorLog = sqliteTable(
  'tasks_agent_error_log',
  {
    /** Auto-increment surrogate PK. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Erring agent identity (cross-DB soft FK → signaldock agents). */
    agentId: text('agent_id').notNull(),
    /** Error classification — E10 §5b CHECK-backed via {@link AGENT_ERROR_TYPES} (§5a). */
    errorType: text('error_type', { enum: AGENT_ERROR_TYPES }).notNull(),
    /** Error message. */
    message: text('message').notNull(),
    /** Optional stack trace. */
    stack: text('stack'),
    /** ISO-8601 UTC occurrence instant (canonical TEXT, §4). */
    occurredAt: text('occurred_at').notNull().default(sql`(datetime('now'))`),
    /** Whether the error was resolved. §3a boolean — already typed, preserved. */
    resolved: integer('resolved', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    index('idx_tasks_agent_error_log_agent_id').on(table.agentId),
    index('idx_tasks_agent_error_log_error_type').on(table.errorType),
    index('idx_tasks_agent_error_log_occurred_at').on(table.occurredAt),
  ],
);

// ---------------------------------------------------------------------------
// Playbooks
// ---------------------------------------------------------------------------

/**
 * `tasks_playbook_runs` — playbook run state.
 *
 * @task T11360 (target shape) · T889 (original)
 */
export const tasksPlaybookRuns = sqliteTable('tasks_playbook_runs', {
  /** Run id. */
  runId: text('run_id').primaryKey(),
  /** Playbook name. */
  playbookName: text('playbook_name').notNull(),
  /** Playbook content hash. */
  playbookHash: text('playbook_hash').notNull(),
  /** Current node pointer. */
  currentNode: text('current_node'),
  /** JSON bindings (TEXT per JSON audit; empty-object default). */
  bindings: text('bindings').notNull().default('{}'),
  /** Optional error context. */
  errorContext: text('error_context'),
  /** Run status — E10 §5b CHECK-backed via {@link PLAYBOOK_RUN_STATUSES}. */
  status: text('status', { enum: PLAYBOOK_RUN_STATUSES }).notNull().default('running'),
  /** JSON iteration counts (TEXT per JSON audit; empty-object default). */
  iterationCounts: text('iteration_counts').notNull().default('{}'),
  /** Optional epic id (cross-table soft ref → `tasks_tasks.id`). */
  epicId: text('epic_id'),
  /** Optional session id (cross-table soft ref → `tasks_sessions.id`). */
  sessionId: text('session_id'),
  /** ISO-8601 UTC start instant (canonical TEXT, §4). */
  startedAt: text('started_at').notNull().default(sql`(datetime('now'))`),
  /** ISO-8601 UTC completion instant (canonical TEXT, §4). */
  completedAt: text('completed_at'),
});

/**
 * `tasks_playbook_approvals` — playbook HITL approval records.
 *
 * @task T11360 (target shape) · T889 (original)
 */
export const tasksPlaybookApprovals = sqliteTable('tasks_playbook_approvals', {
  /** Approval id. */
  approvalId: text('approval_id').primaryKey(),
  /** FK → `tasks_playbook_runs.run_id` (resolved at exodus). */
  runId: text('run_id').notNull(),
  /** Node id awaiting approval. */
  nodeId: text('node_id').notNull(),
  /** HMAC resume token (unique). */
  token: text('token').notNull().unique(),
  /** ISO-8601 UTC request instant (canonical TEXT, §4). */
  requestedAt: text('requested_at').notNull().default(sql`(datetime('now'))`),
  /** ISO-8601 UTC approval instant (canonical TEXT, §4). */
  approvedAt: text('approved_at'),
  /** Approver identity. */
  approver: text('approver'),
  /** Optional reason. */
  reason: text('reason'),
  /** Approval status — E10 §5b CHECK-backed via {@link PLAYBOOK_APPROVAL_STATUSES}. */
  status: text('status', { enum: PLAYBOOK_APPROVAL_STATUSES }).notNull().default('pending'),
  /** Whether the gate auto-passed. E10 §3b: untyped INTEGER 0/1 → typed boolean. */
  autoPassed: integer('auto_passed', { mode: 'boolean' }).notNull().default(false),
});

// === TYPE EXPORTS ===

/** Row type for `tasks_warp_chains` SELECT queries (target shape). */
export type TasksWarpChainRow = typeof tasksWarpChains.$inferSelect;
/** Row type for `tasks_warp_chains` INSERT operations (target shape). */
export type NewTasksWarpChainRow = typeof tasksWarpChains.$inferInsert;
/** Row type for `tasks_warp_chain_instances` SELECT queries (target shape). */
export type TasksWarpChainInstanceRow = typeof tasksWarpChainInstances.$inferSelect;
/** Row type for `tasks_warp_chain_instances` INSERT operations (target shape). */
export type NewTasksWarpChainInstanceRow = typeof tasksWarpChainInstances.$inferInsert;
/** Row type for `tasks_agent_instances` SELECT queries (target shape). */
export type TasksAgentInstanceRow = typeof tasksAgentInstances.$inferSelect;
/** Row type for `tasks_agent_instances` INSERT operations (target shape). */
export type NewTasksAgentInstanceRow = typeof tasksAgentInstances.$inferInsert;
/** Row type for `tasks_agent_error_log` SELECT queries (target shape). */
export type TasksAgentErrorLogRow = typeof tasksAgentErrorLog.$inferSelect;
/** Row type for `tasks_agent_error_log` INSERT operations (target shape). */
export type NewTasksAgentErrorLogRow = typeof tasksAgentErrorLog.$inferInsert;
/** Row type for `tasks_playbook_runs` SELECT queries (target shape). */
export type TasksPlaybookRunRow = typeof tasksPlaybookRuns.$inferSelect;
/** Row type for `tasks_playbook_runs` INSERT operations (target shape). */
export type NewTasksPlaybookRunRow = typeof tasksPlaybookRuns.$inferInsert;
/** Row type for `tasks_playbook_approvals` SELECT queries (target shape). */
export type TasksPlaybookApprovalRow = typeof tasksPlaybookApprovals.$inferSelect;
/** Row type for `tasks_playbook_approvals` INSERT operations (target shape). */
export type NewTasksPlaybookApprovalRow = typeof tasksPlaybookApprovals.$inferInsert;
