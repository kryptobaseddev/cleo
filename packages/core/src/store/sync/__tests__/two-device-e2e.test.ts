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

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { CloudWarning } from '@cleocode/contracts';
import type { LedgerTxn } from '@cleocode/contracts/ledger';
import { SYNC_SCHEMA_VERSION } from '@cleocode/contracts/sync-schema.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveKey, generateEd25519, hmacSha256, randomKey } from '../../../cloud/crypto.js';
import { pullDocBytes, pushDocBytes } from '../../../cloud/doc-bytes.js';
import { Http } from '../../../cloud/http.js';
import { Journal } from '../../../cloud/journal.js';
import {
  prepareSecretOpens,
  prepareSecretSeals,
  secretValuesKey,
} from '../../../cloud/secret-seal.js';
import { DocsReadModel } from '../../../docs/docs-read-model.js';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../../dual-scope-db.js';
import { exportPortableBundle } from '../../portable-bundle.js';
import { importPortableBundle } from '../../portable-bundle-import.js';
import {
  prepareRowIdentity,
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
import { completeGenesis, cutGenesis, cutGenesisWithSnapshot, joinStream } from '../genesis.js';
import { inboxCounts } from '../inbox.js';
import {
  type PulledStreamSegment,
  type PullStreamOptions,
  pullStream,
  readStreamCursor,
  type StreamCursor,
} from '../pull.js';
import { pushStream } from '../push.js';
import { reconcileCopy } from '../reconcile-copy.js';
import { planRepair } from '../repair.js';
import { activeReplica, ensureProjectReplica } from '../replica.js';
import { ReplicaRegistry } from '../replica-registry.js';
import { rowChash, type SecretSeals, sealPending } from '../sealer.js';
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

async function push(r: Replica, stream: Stream, secrets?: SecretSeals) {
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
    ...(secrets ? { secrets } : {}),
  });
  expect(out.refused).toBeNull();
  return out;
}

