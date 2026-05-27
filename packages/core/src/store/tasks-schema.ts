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
} from '../agents/agent-schema.js';
// Re-export agent schema tables so drizzle-kit picks them up for migrations.
export {
  AGENT_INSTANCE_STATUSES,
  AGENT_TYPES,
  agentErrorLog,
  agentInstances,
} from '../agents/agent-schema.js';
export type {
  NewWarpChainInstanceRow,
  NewWarpChainRow,
  WarpChainInstanceRow,
  WarpChainRow,
} from './chain-schema.js';
// Re-export WarpChain schema tables so drizzle-kit picks them up for migrations.
export { warpChainInstances, warpChains } from './chain-schema.js';
// Re-export all domain tables, constants, and types from the schema subdirectory.
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
