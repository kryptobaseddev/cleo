/**
 * Re-export shim — tree-rendering context now lives in
 * `@cleocode/core/render/tree-context`.
 *
 * Kept as a thin shim so that `packages/cleo/src/cli/commands/deps.ts` and the
 * tree-visualization e2e test continue to import from this historical
 * location without B6 needing to coordinate a cross-file rename. Delete this
 * shim once those callers have been updated to import directly from
 * `@cleocode/core`.
 *
 * Migrated by T10131 (B6).
 *
 * @task T1205
 * @task T1206
 * @task T10131
 */

export type { TreeContext } from '@cleocode/core';
export { getTreeContext, setTreeContext } from '@cleocode/core';
