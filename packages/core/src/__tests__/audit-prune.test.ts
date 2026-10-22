import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import type { LoggingConfig } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIT_GATE_RECEIPT_ACTION,
  AUDIT_PRUNE_EXEMPT_ACTIONS,
  AUDIT_RETENTION_FLOOR_DAYS,
  AUTO_AUDIT_PRUNE_INTERVAL_MS,
  auditPruneCondition,
  pruneAuditLog,
} from '../audit-prune.js';
import { SAGA_RECONCILE_RECEIPT_ACTION } from '../sagas/reconcile.js';
import { snapshotAfterSessionEnd } from '../sessions/session-end-snapshot.js';
import { AC_BINDINGS_PRUNED_ACTION } from '../store/ac-binding-prune.js';
import { RANKING_CHANGED_ACTION } from '../tasks/ranking-audit.js';

// The session-end path minus its snapshots: only the automatic prune runs for real (T13828).
vi.mock('../store/sqlite-backup.js', () => ({ vacuumIntoBackupAll: async () => null }));
vi.mock('../system/backup.js', () => ({ autoGlobalBackup: async () => null }));

/** Insert audit_log rows with given timestamps into a test DB. */
async function insertAuditRows(
  projectRoot: string,
  rows: { id: string; timestamp: string; action: string; taskId: string }[],
): Promise<void> {
  const { getDb } = await import('../store/sqlite.js');
  const { auditLog } = await import('../store/tasks-schema.js');
  const db = await getDb(projectRoot);

  for (const row of rows) {
    await db
      .insert(auditLog)
      .values({
        id: row.id,
        timestamp: row.timestamp,
        action: row.action,
        taskId: row.taskId,
        actor: 'test',
      })
      .run();
  }
}

/** Count audit_log rows in the DB. */
async function countAuditRows(projectRoot: string): Promise<number> {
  const { getDb } = await import('../store/sqlite.js');
  const { auditLog } = await import('../store/tasks-schema.js');
  const db = await getDb(projectRoot);
  const rows = await db.select().from(auditLog);
  return rows.length;
}

/** Read a gzipped file and return the decompressed content as a string. */
async function readGzipFile(filePath: string): Promise<string> {
  const chunks: Buffer[] = [];
  const gunzip = createGunzip();
  const input = createReadStream(filePath);
  const collectStream = new (await import('node:stream')).Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
      chunks.push(chunk);
      callback();
    },
  });
  await pipeline(input, gunzip, collectStream);
  return Buffer.concat(chunks).toString('utf-8');
}

