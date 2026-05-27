/**
 * T9073 — DB schema test: severity CHECK widened to allow any role.
 *
 * After migration 20260508000000_t9073-severity-any-role, the constraint
 * changes from:
 *   severity IS NULL OR (severity IN ('P0','P1','P2','P3') AND role='bug')
 * to:
 *   severity IS NULL OR severity IN ('P0','P1','P2','P3')
 *
 * This test verifies:
 * 1. severity=P1 on role='spike'  ACCEPTED  (previously rejected)
 * 2. severity=P0 on role='work'   ACCEPTED  (previously rejected)
 * 3. severity=P2 on role='bug'    ACCEPTED  (still valid)
 * 4. severity='INVALID' on any role  REJECTED  (still invalid)
 * 5. severity=NULL on any role    ACCEPTED  (unchanged)
 *
 * @task T9073
 * @epic T9067
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;

describe('T9073 severity CHECK — widened to any role', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-t9073-schema-'));
    const cleoDir = join(tempDir, '.cleo');
    process.env['CLEO_DIR'] = cleoDir;

    await mkdir(cleoDir, { recursive: true });
    await writeFile(
      join(cleoDir, 'config.json'),
      JSON.stringify({
        enforcement: { session: { requiredForMutate: false } },
        lifecycle: { mode: 'off' },
        verification: { enabled: false },
      }),
    );

    const { closeDb } = await import('../sqlite.js');
    closeDb();
  });

  afterEach(async () => {
    const { closeDb } = await import('../sqlite.js');
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('ACCEPTS severity=P1 on role=spike (non-bug role)', async () => {
    const { getDb, getNativeTasksDb } = await import('../sqlite.js');
    await getDb();
    const nativeDb = getNativeTasksDb();
    expect(nativeDb).toBeTruthy();
    if (!nativeDb) return;

    const now = new Date().toISOString();
    const insert = nativeDb.prepare(
      `INSERT INTO tasks (id, title, description, status, priority, role, scope, severity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // Must NOT throw — T9073 widened the CHECK
    expect(() =>
      insert.run(
        'T_SPIKE_SEV',
        'Spike with severity',
        'Non-bug role with severity',
        'pending',
        'medium',
        'spike',
        'feature',
        'P1',
        now,
      ),
    ).not.toThrow();

    const row = nativeDb
      .prepare('SELECT role, severity FROM tasks WHERE id = ?')
      .get('T_SPIKE_SEV') as { role: string; severity: string };
    expect(row.role).toBe('spike');
    expect(row.severity).toBe('P1');
  });

  it('ACCEPTS severity=P0 on role=work (general role)', async () => {
    const { getDb, getNativeTasksDb } = await import('../sqlite.js');
    await getDb();
    const nativeDb = getNativeTasksDb();
    expect(nativeDb).toBeTruthy();
    if (!nativeDb) return;

    const now = new Date().toISOString();
    const insert = nativeDb.prepare(
      `INSERT INTO tasks (id, title, description, status, priority, role, scope, severity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    expect(() =>
      insert.run(
        'T_WORK_SEV',
        'Work task with severity',
        'General work with P0',
        'pending',
        'high',
        'work',
        'feature',
        'P0',
        now,
      ),
    ).not.toThrow();

    const row = nativeDb
      .prepare('SELECT role, severity FROM tasks WHERE id = ?')
      .get('T_WORK_SEV') as { role: string; severity: string };
    expect(row.role).toBe('work');
    expect(row.severity).toBe('P0');
  });

  it('ACCEPTS severity=P2 on role=bug (original valid pairing still works)', async () => {
    const { getDb, getNativeTasksDb } = await import('../sqlite.js');
    await getDb();
    const nativeDb = getNativeTasksDb();
    expect(nativeDb).toBeTruthy();
    if (!nativeDb) return;

    const now = new Date().toISOString();
    const insert = nativeDb.prepare(
      `INSERT INTO tasks (id, title, description, status, priority, role, scope, severity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    expect(() =>
      insert.run(
        'T_BUG_SEV',
        'Bug with P2',
        'Still valid',
        'pending',
        'medium',
        'bug',
        'feature',
        'P2',
        now,
      ),
    ).not.toThrow();

    const row = nativeDb
      .prepare('SELECT role, severity FROM tasks WHERE id = ?')
      .get('T_BUG_SEV') as { role: string; severity: string };
    expect(row.role).toBe('bug');
    expect(row.severity).toBe('P2');
  });

  it('REJECTS severity=INVALID on any role', async () => {
    const { getDb, getNativeTasksDb } = await import('../sqlite.js');
    await getDb();
    const nativeDb = getNativeTasksDb();
    expect(nativeDb).toBeTruthy();
    if (!nativeDb) return;

    const now = new Date().toISOString();
    const insert = nativeDb.prepare(
      `INSERT INTO tasks (id, title, description, status, priority, role, scope, severity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    expect(() =>
      insert.run(
        'T_BAD_SEV',
        'Bad severity',
        'Invalid level',
        'pending',
        'medium',
        'bug',
        'feature',
        'INVALID',
        now,
      ),
    ).toThrowError(/CHECK|constraint/i);
  });

  it('ACCEPTS severity=NULL on any role', async () => {
    const { getDb, getNativeTasksDb } = await import('../sqlite.js');
    await getDb();
    const nativeDb = getNativeTasksDb();
    expect(nativeDb).toBeTruthy();
    if (!nativeDb) return;

    const now = new Date().toISOString();
    const insert = nativeDb.prepare(
      `INSERT INTO tasks (id, title, description, status, priority, role, scope, severity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    expect(() =>
      insert.run(
        'T_NULL_SEV',
        'Null severity',
        'No severity set',
        'pending',
        'medium',
        'spike',
        'feature',
        null,
        now,
      ),
    ).not.toThrow();

    const row = nativeDb
      .prepare('SELECT role, severity FROM tasks WHERE id = ?')
      .get('T_NULL_SEV') as { role: string; severity: string | null };
    expect(row.role).toBe('spike');
    expect(row.severity).toBeNull();
  });
});
