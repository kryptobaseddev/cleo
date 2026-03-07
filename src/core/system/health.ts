/**
 * System health checks core module.
 * @task T4783
 * @task T4795
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { getAgentsHome, isProjectInitialized } from '../paths.js';
import { getSystemInfo, type SystemInfo } from '../platform.js';
import { checkStorageMigration } from './storage-preflight.js';
import { checkCleoGitignore, checkVitalFilesTracked, checkCoreFilesNotIgnored, checkLegacyAgentOutputs, checkNodeVersion, type CheckResult } from '../validation/doctor/checks.js';
import { getAccessor } from '../../store/data-accessor.js';
import {
  checkProjectInfo,
  checkProjectContext,
  checkCleoStructure,
  checkConfig,
  checkSqliteDb,
  checkGlobalHome,
  checkGlobalTemplates,
  checkLogDir,
  ensureGlobalScaffold,
  ensureCleoStructure,
} from '../scaffold.js';
import { checkGitHooks, type HookCheckResult } from '../hooks.js';
import { checkGlobalSchemas, type CheckResult as SchemaCheckResult } from '../schema-management.js';
import { checkInjection } from '../injection.js';

const execAsync = promisify(execFile);
const _require = createRequire(import.meta.url);

type SqliteModule = typeof import('node:sqlite');
const databaseSyncCtor = (() => {
  try {
    return (_require('node:sqlite') as SqliteModule).DatabaseSync;
  } catch {
    return null;
  }
})();

/** Stale JSON files that should not exist alongside tasks.db (ADR-006). */
const STALE_JSON_FILES = ['todo.json', 'sessions.json', 'todo-archive.json'] as const;

function resolveStructuredLogPath(cleoDir: string): string {
  const defaultPath = join(cleoDir, 'logs', 'cleo.log');
  const configPath = join(cleoDir, 'config.json');
  if (!existsSync(configPath)) return defaultPath;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      logging?: { filePath?: string }
    };
    if (!config.logging?.filePath) return defaultPath;
    return join(cleoDir, config.logging.filePath);
  } catch {
    return defaultPath;
  }
}

function checkAuditLogAvailability(dbPath: string): HealthCheck {
  if (!databaseSyncCtor) {
    return {
      name: 'audit_log',
      status: 'warn',
      message: 'audit_log check unavailable: node:sqlite runtime not found',
    };
  }

  try {
    const db = new databaseSyncCtor(dbPath, { readOnly: true });
    try {
      const tableRow = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'",
      ).get() as { name?: string } | undefined;

      if (!tableRow?.name) {
        return {
          name: 'audit_log',
          status: 'fail',
          message: 'audit_log table missing from tasks.db (run: cleo upgrade)',
        };
      }

      const countRow = db.prepare('SELECT COUNT(1) AS count FROM audit_log').get() as { count?: number } | undefined;
      return {
        name: 'audit_log',
        status: 'pass',
        message: `audit_log table available (${countRow?.count ?? 0} rows)`,
      };
    } finally {
      db.close();
    }
  } catch {
    return {
      name: 'audit_log',
      status: 'warn',
      message: 'Unable to validate audit_log availability from tasks.db',
    };
  }
}

export interface HealthCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message?: string;
}

export interface HealthResult {
  overall: 'healthy' | 'warning' | 'error';
  checks: HealthCheck[];
  version: string;
  installation: 'ok' | 'degraded';
}

export interface DiagnosticsCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  details?: string;
  fix?: string;
}

export interface DiagnosticsResult {
  timestamp: string;
  checks: DiagnosticsCheck[];
  summary: {
    total: number;
    passed: number;
    warned: number;
    failed: number;
  };
}

