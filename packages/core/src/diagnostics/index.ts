/**
 * Diagnostics module — telemetry analysis and BRAIN observation generation.
 *
 * Public surface for `packages/core/src/diagnostics/`:
 *   - EngineResult-wrapped operations for the CLI dispatch layer
 *
 * @module diagnostics
 * @task T1580 — ENG-MIG-13
 * @epic T1566
 */

export {
  diagnosticsAnalyze,
  diagnosticsDisable,
  diagnosticsEnable,
  diagnosticsExport,
  diagnosticsStatus,
} from './engine-ops.js';
