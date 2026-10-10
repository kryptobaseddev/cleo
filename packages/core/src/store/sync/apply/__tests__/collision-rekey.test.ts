/**
 * A held uid collision settles (T13397; T12341 §6.4, §9.2 origin rule).
 *
 * Two replicas write rows that mint one uid with different birth
 * fingerprints. Apply holds the other row everywhere (T13394). The loser's
 * origin re-keys its own row in a `rekey` frame and publishes the K; the
 * winner then places under the freed uid. A receiver holding the loser
 * records the K as an alias, the held insert follows it to the new uid, and
 * the origin's earlier references to the loser follow it too. Both replicas
 * end with both rows under distinct uids, and the collision is resolved.
 *
 * @task T13397
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
import { mintRowUid } from '../../../row-identity.js';
import { setRowUidNative } from '../../../sqlite-data-accessor.js';
import { finishCaptureFrame, openCaptureFrame, setCaptureEnabled } from '../../capture.js';
import { announcePlacedRekeys } from '../../collision-settle.js';
import { listConflicts } from '../../conflicts.js';
import { setSyncFlag } from '../../flags.js';
import { stageTxns } from '../../inbox.js';
import { sealPending } from '../../sealer.js';
import { TRIGGER_SUSPEND_TABLE_DDL } from '../../trigger-classes.js';
import { markAliasPlaced, recordUidAlias } from '../../uid-alias.js';
import { type ApplyReport, applyStagedTxns } from '../applier.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../../migrations/sync-journal');
const RA = '0192aaaa-7f00-7000-8000-00000000000a';
const RB = '0192bbbb-7f00-7000-8000-00000000000b';
const RC = '0192cccc-7f00-7000-8000-00000000000c';
let clock = Date.now();
let dir: string;
let published: Array<{ replicaId: string; txns: LedgerTxn[] }>;
/** Transactions each replica has pushed. */
const sent = new Map<string, Set<string>>();

interface Replica {
  readonly db: DatabaseSync;
  readonly id: string;
  readonly scope: TableScope;
  cursor: number;
}

