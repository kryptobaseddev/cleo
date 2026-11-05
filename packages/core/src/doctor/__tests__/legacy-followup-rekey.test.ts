/**
 * Legacy `T-RECONCILE-FOLLOWUP-*` rows are re-keyed through the journal
 * re-mint path (T14324): a dry run lists each row with its planned `T####`
 * and writes nothing; `--fix` snapshots first, renames the row and its
 * references, keeps the old id as a display-id alias, and writes one receipt
 * per row. A second device that synced the old row follows the rename and
 * keeps one row, not two.
 *
 * @task T14324
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { LedgerActor, LedgerOp, type LedgerTxn } from '@cleocode/contracts/ledger';
import { SYNC_SCHEMA_VERSION } from '@cleocode/contracts/sync-schema.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveDisplayId } from '../../store/display-id-alias.js';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../../store/dual-scope-db.js';
import type { SnapshotGateResult } from '../../store/snapshot-gate.js';
import { applyStagedTxns } from '../../store/sync/apply/applier.js';
import {
  finishCaptureFrame,
  openCaptureFrame,
  setCaptureEnabled,
} from '../../store/sync/capture.js';
import { remintDisplayKey } from '../../store/sync/collision-settle.js';
import { setSyncFlag } from '../../store/sync/flags.js';
import { stageTxns } from '../../store/sync/inbox.js';
import { sealPending } from '../../store/sync/sealer.js';
import { FOLLOWUP_REKEY_AUDIT_FILE, rekeyLegacyFollowUps } from '../legacy-followup-rekey.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../migrations/sync-journal');
const STREAM = 'project:t14324-followup-rekey';
const RA = '0192aaaa-7f00-7000-8000-00000000000a';
const RB = '0192bbbb-7f00-7000-8000-00000000000b';
const LEGACY = 'T-RECONCILE-FOLLOWUP-v2026.5.63-6';
const SNAPSHOT_OK: SnapshotGateResult = {
  snapshotted: ['tasks'],
  linked: [],
  absent: [],
  failed: [],
  skipped: null,
};
let clock = Date.now();
let dir: string;
let published: Array<{ replicaId: string; txns: LedgerTxn[] }>;
const sent = new Map<string, Set<string>>();

interface Replica {
  readonly db: DatabaseSync;
  readonly id: string;
  readonly root: string;
  cursor: number;
}

beforeEach(() => {
  published = [];
  sent.clear();
  dir = mkdtempSync(join(tmpdir(), 'cleo-followup-rekey-'));
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

async function replica(id: string): Promise<Replica> {
  const root = join(dir, id.slice(4, 8));
  const path = join(root, '.cleo', 'cleo.db');
  mkdirSync(join(path, '..'), { recursive: true });
  const db = getDualScopeNativeDb(await openDualScopeDbAtPath('project', path));
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  setSyncFlag(db, 'sync.seal', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  return { db, id, root, cursor: 0 };
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

function write(r: Replica, sql: string): void {
  r.db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(r.db, 'write', null);
  r.db.exec(sql);
  finishCaptureFrame(r.db, frame);
  r.db.exec('COMMIT');
  seal(r);
}

function push(r: Replica): void {
  const done = sent.get(r.id) ?? new Set<string>();
  sent.set(r.id, done);
  const txns = (
    r.db
      .prepare(
        'SELECT txn, hlc, via, kind, actor FROM _sync_txn WHERE replica = ? ORDER BY local_seq',
      )
      .all(r.id) as Array<{
      txn: string;
      hlc: string;
      via: LedgerTxn['via'];
      kind: LedgerTxn['kind'];
      actor: string | null;
    }>
  )
    .filter((t) => !done.has(t.txn))
    .map((t) => {
      done.add(t.txn);
      return {
        v: 1,
        txn: t.txn,
        hlc: t.hlc,
        project: null,
        scope: 'project' as const,
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
  if (txns.length > 0) published.push({ replicaId: r.id, txns });
}

/** Stage what `r` has not seen, without applying it. */
function stage(r: Replica): void {
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
}

function pull(r: Replica): void {
  stage(r);
  applyStagedTxns(r.db, {
    scope: 'project',
    stream: STREAM,
    replica: r.id,
    now: () => Date.now(),
    seal: () => seal(r),
  });
}

/** The original task, and the legacy follow-up the old reconcile minted for it. */
const SEED = `
  INSERT INTO tasks_tasks (id, title, type, status, priority, created_at)
    VALUES ('T100', 'original', 'task', 'pending', 'medium', '2026-05-01T00:00:00.000Z');
  INSERT INTO tasks_tasks (id, title, type, status, priority, created_at)
    VALUES ('${LEGACY}', 'Reconcile T100 for v2026.5.63', 'task', 'pending', 'medium',
            '2026-05-02T00:00:00.000Z');
  INSERT INTO tasks_task_relations (task_id, related_to, relation_type)
    VALUES ('${LEGACY}', 'T100', 'related');
`;

const taskIds = (db: DatabaseSync): string[] =>
  (db.prepare('SELECT id FROM tasks_tasks ORDER BY id').all() as Array<{ id: string }>).map(
    (r) => r.id,
  );

