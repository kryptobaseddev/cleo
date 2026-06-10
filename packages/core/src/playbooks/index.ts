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
// Pi in-process runner wiring — default-OFF, lazy-imported Pi `SkillRunner` the
// production cantbook dispatchers pass into `runSkillNodeOrSpawn`'s `runner`
// slot (T11945 · M4). Exported here (the eager core graph) so its live binding
// is initialised before `internal.ts` re-exports it.
export { type MaybePiRunnerDeps, maybeCreatePiRunner } from './pi-runner-wiring.js';
export {
  listPlaybooks,
  PlaybookNotFoundError,
  type PlaybookTier,
  type ResolvedPlaybook,
  type ResolvePlaybookOptions,
  resolvePlaybook,
} from './playbook-resolver.js';
// Skill-node executor — injects the in-process SkillExecutorAdapter as the
// dispatcher's executor while retaining subprocess-spawn for isolation nodes
// (T11477 · epic T11391).
export {
  createSkillNodeExecutor,
  ISOLATION_CONTEXT_KEY,
  runSkillNodeOrSpawn,
  type SkillNodeDispatchInput,
  type SkillNodeExecutorOptions,
  type SubprocessSpawnExecutor,
} from './skill-node-executor.js';
