/**
 * System operations core module barrel.
 * @task T4783
 */

export { getLabels } from './labels.js';
export type { LabelsResult } from './labels.js';

export { getArchiveStats } from './archive-stats.js';
export type { ArchiveStatsResult } from './archive-stats.js';

export { getSystemHealth, getSystemDiagnostics, coreDoctorReport } from './health.js';
export type { HealthResult, HealthCheck, DiagnosticsResult, DiagnosticsCheck, DoctorReport, DoctorCheck } from './health.js';

export { createBackup, restoreBackup } from './backup.js';
export type { BackupResult, RestoreResult } from './backup.js';

export { cleanupSystem } from './cleanup.js';
export type { CleanupResult } from './cleanup.js';

export { auditData } from './audit.js';
export type { AuditResult, AuditIssue } from './audit.js';

export { safestop, uncancelTask } from './safestop.js';
export type { SafestopResult, UncancelResult } from './safestop.js';

export { getMigrationStatus } from './migrate.js';
export type { MigrateResult } from './migrate.js';

export { getSystemMetrics } from './metrics.js';
export type { SystemMetricsResult } from './metrics.js';

export { generateInjection } from './inject-generate.js';
export type { InjectGenerateResult } from './inject-generate.js';