/** Run system health checks (SQLite-first per ADR-006). */
export function getSystemHealth(
  projectRoot: string,
  opts?: { detailed?: boolean },
): HealthResult {
  const cleoDir = join(projectRoot, '.cleo');
  const checks: HealthCheck[] = [];

  // Check .cleo directory
  if (existsSync(cleoDir)) {
    checks.push({ name: 'cleo_dir', status: 'pass', message: '.cleo directory exists' });
  } else {
    checks.push({ name: 'cleo_dir', status: 'fail', message: '.cleo directory not found' });
  }

  // Check tasks.db (primary data store per ADR-006)
  const dbPath = join(cleoDir, 'tasks.db');
  if (existsSync(dbPath)) {
    try {
      const dbSize = statSync(dbPath).size;
      if (dbSize > 0) {
        checks.push({ name: 'tasks_db', status: 'pass', message: `tasks.db: ${dbSize} bytes` });
      } else {
        checks.push({ name: 'tasks_db', status: 'warn', message: 'tasks.db exists but is empty' });
      }
    } catch {
      checks.push({ name: 'tasks_db', status: 'fail', message: 'tasks.db exists but is not readable' });
    }
  } else {
    checks.push({ name: 'tasks_db', status: 'fail', message: 'tasks.db not found' });
  }

  if (existsSync(dbPath)) {
    checks.push(checkAuditLogAvailability(dbPath));
  }

  // Check config.json (config remains JSON per ADR-006)
  const configPath = join(cleoDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      JSON.parse(readFileSync(configPath, 'utf-8'));
      checks.push({ name: 'config_json', status: 'pass', message: 'config.json is valid JSON' });
    } catch {
      checks.push({ name: 'config_json', status: 'warn', message: 'config.json is not valid JSON' });
    }
  } else {
    checks.push({ name: 'config_json', status: 'warn', message: 'config.json not found' });
  }

  // Check for stale JSON files alongside tasks.db
  if (existsSync(dbPath)) {
    const staleFiles = STALE_JSON_FILES.filter(f => existsSync(join(cleoDir, f)));
    if (staleFiles.length > 0) {
      checks.push({
        name: 'stale_json',
        status: 'warn',
        message: `Stale JSON files found alongside tasks.db: ${staleFiles.join(', ')}. Run: cleo upgrade`,
      });
    }
  }

  if (opts?.detailed) {
    const logPath = resolveStructuredLogPath(cleoDir);
    if (existsSync(logPath)) {
      checks.push({ name: 'log_file', status: 'pass', message: `structured log present: ${logPath}` });
    } else {
      checks.push({ name: 'log_file', status: 'warn', message: `structured log not found: ${logPath}` });
    }

    const backupDir = join(cleoDir, '.backups');
    if (existsSync(backupDir)) {
      checks.push({ name: 'backups_dir', status: 'pass', message: '.backups directory exists' });
    } else {
      checks.push({ name: 'backups_dir', status: 'pass', message: 'No backups directory (created on first write)' });
    }
  }

  // Get version
  let version = 'unknown';
  try {
    const pkgPath = join(projectRoot, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      version = pkg.version || 'unknown';
    }
  } catch {
    // fallback
  }

  const failCount = checks.filter(c => c.status === 'fail').length;
  const warnCount = checks.filter(c => c.status === 'warn').length;
  const overall: HealthResult['overall'] = failCount > 0 ? 'error' : warnCount > 0 ? 'warning' : 'healthy';
  const installation: HealthResult['installation'] = failCount > 0 ? 'degraded' : 'ok';

  return { overall, checks, version, installation };
}

/** Run extended diagnostics with fix suggestions. */
export async function getSystemDiagnostics(
  projectRoot: string,
  opts?: { checks?: string[] },
): Promise<DiagnosticsResult> {
  const healthResult = getSystemHealth(projectRoot, { detailed: true });

  const diagChecks: DiagnosticsCheck[] = healthResult.checks.map(c => ({
    name: c.name,
    status: c.status,
    details: c.message,
    fix: c.status === 'fail'
      ? c.name === 'cleo_dir' ? 'Run: cleo init' :
        c.name === 'tasks_db' ? 'Run: cleo init (or restore from backup)' :
        undefined
      : undefined,
  }));

  // Storage migration pre-flight check
  const preflight = checkStorageMigration(projectRoot);
  if (preflight.migrationNeeded) {
    diagChecks.push({
      name: 'storage_migration',
      status: 'fail',
      details: preflight.summary,
      fix: preflight.fix ?? undefined,
    });
  } else {
    diagChecks.push({
      name: 'storage_migration',
      status: 'pass',
      details: preflight.summary,
    });
  }

  // Schema version check — read via DataAccessor (per ADR-006)
  const cleoDir = join(projectRoot, '.cleo');
  const dbPath = join(cleoDir, 'tasks.db');
  if (existsSync(dbPath)) {
    try {
      const accessor = await getAccessor(projectRoot);
      const schemaVersion = await accessor.getSchemaVersion?.();
      if (schemaVersion) {
        diagChecks.push({ name: 'schema_version', status: 'pass', details: `Schema version: ${schemaVersion}` });
      } else {
        diagChecks.push({ name: 'schema_version', status: 'warn', details: 'No schema version in SQLite', fix: 'Run: cleo upgrade' });
      }
    } catch {
      diagChecks.push({ name: 'schema_version', status: 'warn', details: 'Could not read schema version from SQLite', fix: 'Run: cleo upgrade' });
    }
  }

  // Check for stale sessions — read from SQLite accessor
  if (existsSync(dbPath)) {
    try {
      const accessor = await getAccessor(projectRoot);
      const sessions = await accessor.loadSessions();
      const activeSessions = sessions.filter((s) => s.status === 'active');
      if (activeSessions.length > 3) {
        diagChecks.push({
          name: 'stale_sessions',
          status: 'warn',
          details: `${activeSessions.length} active sessions (may include stale)`,
          fix: 'Run: cleo session gc',
        });
      } else {
        diagChecks.push({ name: 'stale_sessions', status: 'pass', details: `${activeSessions.length} active session(s)` });
      }
    } catch {
      // skip
    }
  }

  // Filter checks if specific ones requested
  let filteredChecks = diagChecks;
  if (opts?.checks && opts.checks.length > 0) {
    filteredChecks = diagChecks.filter(c => opts.checks!.includes(c.name));
  }

  const passedCount = filteredChecks.filter(c => c.status === 'pass').length;
  const warnedCount = filteredChecks.filter(c => c.status === 'warn').length;
  const failedCount = filteredChecks.filter(c => c.status === 'fail').length;

  return {
    timestamp: new Date().toISOString(),
    checks: filteredChecks,
    summary: { total: filteredChecks.length, passed: passedCount, warned: warnedCount, failed: failedCount },
  };
}

