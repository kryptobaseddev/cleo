/**
 * The last two brain exemptions of T12896 (team-lead decision 2026-10-10):
 *
 * - `brain_memory_trees` is DERIVED: the surprisal pass truncates and rebuilds
 *   it every cycle, so each device recomputes it from the synced observations.
 *   It is never captured and never replicated.
 * - `brain_task_observations` joins the consolidated project schema and is
 *   declared natural on (observation id, task uid), with its INTEGER id local.
 *
 * @task T12896
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import { LedgerActor, LedgerOp, type LedgerTxn } from '@cleocode/contracts/ledger';
import { SYNC_SCHEMA_VERSION } from '@cleocode/contracts/sync-schema.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSurprisalTree } from '../../../../memory/surprisal-tree.js';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../../../dual-scope-db.js';
import { missingRowIdentitySchema } from '../../../row-identity.js';
import { classifyTable } from '../../../table-classification.js';
import {
  captureTableDef,
  finishCaptureFrame,
  openCaptureFrame,
  setCaptureEnabled,
} from '../../capture.js';
import { listConflicts } from '../../conflicts.js';
import { setSyncFlag } from '../../flags.js';
import { stageTxns } from '../../inbox.js';
import { sealPending } from '../../sealer.js';
import { type ApplyReport, applyStagedTxns } from '../applier.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../../migrations/sync-journal');
const STREAM = 'project:t12896-brain-remaining';
const RA = '0192aaaa-7f00-7000-8000-00000000000a';
const RB = '0192bbbb-7f00-7000-8000-00000000000b';
let clock = Date.now();
let dir: string;
let published: Array<{ replicaId: string; txns: LedgerTxn[] }>;

interface Replica {
  readonly db: DatabaseSync;
  readonly id: string;
  cursor: number;
}

beforeEach(() => {
  published = [];
  dir = mkdtempSync(join(tmpdir(), 'cleo-brain-remaining-'));
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
  vi.stubEnv('XDG_STATE_HOME', join(dir, 'state'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function storePath(scope: TableScope, name: string): string {
  if (scope === 'global') return join(dir, 'cleo', 'cleo.db');
  mkdirSync(join(dir, name, '.cleo'), { recursive: true });
  return join(dir, name, '.cleo', 'cleo.db');
}

async function open(scope: TableScope, path: string): Promise<DatabaseSync> {
  _resetDualScopeDbCache();
  return getDualScopeNativeDb(await openDualScopeDbAtPath(scope, path));
}

async function replica(id: string): Promise<Replica> {
  const db = getDualScopeNativeDb(
    await openDualScopeDbAtPath('project', storePath('project', id.slice(4, 8))),
  );
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  setSyncFlag(db, 'sync.seal', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  return { db, id, cursor: 0 };
}

function seal(r: Replica): void {
  const out = sealPending(r.db, {
    scope: 'project',
    replica: r.id,
    now: () => ++clock,
    env: {},
    allowUnreleased: true,
  });
  expect(out.refused ?? null, 'sealing was refused').toBeNull();
}

/** One local write through a capture frame, sealed; returns its txn id. */
function write(r: Replica, sql: string): string {
  r.db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(r.db, 'write', null);
  r.db.exec(sql);
  finishCaptureFrame(r.db, frame);
  r.db.exec('COMMIT');
  seal(r);
  return (
    r.db.prepare('SELECT txn FROM _sync_txn ORDER BY local_seq DESC LIMIT 1').get() as {
      txn: string;
    }
  ).txn;
}

/** A sealed transaction as the stream carries it. */
function txnOf(r: Replica, id: string): LedgerTxn {
  const t = r.db
    .prepare('SELECT txn, hlc, via, kind, actor FROM _sync_txn WHERE txn = ?')
    .get(id) as {
    txn: string;
    hlc: string;
    via: LedgerTxn['via'];
    kind: LedgerTxn['kind'];
    actor: string | null;
  };
  return {
    v: 1,
    txn: t.txn,
    hlc: t.hlc,
    project: null,
    scope: 'project',
    via: t.via,
    kind: t.kind,
    actor: t.actor?.startsWith('{') ? LedgerActor.parse(JSON.parse(t.actor)) : null,
    ops: (
      r.db.prepare('SELECT body FROM _sync_op WHERE txn = ? ORDER BY idx').all(t.txn) as Array<{
        body: string;
      }>
    ).map((o) => LedgerOp.parse(JSON.parse(o.body))),
    sig: '',
  };
}

function publish(r: Replica, ...txns: LedgerTxn[]): void {
  published.push({ replicaId: r.id, txns });
}

