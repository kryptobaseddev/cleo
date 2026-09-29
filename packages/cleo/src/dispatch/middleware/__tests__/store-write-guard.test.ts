/**
 * Store write guard (T12535): while a twin collapse is failed, mutating
 * operations are refused with `E_TWIN_COLLAPSE_FAILED`; reads and
 * `admin.backup` pass through.
 *
 * @task T12535
 */

import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '@cleocode/core/errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchRequest, DispatchResponse } from '../../types.js';
import { createStoreWriteGuard } from '../store-write-guard.js';

const storeWriteBlock = vi.fn();
vi.mock('@cleocode/core/store/store-write-guard.js', () => ({
  storeWriteBlock: (root: string, req?: unknown) => storeWriteBlock(root, req),
}));

const ok: DispatchResponse = {
  success: true,
  meta: {
    gateway: 'query',
    domain: 'tasks',
    operation: 'show',
    source: 'cli',
    requestId: 'r',
    timestamp: 't',
    duration_ms: 0,
  },
  data: { ok: true },
};

function request(gateway: 'query' | 'mutate', domain: string, operation: string): DispatchRequest {
  return {
    gateway,
    domain,
    operation,
    params: {},
    source: 'cli',
    requestId: 'r',
  } as DispatchRequest;
}

const guard = createStoreWriteGuard(() => '/project');
const next = vi.fn(async () => ok);

beforeEach(() => {
  next.mockClear();
  storeWriteBlock.mockReset();
  storeWriteBlock.mockResolvedValue(
    new CleoError(ExitCode.TWIN_COLLAPSE_FAILED, 'Twin collapse of schema_meta failed', {
      fix: "run 'cleo doctor twin-collapse --retry'",
      details: { field: 'twinCollapse', snapshotPath: '/p/cleo.db.migration-x' },
    }),
  );
});

describe('store write guard', () => {
  it('refuses a mutate with E_TWIN_COLLAPSE_FAILED (exit 55) and never runs the handler', async () => {
    for (const [domain, operation] of [
      ['tasks', 'add'],
      ['tasks', 'update'],
      ['tasks', 'complete'],
    ] as const) {
      const res = await guard(request('mutate', domain, operation), next);
      expect(res).toMatchObject({
        success: false,
        error: {
          code: 'E_TWIN_COLLAPSE_FAILED',
          exitCode: 55,
          details: { snapshotPath: '/p/cleo.db.migration-x' },
          fix: expect.stringContaining('--retry'),
        },
      });
    }
    expect(next).not.toHaveBeenCalled();
  });

  it('lets reads through without asking', async () => {
    expect(await guard(request('query', 'tasks', 'show'), next)).toBe(ok);
    expect(storeWriteBlock).not.toHaveBeenCalled();
  });

  it('lets admin.backup through (recovery path)', async () => {
    expect(await guard(request('mutate', 'admin', 'backup'), next)).toBe(ok);
    expect(storeWriteBlock).not.toHaveBeenCalled();
  });

  it('lets a mutate through when the store is writable', async () => {
    storeWriteBlock.mockResolvedValue(null);
    expect(await guard(request('mutate', 'tasks', 'add'), next)).toBe(ok);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('asks about the operation it guards, so a failed pair blocks only its own domain', async () => {
    storeWriteBlock.mockResolvedValue(null);
    await guard(request('mutate', 'docs', 'add'), next);
    expect(storeWriteBlock).toHaveBeenCalledWith(expect.any(String), {
      domain: 'docs',
      operation: 'add',
    });
  });
});
