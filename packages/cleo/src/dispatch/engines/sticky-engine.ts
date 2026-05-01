/**
 * Sticky Engine — re-export shim.
 *
 * All business logic has been migrated to `@cleocode/core/sticky/engine-ops`
 * (ENG-MIG-10 / T1577). This file is a pure re-export shim kept to avoid
 * breaking existing imports in the dispatch domain layer.
 *
 * @task T1577 — ENG-MIG-10
 * @epic T1566
 */

// Re-export EngineResult for consumers (canonical location: @cleocode/core)
export type { EngineResult } from '@cleocode/core';

export {
  stickyAdd,
  stickyArchive,
  stickyConvertToMemory,
  stickyConvertToSessionNote,
  stickyConvertToTask,
  stickyConvertToTaskNote,
  stickyList,
  stickyListFiltered,
  stickyPurge,
  stickyShow,
} from '@cleocode/core/internal';
