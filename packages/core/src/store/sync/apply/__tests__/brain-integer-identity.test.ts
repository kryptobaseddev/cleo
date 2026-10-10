/**
 * Row identity of the brain tables keyed by an INTEGER AUTOINCREMENT id
 * (T12896): retrieval log, plasticity events, weight history, modulators,
 * consolidation events and usage log (minted, both scopes).
 *
 * Their integer id numbers from 1 on every device, so it is a local key: it
 * never travels, a received row gets the next local id, and integer
 * references between the tables travel as uids. Two real replicas that each
 * write id 1 must both end with both rows (spec t12341 §4, AC2).
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
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../../../dual-scope-db.js';
import { missingRowIdentitySchema } from '../../../row-identity.js';
import { ROW_UID_FILL_FLAG } from '../../../row-identity-flag.js';
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
import { canonicalStoreTimestamp, timestampColumns } from '../../timestamps.js';
import { type ApplyReport, applyStagedTxns } from '../applier.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../../migrations/sync-journal');
const STREAM = 'project:t12896-brain-integer';
const RA = '0192aaaa-7f00-7000-8000-00000000000a';
const RB = '0192bbbb-7f00-7000-8000-00000000000b';
let clock = Date.now();
let dir: string;
let published: Array<{ replicaId: string; txns: LedgerTxn[] }>;

/** The minted integer-keyed brain tables, in both scopes. */
const MINTED = [
  'brain_retrieval_log',
  'brain_plasticity_events',
  'brain_weight_history',
  'brain_modulators',
  'brain_consolidation_events',
  'brain_usage_log',
] as const;

interface Replica {
  readonly db: DatabaseSync;
  readonly id: string;
  cursor: number;
}

