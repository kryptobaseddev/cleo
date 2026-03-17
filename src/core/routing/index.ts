/**
 * Routing core module — barrel export.
 *
 * Re-exports capability matrix and routing utilities from the core layer.
 *
 * @task T5706
 */

export type {
  CapabilityReport,
  ExecutionMode,
  GatewayType,
  OperationCapability,
  PreferredChannel,
} from './capability-matrix.js';
export {
  canRunNatively,
  generateCapabilityReport,
  getCapabilityMatrix,
  getNativeOperations,
  getOperationMode,
  requiresCLI,
} from './capability-matrix.js';
