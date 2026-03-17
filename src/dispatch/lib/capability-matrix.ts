/**
 * Capability Matrix (Backward-Compat Re-export)
 *
 * Thin wrapper that re-exports from the canonical location at
 * src/core/routing/capability-matrix.ts.
 *
 * @task T5706
 */

export type {
  CapabilityReport,
  ExecutionMode,
  GatewayType,
  OperationCapability,
  PreferredChannel,
} from '../../core/routing/capability-matrix.js';
export {
  canRunNatively,
  generateCapabilityReport,
  getCapabilityMatrix,
  getNativeOperations,
  getOperationMode,
  requiresCLI,
} from '../../core/routing/capability-matrix.js';