beforeEach(() => {
  published = [];
  dir = mkdtempSync(join(tmpdir(), 'cleo-brain-integer-'));
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

/**
 * One row in every minted integer-keyed table, the plasticity event and weight
 * change pointing at the retrieval. Each tag writes at its own hour: a raw
 * insert gets the deterministic uid over (table, id, birth[, content]), so two
 * devices writing the same id in the same second share a retrieval-log uid
 * (spec D6 collision, detected by `birth_fp`), which is not the local-id case
 * this file covers.
 */
const seedMinted = (tag: string) => {
  const hh = tag === 'b' ? '10' : '09';
  return `
  INSERT INTO brain_retrieval_log (query, entry_ids, entry_count, source, session_id, created_at)
    VALUES ('q ${tag}', '["O-1"]', 1, 'find', 'ses-${tag}', '2026-09-01 ${hh}:00:00');
  INSERT INTO brain_plasticity_events (source_node, target_node, delta_w, kind, timestamp, retrieval_log_id)
    VALUES ('n:${tag}', 'n:x', 0.1, 'ltp', '2026-09-01 ${hh}:00:01',
      (SELECT max(id) FROM brain_retrieval_log));
  INSERT INTO brain_weight_history (edge_from_id, edge_to_id, edge_type, weight_after, delta_weight,
      event_kind, source_plasticity_event_id, retrieval_log_id, changed_at)
    VALUES ('n:${tag}', 'n:x', 'co_retrieved', 0.6, 0.1, 'ltp',
      (SELECT max(id) FROM brain_plasticity_events), (SELECT max(id) FROM brain_retrieval_log),
      '2026-09-01 ${hh}:00:02');
  INSERT INTO brain_modulators (modulator_type, valence, session_id, created_at)
    VALUES ('reward', 0.5, 'ses-${tag}', '2026-09-01 ${hh}:00:03');
  INSERT INTO brain_consolidation_events (trigger, step_results_json, started_at)
    VALUES ('session_end', '{"tag":"${tag}"}', '2026-09-01 ${hh}:00:04');
  INSERT INTO brain_usage_log (entry_id, used, outcome, created_at)
    VALUES ('O-${tag}', 1, 'positive', '2026-09-01 ${hh}:00:05');
`;
};

const count = (db: DatabaseSync, table: string): number =>
  (db.prepare(`SELECT count(*) AS n FROM main."${table}"`).get() as { n: number }).n;

/** Each table's rows by uid, without the local id; references as the referenced row's uid. */
function rowsByUid(db: DatabaseSync): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const t of MINTED) {
    const cols = (db.prepare(`PRAGMA main.table_info("${t}")`).all() as Array<{ name: string }>)
      .map((c) => c.name)
      .filter((c) => c !== 'id' && c !== 'retrieval_log_id' && c !== 'source_plasticity_event_id');
    // Timestamps compare by canonical value (journal spec §1.8): the origin
    // keeps its local text, the receiver writes the canonical form.
    const stamps = timestampColumns('project', t);
    out[t] = (
      db
        .prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM main."${t}" ORDER BY uid`)
        .all() as Array<Record<string, unknown>>
    ).map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([c, v]) => [
          c,
          stamps.has(c) && typeof v === 'string' ? (canonicalStoreTimestamp(v) ?? v) : v,
        ]),
      ),
    );
  }
  out.plasticityRefs = db
    .prepare(
      `SELECT p.uid, r.uid AS retrieval FROM brain_plasticity_events p
       LEFT JOIN brain_retrieval_log r ON r.id = p.retrieval_log_id ORDER BY p.uid`,
    )
    .all();
  out.weightRefs = db
    .prepare(
      `SELECT w.uid, p.uid AS plasticity, r.uid AS retrieval FROM brain_weight_history w
       LEFT JOIN brain_plasticity_events p ON p.id = w.source_plasticity_event_id
       LEFT JOIN brain_retrieval_log r ON r.id = w.retrieval_log_id ORDER BY w.uid`,
    )
    .all();
  return out;
}

describe('the INTEGER id is a local key', () => {
  it('never captured, sealed or hashed: the capture definition keeps it off the wire', async () => {
    const r = await replica(RA);
    // AC history (T12341) is integer-keyed too: its id stops travelling here.
    for (const t of [...MINTED, 'tasks_task_acceptance_criteria_history']) {
      const def = captureTableDef(r.db, 'project', t);
      expect(def, t).toBeDefined();
      expect(def?.localRowid, t).toBe('id');
      expect(def?.columns, t).not.toContain('id');
    }
    // A TEXT key that travels (a display id) is not a local rowid.
    expect(captureTableDef(r.db, 'project', 'tasks_tasks')?.localRowid).toBeUndefined();
    const txn = write(r, seedMinted('a'));
    const ops = txnOf(r, txn).ops;
    expect(ops.map((o) => o.t).sort()).toEqual([...MINTED].sort());
    for (const op of ops) expect(op.a ?? {}, op.t).not.toHaveProperty('id');
    expect(ops.find((o) => o.t === 'brain_plasticity_events')?.a?.retrieval_log_id).toBe(
      ops.find((o) => o.t === 'brain_retrieval_log')?.u,
    );
  });

  it('a raw insert under capture captures exactly one I per row, with its uid, and no K', async () => {
    const r = await replica(RA);
    r.db.exec(seedMinted('a'));
    const caps = r.db
      .prepare(`SELECT tbl, op, uid FROM _sync_capture WHERE tbl LIKE 'brain_%' ORDER BY seq`)
      .all() as Array<{ tbl: string; op: string; uid: string | null }>;
    expect(caps.map((c) => c.op)).toEqual(MINTED.map(() => 'I'));
    for (const c of caps) {
      const live = r.db.prepare(`SELECT uid FROM main."${c.tbl}"`).get() as { uid: string };
      expect(c.uid, c.tbl).toBe(live.uid);
    }
  });

  it('the retrieval log is not append-only (its reward is labelled later); the event logs are', async () => {
    const r = await replica(RA);
    expect(captureTableDef(r.db, 'project', 'brain_retrieval_log')?.appendOnly).toBe(false);
    for (const t of MINTED.filter((m) => m !== 'brain_retrieval_log')) {
      expect(captureTableDef(r.db, 'project', t)?.appendOnly, t).toBe(true);
    }
  });
});

describe('two replicas that both number from 1', () => {
  it('each ends with both rows of every table, under its own local ids, refs intact', async () => {
    const a = await replica(RA);
    const b = await replica(RB);
    const la = write(a, seedMinted('a'));
    const lb = write(b, seedMinted('b'));
    for (const t of MINTED) {
      expect(a.db.prepare(`SELECT id FROM main."${t}"`).all(), t).toEqual([{ id: 1 }]);
      expect(b.db.prepare(`SELECT id FROM main."${t}"`).all(), t).toEqual([{ id: 1 }]);
    }
    publish(a, txnOf(a, la));
    publish(b, txnOf(b, lb));
    for (const r of [a, b]) {
      expect(sync(r)).toMatchObject({ void: 0, pending: 0, refusedSchema: 0 });
      expect(listConflicts(r.db)).toEqual([]);
      for (const t of MINTED) {
        expect(count(r.db, t), t).toBe(2);
        expect(
          (r.db.prepare(`SELECT count(DISTINCT id) AS n FROM main."${t}"`).get() as { n: number })
            .n,
          t,
        ).toBe(2);
      }
    }
    // Same rows by uid on both sides; every integer reference resolves to the
    // receiver's own local id of the same uid.
    const left = rowsByUid(a.db);
    expect(rowsByUid(b.db)).toEqual(left);
    for (const ref of left.plasticityRefs as Array<{ retrieval: string | null }>) {
      expect(ref.retrieval).not.toBeNull();
    }
    for (const ref of left.weightRefs as Array<{
      plasticity: string | null;
      retrieval: string | null;
    }>) {
      expect(ref.plasticity).not.toBeNull();
      expect(ref.retrieval).not.toBeNull();
    }
  });

  it("an older build's op that still carries the sender's id is applied under a local id", async () => {
    const a = await replica(RA);
    const b = await replica(RB);
    write(
      b,
      `INSERT INTO brain_modulators (modulator_type, valence, created_at)
      VALUES ('local', 0.1, '2026-09-01 08:00:00')`,
    );
    const la = write(
      a,
      `INSERT INTO brain_modulators (modulator_type, valence, created_at)
       VALUES ('remote', 0.9, '2026-09-01 09:00:00')`,
    );
    const txn = txnOf(a, la);
    const legacy: LedgerTxn = {
      ...txn,
      ops: txn.ops.map((o) => ({ ...o, a: { ...(o.a ?? {}), id: 1 } })),
    };
    publish(a, legacy);
    expect(sync(b)).toMatchObject({ void: 0, pending: 0, refusedSchema: 0 });
    expect(
      b.db.prepare('SELECT id, modulator_type FROM brain_modulators ORDER BY id').all(),
    ).toEqual([
      { id: 1, modulator_type: 'local' },
      { id: 2, modulator_type: 'remote' },
    ]);
  });
});

describe.each([
  'project',
  'global',
] as const)('integer-keyed brain identity in the %s store', (scope) => {
  /** Every minted row's uid, keyed by table and local id. */
  const uids = (db: DatabaseSync) => {
    const out = new Map<string, string | null>();
    for (const t of MINTED) {
      for (const r of db.prepare(`SELECT id, uid FROM main."${t}" ORDER BY id`).all() as Array<{
        id: number;
        uid: string | null;
      }>)
        out.set(`${t}:${r.id}`, r.uid);
    }
    return out;
  };

  it('two stores derive the same uids, one filled at open and one at insert', async () => {
    vi.stubEnv(ROW_UID_FILL_FLAG, '0');
    const first = storePath(scope, 'one');
    const raw = await open(scope, first);
    raw.exec(seedMinted('x'));
    expect([...uids(raw).values()].every((u) => u === null)).toBe(true);
    vi.stubEnv(ROW_UID_FILL_FLAG, '1');
    const atOpen = uids(await open(scope, first));
    let second = storePath(scope, 'two');
    if (scope === 'global') {
      _resetDualScopeDbCache();
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${first}${suffix}`, { force: true });
      second = first;
    }
    const db2 = await open(scope, second);
    db2.exec(seedMinted('x'));
    expect(uids(db2)).toEqual(atOpen);
    expect(atOpen.size).toBe(MINTED.length);
    for (const [row, uid] of atOpen) expect(uid, row).not.toBeNull();
  });

  it('heals a store whose uid columns are missing, then fills them', async () => {
    const path = storePath(scope, 'heal');
    const db = await open(scope, path);
    db.exec(seedMinted('h'));
    for (const t of MINTED) {
      db.exec(`DROP TRIGGER IF EXISTS temp."trg_row_uid_${t}"`);
      db.exec(`DROP INDEX IF EXISTS main."uq_${t}_uid"`);
      db.exec(`DROP INDEX IF EXISTS main."idx_${t}_birth_fp"`);
      db.exec(`ALTER TABLE main."${t}" DROP COLUMN "uid"`);
      db.exec(`ALTER TABLE main."${t}" DROP COLUMN "birth_fp"`);
    }
    expect(missingRowIdentitySchema(db, scope)).toContain('index uq_brain_usage_log_uid');
    const healed = await open(scope, path);
    expect(missingRowIdentitySchema(healed, scope)).toEqual([]);
    for (const [row, uid] of uids(healed)) expect(uid, row).not.toBeNull();
  });
});
