/**
 * Integration tests for T10319 — `cleo backup verify` per-DB freshness +
 * integrity walker (Saga T10281 SG-BRAIN-DB-RESILIENCE / Epic T10284
 * E3-BACKUP-RECOVERY).
 *
 * Verifies the core SDK helper {@link runBackupVerify} against a sandboxed
 * 3-DB fixture (1 fresh + healthy, 1 stale + healthy, 1 corrupt) covering
 * the four canonical verdicts: `healthy`, `stale`, `corrupt`, `missing`.
 *
 * The CLI shell (`backup-verify.ts`) is a thin citty wrapper around the
 * core helper — its arg parsing + envelope shape + exit code wiring are
 * verified by direct method invocation in the second describe block.
 *
 * @task T10319
 * @epic T10284
 * @saga T10281
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DB_INVENTORY } from '@cleocode/contracts';
import { runBackupVerify } from '@cleocode/core/store/backup-verify.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const _require = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncCtor } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof DatabaseSync>) => DatabaseSync;
};

/**
 * Create a tiny well-formed SQLite database with a single populated table.
 * Used as a fresh snapshot fixture — the DB opens cleanly + passes
 * `PRAGMA integrity_check`.
 */
function writeHealthySnapshot(path: string): void {
  const writer = new DatabaseSyncCtor(path);
  writer.exec(
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
     INSERT INTO notes (body) VALUES ('alpha'), ('beta');`,
  );
  writer.close();
}

/**
 * Write a clearly malformed file at the given path so the verify pass
 * surfaces `integrityOK: false` (the open call throws or the
 * integrity_check returns non-ok). Either path is acceptable for the
 * corrupt-detection contract.
 */
function writeCorruptSnapshot(path: string): void {
  writeFileSync(path, 'this is not a sqlite database');
}

/** Backdate a file's mtime to a fixed past timestamp (seconds since epoch). */
function backdateFile(path: string, atimeS: number, mtimeS: number): void {
  utimesSync(path, atimeS, mtimeS);
}

describe('runBackupVerify (T10319 core SDK)', () => {
  let projectRoot: string;
  let cleoHomeOverride: string;
  let canonicalDir: string;
  let legacyDir: string;
  let globalCanonicalDir: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'cleo-bk-verify-project-'));
    cleoHomeOverride = mkdtempSync(join(tmpdir(), 'cleo-bk-verify-home-'));

    canonicalDir = join(projectRoot, '.cleo', 'backups', 'sqlite');
    legacyDir = join(projectRoot, '.cleo', 'backups', 'snapshot');
    globalCanonicalDir = join(cleoHomeOverride, 'backups', 'sqlite');

    mkdirSync(canonicalDir, { recursive: true });
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(globalCanonicalDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(projectRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    try {
      rmSync(cleoHomeOverride, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it('returns one report per DB_INVENTORY role keyed by role name', () => {
    const result = runBackupVerify({
      projectRoot,
      cleoHomeOverride,
    });

    expect(Object.keys(result.dbs).length).toBe(DB_INVENTORY.length);
    for (const entry of DB_INVENTORY) {
      const report = result.dbs[entry.role];
      expect(report).toBeDefined();
      if (!report) throw new Error(`missing report for role ${entry.role}`);
      expect(report.role).toBe(entry.role);
      expect(report.tier).toBe(entry.tier);
    }
  });

  it('returns verdict=missing when no snapshot exists in either directory', () => {
    const result = runBackupVerify({
      projectRoot,
      cleoHomeOverride,
    });

    // Every report must be missing — no snapshots were seeded.
    for (const report of Object.values(result.dbs)) {
      expect(report.verdict).toBe('missing');
      expect(report.freshSnapshot).toBeNull();
      expect(report.legacySnapshot).toBeNull();
      expect(report.dataLossEstimateHours).toBeNull();
    }
    expect(result.summary.missing).toBe(DB_INVENTORY.length);
    expect(result.summary.healthy).toBe(0);
    expect(result.summary.stale).toBe(0);
    expect(result.summary.corrupt).toBe(0);
  });

  it('returns verdict=healthy with positive dataLossEstimateHours when a fresh snapshot opens cleanly', () => {
    // Seed a fresh tasks.db snapshot in the canonical dir using the
    // canonical VACUUM-INTO naming scheme.
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const snapshotPath = join(canonicalDir, `tasks-${stamp}.db`);
    writeHealthySnapshot(snapshotPath);

    const result = runBackupVerify({
      projectRoot,
      cleoHomeOverride,
      nowMs: Date.now(),
    });

    const tasksReport = result.dbs['tasks'];
    expect(tasksReport).toBeDefined();
    if (!tasksReport) throw new Error('tasks report missing');
    expect(tasksReport.verdict).toBe('healthy');
    expect(tasksReport.freshSnapshot).not.toBeNull();
    expect(tasksReport.freshSnapshot?.integrityOK).toBe(true);
    expect(tasksReport.freshSnapshot?.path).toBe(snapshotPath);
    expect(tasksReport.freshSnapshot?.error).toBeNull();
    expect(tasksReport.dataLossEstimateHours).not.toBeNull();
    if (tasksReport.dataLossEstimateHours === null) {
      throw new Error('dataLossEstimateHours should be set on healthy');
    }
    // Fresh: < 24h
    expect(tasksReport.dataLossEstimateHours).toBeLessThan(24);
    expect(tasksReport.dataLossEstimateHours).toBeGreaterThanOrEqual(0);

    expect(result.summary.healthy).toBeGreaterThanOrEqual(1);
  });

  it('returns verdict=stale when the freshest snapshot is older than 24h but still opens cleanly', () => {
    const fortyEightHoursAgoMs = Date.now() - 48 * 60 * 60 * 1000;
    const oldDate = new Date(fortyEightHoursAgoMs);
    const stamp = `${oldDate.getFullYear()}${String(oldDate.getMonth() + 1).padStart(2, '0')}${String(oldDate.getDate()).padStart(2, '0')}-${String(oldDate.getHours()).padStart(2, '0')}${String(oldDate.getMinutes()).padStart(2, '0')}${String(oldDate.getSeconds()).padStart(2, '0')}`;
    const snapshotPath = join(canonicalDir, `brain-${stamp}.db`);
    writeHealthySnapshot(snapshotPath);
    // Backdate mtime to 48h ago so the verify pass reads stale freshness.
    const atime = fortyEightHoursAgoMs / 1000;
    backdateFile(snapshotPath, atime, atime);

    const result = runBackupVerify({
      projectRoot,
      cleoHomeOverride,
      nowMs: Date.now(),
    });

    const brainReport = result.dbs['brain'];
    expect(brainReport).toBeDefined();
    if (!brainReport) throw new Error('brain report missing');
    expect(brainReport.verdict).toBe('stale');
    expect(brainReport.freshSnapshot).not.toBeNull();
    expect(brainReport.freshSnapshot?.integrityOK).toBe(true);
    expect(brainReport.dataLossEstimateHours).not.toBeNull();
    if (brainReport.dataLossEstimateHours === null) {
      throw new Error('dataLossEstimateHours should be set on stale');
    }
    expect(brainReport.dataLossEstimateHours).toBeGreaterThan(24);

    expect(result.summary.stale).toBeGreaterThanOrEqual(1);
  });

  it('returns verdict=corrupt when the freshest snapshot fails integrity_check', () => {
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const snapshotPath = join(canonicalDir, `conduit-${stamp}.db`);
    writeCorruptSnapshot(snapshotPath);

    const result = runBackupVerify({
      projectRoot,
      cleoHomeOverride,
      nowMs: Date.now(),
    });

    const conduitReport = result.dbs['conduit'];
    expect(conduitReport).toBeDefined();
    if (!conduitReport) throw new Error('conduit report missing');
    expect(conduitReport.verdict).toBe('corrupt');
    expect(conduitReport.freshSnapshot).not.toBeNull();
    expect(conduitReport.freshSnapshot?.integrityOK).toBe(false);
    expect(conduitReport.freshSnapshot?.error).not.toBeNull();

    expect(result.summary.corrupt).toBeGreaterThanOrEqual(1);
  });

  it('detects 3-DB mixed fixture: fresh+healthy / stale+healthy / corrupt', () => {
    // 1. Fresh + healthy: tasks
    const now = new Date();
    const stampNow = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const tasksPath = join(canonicalDir, `tasks-${stampNow}.db`);
    writeHealthySnapshot(tasksPath);

    // 2. Stale + healthy: brain (48h old)
    const fortyEightHoursAgoMs = Date.now() - 48 * 60 * 60 * 1000;
    const oldDate = new Date(fortyEightHoursAgoMs);
    const stampOld = `${oldDate.getFullYear()}${String(oldDate.getMonth() + 1).padStart(2, '0')}${String(oldDate.getDate()).padStart(2, '0')}-${String(oldDate.getHours()).padStart(2, '0')}${String(oldDate.getMinutes()).padStart(2, '0')}${String(oldDate.getSeconds()).padStart(2, '0')}`;
    const brainPath = join(canonicalDir, `brain-${stampOld}.db`);
    writeHealthySnapshot(brainPath);
    const atime = fortyEightHoursAgoMs / 1000;
    backdateFile(brainPath, atime, atime);

    // 3. Corrupt: conduit
    const conduitPath = join(canonicalDir, `conduit-${stampNow}.db`);
    writeCorruptSnapshot(conduitPath);

    const result = runBackupVerify({
      projectRoot,
      cleoHomeOverride,
      nowMs: Date.now(),
    });

    expect(result.dbs['tasks']?.verdict).toBe('healthy');
    expect(result.dbs['brain']?.verdict).toBe('stale');
    expect(result.dbs['conduit']?.verdict).toBe('corrupt');

    // Summary must add up across all roles.
    const { healthy, stale, corrupt, missing } = result.summary;
    expect(healthy + stale + corrupt + missing).toBe(DB_INVENTORY.length);
    expect(healthy).toBeGreaterThanOrEqual(1);
    expect(stale).toBeGreaterThanOrEqual(1);
    expect(corrupt).toBeGreaterThanOrEqual(1);
  });

  it('picks the newer snapshot when both canonical and legacy directories hold one', () => {
    // Legacy snapshot — older
    const fortyEightHoursAgoMs = Date.now() - 48 * 60 * 60 * 1000;
    const oldDate = new Date(fortyEightHoursAgoMs);
    const stampOld = `${oldDate.getFullYear()}${String(oldDate.getMonth() + 1).padStart(2, '0')}${String(oldDate.getDate()).padStart(2, '0')}-${String(oldDate.getHours()).padStart(2, '0')}${String(oldDate.getMinutes()).padStart(2, '0')}${String(oldDate.getSeconds()).padStart(2, '0')}`;
    const legacyPath = join(legacyDir, `tasks-${stampOld}.db`);
    writeHealthySnapshot(legacyPath);
    const atime = fortyEightHoursAgoMs / 1000;
    backdateFile(legacyPath, atime, atime);

    // Canonical snapshot — fresh (now)
    const now = new Date();
    const stampNow = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const canonicalPath = join(canonicalDir, `tasks-${stampNow}.db`);
    writeHealthySnapshot(canonicalPath);

    const result = runBackupVerify({
      projectRoot,
      cleoHomeOverride,
      nowMs: Date.now(),
    });

    const tasksReport = result.dbs['tasks'];
    expect(tasksReport).toBeDefined();
    if (!tasksReport) throw new Error('tasks report missing');
    expect(tasksReport.verdict).toBe('healthy');
    // Both should be populated.
    expect(tasksReport.freshSnapshot).not.toBeNull();
    expect(tasksReport.legacySnapshot).not.toBeNull();
    expect(tasksReport.freshSnapshot?.path).toBe(canonicalPath);
    expect(tasksReport.legacySnapshot?.path).toBe(legacyPath);
    // The fresher mtime wins for the data-loss estimate.
    if (tasksReport.dataLossEstimateHours === null) {
      throw new Error('dataLossEstimateHours should be populated');
    }
    expect(tasksReport.dataLossEstimateHours).toBeLessThan(24);
  });

  it('still surfaces healthy verdict when ONLY the legacy directory has a snapshot', () => {
    const now = new Date();
    const stampNow = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const legacyPath = join(legacyDir, `tasks-${stampNow}.db`);
    writeHealthySnapshot(legacyPath);

    const result = runBackupVerify({
      projectRoot,
      cleoHomeOverride,
      nowMs: Date.now(),
    });

    const tasksReport = result.dbs['tasks'];
    expect(tasksReport).toBeDefined();
    if (!tasksReport) throw new Error('tasks report missing');
    expect(tasksReport.verdict).toBe('healthy');
    expect(tasksReport.freshSnapshot).toBeNull();
    expect(tasksReport.legacySnapshot).not.toBeNull();
    expect(tasksReport.legacySnapshot?.integrityOK).toBe(true);
  });

  it('recognises createBackup sidecar-style filenames', () => {
    // createBackup writes `<role>.db.<backupId>` where
    // `backupId = <type>-YYYYMMDD-HHmmss`.
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const sidecarPath = join(canonicalDir, `brain.db.snapshot-${stamp}`);
    writeHealthySnapshot(sidecarPath);

    const result = runBackupVerify({
      projectRoot,
      cleoHomeOverride,
      nowMs: Date.now(),
    });

    const brainReport = result.dbs['brain'];
    expect(brainReport).toBeDefined();
    if (!brainReport) throw new Error('brain report missing');
    expect(brainReport.verdict).toBe('healthy');
    expect(brainReport.freshSnapshot).not.toBeNull();
    expect(brainReport.freshSnapshot?.path).toBe(sidecarPath);
  });

  it('recognises legacy ISO-suffix `<role>.db.snapshot-<iso>` filenames', () => {
    // Legacy `cleo backup add` pattern from recover-brain-db.
    const now = new Date();
    const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}-${String(now.getMilliseconds()).padStart(3, '0')}Z`;
    const isoPath = join(legacyDir, `brain.db.snapshot-${iso}`);
    writeHealthySnapshot(isoPath);

    const result = runBackupVerify({
      projectRoot,
      cleoHomeOverride,
      nowMs: Date.now(),
    });

    const brainReport = result.dbs['brain'];
    expect(brainReport).toBeDefined();
    if (!brainReport) throw new Error('brain report missing');
    expect(brainReport.verdict).toBe('healthy');
    expect(brainReport.legacySnapshot).not.toBeNull();
    expect(brainReport.legacySnapshot?.path).toBe(isoPath);
  });

  it('snapshots a global-tier DB from the global backup directory under cleoHomeOverride', () => {
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const globalPath = join(globalCanonicalDir, `nexus-${stamp}.db`);
    writeHealthySnapshot(globalPath);

    const result = runBackupVerify({
      projectRoot,
      cleoHomeOverride,
      nowMs: Date.now(),
    });

    const nexusReport = result.dbs['nexus'];
    expect(nexusReport).toBeDefined();
    if (!nexusReport) throw new Error('nexus report missing');
    expect(nexusReport.tier).toBe('global');
    expect(nexusReport.verdict).toBe('healthy');
    expect(nexusReport.freshSnapshot?.path).toBe(globalPath);
  });
});
