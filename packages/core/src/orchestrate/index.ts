/**
 * Orchestrate module barrel
 *
 * Re-exports from all 7 orchestrate sub-modules:
 * - query-ops.ts   — status, analyze, ready, next, waves, context, validate
 * - lifecycle-ops.ts — initLoomForEpic, startup, bootstrap, criticalPath, unblock, check, skillInject, parallel*
 * - spawn-ops.ts   — spawnSelectProvider, spawnExecute, spawn, sendConduitEvent, composeSpawnForTask
 * - handoff-ops.ts — handoff + HandoffStep types
 * - plan.ts        — orchestratePlan + 4 interfaces + plan helpers
 * - pivot.ts       — pivotTask (existing)
 * - worker-verify.ts — reVerifyWorkerReport (existing)
 *
 * @task T1570
 * @task T1634 — LOOM auto-init export
 */

export type {
  HandoffFailureDetails,
  HandoffSessionOps,
  HandoffState,
  HandoffStepState,
  HandoffStepStatus,
} from './handoff-ops.js';
export { orchestrateHandoff } from './handoff-ops.js';
export {
  initLoomForEpic,
  orchestrateBootstrap,
  orchestrateCheck,
  orchestrateCriticalPath,
  orchestrateParallel,
  orchestrateParallelEnd,
  orchestrateParallelStart,
  orchestrateSkillInject,
  orchestrateStartup,
  orchestrateUnblockOpportunities,
} from './lifecycle-ops.js';
export type { PivotOptions, PivotResult } from './pivot.js';
export { PIVOT_AUDIT_FILE, pivotTask } from './pivot.js';
export type {
  OrchestratePlanInput,
  PlanWarning,
  PlanWave,
  PlanWorkerEntry,
} from './plan.js';
export { numericToAgentTier, openSignaldockDbForComposer, orchestratePlan } from './plan.js';
export type { EngineResult } from './query-ops.js';
export {
  loadTasks,
  orchestrateAnalyze,
  orchestrateContext,
  orchestrateNext,
  orchestrateReady,
  orchestrateStatus,
  orchestrateValidate,
  orchestrateWaves,
} from './query-ops.js';
export type { ConduitOrchestrationEvent } from './spawn-ops.js';
export {
  composeSpawnForTask,
  orchestrateSpawn,
  orchestrateSpawnExecute,
  orchestrateSpawnSelectProvider,
  sendConduitEvent,
} from './spawn-ops.js';
export type {
  ReVerifyOptions,
  TestRunResult,
  WorkerMismatch,
  WorkerMismatchAuditEntry,
  WorkerReport,
} from './worker-verify.js';
export {
  appendWorkerMismatchAudit,
  defaultListChangedFiles,
  defaultRunProjectTests,
  reVerifyWorkerReport,
  WORKER_MISMATCH_AUDIT_FILE,
} from './worker-verify.js';
