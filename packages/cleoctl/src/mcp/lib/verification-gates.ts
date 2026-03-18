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
  GateStatus,
  getWorkflowGateDefinition,
  isValidWorkflowGateName,
  VerificationGate,
  WORKFLOW_GATE_DEFINITIONS,
  WORKFLOW_GATE_SEQUENCE,
} from '@cleocode/core/internal';

export type {
  GateLayer,
  GateViolation,
  LayerResult,
  OperationContext,
  VerificationResult,
  WorkflowGateAgent,
  WorkflowGateDefinition,
  WorkflowGateName,
  WorkflowGateState,
  WorkflowGateStatus,
  WorkflowGateTracker,
} from '@cleocode/core/internal';
