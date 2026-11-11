/** Fail-closed reaper inactivity proof: real child cwd/open files, worker records and leases. */
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeProjectHash } from '@cleocode/paths';
import { acquireWorktreeTaskLock, readWorktreeTaskLock } from '@cleocode/worktree';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerRecord } from '../../orchestrate/worker-records.js';
import { listWorkerRecordsReadOnly } from '../../orchestrate/worker-records.js';
import { agentLeaseDir, releaseAgentLease, writeAgentLease } from '../../resources/agent-lease.js';
import {
  worktreeInUseProbe,
  worktreeProcessUse,
  worktreeReaperInUseProbe,
} from '../in-use-probe.js';

vi.mock('../../orchestrate/worker-records.js', () => ({
  listWorkerRecords: vi.fn(),
  listWorkerRecordsReadOnly: vi.fn(),
}));
// The own-project and WAL checks are stubbed so the fixture tmpdir (whose
// `.cleo` resolution would fall through to the running checkout) stays
// foreign and read-safe; the store-read failure path is the rejected mock.
vi.mock('../../store/sqlite.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../store/sqlite.js')>()),
  isOwnProjectStore: vi.fn(() => false),
  projectStoreWalPending: vi.fn(() => false),
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

let base: string;
let path: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'reaper-use-')));
  path = join(base, 'checkout');
  mkdirSync(path);
  writeFileSync(join(path, 'open.txt'), 'keep');
  vi.stubEnv('CLEO_HOME', join(base, 'home'));
  vi.mocked(listWorkerRecordsReadOnly).mockResolvedValue([]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  rmSync(base, { recursive: true, force: true });
});

describe('reaper inactivity proof', () => {
  it('keeps shared task locks regardless of whether the spawner PID is live or dead', () => {
    for (const [taskId, pid] of [
      ['T1', process.pid],
      ['T2', 2_147_483_647],
    ] as const) {
      acquireWorktreeTaskLock({ projectHash: computeProjectHash(base), taskId, holder: { pid } });
      expect(worktreeInUseProbe(readWorktreeTaskLock, base, taskId)?.()).toBe('task lock held');
    }
  });

  it.each([
    'cwd',
    'open file',
  ])('keeps a done checkout while a child has its %s in it', async (use) => {
    const script =
      use === 'cwd'
        ? "process.send('ready'); setInterval(() => {}, 1000)"
        : "require('node:fs').openSync(process.argv[1], 'r'); process.send('ready'); setInterval(() => {}, 1000)";
    const child = spawn(process.execPath, ['-e', script, join(path, 'open.txt')], {
      cwd: use === 'cwd' ? path : base,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const exited = once(child, 'exit');
    try {
      await Promise.race([
        once(child, 'message'),
        exited.then(() => {
          throw new Error('usage fixture exited before ready');
        }),
      ]);
      const probe = await worktreeReaperInUseProbe(base, 'T1', path);
      expect(probe()).toContain('a process has its cwd or an open file');
    } finally {
      child.kill('SIGTERM');
      await exited;
    }
    expect(worktreeProcessUse(path)).toBeNull();
  });

  it('keeps a terminal checkout with an unclosed worker record, even with no PID or local file use', async () => {
    const worker: WorkerRecord = {
      recordId: 'w1',
      taskId: 'T1',
      instanceId: 'i1',
      agentId: 'a1',
      provider: 'test',
      pid: null,
      pgid: null,
      worktree: path,
      leadMailbox: null,
      sessionId: null,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
    };
    vi.mocked(listWorkerRecordsReadOnly).mockResolvedValue([worker]);
    expect((await worktreeReaperInUseProbe(base, 'T1', path))()).toContain('worker record');
    vi.mocked(listWorkerRecordsReadOnly).mockRejectedValueOnce(new Error('store unreadable'));
    // Round 5: every failed foreign read fails closed under one reason.
    expect((await worktreeReaperInUseProbe(base, 'T1', path))()).toContain(
      'unknown: store has uncommitted WAL or could not be read without writing',
    );
  });

  it('keeps a live session lease and fails closed on malformed lease ownership without deleting it', async () => {
    writeAgentLease({
      id: 'l1',
      taskId: 'T1',
      projectRoot: base,
      sessionId: 's1',
      takenAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    });
    const probe = await worktreeReaperInUseProbe(base, 'T1', path);
    expect(probe()).toContain('lease is still live');
    releaseAgentLease('l1');
    writeFileSync(join(agentLeaseDir(), 'bad.json'), '{');
    expect(probe()).toContain('lease probe unavailable');
  });

  it('keeps the worktree when the OS process-use tool is unavailable', () => {
    const unavailable = spawnSync('cleo-test-command-that-does-not-exist', []);
    vi.mocked(spawnSync).mockReturnValueOnce(unavailable);
    expect(worktreeProcessUse(path)).toContain('unavailable');
  });

  it('leaves expired lease records untouched during a read-only proof', async () => {
    writeAgentLease({
      id: 'expired',
      taskId: 'T1',
      projectRoot: base,
      sessionId: 's1',
      takenAtMs: Date.now() - 120_000,
      expiresAtMs: Date.now() - 60_000,
    });
    expect((await worktreeReaperInUseProbe(base, 'T1', path))()).toBeNull();
    expect(existsSync(join(agentLeaseDir(), 'expired.json'))).toBe(true);
  });

  it.each([
    'T1',
    'T2',
  ])('protects live %s leases in nested directories whose names begin with two dots', async (taskId) => {
    const nested = join(path, '..cache');
    mkdirSync(nested);
    writeAgentLease({
      id: 'nested',
      taskId,
      projectRoot: nested,
      sessionId: 's1',
      takenAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    });
    expect((await worktreeReaperInUseProbe(base, 'T1', path))()).toContain('lease is still live');
  });
});
