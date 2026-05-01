/**
 * Lifecycle Engine — re-export shim.
 *
 * All business logic has been migrated to `@cleocode/core/lifecycle/engine-ops`
 * (ENG-MIG-9 / T1576). This file is a pure re-export shim kept to avoid
 * breaking existing imports in the dispatch domain layer.
 *
 * @task T1576 — ENG-MIG-9
 * @epic T1566
 */

// Re-export EngineResult for consumers (canonical location: @cleocode/core)
export type { EngineResult } from '@cleocode/core';

export {
  enforceScopeForLifecycleMutation,
  lifecycleCheck,
  lifecycleGateFail,
  lifecycleGatePass,
  lifecycleGates,
  lifecycleHistory,
  lifecyclePrerequisites,
  lifecycleProgress,
  lifecycleReset,
  lifecycleSkip,
  lifecycleStatus,
  listRcsdEpics,
} from '@cleocode/core/internal';
