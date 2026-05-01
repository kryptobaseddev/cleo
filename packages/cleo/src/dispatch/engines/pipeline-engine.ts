/**
 * Pipeline Engine — re-export shim.
 *
 * All business logic has been migrated to `@cleocode/core/pipeline/engine-ops`
 * (ENG-MIG-11 / T1578). This file is a pure re-export shim kept to avoid
 * breaking existing imports in the dispatch domain layer.
 *
 * @task T1578 — ENG-MIG-11
 * @epic T1566
 */

// Re-export EngineResult for consumers (canonical location: @cleocode/core)
export type { EngineResult } from '@cleocode/core';

export {
  phaseAdvance,
  phaseComplete,
  phaseDelete,
  phaseList,
  phaseRename,
  phaseSet,
  phaseShow,
  phaseStart,
} from '@cleocode/core/internal';
