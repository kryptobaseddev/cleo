/**
 * System operations core module barrel.
 * @task T4783
 */

export type {
  AnalyticsTask,
  AnalyzeArchiveOptions,
  ArchiveAnalyticsResult,
  ArchiveMetadata,
  ArchiveReportDataMap,
  ArchiveReportType,
  CycleTimeDistribution,
  CycleTimePercentiles,
  CycleTimesReportData,
  DailyArchiveEntry,
  EmptyArchiveData,
  LabelFrequencyEntry,
  MonthlyArchiveEntry,
  PhaseGroupEntry,
  PriorityGroupEntry,
  SummaryReportData,
  TrendsReportData,
} from './archive-analytics.js';
export {
  analyzeArchive,
  byLabelReport,
  byPhaseReport,
  byPriorityReport,
  cycleTimesReport,
  filterByDate,
  summaryReport,
  trendsReport,
} from './archive-analytics.js';
export type { ArchiveStatsResult } from './archive-stats.js';
export { getArchiveStats } from './archive-stats.js';
export type { AuditIssue, AuditResult, LogQueryData } from './audit.js';
export { auditData, queryAuditLog } from './audit.js';
export type { BackupResult, FileRestoreResult, RestoreResult } from './backup.js';
export { createBackup, fileRestore, restoreBackup } from './backup.js';
export { resolveBridgeMode } from './bridge-mode.js';
export type { CleanupResult } from './cleanup.js';
export { cleanupSystem } from './cleanup.js';
export type {
  DiagnosticsCheck,
  DiagnosticsResult,
  DoctorCheck,
  DoctorReport,
  HealthCheck,
  HealthResult,
} from './health.js';
export { coreDoctorReport, getSystemDiagnostics, getSystemHealth } from './health.js';
export type { InjectGenerateResult } from './inject-generate.js';
export { generateInjection } from './inject-generate.js';
export type { LabelsResult } from './labels.js';
export { getLabels } from './labels.js';
export type { SystemMetricsResult } from './metrics.js';
export { getSystemMetrics } from './metrics.js';
export type { MigrateResult } from './migrate.js';
export { getMigrationStatus } from './migrate.js';
export type { PathsData } from './platform-paths.js';
export { getSystemPaths } from './platform-paths.js';
export type {
  CheckAllOptions,
  DbProbeResult,
  FullHealthReport,
  GlobalHealthReport,
  JsonFileProbe,
  ProjectHealthReport,
  ProjectHealthStatus,
} from './project-health.js';
export {
  checkAllRegisteredProjects,
  checkGlobalHealth,
  checkProjectHealth,
  probeDb,
} from './project-health.js';
export type { RuntimeDiagnostics } from './runtime.js';
export { getRuntimeDiagnostics } from './runtime.js';
export type { SafestopResult, UncancelResult } from './safestop.js';
export { safestop, uncancelTask } from './safestop.js';
export type { PreflightResult } from './storage-preflight.js';
export { checkStorageMigration } from './storage-preflight.js';
// Wave 2: new system exports (T1571)
export type { SyncData } from './sync.js';
export { systemSync } from './sync.js';
// T1868: rogue .cleo/ directory forensic scanner
export type {
  DrizzleMigrationEntry,
  RogueDbRowCounts,
  RogueDirReport,
  RogueFileEntry,
} from './rogue-cleo-detector.js';
export { quarantineRogueCleoDir, scanRogueCleoDirs } from './rogue-cleo-detector.js';
