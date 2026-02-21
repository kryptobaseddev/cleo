/**
 * System health checks core module.
 * @task T4783
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkStorageMigration } from '../migration/preflight.js';

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

/** Run system health checks. */
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

  // Check todo.json
  const todoPath = join(cleoDir, 'todo.json');
  if (existsSync(todoPath)) {
    try {
      JSON.parse(readFileSync(todoPath, 'utf-8'));
      checks.push({ name: 'todo_json', status: 'pass', message: 'todo.json is valid JSON' });
    } catch {
      checks.push({ name: 'todo_json', status: 'fail', message: 'todo.json is not valid JSON' });
    }
  } else {
    checks.push({ name: 'todo_json', status: 'fail', message: 'todo.json not found' });
  }

  // Check config.json
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

  // Check sessions.json
  const sessionsPath = join(cleoDir, 'sessions.json');
  if (existsSync(sessionsPath)) {
    try {
      JSON.parse(readFileSync(sessionsPath, 'utf-8'));
      checks.push({ name: 'sessions_json', status: 'pass', message: 'sessions.json is valid JSON' });
    } catch {
      checks.push({ name: 'sessions_json', status: 'warn', message: 'sessions.json is not valid JSON' });
    }
  } else {
    checks.push({ name: 'sessions_json', status: 'pass', message: 'sessions.json not present (optional)' });
  }

  // Check .sequence.json
  const seqPath = join(cleoDir, '.sequence.json');
  if (existsSync(seqPath)) {
    try {
      JSON.parse(readFileSync(seqPath, 'utf-8'));
      checks.push({ name: 'sequence_json', status: 'pass', message: '.sequence.json is valid' });
    } catch {
      checks.push({ name: 'sequence_json', status: 'warn', message: '.sequence.json is not valid JSON' });
    }
  } else {
    checks.push({ name: 'sequence_json', status: 'warn', message: '.sequence.json not found' });
  }

  // Check archive
  const archivePath = join(cleoDir, 'todo-archive.json');
  if (existsSync(archivePath)) {
    try {
      JSON.parse(readFileSync(archivePath, 'utf-8'));
      checks.push({ name: 'archive_json', status: 'pass', message: 'todo-archive.json is valid JSON' });
    } catch {
      checks.push({ name: 'archive_json', status: 'warn', message: 'todo-archive.json is not valid JSON' });
    }
  } else {
    checks.push({ name: 'archive_json', status: 'pass', message: 'todo-archive.json not present (optional)' });
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
export function getSystemDiagnostics(
  projectRoot: string,
  opts?: { checks?: string[] },
): DiagnosticsResult {
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

  // Schema version check
  const cleoDir = join(projectRoot, '.cleo');
  const todoPath = join(cleoDir, 'todo.json');
  if (existsSync(todoPath)) {
    try {
      const todo = JSON.parse(readFileSync(todoPath, 'utf-8'));
      const schemaVersion = todo._meta?.schemaVersion;
      if (schemaVersion) {
        diagChecks.push({ name: 'schema_version', status: 'pass', details: `Schema version: ${schemaVersion}` });
      } else {
        diagChecks.push({ name: 'schema_version', status: 'warn', details: 'No schema version in _meta', fix: 'Run: cleo migrate' });
      }
    } catch {
      // already caught in health check
    }
  }

  // Check for stale sessions
  const sessionsPath = join(cleoDir, 'sessions.json');
  if (existsSync(sessionsPath)) {
    try {
      const sessionsData = JSON.parse(readFileSync(sessionsPath, 'utf-8'));
      const activeSessions = (sessionsData.sessions ?? []).filter((s: { status: string }) => s.status === 'active');
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
