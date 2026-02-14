/**
 * Unified store interface for CLEO V2 data access.
 * @epic T4454
 * @task T4457
 */

export { atomicWrite, atomicWriteJson, safeReadFile } from './atomic.js';
export { createBackup, listBackups, restoreFromBackup } from './backup.js';
export { acquireLock, isLocked, withLock } from './lock.js';
export type { ReleaseFn } from './lock.js';
export {
  readJson,
  readJsonRequired,
  saveJson,
  appendJsonl,
  computeChecksum,
} from './json.js';
export type { SaveJsonOptions } from './json.js';
