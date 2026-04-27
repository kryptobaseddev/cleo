/**
 * Core playbook primitives — dispatchers, resolvers, and helpers consumed by
 * the playbook runtime (`@cleocode/playbooks`) and the orchestrate CLI.
 *
 * This package intentionally does NOT depend on `@cleocode/playbooks` to
 * preserve the directed layering `contracts → core → playbooks`. Types here
 * are structurally compatible with the runtime-level interfaces so a core
 * dispatcher instance can be passed straight to `executePlaybook()`.
 *
 * @module playbooks
 * @task T1239 — meta-agent infrastructure (epic T1232)
 */

export {
  AGENT_TIER_META,
  type AgentDispatcher,
  CoreAgentDispatcher,
  type CoreAgentDispatcherOptions,
  createAgentDispatcher,
  type DispatchContext,
  type DispatchResult,
  resolveMetaAgent,
} from './agent-dispatcher.js';

export type { playbookCoreOps } from './ops.js';
