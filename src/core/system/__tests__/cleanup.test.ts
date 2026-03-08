import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupSystem } from '../cleanup.js';

async function insertAuditRows(
  projectRoot: string,
  rows: { id: string; timestamp: string; action: string; taskId: string }[],
): Promise<void> {
  const { getDb } = await import('../../../store/sqlite.js');
  const { auditLog } = await import('../../../store/tasks-schema.js');
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

async function countAuditRows(projectRoot: string): Promise<number> {
  const { getDb } = await import('../../../store/sqlite.js');
  const { auditLog } = await import('../../../store/tasks-schema.js');
  const db = await getDb(projectRoot);
  const rows = await db.select().from(auditLog);
  return rows.length;
}

describe('cleanupSystem logs target', () => {
  let tempDir: string;
  let projectRoot: string;
  let cleoDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-cleanup-'));
    projectRoot = tempDir;
    cleoDir = join(projectRoot, '.cleo');
    await mkdir(cleoDir, { recursive: true });

    const { getDb } = await import('../../../store/sqlite.js');
    await getDb(projectRoot);
  });

  afterEach(async () => {
    const { resetDbState } = await import('../../../store/sqlite.js');
    resetDbState();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('prunes audit_log rows and removes legacy rotated files', async () => {
    await writeFile(
      join(cleoDir, 'config.json'),
      JSON.stringify({ logging: { auditRetentionDays: 30, archiveBeforePrune: false } }, null, 2),
      'utf-8',
    );

    const oldTimestamp = new Date(Date.now() - 45 * 86_400_000).toISOString();
    const recentTimestamp = new Date().toISOString();
    await insertAuditRows(projectRoot, [
      { id: 'old-1', timestamp: oldTimestamp, action: 'add', taskId: 'T1' },
      { id: 'recent-1', timestamp: recentTimestamp, action: 'update', taskId: 'T2' },
    ]);

    await writeFile(join(cleoDir, 'audit-log-2026-01-01.json'), '{}', 'utf-8');
    await writeFile(join(cleoDir, 'audit-log-2026-01-02.json'), '{}', 'utf-8');
    await writeFile(join(cleoDir, 'audit-log.json'), '{}', 'utf-8');

    const result = await cleanupSystem(projectRoot, { target: 'logs' });

    expect(result.deleted).toBe(2);
    expect(result.items).toHaveLength(2);
    expect(result.items).toContain('audit-log-2026-01-01.json');
    expect(result.items).toContain('audit-log-2026-01-02.json');
    expect(result.prunedRows).toBe(1);
    expect(result.archivedRows).toBe(0);

    await expect(access(join(cleoDir, 'audit-log-2026-01-01.json'))).rejects.toThrow();
    await expect(access(join(cleoDir, 'audit-log-2026-01-02.json'))).rejects.toThrow();
    await expect(access(join(cleoDir, 'audit-log.json'))).resolves.toBeUndefined();

    const remaining = await countAuditRows(projectRoot);
    expect(remaining).toBe(1);
  });

  it('does not prune or delete when dryRun=true', async () => {
    await writeFile(
      join(cleoDir, 'config.json'),
      JSON.stringify({ logging: { auditRetentionDays: 30, archiveBeforePrune: true } }, null, 2),
      'utf-8',
    );

    const oldTimestamp = new Date(Date.now() - 45 * 86_400_000).toISOString();
    await insertAuditRows(projectRoot, [
      { id: 'old-1', timestamp: oldTimestamp, action: 'add', taskId: 'T1' },
    ]);

    await writeFile(join(cleoDir, 'audit-log-2026-01-01.json'), '{}', 'utf-8');

    const result = await cleanupSystem(projectRoot, { target: 'logs', dryRun: true });

    expect(result.deleted).toBe(0);
    expect(result.items).toEqual(['audit-log-2026-01-01.json']);
    expect(result.prunedRows).toBeUndefined();

    await expect(access(join(cleoDir, 'audit-log-2026-01-01.json'))).resolves.toBeUndefined();
    const remaining = await countAuditRows(projectRoot);
    expect(remaining).toBe(1);
  });
});
