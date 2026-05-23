/**
 * Tests for the brain.db auto-recovery pipeline (T10303).
 *
 * Verifies:
 * - Healthy DB: probe returns ok → no recovery action taken (caller drives this).
 * - Truncated/corrupt DB + valid system-snapshot: corrupt file is quarantined,
 *   snapshot is restored, integrity probe passes.
 * - No snapshots available: returns `restoredFrom: null`, `integrityOK: false`.
 * - Filename pattern matching: system-snapshot, vacuum-snapshot, pre-dup-fix.
 * - Data-loss window is computed from the snapshot's parsed timestamp.
 * - Quarantine directory holds the corrupt file with `-wal`/`-shm` sidecars.
 *
 * @task T10303
 * @epic T10286
 * @saga T10281
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type RecoveryLogger, recoverMalformedBrainDb } from '../recover-brain-db.js';
import { openNativeDatabase } from '../sqlite-native.js';

/** Build a minimal valid brain.db at `path` containing a `brain_observations` table. */
function seedHealthyBrainDb(path: string, observationCount = 3): void {
  const db = openNativeDatabase(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS brain_observations (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const stmt = db.prepare('INSERT INTO brain_observations (id, content) VALUES (?, ?)');
  for (let i = 0; i < observationCount; i++) {
    stmt.run(`obs-${i}`, `seeded observation ${i}`);
  }
  db.close();
}

/** Write a non-SQLite garbage file to simulate `ERR_SQLITE_ERROR errcode=11`. */
function writeCorruptFile(path: string): void {
  // First 16 bytes must be NOT the SQLite magic header so the open path
  // refuses the file with SQLITE_NOTADB or similar. We capture the same
  // failure surface as a malformed schema via the `quick_check === ok`
  // verification in the recovery loop.
  writeFileSync(path, 'this is not a sqlite database\n'.repeat(64));
}

/** Capture-only logger for assertions. */
function makeLogger(): RecoveryLogger & {
  warnCalls: Array<{ obj: Record<string, unknown>; msg: string }>;
  errorCalls: Array<{ obj: Record<string, unknown>; msg: string }>;
} {
  const warnCalls: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const errorCalls: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  return {
    warnCalls,
    errorCalls,
    warn(obj, msg) {
      warnCalls.push({ obj, msg });
    },
    error(obj, msg) {
      errorCalls.push({ obj, msg });
    },
  };
}

describe('recoverMalformedBrainDb (T10303)', () => {
  it('quarantines the corrupt file and restores the freshest system-snapshot', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleo-test-recover-'));
    const cleoDir = join(root, '.cleo');
    const snapshotDir = join(cleoDir, 'backups', 'snapshot');
    const corruptPath = join(cleoDir, 'brain.db');
    mkdirSync(snapshotDir, { recursive: true });

    // Seed an older + newer system-snapshot. Both must be REAL SQLite files
    // so the probe (PRAGMA quick_check) returns ok.
    const olderSnapshot = join(snapshotDir, 'brain.db.snapshot-2026-05-12T00-33-56-575Z');
    const newerSnapshot = join(snapshotDir, 'brain.db.snapshot-2026-05-23T08-00-55-563Z');
    seedHealthyBrainDb(olderSnapshot, 2);
    seedHealthyBrainDb(newerSnapshot, 7);

    // Write the corrupt main DB.
    writeCorruptFile(corruptPath);
    writeFileSync(`${corruptPath}-wal`, 'wal sidecar contents');
    writeFileSync(`${corruptPath}-shm`, 'shm sidecar contents');

    const logger = makeLogger();
    const result = recoverMalformedBrainDb({
      corruptPath,
      snapshotDir,
      legacyArtifactDir: cleoDir,
      quarantineRoot: join(cleoDir, 'quarantine'),
      logger,
    });

    expect(result.integrityOK).toBe(true);
    expect(result.restoredFrom).toBe(newerSnapshot);
    expect(result.observationsRecovered).toBe(7);
    expect(result.quarantineDir).not.toBeNull();
    expect(result.dataLossWindowHours).toBeGreaterThanOrEqual(0);

    // The corrupt file must be gone from the live path and present in quarantine.
    expect(existsSync(corruptPath)).toBe(true); // restored to live path
    const quarantineEntries = readdirSync(result.quarantineDir as string);
    expect(quarantineEntries).toContain('brain.db.malformed');
    expect(quarantineEntries.some((n) => n.endsWith('-wal'))).toBe(true);
    expect(quarantineEntries.some((n) => n.endsWith('-shm'))).toBe(true);

    // Restored file is a valid brain.db with the SEVEN seeded observations.
    const restored = openNativeDatabase(corruptPath, { readonly: true, enableWal: false });
    const row = restored.prepare('SELECT COUNT(*) AS cnt FROM brain_observations').get() as
      | { cnt: number }
      | undefined;
    expect(row?.cnt).toBe(7);
    restored.close();

    // Single warn() call with the canonical event tag.
    expect(logger.warnCalls.length).toBe(1);
    expect(logger.warnCalls[0]?.obj['event']).toBe('brain.auto-recovery');
    expect(logger.warnCalls[0]?.msg).toMatch(/BRAIN auto-recovered/);
  });

  it('returns null restoredFrom when no snapshots are available', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleo-test-recover-none-'));
    const cleoDir = join(root, '.cleo');
    const snapshotDir = join(cleoDir, 'backups', 'snapshot');
    const corruptPath = join(cleoDir, 'brain.db');
    mkdirSync(snapshotDir, { recursive: true });
    writeCorruptFile(corruptPath);

    const logger = makeLogger();
    const result = recoverMalformedBrainDb({
      corruptPath,
      snapshotDir,
      logger,
    });

    expect(result.integrityOK).toBe(false);
    expect(result.restoredFrom).toBeNull();
    expect(result.observationsRecovered).toBeNull();
    expect(result.dataLossWindowHours).toBeNull();
    // The corrupt file is still moved to quarantine even on no-snapshot failure.
    expect(result.quarantineDir).not.toBeNull();
    expect(existsSync(join(result.quarantineDir as string, 'brain.db.malformed'))).toBe(true);
    // No warn() — failure reported via error().
    expect(logger.warnCalls.length).toBe(0);
    expect(logger.errorCalls.length).toBeGreaterThan(0);
  });

  it('skips a malformed snapshot and falls back to the next-freshest valid one', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleo-test-recover-skip-'));
    const cleoDir = join(root, '.cleo');
    const snapshotDir = join(cleoDir, 'backups', 'snapshot');
    const corruptPath = join(cleoDir, 'brain.db');
    mkdirSync(snapshotDir, { recursive: true });

    // Newer snapshot is also corrupt; older snapshot is healthy.
    const olderSnapshot = join(snapshotDir, 'brain.db.snapshot-2026-05-12T00-33-56-575Z');
    const newerCorruptSnapshot = join(snapshotDir, 'brain.db.snapshot-2026-05-23T08-00-55-563Z');
    seedHealthyBrainDb(olderSnapshot, 4);
    writeCorruptFile(newerCorruptSnapshot);
    writeCorruptFile(corruptPath);

    const logger = makeLogger();
    const result = recoverMalformedBrainDb({
      corruptPath,
      snapshotDir,
      logger,
    });

    expect(result.integrityOK).toBe(true);
    expect(result.restoredFrom).toBe(olderSnapshot);
    expect(result.observationsRecovered).toBe(4);
    // At least one error() call for the skipped corrupt snapshot.
    expect(logger.errorCalls.some((c) => /quick_check/.test(c.msg))).toBe(true);
  });

  it('discovers VACUUM-INTO snapshots from the sqlite/ backup dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleo-test-recover-vacuum-'));
    const cleoDir = join(root, '.cleo');
    const vacuumDir = join(cleoDir, 'backups', 'sqlite');
    const snapshotDir = join(cleoDir, 'backups', 'snapshot');
    const corruptPath = join(cleoDir, 'brain.db');
    mkdirSync(vacuumDir, { recursive: true });
    mkdirSync(snapshotDir, { recursive: true });

    const vacuumSnapshot = join(vacuumDir, 'brain-20260523-131622.db');
    seedHealthyBrainDb(vacuumSnapshot, 9);
    writeCorruptFile(corruptPath);

    const logger = makeLogger();
    const result = recoverMalformedBrainDb({
      corruptPath,
      snapshotDir,
      vacuumSnapshotDir: vacuumDir,
      logger,
    });

    expect(result.integrityOK).toBe(true);
    expect(result.restoredFrom).toBe(vacuumSnapshot);
    expect(result.observationsRecovered).toBe(9);
  });

  it('uses legacy PRE-DUP-FIX artifacts as a last-resort fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleo-test-recover-predup-'));
    const cleoDir = join(root, '.cleo');
    const snapshotDir = join(cleoDir, 'backups', 'snapshot');
    const corruptPath = join(cleoDir, 'brain.db');
    mkdirSync(snapshotDir, { recursive: true });

    const legacy = join(cleoDir, 'brain.db.PRE-DUP-FIX-191315');
    seedHealthyBrainDb(legacy, 1);
    writeCorruptFile(corruptPath);

    const logger = makeLogger();
    const result = recoverMalformedBrainDb({
      corruptPath,
      snapshotDir,
      legacyArtifactDir: cleoDir,
      logger,
    });

    expect(result.integrityOK).toBe(true);
    expect(result.restoredFrom).toBe(legacy);
    expect(result.observationsRecovered).toBe(1);
  });

  it('emits a single Pino warning with the canonical event tag and data-loss window', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleo-test-recover-warn-'));
    const cleoDir = join(root, '.cleo');
    const snapshotDir = join(cleoDir, 'backups', 'snapshot');
    const corruptPath = join(cleoDir, 'brain.db');
    mkdirSync(snapshotDir, { recursive: true });

    // Pick a snapshot timestamp from days ago so dataLossWindowHours > 0.
    const snapshot = join(snapshotDir, 'brain.db.snapshot-2026-05-12T00-00-00-000Z');
    seedHealthyBrainDb(snapshot, 1);
    writeCorruptFile(corruptPath);

    const logger = makeLogger();
    recoverMalformedBrainDb({ corruptPath, snapshotDir, logger });

    expect(logger.warnCalls.length).toBe(1);
    const { obj, msg } = logger.warnCalls[0]!;
    expect(obj['event']).toBe('brain.auto-recovery');
    expect(typeof obj['dataLossWindowHours']).toBe('number');
    expect(msg).toMatch(/BRAIN auto-recovered/);
    expect(msg).toMatch(/T10303/);
  });

  it('throws when corruptPath is not provided', () => {
    const logger = makeLogger();
    expect(() =>
      recoverMalformedBrainDb({
        corruptPath: '',
        snapshotDir: tmpdir(),
        logger,
      }),
    ).toThrow(/corruptPath/);
  });

  it('quarantine directory has a timestamp suffix and contains the malformed file', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleo-test-recover-qdir-'));
    const cleoDir = join(root, '.cleo');
    const snapshotDir = join(cleoDir, 'backups', 'snapshot');
    const corruptPath = join(cleoDir, 'brain.db');
    mkdirSync(snapshotDir, { recursive: true });
    const snap = join(snapshotDir, 'brain.db.snapshot-2026-05-23T08-00-55-563Z');
    seedHealthyBrainDb(snap, 1);
    writeCorruptFile(corruptPath);

    const logger = makeLogger();
    const result = recoverMalformedBrainDb({ corruptPath, snapshotDir, logger });

    expect(result.quarantineDir).not.toBeNull();
    const qdir = result.quarantineDir as string;
    expect(qdir).toMatch(/brain-malformed-/);
    const stat = statSync(qdir);
    expect(stat.isDirectory()).toBe(true);
    expect(existsSync(join(qdir, 'brain.db.malformed'))).toBe(true);
  });
});