function sync(r: Replica): ApplyReport {
  for (; r.cursor < published.length; r.cursor++) {
    const s = published[r.cursor] as { replicaId: string; txns: LedgerTxn[] };
    stageTxns(
      r.db,
      STREAM,
      {
        seq: r.cursor + 1,
        replicaId: s.replicaId,
        replicaSeq: r.cursor + 1,
        deviceId: `dev-${s.replicaId.slice(4, 8)}`,
        schemaVersion: SYNC_SCHEMA_VERSION,
        txns: s.txns,
      },
      new Date().toISOString(),
    );
  }
  return applyStagedTxns(r.db, {
    scope: 'project',
    stream: STREAM,
    replica: r.id,
    now: () => Date.now(),
    seal: () => seal(r),
  });
}

const count = (db: DatabaseSync, table: string): number =>
  (db.prepare(`SELECT count(*) AS n FROM main."${table}"`).get() as { n: number }).n;

const OBSERVATIONS = `
  INSERT INTO brain_observations (id, type, title, created_at, valid_at) VALUES
    ('O-aaaa0001', 'discovery', 'first', '2026-09-01 09:00:00', '2026-09-01 09:00:00'),
    ('O-aaaa0002', 'discovery', 'second', '2026-09-01 09:00:01', '2026-09-01 09:00:01'),
    ('O-aaaa0003', 'change', 'third', '2026-09-01 09:00:02', '2026-09-01 09:00:02');
`;

const TREE_ROW = `
  INSERT INTO brain_memory_trees (depth, leaf_ids, centroid, parent_id, created_at)
    VALUES (0, '["O-aaaa0001"]', NULL, NULL, '2026-09-01 09:00:03');
`;

/** Embeddings for the surprisal pass (two clusters of near-identical vectors). */
const EMBEDDED = [
  { id: 'O-aaaa0001', embedding: [1, 0, 0, 0] },
  { id: 'O-aaaa0002', embedding: [0.9, 0.1, 0, 0] },
  { id: 'O-aaaa0003', embedding: [0, 0, 1, 0] },
];

describe('brain_memory_trees is derived', () => {
  it.each([
    'project',
    'global',
  ] as const)('is classified derived in %s scope and has no capture definition', async (scope) => {
    const db = await open(scope, storePath(scope, 'cls'));
    const cls = classifyTable(scope, 'brain_memory_trees');
    expect(cls.kind === 'entry' ? cls.entry.class : cls.kind).toBe('derived');
    expect(captureTableDef(db, scope, 'brain_memory_trees')).toBeUndefined();
  });

  it('a write to it under capture captures nothing', async () => {
    const r = await replica(RA);
    r.db.exec(TREE_ROW);
    expect(count(r.db, 'brain_memory_trees')).toBe(1);
    expect(
      r.db
        .prepare(`SELECT count(*) AS n FROM _sync_capture WHERE tbl = 'brain_memory_trees'`)
        .get(),
    ).toEqual({ n: 0 });
  });

  it('never reaches another replica, which rebuilds its own tree from the synced observations', async () => {
    const a = await replica(RA);
    const b = await replica(RB);
    const t = write(a, OBSERVATIONS + TREE_ROW);
    const ops = txnOf(a, t).ops;
    expect(ops.some((o) => o.t === 'brain_memory_trees')).toBe(false);
    publish(a, txnOf(a, t));
    expect(sync(b)).toMatchObject({ void: 0, pending: 0, refusedSchema: 0 });
    expect(count(b.db, 'brain_observations')).toBe(3);
    expect(count(b.db, 'brain_memory_trees')).toBe(0);

    const built = buildSurprisalTree(EMBEDDED, { db: b.db, minLeafSize: 1, maxDepth: 2 });
    expect(built.nodesWritten).toBeGreaterThan(0);
    expect(count(b.db, 'brain_memory_trees')).toBe(built.nodesWritten);
    expect(
      (
        b.db
          .prepare(`SELECT count(*) AS n FROM brain_observations WHERE tree_id IS NOT NULL`)
          .get() as { n: number }
      ).n,
    ).toBe(3);
    expect(
      b.db
        .prepare(`SELECT count(*) AS n FROM _sync_capture WHERE tbl = 'brain_memory_trees'`)
        .get(),
    ).toEqual({ n: 0 });
  });
});

const TASK = (id: string) =>
  `INSERT INTO tasks_tasks (id, title, type, status, priority, created_at)
     VALUES ('${id}', 'task ${id}', 'task', 'pending', 'medium', '2026-09-01T08:00:00.000Z');`;

