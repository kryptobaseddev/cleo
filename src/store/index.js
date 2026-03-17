/**
 * Unified store interface for CLEO V2 data access.
 * @epic T4454
 * @task T4457
 * @task T4645
 * @task T4745
 */
export { atomicWrite, atomicWriteJson, safeReadFile } from './atomic.js';
export { createBackup, listBackups, restoreFromBackup } from './backup.js';
export { forceCheckpointBeforeOperation } from './data-safety.js';
export { DataSafetyError, disableSafety, enableSafety, forceSafetyCheckpoint, getSafetyStats, resetSafetyStats, runDataIntegrityCheck, } from './data-safety-central.js';
export { appendJsonl, computeChecksum, readJson, readJsonRequired, saveJson, } from './json.js';
export { acquireLock, isLocked, withLock } from './lock.js';
export { createStoreProvider } from './provider.js';
// Safety-enabled DataAccessor exports (@task T4745)
export { getSafetyStatus, isSafetyEnabled, SafetyDataAccessor, wrapWithSafety, } from './safety-data-accessor.js';
/**
 * Get a StoreProvider instance for the given working directory.
 * Convenience wrapper around createStoreProvider with auto-detection.
 *
 * @task T4645
 * @epic T4638
 */
export async function getStore(cwd) {
    const { createStoreProvider: create } = await import('./provider.js');
    return create(undefined, cwd);
}
//# sourceMappingURL=index.js.map