/**
 * Hooks Engine — re-export shim.
 *
 * All business logic has been migrated to `@cleocode/core/hooks/engine-ops`
 * (ENG-MIG-12 / T1579). This file is a pure re-export shim kept to avoid
 * breaking existing imports in the dispatch domain layer.
 *
 * @task T1579 — ENG-MIG-12
 * @epic T1566
 */

export type { HookMatrixResult, ProviderMatrixEntry } from '@cleocode/core/internal';
export { queryCommonHooks, queryHookProviders, systemHooksMatrix } from '@cleocode/core/internal';
