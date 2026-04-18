import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coreDoctorReport, getSystemHealth } from '../health.js';

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as typeof import('node:sqlite');

describe('system health audit_log checks', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'cleo-health-'));
  });

  afterEach(async () => {
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('reports audit_log as pass when table exists', async () => {
    const { getDb, closeDb } = await import('../../store/sqlite.js');
    await getDb(projectRoot);
    closeDb();

    const result = await getSystemHealth(projectRoot);
    const auditLog = result.checks.find((c) => c.name === 'audit_log');

    expect(auditLog).toBeDefined();
    expect(auditLog?.status).toBe('pass');
    expect(auditLog?.message).toContain('audit_log table available');
  });

  it('reports audit_log as fail when table is missing', async () => {
    const cleoDir = join(projectRoot, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    const dbPath = join(cleoDir, 'tasks.db');

    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY)');
    db.close();
    expect(existsSync(dbPath)).toBe(true);

    const result = await getSystemHealth(projectRoot);
    const auditLog = result.checks.find((c) => c.name === 'audit_log');

    expect(auditLog).toBeDefined();
    expect(auditLog?.status).toBe('fail');
    expect(auditLog?.message).toContain('audit_log table missing');
  });

  it('includes audit_log check in doctor report', async () => {
    const { getDb, closeDb } = await import('../../store/sqlite.js');
    await getDb(projectRoot);
    closeDb();

    const report = await coreDoctorReport(projectRoot);
    const auditLog = report.checks.find((c) => c.check === 'audit_log');

    expect(auditLog).toBeDefined();
    expect(auditLog?.status).toBe('ok');
    expect(auditLog?.message).toContain('audit_log table available');
  });
});

describe('T929 regression: getSystemHealth DB integrity checks', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'cleo-health-t929-'));
  });

  afterEach(async () => {
    try {
      const { closeDb } = await import('../../store/sqlite.js');
      closeDb();
    } catch {
      /* ignore */
    }
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('reports tasks_db as pass with integrity ok when the database is a valid SQLite file', async () => {
    const { getDb, closeDb } = await import('../../store/sqlite.js');
    await getDb(projectRoot);
    closeDb();

    const result = await getSystemHealth(projectRoot);
    const check = result.checks.find((c) => c.name === 'tasks_db');

    expect(check).toBeDefined();
    expect(check?.status).toBe('pass');
    expect(check?.message).toContain('integrity ok');
  });

  it('reports tasks_db as fail when the file contains random bytes (not a valid SQLite DB)', async () => {
    const cleoDir = join(projectRoot, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    const dbPath = join(cleoDir, 'tasks.db');
    // Write 1 KiB of non-SQLite content — simulates the corrupt-DB repro case.
    const junk = Buffer.alloc(1024, 0xde);
    writeFileSync(dbPath, junk);

    const result = await getSystemHealth(projectRoot);
    const check = result.checks.find((c) => c.name === 'tasks_db');

    expect(check).toBeDefined();
    expect(check?.status).toBe('fail');
    // Must NOT report a size-only pass like "tasks.db: 1024 bytes"
    expect(check?.message).not.toMatch(/^\d+ bytes$/);
  });
});
