/**
 * SQLite backup via VACUUM INTO with snapshot rotation.
 *
 * Produces self-contained, WAL-free copies of tasks.db into
 * .cleo/backups/sqlite/ with a configurable rotation limit.
 * All errors are swallowed -- backup failure must never interrupt
 * normal operation.
 *
 * @task T4873
 * @epic T4867
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoDir } from '../core/paths.js';
import { getNativeDb } from './sqlite.js';

const MAX_SNAPSHOTS = 10;
const DEBOUNCE_MS = 30_000; // 30 seconds

let _lastBackupEpoch = 0;

function formatTimestamp(d: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function rotateSnapshots(backupDir: string): void {
  try {
    const files = readdirSync(backupDir)
      .filter(f => f.match(/^tasks-\d{8}-\d{6}\.db$/))
      .map(f => ({ name: f, path: join(backupDir, f), mtimeMs: statSync(join(backupDir, f)).mtimeMs }))
      .sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first

    while (files.length >= MAX_SNAPSHOTS) {
      const oldest = files.shift()!;
      unlinkSync(oldest.path);
    }
  } catch {
    // non-fatal
  }
}

export interface VacuumOptions {
  cwd?: string;
  force?: boolean;
}

/**
 * Create a VACUUM INTO snapshot of the SQLite database.
 *
 * Debounced by default (30s). Pass `force: true` to bypass debounce.
 * WAL checkpoint is run before the snapshot for consistency.
 * Oldest snapshots are rotated out when MAX_SNAPSHOTS is reached.
 *
 * Non-fatal: all errors are swallowed.
 */
export async function vacuumIntoBackup(opts: VacuumOptions = {}): Promise<void> {
  const now = Date.now();
  if (!opts.force && now - _lastBackupEpoch < DEBOUNCE_MS) {
    return; // debounced
  }

  try {
    const cleoDir = getCleoDir(opts.cwd);
    const backupDir = join(cleoDir, 'backups', 'sqlite');
    mkdirSync(backupDir, { recursive: true });

    const db = getNativeDb();
    if (!db) return; // SQLite not initialized

    const dest = join(backupDir, `tasks-${formatTimestamp(new Date())}.db`);

    // WAL checkpoint first for consistency
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

    rotateSnapshots(backupDir);

    // Escape single quotes in path (path is programmatic, but be safe)
    const safeDest = dest.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${safeDest}'`);

    _lastBackupEpoch = Date.now();
  } catch {
    // non-fatal -- backup failure must never interrupt normal operation
  }
}

/**
 * List existing SQLite backup snapshots, newest first.
 */
export function listSqliteBackups(cwd?: string): Array<{ name: string; path: string; mtimeMs: number }> {
  try {
    const cleoDir = getCleoDir(cwd);
    const backupDir = join(cleoDir, 'backups', 'sqlite');
    if (!existsSync(backupDir)) return [];

    return readdirSync(backupDir)
      .filter(f => f.match(/^tasks-\d{8}-\d{6}\.db$/))
      .map(f => ({ name: f, path: join(backupDir, f), mtimeMs: statSync(join(backupDir, f)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  } catch {
    return [];
  }
}
