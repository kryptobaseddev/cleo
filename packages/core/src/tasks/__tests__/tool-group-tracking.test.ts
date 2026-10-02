/**
 * The tool groups a heavy run starts are recorded on the slots it holds, and a
 * terminating signal is passed on to them (T12963).
 *
 * Tools run detached, in their own process group. A SIGKILLed cleo leaves
 * that group running with PPID 1, so a slot must stay held while it lives:
 * the slot's holder record lists every group started while it is held. A
 * signal that ends cleo never reaches the detached group either, so while one
 * runs cleo passes SIGTERM/SIGINT/SIGHUP (and its own `exit`) on to it, then
 * re-raises the signal so the process still dies by it.
 *
 * The signal tests stub `process.kill` only; the real `process.kill` is never
 * reached. `proper-lockfile` is loaded, as in every cleo process that runs a
 * tool, so `signal-exit`'s own listeners are present and not stubbed away.
 *
 * @task T12963
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetToolGroupsForTest,
  activeToolGroups,
  trackToolGroup,
} from '../../resources/tool-groups.js';
import {
  runToolCached,
  terminateToolGroupsOnExit,
  terminateToolGroupsOnSignal,
} from '../tool-cache.js';
import type { ResolvedToolCommand } from '../tool-resolver.js';
import { semaphoreDir } from '../tool-semaphore.js';

const saved = { home: process.env.CLEO_HOME, test: process.env.CLEO_TOOL_CONCURRENCY_TEST };
let home: string;
let repo: string;
let out: string;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tool-groups-home-'));
  repo = mkdtempSync(join(tmpdir(), 'tool-groups-repo-'));
  out = mkdtempSync(join(tmpdir(), 'tool-groups-out-'));
  process.env.CLEO_HOME = home;
  // One tool slot; an explicit override also keeps the governor out of it.
  process.env.CLEO_TOOL_CONCURRENCY_TEST = '1';
  git(['init', '-q']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.com']);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(['add', 'a.txt']);
  git(['commit', '-q', '-m', 'first']);
  _resetToolGroupsForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetToolGroupsForTest();
  for (const [k, v] of [
    ['CLEO_HOME', saved.home],
    ['CLEO_TOOL_CONCURRENCY_TEST', saved.test],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of [home, repo, out]) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')(
  'a running tool is recorded on the slot it holds (T12963)',
  () => {
    it("lists the tool's process group in the tool slot's holder record while it runs", async () => {
      const slot = join(semaphoreDir('test'), 'slot-0.lock');
      const seen = join(out, 'holder.json');
      const pgid = join(out, 'pgid');
      // The tool itself copies the record of the slot it runs under, and prints
      // its own process group.
      const command: ResolvedToolCommand = {
        canonical: 'test',
        displayName: 'test',
        cmd: 'sh',
        args: [
          '-c',
          `cat "${slot}.holder.json" > "${seen}"; ps -o pgid= -p $$ > "${pgid}"; sleep 0.3`,
        ],
        source: 'language-default',
        primaryType: 'unknown',
      };
      const sigtermListeners = process.listenerCount('SIGTERM');
      const exitListeners = process.listenerCount('exit');

      const running = runToolCached(command, repo);
      // While the tool runs (it has written its pgid and is sleeping), the
      // signal and exit cleanup is installed.
      while (!existsSync(pgid)) await new Promise((r) => setTimeout(r, 10));
      expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners + 1);
      expect(process.listenerCount('exit')).toBe(exitListeners + 1);
      const r = await running;

      expect(r.exitCode).toBe(0);
      const record = JSON.parse(readFileSync(seen, 'utf-8')) as {
        pid: number;
        toolGroups: number[];
      };
      expect(record.pid).toBe(process.pid);
      expect(record.toolGroups).toEqual([Number(readFileSync(pgid, 'utf-8').trim())]);
      // Once the tool exits it is no longer tracked, and the signal cleanup is gone.
      expect(activeToolGroups()).toEqual([]);
      expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
      expect(process.listenerCount('exit')).toBe(exitListeners);
    });
  },
);

describe.skipIf(process.platform === 'win32')('terminateToolGroupsOnSignal (T12963)', () => {
  let kills: Array<[number, string | number | undefined]>;

  beforeEach(() => {
    kills = [];
    vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      kills.push([pid, signal]);
      return true;
    });
  });

  it('SIGTERMs every running tool group, then re-raises the signal to this process', () => {
    // proper-lockfile loads signal-exit, whose listener alone suppresses the
    // default action: the handler must re-raise however many listeners exist.
    expect(typeof lockfile.lock).toBe('function');
    expect(process.listenerCount('SIGTERM')).toBeGreaterThan(0);
    trackToolGroup(4_000_005);
    trackToolGroup(4_000_006);

    terminateToolGroupsOnSignal('SIGTERM');

    expect(kills).toEqual([
      [-4_000_005, 'SIGTERM'],
      [-4_000_006, 'SIGTERM'],
      [process.pid, 'SIGTERM'],
    ]);
  });

  it('re-raises the same signal it received', () => {
    trackToolGroup(4_000_007);

    terminateToolGroupsOnSignal('SIGINT');

    expect(kills).toEqual([
      [-4_000_007, 'SIGTERM'],
      [process.pid, 'SIGINT'],
    ]);
  });

  it('never tracks, and so never signals, a group id of 1 or below', () => {
    for (const id of [1, 0, -1]) trackToolGroup(id);
    trackToolGroup(undefined);

    terminateToolGroupsOnSignal('SIGHUP');

    expect(activeToolGroups()).toEqual([]);
    expect(kills).toEqual([[process.pid, 'SIGHUP']]);
  });

  it('the exit hook SIGTERMs running tool groups and never signals this process', () => {
    trackToolGroup(4_000_008);

    terminateToolGroupsOnExit();

    expect(kills).toEqual([[-4_000_008, 'SIGTERM']]);
  });
});
