/**
 * Row identity of the brain natural-key tables (T12895): page edges, memory
 * links, sticky tags (global) and release links (project). The uid is a
 * UUIDv8 over the primary key, so it is a pure function of the row: two
 * stores derive the same uid for the same edge whenever it was filled.
 *
 * Stores are fresh `cleo.db` files opened through the chokepoint under a
 * `mkdtemp` directory (project at `<root>/.cleo/cleo.db`, global at
 * `<CLEO_HOME>/cleo.db`).
 *
 * @task T12895
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../dual-scope-db.js';
import { missingRowIdentitySchema, naturalRowUid } from '../row-identity.js';
import { ROW_UID_FILL_FLAG } from '../row-identity-flag.js';
import { setCaptureEnabled } from '../sync/capture.js';
import { seedBrainRows } from './brain-identity-fixture.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../migrations/sync-journal');

let dir: string;
let home: string;

function storePath(scope: TableScope, n = 1): string {
  if (scope === 'global') return join(home, 'cleo.db');
  const root = join(dir, `project-${n}`, '.cleo');
  mkdirSync(root, { recursive: true });
  return join(root, 'cleo.db');
}

async function open(scope: TableScope, path: string): Promise<DatabaseSync> {
  _resetDualScopeDbCache();
  const handle = await openDualScopeDbAtPath(scope, path);
  return handle.db.$client as DatabaseSync;
}

function uidOf(db: DatabaseSync, sql: string, ...params: string[]): string | null {
  const row = db.prepare(sql).get(...params) as { uid: string | null } | undefined;
  return row?.uid ?? null;
}

const edgeUid = (db: DatabaseSync, from: string, to: string, type: string) =>
  uidOf(
    db,
    'SELECT uid FROM brain_page_edges WHERE from_id = ? AND to_id = ? AND edge_type = ?',
    from,
    to,
    type,
  );

/** Every natural brain row's uid, keyed by table and primary key. */
function naturalUids(db: DatabaseSync, scope: TableScope): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const tables: Array<[string, string[]]> = [
    ['brain_page_edges', ['from_id', 'to_id', 'edge_type']],
    ['brain_memory_links', ['memory_type', 'memory_id', 'task_id', 'link_type']],
  ];
  if (scope === 'global') tables.push(['brain_sticky_tags', ['sticky_id', 'tag']]);
  if (scope === 'project') {
    tables.push(['tasks_brain_release_links', ['brain_entry_id', 'release_id', 'link_type']]);
  }
  for (const [table, key] of tables) {
    const rows = db.prepare(`SELECT ${key.join(', ')}, uid FROM main."${table}"`).all() as Record<
      string,
      string | null
    >[];
    for (const r of rows) out.set(`${table}:${key.map((k) => r[k]).join('|')}`, r.uid ?? null);
  }
  return out;
}

