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

export { runExodusMigrate } from './migrate.js';
export { buildExodusPlan, deriveStagingDirName, sourcesPresent } from './plan.js';
export { runExodusStatus } from './status.js';
export {
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
