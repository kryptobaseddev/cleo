/**
 * CANT DSL runtime — TypeScript workflow executor.
 *
 * This module provides the TypeScript side of the CANT hybrid runtime:
 * - Workflow execution (sessions, parallel, conditionals, loops, try/catch)
 * - Discretion evaluation (pluggable AI-judged conditions)
 * - Approval gate management (token generation, validation, state machine)
 * - Parallel arm execution (all/race/settle strategies)
 * - Execution context and scope management
 *
 * Pipeline execution is handled by the Rust `cant-runtime` crate and
 * bridged via napi-rs.
 *
 * @see docs/specs/CANT-DSL-SPEC.md Section 7 (Runtime) and Section 8 (Approval Tokens)
 */

// Approval gate management
export { ApprovalManager } from './approval.js';

// Execution context and scope
export {
  createChildScope,
  createScope,
  flattenScope,
  mergeStepOutput,
  resolveTemplate,
  resolveVariable,
  setVariable,
} from './context-builder.js';

// Discretion evaluation
export type { DiscretionEvaluator } from './discretion.js';
export {
  DefaultDiscretionEvaluator,
  MockDiscretionEvaluator,
  RateLimitedDiscretionEvaluator,
} from './discretion.js';

// Parallel execution
export type { ParallelArm, ParallelResult } from './parallel-runner.js';
export { executeParallel } from './parallel-runner.js';

// Runtime types
export type {
  ApprovalToken,
  ApprovalTokenStatus,
  DiscretionContext,
  ExecutionResult,
  ExecutionScope,
  JoinStrategy,
  SettleResult,
  StepResult,
  TokenValidation,
} from './types.js';

// Workflow executor
export type { WorkflowExecutorConfig } from './workflow-executor.js';
export { WorkflowExecutor } from './workflow-executor.js';
