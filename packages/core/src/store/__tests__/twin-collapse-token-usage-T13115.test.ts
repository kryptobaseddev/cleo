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
  setTokenDrainChunkForTests,
  TWIN_COLLAPSE_MARKER_PREFIX,
  twinCollapseFailureOf,
} from '../twin-collapse.js';
import { optOutOfForeignKeys } from './test-db-helper.js';

// T13228: fixtures seed bare legacy rows with references the drain resolves; they run with foreign keys OFF.
optOutOfForeignKeys();

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

  it('a failed drain degrades nothing: the twin serves reads, token writes go on, the next open retries', async () => {
    let db = await open();
    row(db, 'tasks_token_usage', 'held-1');
    row(db, 'token_usage', 'deg-1', { total_tokens: 8 });
    db.exec(
      "CREATE TRIGGER main.t13115_block BEFORE DELETE ON token_usage BEGIN SELECT RAISE(ABORT, 'blocked by the test'); END",
    );

    db = await reopen();
    // Recorded for cleo doctor, but no shadow, no refused write, no degraded connection.
    expect(twinCollapseFailureOf(db)).toBeUndefined();
    expect(inspectTwinCollapse(db)[TOKEN]?.state).toBe('failed');
    expect(
      db.prepare("SELECT 1 FROM temp.sqlite_master WHERE name = 'tasks_token_usage'").get(),
    ).toBeUndefined();
    expect((await listTokenUsage(root)).records.map((r) => r.id)).toEqual(['held-1']);
    await recordTokenExchange(root, { transport: 'cli', gateway: 'mutate', requestId: 'r' });
    expect(ids(db, 'tasks_token_usage')).toHaveLength(2);
    expect(await storeWriteBlock(root, { domain: 'tasks', operation: 'add' })).toBeNull();
    expect(ids(db, 'token_usage')).toEqual(['deg-1']);

    // Once the cause is gone, the next open drains it and clears the failure.
    db.exec('DROP TRIGGER main.t13115_block');
    db = await reopen();
    expect(ids(db, 'token_usage')).toEqual([]);
    expect(ids(db, 'tasks_token_usage')).toContain('deg-1');
    expect(inspectTwinCollapse(db)[TOKEN]?.state).toBe('collapsed');
    // An explicit retry has nothing left to do.
    const receipts = collapseTwinTables(db, dbPath(), { onFailure: 'throw' });
    expect(receipts[TOKEN]?.status).toBe('unchanged');
  });

  it('a long backlog drains in bounded transactions, all in one open', async () => {
    setTokenDrainChunkForTests(2);
    try {
      let db = await open();
      for (let i = 1; i <= 5; i++) row(db, 'token_usage', `bulk-${i}`);
      forgetMarker(db);
      db = await reopen();
      expect(ids(db, 'token_usage')).toEqual([]);
      expect(ids(db, 'tasks_token_usage')).toEqual([
        'bulk-1',
        'bulk-2',
        'bulk-3',
        'bulk-4',
        'bulk-5',
      ]);
      expect(marker(db)?.conflicts).toEqual([]);
    } finally {
      setTokenDrainChunkForTests(undefined);
    }
  });

  it('a row left behind before a long backlog stays left behind through every chunk', async () => {
    let db = await open();
    // The bare copy differs from the twin's: left behind by the first merge.
    row(db, 'token_usage', 'diff-1', { total_tokens: 1 });
    row(db, 'tasks_token_usage', 'diff-1', { total_tokens: 99 });
    forgetMarker(db);
    db = await reopen();
    expect(ids(db, 'token_usage')).toEqual(['diff-1']);
    await deleteTokenUsage(root, { id: 'diff-1' });

    setTokenDrainChunkForTests(2);
    try {
      // A backlog that takes three chunks; diff-1 comes first in the scan, the
      // undecided rows after it.
      for (let i = 1; i <= 5; i++) row(db, 'token_usage', `late-${i}`);
      db = await reopen();
      expect(ids(db, 'token_usage')).toEqual(['diff-1']);
      expect(ids(db, 'tasks_token_usage')).toEqual([
        'late-1',
        'late-2',
        'late-3',
        'late-4',
        'late-5',
      ]);
      // Nothing waiting was ever recorded as left behind, and diff-1 never came back.
      expect(marker(db)?.conflicts).toEqual([
        'diff-1: kept in token_usage (tasks_token_usage holds another copy)',
      ]);
    } finally {
      setTokenDrainChunkForTests(undefined);
    }
  });

  it('a left-behind row the bounded scan does not reach is still left behind', async () => {
    let db = await open();
    // diff-1 sits at rowid 1000, so a bounded scan stops before it.
    db.prepare(
      `INSERT INTO main.token_usage (rowid, id, created_at, transport, total_tokens) VALUES (1000, 'diff-1', ?, 'cli', 1)`,
    ).run(AT);
    row(db, 'tasks_token_usage', 'diff-1', { total_tokens: 99 });
    forgetMarker(db);
    db = await reopen();
    expect(ids(db, 'token_usage')).toEqual(['diff-1']);
    await deleteTokenUsage(root, { id: 'diff-1' });

    setTokenDrainChunkForTests(2);
    try {
      for (let i = 1; i <= 5; i++) {
        db.prepare(
          `INSERT INTO main.token_usage (rowid, id, created_at, transport) VALUES (?, ?, ?, 'cli')`,
        ).run(i, `early-${i}`, AT);
      }
      db = await reopen();
      expect(ids(db, 'token_usage')).toEqual(['diff-1']);
      expect(ids(db, 'tasks_token_usage')).not.toContain('diff-1');
      expect(ids(db, 'tasks_token_usage')).toHaveLength(5);
    } finally {
      setTokenDrainChunkForTests(undefined);
    }
  });

  it("another pair's initial snapshot is never named by the token marker", async () => {
    let db = await open();
    // schema_meta's initial collapse changes its twin (a bare-only key), so this open takes a snapshot.
    db.prepare(`DELETE FROM main.tasks_schema_meta WHERE key = ?`).run(
      `${TWIN_COLLAPSE_MARKER_PREFIX}schema_meta`,
    );
    db.prepare(`INSERT INTO main.schema_meta (key, value) VALUES ('t13115_probe', '1')`).run();
    row(db, 'token_usage', 'snap-1');
    forgetMarker(db);
    const before = snapshots();

    db = await reopen();
    const schemaMeta = db
      .prepare('SELECT value FROM main.tasks_schema_meta WHERE key = ?')
      .get(`${TWIN_COLLAPSE_MARKER_PREFIX}schema_meta`) as { value: string };
    expect(JSON.parse(schemaMeta.value).snapshot).toBeTruthy();
    expect(snapshots().length).toBe(before.length + 1);
    expect(marker(db)?.snapshot).toBeNull();
    expect(ids(db, 'tasks_token_usage')).toEqual(['snap-1']);
  });

  it('a value the twin would store differently is not carried, and the open is not failed', async () => {
    let db = await open();
    db.exec('DROP TABLE main.token_usage');
    db.exec(
      'CREATE TABLE main.token_usage (id TEXT PRIMARY KEY, transport TEXT, total_tokens TEXT)',
    );
    // The twin's INTEGER affinity stores '0012' as 12 (and '7' as 7): carried rows that do not read back.
    db.exec("INSERT INTO main.token_usage VALUES ('pad-1', 'cli', '0012'), ('pad-2', 'cli', '7')");
    forgetMarker(db);

    db = await reopen();
    // Refused one by one inside the merge, so the drain itself succeeds.
    expect(inspectTwinCollapse(db)[TOKEN]?.state).toBe('collapsed');
    expect(ids(db, 'token_usage')).toEqual(['pad-1', 'pad-2']);
    expect(ids(db, 'tasks_token_usage')).toEqual([]);
    expect(marker(db)?.conflicts).toEqual([
      'pad-1: not carried (the stored row differs)',
      'pad-2: not carried (the stored row differs)',
    ]);
  });
});
