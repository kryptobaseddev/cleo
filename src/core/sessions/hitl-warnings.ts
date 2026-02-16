/**
 * Human-in-the-Loop (HITL) warning system.
 *
 * Generates warnings for concurrent operations, orphaned locks,
 * and high-risk operations that may require human review.
 *
 * Warning levels:
 *   INFO  - Informational, no action needed
 *   WARN  - Review recommended
 *   BLOCK - Requires human decision before proceeding
 *
 * @task T4454
 * @epic T4454
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { getCleoDir } from '../paths.js';
import { existsSync as configExists, readFileSync as readConfigFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';

/** Synchronous config value reader. */
function readConfigValueSync(path: string, defaultValue: unknown, cwd?: string): unknown {
  try {
    const configPath = joinPath(getCleoDir(cwd), 'config.json');
    if (!configExists(configPath)) return defaultValue;
    const config = JSON.parse(readConfigFileSync(configPath, 'utf-8'));
    const keys = path.split('.');
    let value: unknown = config;
    for (const key of keys) {
      if (value == null || typeof value !== 'object') return defaultValue;
      value = (value as Record<string, unknown>)[key];
    }
    return value ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

/** HITL warning level. */
export type HITLLevel = 'none' | 'info' | 'warn' | 'block';

/** HITL warning entry. */
export interface HITLWarning {
  level: 'INFO' | 'WARN' | 'BLOCK';
  type: string;
  message: string;
  details: unknown;
  action: string;
}

/** Lock info from .cleo/*.lock files. */
interface LockInfo {
  resource: string;
  pid: number;
  process: string;
  status: 'active' | 'stale' | 'orphaned';
  age_seconds: number;
}

/** HITL warnings result. */
export interface HITLWarningsResult {
  enabled: boolean;
  level: HITLLevel;
  requiresHuman: boolean;
  warnings: HITLWarning[];
  activeLocks: LockInfo[];
  summary: {
    total: number;
    byLevel: { block: number; warn: number; info: number };
  } | null;
}

const HIGH_RISK_RESOURCES = ['todo-archive.json', 'sessions.json', 'config.json'];

/** Check if HITL warnings are enabled. */
export function isHITLEnabled(cwd?: string): boolean {
  try {
    return readConfigValueSync('analyze.lockAwareness.enabled', true, cwd) as boolean;
  } catch {
    return true; // Enabled by default
  }
}

/** Check if warn-only mode is active. */
function isWarnOnlyMode(cwd?: string): boolean {
  try {
    return readConfigValueSync('analyze.lockAwareness.warnOnly', true, cwd) as boolean;
  } catch {
    return true;
  }
}

/** Check if a PID is currently running. */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Get lock file information from .cleo directory. */
function getLockFiles(cwd?: string): LockInfo[] {
  const cleoDir = getCleoDir(cwd);
  if (!existsSync(cleoDir)) return [];

  const locks: LockInfo[] = [];
  const now = Date.now();

  try {
    for (const file of readdirSync(cleoDir)) {
      if (!file.endsWith('.lock')) continue;

      const filePath = join(cleoDir, file);
      const stat = statSync(filePath);
      const ageSeconds = Math.floor((now - stat.mtimeMs) / 1000);
      const resource = basename(file, '.lock');

      let pid = 0;
      let processName = 'unknown';
      try {
        const content = JSON.parse(readFileSync(filePath, 'utf-8'));
        pid = content.pid ?? 0;
        processName = content.process ?? content.command ?? 'unknown';
      } catch {
        // Not JSON, try as raw PID
        try {
          pid = parseInt(readFileSync(filePath, 'utf-8').trim(), 10);
        } catch { /* empty */ }
      }

      let status: LockInfo['status'] = 'active';
      if (pid > 0 && !isProcessRunning(pid)) {
        status = 'orphaned';
      } else if (ageSeconds > 300) { // 5 minutes
        status = 'stale';
      }

      locks.push({ resource, pid, process: processName, status, age_seconds: ageSeconds });
    }
  } catch {
    // Can't read directory
  }

  return locks;
}

/** Generate HITL warnings based on lock state. */
export function generateHITLWarnings(cwd?: string): HITLWarningsResult {
  if (!isHITLEnabled(cwd)) {
    return {
      enabled: false,
      level: 'none',
      requiresHuman: false,
      warnings: [],
      activeLocks: [],
      summary: null,
    };
  }

  const allLocks = getLockFiles(cwd);
  const activeLocks = allLocks.filter(l => l.status === 'active');
  const staleLocks = allLocks.filter(l => l.status === 'stale');
  const orphanedLocks = allLocks.filter(l => l.status === 'orphaned');

  const warnings: HITLWarning[] = [];
  let maxLevel: HITLLevel = 'none';
  let requiresHuman = false;

  // Multiple active locks on same resource => BLOCK
  if (activeLocks.length > 0) {
    const byResource = new Map<string, LockInfo[]>();
    for (const lock of activeLocks) {
      if (!byResource.has(lock.resource)) byResource.set(lock.resource, []);
      byResource.get(lock.resource)!.push(lock);
    }

    for (const [resource, locks] of byResource) {
      if (locks.length > 1) {
        maxLevel = 'block';
        requiresHuman = true;
        warnings.push({
          level: 'BLOCK',
          type: 'MULTI_LOCK',
          message: 'Multiple processes locking same resource',
          details: [{ resource, count: locks.length }],
          action: 'Investigate - potential race condition',
        });
      }
    }

    // High-risk operations
    const highRiskLocks = activeLocks.filter(l => HIGH_RISK_RESOURCES.includes(l.resource));
    if (highRiskLocks.length > 0) {
      if (maxLevel !== 'block') {
        if (isWarnOnlyMode(cwd)) {
          maxLevel = 'warn';
        } else {
          maxLevel = 'block';
          requiresHuman = true;
        }
      }
      warnings.push({
        level: 'WARN',
        type: 'HIGH_RISK_OP',
        message: 'High-risk operation in progress',
        details: highRiskLocks,
        action: 'Wait for completion or investigate',
      });
    }

    // Standard concurrent operations
    if (maxLevel === 'none') maxLevel = 'warn';
    warnings.push({
      level: 'WARN',
      type: 'CONCURRENT',
      message: 'Concurrent operation detected',
      details: activeLocks.map(l => ({
        resource: l.resource,
        pid: l.pid,
        process: l.process,
        age_seconds: l.age_seconds,
      })),
      action: 'Tasks may conflict with active operations',
    });
  }

  // Orphaned locks
  if (orphanedLocks.length > 0) {
    if (maxLevel === 'none') maxLevel = 'warn';
    warnings.push({
      level: 'WARN',
      type: 'ORPHANED',
      message: 'Orphaned lock detected - process may have crashed',
      details: orphanedLocks,
      action: 'Run: rm .cleo/*.lock to clean up',
    });
  }

  // Stale locks
  if (staleLocks.length > 0) {
    if (maxLevel === 'none') maxLevel = 'info';
    warnings.push({
      level: 'INFO',
      type: 'STALE',
      message: 'Stale lock file(s) detected',
      details: staleLocks,
      action: 'Can be safely removed if no operations are pending',
    });
  }

  const summary = warnings.length > 0
    ? {
        total: warnings.length,
        byLevel: {
          block: warnings.filter(w => w.level === 'BLOCK').length,
          warn: warnings.filter(w => w.level === 'WARN').length,
          info: warnings.filter(w => w.level === 'INFO').length,
        },
      }
    : null;

  return { enabled: true, level: maxLevel, requiresHuman, warnings, activeLocks, summary };
}

/** Get highest warning level from warnings. */
export function getHighestLevel(warnings: HITLWarning[]): HITLLevel {
  if (warnings.some(w => w.level === 'BLOCK')) return 'block';
  if (warnings.some(w => w.level === 'WARN')) return 'warn';
  if (warnings.some(w => w.level === 'INFO')) return 'info';
  return 'none';
}

/** Get concurrency data for analyze JSON output. */
export function getConcurrencyJson(cwd?: string): Record<string, unknown> {
  if (!isHITLEnabled(cwd)) return { enabled: false };

  const result = generateHITLWarnings(cwd);
  if (result.level === 'none') {
    return { enabled: true, hasWarnings: false, level: 'none', activeLocks: [], warnings: [] };
  }

  return {
    enabled: result.enabled,
    hasWarnings: result.warnings.length > 0,
    level: result.level,
    requiresHuman: result.requiresHuman,
    activeLocks: result.activeLocks,
    warnings: result.warnings,
    summary: result.summary,
  };
}
