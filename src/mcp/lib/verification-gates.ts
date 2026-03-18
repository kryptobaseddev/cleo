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
  type GateViolation,
  getWorkflowGateDefinition,
  isValidWorkflowGateName,
  type LayerResult,
  type OperationContext,
  VerificationGate,
  type VerificationResult,
  WORKFLOW_GATE_DEFINITIONS,
  WORKFLOW_GATE_SEQUENCE,
  type WorkflowGateAgent,
  type WorkflowGateDefinition,
  WorkflowGateName,
  type WorkflowGateState,
  type WorkflowGateStatus,
  WorkflowGateTracker,
} from '@cleocode/core';
