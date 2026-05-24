/**
 * @cleocode/core/doctor — Programmatic primitives for `cleo doctor` flows.
 *
 * Today this module owns the worktree-orphan audit + prune surface
 * introduced by T9790 (E-DOCS-WORKTREE-CLEANUP) and the comprehensive
 * worktree anomaly audit introduced by T9808 (council D009 closure).
 *
 * Future doctor probes should live here too, keeping `cleo doctor` itself a
 * thin CLI shell over CORE primitives.
 *
 * @see ../../validation/doctor/checks.ts — the older, validation-suite
 *   style probes (auditOrphanWorktrees / auditOrphanTempDirs) that pre-date
 *   this module and are kept for backwards compatibility.
 *
 * @task T9790
 * @task T9808
 * @epic T9790
 * @epic T9808
 */

// T10307 — DB-substrate survey (Saga T10281 SG-BRAIN-DB-RESILIENCE / Epic T10282)
// T10310 — Per-DB pragma drift (Saga T10281 SG-BRAIN-DB-RESILIENCE / Epic T10283)
export {
  computeSubstrateProjectId,
  detectNestedNexusDuplicates,
  detectOrphanProjectRootWarning,
  inspectDbFile,
  resolveInventoryFilePath,
  summarizeSubstrateSurveys,
  surveyDbSubstrate,
  surveyFleetDbSubstrate,
  surveyProjectDbSubstrate,
  walkPragmaDrift,
} from './db-substrate.js';
// T10309 — Legacy-backup walker (Saga T10281 SG-BRAIN-DB-RESILIENCE / Epic T10282)
export type { LegacyBackupPruneOptions, LegacyBackupScanOptions } from './legacy-backups.js';
export {
  classifyLegacyBackup,
  DEFAULT_HARD_RETENTION_DAYS,
  DEFAULT_SOFT_RETENTION_DAYS,
  isLegacyBackupFilename,
  legacyBackupSearchRoots,
  pruneLegacyBackups,
  recommendForBackup,
  scanLegacyBackups,
} from './legacy-backups.js';
export type { PragmaSsot, PragmaSsotEntry } from './pragma-ssot.js';
export {
  loadPragmaSsot,
  normalisePragmaValue,
  PRAGMA_VALUE_NORMALISERS,
} from './pragma-ssot.js';
export { auditSagaHierarchy } from './saga-audit.js';
export type { PruneOptions, ScanOptions } from './worktree-orphans.js';
export {
  auditWorktreeOrphansComprehensive,
  pruneWorktreeOrphans,
  scanWorktreeOrphans,
} from './worktree-orphans.js';
