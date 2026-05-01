/**
 * Init Engine — re-export shim.
 *
 * All business logic has been migrated to `packages/core/src/init/engine-ops.ts`
 * (ENG-MIG-14 / T1581 / ADR-057 D1). This file is a thin re-export shim
 * so any legacy direct imports of this module continue to resolve.
 *
 * Consumers SHOULD import from `@cleocode/core/internal` directly.
 *
 * @task T1581 — ENG-MIG-14
 * @epic T1566
 */

export {
  ensureInitialized,
  getVersion,
  initProject,
  isAutoInitEnabled,
} from '@cleocode/core/internal';