// ============================================================================
// Doctor Report (Comprehensive)
// ============================================================================

export interface DoctorCheck {
  check: string;
  status: 'ok' | 'error' | 'warning';
  message: string;
  details?: Record<string, unknown>;
  fix?: string;
}

export interface DoctorReport {
  healthy: boolean;
  errors: number;
  warnings: number;
  checks: DoctorCheck[];
}

async function commandExists(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync('which', [cmd]);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

function mapCheckResult(cr: CheckResult): DoctorCheck {
  return {
    check: cr.id,
    status: cr.status === 'passed' ? 'ok' : cr.status === 'info' ? 'ok' : cr.status === 'warning' ? 'warning' : 'error',
    message: cr.message,
    ...(cr.fix ? { fix: cr.fix } : {}),
  };
}

/** Map HookCheckResult[] from hooks.ts into a single DoctorCheck summary. */
function mapHookResults(results: HookCheckResult[]): DoctorCheck {
  const missing = results.filter(r => !r.installed);
  const stale = results.filter(r => r.installed && !r.current);

  if (missing.length > 0) {
    return {
      check: 'git_hooks',
      status: 'warning',
      message: `Missing git hooks: ${missing.map(r => r.hook).join(', ')}`,
      details: { missing: missing.map(r => r.hook), fix: 'cleo init --force' },
    };
  }

  if (stale.length > 0) {
    return {
      check: 'git_hooks',
      status: 'warning',
      message: `Stale git hooks: ${stale.map(r => r.hook).join(', ')}`,
      details: { stale: stale.map(r => r.hook), fix: 'cleo upgrade' },
    };
  }

  return {
    check: 'git_hooks',
    status: 'ok',
    message: `All ${results.length} managed git hooks installed and current`,
  };
}

/** Map schema-management.ts CheckResult into a DoctorCheck. */
function mapSchemaCheckResult(sr: SchemaCheckResult): DoctorCheck {
  if (sr.missing.length > 0) {
    return {
      check: 'global_schemas',
      status: 'warning',
      message: `Missing global schemas: ${sr.missing.join(', ')}`,
      details: { missing: sr.missing, fix: 'cleo upgrade' },
    };
  }

  if (sr.stale.length > 0) {
    return {
      check: 'global_schemas',
      status: 'warning',
      message: `Stale global schemas: ${sr.stale.join(', ')}`,
      details: { stale: sr.stale, fix: 'cleo upgrade' },
    };
  }

  return {
    check: 'global_schemas',
    status: 'ok',
    message: `All ${sr.installed} global schemas installed and current`,
  };
}

/**
 * Check contributor project dev channel availability and health.
 * No-op for non-contributor projects (ADR-029).
 *
 * Reports whether cleo-dev is on PATH and responsive. Does NOT mandate
 * using cleo-dev — agents should prefer it when healthy, fall back to
 * production cleo when the dev build is broken.
 */
function checkContributorChannel(projectRoot: string): DoctorCheck {
  const configPath = join(projectRoot, '.cleo', 'config.json');
  if (!existsSync(configPath)) {
    return { check: 'contributor_channel', status: 'ok', message: 'Not a contributor project' };
  }
  let isContributor = false;
  let devCli = 'cleo-dev';
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      contributor?: { isContributorProject?: boolean; devCli?: string };
    };
    isContributor = config.contributor?.isContributorProject === true;
    devCli = config.contributor?.devCli ?? 'cleo-dev';
  } catch {
    return { check: 'contributor_channel', status: 'ok', message: 'Not a contributor project' };
  }

  if (!isContributor) {
    return { check: 'contributor_channel', status: 'ok', message: 'Not a contributor project' };
  }

  // Check that cleo-dev is on PATH
  const pathDirs = (process.env['PATH'] ?? '').split(':').filter(Boolean);
  const devCliOnPath = pathDirs.some(dir => existsSync(join(dir, devCli)));

  if (!devCliOnPath) {
    return {
      check: 'contributor_channel',
      status: 'warning',
      message: `Contributor project: '${devCli}' not on PATH. Using production cleo. Run ./install.sh --dev to enable dev channel.`,
      fix: './install.sh --dev',
    };
  }

  // Probe whether the dev CLI actually responds
  try {
    const version = execFileSync(devCli, ['--version'], { timeout: 5000 }).toString().trim();
    return {
      check: 'contributor_channel',
      status: 'ok',
      message: `Contributor project: '${devCli}' healthy (v${version}). Prefer dev channel for unreleased features.`,
    };
  } catch {
    return {
      check: 'contributor_channel',
      status: 'warning',
      message: `Contributor project: '${devCli}' on PATH but not responding. Dev build may need rebuild (npm run build). Production cleo available as fallback.`,
      fix: 'npm run build',
    };
  }
}

