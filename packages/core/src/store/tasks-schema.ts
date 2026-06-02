/**
 * Drizzle ORM schema for CLEO tasks.db (SQLite via node:sqlite + sqlite-proxy).
 *
 * This file is a barrel re-export. All table declarations live in subdomain
 * files under `packages/core/src/store/schema/`.
 *
 * Tables: tasks, task_dependencies, task_relations, sessions,
 *         session_handoff_entries, task_work_history
 * Archive uses the same tasks table with status = 'archived' + archive metadata.
 *
 * @epic T4454
 * @task W1-T2
 * @task T1609 session_handoff_entries — write-once handoff table
 */

export type {
  AgentErrorLogRow,
  AgentErrorType,
  AgentInstanceRow,
  AgentInstanceStatus,
  AgentType,
  NewAgentErrorLogRow,
  NewAgentInstanceRow,
} from './schema/agent-schema.js';
// Re-export agent schema tables so drizzle-kit picks them up for migrations.
export {
  AGENT_INSTANCE_STATUSES,
  AGENT_TYPES,
  agentErrorLog,
  agentInstances,
} from './schema/agent-schema.js';
export type {
  NewWarpChainInstanceRow,
  NewWarpChainRow,
  WarpChainInstanceRow,
  WarpChainRow,
} from './schema/chain-schema.js';
// Re-export WarpChain schema tables so drizzle-kit picks them up for migrations.
export { warpChainInstances, warpChains } from './schema/chain-schema.js';
// Row types follow the prefixed tables so `converters.ts` / `db-helpers.ts`
// and AC/session/link stores operate on the consolidated row shape.
export type {
  NewTasksExternalTaskLinkRow as NewExternalTaskLinkRow,
  NewTasksSessionRow as NewSessionRow,
  NewTasksTaskAcceptanceCriteriaHistoryRow as NewTaskAcceptanceCriteriaHistoryRow,
  NewTasksTaskRow as NewTaskRow,
  TasksExternalTaskLinkRow as ExternalTaskLinkRow,
  TasksSessionRow as SessionRow,
  TasksTaskAcceptanceCriteriaHistoryRow as TaskAcceptanceCriteriaHistoryRow,
  TasksTaskDependencyRow as TaskDependencyRow,
  TasksTaskRelationRow as TaskRelationRow,
  TasksTaskRow as TaskRow,
  TasksTaskWorkHistoryRow as WorkHistoryRow,
} from './schema/cleo-project/tasks-core.js';
// ===========================================================================
// COMPLETE-CUTOVER (T11578 · AC1) — runtime tasks store → prefixed tables
// ===========================================================================
//
// The full tasks-domain table family is repointed from the BARE legacy tables
// (`tasks`, `task_dependencies`, `task_relations`, `task_labels`, `sessions`,
// `task_acceptance_criteria`, `acceptance_projection_state`,
// `acceptance_projection_dirty`, `session_handoff_entries`, `task_work_history`,
// `task_acceptance_criteria_history`, `external_task_links`,
// `evidence_ac_bindings`) to the PREFIXED consolidated tables (`tasks_tasks`,
// `tasks_task_dependencies`, … `tasks_evidence_ac_bindings`) authored for
// SG-DB-SUBSTRATE-V2 (saga T11242, epic T11245/E2, T11360) and filled by the
// exodus migration (T11248).
//
// ## Why the WHOLE family, not just the 5 named in AC1
//
// The satellite tables carry foreign keys onto the task/session rows
// (`task_acceptance_criteria.task_id → tasks.id`,
// `evidence_ac_bindings.ac_id → task_acceptance_criteria.id`, etc.). Repointing
// only `tasks`/`sessions` while leaving the satellites on the bare tables
// produces a CROSS-TABLE FK split-brain: `cleo add --acceptance` writes the
// task into `tasks_tasks` but its AC rows into bare `task_acceptance_criteria`,
// whose FK references the now-empty bare `tasks` → `FOREIGN KEY constraint
// failed`. The whole family must move together so every intra-domain FK
// resolves within the consolidated substrate.
//
// ## Why an alias-at-the-barrel instead of editing `schema/tasks.ts`
//
// The legacy `tasks` / `sessions` table objects are still referenced by OTHER
// schema files (`audit.ts`, `experiments.ts`, `lifecycle.ts`, `manifest.ts`)
// for FK `.references(() => tasks.id)` and by the `drizzle-tasks` legacy
// migration generator — those must keep pointing at the bare definitions. Only
// the RUNTIME query surface (`import * as schema from './tasks-schema.js'` in
// `sqlite.ts`) needs the prefixed binding, so the swap lives here.
//
// ## Constraint reconciliation
//
// Physical column names are identical between legacy and prefixed tables (so
// `schema.tasks.<field>` access stays byte-identical). The prefixed `tasks_tasks`
// adds one nullable `idempotency_key` column plus CHECK / GLOB constraints (enum
// casing + ISO-8601 timestamps + 0/1 booleans). The tasks write path conforms:
// `converters.ts#taskToRow` emits ISO-8601 `createdAt`; `db-helpers.ts`
// writes `gradeMode` as a boolean and the canonical `ARCHIVE_REASON_TOMBSTONE`
// for completed archives (the legacy `'completed'` literal was out-of-enum and
// only survived because the bare table had no CHECK).
//
// The legacy bare tables are now DEAD for runtime reads/writes; they remain
// physically present (created by `runMigrations` / `drizzle-tasks`) for the
// exodus source-vs-target equivalence check until E6-L7/L8 removes them.
export {
  tasksAcceptanceProjectionDirty as acceptanceProjectionDirty,
  tasksAcceptanceProjectionState as acceptanceProjectionState,
  tasksExternalTaskLinks as externalTaskLinks,
  tasksSessionHandoffEntries as sessionHandoffEntries,
  tasksSessions as sessions,
  tasksTaskAcceptanceCriteria as taskAcceptanceCriteria,
  tasksTaskAcceptanceCriteriaHistory as taskAcceptanceCriteriaHistory,
  tasksTaskDependencies as taskDependencies,
  tasksTaskRelations as taskRelations,
  tasksTasks as tasks,
  tasksTaskWorkHistory as taskWorkHistory,
} from './schema/cleo-project/tasks-core.js';
export type {
  NewTasksEvidenceAcBindingRow as NewEvidenceAcBindingRow,
  NewTasksTaskLabelRow as NewTaskLabelRow,
  TasksEvidenceAcBindingRow as EvidenceAcBindingRow,
  TasksTaskLabelRow as TaskLabelRow,
} from './schema/cleo-project/tasks-core-batch2.js';
export {
  tasksEvidenceAcBindings as evidenceAcBindings,
  tasksTaskLabels as taskLabels,
} from './schema/cleo-project/tasks-core-batch2.js';
// Re-export all domain tables, constants, and types from the schema subdirectory.
// NOTE (T11578 · AC1): `./schema/index.js` re-exports the LEGACY bare-name task
// table objects (`tasks`, `sessions`, `taskDependencies`, `taskRelations`,
// `taskLabels`). The explicit re-exports in the "COMPLETE-CUTOVER" block at the
// bottom of this file SHADOW those five names, repointing the runtime drizzle
// query symbols at the PREFIXED consolidated tables (`tasks_tasks`, …) that the
// exodus migration fills. Per the ES module spec, a local explicit named
// re-export takes precedence over a `export *` re-export for the same name, so
// all 290+ `schema.tasks` / `schema.sessions` call sites keep compiling while
// now reading and writing the prefixed physical tables.
export * from './schema/index.js';
// Re-export status constants and types so existing imports from schema.ts still work.
export {
  ADR_STATUSES,
  type AdrStatus,
  GATE_STATUSES,
  type GateStatus,
  isValidStatus,
  LIFECYCLE_PIPELINE_STATUSES,
  LIFECYCLE_STAGE_STATUSES,
  MANIFEST_STATUSES,
  type ManifestStatus,
  type PipelineStatus,
  SESSION_STATUSES,
  type SessionStatus,
  type StageStatus,
  TASK_STATUSES,
  type TaskStatus,
} from './status-registry.js';