// Scope cleanup and durable session reads to the explicitly seeded fixture.
beforeEach(() => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('pruneAuditLog', () => {
  let tempDir: string;
  let projectRoot: string;
  let cleoDir: string;

  const defaultConfig: LoggingConfig = {
    level: 'info',
    filePath: 'logs/cleo.log',
    maxFileSize: 10 * 1024 * 1024,
    maxFiles: 5,
    auditRetentionDays: 90,
    archiveBeforePrune: true,
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-audit-prune-'));
    projectRoot = tempDir;
    cleoDir = join(projectRoot, '.cleo');
    await mkdir(cleoDir, { recursive: true });

    // Initialize the DB (runs migrations, creates tables)
    const { getDb } = await import('../store/sqlite.js');
    await getDb(projectRoot);
  });

  afterEach(async () => {
    // Reset DB cache so the next test gets a fresh DB
    const { resetDbState } = await import('../store/sqlite.js');
    resetDbState();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('creates archive file when archiveBeforePrune=true and old rows exist', async () => {
    // Insert rows older than 90 days
    const oldTimestamp = new Date(Date.now() - 100 * 86_400_000).toISOString();
    await insertAuditRows(projectRoot, [
      { id: 'old-1', timestamp: oldTimestamp, action: 'add', taskId: 'T1' },
      { id: 'old-2', timestamp: oldTimestamp, action: 'update', taskId: 'T2' },
    ]);

    const result = await pruneAuditLog(cleoDir, defaultConfig);

    expect(result.rowsArchived).toBe(2);
    expect(result.rowsDeleted).toBe(2);
    expect(result.archivePath).toBeDefined();

    // Verify archive directory exists
    const archiveDir = join(cleoDir, 'backups', 'logs');
    const files = await readdir(archiveDir);
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]).toMatch(/^audit-\d{4}-\d{2}-\d{2}\.jsonl\.gz$/);
  });

  it('deletes rows older than retention period', async () => {
    const oldTimestamp = new Date(Date.now() - 100 * 86_400_000).toISOString();
    const recentTimestamp = new Date().toISOString();

    await insertAuditRows(projectRoot, [
      { id: 'old-1', timestamp: oldTimestamp, action: 'add', taskId: 'T1' },
      { id: 'recent-1', timestamp: recentTimestamp, action: 'add', taskId: 'T2' },
    ]);

    const result = await pruneAuditLog(cleoDir, defaultConfig);

    expect(result.rowsDeleted).toBe(1);
    // Recent row should remain
    const remaining = await countAuditRows(projectRoot);
    expect(remaining).toBe(1);
  });

  it('skips archiving when archiveBeforePrune=false', async () => {
    const oldTimestamp = new Date(Date.now() - 100 * 86_400_000).toISOString();
    await insertAuditRows(projectRoot, [
      { id: 'old-1', timestamp: oldTimestamp, action: 'add', taskId: 'T1' },
    ]);

    const config = { ...defaultConfig, archiveBeforePrune: false };
    const result = await pruneAuditLog(cleoDir, config);

    expect(result.rowsArchived).toBe(0);
    expect(result.rowsDeleted).toBe(1);
    expect(result.archivePath).toBeUndefined();

    // Verify no archive directory was created
    const archiveDir = join(cleoDir, 'backups', 'logs');
    await expect(readdir(archiveDir)).rejects.toThrow();
  });

  it('no-ops when auditRetentionDays=0', async () => {
    const oldTimestamp = new Date(Date.now() - 100 * 86_400_000).toISOString();
    await insertAuditRows(projectRoot, [
      { id: 'old-1', timestamp: oldTimestamp, action: 'add', taskId: 'T1' },
    ]);

    const config = { ...defaultConfig, auditRetentionDays: 0 };
    const result = await pruneAuditLog(cleoDir, config);

    expect(result.rowsArchived).toBe(0);
    expect(result.rowsDeleted).toBe(0);

    // Row should still exist
    const remaining = await countAuditRows(projectRoot);
    expect(remaining).toBe(1);
  });

  it('handles empty audit_log gracefully', async () => {
    const result = await pruneAuditLog(cleoDir, defaultConfig);

    expect(result.rowsArchived).toBe(0);
    expect(result.rowsDeleted).toBe(0);
  });

  it('archive file is valid gzipped JSONL', async () => {
    const oldTimestamp = new Date(Date.now() - 100 * 86_400_000).toISOString();
    await insertAuditRows(projectRoot, [
      { id: 'old-1', timestamp: oldTimestamp, action: 'add', taskId: 'T1' },
      { id: 'old-2', timestamp: oldTimestamp, action: 'update', taskId: 'T2' },
    ]);

    const result = await pruneAuditLog(cleoDir, defaultConfig);
    expect(result.archivePath).toBeDefined();

    // Decompress and verify JSONL format
    const content = await readGzipFile(result.archivePath!);
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(2);

    // Each line should be valid JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('id');
      expect(parsed).toHaveProperty('timestamp');
      expect(parsed).toHaveProperty('action');
      expect(parsed).toHaveProperty('taskId');
    }
  });

  it('never prunes ac.bindings.pruned rows, however old (T12790)', async () => {
    const oldTimestamp = new Date(Date.now() - 400 * 86_400_000).toISOString();
    await insertAuditRows(projectRoot, [
      { id: 'old-plain', timestamp: oldTimestamp, action: 'update', taskId: 'T1' },
      {
        id: 'old-binding',
        timestamp: oldTimestamp,
        action: AC_BINDINGS_PRUNED_ACTION,
        taskId: 'T1',
      },
    ]);

    const result = await pruneAuditLog(cleoDir, defaultConfig);

    expect(result.rowsDeleted).toBe(1);
    expect(result.rowsArchived).toBe(1);
    const { getDb } = await import('../store/sqlite.js');
    const { auditLog } = await import('../store/tasks-schema.js');
    const db = await getDb(projectRoot);
    const remaining = await db.select({ id: auditLog.id }).from(auditLog);
    expect(remaining.map((r) => r.id)).toEqual(['old-binding']);
  });

  it('applies the same exemption to tasks_audit_log (T12790)', async () => {
    const { getDb } = await import('../store/sqlite.js');
    const { tasksAuditLog } = await import('../store/schema/cleo-project/audit.js');
    const db = await getDb(projectRoot);
    const oldTimestamp = new Date(Date.now() - 400 * 86_400_000).toISOString();
    for (const [id, action] of [
      ['old-plain', 'update'],
      ['old-binding', AC_BINDINGS_PRUNED_ACTION],
    ] as const) {
      await db
        .insert(tasksAuditLog)
        .values({ id, timestamp: oldTimestamp, action, taskId: 'T1', actor: 'test' })
        .run();
    }
    const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();

    await db.delete(tasksAuditLog).where(auditPruneCondition(tasksAuditLog, cutoff)).run();

    const remaining = await db.select({ id: tasksAuditLog.id }).from(tasksAuditLog);
    expect(remaining.map((r) => r.id)).toEqual(['old-binding']);
  });
  it("keeps the receipts code reads back, however old: saga and ranking receipts, and an open task's typed-gate receipts (T13777)", async () => {
    const { getNativeTasksDb } = await import('../store/sqlite.js');
    const native = getNativeTasksDb(projectRoot);
    if (!native) throw new Error('no native handle');
    native.exec(
      `INSERT INTO tasks_tasks (id, title, status, priority, type, pipeline_stage) VALUES
         ('T1', 'open', 'active', 'medium', 'task', 'implementation'),
         ('T2', 'done', 'done', 'medium', 'task', 'contribution'),
         ('T3', 'cancelled', 'cancelled', 'medium', 'task', 'cancelled')`,
    );
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    await insertAuditRows(projectRoot, [
      { id: 'plain', timestamp: old, action: 'update', taskId: 'T1' },
      { id: 'saga', timestamp: old, action: SAGA_RECONCILE_RECEIPT_ACTION, taskId: 'T1' },
      { id: 'ranking', timestamp: old, action: RANKING_CHANGED_ACTION, taskId: 'T1' },
      { id: 'gate-open', timestamp: old, action: AUDIT_GATE_RECEIPT_ACTION, taskId: 'T1' },
      { id: 'gate-done', timestamp: old, action: AUDIT_GATE_RECEIPT_ACTION, taskId: 'T2' },
      { id: 'gate-cancelled', timestamp: old, action: AUDIT_GATE_RECEIPT_ACTION, taskId: 'T3' },
    ]);

    const result = await pruneAuditLog(cleoDir, defaultConfig);

    expect(result.rowsDeleted).toBe(3);
    const { getDb } = await import('../store/sqlite.js');
    const { auditLog } = await import('../store/tasks-schema.js');
    const db = await getDb(projectRoot);
    const remaining = (await db.select({ id: auditLog.id }).from(auditLog)).map((r) => r.id);
    expect(remaining.sort()).toEqual(['gate-open', 'ranking', 'saga']);
  });

  it('clamps a retention below the 30-day floor: a 1-day setting keeps the last 30 days (T13777)', async () => {
    const day = 86_400_000;
    await insertAuditRows(projectRoot, [
      {
        id: 'two-days',
        timestamp: new Date(Date.now() - 2 * day).toISOString(),
        action: 'update',
        taskId: 'T1',
      },
      {
        id: 'forty-days',
        timestamp: new Date(Date.now() - 40 * day).toISOString(),
        action: 'update',
        taskId: 'T1',
      },
    ]);

    const result = await pruneAuditLog(cleoDir, { ...defaultConfig, auditRetentionDays: 1 });

    expect(AUDIT_RETENTION_FLOOR_DAYS).toBe(30);
    expect(result.rowsDeleted).toBe(1);
    expect(await countAuditRows(projectRoot)).toBe(1);
  });

  it('names the receipt actions by the constants their writers use (T13777)', () => {
    expect(AUDIT_PRUNE_EXEMPT_ACTIONS).toEqual(
      expect.arrayContaining([SAGA_RECONCILE_RECEIPT_ACTION, RANKING_CHANGED_ACTION]),
    );
  });

  it('session end prunes automatically, at most once a day: an old row goes, a receipt stays (T13828)', async () => {
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    await insertAuditRows(projectRoot, [
      { id: 'plain', timestamp: old, action: 'update', taskId: 'T1' },
      { id: 'saga', timestamp: old, action: SAGA_RECONCILE_RECEIPT_ACTION, taskId: 'T1' },
    ]);
    await snapshotAfterSessionEnd(projectRoot);
    const { getDb } = await import('../store/sqlite.js');
    const { auditLog } = await import('../store/tasks-schema.js');
    const db = await getDb(projectRoot);
    const ids = async () => (await db.select({ id: auditLog.id }).from(auditLog)).map((r) => r.id);
    expect(await ids()).toEqual(['saga']);

    // Within the day a second session end does not prune again.
    await insertAuditRows(projectRoot, [
      { id: 'plain-2', timestamp: old, action: 'update', taskId: 'T1' },
    ]);
    await snapshotAfterSessionEnd(projectRoot);
    expect((await ids()).sort()).toEqual(['plain-2', 'saga']);
    const { autoPruneAuditLog } = await import('../audit-prune.js');
    expect(await autoPruneAuditLog(projectRoot)).toBeNull();
    // A day on, it does.
    const later = new Date(Date.now() + AUTO_AUDIT_PRUNE_INTERVAL_MS);
    expect((await autoPruneAuditLog(projectRoot, later))?.rowsDeleted).toBe(1);
    expect(await ids()).toEqual(['saga']);
  });
});
