/**
 * The seam between the heap plan and the typecheck/lint slot count (T13123):
 * `runToolCached` must hand the semaphore the heap the run is spawned with, or
 * a run planned with a large inherited heap counts as a default-sized one.
 *
 * @task T13123
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcquireSlotOptions } from '../tool-semaphore.js';

const acquired = vi.hoisted(() => [] as Array<{ canonical: string; opts?: AcquireSlotOptions }>);

vi.mock('../tool-semaphore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tool-semaphore.js')>();
  return {
    ...actual,
    acquireGlobalSlot: async (canonical: string, opts?: AcquireSlotOptions) => {
      acquired.push({ canonical, ...(opts ? { opts } : {}) });
      return async () => {};
    },
  };
});

import { runToolCached } from '../tool-cache.js';
import { useRealToolRunner } from './real-tool-runner.js';

// These tests spawn tiny real commands on purpose (T13203 guard opt-in).
useRealToolRunner();

let repo: string;

beforeEach(() => {
  acquired.length = 0;
  repo = mkdtempSync(join(tmpdir(), 'slot-heap-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 'T');
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, '.gitignore'), '.cleo\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  vi.stubEnv('NODE_OPTIONS', '--max-old-space-size=1024');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(repo, { recursive: true, force: true });
});

describe('runToolCached sizes the typecheck slot from the planned heap (T13123)', () => {
  it('passes the heap the run is spawned with to acquireGlobalSlot', async () => {
    const result = await runToolCached(
      {
        canonical: 'typecheck',
        displayName: 'typecheck',
        cmd: 'sh',
        args: ['-c', 'echo ok'],
        source: 'language-default',
      },
      repo,
      { spawnTimeoutMs: 30_000 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.resources?.heapMb).toBe(1024);
    // T13132: charged what the plan lets it start — 1 process × (1024 + 2048) MiB.
    expect(acquired).toEqual([
      { canonical: 'typecheck', opts: { heapMb: 1024, footprintBytes: (1024 + 2048) * 1024 ** 2 } },
    ]);
  });
});
