/**
 * System health checks core module.
 * @task T4783
 * @task T4795
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { checkStorageMigration } from '../migration/preflight.js';
import { checkCleoGitignore, checkVitalFilesTracked, checkCoreFilesNotIgnored, checkLegacyAgentOutputs, checkNodeVersion, type CheckResult } from '../validation/doctor/checks.js';
import { getAccessor } from '../../store/data-accessor.js';
import { checkProjectInfo, checkProjectContext } from '../scaffold.js';
import { checkGitHooks, type HookCheckResult } from '../hooks.js';
import { checkGlobalSchemas, type CheckResult as SchemaCheckResult } from '../schema-management.js';
import { checkInjection } from '../injection.js';

const execAsync = promisify(execFile);

/** Stale JSON files that should not exist alongside tasks.db (ADR-006). */
const STALE_JSON_FILES = ['todo.json', 'sessions.json', 'todo-archive.json'] as const;

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
    const logPath = join(cleoDir, 'todo-log.jsonl');
    if (existsSync(logPath)) {
      checks.push({ name: 'log_file', status: 'pass', message: 'todo-log.jsonl exists' });
    } else {
      checks.push({ name: 'log_file', status: 'warn', message: 'todo-log.jsonl not found' });
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
        c.name === 'todo_json' ? 'Run: cleo init (or restore from backup)' :
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

  const logPath = join(cleoDir, 'todo-log.jsonl');
  const logExists = existsSync(logPath);
  checks.push({
    check: 'log_file',
    status: logExists ? 'ok' : 'warning',
    message: logExists ? 'log file present' : 'log file not found',
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

  // 5c. Shared module checks: git hooks, global schemas, project-info, injection
  const hookResults = await checkGitHooks(projectRoot);
  checks.push(mapHookResults(hookResults));

  checks.push(mapSchemaCheckResult(checkGlobalSchemas()));

  checks.push(mapCheckResult(checkProjectInfo(projectRoot)));

  // Project context check
  checks.push(mapCheckResult(checkProjectContext(projectRoot)));

  checks.push(mapCheckResult(checkInjection(projectRoot)));

  // Agent definition presence check
  const agentDefPath = join(homedir(), '.agents', 'agents', 'cleo-subagent');
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

  checks.push({
    check: 'platform',
    status: 'ok',
    message: `${process.platform} ${process.arch}`,
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
  const { ensureCleoStructure, ensureGitignore, ensureConfig, ensureProjectInfo, ensureProjectContext, ensureCleoGitRepo } = await import('../scaffold.js');
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
