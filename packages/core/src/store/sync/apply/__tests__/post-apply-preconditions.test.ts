/**
 * PAC-15 `apply.preconditions` (T12344 PR-5): a store whose twin collapse
 * failed refuses writes, so the applier applies nothing and the inbox waits.
 *
 * @task T12344
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SYNC_SCHEMA_VERSION } from '@cleocode/contracts/sync-schema.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const failed = vi.hoisted(() => ({ on: false }));
vi.mock('../../../twin-collapse.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../twin-collapse.js')>();
  return {
    ...real,
    twinCollapseFailureOf: (db: Parameters<typeof real.twinCollapseFailureOf>[0]) =>
      failed.on
        ? {
            tables: ['tasks'],
            cause: 'test',
            snapshotPath: null,
            snapshotWritten: false,
            requiredBytes: 0,
            availableBytes: null,
            failedAt: '2026-10-05T00:00:00.000Z',
          }
        : real.twinCollapseFailureOf(db),
  };
});

const { _resetDualScopeDbCache, getDualScopeNativeDb, openDualScopeDbAtPath } = await import(
  '../../../dual-scope-db.js'
);
const { setCaptureEnabled } = await import('../../capture.js');
const { setSyncFlag } = await import('../../flags.js');
const { stageTxns } = await import('../../inbox.js');
const { applyStagedTxns } = await import('../applier.js');

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../../migrations/sync-journal');
const R1 = '11111111-1111-4111-8111-111111111111';
const T0 = 1_790_000_000_000;
let dir = '';

afterEach(() => {
  failed.on = false;
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('PAC-15 apply preconditions', () => {
  it('a store whose twin collapse failed applies nothing; the txn stays staged', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cleo-pac15-'));
    mkdirSync(join(dir, 'cleo'), { recursive: true });
    mkdirSync(join(dir, 'project', '.cleo'), { recursive: true });
    vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_DIR', undefined);
    const db = getDualScopeNativeDb(
      await openDualScopeDbAtPath('project', join(dir, 'project', '.cleo', 'cleo.db')),
    );
    setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
    setSyncFlag(db, 'sync.seal', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
    const h = `${T0 + 1}-000000-${R1}`;
    stageTxns(
      db,
      'project:pac15',
      {
        seq: 1,
        replicaId: R1,
        replicaSeq: 1,
        deviceId: 'dev',
        schemaVersion: SYNC_SCHEMA_VERSION,
        txns: [
          {
            v: 1,
            txn: 'R1:1',
            hlc: h,
            project: null,
            scope: 'project',
            via: 'accessor',
            kind: 'write',
            actor: null,
            ops: [
              {
                t: 'tasks_tasks',
                u: 'p1',
                o: 'I',
                h,
                a: {
                  id: 'P1',
                  title: 'p',
                  type: 'task',
                  status: 'pending',
                  priority: 'medium',
                  birth_fp: 'fp',
                },
              },
            ],
            sig: '',
          },
        ],
      },
      '2026-10-05T00:00:00.000Z',
    );
    failed.on = true;
    const r = applyStagedTxns(db, {
      scope: 'project',
      stream: 'project:pac15',
      replica: '0192aaaa-7f00-7000-8000-00000000000a',
      now: () => T0 + 60_000,
    });
    expect(r.blocked).toMatch(/twin collapse failed/);
    expect(r.applied).toBe(0);
    expect(db.prepare('SELECT status FROM _sync_inbox').get()).toEqual({ status: 'staged' });
    failed.on = false;
    expect(
      applyStagedTxns(db, {
        scope: 'project',
        stream: 'project:pac15',
        replica: '0192aaaa-7f00-7000-8000-00000000000a',
        now: () => T0 + 60_000,
      }).applied,
    ).toBe(1);
  });
});