beforeEach(() => {
  published = [];
  sent.clear();
  dir = mkdtempSync(join(tmpdir(), 'cleo-collision-rekey-'));
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

const streamOf = (scope: TableScope): string =>
  scope === 'global' ? 'home:t13397-user' : 'project:t13397-collision-rekey';

async function replica(id: string, scope: TableScope = 'project'): Promise<Replica> {
  const name = id.slice(4, 8);
  const path =
    scope === 'global' ? join(dir, `home-${name}`, 'cleo.db') : join(dir, name, '.cleo', 'cleo.db');
  mkdirSync(join(path, '..'), { recursive: true });
  const db = getDualScopeNativeDb(await openDualScopeDbAtPath(scope, path));
  // The global store gets no cleo_trigger_suspend from its migrations (only the
  // project folder creates it), while its capture triggers read it.
  if (scope === 'global') db.exec(TRIGGER_SUSPEND_TABLE_DDL);
  setCaptureEnabled(db, scope, true, { schemaRoot: SYNC_SCHEMA });
  setSyncFlag(db, 'sync.seal', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  return { db, id, scope, cursor: 0 };
}

function seal(r: Replica): void {
  const out = sealPending(r.db, {
    scope: r.scope,
    replica: r.id,
    now: () => ++clock,
    env: {},
    allowUnreleased: true,
  });
  expect(out.refused ?? null, 'sealing was refused').toBeNull();
}

/** One local write through a capture frame, sealed. */
function write(r: Replica, sql: string): void {
  r.db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(r.db, 'write', null);
  r.db.exec(sql);
  finishCaptureFrame(r.db, frame);
  r.db.exec('COMMIT');
  seal(r);
}

/** Every sealed transaction of `r` not published yet, as the stream carries them. */
function unpublished(r: Replica): LedgerTxn[] {
  const done = sent.get(r.id) ?? new Set<string>();
  sent.set(r.id, done);
  const txns = r.db
    .prepare(
      'SELECT txn, hlc, via, kind, actor FROM _sync_txn WHERE replica = ? ORDER BY local_seq',
    )
    .all(r.id) as Array<{
    txn: string;
    hlc: string;
    via: LedgerTxn['via'];
    kind: LedgerTxn['kind'];
    actor: string | null;
  }>;
  return txns
    .filter((t) => !done.has(t.txn))
    .map((t) => {
      done.add(t.txn);
      return {
        v: 1,
        txn: t.txn,
        hlc: t.hlc,
        project: null,
        scope: r.scope,
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
    });
}

/** Push: every unpublished sealed transaction of `r`, as one segment. */
function push(r: Replica): LedgerTxn[] {
  const txns = unpublished(r);
  if (txns.length > 0) published.push({ replicaId: r.id, txns });
  return txns;
}

/** Pull: stage what `r` has not seen and apply it. */
function pull(r: Replica): ApplyReport {
  const stream = streamOf(r.scope);
  for (; r.cursor < published.length; r.cursor++) {
    const s = published[r.cursor] as { replicaId: string; txns: LedgerTxn[] };
    stageTxns(
      r.db,
      stream,
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
    scope: r.scope,
    stream,
    replica: r.id,
    now: () => Date.now(),
    seal: () => seal(r),
  });
}

const rows = (db: DatabaseSync, sql: string): Array<Record<string, unknown>> =>
  db.prepare(sql).all() as Array<Record<string, unknown>>;

const fpOf = (r: Replica, table: string): string =>
  (r.db.prepare(`SELECT birth_fp AS fp FROM main."${table}"`).get() as { fp: string }).fp;

const statuses = (db: DatabaseSync): string[] =>
  (
    db.prepare('SELECT status FROM _sync_inbox ORDER BY seq, txn_idx').all() as Array<{
      status: string;
    }>
  ).map((s) => s.status);

/** Same id, same birth second, different query: one uid, two fingerprints. */
const retrieval = (query: string) =>
  `INSERT INTO brain_retrieval_log (query, entry_ids, entry_count, source, session_id, created_at)
     VALUES ('${query}', '["O-1"]', 1, 'find', 'ses-1', '2026-09-01 09:00:00')`;

/** A plasticity event referencing this replica's newest retrieval-log row. */
const plasticity = (node: string) =>
  `INSERT INTO brain_plasticity_events (source_node, target_node, delta_w, kind, timestamp, retrieval_log_id)
     VALUES ('${node}', 'n:x', 0.1, 'ltp', '2026-09-01 09:00:01', (SELECT max(id) FROM brain_retrieval_log))`;

/** Same id and created_at, different title: one uid, two fingerprints (and one display id). */
const task = (title: string) =>
  `INSERT INTO tasks_tasks (id, title, type, status, priority, created_at)
     VALUES ('T1', '${title}', 'task', 'pending', 'medium', '2026-09-01T09:00:00.000Z')`;

/** Both replicas write `table` rows on one uid; returns them as winner and loser. */
async function collide(
  scope: TableScope,
  table: string,
  sqlA: string,
  sqlB: string,
): Promise<{ winner: Replica; loser: Replica; uid: string }> {
  const a = await replica(RA, scope);
  const b = await replica(RB, scope);
  write(a, sqlA);
  write(b, sqlB);
  const ua = (a.db.prepare(`SELECT uid FROM main."${table}"`).get() as { uid: string }).uid;
  const ub = (b.db.prepare(`SELECT uid FROM main."${table}"`).get() as { uid: string }).uid;
  expect(ua, 'the recipe gives both rows one uid').toBe(ub);
  const [winner, loser] = fpOf(a, table) < fpOf(b, table) ? [a, b] : [b, a];
  return { winner, loser, uid: ua };
}

const retrievalRows = (r: Replica) =>
  rows(r.db, 'SELECT uid, birth_fp, query FROM brain_retrieval_log ORDER BY uid');

describe('the loser of a uid collision is re-keyed by its origin, and everyone follows', () => {
  it('brain_retrieval_log: both replicas end with both rows under distinct uids', async () => {
    const { winner, loser, uid } = await collide(
      'project',
      'brain_retrieval_log',
      retrieval('query a'),
      retrieval('query b'),
    );
    const winnerQuery = retrievalRows(winner)[0]?.query;
    const loserQuery = retrievalRows(loser)[0]?.query;
    push(winner);
    push(loser);

    // The loser's origin sees the winner, re-keys its own row, places the winner.
    const lr = pull(loser);
    expect(lr).toMatchObject({ pending: 0, void: 0 });
    const onLoser = retrievalRows(loser);
    expect(onLoser).toHaveLength(2);
    expect(onLoser.find((r) => r.uid === uid)?.query).toBe(winnerQuery);
    const moved = onLoser.find((r) => r.uid !== uid);
    expect(moved?.query).toBe(loserQuery);
    // The re-key is journaled as a K and published with the next push.
    const k = push(loser).flatMap((t) => t.ops.filter((o) => o.o === 'K'));
    expect(k).toEqual([
      expect.objectContaining({ t: 'brain_retrieval_log', u: uid, nu: moved?.uid }),
    ]);
    expect(listConflicts(loser.db, { open: true })).toEqual([]);
    expect(listConflicts(loser.db)).toHaveLength(1);

    // The winner's replica held the loser; the K is an alias it follows.
    const wr = pull(winner);
    expect(wr).toMatchObject({ pending: 0, void: 0 });
    expect(retrievalRows(winner)).toEqual(onLoser);
    expect(listConflicts(winner.db, { open: true })).toEqual([]);
    expect(listConflicts(winner.db).map((c) => c.kind)).toEqual(['uid-collision']);
    expect(statuses(winner.db).every((s) => s === 'applied' || s === 'conflict')).toBe(true);

    // The loser's own K echo changes nothing, and a third replica converges.
    expect(pull(loser)).toMatchObject({ pending: 0, void: 0 });
    expect(retrievalRows(loser)).toEqual(onLoser);
    const c = await replica(RC);
    expect(pull(c)).toMatchObject({ pending: 0, void: 0 });
    expect(retrievalRows(c)).toEqual(onLoser);
  });

  it('a reference the origin wrote to its loser follows the re-key, never binding to the winner', async () => {
    const { winner, loser, uid } = await collide(
      'project',
      'brain_retrieval_log',
      retrieval('query a'),
      retrieval('query b'),
    );
    const loserQuery = retrievalRows(loser)[0]?.query;
    // Written before the collision is known: it references the loser's uid.
    write(loser, plasticity('n:child'));
    push(winner);
    push(loser);

    // Before the K: the reference names a uid in an open collision and waits.
    const early = pull(winner);
    expect(early.void).toBe(0);
    expect(rows(winner.db, 'SELECT uid FROM brain_plasticity_events')).toEqual([]);

    pull(loser);
    // After its K the origin holds the winner under the old uid: a reference it
    // writes now means the winner.
    write(
      loser,
      `INSERT INTO brain_plasticity_events (source_node, target_node, delta_w, kind, timestamp, retrieval_log_id)
         VALUES ('n:later', 'n:x', 0.2, 'ltp', '2026-09-01 09:00:02',
           (SELECT id FROM brain_retrieval_log WHERE uid = '${uid}'))`,
    );
    push(loser);
    expect(pull(winner)).toMatchObject({ pending: 0, void: 0 });
    const winnerQuery = retrievalRows(winner).find((r) => r.uid === uid)?.query;
    const child = (db: DatabaseSync) =>
      rows(
        db,
        `SELECT p.source_node, r.query, r.uid FROM brain_plasticity_events p
           JOIN brain_retrieval_log r ON r.id = p.retrieval_log_id ORDER BY p.source_node`,
      );
    expect(child(winner.db)).toEqual([
      expect.objectContaining({ source_node: 'n:child', query: loserQuery }),
      expect.objectContaining({ source_node: 'n:later', query: winnerQuery, uid }),
    ]);
    expect(child(winner.db)).toEqual(child(loser.db));
  });

  it('a third replica that placed the loser first announces the re-key, so its references follow the loser', async () => {
    const { winner, loser, uid } = await collide(
      'project',
      'brain_retrieval_log',
      retrieval('query a'),
      retrieval('query b'),
    );
    const loserQuery = retrievalRows(loser)[0]?.query;
    // The loser's insert reaches C before the winner's: C places the loser and
    // writes a row referencing its uid (T13399).
    push(loser);
    const c = await replica(RC);
    expect(pull(c)).toMatchObject({ pending: 0, void: 0 });
    write(c, plasticity('n:third'));
    push(c);
    push(winner);
    // The origin settles and publishes its K.
    expect(pull(loser)).toMatchObject({ pending: 0, void: 0 });
    push(loser);
    // C moves its placed loser, places the winner, and announces the re-key
    // under its own name: an alias-only K that moves nothing here.
    expect(pull(c)).toMatchObject({ pending: 0, void: 0 });
    const movedUid = retrievalRows(c).find((r) => r.uid !== uid)?.uid;
    const announced = push(c);
    expect(announced.map((t) => t.kind)).toEqual(['rekey']);
    expect(announced.flatMap((t) => t.ops)).toEqual([
      expect.objectContaining({ o: 'K', t: 'brain_retrieval_log', u: uid, nu: movedUid }),
    ]);
    expect(retrievalRows(c).find((r) => r.uid === movedUid)?.query).toBe(loserQuery);
    // Sealing the announcement left each row's meta with its own row.
    expect(
      rows(
        c.db,
        `SELECT m.uid, r.birth_fp = m.bfp AS same FROM _sync_row_meta m
           JOIN brain_retrieval_log r ON r.uid = m.uid WHERE m.tbl = 'brain_retrieval_log' ORDER BY m.uid`,
      ),
    ).toEqual([uid, movedUid].sort().map((u) => ({ uid: u, same: 1 })));

    for (const r of [winner, loser, c]) {
      expect(pull(r)).toMatchObject({ pending: 0, void: 0 });
    }
    const child = (db: DatabaseSync) =>
      rows(
        db,
        `SELECT p.source_node, r.query, r.uid FROM brain_plasticity_events p
           JOIN brain_retrieval_log r ON r.id = p.retrieval_log_id`,
      );
    for (const r of [winner, loser, c]) {
      expect(child(r.db)).toEqual([{ source_node: 'n:third', query: loserQuery, uid: movedUid }]);
      expect(retrievalRows(r)).toEqual(retrievalRows(winner));
      expect(listConflicts(r.db, { open: true })).toEqual([]);
    }
  });

  it('a replica that placed a row re-keyed without a collision announces nothing', async () => {
    const a = await replica(RA);
    const c = await replica(RC);
    write(a, retrieval('plain'));
    push(a);
    expect(pull(c)).toMatchObject({ pending: 0, void: 0 });
    const row = a.db.prepare('SELECT uid, birth_fp AS fp FROM brain_retrieval_log').get() as {
      uid: string;
      fp: string;
    };
    a.db.exec('BEGIN IMMEDIATE');
    const frame = openCaptureFrame(a.db, 'rekey', null);
    setRowUidNative(a.db, 'brain_retrieval_log', row.uid, row.fp, mintRowUid());
    finishCaptureFrame(a.db, frame);
    a.db.exec('COMMIT');
    seal(a);
    expect(push(a).flatMap((t) => t.ops)).toEqual([
      expect.objectContaining({ o: 'K', u: row.uid, obfp: row.fp }),
    ]);
    expect(pull(c)).toMatchObject({ pending: 0, void: 0 });
    expect(retrievalRows(c)).toEqual(retrievalRows(a));
    expect(push(c)).toEqual([]);
  });

  it('an announcement seals as an alias-only K even when its old uid has no meta here', async () => {
    const c = await replica(RC);
    write(c, retrieval('solo'));
    push(c);
    const row = c.db.prepare('SELECT uid, birth_fp AS fp FROM brain_retrieval_log').get() as {
      uid: string;
      fp: string;
    };
    // Another replica's K moved this row here from OLD; C owes its announcement.
    const OLD = '0192dddd-7f00-7000-8000-0000000000d1';
    recordUidAlias(
      c.db,
      {
        table: 'brain_retrieval_log',
        oldUid: OLD,
        oldBfp: row.fp,
        newUid: row.uid,
        origin: RA,
        hlc: `${String(++clock).padStart(13, '0')}-000000-${RA}`,
      },
      new Date().toISOString(),
    );
    markAliasPlaced(c.db, 'brain_retrieval_log', OLD, row.fp);
    expect(
      announcePlacedRekeys(
        c.db,
        { scope: 'project', stream: streamOf('project'), replica: RC },
        new Date().toISOString(),
      ),
    ).toBe(1);
    seal(c);
    expect(push(c).flatMap((t) => t.ops)).toEqual([
      expect.objectContaining({ o: 'K', t: 'brain_retrieval_log', u: OLD, nu: row.uid }),
    ]);
    expect(
      c.db.prepare(`SELECT uid FROM _sync_row_meta WHERE tbl = 'brain_retrieval_log'`).all(),
    ).toEqual([{ uid: row.uid }]);
    // Owed once: a second call announces nothing.
    expect(
      announcePlacedRekeys(
        c.db,
        { scope: 'project', stream: streamOf('project'), replica: RC },
        new Date().toISOString(),
      ),
    ).toBe(0);
  });

  it('the origin settles after its sealed insert ops are folded away', async () => {
    const { winner, loser } = await collide(
      'project',
      'brain_retrieval_log',
      retrieval('query a'),
      retrieval('query b'),
    );
    push(winner);
    push(loser);
    // Folded: the insert's ops are gone; only _sync_authored remembers the origin (T13399).
    loser.db.exec(`DELETE FROM _sync_op WHERE o = 'I' AND tbl = 'brain_retrieval_log'`);
    expect(pull(loser)).toMatchObject({ pending: 0, void: 0 });
    expect(retrievalRows(loser)).toHaveLength(2);
    expect(listConflicts(loser.db, { open: true })).toEqual([]);
    expect(push(loser).flatMap((t) => t.ops.filter((o) => o.o === 'K'))).toHaveLength(1);
  });

  it('the global store settles its brain collisions the same way', async () => {
    const { winner, loser, uid } = await collide(
      'global',
      'brain_retrieval_log',
      retrieval('home a'),
      retrieval('home b'),
    );
    push(winner);
    push(loser);
    expect(pull(loser)).toMatchObject({ pending: 0, void: 0 });
    push(loser);
    expect(pull(winner)).toMatchObject({ pending: 0, void: 0 });
    const onWinner = retrievalRows(winner);
    expect(onWinner).toHaveLength(2);
    expect(new Set(onWinner.map((r) => r.uid)).size).toBe(2);
    expect(onWinner.some((r) => r.uid === uid)).toBe(true);
    expect(onWinner).toEqual(retrievalRows(loser));
    expect(listConflicts(winner.db, { open: true })).toEqual([]);
  });

  it('a loser this replica only received waits for its origin, then moves with the K', async () => {
    const { winner, loser, uid } = await collide(
      'project',
      'brain_retrieval_log',
      retrieval('query a'),
      retrieval('query b'),
    );
    // C places the loser first, then meets the winner: it is not the authority.
    push(loser);
    const c = await replica(RC);
    pull(c);
    push(winner);
    const held = pull(c);
    expect(held.pending).toBe(1);
    expect(retrievalRows(c)).toHaveLength(1);
    expect(c.db.prepare("SELECT count(*) AS n FROM _sync_txn WHERE kind = 'rekey'").get()).toEqual({
      n: 0,
    });
    // The origin re-keys; C moves its placed loser and places the winner.
    pull(loser);
    push(loser);
    expect(pull(c)).toMatchObject({ pending: 0, void: 0 });
    expect(retrievalRows(c)).toEqual(retrievalRows(loser));
    expect(retrievalRows(c).find((r) => r.uid === uid)?.query).toBe(
      retrievalRows(winner)[0]?.query,
    );
  });

  it('tasks_tasks: the origin re-mints the shared display id, and every replica places both rows (T13405)', async () => {
    const { winner, loser, uid } = await collide(
      'project',
      'tasks_tasks',
      task('alpha'),
      task('beta'),
    );
    // A child the origin wrote under its loser before the collision.
    write(
      loser,
      `INSERT INTO tasks_tasks (id, title, type, status, priority, parent_id, created_at)
         VALUES ('T2', 'child', 'subtask', 'pending', 'medium', 'T1', '2026-09-01T09:00:01.000Z')`,
    );
    const titleOf = (r: Replica) =>
      (r.db.prepare(`SELECT title FROM tasks_tasks WHERE id = 'T1'`).get() as { title: string })
        .title;
    const winnerTitle = titleOf(winner);
    const loserTitle = titleOf(loser);
    push(winner);
    push(loser);

    // The origin re-keys its loser, then re-mints its display id: the winner places as T1.
    const lr = pull(loser);
    expect(lr).toMatchObject({ pending: 0, void: 0 });
    const tasksOf = (r: Replica) =>
      rows(r.db, 'SELECT uid, id, title, parent_id FROM tasks_tasks ORDER BY title');
    const onLoser = tasksOf(loser);
    const moved = onLoser.find((t) => t.title === loserTitle);
    expect(onLoser.find((t) => t.title === winnerTitle)).toMatchObject({ uid, id: 'T1' });
    expect(moved?.uid).not.toBe(uid);
    expect(moved?.id).toMatch(/^T\d+$/);
    expect(moved?.id).not.toBe('T1');
    expect(moved?.id).not.toBe('T2');
    // The origin's child follows its parent's new id.
    expect(onLoser.find((t) => t.title === 'child')?.parent_id).toBe(moved?.id);
    expect(listConflicts(loser.db, { open: true })).toEqual([]);
    // K first, then the rename in its own remint transaction.
    const out = push(loser);
    expect(out.map((t) => t.kind)).toEqual(['rekey', 'remint']);
    expect(out[1]?.ops).toContainEqual(
      expect.objectContaining({ o: 'U', t: 'tasks_tasks', u: moved?.uid }),
    );

    // The winner holds the loser behind the key, folds the rename in, and places it.
    const wr = pull(winner);
    expect(wr).toMatchObject({ pending: 0, void: 0 });
    expect(tasksOf(winner)).toEqual(onLoser);
    expect(listConflicts(winner.db, { open: true })).toEqual([]);
  });

  it('a re-mint that fails after the K is retried by the next apply, and both replicas converge (T13431)', async () => {
    const { winner, loser } = await collide('project', 'tasks_tasks', task('alpha'), task('beta'));
    // The re-mint's id rename fails once, after the K has committed.
    loser.db.exec(`CREATE TEMP TRIGGER t13431_probe BEFORE UPDATE OF id ON main.tasks_tasks
      BEGIN SELECT RAISE(ABORT, 't13431 probe'); END`);
    push(winner);
    push(loser);
    expect(() => pull(loser)).toThrow('t13431 probe');
    expect(rows(loser.db, `SELECT id FROM tasks_tasks`)).toEqual([{ id: 'T1' }]);
    loser.db.exec('DROP TRIGGER temp.t13431_probe');
    expect(pull(loser)).toMatchObject({ pending: 0, void: 0 });
    const tasksOf = (r: Replica) =>
      rows(r.db, 'SELECT uid, id, title FROM tasks_tasks ORDER BY id');
    expect(tasksOf(loser)).toHaveLength(2);
    expect(listConflicts(loser.db, { open: true })).toEqual([]);
    push(loser);
    expect(pull(winner)).toMatchObject({ pending: 0, void: 0 });
    expect(tasksOf(winner)).toEqual(tasksOf(loser));
    expect(listConflicts(winner.db, { open: true })).toEqual([]);
  });

  it('a third replica that placed the loser first points its own children at the re-minted id', async () => {
    const a = await replica(RA);
    const b = await replica(RB);
    const c = await replica(RC);
    write(a, task('alpha'));
    write(b, task('beta'));
    const [win, lose] = fpOf(a, 'tasks_tasks') < fpOf(b, 'tasks_tasks') ? [a, b] : [b, a];
    const loserTitle = (lose.db.prepare('SELECT title FROM tasks_tasks').get() as { title: string })
      .title;
    push(lose);
    pull(c);
    // C writes a child under the loser it placed as T1.
    write(
      c,
      `INSERT INTO tasks_tasks (id, title, type, status, priority, parent_id, created_at)
         VALUES ('T9', 'c-child', 'subtask', 'pending', 'medium', 'T1', '2026-09-01T09:00:02.000Z')`,
    );
    push(win);
    pull(c);
    pull(lose);
    push(lose);
    push(c);
    const cr = pull(c);
    expect(cr).toMatchObject({ pending: 0, void: 0 });
    const loserId = (
      c.db.prepare('SELECT id FROM tasks_tasks WHERE title = ?').get(loserTitle) as { id: string }
    ).id;
    expect(loserId).not.toBe('T1');
    expect(
      (
        c.db.prepare(`SELECT parent_id AS p FROM tasks_tasks WHERE title = 'c-child'`).get() as {
          p: string;
        }
      ).p,
    ).toBe(loserId);
    expect(rows(c.db, `SELECT id FROM tasks_tasks WHERE id = 'T1'`)).toHaveLength(1);
  });

  it('brain_decisions: the re-minted D id carries its page node and evidence atoms with it', async () => {
    const decision = (text: string) =>
      `INSERT INTO brain_decisions (id, type, decision, rationale, confidence, created_at)
         VALUES ('D001', 'technical', '${text}', 'why', 'high', '2026-09-01 09:00:00')`;
    const { winner, loser, uid } = await collide(
      'project',
      'brain_decisions',
      decision('use a'),
      decision('use b'),
    );
    // The origin's own references to its decision: a page node and an evidence atom.
    write(
      loser,
      `INSERT INTO brain_page_nodes (id, node_type, label, created_at, last_activity_at)
         VALUES ('decision:D001', 'decision', 'dec', '2026-09-01 09:00:01', '2026-09-01 09:00:01')`,
    );
    write(
      loser,
      `INSERT INTO tasks_tasks (id, title, type, status, priority, verification_json, created_at)
         VALUES ('T5', 'ev', 'task', 'pending', 'medium',
                 '{"evidence":["decision:D001","decision:D0010"]}', '2026-09-01T09:00:03.000Z')`,
    );
    // The winner's own page node for its decision (T13432).
    write(
      winner,
      `INSERT INTO brain_page_nodes (id, node_type, label, created_at, last_activity_at)
         VALUES ('decision:D001', 'decision', 'win', '2026-09-01 09:00:02', '2026-09-01 09:00:02')`,
    );
    const textOf = (r: Replica) =>
      (
        r.db.prepare(`SELECT decision FROM brain_decisions WHERE id = 'D001'`).get() as {
          decision: string;
        }
      ).decision;
    const winnerText = textOf(winner);
    const loserText = textOf(loser);
    push(winner);
    push(loser);
    expect(pull(loser)).toMatchObject({ pending: 0, void: 0 });
    const decisionsOf = (r: Replica) =>
      rows(r.db, 'SELECT uid, id, decision FROM brain_decisions ORDER BY decision');
    const onLoser = decisionsOf(loser);
    const moved = onLoser.find((d) => d.decision === loserText);
    expect(onLoser.find((d) => d.decision === winnerText)).toMatchObject({ uid, id: 'D001' });
    expect(moved?.id).toBe('D002');
    const refsOf = (r: Replica) => ({
      nodes: rows(r.db, 'SELECT id FROM brain_page_nodes ORDER BY id').map((n) => n.id),
      evidence: (
        r.db.prepare(`SELECT verification_json AS v FROM tasks_tasks WHERE title = 'ev'`).get() as {
          v: string;
        }
      ).v,
    });
    expect(refsOf(loser)).toEqual({
      nodes: ['decision:D001', 'decision:D002'],
      evidence: '{"evidence":["decision:D002","decision:D0010"]}',
    });
    const labelsOf = (r: Replica) =>
      rows(r.db, 'SELECT id, label FROM brain_page_nodes ORDER BY id');
    expect(labelsOf(loser)).toEqual([
      { id: 'decision:D001', label: 'win' },
      { id: 'decision:D002', label: 'dec' },
    ]);
    push(loser);
    expect(pull(winner)).toMatchObject({ pending: 0, void: 0 });
    expect(decisionsOf(winner)).toEqual(onLoser);
    expect(refsOf(winner)).toEqual(refsOf(loser));
    expect(labelsOf(winner)).toEqual(labelsOf(loser));
    expect(statuses(winner.db)).not.toContain('pending');
    expect(listConflicts(winner.db, { open: true })).toEqual([]);
  });

  it('a third replica re-points its own decision evidence at the re-minted D id (T13433)', async () => {
    const decision = (text: string) =>
      `INSERT INTO brain_decisions (id, type, decision, rationale, confidence, created_at)
         VALUES ('D001', 'technical', '${text}', 'why', 'high', '2026-09-01 09:00:00')`;
    const a = await replica(RA);
    const b = await replica(RB);
    const c = await replica(RC);
    write(a, decision('use a'));
    write(b, decision('use b'));
    const [win, lose] = fpOf(a, 'brain_decisions') < fpOf(b, 'brain_decisions') ? [a, b] : [b, a];
    const loserText = (
      lose.db.prepare('SELECT decision FROM brain_decisions').get() as { decision: string }
    ).decision;
    push(lose);
    pull(c);
    // C cites the decision it placed as D001: that is the loser.
    write(
      c,
      `INSERT INTO tasks_tasks (id, title, type, status, priority, verification_json, created_at)
         VALUES ('T7', 'c-ev', 'task', 'pending', 'medium',
                 '{"evidence":["decision:D001"]}', '2026-09-01T09:00:04.000Z')`,
    );
    push(win);
    pull(c);
    pull(lose);
    push(lose);
    push(c);
    expect(pull(c)).toMatchObject({ pending: 0, void: 0 });
    const loserId = (
      c.db.prepare('SELECT id FROM brain_decisions WHERE decision = ?').get(loserText) as {
        id: string;
      }
    ).id;
    expect(loserId).toBe('D002');
    const evidenceOf = (r: Replica) =>
      (
        r.db
          .prepare(`SELECT verification_json AS v FROM tasks_tasks WHERE title = 'c-ev'`)
          .get() as {
          v: string;
        }
      ).v;
    expect(evidenceOf(c)).toBe('{"evidence":["decision:D002"]}');
    push(c);
    expect(pull(win)).toMatchObject({ pending: 0, void: 0 });
    expect(evidenceOf(win)).toBe('{"evidence":["decision:D002"]}');
    expect(
      (
        win.db.prepare(`SELECT decision FROM brain_decisions WHERE id = 'D002'`).get() as {
          decision: string;
        }
      ).decision,
    ).toBe(loserText);
  });

  it("a third replica never re-points the winner's evidence on a row it edited last (T13456)", async () => {
    const decision = (text: string) =>
      `INSERT INTO brain_decisions (id, type, decision, rationale, confidence, created_at)
         VALUES ('D001', 'technical', '${text}', 'why', 'high', '2026-09-01 09:00:00')`;
    const a = await replica(RA);
    const b = await replica(RB);
    const c = await replica(RC);
    write(a, decision('use a'));
    write(b, decision('use b'));
    const [win, lose] = fpOf(a, 'brain_decisions') < fpOf(b, 'brain_decisions') ? [a, b] : [b, a];
    // The winner cites its own D001.
    write(
      win,
      `INSERT INTO tasks_tasks (id, title, type, status, priority, verification_json, created_at)
         VALUES ('T9', 'w-ev', 'task', 'pending', 'medium',
                 '{"evidence":["decision:D001"]}', '2026-09-01T09:00:04.000Z')`,
    );
    push(lose);
    pull(c);
    push(win);
    pull(c);
    // C edits another column of the winner's task: the row's newest origin is now C.
    write(c, `UPDATE tasks_tasks SET status = 'active' WHERE title = 'w-ev'`);
    push(c);
    pull(lose);
    push(lose);
    expect(pull(c)).toMatchObject({ pending: 0, void: 0 });
    const evidenceOf = (r: Replica) =>
      (
        r.db
          .prepare(`SELECT verification_json AS v FROM tasks_tasks WHERE title = 'w-ev'`)
          .get() as { v: string }
      ).v;
    expect(evidenceOf(c)).toBe('{"evidence":["decision:D001"]}');
    push(c);
    expect(pull(win)).toMatchObject({ pending: 0, void: 0 });
    expect(evidenceOf(win)).toBe('{"evidence":["decision:D001"]}');
    expect(
      (
        win.db.prepare(`SELECT decision FROM brain_decisions WHERE id = 'D001'`).get() as {
          decision: string;
        }
      ).decision,
    ).not.toBe(
      (
        lose.db.prepare(`SELECT decision FROM brain_decisions WHERE id = 'D002'`).get() as {
          decision: string;
        }
      ).decision,
    );
  });

  it('a third replica re-points its own evidence on a row another replica edited last (T13456)', async () => {
    const decision = (text: string) =>
      `INSERT INTO brain_decisions (id, type, decision, rationale, confidence, created_at)
         VALUES ('D001', 'technical', '${text}', 'why', 'high', '2026-09-01 09:00:00')`;
    const a = await replica(RA);
    const b = await replica(RB);
    const c = await replica(RC);
    write(a, decision('use a'));
    write(b, decision('use b'));
    const [win, lose] = fpOf(a, 'brain_decisions') < fpOf(b, 'brain_decisions') ? [a, b] : [b, a];
    push(lose);
    pull(c);
    // C cites the decision it placed (the loser).
    write(
      c,
      `INSERT INTO tasks_tasks (id, title, type, status, priority, verification_json, created_at)
         VALUES ('T7', 'c-ev', 'task', 'pending', 'medium',
                 '{"evidence":["decision:D001"]}', '2026-09-01T09:00:04.000Z')`,
    );
    push(c);
    pull(win);
    // The winner edits another column of C's task: the row's newest origin is the winner.
    write(win, `UPDATE tasks_tasks SET status = 'active' WHERE title = 'c-ev'`);
    push(win);
    pull(c);
    pull(lose);
    push(lose);
    expect(pull(c)).toMatchObject({ pending: 0, void: 0 });
    const evidenceOf = (r: Replica) =>
      (
        r.db
          .prepare(`SELECT verification_json AS v FROM tasks_tasks WHERE title = 'c-ev'`)
          .get() as { v: string }
      ).v;
    expect(evidenceOf(c)).toBe('{"evidence":["decision:D002"]}');
    push(c);
    expect(pull(win)).toMatchObject({ pending: 0, void: 0 });
    expect(evidenceOf(win)).toBe('{"evidence":["decision:D002"]}');
  });

  it('brain_sticky_notes (global): the re-minted SN id keeps its tags', async () => {
    const note = (content: string) =>
      `INSERT INTO brain_sticky_notes (id, content, created_at)
         VALUES ('SN-001', '${content}', '2026-09-01 09:00:00')`;
    const { winner, loser, uid } = await collide(
      'global',
      'brain_sticky_notes',
      note('note a'),
      note('note b'),
    );
    write(loser, `INSERT INTO brain_sticky_tags (sticky_id, tag) VALUES ('SN-001', 'mine')`);
    const loserContent = (
      loser.db.prepare('SELECT content FROM brain_sticky_notes').get() as { content: string }
    ).content;
    push(winner);
    push(loser);
    expect(pull(loser)).toMatchObject({ pending: 0, void: 0 });
    const notesOf = (r: Replica) =>
      rows(r.db, 'SELECT uid, id, content FROM brain_sticky_notes ORDER BY content');
    const moved = notesOf(loser).find((n) => n.content === loserContent);
    expect(moved?.id).toBe('SN-002');
    expect(notesOf(loser).find((n) => n.content !== loserContent)).toMatchObject({
      uid,
      id: 'SN-001',
    });
    const tagsOf = (r: Replica) => rows(r.db, 'SELECT sticky_id, tag FROM brain_sticky_tags');
    expect(tagsOf(loser)).toEqual([{ sticky_id: 'SN-002', tag: 'mine' }]);
    push(loser);
    expect(pull(winner)).toMatchObject({ pending: 0, void: 0 });
    expect(notesOf(winner)).toEqual(notesOf(loser));
    expect(tagsOf(winner)).toEqual(tagsOf(loser));
  });
});