describe('legacy reconcile follow-ups are re-keyed through the journal re-mint (T14324)', () => {
  it('a dry run lists each row with its planned id and writes nothing', async () => {
    const a = await replica(RA);
    write(a, SEED);
    const report = await rekeyLegacyFollowUps(a.db, a.root, { snapshot: async () => SNAPSHOT_OK });
    expect(report).toEqual({
      applied: false,
      rows: [{ oldId: LEGACY, newId: 'T101' }],
      refused: null,
    });
    expect(taskIds(a.db)).toContain(LEGACY);
    expect(existsSync(join(a.root, '.cleo', FOLLOWUP_REKEY_AUDIT_FILE))).toBe(false);
  });

  it('refuses without a snapshot', async () => {
    const a = await replica(RA);
    write(a, SEED);
    const report = await rekeyLegacyFollowUps(a.db, a.root, {
      apply: true,
      snapshot: async () => ({ ...SNAPSHOT_OK, snapshotted: [], skipped: 'lock-timeout' }),
    });
    expect(report.applied).toBe(false);
    expect(report.refused).toMatch(/no snapshot/);
    expect(taskIds(a.db)).toContain(LEGACY);
  });

  it('renames the row and its references, keeps the old id as an alias, and writes a receipt', async () => {
    const a = await replica(RA);
    write(a, SEED);
    const report = await rekeyLegacyFollowUps(a.db, a.root, {
      apply: true,
      snapshot: async () => SNAPSHOT_OK,
    });
    expect(report.applied).toBe(true);
    const newId = report.rows[0]?.newId as string;
    expect(newId).toMatch(/^T\d+$/);
    expect(taskIds(a.db)).toEqual(['T100', newId].sort());
    expect(
      a.db.prepare('SELECT task_id FROM tasks_task_relations WHERE related_to = ?').get('T100'),
    ).toEqual({ task_id: newId });
    const resolved = resolveDisplayId(a.db, 'tasks_tasks', LEGACY);
    expect(resolved).toMatchObject({ status: 'resolved', claimant: { currentId: newId } });
    const receipts = readFileSync(join(a.root, '.cleo', FOLLOWUP_REKEY_AUDIT_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { oldId: string; newId: string });
    expect(receipts).toEqual([expect.objectContaining({ oldId: LEGACY, newId })]);
  });

  it('a second device that synced the old row converges on the new id, with no duplicate', async () => {
    const a = await replica(RA);
    const b = await replica(RB);
    write(a, SEED);
    push(a);
    pull(b);
    expect(taskIds(b.db)).toContain(LEGACY);

    const report = await rekeyLegacyFollowUps(a.db, a.root, {
      apply: true,
      snapshot: async () => SNAPSHOT_OK,
    });
    const newId = report.rows[0]?.newId as string;
    seal(a);
    push(a);
    pull(b);

    expect(taskIds(b.db)).toEqual(taskIds(a.db));
    expect(taskIds(b.db)).toEqual(['T100', newId].sort());
    expect(
      b.db.prepare('SELECT task_id FROM tasks_task_relations WHERE related_to = ?').get('T100'),
    ).toEqual({ task_id: newId });
    expect(resolveDisplayId(b.db, 'tasks_tasks', LEGACY)).toMatchObject({
      status: 'resolved',
      claimant: { currentId: newId },
    });
  });
});

describe('remintDisplayKey staged keys by stream (T14324)', () => {
  it('a named stream takes only its own staged keys (unchanged); null takes every stream', async () => {
    const a = await replica(RA);
    const b = await replica(RB);
    // A's T500 is staged on B's stream and not applied: a key B must not re-mint onto.
    write(
      a,
      `INSERT INTO tasks_tasks (id, title, type, status, priority, created_at)
         VALUES ('T500', 'staged elsewhere', 'task', 'pending', 'medium', '2026-05-01T00:00:00.000Z')`,
    );
    push(a);
    stage(b);
    write(
      b,
      `INSERT INTO tasks_tasks (id, title, type, status, priority, created_at)
         VALUES ('T100', 'local', 'task', 'pending', 'medium', '2026-05-01T00:00:00.000Z')`,
    );
    const { uid, fp } = b.db
      .prepare('SELECT uid, birth_fp AS fp FROM tasks_tasks WHERE id = ?')
      .get('T100') as { uid: string; fp: string };
    const remintTo = (stream: string | null): string | undefined => {
      b.db.exec('BEGIN IMMEDIATE');
      try {
        return remintDisplayKey(b.db, 'project', 'tasks_tasks', uid, fp, { stream, origin: RB })
          ?.toKey;
      } finally {
        b.db.exec('ROLLBACK');
      }
    };
    // The sync applier's call: its own stream's staged keys are above the floor.
    expect(remintTo(STREAM)).toBe('T501');
    // Another stream's staged keys are not this stream's: only local keys count.
    expect(remintTo('project:another-stream')).toBe('T101');
    // A local re-key (null) takes every staged stream.
    expect(remintTo(null)).toBe('T501');
  });
});
