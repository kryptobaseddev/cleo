/**
 * Exodus subsystem public API barrel.
 *
 * Re-exports the public surface of the `cleo exodus` migration engine:
 * plan builder, migrate runner, verify runner, and status reporter.
 *
 * @module
 * @task T11248 (E5 · SG-DB-SUBSTRATE-V2)
 * @saga T11242
 */

export {
  clearExodusAborts,
  type ExodusAbortDetail,
  emitExodusAbort,
  exodusAbortEvents,
  getRecordedExodusAbort,
} from './abort-events.js';
export {
  type ArchivedSourceResult,
  type ArchiveMigratedSourcesResult,
  archiveMigratedSources,
  archiveSourceDb,
  archiveStrandedResidue,
  detectStrandedResidue,
  type ExodusCompleteMarker,
  exodusArchiveDir,
  exodusMarkerPath,
  hasExodusCompleteMarker,
  type StrandedResidueEntry,
  writeExodusCompleteMarker,
} from './archive.js';
export {
  type CountParityEntry,
  type CountParityResult,
  computeCountParity,
} from './count-parity.js';
export {
  buildExodusHealth,
  type ExodusHealth,
  type ExodusScopeHealth,
  type ExodusScopeState,
  type ExodusSourceHealth,
} from './health.js';
export { clearExodusJournal, runExodusMigrate } from './migrate.js';
export { buildExodusPlan, deriveStagingDirName, sourcesPresent } from './plan.js';
export {
  type SealResult,
  type SealScopeArg,
  type SealScopeOutcome,
  sealExodus,
} from './seal.js';
export { runExodusStatus } from './status.js';
export {
  isDerivedOrInternalTable,
  resolveConsolidatedTableName,
  reverseLookup,
  type TableNameResolution,
} from './table-name-map.js';
export {
  EXODUS_TARGET_SCHEMA_VERSION,
  type ExodusJournal,
  type ExodusMigrateResult,
  type ExodusPlan,
  type ExodusScope,
  type ExodusStatusResult,
  type ExodusVerifyResult,
  type JournalTableEntry,
  type LegacyDbDescriptor,
  type TableCopyResult,
  type TableMigrationStatus,
  type VerifyTableResult,
} from './types.js';
export { runExodusVerify } from './verify.js';
export { verifyMigration } from './verify-migration.js';
