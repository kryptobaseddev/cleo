/**
 * Diagnostics Engine — re-export shim.
 *
 * All business logic has been migrated to `@cleocode/core/diagnostics/engine-ops`
 * (ENG-MIG-13 / T1580). This file is a pure re-export shim kept to avoid
 * breaking existing imports in the dispatch domain layer.
 *
 * @task T1580 — ENG-MIG-13
 * @epic T1566
 */

// Re-export EngineResult for consumers (canonical location: @cleocode/core)
export type { EngineResult } from '@cleocode/core';

export {
  diagnosticsAnalyze,
  diagnosticsDisable,
  diagnosticsEnable,
  diagnosticsExport,
  diagnosticsStatus,
} from '@cleocode/core/internal';
