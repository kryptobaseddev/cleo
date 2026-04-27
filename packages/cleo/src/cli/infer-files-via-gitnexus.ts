/**
 * File inference via GitNexus query — re-export shim.
 *
 * The canonical implementation has moved to `packages/core/src/tasks/infer-add-params.ts`
 * (T1490). This module re-exports `inferFilesViaGitNexus` for backward
 * compatibility with any existing consumers and tests that import from this path.
 *
 * @task T1330
 * @task T1490
 */

export { inferFilesViaGitNexus } from '@cleocode/core';
