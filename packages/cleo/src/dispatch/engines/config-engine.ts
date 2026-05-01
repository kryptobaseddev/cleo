/**
 * Config Engine — re-export shim.
 *
 * All business logic has been migrated to `packages/core/src/config/engine-ops.ts`
 * (ENG-MIG-15 / T1582 / ADR-057 D1). This file is a thin re-export shim
 * so any legacy direct imports of this module continue to resolve.
 *
 * Consumers SHOULD import from `@cleocode/core/internal` directly.
 *
 * @task T1582 — ENG-MIG-15
 * @epic T1566
 */

export {
  configGet,
  configListPresets,
  configSet,
  configSetPreset,
} from '@cleocode/core/internal';
