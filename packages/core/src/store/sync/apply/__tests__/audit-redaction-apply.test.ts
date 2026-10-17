/**
 * A pulled audit row is stored redacted, and re-delivering it is no conflict
 * (T13861). The apply write API writes raw SQL, so without the shared column
 * transform a segment carrying a plaintext token would land verbatim, and the
 * immutable-audit rule would refuse the redacted row's own re-delivery.
 *
 * Real project `cleo.db` stores with capture and seal on, under `mkdtemp`.
 *
 * @task T13861
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { LedgerOp, LedgerTxn } from '@cleocode/contracts/ledger';
import { SYNC_SCHEMA_VERSION } from '@cleocode/contracts/sync-schema.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../../../dual-scope-db.js';
import { naturalRowUid } from '../../../row-identity.js';
import { setCaptureEnabled } from '../../capture.js';
import { listConflicts } from '../../conflicts.js';
import { setSyncFlag } from '../../flags.js';
import { type InboxSegment, stageTxns } from '../../inbox.js';
import { sealPending } from '../../sealer.js';
import { applyStagedTxns } from '../applier.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../../migrations/sync-journal');
const LOCAL = '01929a3e-7f00-7000-8000-000000000001';
const R1 = '11111111-1111-4111-8111-111111111111';
const STREAM = 'project:test';
const T0 = 1_790_000_000_000;
const TOKEN = 'plain-gate-token-1';
let clock = T0;
let seq = 0;
let dir: string;

const h = (ms: number): string => `${String(T0 + ms).padStart(13, '0')}-000000-${R1}`;

beforeEach(() => {
  seq = 0;
  dir = mkdtempSync(join(tmpdir(), 'cleo-audit-redact-apply-'));
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

async function store(): Promise<DatabaseSync> {
  mkdirSync(join(dir, 'project', '.cleo'), { recursive: true });
  const db = getDualScopeNativeDb(
    await openDualScopeDbAtPath('project', join(dir, 'project', '.cleo', 'cleo.db')),
  );
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  setSyncFlag(db, 'sync.seal', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  return db;
}

function seal(db: DatabaseSync) {
  const r = sealPending(db, {
    scope: 'project',
    replica: LOCAL,
    now: () => ++clock,
    env: {},
    allowUnreleased: true,
  });
  expect(r.refused ?? null, 'sealing was refused').toBeNull();
  return r;
}

function segment(ops: LedgerOp[]): InboxSegment {
  seq += 1;
  const txn: LedgerTxn = {
    v: 1,
    txn: `t-${seq}`,
    hlc: ops[0]?.h ?? h(0),
    project: null,
    scope: 'project',
    via: 'accessor',
    kind: 'write',
    actor: null,
    ops,
    sig: '',
  };
  return {
    seq,
    replicaId: R1,
    replicaSeq: seq,
    deviceId: 'dev-1111',
    schemaVersion: SYNC_SCHEMA_VERSION,
    txns: [txn],
  };
}

function applySegment(db: DatabaseSync, s: InboxSegment) {
  stageTxns(db, STREAM, s, new Date(clock).toISOString());
  return applyStagedTxns(db, {
    scope: 'project',
    stream: STREAM,
    replica: LOCAL,
    now: () => T0 + 60_000,
    seal: () => seal(db),
  });
}

const AUDIT_ID = 'audit-T13861';
const auditInsert = (): LedgerOp => ({
  t: 'tasks_audit_log',
  u: naturalRowUid('project', 'tasks_audit_log', [AUDIT_ID]),
  o: 'I',
  h: h(1),
  a: {
    id: AUDIT_ID,
    timestamp: '2026-10-17T00:00:00Z',
    action: 'service.connect',
    task_id: 'system',
    actor: 'system',
    details_json: JSON.stringify({ provider: 'github', token: TOKEN }),
    error_message: `failed: --token ${TOKEN}`,
  },
});

const row = (db: DatabaseSync) =>
  db
    .prepare('SELECT details_json, error_message FROM tasks_audit_log WHERE id = ?')
    .get(AUDIT_ID) as { details_json: string; error_message: string } | undefined;

describe('pulled audit rows are stored redacted (T13861)', () => {
  it('redacts a plaintext token a pulled segment carries', async () => {
    const db = await store();
    applySegment(db, segment([auditInsert()]));
    const stored = row(db);
    expect(stored?.details_json).toBe('{"provider":"github","token":"[REDACTED]"}');
    expect(stored?.error_message).toBe('failed: --token [REDACTED]');
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
    // The applied write is subtracted from its capture: nothing is echoed back.
    expect(seal(db).txns, 'the applied insert was echoed').toBe(0);
  });

  it('re-delivering the same segment raises no conflict', async () => {
    const db = await store();
    const op = auditInsert();
    applySegment(db, segment([op]));
    applySegment(db, segment([op]));
    expect(listConflicts(db, { open: true })).toEqual([]);
    expect(row(db)?.details_json).toBe('{"provider":"github","token":"[REDACTED]"}');
  });
});