const LINK = (obs: string, task: string) =>
  `INSERT INTO brain_task_observations (observation_id, task_id, link_type, created_at)
     VALUES ('${obs}', '${task}', 'session-completed', '2026-09-01 09:30:00');`;

function links(db: DatabaseSync): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT l.uid, l.observation_id, l.task_id, l.link_type, t.uid AS task_uid
       FROM brain_task_observations l LEFT JOIN tasks_tasks t ON t.id = l.task_id ORDER BY l.uid`,
    )
    .all() as Array<Record<string, unknown>>;
}

describe('brain_task_observations', () => {
  it('a fresh project store has it, with its identity schema, before any brain reconcile', async () => {
    const db = await open('project', storePath('project', 'fresh'));
    const cols = (
      db.prepare(`PRAGMA main.table_info("brain_task_observations")`).all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toEqual(['id', 'observation_id', 'task_id', 'link_type', 'created_at', 'uid']);
    expect(missingRowIdentitySchema(db, 'project')).toEqual([]);
    db.exec(TASK('T1') + LINK('O-aaaa0001', 'T1'));
    const row = db.prepare('SELECT uid FROM brain_task_observations').get() as { uid: string };
    expect(row.uid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('captures one I without the local id, keyed by its natural uid', async () => {
    const r = await replica(RA);
    r.db.exec(TASK('T1') + LINK('O-aaaa0001', 'T1'));
    expect(captureTableDef(r.db, 'project', 'brain_task_observations')?.localRowid).toBe('id');
    const caps = r.db
      .prepare(`SELECT op, uid FROM _sync_capture WHERE tbl = 'brain_task_observations'`)
      .all() as Array<{ op: string; uid: string }>;
    const live = r.db.prepare('SELECT uid FROM brain_task_observations').get() as { uid: string };
    expect(caps).toEqual([{ op: 'I', uid: live.uid }]);
  });

  it('two replicas converge: the same links under the same uids, task refs by uid', async () => {
    const a = await replica(RA);
    const b = await replica(RB);
    const t1 = write(a, TASK('T1') + LINK('O-aaaa0001', 'T1'));
    publish(a, txnOf(a, t1));
    expect(sync(b)).toMatchObject({ void: 0, pending: 0, refusedSchema: 0 });
    const t2 = write(b, LINK('O-aaaa0002', 'T1'));
    publish(b, txnOf(b, t2));
    for (const r of [a, b]) {
      expect(sync(r)).toMatchObject({ void: 0, pending: 0, refusedSchema: 0 });
      expect(listConflicts(r.db)).toEqual([]);
      expect(count(r.db, 'brain_task_observations')).toBe(2);
    }
    const left = links(a.db);
    expect(links(b.db)).toEqual(left);
    for (const l of left) expect(l.task_uid).not.toBeNull();
  });

  it('the same link written on both devices is one row, not two', async () => {
    const a = await replica(RA);
    const b = await replica(RB);
    const t1 = write(a, TASK('T1'));
    publish(a, txnOf(a, t1));
    sync(b);
    const la = write(a, LINK('O-aaaa0001', 'T1'));
    const lb = write(b, LINK('O-aaaa0001', 'T1'));
    expect(links(a.db)[0]?.uid).toBe(links(b.db)[0]?.uid);
    publish(a, txnOf(a, la));
    publish(b, txnOf(b, lb));
    for (const r of [a, b]) {
      expect(sync(r)).toMatchObject({ void: 0, refusedSchema: 0 });
      expect(count(r.db, 'brain_task_observations')).toBe(1);
    }
  });

  it('heals a store whose uid column and index are missing, then fills them', async () => {
    const path = storePath('project', 'heal');
    const db = await open('project', path);
    db.exec(TASK('T1') + LINK('O-aaaa0001', 'T1'));
    db.exec(`DROP TRIGGER IF EXISTS temp."trg_row_uid_brain_task_observations"`);
    db.exec(`DROP INDEX IF EXISTS main."uq_brain_task_observations_uid"`);
    db.exec(`ALTER TABLE main."brain_task_observations" DROP COLUMN "uid"`);
    expect(missingRowIdentitySchema(db, 'project')).toContain(
      'index uq_brain_task_observations_uid',
    );
    const healed = await open('project', path);
    expect(missingRowIdentitySchema(healed, 'project')).toEqual([]);
    const row = healed.prepare('SELECT uid FROM brain_task_observations').get() as {
      uid: string | null;
    };
    expect(row.uid).not.toBeNull();
  });
});
