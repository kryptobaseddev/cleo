/**
 * Bounded git runner (T12511): live process groups are killed on process
 * exit/signal/teardown, and the signal hooks exist only while a call is live.
 *
 * @task T12511
 */

import { chmodSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetTeardownSignalForTests, markShuttingDown } from '../../teardown-signal.js';
import { killLiveGitProcesses, liveGitProcessCount, runBoundedGit } from '../bounded-git.js';

let testDir: string;

beforeEach(async () => {
  testDir = realpathSync(await mkdtemp(join(tmpdir(), 'cleo-bounded-git-T12511-')));
});

afterEach(async () => {
  killLiveGitProcesses();
  _resetTeardownSignalForTests();
  await rm(testDir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A fake git that hangs with a grandchild in its group; returns pid file. */
function hangingGit(): { bin: string; pidFile: string } {
  const bin = join(testDir, 'hang.sh');
  const pidFile = join(testDir, 'gc.pid');
  writeFileSync(bin, `#!/bin/sh\nsleep 30 &\necho $! > "${pidFile}"\nwait\n`);
  chmodSync(bin, 0o755);
  return { bin, pidFile };
}

async function waitFor(file: string): Promise<number> {
  for (let i = 0; i < 100; i++) {
    try {
      const pid = Number(readFileSync(file, 'utf8').trim());
      if (pid > 0) return pid;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no pid in ${file}`);
}

describe.skipIf(process.platform === 'win32')('bounded git process groups (T12511)', () => {
  it('exit/signal hooks exist only while a call is live, and kill its group', async () => {
    const baseline = {
      exit: process.listenerCount('exit'),
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    };
    const { bin, pidFile } = hangingGit();
    const run = runBoundedGit(['status'], {
      cwd: testDir,
      deadline: Date.now() + 20_000,
      gitBin: bin,
    });
    const grandchild = await waitFor(pidFile);
    expect(liveGitProcessCount()).toBe(1);
    expect(process.listenerCount('exit')).toBe(baseline.exit + 1);
    expect(process.listenerCount('SIGINT')).toBe(baseline.sigint + 1);
    expect(process.listenerCount('SIGTERM')).toBe(baseline.sigterm + 1);

    // What the exit / SIGINT / SIGTERM handlers run.
    expect(killLiveGitProcesses()).toBe(1);
    const result = await run;
    expect(result.code).toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(grandchild)).toBe(false);
    expect(process.listenerCount('exit')).toBe(baseline.exit);
    expect(process.listenerCount('SIGINT')).toBe(baseline.sigint);
    expect(process.listenerCount('SIGTERM')).toBe(baseline.sigterm);
  });

  it('teardown (markShuttingDown) kills a live group', async () => {
    const { bin, pidFile } = hangingGit();
    const run = runBoundedGit(['status'], {
      cwd: testDir,
      deadline: Date.now() + 20_000,
      gitBin: bin,
    });
    const grandchild = await waitFor(pidFile);
    const started = Date.now();
    markShuttingDown();
    const result = await run;
    // Killed by teardown, not by the 20s deadline.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.timedOut).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(grandchild)).toBe(false);
    expect(liveGitProcessCount()).toBe(0);
  });
});
