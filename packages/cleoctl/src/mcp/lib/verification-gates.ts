/**
 * Verification Gate System for CLEO MCP Server
 *
 * Re-exports from canonical location at src/core/validation/operation-verification-gates.ts.
 * Retained for backward compatibility.
 *
 * @task T2936
 * @task T5707
 * @epic T2908
 */

export {
  createVerificationGate,
  GATE_SEQUENCE,
  GateLayer,
  GateStatus,
  getWorkflowGateDefinition,
  isValidWorkflowGateName,
  VerificationGate,
  WORKFLOW_GATE_DEFINITIONS,
  WORKFLOW_GATE_SEQUENCE,
  WorkflowGateName,
  WorkflowGateTracker,
} from '@cleocode/core/internal';

export type {
  GateViolation,
  LayerResult,
  OperationContext,
  VerificationResult,
  WorkflowGateAgent,
  WorkflowGateDefinition,
  WorkflowGateState,
  WorkflowGateStatus,
} from '@cleocode/core/internal';
