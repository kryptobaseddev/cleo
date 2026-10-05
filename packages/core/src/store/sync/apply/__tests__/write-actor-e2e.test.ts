/**
 * A local reopen carries its command to every replica (T13229).
 *
 * The real data accessor writes a done task, then reopens it inside
 * `runWithWriteActor({ op: 'tasks.restore' })`. The sealed transaction must
 * name the command, the sealer must record the leave, and a second store
 * applying both sealed transactions must apply the reopen, not void it as a
 * typed-rule conflict.
 *
 * @task T13229
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { LedgerOp, type LedgerTxn } from '@cleocode/contracts/ledger';
import { SYNC_SCHEMA_VERSION } from '@cleocode/contracts/sync-schema.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../../../dual-scope-db.js';
import { createSqliteDataAccessor } from '../../../sqlite-data-accessor.js';
import { setCaptureEnabled } from '../../capture.js';
import { listConflicts } from '../../conflicts.js';
import { readFieldLeaves } from '../../field-leave.js';
import { setSyncFlag } from '../../flags.js';
import { stageTxns } from '../../inbox.js';
import { sealPending } from '../../sealer.js';
import { runWithWriteActor } from '../../write-actor.js';
import { applyStagedTxns } from '../applier.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../../migrations/sync-journal');
const AUTHOR = '0192aaaa-7f00-7000-8000-00000000000a';
const RECEIVER = '0192bbbb-7f00-7000-8000-00000000000b';
const STREAM = 'project:t13229';
let clock = Date.now();

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-write-actor-'));
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  mkdirSync(join(dir, 'author', '.cleo'), { recursive: true });
  mkdirSync(join(dir, 'receiver', '.cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  // Rows need uids to seal.
  vi.stubEnv('CLEO_ROW_UID_FILL', '1');
});

afterEach(async () => {
  const { closeAllDatabases } = await import('../../../sqlite.js');
  await closeAllDatabases();
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function enableSync(db: DatabaseSync): void {
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  setSyncFlag(db, 'sync.seal', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
}

function seal(db: DatabaseSync, replica: string): void {
  const r = sealPending(db, {
    scope: 'project',
    replica,
    now: () => ++clock,
    env: {},
    allowUnreleased: true,
  });
  expect(r.refused ?? null, 'sealing was refused').toBeNull();
}

/** The author's sealed transactions, as the receiver stages them. */
function sealedTxns(db: DatabaseSync): LedgerTxn[] {
  const txns = db
    .prepare('SELECT txn, hlc, via, kind, actor FROM _sync_txn ORDER BY local_seq')
    .all() as Array<{
    txn: string;
    hlc: string;
    via: LedgerTxn['via'];
    kind: LedgerTxn['kind'];
    actor: string | null;
  }>;
  return txns.map((t) => ({
    v: 1,
    txn: t.txn,
    hlc: t.hlc,
    project: null,
    scope: 'project',
    via: t.via,
    kind: t.kind,
    actor: t.actor ? JSON.parse(t.actor) : null,
    ops: (
      db.prepare('SELECT body FROM _sync_op WHERE txn = ? ORDER BY idx').all(t.txn) as Array<{
        body: string;
      }>
    ).map((o) => LedgerOp.parse(JSON.parse(o.body))),
    sig: '',
  }));
}

describe('a local reopen names its command (T13229)', () => {
  it('seals actor.op, records the leave, and applies on a receiving store', async () => {
    const authorRoot = join(dir, 'author');
    const accessor = await createSqliteDataAccessor(authorRoot);
    const { getNativeDb } = await import('../../../sqlite.js');
    const author = getNativeDb(authorRoot);
    if (!author) throw new Error('author store not open');
    enableSync(author);

    const now = new Date().toISOString();
    const task = {
      id: 'T1',
      title: 'reopen me',
      type: 'task' as const,
      status: 'done' as const,
      priority: 'medium' as const,
      pipelineStage: 'contribution',
      createdAt: now,
      completedAt: now,
    };
    await accessor.transaction(async (tx) => tx.insertNewTask(task));
    seal(author, AUTHOR);

    await runWithWriteActor({ op: 'tasks.restore' }, () =>
      accessor.transaction(async (tx) =>
        tx.upsertSingleTask({ ...task, status: 'pending', completedAt: undefined }),
      ),
    );
    seal(author, AUTHOR);

    const txns = sealedTxns(author);
    expect(txns.at(-1)?.actor).toEqual({ op: 'tasks.restore' });
    const uid = txns.at(-1)?.ops[0]?.u as string;
    expect(readFieldLeaves(author, 'tasks_tasks', uid)).toHaveProperty('status');

    const receiver = getDualScopeNativeDb(
      await openDualScopeDbAtPath('project', join(dir, 'receiver', '.cleo', 'cleo.db')),
    );
    enableSync(receiver);
    stageTxns(
      receiver,
      STREAM,
      {
        seq: 1,
        replicaId: AUTHOR,
        replicaSeq: 1,
        deviceId: 'dev-author',
        schemaVersion: SYNC_SCHEMA_VERSION,
        txns,
      },
      now,
    );
    const r = applyStagedTxns(receiver, {
      scope: 'project',
      stream: STREAM,
      replica: RECEIVER,
      seal: () => seal(receiver, RECEIVER),
    });
    expect(listConflicts(receiver)).toEqual([]);
    expect(r).toMatchObject({ void: 0, pending: 0, refusedSchema: 0 });
    expect(receiver.prepare('SELECT status FROM tasks_tasks WHERE uid = ?').get(uid)).toEqual({
      status: 'pending',
    });
    await accessor.close();
  });

  it('a write outside any actor scope records no actor', async () => {
    const authorRoot = join(dir, 'author');
    const accessor = await createSqliteDataAccessor(authorRoot);
    const { getNativeDb } = await import('../../../sqlite.js');
    const author = getNativeDb(authorRoot);
    if (!author) throw new Error('author store not open');
    enableSync(author);
    await accessor.transaction(async (tx) =>
      tx.insertNewTask({
        id: 'T2',
        title: 'plain',
        type: 'task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      }),
    );
    seal(author, AUTHOR);
    expect(sealedTxns(author).at(-1)?.actor).toBeNull();
    await accessor.close();
  });
});
