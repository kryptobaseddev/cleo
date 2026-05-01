/**
 * Code Engine — re-export shim.
 *
 * All business logic has been migrated to `packages/core/src/code/engine-ops.ts`
 * (ENG-MIG-16 / T1583 / ADR-057 D1). This file is a thin re-export shim
 * so any legacy direct imports of this module continue to resolve.
 *
 * Consumers SHOULD import from `@cleocode/core/internal` directly.
 *
 * @task T1583 — ENG-MIG-16
 * @epic T1566
 */

export { codeOutline, codeParse, codeSearch, codeUnfold } from '@cleocode/core/internal';