async function pull(r: Replica, stream: Stream, openSecrets?: PullStreamOptions['openSecrets']) {
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
    ...(openSecrets ? { openSecrets } : {}),
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

describe('project stickies and playbook approvals reach a second device (T12535)', () => {
  it('a sticky with its tag and a playbook run with its approval travel, and so do their later edits', async () => {
    const TABLES = [
      'brain_sticky_notes',
      'brain_sticky_tags',
      'tasks_playbook_runs',
      'tasks_playbook_approvals',
    ];
    const pick = (sums: Record<string, string>) =>
      Object.fromEntries(TABLES.map((t) => [t, sums[t] ?? null]));
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    write(
      a.db,
      `INSERT INTO brain_sticky_notes (id, content, tags_json, created_at, updated_at)
         VALUES ('SN-001', 'gate sticky', '["typed-rule"]', '2026-10-14 17:41:24', '2026-10-14 17:41:24');
       INSERT INTO brain_sticky_tags (sticky_id, tag) VALUES ('SN-001', 'typed-rule');
       INSERT INTO tasks_playbook_runs (run_id, playbook_name, playbook_hash, started_at)
         VALUES ('run-1', 'rcasd', 'hash-1', '2026-10-14 17:42:00');
       INSERT INTO tasks_playbook_approvals (approval_id, run_id, node_id, token, requested_at)
         VALUES ('appr-1', 'run-1', 'gate', 'tok-1', '2026-10-14 17:42:01');`,
    );
    // The resume token travels sealed (phase A, as `cloud sync` runs it).
    const secretKey = secretValuesKey(randomBytes(32));
    await push(a, stream, await prepareSecretSeals(a.db, 'project', secretKey));
    await pull(b, stream, () => prepareSecretOpens(b.db, 'project', STREAM, secretKey));
    expect(
      b.db.prepare("SELECT token FROM tasks_playbook_approvals WHERE approval_id = 'appr-1'").get(),
    ).toEqual({ token: 'tok-1' });
    for (const t of TABLES)
      expect(b.db.prepare(`SELECT count(*) AS n FROM "${t}"`).get(), t).toEqual({ n: 1 });
    expect(pick(contentChecksums(b.db))).toEqual(pick(contentChecksums(a.db)));

    write(
      a.db,
      `UPDATE brain_sticky_notes SET status = 'archived' WHERE id = 'SN-001';
       UPDATE tasks_playbook_approvals SET status = 'approved', approver = 'alice',
         approved_at = '2026-10-14 17:43:00' WHERE approval_id = 'appr-1';`,
    );
    await push(a, stream);
    await pull(b, stream);
    expect(b.db.prepare("SELECT status FROM brain_sticky_notes WHERE id = 'SN-001'").get()).toEqual(
      { status: 'archived' },
    );
    expect(
      b.db
        .prepare(
          "SELECT status, approver FROM tasks_playbook_approvals WHERE approval_id = 'appr-1'",
        )
        .get(),
    ).toEqual({ status: 'approved', approver: 'alice' });
    expect(contentChecksums(b.db)).toEqual(contentChecksums(a.db));
    expect(conflictKeys(b.db)).toEqual([]);
  });
});

describe('a rewound delete of a sealed NOT NULL secret restores it (T12535)', () => {
  it('a run deleted on A while B adds an approval under it rebases on A without losing the token', async () => {
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    const secretKey = secretValuesKey(randomBytes(32));
    const pushSealed = async (r: Replica) =>
      push(r, stream, await prepareSecretSeals(r.db, 'project', secretKey));
    const pullOpened = (r: Replica) =>
      pull(r, stream, () => prepareSecretOpens(r.db, 'project', STREAM, secretKey));
    write(
      a.db,
      `INSERT INTO tasks_playbook_runs (run_id, playbook_name, playbook_hash, started_at)
         VALUES ('run-1', 'rcasd', 'hash-1', '2026-10-14 17:42:00');
       INSERT INTO tasks_playbook_approvals (approval_id, run_id, node_id, token, requested_at)
         VALUES ('ap1', 'run-1', 'gate', 'tok-1', '2026-10-14 17:42:01');`,
    );
    await pushSealed(a);
    await pullOpened(b);
    // deletePlaybookRun on A; concurrently B adds a second approval to the run.
    write(
      a.db,
      `DELETE FROM tasks_playbook_approvals WHERE run_id = 'run-1';
       DELETE FROM tasks_playbook_runs WHERE run_id = 'run-1';`,
    );
    write(
      b.db,
      `INSERT INTO tasks_playbook_approvals (approval_id, run_id, node_id, token, requested_at)
         VALUES ('ap2', 'run-1', 'gate-2', 'tok-2', '2026-10-14 17:43:00');`,
    );
    await pushSealed(a);
    await pushSealed(b);
    // The pull rebases A: its delete of ap1 is rewound (ap1 re-inserted with
    // its token) and replayed. It used to throw NOT NULL on the token.
    await pullOpened(a);
    await pullOpened(b);
    for (const r of [a, b])
      expect(
        r.db
          .prepare("SELECT count(*) AS n FROM tasks_playbook_approvals WHERE approval_id = 'ap1'")
          .get(),
      ).toEqual({ n: 0 });
    expect(contentChecksums(b.db)).toEqual(contentChecksums(a.db));
  });
});

describe('a store moved through an unencrypted bundle keeps its unsent edits (T12535)', () => {
  for (const concurrent of [false, true])
    it(`A's offline edits reach B through C, and no redacted secret is overwritten${concurrent ? ' (B edits concurrently)' : ''}`, async () => {
      const { a, b } = await twoDevices();
      const stream = fakeStream();
      const secretKey = secretValuesKey(randomBytes(32));
      const pushSealed = async (r: Replica) =>
        push(r, stream, await prepareSecretSeals(r.db, 'project', secretKey));
      const pullOpened = (r: Replica) =>
        pull(r, stream, () => prepareSecretOpens(r.db, 'project', STREAM, secretKey));
      write(
        a.db,
        `INSERT INTO brain_sticky_notes (id, content, tags_json, created_at, updated_at) VALUES
           ('SN-100', 'v1', '[]', '2026-10-14 17:41:24', '2026-10-14 17:41:24'),
           ('SN-101', 'w1', '[]', '2026-10-14 17:41:25', '2026-10-14 17:41:25');
         INSERT INTO tasks_playbook_runs (run_id, playbook_name, playbook_hash, started_at)
           VALUES ('run-1', 'rcasd', 'hash-1', '2026-10-14 17:42:00');
         INSERT INTO tasks_playbook_approvals (approval_id, run_id, node_id, token, requested_at)
           VALUES ('ap1', 'run-1', 'gate', 'tok-1', '2026-10-14 17:42:01');`,
      );
      await pushSealed(a);
      await pullOpened(b);
      await pullOpened(a);
      // Offline on A, never sealed: an edit, an insert, and an approval decided
      // with a re-minted token (the secret column changed too).
      write(
        a.db,
        `UPDATE brain_sticky_notes SET content = 'A-offline-edit' WHERE id = 'SN-100';
         INSERT INTO brain_sticky_notes (id, content, tags_json, created_at, updated_at)
           VALUES ('SN-200', 'A-offline-new', '[]', '2026-10-14 18:00:00', '2026-10-14 18:00:00');
         UPDATE tasks_playbook_approvals SET status = 'approved', token = 'tok-1b' WHERE approval_id = 'ap1';`,
      );
      if (concurrent) {
        write(b.db, `UPDATE brain_sticky_notes SET content = 'B-edit-101' WHERE id = 'SN-101';`);
        await pushSealed(b);
      }
      const bundle = join(dir, 'move.cleobundle.tar.gz');
      await exportPortableBundle({
        scope: 'project',
        projectRoot: join(dir, 'a'),
        outputPath: bundle,
        label: 'move',
      });
      mkdirSync(join(dir, 'c'), { recursive: true });
      await importPortableBundle({
        bundlePath: bundle,
        target: join(dir, 'c'),
        cwd: join(dir, 'c'),
        force: true,
        cleoHome: join(dir, 'cleo'),
      });
      const c = await open('c', 'dev-a');
      // The copy reconcile (rule 1 reads the inherited live captures).
      mkdirSync(join(dir, 'scratch'), { recursive: true });
      const merged = getDualScopeNativeDb(
        await openDualScopeDbAtPath('project', join(dir, 'scratch', 'cleo.db'), undefined, {
          dedicated: true,
          syncMode: 'off',
        }),
      );
      setSyncFlag(merged, 'sync.pull', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
      const pulled = await pullStream(merged, {
        scope: 'project',
        stream: STREAM,
        replica: randomUUID(),
        pull: stream.pull,
        verify: () => null,
        initialCursor: START,
        now: () => ++clock,
        env: {},
        seal: () => {},
        openSecrets: () => prepareSecretOpens(merged, 'project', STREAM, secretKey),
      });
      expect(pulled.refused).toBeNull();
      reconcileCopy(c.db, merged, {
        scope: 'project',
        stream: STREAM,
        mergedCursor: readStreamCursor(merged, STREAM) ?? START,
        now: () => ++clock,
      });
      await pushSealed(c);
      await pullOpened(b);
      const notes = 'SELECT id, content FROM brain_sticky_notes ORDER BY id';
      const want = [
        { id: 'SN-100', content: 'A-offline-edit' },
        { id: 'SN-101', content: concurrent ? 'B-edit-101' : 'w1' },
        { id: 'SN-200', content: 'A-offline-new' },
      ];
      expect(b.db.prepare(notes).all()).toEqual(want);
      expect(c.db.prepare(notes).all()).toEqual(want);
      // The decision travels; the token the bundle redacted is never sent as
      // a NULL or empty value over B's.
      expect(
        b.db
          .prepare("SELECT status, token FROM tasks_playbook_approvals WHERE approval_id = 'ap1'")
          .get(),
      ).toEqual({ status: 'approved', token: 'tok-1' });
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
    // Segments carry no bytes (they travel as stream blobs, T13721): fetch
    // names the doc and says its content is missing, never a fabricated body.
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

  it('a pre-collapse store holding duplicate sha256 rows still fills: the duplicate keeps a NULL uid', async () => {
    const a = await open('a', 'dev-a');
    // Before the twin collapse dedupes them, the twin may hold one sha256 twice.
    dropCaptureTriggers(a.db);
    a.db.exec(`DROP INDEX IF EXISTS uniq_docs_attachments_sha256;
      INSERT INTO docs_attachments (id, sha256, attachment_json, created_at, ref_count)
        VALUES ('dup-1', '${SHA}', '${json(SHA)}', '2026-10-01T00:00:00.000Z', 1),
               ('dup-2', '${SHA}', '${json(SHA)}', '2026-10-02T00:00:00.000Z', 1);
      UPDATE docs_attachments SET uid = NULL;`);
    const report = prepareRowIdentity(a.db, 'project');
    expect(report?.filled.docs_attachments).toBe(1);
    expect(report?.unfilled.docs_attachments).toBe(1);
    expect(
      a.db.prepare('SELECT count(*) AS n FROM docs_attachments WHERE uid IS NOT NULL').get(),
    ).toEqual({ n: 1 });
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

  /**
   * A fake Nexus for doc bytes (T13721): presign/complete and the stream
   * attachment routes (E32/E33), blobs in memory. `routes: false` is a server
   * from before E32/E33: those paths answer 404 like any unknown route.
   */
  function attachmentServer(routes = true) {
    const blobs = new Map<string, Buffer>();
    const refs = new Map<string, { blobSha256: string; sizeBytes: number }>();
    const calls: string[] = [];
    /** E34 answers 403 while false (the caller is neither the recorder nor an owner). */
    const policy = { deleteAllowed: true, beforePut: (_ref: string) => {} };
    const reply = (data: unknown, status = 200) =>
      new Response(
        JSON.stringify(
          status === 200
            ? { success: true, data, meta: { requestId: 'r' } }
            : {
                success: false,
                error:
                  status === 403
                    ? { code: 'E_FORBIDDEN', message: 'not the recorder or an owner' }
                    : { code: 'E_NOT_FOUND', message: 'route not found' },
              },
        ),
        { status },
      );
    const http = new Http({
      baseUrl: 'https://nexus.test',
      token: 't',
      maxAttempts: 1,
      fetch: async (input, init) => {
        const path = input.replace('https://nexus.test', '');
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${path}`);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (method === 'POST' && path === '/v1/blobs/presign') {
          return reply({
            alreadyPresent: blobs.has(body.sha256),
            uploadUrl: `https://blob.test/${body.sha256}`,
            uploadHeaders: {},
            expiresAt: null,
          });
        }
        const done = /^\/v1\/blobs\/([0-9a-f]{64})\/complete$/.exec(path);
        if (method === 'POST' && done) return reply({ sha256: done[1], verified: true });
        const att = /\/attachments\/([0-9a-f]{64})$/.exec(path);
        if (!att || !routes) return reply(null, 404);
        const ref = att[1] ?? '';
        if (method === 'DELETE') {
          if (!policy.deleteAllowed) return reply(null, 403);
          return reply({ deleted: refs.delete(ref) });
        }
        if (method === 'PUT') {
          policy.beforePut(ref);
          const created = !refs.has(ref);
          if (created) refs.set(ref, body);
          return reply({ ...refs.get(ref), created });
        }
        const r = refs.get(ref);
        return reply({
          download: r
            ? {
                url: `https://blob.test/${r.blobSha256}`,
                sha256: r.blobSha256,
                sizeBytes: r.sizeBytes,
                expiresInSeconds: 300,
              }
            : null,
        });
      },
    });
    const key = randomKey();
    const journal = (r: Replica) =>
      new Journal({
        http,
        streamId: STREAM,
        replicaId: replicaOf(r),
        deviceId: r.device,
        signing: KEYS[r.device],
        key,
        uploader: async (url, _headers, bytes) => {
          blobs.set(url.slice(url.lastIndexOf('/') + 1), Buffer.from(bytes));
        },
        downloader: async (url) =>
          blobs.get(url.slice(url.lastIndexOf('/') + 1)) ?? Buffer.alloc(0),
      });
    /** Record `bytes` under the ref of `sha`, as a squatting writer (or a buggy client) would. */
    const squat = (sha: string, bytes: Buffer) => {
      const blobSha256 = createHash('sha256').update(bytes).digest('hex');
      blobs.set(blobSha256, bytes);
      const ref = hmacSha256(deriveKey(key, 'attachment-ref'), Buffer.from(sha)).toString('hex');
      refs.set(ref, { blobSha256, sizeBytes: bytes.length });
    };
    return { blobs, refs, calls, journal, policy, squat, key };
  }

  const docBytes = (r: Replica, name: string, warnings: CloudWarning[]) => ({
    stream: STREAM,
    cleoDir: join(dir, name, '.cleo'),
    warn: (w: CloudWarning) => {
      warnings.push(w);
    },
  });
  const blobFile = (name: string) => join(dir, name, '.cleo', 'blobs', 'blobs', SHA);

  it('a doc body added on A reaches B through the stream, encrypted, and fetch returns identical bytes (T13721)', async () => {
    const { a, b } = await docOnBoth();
    const server = attachmentServer();
    const warnings: CloudWarning[] = [];
    // A holds the body of one of its two docs: only that one goes up.
    expect(await pushDocBytes(a.db, server.journal(a), docBytes(a, 'a', warnings))).toEqual({
      moved: 1,
      refused: 0,
    });
    expect(server.blobs.size).toBe(1);
    for (const stored of server.blobs.values()) {
      expect(stored.includes(Buffer.from('Gate doc'))).toBe(false); // never plaintext
    }

    expect(await pullDocBytes(b.db, server.journal(b), docBytes(b, 'b', warnings))).toEqual({
      moved: 1,
      refused: 0,
    });
    const model = new DocsReadModel({ projectRoot: join(dir, 'b') });
    expect(await model.fetchDecoded('gate-doc')).toMatchObject({ ok: true, content: BODY });
    expect(readFileSync(blobFile('b'))).toEqual(readFileSync(blobFile('a')));

    // Dedup: neither device uploads the body again.
    const presigns = () => server.calls.filter((c) => c.endsWith('/v1/blobs/presign')).length;
    expect(await pushDocBytes(a.db, server.journal(a), docBytes(a, 'a', warnings))).toEqual({
      moved: 0,
      refused: 0,
    });
    expect(await pushDocBytes(b.db, server.journal(b), docBytes(b, 'b', warnings))).toEqual({
      moved: 0,
      refused: 0,
    });
    expect(presigns()).toBe(1);
    expect(warnings).toEqual([]);
  });

  it('a tampered or swapped doc blob is refused and nothing is written on B (T13721)', async () => {
    const { a, b } = await docOnBoth();
    const server = attachmentServer();
    const warnings: CloudWarning[] = [];
    await pushDocBytes(a.db, server.journal(a), docBytes(a, 'a', warnings));
    const [[blobSha, ciphertext]] = [...server.blobs.entries()] as Array<[string, Buffer]>;
    // One flipped byte: the ciphertext no longer matches its announced sha256.
    const flipped = Buffer.from(ciphertext);
    flipped[flipped.length - 1] = (flipped.at(-1) ?? 0) ^ 0xff;
    server.blobs.set(blobSha, flipped);
    expect(await pullDocBytes(b.db, server.journal(b), docBytes(b, 'b', warnings))).toEqual({
      moved: 0,
      refused: 1,
    });
    expect(existsSync(blobFile('b'))).toBe(false);
    // A delivery fault proves nothing about the record: it is kept.
    expect(server.refs.size).toBe(1);

    // A consistent swap (sha and size re-announced) fails the AEAD under the stream key.
    const swapped = Buffer.from(ciphertext);
    swapped[40] = (swapped[40] ?? 0) ^ 0x01;
    const swappedSha = createHash('sha256').update(swapped).digest('hex');
    server.blobs.set(swappedSha, swapped);
    for (const [ref, r] of server.refs) server.refs.set(ref, { ...r, blobSha256: swappedSha });
    expect(await pullDocBytes(b.db, server.journal(b), docBytes(b, 'b', warnings))).toEqual({
      moved: 0,
      refused: 1,
    });
    expect(existsSync(blobFile('b'))).toBe(false);
    // Content that matched its sha256 and still fails the AEAD is provably wrong: the record is cleared.
    expect(server.refs.size).toBe(0);
    expect(warnings.map((w) => w.code)).toEqual([
      'W_SYNC_DOC_BYTES_REFUSED',
      'W_SYNC_DOC_BYTES_REFUSED',
    ]);
    expect(warnings.map((w) => w.message).join('\n')).toMatch(/blob-hash[\s\S]*decrypt/);
    expect(
      await new DocsReadModel({ projectRoot: join(dir, 'b') }).fetchDecoded('gate-doc'),
    ).toMatchObject({ ok: false, reason: 'no-content' });
  });

  it('a squatted ref heals: B refuses the junk, A clears it and records the real bytes, B then fetches them (T13721)', async () => {
    const { a, b } = await docOnBoth();
    const server = attachmentServer();
    const warnings: CloudWarning[] = [];
    server.squat(SHA, Buffer.from('junk recorded first by a squatting writer'));

    expect(await pullDocBytes(b.db, server.journal(b), docBytes(b, 'b', warnings))).toEqual({
      moved: 0,
      refused: 1,
    });
    expect(existsSync(blobFile('b'))).toBe(false);

    // A holds the bytes: it checks the recorded blob, clears it (E34) and records its own.
    expect(await pushDocBytes(a.db, server.journal(a), docBytes(a, 'a', warnings))).toEqual({
      moved: 1,
      refused: 0,
    });
    expect(server.calls.filter((c) => c.startsWith('DELETE '))).toHaveLength(1);
    expect(await pullDocBytes(b.db, server.journal(b), docBytes(b, 'b', warnings))).toEqual({
      moved: 1,
      refused: 0,
    });
    expect(
      await new DocsReadModel({ projectRoot: join(dir, 'b') }).fetchDecoded('gate-doc'),
    ).toMatchObject({ ok: true, content: BODY });
    expect(warnings.map((w) => w.code)).toEqual(['W_SYNC_DOC_BYTES_REFUSED']);
  });

  it('a ref A may not clear, or a racer recorded first, stays contested and unmarked until it heals (T13721)', async () => {
    const { a } = await docOnBoth();
    const server = attachmentServer();
    const warnings: CloudWarning[] = [];
    const run = () => pushDocBytes(a.db, server.journal(a), docBytes(a, 'a', warnings));

    // Squatted by another user, and A is not an owner: E34 is 403.
    server.squat(SHA, Buffer.from('junk'));
    server.policy.deleteAllowed = false;
    expect(await run()).toEqual({ moved: 0, refused: 0 });

    // L1: cleared now, but a racer records first: created false names another blob.
    server.policy.deleteAllowed = true;
    server.policy.beforePut = (ref) => {
      server.policy.beforePut = () => {};
      server.refs.set(ref, { blobSha256: 'f'.repeat(64), sizeBytes: 99 });
    };
    expect(await run()).toEqual({ moved: 0, refused: 0 });
    expect(warnings.map((w) => w.code)).toEqual([
      'W_SYNC_DOC_BYTES_CONTESTED',
      'W_SYNC_DOC_BYTES_CONTESTED',
    ]);

    // Neither run marked the body sent, so the next one checks the racer's junk and heals.
    server.blobs.set('f'.repeat(64), Buffer.alloc(99));
    expect(await run()).toEqual({ moved: 1, refused: 0 });
    expect(await run()).toEqual({ moved: 0, refused: 0 });
  });

  it("a record cleared after A marked it sent is re-recorded by A's re-check (T13721)", async () => {
    const { a, b } = await docOnBoth();
    const server = attachmentServer();
    const warnings: CloudWarning[] = [];
    await pushDocBytes(a.db, server.journal(a), docBytes(a, 'a', warnings));
    // An owner clears the good record, then a squatter records junk before A looks again.
    server.refs.clear();
    server.squat(SHA, Buffer.from('junk after the clear'));
    // B refuses it and clears the junk (it may); A's next push re-checks, finds no record, records again.
    expect(await pullDocBytes(b.db, server.journal(b), docBytes(b, 'b', warnings))).toEqual({
      moved: 0,
      refused: 1,
    });
    expect(server.refs.size).toBe(0);
    expect(await pushDocBytes(a.db, server.journal(a), docBytes(a, 'a', warnings))).toEqual({
      moved: 1,
      refused: 0,
    });
    expect(await pullDocBytes(b.db, server.journal(b), docBytes(b, 'b', warnings))).toEqual({
      moved: 1,
      refused: 0,
    });
    expect(readFileSync(blobFile('b'), 'utf8')).toBe(BODY);
  });

  it('more than a run of byte-less rows ahead of a real doc never starve it: the cursor moves on (T13721)', async () => {
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    for (const r of [a, b]) uniqueDocIndexes(r.db);
    // 120 docs no device holds bytes for, every sha sorting before the real one.
    const empty = Array.from({ length: 120 }, (_, i) => `00${i.toString(16).padStart(62, '0')}`);
    expect(empty.every((x) => x < SHA)).toBe(true);
    const at = new Date(++clockMs).toISOString();
    write(
      a.db,
      empty
        .map(
          (x, i) =>
            `INSERT INTO docs_attachments (id, sha256, attachment_json, created_at, ref_count) VALUES ('e-${i}', '${x}', '${json(x)}', '${at}', 0);`,
        )
        .join('\n'),
    );
    addDoc(a.db, 'doc-1', SHA, 'gate-doc', 'T1');
    mkdirSync(join(dir, 'a', '.cleo', 'blobs', 'blobs'), { recursive: true });
    writeFileSync(join(dir, 'a', '.cleo', 'blobs', 'blobs', SHA), BODY);
    await push(a, stream);
    await pull(b, stream);
    const server = attachmentServer();
    const warnings: CloudWarning[] = [];
    expect(await pushDocBytes(a.db, server.journal(a), docBytes(a, 'a', warnings))).toEqual({
      moved: 1,
      refused: 0,
    });
    const gets = () => server.calls.filter((c) => c.startsWith('GET ')).length;
    const before = gets();
    // Run one spends its 100 attempts on byte-less rows; run two resumes after them.
    expect(await pullDocBytes(b.db, server.journal(b), docBytes(b, 'b', warnings))).toEqual({
      moved: 0,
      refused: 0,
    });
    expect(gets() - before).toBe(100);
    expect(await pullDocBytes(b.db, server.journal(b), docBytes(b, 'b', warnings))).toEqual({
      moved: 1,
      refused: 0,
    });
    expect(readFileSync(blobFile('b'), 'utf8')).toBe(BODY);
    // Each run stays inside its budget (run two wraps around once it passes the real doc).
    expect(gets() - before).toBe(200);
  });

  it('a body over the pull cap never loops: B refuses it without clearing, and a capped holder never sends it (T13721)', async () => {
    const { a, b } = await docOnBoth();
    const server = attachmentServer();
    const warnings: CloudWarning[] = [];
    const capped = (r: Replica, name: string) => ({ ...docBytes(r, name, warnings), maxBytes: 50 });
    // A holder without the cap uploaded it (BODY + overhead is over 50 bytes).
    await pushDocBytes(a.db, server.journal(a), docBytes(a, 'a', warnings));
    for (let cycle = 0; cycle < 3; cycle++) {
      expect(await pullDocBytes(b.db, server.journal(b), capped(b, 'b'))).toEqual({
        moved: 0,
        refused: 1,
      });
      await pushDocBytes(a.db, server.journal(a), docBytes(a, 'a', warnings));
    }
    expect(server.refs.size).toBe(1);
    expect(server.calls.filter((c) => c.startsWith('DELETE '))).toHaveLength(0);
    expect(server.calls.filter((c) => c.endsWith('/v1/blobs/presign'))).toHaveLength(1);
    expect(warnings.every((w) => w.message.includes('too-large'))).toBe(true);

    // A holder with the same cap never sends it, and says so once per run.
    const fresh = attachmentServer();
    const quiet: CloudWarning[] = [];
    expect(
      await pushDocBytes(a.db, fresh.journal(a), {
        ...docBytes(a, 'a', quiet),
        stream: `${STREAM}-capped`,
        maxBytes: 50,
      }),
    ).toEqual({ moved: 0, refused: 0 });
    expect(fresh.calls).toEqual([]);
    expect(quiet.map((w) => w.code)).toEqual(['W_SYNC_DOC_BYTES_TOO_LARGE']);
  });

  it('a recorded blob that cannot be checked holds up only itself: the push moves on to the next doc (T13721)', async () => {
    const { a } = await docOnBoth();
    const server = attachmentServer();
    const warnings: CloudWarning[] = [];
    const NEXT = `${BODY}v2\n`;
    writeFileSync(join(dir, 'a', '.cleo', 'blobs', 'blobs', NEXT_SHA), NEXT);
    // The doc that sorts first is recorded with a blob of the right size whose stored bytes are
    // damaged (a delivery fault: the download misses its announced sha256).
    const [first, firstLen] = SHA < NEXT_SHA ? [SHA, BODY.length] : [NEXT_SHA, NEXT.length];
    const [second] = SHA < NEXT_SHA ? [NEXT_SHA] : [SHA];
    server.squat(first, Buffer.alloc(firstLen + 61, 1));
    for (const r of server.refs.values()) {
      server.blobs.set(r.blobSha256, Buffer.alloc(firstLen + 61, 2));
    }
    const refOf = (x: string) =>
      hmacSha256(deriveKey(server.key, 'attachment-ref'), Buffer.from(x)).toString('hex');
    for (let run = 0; run < 3; run++) {
      await pushDocBytes(a.db, server.journal(a), docBytes(a, 'a', warnings));
    }
    // The second doc was recorded on the first run; the first stays recorded, never cleared.
    expect(server.refs.has(refOf(second))).toBe(true);
    expect(server.refs.has(refOf(first))).toBe(true);
    expect(server.calls.filter((c) => c.startsWith('DELETE '))).toHaveLength(0);
    expect(server.calls.filter((c) => c.endsWith('/v1/blobs/presign'))).toHaveLength(1);
    expect(warnings.map((w) => w.code)).toEqual([
      'W_SYNC_DOC_BYTES_UNVERIFIED',
      'W_SYNC_DOC_BYTES_UNVERIFIED',
      'W_SYNC_DOC_BYTES_UNVERIFIED',
    ]);
  });

  it('a server without the attachment routes: rows still sync, fetch is no-content, one warning says why (T13721)', async () => {
    const { a, b } = await docOnBoth();
    const server = attachmentServer(false);
    const warnings: CloudWarning[] = [];
    expect(await pushDocBytes(a.db, server.journal(a), docBytes(a, 'a', warnings))).toEqual({
      moved: 0,
      refused: 0,
    });
    // It asked first, so nothing was uploaded for a route that is not there.
    expect(server.calls.some((c) => c.includes('/v1/blobs/'))).toBe(false);
    expect(await pullDocBytes(b.db, server.journal(b), docBytes(b, 'b', warnings))).toEqual({
      moved: 0,
      refused: 0,
    });
    expect(warnings.map((w) => w.code)).toEqual([
      'W_SYNC_DOC_BYTES_UNAVAILABLE',
      'W_SYNC_DOC_BYTES_UNAVAILABLE',
    ]);
    expect(warnings[0]?.message).toContain('does not carry doc bytes yet');
    const model = new DocsReadModel({ projectRoot: join(dir, 'b') });
    expect((await model.listProjectDocs()).map((d) => d.slug)).toContain('gate-doc');
    expect(await model.fetchDecoded('gate-doc')).toMatchObject({ ok: false, reason: 'no-content' });
  });
});

describe('legacy-format timestamps echo without conflicts (T13714)', () => {
  it("A's own echo of brain rows with 'YYYY-MM-DD HH:MM:SS' text records no conflict, and both devices list the same set", async () => {
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    write(
      a.db,
      `INSERT INTO brain_observations (id, type, title, created_at, updated_at) VALUES
         ('O-t13714', 'discovery', 'legacy stamps', '2026-10-14 17:30:00', '2026-10-14 17:30:00');
       INSERT INTO brain_page_nodes (id, node_type, label, created_at, updated_at, last_activity_at)
         VALUES ('task:T13714', 'task', 'T13714', '2026-10-14 17:30:00', '2026-10-14 17:30:00', '2026-10-14 17:30:00');`,
    );
    await push(a, stream);
    await pull(b, stream);
    await pull(a, stream); // own echo of the inserts
    // A command stamps the rows with SQLite's datetime('now') text.
    write(
      a.db,
      `UPDATE brain_observations SET title = 'stamped', updated_at = '2026-10-14 17:32:57' WHERE id = 'O-t13714';
       UPDATE brain_page_nodes SET updated_at = '2026-10-14 17:39:30', last_activity_at = '2026-10-14 17:39:30'
         WHERE id = 'task:T13714';`,
    );
    await push(a, stream);
    await pull(a, stream); // own echo of the updates
    await pull(b, stream);

    expect(conflictKeys(a.db)).toEqual([]);
    expect(conflictKeys(b.db)).toEqual(conflictKeys(a.db));
    // A keeps its local text; B holds the canonical wire form of the same instant.
    expect(
      a.db.prepare("SELECT updated_at FROM brain_observations WHERE id = 'O-t13714'").get(),
    ).toEqual({ updated_at: '2026-10-14 17:32:57' });
    expect(
      b.db.prepare("SELECT updated_at FROM brain_observations WHERE id = 'O-t13714'").get(),
    ).toEqual({ updated_at: '2026-10-14T17:32:57.000Z' });
  });
});

describe('brain ops reach a joiner that never opened brain (T13719)', () => {
  const hasColumn = (db: DatabaseSync, table: string, column: string): boolean =>
    (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).some(
      (c) => c.name === column,
    );
  const LAZY = ['network', 'prune_candidate'] as const;
  const OBS = 'id, title, narrative, network';

  it('the genesis cut and the pull bring the brain schema current; both converge with nothing pending', async () => {
    // A cuts genesis without ever binding the brain domain.
    const a = await open('a', 'dev-a');
    for (const c of LAZY) expect(hasColumn(a.db, 'brain_observations', c), c).toBe(false);
    const cut = await cutGenesisWithSnapshot(
      a.db,
      {
        scope: 'project',
        stream: STREAM,
        dbPath: join(dir, 'a', '.cleo', 'cleo.db'),
        now: () => ++clock,
        env: {},
        allowUnreleased: true,
      },
      async () => {},
    );
    expect(cut.refused).toBeNull();
    for (const c of LAZY) expect(hasColumn(a.db, 'brain_observations', c), c).toBe(true);
    completeGenesis(a.db, {
      stream: STREAM,
      replica: replicaOf(a),
      replicaSeqFloor: null,
      nowIso: new Date(++clock).toISOString(),
    });

    // B joins; it never binds brain either.
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
    for (const c of LAZY) expect(hasColumn(b.db, 'brain_observations', c), c).toBe(false);

    const stream = fakeStream();
    write(
      a.db,
      `INSERT INTO brain_observations (id, type, title, narrative, created_at, valid_at, network, prune_candidate)
       VALUES ('O-t13719', 'discovery', 'joiner sees it', 'first', '2026-10-14T09:00:00.000Z',
               '2026-10-14 09:00:00', 'world', 1)`,
    );
    write(a.db, "UPDATE brain_observations SET title = 'retitled on A' WHERE id = 'O-t13719'");
    await push(a, stream);
    const pulled = await pull(b, stream);
    expect(pulled.apply).toMatchObject({ refusedSchema: 0, pending: 0 });
    expect(inboxCounts(b.db, STREAM)).not.toHaveProperty('refused-schema');
    expect(inboxCounts(b.db, STREAM)).not.toHaveProperty('pending');
    const row = (db: DatabaseSync) =>
      db.prepare(`SELECT ${OBS} FROM brain_observations WHERE id = 'O-t13719'`).get();
    expect(row(b.db)).toEqual({
      id: 'O-t13719',
      title: 'retitled on A',
      narrative: 'first',
      network: 'world',
    });
    expect(row(b.db)).toEqual(row(a.db));
    // prune_candidate is local-only: B has the column, A's flag never travels.
    expect(
      b.db.prepare("SELECT prune_candidate FROM brain_observations WHERE id = 'O-t13719'").get(),
    ).toEqual({ prune_candidate: 0 });
    await pull(a, stream); // own echo
    expect(contentChecksums(b.db).brain_observations).toBe(
      contentChecksums(a.db).brain_observations,
    );
  });
});

describe('lifecycle, release, PR and commit rows reach a second device (T12914)', () => {
  const TABLES = [
    'tasks_lifecycle_pipelines',
    'tasks_lifecycle_stages',
    'tasks_lifecycle_gate_results',
    'tasks_lifecycle_evidence',
    'tasks_lifecycle_transitions',
    'tasks_releases',
    'tasks_release_commits',
    'tasks_release_changes',
    'tasks_release_changesets',
    'tasks_release_artifacts',
    'tasks_pull_requests',
    'tasks_pr_commits',
    'tasks_pr_tasks',
    'tasks_commits',
    'tasks_commit_files',
    'tasks_task_commits',
  ];
  const AT = '2026-10-15T10:00:00.000Z';
  const SHA = 'a'.repeat(40);
  const count = (db: DatabaseSync, t: string) =>
    (db.prepare(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }).n;
  const pick = (s: Record<string, string>) => TABLES.map((t) => [t, s[t] ?? null]);
  const conflictsOf = (db: DatabaseSync, kind: string) =>
    listConflicts(db, { stream: STREAM }).filter(
      (c) => TABLES.includes(c.table) && c.kind === kind,
    );
  /** A release row as plan writes it: the id embeds this device's project hash. */
  const releaseSql = (hash: string, version: string) =>
    `INSERT INTO tasks_releases (id, version, status, planned_at, created_at)
       VALUES ('${hash}:${version}', '${version}', 'planned', '${AT}', '${AT}');`;
  const releaseOf = (db: DatabaseSync, version: string) =>
    db
      .prepare('SELECT id, uid, status, pushed_at FROM tasks_releases WHERE version = ?')
      .get(version) as { id: string; uid: string; status: string; pushed_at: string | null };
  /** Every release child, with its release named by version (ids differ per device). */
  const releaseChildren = (db: DatabaseSync) =>
    db
      .prepare(
        `SELECT 'commit' AS k, r.version, c.commit_sha AS v, c.uid FROM tasks_release_commits c
           LEFT JOIN tasks_releases r ON r.id = c.release_id
         UNION ALL
         SELECT 'changeset', r.version, s.changeset_id, s.uid FROM tasks_release_changesets s
           LEFT JOIN tasks_releases r ON r.id = s.release_id
         ORDER BY 1, 3`,
      )
      .all();

  /** One of every row of the 16 tables, written on A as the CLI writes them. */
  function seedAll(db: DatabaseSync) {
    write(
      db,
      `INSERT INTO tasks_lifecycle_pipelines (id, task_id, status, started_at, updated_at)
         VALUES ('pipeline-T1', 'T1', 'active', '${AT}', '${AT}');
       INSERT INTO tasks_lifecycle_stages (id, pipeline_id, stage_name, status, sequence, started_at)
         VALUES ('stage-T1-research', 'pipeline-T1', 'research', 'completed', 1, '${AT}'),
                ('stage-T1-consensus', 'pipeline-T1', 'consensus', 'in_progress', 2, '${AT}');
       INSERT INTO tasks_lifecycle_gate_results (id, stage_id, gate_name, result, checked_at, checked_by)
         VALUES ('gate-T1-research-research-done', 'stage-T1-research', 'research-done', 'pass', '${AT}', 'agent');
       INSERT INTO tasks_lifecycle_evidence (id, stage_id, uri, type, recorded_at)
         VALUES ('evidence-T1-research-1', 'stage-T1-research', 'docs/r.md', 'file', '${AT}');
       INSERT INTO tasks_lifecycle_transitions (id, pipeline_id, from_stage_id, to_stage_id, transition_type, created_at)
         VALUES ('transition-1', 'pipeline-T1', 'stage-T1-research', 'stage-T1-consensus', 'manual', '${AT}');
       INSERT INTO tasks_commits (sha, short_sha, authored_at, committed_at, message, subject, created_at)
         VALUES ('${SHA}', 'aaaaaaa', '${AT}', '${AT}', 'feat: x', 'feat: x', '${AT}');
       INSERT INTO tasks_commit_files (commit_sha, path, change_type) VALUES ('${SHA}', 'src/x.ts', 'M');
       INSERT INTO tasks_task_commits (task_id, commit_sha, link_kind, link_source, created_at)
         VALUES ('T1', '${SHA}', 'implements', 'commit-subject', '${AT}');
       INSERT INTO tasks_pull_requests (id, pr_number, repo_url, title, state, base_ref, head_ref, opened_at, created_at, updated_at)
         VALUES ('hashA:7', 7, 'https://github.com/o/r', 'feat', 'merged', 'main', 'feat/T1', '${AT}', '${AT}', '${AT}');
       INSERT INTO tasks_pr_commits (pr_id, commit_sha, position) VALUES ('hashA:7', '${SHA}', 0);
       INSERT INTO tasks_pr_tasks (pr_id, task_id, link_source, link_kind, created_at)
         VALUES ('hashA:7', 'T1', 'pr-title', 'implements', '${AT}');
       ${releaseSql('hashA', 'v2026.10.1')}
       INSERT INTO tasks_release_commits (release_id, commit_sha, position) VALUES ('hashA:v2026.10.1', '${SHA}', 0);
       INSERT INTO tasks_release_changes (id, release_id, task_id, change_type, summary, classified_at)
         VALUES ('chg-1', 'hashA:v2026.10.1', 'T1', 'feature', 'x', '${AT}');
       INSERT INTO tasks_release_changesets (id, release_id, changeset_id, task_ids, kind, summary, created_at)
         VALUES ('cs-a', 'hashA:v2026.10.1', 't1-x', '["T1"]', 'feat', 'x', '${AT}');
       INSERT INTO tasks_release_artifacts (release_id, artifact_type, identifier, version)
         VALUES ('hashA:v2026.10.1', 'npm', '@o/x', 'v2026.10.1');`,
    );
  }

  it('every table travels with its uid; B holds the same rows, and a release takes its uid as its local id', async () => {
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    seedAll(a.db);
    await push(a, stream);
    await pull(b, stream);
    await pull(a, stream); // own echo
    const ones = TABLES.map((t) => (t === 'tasks_lifecycle_stages' ? 2 : 1));
    expect(TABLES.map((t) => count(a.db, t))).toEqual(ones);
    expect(TABLES.map((t) => count(b.db, t))).toEqual(ones);
    expect(pick(contentChecksums(b.db))).toEqual(pick(contentChecksums(a.db)));
    const atB = releaseOf(b.db, 'v2026.10.1');
    expect(atB.id).toBe(atB.uid);
    expect(atB.uid).toBe(releaseOf(a.db, 'v2026.10.1').uid);
    expect(releaseChildren(b.db)).toEqual(releaseChildren(a.db));
    expect(conflictKeys(a.db)).toEqual([]);
    expect(conflictKeys(b.db)).toEqual([]);
  });

  it('the same release planned on both devices under different ids is one row; both changesets survive the UNIQUE version index', async () => {
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    const uniqueVersion = (db: DatabaseSync) =>
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'uq_tasks_releases_version'",
        )
        .get();
    for (const r of [a, b])
      expect(uniqueVersion(r.db)).toEqual({ name: 'uq_tasks_releases_version' });
    write(
      a.db,
      `${releaseSql('hashA', 'v2026.10.2')}
       INSERT INTO tasks_release_changesets (id, release_id, changeset_id, task_ids, kind, summary, created_at)
         VALUES ('cs-a', 'hashA:v2026.10.2', 't1-a', '["T1"]', 'feat', 'from A', '${AT}');`,
    );
    write(
      b.db,
      `${releaseSql('hashB', 'v2026.10.2')}
       INSERT INTO tasks_release_changesets (id, release_id, changeset_id, task_ids, kind, summary, created_at)
         VALUES ('cs-b', 'hashB:v2026.10.2', 't2-b', '["T2"]', 'fix', 'from B', '${AT}');`,
    );
    await push(a, stream);
    await push(b, stream);
    await pull(a, stream);
    await pull(b, stream);
    for (const r of [a, b]) {
      expect(count(r.db, 'tasks_releases')).toBe(1);
      expect(conflictsOf(r.db, 'guard')).toEqual([]);
      expect(conflictsOf(r.db, 'dangling-ref')).toEqual([]);
    }
    // Each device keeps its own local id for its own row.
    expect(releaseOf(a.db, 'v2026.10.2').id).toBe('hashA:v2026.10.2');
    expect(releaseOf(b.db, 'v2026.10.2').id).toBe('hashB:v2026.10.2');
    expect(releaseOf(b.db, 'v2026.10.2').uid).toBe(releaseOf(a.db, 'v2026.10.2').uid);
    const children = releaseChildren(a.db) as Array<{ version: string; v: string }>;
    expect(children.map((c) => [c.version, c.v])).toEqual([
      ['v2026.10.2', 't1-a'],
      ['v2026.10.2', 't2-b'],
    ]);
    expect(releaseChildren(b.db)).toEqual(children);
  });

  it('the same PR reconciled on both devices under different ids is one PR and one task link (#2282 review)', async () => {
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    const prSql = (hash: string) =>
      `INSERT INTO tasks_pull_requests (id, pr_number, repo_url, title, state, base_ref, head_ref, opened_at, created_at, updated_at)
         VALUES ('${hash}:7', 7, 'https://github.com/o/r', 'feat', 'merged', 'main', 'feat/T1', '${AT}', '${AT}', '${AT}');
       INSERT INTO tasks_pr_tasks (pr_id, task_id, link_source, link_kind, created_at)
         VALUES ('${hash}:7', 'T1', 'pr-title', 'implements', '${AT}');`;
    write(a.db, prSql('hashA'));
    write(b.db, prSql('hashB'));
    await push(a, stream);
    await push(b, stream);
    await pull(a, stream);
    await pull(b, stream);
    const links = (db: DatabaseSync) =>
      db
        .prepare(
          `SELECT p.pr_number, p.uid, t.task_id, t.uid AS link FROM tasks_pr_tasks t
             JOIN tasks_pull_requests p ON p.id = t.pr_id`,
        )
        .all();
    for (const r of [a, b]) {
      expect([count(r.db, 'tasks_pull_requests'), count(r.db, 'tasks_pr_tasks')]).toEqual([1, 1]);
      expect(conflictsOf(r.db, 'guard')).toEqual([]);
    }
    expect(links(b.db)).toEqual(links(a.db));
    // Each device keeps its own local id for its own PR.
    expect(a.db.prepare('SELECT id FROM tasks_pull_requests').get()).toEqual({ id: 'hashA:7' });
    expect(b.db.prepare('SELECT id FROM tasks_pull_requests').get()).toEqual({ id: 'hashB:7' });
  });

  it('the same release change reconciled on both devices under different ids is one row (#2282 review)', async () => {
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    const changeSql = (hash: string, id: string) =>
      `${releaseSql(hash, 'v2026.10.4')}
       INSERT INTO tasks_release_changes (id, release_id, task_id, change_type, summary, classified_at)
         VALUES ('${id}', '${hash}:v2026.10.4', 'T1', 'feature', 'x', '${AT}');`;
    // reconcile's id is a hash over the device-local release id.
    write(a.db, changeSql('hashA', 'chg-hash-a'));
    write(b.db, changeSql('hashB', 'chg-hash-b'));
    await push(a, stream);
    await push(b, stream);
    await pull(a, stream);
    await pull(b, stream);
    const changes = (db: DatabaseSync) =>
      db
        .prepare(
          `SELECT r.version, c.task_id, c.change_type, c.uid FROM tasks_release_changes c
             JOIN tasks_releases r ON r.id = c.release_id`,
        )
        .all();
    for (const r of [a, b]) {
      expect(count(r.db, 'tasks_release_changes')).toBe(1);
      expect(conflictsOf(r.db, 'guard')).toEqual([]);
    }
    expect(changes(b.db)).toEqual(changes(a.db));
  });

  it('a NULL task id keeps a change or PR link local: two of them never fold into one uid (#2282 review)', async () => {
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    const sqlFor = (hash: string, gone: string) =>
      `${releaseSql(hash, 'v2026.10.5')}
       INSERT INTO tasks_release_changes (id, release_id, task_id, change_type, summary, classified_at) VALUES
         ('chg-null-${hash}', '${hash}:v2026.10.5', NULL, 'feature', '${gone}: gone', '${AT}'),
         ('chg-t1-${hash}', '${hash}:v2026.10.5', 'T1', 'feature', 'T1: kept', '${AT}');
       INSERT INTO tasks_pull_requests (id, pr_number, repo_url, title, state, base_ref, head_ref, opened_at, created_at, updated_at)
         VALUES ('${hash}:8', 8, 'https://github.com/o/r', 'feat', 'merged', 'main', 'feat/x', '${AT}', '${AT}', '${AT}');
       INSERT INTO tasks_pr_tasks (pr_id, task_id, link_source, link_kind, created_at)
         VALUES ('${hash}:8', NULL, 'pr-body', 'implements', '${AT}');`;
    write(a.db, sqlFor('hashA', 'T5'));
    write(b.db, sqlFor('hashB', 'T6'));
    await push(a, stream);
    await push(b, stream);
    await pull(a, stream);
    await pull(b, stream);
    const nullRows = (db: DatabaseSync) => [
      db.prepare('SELECT summary, uid FROM tasks_release_changes WHERE task_id IS NULL').all(),
      db.prepare('SELECT uid FROM tasks_pr_tasks WHERE task_id IS NULL').all(),
    ];
    // Each device keeps its own local row, without a uid; nothing overwrote it.
    expect(nullRows(a.db)).toEqual([[{ summary: 'T5: gone', uid: null }], [{ uid: null }]]);
    expect(nullRows(b.db)).toEqual([[{ summary: 'T6: gone', uid: null }], [{ uid: null }]]);
    for (const r of [a, b]) {
      // The rows with a task id still sync as one row, and nothing is pending.
      expect(
        r.db.prepare("SELECT count(*) AS n FROM tasks_release_changes WHERE task_id = 'T1'").get(),
      ).toEqual({ n: 1 });
      expect(count(r.db, 'tasks_pull_requests')).toBe(1);
      expect(inboxCounts(r.db, STREAM)).not.toHaveProperty('pending');
      expect(conflictsOf(r.db, 'guard')).toEqual([]);
      // The local rows were never captured, so nothing waits on a missing uid.
      expect(
        r.db.prepare('SELECT count(*) AS n FROM _sync_capture WHERE uid IS NULL').get(),
      ).toEqual({ n: 0 });
    }
  });

  it('a concurrent status change converges on the shipped status (release.status.absorbing)', async () => {
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    write(a.db, releaseSql('hashA', 'v2026.10.3'));
    await push(a, stream);
    await pull(b, stream);
    await pull(a, stream);
    const pushedAt = new Date(++clock).toISOString();
    write(
      a.db,
      `UPDATE tasks_releases SET status = 'pushed', pushed_at = '${pushedAt}' WHERE version = 'v2026.10.3'`,
    );
    await push(a, stream);
    // B, offline, cancels the release; its op carries the later HLC.
    const cancelledAt = new Date(++clock).toISOString();
    write(
      b.db,
      `UPDATE tasks_releases SET status = 'cancelled', cancelled_at = '${cancelledAt}' WHERE version = 'v2026.10.3'`,
    );
    await push(b, stream);
    await pull(a, stream);
    await pull(b, stream);
    for (const r of [a, b]) {
      expect(releaseOf(r.db, 'v2026.10.3')).toMatchObject({
        status: 'pushed',
        pushed_at: pushedAt,
      });
    }
    const rules = [a, b].flatMap((r) => conflictsOf(r.db, 'typed-rule').map((c) => c.rule));
    expect(rules).toContain('release.status.absorbing');
  });

  it('a child added on B while A deletes its parent is never lost silently: both record a revivable dangling ref, no orphan', async () => {
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    seedAll(a.db);
    await push(a, stream);
    await pull(b, stream);
    await pull(a, stream);
    // A cancels the release as cancelRelease does (children first, while the
    // release exists) and deletes the pipeline (its rows cascade, with ops).
    const atA = releaseOf(a.db, 'v2026.10.1').id;
    write(
      a.db,
      `DELETE FROM tasks_release_commits WHERE release_id = '${atA}';
       DELETE FROM tasks_release_changes WHERE release_id = '${atA}';
       DELETE FROM tasks_release_changesets WHERE release_id = '${atA}';
       DELETE FROM tasks_release_artifacts WHERE release_id = '${atA}';
       DELETE FROM tasks_releases WHERE id = '${atA}';
       DELETE FROM tasks_lifecycle_pipelines WHERE id = 'pipeline-T1';`,
    );
    await push(a, stream);
    // B, offline, adds a commit to the release and a gate result to a stage.
    const local = releaseOf(b.db, 'v2026.10.1').id;
    write(
      b.db,
      `INSERT INTO tasks_release_commits (release_id, commit_sha, position) VALUES ('${local}', '${'b'.repeat(40)}', 1);
       INSERT INTO tasks_lifecycle_gate_results (id, stage_id, gate_name, result, checked_at, checked_by)
         VALUES ('gate-T1-research-late', 'stage-T1-research', 'late', 'pass', '${AT}', 'agent');`,
    );
    await push(b, stream);
    await pull(a, stream);
    await pull(b, stream);
    const orphans = (db: DatabaseSync) =>
      db
        .prepare(
          `SELECT
             (SELECT count(*) FROM tasks_release_commits c WHERE NOT EXISTS (SELECT 1 FROM tasks_releases r WHERE r.id = c.release_id))
           + (SELECT count(*) FROM tasks_lifecycle_gate_results g WHERE NOT EXISTS (SELECT 1 FROM tasks_lifecycle_stages s WHERE s.id = g.stage_id)) AS n`,
        )
        .get();
    for (const r of [a, b]) expect(orphans(r.db)).toEqual({ n: 0 });
    // Both converge on the deletes, and on both the late children are voided
    // with a recorded, revivable dangling-ref conflict: never dropped silently.
    expect(TABLES.map((t) => count(b.db, t))).toEqual(TABLES.map((t) => count(a.db, t)));
    expect(count(b.db, 'tasks_releases')).toBe(0);
    for (const r of [a, b]) {
      expect(
        conflictsOf(r.db, 'dangling-ref')
          .map((c) => [c.table, c.resolution])
          .sort(),
      ).toEqual([
        ['tasks_lifecycle_gate_results', 'op-voided'],
        ['tasks_release_commits', 'op-voided'],
      ]);
      expect(conflictsOf(r.db, 'guard')).toEqual([]);
    }
  });
});
