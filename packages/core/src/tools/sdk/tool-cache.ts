/**
 * ToolCache SDK Tool — Category B re-export entry point.
 *
 * Canonical SDK path for content-addressed, cross-process cached tool
 * execution (ADR-061). Every evidence-capture pathway that runs a project
 * tool (test, lint, typecheck, etc.) MUST go through `runToolCached` and
 * `acquireGlobalSlot` from this path.
 *
 * The implementation lives in `../../tasks/tool-cache.ts` and
 * `../../tasks/tool-semaphore.ts` (domain locations); this file is the
 * SDK-surface barrier.
 *
 * T1818 will fill this stub with the actual re-export once ADR-064 is written.
 *
 * @arch See ADR-064 (Category B SDK Tool: ToolCache)
 * @task T1815
 * @epic T1768
 */
export type {
  RunToolOptions,
  ToolCacheEntry,
  ToolRunResult,
} from '../../tasks/tool-cache.js';

export { runToolCached } from '../../tasks/tool-cache.js';

export type { AcquireSlotOptions, ReleaseSlotFn } from '../../tasks/tool-semaphore.js';

export { acquireGlobalSlot } from '../../tasks/tool-semaphore.js';
