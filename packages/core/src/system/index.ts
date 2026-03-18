/**
 * System operations core module barrel.
 * @task T4783
 */

export type {
  AnalyzeArchiveOptions,
  AnalyticsTask,
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
export type { AuditIssue, AuditResult } from './audit.js';
export { auditData } from './audit.js';
export type { BackupResult, RestoreResult } from './backup.js';
export { createBackup, restoreBackup } from './backup.js';
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
export type { RuntimeDiagnostics } from './runtime.js';
export { getRuntimeDiagnostics } from './runtime.js';
export type { SafestopResult, UncancelResult } from './safestop.js';
export { safestop, uncancelTask } from './safestop.js';
export type { PreflightResult } from './storage-preflight.js';
export { checkStorageMigration } from './storage-preflight.js';
