/**
 * Lifecycle Domain Operations (10 operations)
 *
 * Query operations: 5
 * Mutate operations: 5
 */

import type { StageStatus } from '../../store/status-registry.js';
export type { StageStatus };

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

export type GateStatus = 'passed' | 'failed' | 'blocked' | null;

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
export interface LifecycleCheckParams {
  taskId: string;
  targetStage: LifecycleStage;
}
export interface LifecycleCheckResult {
  taskId: string;
  targetStage: LifecycleStage;
  canProceed: boolean;
  missingPrerequisites: LifecycleStage[];
  gateStatus: 'passed' | 'failed' | 'pending';
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
