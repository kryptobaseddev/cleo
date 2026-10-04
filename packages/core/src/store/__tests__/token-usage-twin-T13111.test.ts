/**
 * T13111 — token usage is recorded in `tasks_token_usage`, so a row naming a
 * bound session is stored. Rows the bare `token_usage` table holds are drained
 * into the twin by the T12535 collapse at the next open (T13115).
 *
 * Production opens enforce foreign keys; the tasks bind turns them off under
 * VITEST (sqlite.ts), so every test here turns them back on first. Without
 * that, the bare table's FK to the empty bare `sessions` twin, the cause of
 * the loss, would never fire.
 *
 * @task T13111
 * @epic T12323
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearTokenUsage,
  deleteTokenUsage,
  listTokenUsage,
  recordTokenExchange,
  summarizeTokenUsage,
} from '../../metrics/token-service.js';
import { bindTasksDomain, closeDb } from '../sqlite.js';
import { sessions, tasks } from '../tasks-schema.js';

const SESSION = 'ses_20261003000000_t13111';

let root: string;
let savedCleoDir: string | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-token-twin-T13111-')));
  mkdirSync(join(root, '.cleo'), { recursive: true });
  savedCleoDir = process.env['CLEO_DIR'];
  process.env['CLEO_DIR'] = join(root, '.cleo');
});

afterEach(() => {
  closeDb();
  if (savedCleoDir === undefined) delete process.env['CLEO_DIR'];
  else process.env['CLEO_DIR'] = savedCleoDir;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** Open the project's tasks domain (migrating it) with foreign keys enforced, as production does. */
async function open(): Promise<DatabaseSync> {
  const binding = await bindTasksDomain(root);
  binding.native.exec('PRAGMA foreign_keys=ON');
  return binding.native;
}

const count = (db: DatabaseSync, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** A row of the bare table, as a build before this one wrote it. */
function bareRow(db: DatabaseSync, id: string, fields: Record<string, string | number> = {}): void {
  const row = {
    id,
    transport: 'cli',
    gateway: 'mutate',
    domain: 'tasks',
    operation: 'add',
    ...fields,
  };
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO token_usage (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).run(...Object.values(row));
}

describe('token usage in tasks_token_usage (T13111)', () => {
  it('a token row naming a bound session and a live task is stored, where the bare table refused both', async () => {
    const db = await open();
    const drizzle = (await bindTasksDomain(root)).db;
    await drizzle.insert(sessions).values({ id: SESSION, name: 'bound', status: 'active' }).run();
    await drizzle
      .insert(tasks)
      .values({ id: 'T001', title: 'live task', status: 'pending', type: 'task', position: 0 })
      .run();
    expect(count(db, 'tasks_sessions')).toBe(1);
    expect(count(db, 'tasks_tasks')).toBe(1);
    expect(count(db, 'sessions')).toBe(0);
    expect(count(db, 'tasks')).toBe(0);

    // The old path: the bare table's FKs point at the empty bare `sessions` and `tasks` twins.
    expect(() => bareRow(db, 'bare-1', { session_id: SESSION })).toThrow(/FOREIGN KEY/);
    expect(() => bareRow(db, 'bare-2', { task_id: 'T001' })).toThrow(/FOREIGN KEY/);

    const row = await recordTokenExchange(root, {
      requestPayload: { title: 'x' },
      responsePayload: { data: { id: 'T001' } },
      transport: 'cli',
      gateway: 'mutate',
      domain: 'tasks',
      operation: 'add',
      sessionId: SESSION,
      taskId: 'T001',
      requestId: 'req-1',
    });
    expect(row).toMatchObject({ sessionId: SESSION, taskId: 'T001', gateway: 'mutate' });
    expect(count(db, 'tasks_token_usage')).toBe(1);
    expect(count(db, 'token_usage')).toBe(0);
    expect((await listTokenUsage(root, { sessionId: SESSION })).records.map((r) => r.id)).toEqual([
      row.id,
    ]);
  });

  it('reads come from the twin only; a bare row waits for the next open to be drained', async () => {
    let db = await open();
    db.exec('PRAGMA foreign_keys=OFF');
    bareRow(db, 'bare-old-1', { total_tokens: 7 });
    db.exec('PRAGMA foreign_keys=ON');
    const row = await recordTokenExchange(root, {
      requestPayload: {},
      responsePayload: {},
      transport: 'cli',
      gateway: 'mutate',
      domain: 'tasks',
      operation: 'add',
      requestId: 'req-2',
    });
    expect((await listTokenUsage(root)).records.map((r) => r.id)).toEqual([row.id]);
    expect(count(db, 'token_usage')).toBe(1);

    // The next open drains it (T13115): the reports cover it, the bare table is empty.
    closeDb();
    db = await open();
    expect((await listTokenUsage(root)).records.map((r) => r.id).sort()).toEqual(
      ['bare-old-1', row.id].sort(),
    );
    expect((await summarizeTokenUsage(root)).totalTokens).toBe(7 + row.totalTokens);
    expect(count(db, 'token_usage')).toBe(0);
  });

  it('delete and clear touch tasks_token_usage only; the open has drained the bare table into it (T13115)', async () => {
    let db = await open();
    db.exec('PRAGMA foreign_keys=OFF');
    bareRow(db, 'bare-a', { domain: 'tasks' });
    bareRow(db, 'bare-b', { domain: 'memory' });
    bareRow(db, 'bare-c', { domain: 'tasks' });
    db.exec('PRAGMA foreign_keys=ON');

    // Written after this open's drain: the bare table is not touched by a delete or a clear.
    await deleteTokenUsage(root, { id: 'bare-a' });
    expect(await clearTokenUsage(root)).toEqual({ deleted: 0 });
    expect(count(db, 'token_usage')).toBe(3);

    closeDb();
    db = await open();
    expect(count(db, 'token_usage')).toBe(0);
    const twin = await recordTokenExchange(root, {
      requestPayload: {},
      responsePayload: {},
      transport: 'cli',
      gateway: 'mutate',
      domain: 'tasks',
      operation: 'add',
      requestId: 'req-3',
    });
    await deleteTokenUsage(root, { id: 'bare-a' });
    expect(await clearTokenUsage(root, { domain: 'tasks' })).toEqual({ deleted: 2 });
    expect((await listTokenUsage(root)).records.map((r) => r.id)).toEqual(['bare-b']);
    expect((await listTokenUsage(root)).records.map((r) => r.id)).not.toContain(twin.id);

    // Nothing comes back at the next open.
    closeDb();
    db = await open();
    expect((await listTokenUsage(root)).records.map((r) => r.id)).toEqual(['bare-b']);
    expect(await clearTokenUsage(root)).toEqual({ deleted: 1 });
    expect(count(db, 'tasks_token_usage')).toBe(0);
    expect(count(db, 'token_usage')).toBe(0);
  });
});