/**
 * Run comprehensive doctor diagnostics combining dependency checks,
 * directory checks, data file checks, gitignore checks, and environment info.
 * @task T4795
 */
export async function coreDoctorReport(
  projectRoot: string,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  // 1. Check dependencies (jq removed — no longer needed since SQLite migration, ADR-006)
  const gitPath = await commandExists('git');
  checks.push({
    check: 'git_installed',
    status: gitPath ? 'ok' : 'warning',
    message: gitPath ? `git found: ${gitPath}` : 'git not found (optional, needed for version control features)',
  });

  // 2. Check CLEO directories
  const cleoDir = join(projectRoot, '.cleo');
  const dirExists = existsSync(cleoDir);
  checks.push({
    check: 'project_dir',
    status: dirExists ? 'ok' : 'error',
    message: dirExists ? `Project dir: ${cleoDir}` : `Project dir not found: ${cleoDir}. Run: cleo init`,
  });

  // 3. Check data files — SQLite is the primary store (ADR-006)
  const dbPath = join(cleoDir, 'tasks.db');
  const dbExists = existsSync(dbPath);
  const dbSize = await fileSize(dbPath);
  checks.push({
    check: 'tasks_db',
    status: dbExists ? 'ok' : 'error',
    message: dbExists
      ? `tasks.db: ${dbSize} bytes`
      : `tasks.db not found. Run: cleo init`,
  });

  if (dbExists) {
    try {
      const accessor = await getAccessor(projectRoot);
      const data = await accessor.loadTaskFile();
      const taskCount = data.tasks?.length ?? 0;
      const schemaVersion = data._meta?.schemaVersion ?? 'unknown';
      checks.push({
        check: 'tasks_db_data',
        status: 'ok',
        message: `${taskCount} tasks, schema v${schemaVersion}`,
        details: { taskCount, schemaVersion },
      });
    } catch {
      checks.push({
        check: 'tasks_db_data',
        status: 'error',
        message: 'Failed to read tasks from SQLite database',
      });
    }

    const auditLogCheck = checkAuditLogAvailability(dbPath);
    checks.push({
      check: 'audit_log',
      status: auditLogCheck.status === 'pass' ? 'ok' : auditLogCheck.status === 'warn' ? 'warning' : 'error',
      message: auditLogCheck.message ?? 'audit_log availability check completed',
      ...(auditLogCheck.status === 'fail' ? { fix: 'Run: cleo upgrade' } : {}),
    });

    // SQLite integrity check
    try {
      const { getNativeDb, getDb: getDbInit } = await import('../../store/sqlite.js');
      // Ensure the DB is initialized so getNativeDb() returns a valid handle
      await getDbInit(projectRoot);
      const nativeDb = getNativeDb();
      if (nativeDb) {
        const result = nativeDb.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined;
        const integrityOk = result?.integrity_check === 'ok';
        checks.push({
          check: 'sqlite_integrity',
          status: integrityOk ? 'ok' : 'warning',
          message: integrityOk ? 'SQLite integrity check passed' : 'SQLite integrity check reported issues',
          ...(integrityOk ? {} : { fix: 'Run: cleo upgrade' }),
        });
      }
    } catch {
      // SQLite integrity check is best-effort
    }
  }

  const configPath = join(cleoDir, 'config.json');
  const configExists = existsSync(configPath);
  checks.push({
    check: 'config_file',
    status: configExists ? 'ok' : 'warning',
    message: configExists ? 'config.json present' : 'config.json not found (using defaults)',
  });

  // Check for stale JSON files that should have been cleaned up after migration
  const staleJsonFiles = STALE_JSON_FILES.filter(f => existsSync(join(cleoDir, f)));
  if (dbExists && staleJsonFiles.length > 0) {
    checks.push({
      check: 'stale_json',
      status: 'warning',
      message: `Stale JSON files found alongside tasks.db: ${staleJsonFiles.join(', ')}. Run: cleo upgrade`,
      details: { files: staleJsonFiles },
    });
  }

  const logPath = resolveStructuredLogPath(cleoDir);
  const logExists = existsSync(logPath);
  checks.push({
    check: 'log_file',
    status: logExists ? 'ok' : 'warning',
    message: logExists ? `structured log present: ${logPath}` : `structured log not found: ${logPath}`,
  });

  // 4. Check root .gitignore for .cleo/ blocking
  const rootGitignorePath = join(projectRoot, '.gitignore');
  if (existsSync(rootGitignorePath)) {
    try {
      const gitignoreContent = readFileSync(rootGitignorePath, 'utf-8');
      const blockingLines = gitignoreContent.split('\n').filter(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') || trimmed === '') return false;
        return /^\/?\.cleo\/?(\*)?$/.test(trimmed);
      });
      checks.push({
        check: 'root_gitignore',
        status: blockingLines.length > 0 ? 'warning' : 'ok',
        message: blockingLines.length > 0
          ? `.cleo/ is ignored in root .gitignore. Run 'cleo init' to fix.`
          : 'Root .gitignore does not block .cleo/',
        ...(blockingLines.length > 0 ? { details: { blockingLines } } : {}),
      });
    } catch {
      // Ignore read errors for gitignore check
    }
  }

  // 5. Gitignore integrity, vital files, legacy paths (delegated to core checks)
  checks.push(mapCheckResult(checkCleoGitignore(projectRoot)));
  checks.push(mapCheckResult(checkVitalFilesTracked(projectRoot)));
  checks.push(mapCheckResult(checkCoreFilesNotIgnored(projectRoot)));
  checks.push(mapCheckResult(checkLegacyAgentOutputs(projectRoot)));

  // 5b. Isolated .cleo/.git checkpoint repo check (T4872)
  const cleoGitHeadExists = existsSync(join(cleoDir, '.git', 'HEAD'));
  checks.push({
    check: 'cleo_git_repo',
    status: cleoGitHeadExists ? 'ok' : 'warning',
    message: cleoGitHeadExists
      ? '.cleo/.git isolated checkpoint repo exists'
      : '.cleo/.git not found — run: cleo init',
  });

  // 5c. Global scaffold checks: home, templates, schemas
  checks.push(mapCheckResult(checkGlobalHome()));
  checks.push(mapCheckResult(checkGlobalTemplates()));
  checks.push(mapSchemaCheckResult(checkGlobalSchemas()));

  // 5d. Project scaffold checks: log dir, structure, git hooks, project-info, injection
  checks.push(mapCheckResult(checkLogDir(projectRoot)));

  const hookResults = await checkGitHooks(projectRoot);
  checks.push(mapHookResults(hookResults));

  checks.push(mapCheckResult(checkProjectInfo(projectRoot)));

  // Project context check
  checks.push(mapCheckResult(checkProjectContext(projectRoot)));

  checks.push(mapCheckResult(checkInjection(projectRoot)));

  // Contributor project channel check (ADR-029)
  checks.push(checkContributorChannel(projectRoot));

  // Agent definition presence check
  const agentDefPath = join(getAgentsHome(), 'agents', 'cleo-subagent');
  checks.push({
    check: 'agent_definition',
    status: existsSync(agentDefPath) ? 'ok' : 'warning',
    message: existsSync(agentDefPath)
      ? 'cleo-subagent agent definition installed'
      : 'cleo-subagent not found — run: cleo init',
    ...(existsSync(agentDefPath) ? {} : { fix: 'cleo init' }),
  });

  // 6. Environment - Node.js version validation
  checks.push(mapCheckResult(checkNodeVersion()));

  const sysInfo = getSystemInfo();
  checks.push({
    check: 'platform',
    status: 'ok',
    message: `${sysInfo.osType} ${sysInfo.osRelease} (${sysInfo.platform}/${sysInfo.arch}), Node ${sysInfo.nodeVersion}`,
    details: {
      platform: sysInfo.platform,
      arch: sysInfo.arch,
      osType: sysInfo.osType,
      osRelease: sysInfo.osRelease,
      nodeVersion: sysInfo.nodeVersion,
      totalMemory: sysInfo.totalMemory,
      freeMemory: sysInfo.freeMemory,
      hostname: sysInfo.hostname,
    },
  });

  // Summary
  const errorCount = checks.filter((c) => c.status === 'error').length;
  const warningCount = checks.filter((c) => c.status === 'warning').length;
  const healthy = errorCount === 0;

  return { healthy, errors: errorCount, warnings: warningCount, checks };
}

