/**
 * The idempotency replay read against a real `tasks_audit_log` (T13777): the
 * store's own schema and indexes, not a mocked statement. A dispatch row keyed
 * by `dispatch_idempotency_key` and a row exodus carried over with only
 * `idempotency_key` both replay.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchRequest } from '../../types.js';

const state = vi.hoisted(() => ({ root: '' }));

vi.mock('../../../../../core/src/internal.js', async () => {
  const real = await vi.importActual<typeof import('../../../../../core/src/internal.js')>(
    '../../../../../core/src/internal.js',
  );
  return {
    getDb: () => real.getDb(state.root),
    getNativeDb: () => real.getNativeDb(state.root),
    getProjectInfoSync: () => ({ projectHash: 'proj-twin' }),
  };
});

import { getNativeDb, resetDbState } from '../../../../../core/src/store/sqlite.js';
import { createIdempotency } from '../idempotency.js';

const request = (key: string): DispatchRequest => ({
  gateway: 'mutate',
  domain: 'admin',
  operation: 'scaffold-hub',
  params: { idempotencyKey: key },
  source: 'cli',
  requestId: `req-${key}`,
});

describe('idempotency replay on the real tasks_audit_log (T13777)', () => {
  beforeEach(async () => {
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_DIR', undefined);
    state.root = await mkdtemp(join(tmpdir(), 'cleo-idem-twin-'));
    await mkdir(join(state.root, '.cleo'), { recursive: true });
  });

  afterEach(async () => {
    resetDbState();
    vi.unstubAllEnvs();
    await rm(state.root, { recursive: true, force: true });
  });

  it('replays a dispatch row and a row exodus carried over with only idempotency_key', async () => {
    const { getDb } = await import('../../../../../core/src/internal.js');
    await getDb(state.root);
    const db = getNativeDb(state.root);
    if (!db) throw new Error('no native handle');
    const insert = db.prepare(
      `INSERT INTO tasks_audit_log (id, timestamp, action, task_id, actor, domain, operation, success, project_hash, details_json, after_json, dispatch_idempotency_key, idempotency_key)
       VALUES (?, ?, 'mutate', 'system', 'cli', 'admin', 'scaffold-hub', 1, 'proj-twin', ?, ?, ?, ?)`,
    );
    insert.run(
      'a-1',
      '2026-10-16T09:00:00.000Z',
      JSON.stringify({ idempotencyKey: 'new-key' }),
      JSON.stringify({ success: true, data: { from: 'dispatch' } }),
      'new-key',
      null,
    );
    insert.run(
      'a-2',
      '2026-10-16T09:00:01.000Z',
      JSON.stringify({ idempotencyKey: 'old-key' }),
      JSON.stringify({ success: true, data: { from: 'exodus' } }),
      null,
      'old-key',
    );
    const next = vi.fn();
    const middleware = createIdempotency();

    const fresh = await middleware(request('new-key'), next);
    const legacy = await middleware(request('old-key'), next);

    expect(next).not.toHaveBeenCalled();
    expect(fresh.data).toEqual({ from: 'dispatch' });
    expect(legacy.data).toEqual({ from: 'exodus' });
  });
});
