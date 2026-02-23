/**
 * Verification Gates - Dispatch layer re-export
 *
 * Re-exports from the canonical implementation in mcp/lib.
 * Will be replaced with a standalone implementation when mcp/lib is removed.
 */
export {
  createVerificationGate,
  VerificationGate,
  GateLayer,
  GateStatus,
  type GateViolation,
  type LayerResult,
  type VerificationResult,
  type OperationContext,
  GATE_SEQUENCE,
  WorkflowGateName,
  type WorkflowGateStatus,
  type WorkflowGateAgent,
  type WorkflowGateDefinition,
  type WorkflowGateState,
  WORKFLOW_GATE_DEFINITIONS,
  WORKFLOW_GATE_SEQUENCE,
  WorkflowGateTracker,
  isValidWorkflowGateName,
  getWorkflowGateDefinition,
} from '../../mcp/lib/verification-gates.js';
