/**
 * Lifecycle Domain Operations (10 operations)
 *
 * Query operations: 5
 * Mutate operations: 5
 */

import type { GateStatus, StageStatus } from '../status-registry.js';

export type { GateStatus, StageStatus };

/**
 * Common lifecycle types
 */
export type LifecycleStage =
  | 'research'
  | 'consensus'
  | 'architecture_decision'
  | 'specification'
  | 'decomposition'
  | 'implementation'
  | 'validation'
  | 'testing'
  | 'release';

export interface StageRecord {
  stage: LifecycleStage;
  status: StageStatus;
  started?: string;
  completed?: string;
  agent?: string;
  notes?: string;
}

export interface Gate {
  name: string;
  stage: LifecycleStage;
  status: GateStatus;
  agent?: string;
  timestamp?: string;
  reason?: string;
}

/**
 * Query Operations
 */

// lifecycle.check
/**
 * Parameters for `lifecycle.check`.
 *
 * @remarks
 * Re-synced to match `lifecycleCheck(epicId, targetStage)` in
 * `packages/cleo/src/dispatch/engines/lifecycle-engine.ts`. The legacy
 * contract used `taskId`; the engine operates on the epic/pipeline
 * container. Both forms accept a task ID string — the parameter is named
 * after its semantic role (the epic whose pipeline stage is being checked).
 *
 * @task T963 — contract↔impl drift reconciliation (T910 audit)
 */
export interface LifecycleCheckParams {
  /**
   * Epic (or task with a pipeline) whose stage prerequisites should be
   * checked. Matches `epicId` in the engine signature.
   * @task T963
   */
  epicId: string;
  /** Target lifecycle stage to validate prerequisites for. @task T963 */
  targetStage: LifecycleStage;
}
export interface LifecycleCheckResult {
  /**
   * The epic ID that was checked (mirrors `epicId` param). Named
   * `taskId` historically for wire compatibility; new callers should use
   * the param name `epicId`.
   * @task T963
   */
  taskId: string;
  /** The target stage that was checked. @task T963 */
  targetStage: LifecycleStage;
  /** True when prerequisites are satisfied and the stage can be entered. @task T963 */
  canProceed: boolean;
  /** Ordered list of stages that must complete first. @task T963 */
  missingPrerequisites: LifecycleStage[];
  /** Current gate status for the target stage. @task T963 */
  gateStatus: GateStatus;
}

// lifecycle.status
export interface LifecycleStatusParams {
  taskId?: string;
  epicId?: string;
}
export interface LifecycleStatusResult {
  id: string;
  currentStage: LifecycleStage;
  stages: StageRecord[];
  completedStages: LifecycleStage[];
  pendingStages: LifecycleStage[];
}

// lifecycle.history
export interface LifecycleHistoryParams {
  taskId: string;
}
export interface LifecycleHistoryEntry {
  stage: LifecycleStage;
  from: StageStatus;
  to: StageStatus;
  timestamp: string;
  agent?: string;
  notes?: string;
}
export type LifecycleHistoryResult = LifecycleHistoryEntry[];

// lifecycle.gates
export interface LifecycleGatesParams {
  taskId: string;
}
export type LifecycleGatesResult = Gate[];

// lifecycle.prerequisites
export interface LifecyclePrerequisitesParams {
  targetStage: LifecycleStage;
}
export interface LifecyclePrerequisitesResult {
  targetStage: LifecycleStage;
  prerequisites: LifecycleStage[];
  optional: LifecycleStage[];
}

/**
 * Mutate Operations
 */

// lifecycle.progress
export interface LifecycleProgressParams {
  taskId: string;
  stage: LifecycleStage;
  status: StageStatus;
  notes?: string;
}
export interface LifecycleProgressResult {
  taskId: string;
  stage: LifecycleStage;
  status: StageStatus;
  timestamp: string;
}

// lifecycle.skip
export interface LifecycleSkipParams {
  taskId: string;
  stage: LifecycleStage;
  reason: string;
}
export interface LifecycleSkipResult {
  taskId: string;
  stage: LifecycleStage;
  skipped: string;
  reason: string;
}

// lifecycle.reset
export interface LifecycleResetParams {
  taskId: string;
  stage: LifecycleStage;
  reason: string;
}
export interface LifecycleResetResult {
  taskId: string;
  stage: LifecycleStage;
  reset: string;
  reason: string;
  warning: string;
}

// lifecycle.gate.pass
export interface LifecycleGatePassParams {
  taskId: string;
  gateName: string;
  agent: string;
  notes?: string;
}
export interface LifecycleGatePassResult {
  taskId: string;
  gateName: string;
  status: 'passed';
  timestamp: string;
}

// lifecycle.gate.fail
export interface LifecycleGateFailParams {
  taskId: string;
  gateName: string;
  reason: string;
}
export interface LifecycleGateFailResult {
  taskId: string;
  gateName: string;
  status: 'failed';
  reason: string;
  timestamp: string;
}
