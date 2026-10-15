/**
 * Two-device end to end (T13371): two real replicas, A (which cut the
 * stream's genesis) and B (which joined it), edit the same task while
 * neither has seen the other's change. Both push, both pull, and both must
 * end with the same row, the same conflict records and the same content
 * checksums. A row changed behind the journal's back must then show up in
 * the checksums and in the repair diff.
 *
 * Every step runs the real code: capture triggers, sealer, segment builder,
 * txn signatures, push, pull, inbox, merge engine and applier. Only the
 * server is a fake stream that orders segments as they arrive.
 *
 * Merge rules this exercises (journal spec §3.2, merge/rules.ts):
 * - per-field LWW by HLC for title, priority and acceptance_json;
 * - the status group {status, completed_at, cancelled_at, cancellation_reason}
 *   moves as one unit from the winning op;
 * - `task.status.absorbing` (T12937): done and cancelled are both terminal,
 *   so between them it is plain LWW, never a refusal;
 * - pipeline_stage is coupled to the terminal status (T13243);
 * - a concurrent divergent edit records a conflict whichever side wins.
 *
 * @task T13371
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { LedgerTxn } from '@cleocode/contracts/ledger';
import { SYNC_SCHEMA_VERSION } from '@cleocode/contracts/sync-schema.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateEd25519 } from '../../../cloud/crypto.js';
import { DocsReadModel } from '../../../docs/docs-read-model.js';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../../dual-scope-db.js';
import {
  ROW_IDENTITY_META_TABLE,
  ROW_IDENTITY_RECIPE,
  ROW_IDENTITY_RECIPE_KEY,
} from '../../row-identity.js';
import {
  captureTableDef,
  dropCaptureTriggers,
  finishCaptureFrame,
  installCaptureTriggers,
  openCaptureFrame,
  setCaptureEnabled,
} from '../capture.js';
import { listConflicts } from '../conflicts.js';
import { setSyncFlag, syncSetTables } from '../flags.js';
import { completeGenesis, cutGenesis, joinStream } from '../genesis.js';
import {
  type PulledStreamSegment,
  type PullStreamOptions,
  pullStream,
  type StreamCursor,
} from '../pull.js';
import { pushStream } from '../push.js';
import { planRepair } from '../repair.js';
import { activeReplica, ensureProjectReplica } from '../replica.js';
import { ReplicaRegistry } from '../replica-registry.js';
import { rowChash, sealPending } from '../sealer.js';
import { firstBadTxnSignature, signTxn } from '../txn-signing.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');
const STREAM = 'project:0192ffff-7f00-7000-8000-0000000013a1';
const KEYS = { 'dev-a': generateEd25519(), 'dev-b': generateEd25519() } as const;
type Device = keyof typeof KEYS;
let clock = Date.now();
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-two-device-'));
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

interface Replica {
  readonly db: DatabaseSync;
  readonly device: Device;
}

const START: StreamCursor = { after: 0, knowsAllReplicas: true, replicas: {} };

/** A store with capture, seal, push and pull on, bound to its own replica. */
async function open(name: string, device: Device): Promise<Replica> {
  mkdirSync(join(dir, name, '.cleo'), { recursive: true });
  const path = join(dir, name, '.cleo', 'cleo.db');
  const db = getDualScopeNativeDb(await openDualScopeDbAtPath('project', path));
  db.prepare(
    `INSERT INTO ${ROW_IDENTITY_META_TABLE} (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(ROW_IDENTITY_RECIPE_KEY, ROW_IDENTITY_RECIPE);
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  for (const flag of ['sync.seal', 'sync.push', 'sync.pull'] as const) {
    setSyncFlag(db, flag, true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  }
  const registry = new ReplicaRegistry(join(dir, `registry-${name}.json`), device);
  ensureProjectReplica(db, { dbPath: path, mode: 'test', registry });
  return { db, device };
}

const replicaOf = (r: Replica): string => activeReplica(r.db, 'project')?.replicaId ?? '';

/** A cuts the stream's genesis; B, an empty store, joins it at the start. */
async function twoDevices(): Promise<{ a: Replica; b: Replica }> {
  const a = await open('a', 'dev-a');
  expect(
    cutGenesis(a.db, {
      scope: 'project',
      stream: STREAM,
      now: () => ++clock,
      env: {},
      allowUnreleased: true,
    }).refused,
  ).toBeNull();
  completeGenesis(a.db, {
    stream: STREAM,
    replica: replicaOf(a),
    replicaSeqFloor: null,
    nowIso: new Date(++clock).toISOString(),
  });
  const b = await open('b', 'dev-b');
  expect(
    joinStream(b.db, {
      scope: 'project',
      stream: STREAM,
      cursor: START,
      now: () => ++clock,
      allowUnreleased: true,
    }).refused,
  ).toBeNull();
  return { a, b };
}

/** One local write, in its own capture frame, as a command would make it. */
function write(db: DatabaseSync, sql: string): void {
  db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(db, 'write', null);
  db.exec(sql);
  finishCaptureFrame(db, frame);
  db.exec('COMMIT');
}

/** The fake server: segments in arrival order; pulls page after the cursor. */
function fakeStream() {
  const segments: PulledStreamSegment[] = [];
  return {
    segments,
    append(plaintext: Uint8Array, replicaSeq: number, replicaId: string, deviceId: string): number {
      segments.push({
        seq: segments.length + 1,
        replicaId,
        replicaSeq,
        deviceId,
        plaintext,
        schemaVersion: SYNC_SCHEMA_VERSION,
      });
      return segments.length;
    },
    pull: async (cursor: StreamCursor) => {
      const page = segments.filter((s) => s.seq > cursor.after).slice(0, 2);
      const replicas = { ...cursor.replicas };
      for (const s of page) {
        replicas[s.replicaId] = { deviceId: s.deviceId, replicaSeq: s.replicaSeq };
      }
      return {
        segments: page,
        cursor: { after: page.at(-1)?.seq ?? cursor.after, knowsAllReplicas: true, replicas },
        head: segments.length,
      };
    },
  };
}
type Stream = ReturnType<typeof fakeStream>;

async function push(r: Replica, stream: Stream) {
  const replica = replicaOf(r);
  const out = await pushStream(r.db, {
    scope: 'project',
    stream: STREAM,
    replica,
    project: null,
    sealer: (_seq, plaintext) => Buffer.from(plaintext),
    signTxn: (s, txn) => signTxn(KEYS[r.device], s, txn),
    upload: async (seg) => ({
      seq: stream.append(seg.sealed, seg.replicaSeq, replica, r.device),
      duplicate: false,
    }),
    serverOffsetMs: 0,
    serverLastReplicaSeq: null,
    now: () => ++clock,
    env: {},
    allowUnreleased: true,
  });
  expect(out.refused).toBeNull();
  return out;
}

async function pull(r: Replica, stream: Stream) {
  const replica = replicaOf(r);
  const opts: PullStreamOptions = {
    scope: 'project',
    stream: STREAM,
    replica,
    pull: stream.pull,
    verify: (deviceId: string, txns: readonly LedgerTxn[]) =>
      deviceId in KEYS ? firstBadTxnSignature(KEYS[deviceId as Device].publicKey, STREAM, txns) : 0,
    initialCursor: START,
    now: () => ++clock,
    env: {},
    seal: () => {
      sealPending(r.db, {
        scope: 'project',
        replica,
        now: () => ++clock,
        env: {},
        allowUnreleased: true,
      });
    },
  };
  const out = await pullStream(r.db, opts);
  expect(out.refused).toBeNull();
  return out;
}

const TASK_COLUMNS =
  'title, status, priority, acceptance_json, pipeline_stage, completed_at, cancelled_at, cancellation_reason';

function task(db: DatabaseSync, id: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks_tasks WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
}

/**
 * Per-table content checksum over the sync set: sha256 of every live row's
 * uid and wire-image hash ({@link rowChash}, the hash every replica computes
 * over identical bytes), in uid order. Tables with no rows are left out.
 */
function contentChecksums(db: DatabaseSync): Record<string, string> {
  const out: Record<string, string> = {};
  for (const table of syncSetTables('project')) {
    const def = captureTableDef(db, 'project', table);
    if (!def) continue;
    const uids = (
      db.prepare(`SELECT uid FROM "${table}" WHERE uid IS NOT NULL ORDER BY uid`).all() as Array<{
        uid: string;
      }>
    ).map((r) => r.uid);
    if (uids.length === 0) continue;
    const h = createHash('sha256');
    for (const uid of uids) h.update(`${uid}\0${rowChash(db, 'project', def, uid) ?? ''}\n`);
    out[table] = h.digest('hex');
  }
  return out;
}

/** Seal whatever the apply left captured, so the repair diff can run. */
function settle(r: Replica): void {
  const out = sealPending(r.db, {
    scope: 'project',
    replica: replicaOf(r),
    now: () => ++clock,
    env: {},
    allowUnreleased: true,
  });
  expect(out.refused).toBeNull();
}

/** The conflicts a replica recorded, as (table, uid, columns) keys, sorted. */
function conflictKeys(db: DatabaseSync): string[] {
  return listConflicts(db, { stream: STREAM })
    .map((c) => `${c.table}|${c.uid}|${[...c.columns].sort().join(',')}`)
    .sort();
}

/**
 * A pushes T1, B pulls it; then both go offline and edit T1 concurrently.
 * A completes it and retitles it; B cancels it, retitles it, raises its
 * priority and rewrites its acceptance. B's edits are sealed later, so they
 * carry the later HLCs.
 */
async function concurrentEdits() {
  const { a, b } = await twoDevices();
  const stream = fakeStream();
  write(
    a.db,
    `INSERT INTO tasks_tasks (id, title, type, status, priority, acceptance_json, uid, birth_fp)
     VALUES ('T1', 'shared task', 'task', 'pending', 'medium', '["ship it"]', 'uid-T1', 'fp-T1')`,
  );
  await push(a, stream);
  await pull(b, stream);
  await pull(a, stream); // own echo
  expect(task(b.db, 'T1')).toEqual(task(a.db, 'T1'));
  const base = task(a.db, 'T1');

  // Offline, concurrently: neither replica has seen the other's edit.
  const doneAt = new Date(++clock).toISOString();
  write(
    a.db,
    `UPDATE tasks_tasks SET status = 'done', completed_at = '${doneAt}', pipeline_stage = 'contribution',
       title = 'title from A', acceptance_json = '["ship it","A: tests green"]' WHERE id = 'T1'`,
  );
  await push(a, stream);
  const cancelAt = new Date(++clock).toISOString();
  write(
    b.db,
    `UPDATE tasks_tasks SET status = 'cancelled', cancelled_at = '${cancelAt}',
       cancellation_reason = 'superseded on B', pipeline_stage = 'cancelled',
       title = 'title from B', priority = 'high', acceptance_json = '["B: rescoped"]' WHERE id = 'T1'`,
  );
  await push(b, stream); // B pushes without having pulled A's edit

  await pull(a, stream);
  await pull(b, stream);
  return { a, b, stream, base, cancelAt };
}

describe('two devices editing one task converge (T13371)', () => {
  it('both replicas end with the same row, chosen by the merge rules', async () => {
    const { a, b, cancelAt } = await concurrentEdits();
    const atA = task(a.db, 'T1');
    const atB = task(b.db, 'T1');
    expect(atA).toEqual(atB);
    // B's edits carry the later HLCs: LWW gives B every field both touched;
    // the status group moves whole from B's op, and the stage follows it.
    expect(atA).toMatchObject({
      title: 'title from B',
      status: 'cancelled',
      cancelled_at: cancelAt,
      cancellation_reason: 'superseded on B',
      completed_at: null,
      pipeline_stage: 'cancelled',
      priority: 'high',
      acceptance_json: '["B: rescoped"]',
    });
  });

  it('both replicas record the same conflicts for the divergent fields, and none for priority', async () => {
    const { a, b } = await concurrentEdits();
    const keysA = conflictKeys(a.db);
    const keysB = conflictKeys(b.db);
    expect(keysA.length).toBeGreaterThan(0);
    expect(keysA).toEqual(keysB);
    const columns = new Set(
      [...listConflicts(a.db, { stream: STREAM }), ...listConflicts(b.db, { stream: STREAM })]
        .filter((c) => c.uid === 'uid-T1')
        .flatMap((c) => c.columns),
    );
    expect(columns.has('title')).toBe(true);
    expect(columns.has('status')).toBe(true);
    expect(columns.has('acceptance_json')).toBe(true);
    // Only B changed priority: no divergence, no conflict.
    expect(columns.has('priority')).toBe(false);
  });

  it("both replicas' per-table content checksums match after convergence", async () => {
    const { a, b, stream } = await concurrentEdits();
    // Converged replicas have nothing left to send: no echo ping-pong.
    const sent = stream.segments.length;
    await push(a, stream);
    await push(b, stream);
    expect(stream.segments.length).toBe(sent);
    const sumA = contentChecksums(a.db);
    expect(sumA.tasks_tasks).toBeDefined();
    expect(contentChecksums(b.db)).toEqual(sumA);
    // Each replica's row meta agrees with its own rows: nothing for repair.
    for (const r of [a, b]) {
      settle(r);
      const plan = planRepair(r.db, 'project', 'tasks_tasks');
      expect(plan.skipped).toBeNull();
      expect(plan.inserts.length + plan.updates.length + plan.deletes.length).toBe(0);
    }
  });

  it('a row changed behind the journal is caught by the checksums and the repair diff', async () => {
    const { a, b } = await concurrentEdits();
    settle(a);
    settle(b);
    // Corrupt B's copy with capture off, as a raw edit outside the chokepoint would.
    dropCaptureTriggers(b.db);
    b.db.prepare("UPDATE tasks_tasks SET title = 'silently corrupted' WHERE id = 'T1'").run();
    installCaptureTriggers(b.db, 'project');
    const sumA = contentChecksums(a.db);
    const sumB = contentChecksums(b.db);
    expect(sumB.tasks_tasks).not.toBe(sumA.tasks_tasks);
    const plan = planRepair(b.db, 'project', 'tasks_tasks');
    expect(plan.skipped).toBeNull();
    expect(plan.updates.map((u) => u.uid)).toContain('uid-T1');
    // A is untouched.
    const atA = planRepair(a.db, 'project', 'tasks_tasks');
    expect(atA.updates.length).toBe(0);
  });
});

describe('natural-key brain rows replay across devices (T12895)', () => {
  it('memory links, release links and page edges reach B by derived uid, with the same counts and hashes', async () => {
    const NATURAL = ['brain_page_edges', 'brain_memory_links', 'tasks_brain_release_links'];
    const count = (db: DatabaseSync, t: string) =>
      (db.prepare(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }).n;
    const pick = (sums: Record<string, string>) =>
      Object.fromEntries(NATURAL.map((t) => [t, sums[t] ?? null]));
    const expectReplayed = (want: number[]) => {
      expect(NATURAL.map((t) => count(a.db, t))).toEqual(want);
      expect(NATURAL.map((t) => count(b.db, t))).toEqual(want);
      expect(pick(contentChecksums(b.db))).toEqual(pick(contentChecksums(a.db)));
      expect(contentChecksums(b.db)).toEqual(contentChecksums(a.db));
    };
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    write(
      a.db,
      `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp)
         VALUES ('T1', 'linked task', 'task', 'pending', 'medium', 'uid-T1', 'fp-T1');
       INSERT INTO brain_memory_links (memory_type, memory_id, task_id, link_type, created_at) VALUES
         ('observation', 'O-0a1b2c3d', 'T1', 'produced_by', '2026-10-10 09:00:00'),
         ('decision', 'D0001', 'T1', 'produced_by', '2026-10-10 09:00:01');
       INSERT INTO tasks_brain_release_links (brain_entry_id, release_id, link_type, created_at) VALUES
         ('O-0a1b2c3d', 'v2026.10.5', 'observed-in', '2026-10-10 09:01:00');
       INSERT INTO brain_page_edges (from_id, to_id, edge_type, created_at) VALUES
         ('task:T1', 'observation:O-0a1b2c3d', 'derived_from', '2026-10-10 09:02:00'),
         ('task:T1', 'symbol:src/a.ts#f', 'code_reference', '2026-10-10 09:02:01');`,
    );
    await push(a, stream);
    await pull(b, stream);
    expectReplayed([2, 2, 1]);

    write(
      a.db,
      `UPDATE brain_page_edges SET weight = 0.25 WHERE to_id = 'observation:O-0a1b2c3d';
       DELETE FROM brain_page_edges WHERE to_id = 'symbol:src/a.ts#f';
       DELETE FROM brain_memory_links WHERE memory_id = 'D0001';
       INSERT INTO tasks_brain_release_links (brain_entry_id, release_id, link_type, created_at) VALUES
         ('D0001', 'v2026.10.6', 'observed-in', '2026-10-10 09:03:00');`,
    );
    await push(a, stream);
    await pull(b, stream);
    expectReplayed([1, 1, 2]);
    expect(
      b.db.prepare("SELECT weight FROM brain_page_edges WHERE from_id = 'task:T1'").get(),
    ).toEqual({ weight: 0.25 });
  });
});

describe('docs reach a second device (T12919)', () => {
  const BODY = '# Gate doc\n\nline one\n';
  const sha = (body: string) => createHash('sha256').update(body).digest('hex');
  const SHA = sha(BODY);
  const NEXT_SHA = sha(`${BODY}v2\n`);
  const json = (s: string) =>
    JSON.stringify({ kind: 'blob', mime: 'text/markdown', sha256: s, size: BODY.length });
  let clockMs = Date.parse('2026-10-14T18:00:00.000Z');

  /** The UNIQUE indexes real stores carry (twin collapse, twin-collapse.ts). */
  function uniqueDocIndexes(db: DatabaseSync): string[] {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_docs_attachments_slug ON docs_attachments (slug) WHERE slug IS NOT NULL;
             CREATE UNIQUE INDEX IF NOT EXISTS uniq_docs_attachments_sha256 ON docs_attachments (sha256);`);
    return (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'uniq_docs_attachments_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
  }

  /** Add a doc with one ref, as `docs add` writes them (a random local id). */
  function addDoc(db: DatabaseSync, id: string, s: string, slug: string | null, owner: string) {
    const at = new Date(++clockMs).toISOString();
    write(
      db,
      `INSERT INTO docs_attachments (id, sha256, attachment_json, created_at, ref_count, slug, type)
         VALUES ('${id}', '${s}', '${json(s)}', '${at}', 1, ${slug === null ? 'NULL' : `'${slug}'`}, 'note');
       INSERT INTO docs_attachment_refs (attachment_id, owner_type, owner_id, attached_at)
         VALUES ('${id}', 'task', '${owner}', '${at}');`,
    );
  }

  /** Every doc row without its local id, by content address. */
  const docs = (db: DatabaseSync) =>
    db
      .prepare(
        'SELECT sha256, slug, lifecycle_status, uid, ' +
          '(SELECT s.sha256 FROM docs_attachments s WHERE s.id = d.superseded_by) AS superseded_by_sha ' +
          'FROM docs_attachments d ORDER BY sha256',
      )
      .all();
  /** Every ref, with its doc named by content address (the local id differs per device). */
  const refs = (db: DatabaseSync) =>
    db
      .prepare(
        `SELECT d.sha256, r.owner_type, r.owner_id, r.uid FROM docs_attachment_refs r
           LEFT JOIN docs_attachments d ON d.id = r.attachment_id ORDER BY r.uid`,
      )
      .all();
  const docConflicts = (db: DatabaseSync, kind: string) =>
    listConflicts(db, { stream: STREAM }).filter(
      (c) => c.table.startsWith('docs_') && c.kind === kind,
    );
  const pick = (s: Record<string, string>) => [s.docs_attachments, s.docs_attachment_refs];

  /** A adds a doc and its successor draft, B pulls them. */
  async function docOnBoth() {
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    for (const r of [a, b]) uniqueDocIndexes(r.db);
    addDoc(a.db, 'doc-1', SHA, 'gate-doc', 'T1');
    addDoc(a.db, 'doc-2', NEXT_SHA, null, 'T1');
    mkdirSync(join(dir, 'a', '.cleo', 'blobs', 'blobs'), { recursive: true });
    writeFileSync(join(dir, 'a', '.cleo', 'blobs', 'blobs', SHA), BODY);
    await push(a, stream);
    await pull(b, stream);
    await pull(a, stream); // own echo
    return { a, b, stream };
  }

  it('the doc row and its ref travel with their uids; docs list and fetch resolve it on B', async () => {
    const { a, b } = await docOnBoth();
    expect(docs(b.db)).toEqual(docs(a.db));
    expect(docs(b.db)).toHaveLength(2);
    expect(refs(b.db)).toEqual(refs(a.db));
    expect(pick(contentChecksums(b.db))).toEqual(pick(contentChecksums(a.db)));

    const model = new DocsReadModel({ projectRoot: join(dir, 'b') });
    const listed = await model.listProjectDocs();
    expect(listed.map((d) => d.slug)).toContain('gate-doc');
    // The bytes are not on the stream (T13721): fetch names the doc and says
    // its content is missing, never a fabricated body.
    const missing = await model.fetchDecoded('gate-doc');
    expect(missing).toMatchObject({ ok: false, reason: 'no-content' });
    // Once the content-addressed bytes land (a vault restore carries them,
    // T13704), the synced row serves them.
    mkdirSync(join(dir, 'b', '.cleo', 'blobs', 'blobs'), { recursive: true });
    writeFileSync(join(dir, 'b', '.cleo', 'blobs', 'blobs', SHA), BODY);
    expect(await model.fetchDecoded('gate-doc')).toMatchObject({ ok: true, content: BODY });
  });

  it('a concurrent lifecycle transition converges: superseded absorbs a later accept (docs.lifecycle.transitions)', async () => {
    const { a, b, stream } = await docOnBoth();
    write(
      a.db,
      `UPDATE docs_attachments SET lifecycle_status = 'superseded',
         superseded_by = (SELECT id FROM docs_attachments WHERE sha256 = '${NEXT_SHA}')
       WHERE sha256 = '${SHA}'`,
    );
    await push(a, stream);
    // B has not seen A's supersession; its accept carries the later HLC.
    write(
      b.db,
      `UPDATE docs_attachments SET lifecycle_status = 'accepted' WHERE sha256 = '${SHA}'`,
    );
    await push(b, stream);
    await pull(a, stream);
    await pull(b, stream);
    expect(docs(b.db)).toEqual(docs(a.db));
    expect(docs(a.db)[SHA < NEXT_SHA ? 0 : 1]).toMatchObject({
      sha256: SHA,
      lifecycle_status: 'superseded',
      superseded_by_sha: NEXT_SHA,
    });
  });

  it('the same bytes added on both devices become one doc; no row, ref or blob owner is lost', async () => {
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    for (const r of [a, b]) expect(uniqueDocIndexes(r.db)).toHaveLength(2);
    // The same repo ADR backfilled on each machine, each with its own random id.
    addDoc(a.db, 'id-a', SHA, 'adr-001', 'T1');
    addDoc(b.db, 'id-b', SHA, 'adr-001', 'T2');
    await push(a, stream);
    await push(b, stream);
    await pull(a, stream);
    await pull(b, stream);
    for (const r of [a, b]) {
      expect(docs(r.db)).toHaveLength(1);
      // Both owners keep their ref, each pointing at the one doc.
      expect(
        (refs(r.db) as Array<{ sha256: string; owner_id: string }>)
          .map((x) => [x.sha256, x.owner_id])
          .sort(),
      ).toEqual([
        [SHA, 'T1'],
        [SHA, 'T2'],
      ]);
      expect(docConflicts(r.db, 'guard')).toEqual([]);
    }
    // Each device keeps its own local id for its own row.
    expect(a.db.prepare('SELECT id FROM docs_attachments').get()).toEqual({ id: 'id-a' });
    expect(b.db.prepare('SELECT id FROM docs_attachments').get()).toEqual({ id: 'id-b' });
    expect(docs(b.db)).toEqual(docs(a.db));
    expect(refs(b.db)).toEqual(refs(a.db));
  });

  it('two different docs under one slug both survive: the greater uid yields the slug on both devices', async () => {
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    for (const r of [a, b]) expect(uniqueDocIndexes(r.db)).toHaveLength(2);
    addDoc(a.db, 'id-a', SHA, 'adr-001', 'T1');
    addDoc(b.db, 'id-b', NEXT_SHA, 'adr-001', 'T2');
    await push(a, stream);
    await push(b, stream);
    await pull(a, stream);
    await pull(b, stream);
    const atA = docs(a.db) as Array<{ sha256: string; slug: string; uid: string }>;
    expect(atA).toHaveLength(2);
    expect(docs(b.db)).toEqual(atA);
    const [keeps, yields] = [...atA].sort((x, y) => x.uid.localeCompare(y.uid));
    expect(keeps?.slug).toBe('adr-001');
    expect(yields?.slug).toBe(`adr-001-${yields?.uid.replaceAll('-', '').slice(-8)}`);
    expect(refs(b.db)).toEqual(refs(a.db));
    expect(refs(a.db)).toHaveLength(2);
    for (const r of [a, b]) {
      expect(docConflicts(r.db, 'guard')).toEqual([]);
      expect(docConflicts(r.db, 'key-collision').map((c) => c.uid)).toEqual([yields?.uid]);
    }
  });

  it('a deref racing an attach never leaves a silent orphan ref', async () => {
    const { a, b, stream } = await docOnBoth();
    // A derefs the last owner: the ref, then the doc (ref_count 0).
    write(
      a.db,
      `DELETE FROM docs_attachment_refs WHERE attachment_id = 'doc-2';
       DELETE FROM docs_attachments WHERE id = 'doc-2';`,
    );
    await push(a, stream);
    // B, offline, attaches the same doc to another task.
    const local = (
      b.db.prepare(`SELECT id FROM docs_attachments WHERE sha256 = '${NEXT_SHA}'`).get() as {
        id: string;
      }
    ).id;
    write(
      b.db,
      `INSERT INTO docs_attachment_refs (attachment_id, owner_type, owner_id, attached_at)
         VALUES ('${local}', 'task', 'T9', '2026-10-14T19:00:00.000Z');
       UPDATE docs_attachments SET ref_count = 2 WHERE id = '${local}';`,
    );
    await push(b, stream);
    await pull(a, stream);
    await pull(b, stream);
    const orphans = (db: DatabaseSync) =>
      db
        .prepare(
          'SELECT count(*) AS n FROM docs_attachment_refs r WHERE NOT EXISTS (SELECT 1 FROM docs_attachments d WHERE d.id = r.attachment_id)',
        )
        .get();
    // A never writes the late ref onto the deleted doc: it records a dangling ref.
    expect(orphans(a.db)).toEqual({ n: 0 });
    expect(docConflicts(a.db, 'dangling-ref').length).toBeGreaterThan(0);
    expect(orphans(b.db)).toEqual({ n: 0 });
    expect(docs(b.db)).toEqual(docs(a.db));
    expect(refs(b.db)).toEqual(refs(a.db));
  });
});
