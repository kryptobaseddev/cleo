/**
 * System Domain Operations (12 operations)
 *
 * Query operations: 5
 * Mutate operations: 7
 */

/**
 * Common system types
 */
export interface HealthCheck {
  component: string;
  healthy: boolean;
  message?: string;
}

export interface ProjectStats {
  tasks: {
    total: number;
    pending: number;
    active: number;
    blocked: number;
    done: number;
  };
  sessions: {
    total: number;
    active: number;
  };
  research: {
    total: number;
    complete: number;
  };
}

/**
 * Query Operations
 */

// system.version
export type SystemVersionParams = Record<string, never>;
export interface SystemVersionResult {
  version: string;
  schemaVersion: string;
  buildDate: string;
}

// system.doctor
export type SystemDoctorParams = Record<string, never>;
export interface SystemDoctorResult {
  healthy: boolean;
  checks: HealthCheck[];
  warnings: string[];
  errors: string[];
}

// system.config.get
export interface SystemConfigGetParams {
  key: string;
}
export interface SystemConfigGetResult {
  key: string;
  value: unknown;
  type: string;
}

// system.stats
export type SystemStatsParams = Record<string, never>;
export type SystemStatsResult = ProjectStats;

// system.context
export type SystemContextParams = Record<string, never>;
export interface SystemContextResult {
  currentTokens: number;
  maxTokens: number;
  percentUsed: number;
  level: 'safe' | 'medium' | 'high' | 'critical';
  estimatedFiles: number;
  largestFile: {
    path: string;
    tokens: number;
  };
}

/**
 * Mutate Operations
 */

// system.init
export interface SystemInitParams {
  projectType?: 'nodejs' | 'python' | 'bash' | 'typescript' | 'rust' | 'go';
  detect?: boolean;
}
export interface SystemInitResult {
  initialized: boolean;
  projectType?: string;
  filesCreated: string[];
  detectedFeatures?: Record<string, boolean>;
}

// system.config.set
export interface SystemConfigSetParams {
  key: string;
  value: unknown;
}
export interface SystemConfigSetResult {
  key: string;
  value: unknown;
  previousValue?: unknown;
}

// system.backup
export interface SystemBackupParams {
  type?: 'snapshot' | 'safety' | 'archive' | 'migration';
  note?: string;
}
export interface SystemBackupResult {
  backupId: string;
  type: string;
  timestamp: string;
  files: string[];
  size: number;
}

// system.restore
export interface SystemRestoreParams {
  backupId: string;
}
export interface SystemRestoreResult {
  backupId: string;
  restored: string;
  filesRestored: string[];
}

// system.migrate
export interface SystemMigrateParams {
  version?: string;
  dryRun?: boolean;
}
export interface SystemMigrateResult {
  fromVersion: string;
  toVersion: string;
  migrations: Array<{
    name: string;
    applied: boolean;
    error?: string;
  }>;
  dryRun: boolean;
}

// system.sync
export interface SystemSyncParams {
  direction?: 'push' | 'pull' | 'bidirectional';
}
export interface SystemSyncResult {
  direction: string;
  synced: string;
  tasksSynced: number;
  conflicts: Array<{
    taskId: string;
    resolution: string;
  }>;
}

// system.cleanup
export interface SystemCleanupParams {
  type: 'backups' | 'logs' | 'archive' | 'sessions';
  olderThan?: string;
}
export interface SystemCleanupResult {
  type: string;
  cleaned: number;
  freed: number;
  items: string[];
}