// ============================================================================
// Doctor --fix Support
// ============================================================================

export interface FixResult {
  check: string;
  action: 'fixed' | 'skipped' | 'failed';
  message: string;
}

/**
 * Run auto-fix for failed doctor checks by calling the corresponding ensure* functions.
 * Returns a list of fix results for each attempted repair.
 */
export async function runDoctorFixes(
  projectRoot: string,
): Promise<FixResult[]> {
  const { ensureCleoStructure, ensureGitignore, ensureConfig, ensureProjectInfo, ensureProjectContext, ensureCleoGitRepo, ensureGlobalHome, ensureGlobalTemplates } = await import('../scaffold.js');
  const { ensureGitHooks } = await import('../hooks.js');
  const { ensureGlobalSchemas } = await import('../schema-management.js');
  const { ensureInjection } = await import('../injection.js');

  const report = await coreDoctorReport(projectRoot);
  const failedChecks = report.checks.filter(c => c.status !== 'ok');
  const results: FixResult[] = [];

  // Map check names to their fix functions
  const fixMap: Record<string, () => Promise<FixResult>> = {
    project_dir: async () => {
      const r = await ensureCleoStructure(projectRoot);
      return { check: 'project_dir', action: r.action === 'skipped' ? 'skipped' : 'fixed', message: r.details ?? r.action };
    },
    cleo_gitignore: async () => {
      const r = await ensureGitignore(projectRoot);
      return { check: 'cleo_gitignore', action: r.action === 'skipped' ? 'skipped' : 'fixed', message: r.details ?? r.action };
    },
    config_file: async () => {
      const r = await ensureConfig(projectRoot);
      return { check: 'config_file', action: r.action === 'skipped' ? 'skipped' : 'fixed', message: r.details ?? r.action };
    },
    cleo_project_info: async () => {
      const r = await ensureProjectInfo(projectRoot, { force: true });
      return { check: 'cleo_project_info', action: r.action === 'skipped' ? 'skipped' : 'fixed', message: r.details ?? r.action };
    },
    cleo_project_context: async () => {
      const r = await ensureProjectContext(projectRoot, { force: true });
      return { check: 'cleo_project_context', action: r.action === 'skipped' ? 'skipped' : 'fixed', message: r.details ?? r.action };
    },
    cleo_git_repo: async () => {
      const r = await ensureCleoGitRepo(projectRoot);
      return { check: 'cleo_git_repo', action: r.action === 'skipped' ? 'skipped' : 'fixed', message: r.details ?? r.action };
    },
    contributor_channel: async () => {
      const { ensureContributorMcp } = await import('../scaffold.js');
      const r = await ensureContributorMcp(projectRoot);
      return { check: 'contributor_channel', action: r.action === 'skipped' ? 'skipped' : 'fixed', message: r.details ?? r.action };
    },
    git_hooks: async () => {
      const r = await ensureGitHooks(projectRoot, { force: true });
      return { check: 'git_hooks', action: r.action === 'skipped' ? 'skipped' : 'fixed', message: r.details ?? r.action };
    },
    global_schemas: async () => {
      const r = ensureGlobalSchemas();
      const msg = `Installed ${r.installed}, updated ${r.updated} of ${r.total} schemas`;
      return { check: 'global_schemas', action: r.installed + r.updated > 0 ? 'fixed' : 'skipped', message: msg };
    },
    injection_health: async () => {
      const r = await ensureInjection(projectRoot);
      return { check: 'injection_health', action: r.action === 'skipped' ? 'skipped' : 'fixed', message: r.details ?? r.action };
    },
    cleo_structure: async () => {
      const r = await ensureCleoStructure(projectRoot);
      return { check: 'cleo_structure', action: r.action === 'skipped' ? 'skipped' : 'fixed', message: r.details ?? r.action };
    },
    global_home: async () => {
      const r = await ensureGlobalHome();
      return { check: 'global_home', action: r.action === 'skipped' ? 'skipped' : 'fixed', message: r.details ?? r.action };
    },
    global_templates: async () => {
      const r = await ensureGlobalTemplates();
      return { check: 'global_templates', action: r.action === 'skipped' ? 'skipped' : 'fixed', message: r.details ?? r.action };
    },
    log_dir: async () => {
      // Log dir is part of REQUIRED_CLEO_SUBDIRS, so ensureCleoStructure fixes it
      const r = await ensureCleoStructure(projectRoot);
      return { check: 'log_dir', action: r.action === 'skipped' ? 'skipped' : 'fixed', message: r.details ?? r.action };
    },
  };

  for (const check of failedChecks) {
    const fixer = fixMap[check.check];
    if (!fixer) continue;

    try {
      const result = await fixer();
      results.push(result);
    } catch (err) {
      results.push({
        check: check.check,
        action: 'failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

// ============================================================================
// Startup Health Check (MCP + CLI unified entry point)
// ============================================================================

/**
 * Outcome of a startup health check. Tells the caller exactly what state
 * the system is in so it can route to init, upgrade, or proceed normally.
 */
export type StartupState = 'healthy' | 'needs_init' | 'needs_upgrade';

export interface StartupHealthCheck {
  check: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  repaired?: boolean;
}

export interface StartupHealthResult {
  /** Overall system state after health check + auto-repair. */
  state: StartupState;
  /** True if the global ~/.cleo scaffold is healthy (after auto-repair). */
  globalHealthy: boolean;
  /** True if the project .cleo/ scaffold is present and healthy. */
  projectHealthy: boolean;
  /** Individual check results for logging/diagnostics. */
  checks: StartupHealthCheck[];
  /** Checks that failed and could not be auto-repaired. */
  failures: StartupHealthCheck[];
  /** Host system snapshot for diagnostics, error reports, and logging. */
  system: SystemInfo;
}

/**
 * Unified startup health check for MCP server and CLI entry points.
 *
 * This is the single entry point for startup diagnostics. It follows a
 * three-phase approach:
 *
 * Phase 1: Global scaffold (~/.cleo/) — always auto-repaired.
 *   The global home is CLEO infrastructure, not project data. It is safe
 *   to create/repair unconditionally on every startup.
 *
 * Phase 2: Project detection — determines if this is an initialized project.
 *   Uses isProjectInitialized() from paths.ts as the SSoT for detection.
 *
 * Phase 3: Project health — lightweight checks on the project scaffold.
 *   If the project is initialized, runs check* functions to detect drift.
 *   Auto-repairs safe items (missing subdirs via ensureCleoStructure).
 *   Flags items requiring full upgrade (missing DB, config issues).
 *
 * Design principles:
 *   - SSoT: All checks delegate to scaffold.ts check* functions
 *   - DRY: No duplicated health-check logic
 *   - SRP: This function only diagnoses and does safe auto-repair
 *   - Graceful: Never throws. All errors are captured as check results.
 *   - Logged: Returns structured results for the caller to log via pino
 *
 * @param projectRoot - Absolute path to the project root (defaults to cwd)
 */
export async function startupHealthCheck(
  projectRoot?: string,
): Promise<StartupHealthResult> {
  const root = projectRoot ?? process.cwd();
  const system = getSystemInfo();
  const checks: StartupHealthCheck[] = [];
  const failures: StartupHealthCheck[] = [];
  let globalHealthy = true;
  let projectHealthy = true;

  // ── Phase 1: Global scaffold (~/.cleo/) ──────────────────────────
  // Always auto-repair. This is infrastructure, not project data.
  try {
    // Check current state first (read-only)
    const globalHomeCheck = checkGlobalHome();
    const globalTemplateCheck = checkGlobalTemplates();
    const globalSchemaCheck = checkGlobalSchemas();

    const globalNeedsRepair =
      globalHomeCheck.status !== 'passed' ||
      globalTemplateCheck.status !== 'passed' ||
      !globalSchemaCheck.ok;

    if (globalNeedsRepair) {
      // Auto-repair: ensureGlobalScaffold is idempotent and safe
      const scaffoldResult = await ensureGlobalScaffold();

      checks.push({
        check: 'global_home',
        status: 'pass',
        message: scaffoldResult.home.action === 'skipped'
          ? 'Global home already current'
          : `Global home ${scaffoldResult.home.action}: ${scaffoldResult.home.details ?? ''}`,
        repaired: scaffoldResult.home.action !== 'skipped',
      });

      checks.push({
        check: 'global_schemas',
        status: 'pass',
        message: `Schemas: ${scaffoldResult.schemas.installed} installed, ${scaffoldResult.schemas.updated} updated of ${scaffoldResult.schemas.total}`,
        repaired: scaffoldResult.schemas.installed > 0 || scaffoldResult.schemas.updated > 0,
      });

      checks.push({
        check: 'global_templates',
        status: 'pass',
        message: scaffoldResult.templates.action === 'skipped'
          ? 'Templates already current'
          : `Templates ${scaffoldResult.templates.action}: ${scaffoldResult.templates.details ?? ''}`,
        repaired: scaffoldResult.templates.action !== 'skipped',
      });
    } else {
      checks.push(
        { check: 'global_home', status: 'pass', message: 'Global home healthy' },
        { check: 'global_schemas', status: 'pass', message: `All ${globalSchemaCheck.installed} schemas current` },
        { check: 'global_templates', status: 'pass', message: 'Templates present' },
      );
    }
  } catch (err) {
    // Global scaffold failure is non-fatal but degrades the system
    globalHealthy = false;
    const msg = err instanceof Error ? err.message : String(err);
    const failCheck: StartupHealthCheck = {
      check: 'global_scaffold',
      status: 'fail',
      message: `Global scaffold repair failed: ${msg}`,
    };
    checks.push(failCheck);
    failures.push(failCheck);
  }

  // ── Phase 2: Project detection ───────────────────────────────────
  if (!isProjectInitialized(root)) {
    checks.push({
      check: 'project_initialized',
      status: 'fail',
      message: 'Project not initialized (.cleo/ or tasks.db missing)',
    });

    return {
      state: 'needs_init',
      globalHealthy,
      projectHealthy: false,
      checks,
      failures,
      system,
    };
  }

  checks.push({
    check: 'project_initialized',
    status: 'pass',
    message: 'Project initialized',
  });

  // ── Phase 3: Lightweight project health checks ───────────────────
  // Run read-only check* functions to detect drift. Only auto-repair
  // safe structural items (missing subdirs). Flag everything else.

  const structureCheck = checkCleoStructure(root);
  const configCheck = checkConfig(root);
  const dbCheck = checkSqliteDb(root);
  const logDirCheck = checkLogDir(root);

  // Structure: auto-repairable (missing subdirs are safe to create)
  if (structureCheck.status !== 'passed') {
    try {
      await ensureCleoStructure(root);
      checks.push({
        check: 'cleo_structure',
        status: 'pass',
        message: 'Structure repaired: missing subdirectories created',
        repaired: true,
      });
    } catch (err) {
      projectHealthy = false;
      const msg = err instanceof Error ? err.message : String(err);
      const failCheck: StartupHealthCheck = {
        check: 'cleo_structure',
        status: 'fail',
        message: `Structure repair failed: ${msg}`,
      };
      checks.push(failCheck);
      failures.push(failCheck);
    }
  } else {
    checks.push({ check: 'cleo_structure', status: 'pass', message: 'Structure healthy' });
  }

  // Config: NOT auto-repairable on startup (requires explicit init/upgrade)
  if (configCheck.status === 'failed') {
    projectHealthy = false;
    const failCheck: StartupHealthCheck = {
      check: 'config',
      status: 'fail',
      message: configCheck.message,
    };
    checks.push(failCheck);
    failures.push(failCheck);
  } else {
    checks.push({
      check: 'config',
      status: configCheck.status === 'warning' ? 'warn' : 'pass',
      message: configCheck.message,
    });
  }

  // SQLite DB: NOT auto-repairable on startup
  if (dbCheck.status === 'failed') {
    projectHealthy = false;
    const failCheck: StartupHealthCheck = {
      check: 'sqlite_db',
      status: 'fail',
      message: dbCheck.message,
    };
    checks.push(failCheck);
    failures.push(failCheck);
  } else {
    checks.push({
      check: 'sqlite_db',
      status: dbCheck.status === 'warning' ? 'warn' : 'pass',
      message: dbCheck.message,
    });
  }

  // Log directory: auto-repairable (part of ensureCleoStructure above,
  // but verify explicitly since it was just added to REQUIRED_CLEO_SUBDIRS)
  if (logDirCheck.status !== 'passed') {
    // ensureCleoStructure above should have created it, but check again
    checks.push({
      check: 'log_dir',
      status: 'warn',
      message: logDirCheck.message,
    });
  } else {
    checks.push({ check: 'log_dir', status: 'pass', message: 'Log directory present' });
  }

  // Determine overall state
  const hasFailures = failures.length > 0;
  const state: StartupState = hasFailures && !projectHealthy
    ? 'needs_upgrade'
    : 'healthy';

  return {
    state,
    globalHealthy,
    projectHealthy,
    checks,
    failures,
    system,
  };
}
