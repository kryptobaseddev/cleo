/**
 * WarpChain Type System
 *
 * Defines the complete type system for WarpChain workflow definitions.
 * Warp is the unyielding protocol chain: the synthesis of composable workflow
 * shape (topology) and LOOM quality gates into a unified chain model.
 *
 * @task T5407
 */

import type { ProtocolType } from '../core/orchestration/protocol-validators.js';
import type { GateName } from '../core/validation/verification.js';

// =============================================================================
// CHAIN SHAPE (Warp topology)
// =============================================================================

/**
 * A single stage in the warp chain.
 *
 * The category union includes all canonical CLEO pipeline stages
 * plus 'custom' for user-defined stages.
 */
export interface WarpStage {
  id: string;
  name: string;
  category:
    | 'research'
    | 'consensus'
    | 'architecture'
    | 'specification'
    | 'decomposition'
    | 'implementation'
    | 'validation'
    | 'testing'
    | 'release'
    | 'contribution'
    | 'custom';
  skippable: boolean;
  description?: string;
}

/** Connection between two stages in the chain. */
export interface WarpLink {
  from: string;
  to: string;
  type: 'linear' | 'fork' | 'branch';
  condition?: string;
}

/** The topology/DAG of a workflow. */
export interface ChainShape {
  stages: WarpStage[];
  links: WarpLink[];
  entryPoint: string;
  exitPoints: string[];
}

// =============================================================================
// GATE SYSTEM (LOOM quality gates)
// =============================================================================

/** Discriminated union for gate check types. */
export type GateCheck =
  | { type: 'stage_complete'; stageId: string }
  | { type: 'artifact_exists'; artifactType: string; path?: string }
  | { type: 'protocol_valid'; protocolType: ProtocolType }
  | { type: 'verification_gate'; gateName: GateName }
  | { type: 'custom'; validator: string; params?: Record<string, unknown> };

/** A quality gate embedded in the chain. */
export interface GateContract {
  id: string;
  name: string;
  type: 'entry' | 'exit' | 'checkpoint';
  stageId: string;
  position: 'before' | 'after';
  check: GateCheck;
  severity: 'blocking' | 'warning' | 'info';
  canForce: boolean;
}

// =============================================================================
// CHAIN DEFINITION
// =============================================================================

/** Complete chain definition combining shape and gates. */
export interface WarpChain {
  id: string;
  name: string;
  version: string;
  description: string;
  shape: ChainShape;
  gates: GateContract[];
  tessera?: string;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// CHAIN VALIDATION
// =============================================================================

/** Result of validating a chain definition. */
export interface ChainValidation {
  wellFormed: boolean;
  gateSatisfiable: boolean;
  artifactComplete: boolean;
  errors: string[];
  warnings: string[];
}

// =============================================================================
// CHAIN INSTANCE (runtime binding)
// =============================================================================

/** A chain bound to a specific epic. */
export interface WarpChainInstance {
  id: string;
  chainId: string;
  epicId: string;
  variables: Record<string, unknown>;
  stageToTask: Record<string, string>;
  status: 'pending' | 'active' | 'completed' | 'failed' | 'cancelled';
  currentStage: string;
  createdAt: string;
  createdBy: string;
}

// =============================================================================
// CHAIN EXECUTION (runtime state)
// =============================================================================

/** Result of evaluating a single gate. */
export interface GateResult {
  gateId: string;
  passed: boolean;
  forced: boolean;
  message?: string;
  evaluatedAt: string;
}

/** Runtime state of a chain instance execution. */
export interface WarpChainExecution {
  instanceId: string;
  currentStage: string;
  gateResults: GateResult[];
  status: 'running' | 'paused' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
}
