/**
 * Gate Validators for 4-Layer Verification System
 *
 * Re-exports from canonical location at src/core/validation/operation-gate-validators.ts.
 * Retained for backward compatibility.
 *
 * @task T2936
 * @task T3138
 * @task T5707
 * @epic T2908
 */

export {
  GATE_VALIDATION_RULES as VALIDATION_RULES,
  isFieldRequired,
  VALID_WORKFLOW_AGENTS,
  VALID_WORKFLOW_GATE_STATUSES,
  validateLayer1Schema,
  validateLayer2Semantic,
  validateLayer3Referential,
  validateLayer4Protocol,
  validateWorkflowGateName,
  validateWorkflowGateStatus,
  validateWorkflowGateUpdate,
} from '@cleocode/core';
