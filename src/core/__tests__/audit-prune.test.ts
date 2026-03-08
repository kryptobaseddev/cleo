import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoggingConfig } from '../../types/config.js';
import { pruneAuditLog } from '../audit-prune.js';

/** Insert audit_log rows with given timestamps into a test DB. */
async function insertAuditRows(
  projectRoot: string,
  rows: { id: string; timestamp: string; action: string; taskId: string }[],
): Promise<void> {
  const { getDb } = await import('../../store/sqlite.js');
  const { auditLog } = await import('../../store/tasks-schema.js');
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
  const { getDb } = await import('../../store/sqlite.js');
  const { auditLog } = await import('../../store/tasks-schema.js');
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
    const { getDb } = await import('../../store/sqlite.js');
    await getDb(projectRoot);
  });

  afterEach(async () => {
    // Reset DB cache so the next test gets a fresh DB
    const { resetDbState } = await import('../../store/sqlite.js');
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
});