function seedReleaseLinks(db: DatabaseSync): void {
  db.exec(`INSERT INTO tasks_brain_release_links (brain_entry_id, release_id, link_type, created_at)
    VALUES ('O-0a1b2c3d', 'v2026.10.5', 'observed-in', '2026-09-01 09:13:00')`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-brain-natural-'));
  home = join(dir, 'cleo');
  mkdirSync(home, { recursive: true });
  vi.stubEnv('CLEO_HOME', home);
  vi.stubEnv('XDG_STATE_HOME', join(dir, 'state'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe.each(['project', 'global'] as const)('natural brain identity in the %s store', (scope) => {
  it('an edge uid is a pure function of its raw key, whether or not its nodes exist', async () => {
    const db = await open(scope, storePath(scope));
    seedBrainRows(db, { sticky: scope === 'global' });
    // 'symbol:src/a.ts#f' has no page-node row; 'decision:D0001' has one.
    for (const [from, to, type] of [
      ['decision:D0001', 'symbol:src/a.ts#f', 'code_reference'],
      ['decision:D0001', 'observation:O-0a1b2c3d', 'co_retrieved'],
    ] as const) {
      expect(edgeUid(db, from, to, type)).toBe(
        naturalRowUid(scope, 'brain_page_edges', [from, to, type]),
      );
    }
  });

  it('a pair stored both ways keeps two directed rows with two uids', async () => {
    const db = await open(scope, storePath(scope));
    seedBrainRows(db, { sticky: scope === 'global' });
    const ab = edgeUid(db, 'decision:D0001', 'observation:O-0a1b2c3d', 'co_retrieved');
    const ba = edgeUid(db, 'observation:O-0a1b2c3d', 'decision:D0001', 'co_retrieved');
    expect(ab).not.toBeNull();
    expect(ba).not.toBeNull();
    expect(ab).not.toBe(ba);
    expect(ba).toBe(
      naturalRowUid(scope, 'brain_page_edges', [
        'observation:O-0a1b2c3d',
        'decision:D0001',
        'co_retrieved',
      ]),
    );
  });

  it('two stores derive the same uids, one filled at open and one at insert', async () => {
    vi.stubEnv(ROW_UID_FILL_FLAG, '0');
    const first = storePath(scope, 1);
    const raw = await open(scope, first);
    seedBrainRows(raw, { sticky: scope === 'global' });
    if (scope === 'project') seedReleaseLinks(raw);
    expect([...naturalUids(raw, scope).values()].every((u) => u === null)).toBe(true);
    vi.stubEnv(ROW_UID_FILL_FLAG, '1');
    const atOpen = naturalUids(await open(scope, first), scope);
    let second = storePath(scope, 2);
    if (scope === 'global') {
      _resetDualScopeDbCache();
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${first}${suffix}`, { force: true });
      second = first;
    }
    const db2 = await open(scope, second);
    seedBrainRows(db2, { sticky: scope === 'global' });
    if (scope === 'project') seedReleaseLinks(db2);
    expect(naturalUids(db2, scope)).toEqual(atOpen);
    expect(atOpen.size).toBe(5);
    for (const [row, uid] of atOpen) expect(uid, row).not.toBeNull();
  });
});

describe('natural brain identity: references', () => {
  it('a project memory link follows its task uid, not the T#### id', async () => {
    const db = await open('project', storePath('project'));
    db.exec(
      "INSERT INTO tasks_tasks (id, title, status, priority, type, created_at) VALUES ('T1', 'x', 'pending', 'medium', 'task', '2026-09-01 08:00:00')",
    );
    seedBrainRows(db);
    const taskUid = uidOf(db, "SELECT uid FROM tasks_tasks WHERE id = 'T1'");
    expect(taskUid).not.toBeNull();
    const linkUid = uidOf(db, "SELECT uid FROM brain_memory_links WHERE task_id = 'T1'");
    expect(linkUid).toBe(
      naturalRowUid('project', 'brain_memory_links', [
        'observation',
        'O-0a1b2c3d',
        taskUid as string,
        'produced_by',
      ]),
    );
  });

  it('a global memory link keys on the raw task id (the global store has no tasks)', async () => {
    const db = await open('global', storePath('global'));
    seedBrainRows(db, { sticky: true });
    expect(uidOf(db, "SELECT uid FROM brain_memory_links WHERE task_id = 'T1'")).toBe(
      naturalRowUid('global', 'brain_memory_links', [
        'observation',
        'O-0a1b2c3d',
        'T1',
        'produced_by',
      ]),
    );
  });

  it('a global sticky tag follows its note uid', async () => {
    const db = await open('global', storePath('global'));
    seedBrainRows(db, { sticky: true });
    const noteUid = uidOf(db, "SELECT uid FROM brain_sticky_notes WHERE id = 'SN-001'");
    expect(noteUid).not.toBeNull();
    expect(uidOf(db, "SELECT uid FROM brain_sticky_tags WHERE sticky_id = 'SN-001'")).toBe(
      naturalRowUid('global', 'brain_sticky_tags', [noteUid as string, 'sync']),
    );
  });

  it('the project sticky tags stay unfilled until the T12535 twin collapse declares them', async () => {
    const db = await open('project', storePath('project'));
    db.exec(
      "INSERT INTO brain_sticky_notes (id, content, created_at) VALUES ('SN-001', 'n', '2026-09-01 09:10:00')",
    );
    db.exec("INSERT INTO brain_sticky_tags (sticky_id, tag) VALUES ('SN-001', 'sync')");
    expect(uidOf(db, "SELECT uid FROM brain_sticky_tags WHERE sticky_id = 'SN-001'")).toBeNull();
  });
});

describe('natural brain identity: heal and capture', () => {
  it('heals a project store whose release-link and edge columns are missing, then fills them', async () => {
    const path = storePath('project');
    const db = await open('project', path);
    seedBrainRows(db);
    seedReleaseLinks(db);
    for (const table of ['tasks_brain_release_links', 'brain_page_edges']) {
      db.exec(`DROP TRIGGER IF EXISTS temp."trg_row_uid_${table}"`);
      db.exec(`DROP INDEX IF EXISTS main."uq_${table}_uid"`);
      db.exec(`ALTER TABLE main."${table}" DROP COLUMN "uid"`);
    }
    expect(missingRowIdentitySchema(db, 'project')).toContain(
      'index uq_tasks_brain_release_links_uid',
    );
    const healed = await open('project', path);
    expect(missingRowIdentitySchema(healed, 'project')).toEqual([]);
    expect(
      uidOf(healed, "SELECT uid FROM tasks_brain_release_links WHERE release_id = 'v2026.10.5'"),
    ).toBe(
      naturalRowUid('project', 'tasks_brain_release_links', [
        'O-0a1b2c3d',
        'v2026.10.5',
        'observed-in',
      ]),
    );
    for (const uid of naturalUids(healed, 'project').values()) expect(uid).not.toBeNull();
  });

  it('a raw edge insert under capture captures exactly one I with the derived uid, and no K', async () => {
    const db = await open('project', storePath('project'));
    setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
    db.exec(
      "INSERT INTO brain_page_edges (from_id, to_id, edge_type, created_at) VALUES ('task:T9', 'symbol:x', 'task_touches_symbol', '2026-09-01 10:00:00')",
    );
    const uid = naturalRowUid('project', 'brain_page_edges', [
      'task:T9',
      'symbol:x',
      'task_touches_symbol',
    ]);
    expect(edgeUid(db, 'task:T9', 'symbol:x', 'task_touches_symbol')).toBe(uid);
    const caps = db
      .prepare("SELECT op, uid, img FROM _sync_capture WHERE tbl = 'brain_page_edges' ORDER BY seq")
      .all() as { op: string; uid: string | null; img: string }[];
    expect(caps.map((c) => c.op)).toEqual(['I']);
    expect(caps[0]?.uid).toBe(uid);
    expect(JSON.parse(caps[0]?.img ?? '{}')).toMatchObject({ uid: `'${uid}'` });
  });
});
