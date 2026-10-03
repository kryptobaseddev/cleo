/**
 * T13115 — the twin collapse drains the bare `token_usage` table into
 * `tasks_token_usage` at every open: rows the twin lacks are carried, rows it
 * already holds identically are only removed, and a row the twin refuses,
 * holds a different copy of, or has no column for stays behind as a conflict
 * that is not decided again. Nothing is lost, so no snapshot is taken, and
 * nothing about a token row can fail the open. Real full-column stores and
 * cut-down legacy shapes both work.
 *
 * Every open goes through the real tasks-domain bind (`bindTasksDomain`), which
 * runs the collapse with `onFailure: 'degrade'`.
 *
 * @task T13115
 * @epic T12323
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteTokenUsage,
  listTokenUsage,
  recordTokenExchange,
} from '../../metrics/token-service.js';
import { bindTasksDomain, closeDb } from '../sqlite.js';
import { storeWriteBlock } from '../store-write-guard.js';
import {
  collapseTwinTables,
  inspectTwinCollapse,
  TWIN_COLLAPSE_MARKER_PREFIX,
  twinCollapseFailureOf,
} from '../twin-collapse.js';

const MARKER = `${TWIN_COLLAPSE_MARKER_PREFIX}token_usage`;
/** Index of the token pair in the receipts and in the inspect output. */
const TOKEN = 3;
const AT = '2026-01-01 00:00:00';

let root: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-token-drain-T13115-')));
  mkdirSync(join(root, '.cleo'), { recursive: true });
  for (const k of ['CLEO_DIR', 'CLEO_HOME']) saved[k] = process.env[k];
  process.env['CLEO_DIR'] = join(root, '.cleo');
  process.env['CLEO_HOME'] = join(root, 'cleo-home');
});

