/**
 * Unified store interface for CLEO V2 data access.
 * @epic T4454
 * @task T4457
 * @task T4645
 * @task T4745
 */

export { atomicWrite, atomicWriteJson, safeReadFile } from './atomic.js';
export { createBackup, listBackups, restoreFromBackup } from './backup.js';
export type { SafetyOptions } from './data-safety-central.js';
export {
  DataSafetyError,
  disableSafety,
  enableSafety,
  forceCheckpointBeforeOperation,
  forceSafetyCheckpoint,
  getSafetyStats,
  resetSafetyStats,
  runDataIntegrityCheck,
} from './data-safety-central.js';
export type { SaveJsonOptions } from './json.js';
export {
  appendJsonl,
  computeChecksum,
  readJson,
  readJsonRequired,
  saveJson,
} from './json.js';
export type { ReleaseFn } from './lock.js';
export { acquireLock, isLocked, withLock } from './lock.js';
export { type CleoDbRole, type DBHandle, openCleoDb } from './open-cleo-db.js';
export type {
  AddTaskOptions,
  AddTaskResult,
  AnalysisResult,
  ArchiveTasksOptions,
  ArchiveTasksResult,
  CompleteTaskOptions,
  CompleteTaskResult,
  DeleteTaskOptions,
  DeleteTaskResult,
  FindTasksOptions,
  FindTasksResult,
  ListTasksOptions,
  ListTasksResult,
  SessionFilters,
  StoreEngine,
  StoreProvider,
  TaskCurrentResult,
  TaskFilters,
  TaskStartResult,
  TaskWorkHistoryEntry,
  UpdateTaskOptions,
  UpdateTaskResult,
} from './provider.js';
export { createStoreProvider } from './provider.js';
// Safety-enabled DataAccessor exports (@task T4745)
export {
  getSafetyStatus,
  isSafetyEnabled,
  SafetyDataAccessor,
  wrapWithSafety,
} from './safety-data-accessor.js';
export type {
  NewSkillRow,
  SkillRow,
  SkillSourceType,
} from './schema/skills-schema.js';
// Skills DB helpers (per-user skills.db chokepoint — T9651 / T9657)
export {
  closeSkillsDb,
  getDefaultSkillsDbPath,
  getSkillRow,
  getSkillsNativeDb,
  listSkillsBySource,
  openSkillsDb,
  resetSkillsDbState,
  SKILLS_DB_FILENAME,
  SKILLS_SCHEMA_VERSION,
  upsertSkillRow,
} from './skills-db.js';
export {
  listBrainBackups,
  listSqliteBackups,
  listSqliteBackupsAll,
  vacuumIntoBackup,
  vacuumIntoBackupAll,
} from './sqlite-backup.js';
export { UmbrellaDataAccessor } from './umbrella-data-accessor.js';

/**
 * Get a StoreProvider instance for the given working directory.
 * Convenience wrapper around createStoreProvider with auto-detection.
 *
 * @task T4645
 * @epic T4638
 */
export async function getStore(cwd?: string): Promise<import('./provider.js').StoreProvider> {
  const { createStoreProvider: create } = await import('./provider.js');
  return create(undefined, cwd);
}