afterEach(() => {
  closeDb();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const dbPath = () => join(root, '.cleo', 'cleo.db');

/** The collapse snapshots written so far (`.cleo/backups/sqlite/cleo.db.migration-*`). */
function snapshots(): string[] {
  const dir = join(root, '.cleo', 'backups', 'sqlite');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('cleo.db.migration-')) : [];
}

/** Open the project through the tasks-domain bind (the collapse runs there). */
async function open(): Promise<DatabaseSync> {
  return (await bindTasksDomain(root)).native;
}

/** Close every handle and open again: what the next CLI process sees. */
async function reopen(): Promise<DatabaseSync> {
  closeDb();
  return open();
}

/** Insert a token row as an older build (bare) or this build (twin) wrote it. */
function row(
  db: DatabaseSync,
  table: 'token_usage' | 'tasks_token_usage',
  id: string,
  fields: Record<string, string | number> = {},
): void {
  const r = { id, created_at: AT, transport: 'cli', gateway: 'mutate', domain: 'tasks', ...fields };
  const cols = Object.keys(r);
  db.prepare(
    `INSERT INTO main.${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).run(...Object.values(r));
}

const ids = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`SELECT id FROM main.${table} ORDER BY id`).all() as Array<{ id: string }>).map((r) =>
    String(r.id),
  );

interface Marker {
  snapshot: string | null;
  lastMergedAt: string;
  conflicts: string[];
}

function marker(db: DatabaseSync): Marker | undefined {
  const raw = db.prepare('SELECT value FROM main.tasks_schema_meta WHERE key = ?').get(MARKER) as
    | { value: string }
    | undefined;
  return raw === undefined ? undefined : (JSON.parse(raw.value) as Marker);
}

/** Make the next open run the initial collapse again (an upgraded store has no marker). */
function forgetMarker(db: DatabaseSync): void {
  db.prepare('DELETE FROM main.tasks_schema_meta WHERE key = ?').run(MARKER);
}

describe('token_usage drain into tasks_token_usage (T13115)', () => {
  it('an upgraded store drains on its first open: carried, already held, and differing rows', async () => {
    let db = await open();
    row(db, 'token_usage', 'carry-1', { total_tokens: 5 });
    row(db, 'token_usage', 'carry-2', { session_id: 'ses-old', total_tokens: 7 });
    // A store an older build reconciled holds the same row in both tables.
    row(db, 'token_usage', 'same-1', { total_tokens: 3 });
    row(db, 'tasks_token_usage', 'same-1', { total_tokens: 3 });
    row(db, 'token_usage', 'diff-1', { total_tokens: 1 });
    row(db, 'tasks_token_usage', 'diff-1', { total_tokens: 99 });
    forgetMarker(db);
    const before = snapshots();

    db = await reopen();
    // Each row lands in the twin once; the differing bare copy stays where it is.
    expect(ids(db, 'tasks_token_usage')).toEqual(['carry-1', 'carry-2', 'diff-1', 'same-1']);
    expect(ids(db, 'token_usage')).toEqual(['diff-1']);
    const kept = db.prepare("SELECT total_tokens AS t FROM tasks_token_usage WHERE id = 'diff-1'");
    expect(kept.get()).toEqual({ t: 99 });
    const m = marker(db);
    expect(m?.conflicts).toEqual([
      'diff-1: kept in token_usage (tasks_token_usage holds another copy)',
    ]);
    // Lossless: no snapshot is taken, and the marker names none.
    expect(m?.snapshot).toBeNull();
    expect(snapshots()).toEqual(before);
    expect((await listTokenUsage(root)).total).toBe(4);

    // The next open has nothing to decide: the left-behind copy is not looked at again.
    db = await reopen();
    expect(marker(db)?.lastMergedAt).toBe(m?.lastMergedAt);
    expect(inspectTwinCollapse(db)[TOKEN]?.state).toBe('collapsed');
  });

  it('a twin row deleted after the drain never comes back from a left-behind bare copy', async () => {
    let db = await open();
    row(db, 'token_usage', 'diff-1', { total_tokens: 1 });
    row(db, 'tasks_token_usage', 'diff-1', { total_tokens: 99 });
    forgetMarker(db);
    db = await reopen();
    expect(ids(db, 'token_usage')).toEqual(['diff-1']);

    await deleteTokenUsage(root, { id: 'diff-1' });
    // An older build writes another row, so the next open merges again.
    row(db, 'token_usage', 'late-1');
    db = await reopen();
    expect(ids(db, 'tasks_token_usage')).toEqual(['late-1']);
    expect(ids(db, 'token_usage')).toEqual(['diff-1']);
    // The conflict keeps the reason the row was left for.
    expect(marker(db)?.conflicts).toEqual([
      'diff-1: kept in token_usage (tasks_token_usage holds another copy)',
    ]);
  });

  it('is idempotent, and a row an older build writes later is drained at the next open', async () => {
    let db = await open();
    const first = marker(db);
    expect(first).toBeDefined();
    db = await reopen();
    expect(marker(db)?.lastMergedAt).toBe(first?.lastMergedAt);
    expect(inspectTwinCollapse(db)[TOKEN]?.state).toBe('collapsed');

    row(db, 'token_usage', 'late-1');
    expect(inspectTwinCollapse(db)[TOKEN]?.state).toBe('bare-changed');
    db = await reopen();
    expect(ids(db, 'token_usage')).toEqual([]);
    expect(ids(db, 'tasks_token_usage')).toEqual(['late-1']);
    // An incremental merge takes no snapshot.
    expect(marker(db)?.snapshot).toBe(first?.snapshot ?? null);
  });

  it('a row the twin refuses stays in the bare table as a conflict and never fails the open', async () => {
    let db = await open();
    row(db, 'token_usage', 'ok-1');
    row(db, 'token_usage', 'bad-1', { transport: 'carrier-pigeon' });
    forgetMarker(db);

    db = await reopen();
    expect(twinCollapseFailureOf(db)).toBeUndefined();
    expect(ids(db, 'tasks_token_usage')).toEqual(['ok-1']);
    expect(ids(db, 'token_usage')).toEqual(['bad-1']);
    expect(marker(db)?.conflicts.find((c) => c.startsWith('bad-1: not carried'))).toMatch(
      /CHECK constraint failed/,
    );
    expect(inspectTwinCollapse(db)[TOKEN]?.state).toBe('collapsed');
    // Token writes are open.
    await recordTokenExchange(root, { transport: 'cli', gateway: 'mutate', requestId: 'r' });
    expect(ids(db, 'tasks_token_usage')).toHaveLength(2);

    // A later merge does not try the refused row again, and still lists why it stayed.
    row(db, 'token_usage', 'late-1');
    db = await reopen();
    expect(ids(db, 'token_usage')).toEqual(['bad-1']);
    expect(marker(db)?.conflicts).toHaveLength(1);
    expect(marker(db)?.conflicts[0]).toMatch(/^bad-1: not carried \(CHECK constraint failed/);
  });

  it('a cut-down legacy bare table drains the columns it has; the twin fills its defaults', async () => {
    let db = await open();
    db.exec('DROP TABLE main.token_usage');
    db.exec(
      'CREATE TABLE main.token_usage (id TEXT PRIMARY KEY, transport TEXT, total_tokens INTEGER)',
    );
    db.exec("INSERT INTO main.token_usage VALUES ('legacy-1', 'cli', 11), ('legacy-2', 'mcp', 12)");
    forgetMarker(db);

    db = await reopen();
    expect(twinCollapseFailureOf(db)).toBeUndefined();
    expect(ids(db, 'token_usage')).toEqual([]);
    const carried = db
      .prepare(
        'SELECT id, transport, total_tokens AS t, provider, method FROM tasks_token_usage ORDER BY id',
      )
      .all();
    expect(carried).toEqual([
      { id: 'legacy-1', transport: 'cli', t: 11, provider: 'unknown', method: 'heuristic' },
      { id: 'legacy-2', transport: 'mcp', t: 12, provider: 'unknown', method: 'heuristic' },
    ]);
  });

  it('a bare row with a value in a column the twin lacks stays in the bare table', async () => {
    let db = await open();
    db.exec('ALTER TABLE main.token_usage ADD COLUMN legacy_note TEXT');
    row(db, 'token_usage', 'plain-1');
    row(db, 'token_usage', 'noted-1', { legacy_note: 'only the bare table can hold this' });
    forgetMarker(db);

    db = await reopen();
    expect(twinCollapseFailureOf(db)).toBeUndefined();
    expect(ids(db, 'tasks_token_usage')).toEqual(['plain-1']);
    expect(ids(db, 'token_usage')).toEqual(['noted-1']);
    expect(marker(db)?.conflicts).toEqual([
      'noted-1: not carried (tasks_token_usage has no column legacy_note)',
    ]);
  });

  it('a cut-down bare table without a key that holds an id twice keeps both rows', async () => {
    let db = await open();
    db.exec('DROP TABLE main.token_usage');
    db.exec('CREATE TABLE main.token_usage (id TEXT, transport TEXT, total_tokens INTEGER)');
    db.exec(
      "INSERT INTO main.token_usage VALUES ('dup-1', 'cli', 1), ('dup-1', 'api', 2), ('one-1', 'cli', 3)",
    );
    forgetMarker(db);

    db = await reopen();
    expect(twinCollapseFailureOf(db)).toBeUndefined();
    expect(ids(db, 'tasks_token_usage')).toEqual(['one-1']);
    expect(ids(db, 'token_usage')).toEqual(['dup-1', 'dup-1']);
    expect(marker(db)?.conflicts).toEqual([
      'dup-1: not carried (token_usage holds this id more than once)',
    ]);
  });

  it('a cut-down twin (the exodus fixture shape) refuses what it cannot hold without failing the open', async () => {
    let db = await open();
    db.exec('DROP TABLE main.tasks_token_usage');
    db.exec(
      `CREATE TABLE main.tasks_token_usage (id INTEGER PRIMARY KEY,
        transport TEXT CHECK ("transport" IN ('cli', 'api', 'agent', 'mcp', 'unknown')))`,
    );
    row(db, 'token_usage', 'uuid-like-1');
    forgetMarker(db);

    db = await reopen();
    expect(twinCollapseFailureOf(db)).toBeUndefined();
    expect(ids(db, 'token_usage')).toEqual(['uuid-like-1']);
    expect(ids(db, 'tasks_token_usage')).toEqual([]);
    expect(marker(db)?.conflicts[0]).toMatch(/^uuid-like-1: not carried/);
  });

  it('a failed drain degrades: reads include the planned rows, token writes are refused, nothing else is blocked', async () => {
    let db = await open();
    row(db, 'tasks_token_usage', 'held-1');
    row(db, 'token_usage', 'deg-1', { total_tokens: 8 });
    db.exec(
      "CREATE TRIGGER main.t13115_block BEFORE DELETE ON token_usage BEGIN SELECT RAISE(ABORT, 'blocked by the test'); END",
    );

    db = await reopen();
    expect(twinCollapseFailureOf(db)?.tables).toEqual(['token_usage']);
    expect(inspectTwinCollapse(db)[TOKEN]?.state).toBe('failed');
    // Reads see the twin with the planned rows (the TEMP shadow) …
    expect((await listTokenUsage(root)).records.map((r) => r.id).sort()).toEqual([
      'deg-1',
      'held-1',
    ]);
    // … main is untouched …
    expect(ids(db, 'tasks_token_usage')).toEqual(['held-1']);
    expect(ids(db, 'token_usage')).toEqual(['deg-1']);
    // … token writes are refused at the accessor, and no dispatch domain is blocked.
    await expect(
      recordTokenExchange(root, { transport: 'cli', gateway: 'mutate', requestId: 'r' }),
    ).rejects.toThrow(/Twin collapse of token_usage failed/);
    expect(await storeWriteBlock(root, { domain: 'tasks', operation: 'add' })).toBeNull();
    expect(await storeWriteBlock(root, { domain: 'admin', operation: 'token.record' })).toBeNull();

    // Once the cause is gone, the retry drains and drops the shadow.
    db.exec('DROP TRIGGER main.t13115_block');
    const receipts = collapseTwinTables(db, dbPath(), { onFailure: 'throw' });
    expect(receipts[TOKEN]).toMatchObject({ status: 'incremental', inserted: 1, deleted: 1 });
    expect(twinCollapseFailureOf(db)).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM temp.sqlite_master WHERE name = 'tasks_token_usage'").get(),
    ).toBeUndefined();
    expect(ids(db, 'tasks_token_usage')).toEqual(['deg-1', 'held-1']);
    expect(ids(db, 'token_usage')).toEqual([]);
  });
});
