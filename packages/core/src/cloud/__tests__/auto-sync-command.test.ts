/**
 * Piggyback sync on normal commands (T13553): one detached child per window,
 * the opt-outs, heavy runs, and no network when nothing is synced.
 *
 * @task T13553
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  autoSyncSuppressedBy,
  autoSyncSuppressedWarning,
  runCommandAutoSync,
  startCommandAutoSync,
  W_AUTO_SYNC_SUPPRESSED,
} from '../auto-sync-command.js';

let dir: string;
let home: string;
let project: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-auto-sync-cmd-'));
  home = join(dir, 'cleo');
  project = join(dir, 'project');
  mkdirSync(join(project, '.cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', home);
  vi.stubEnv('CLEO_AUTO_SYNC_INTERVAL_MIN', '');
  vi.stubEnv('CLEO_DISABLE_AUTO_SYNC', '');
  vi.stubEnv('CLEO_RUN_CLASS', undefined);
  // The guard under test treats vitest and CI as no-spawn; these tests exercise the logic outside them.
  vi.stubEnv('VITEST', undefined);
  vi.stubEnv('CI', undefined);
  vi.stubEnv('NODE_ENV', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

const at = (ms: number) => () => new Date(Date.UTC(2026, 9, 11, 12, 0, 0) + ms);
/** Behave as after T13549 releases sync.push/sync.pull. */
const released = new Set<string>();

describe('startCommandAutoSync (T13553)', () => {
  it('is inert while sync.push and sync.pull are unreleased: no stamp, no spawn', () => {
    const spawnWorker = vi.fn();
    expect(startCommandAutoSync({ projectRoot: project, cleoHome: home, spawnWorker })).toBe(
      'disabled',
    );
    expect(spawnWorker).not.toHaveBeenCalled();
    expect(existsSync(join(home, 'auto-sync-command.stamp'))).toBe(false);
  });

  it('two quick commands start exactly one background sync; the next window starts another', () => {
    const spawnWorker = vi.fn();
    const base = {
      projectRoot: project,
      verb: 'show',
      cleoHome: home,
      spawnWorker,
      unreleasedFlags: released,
    };
    expect(startCommandAutoSync({ ...base, now: at(0) })).toBe('spawned');
    expect(startCommandAutoSync({ ...base, now: at(5_000) })).toBe('throttled');
    expect(spawnWorker).toHaveBeenCalledTimes(1);
    expect(spawnWorker).toHaveBeenCalledWith(project);
    expect(startCommandAutoSync({ ...base, now: at(15 * 60_000 + 1) })).toBe('spawned');
    expect(spawnWorker).toHaveBeenCalledTimes(2);
  });

  it('returns at once: the foreground never awaits the child', () => {
    let finished = false;
    const result = startCommandAutoSync({
      projectRoot: project,
      cleoHome: home,
      unreleasedFlags: released,
      spawnWorker: () => {
        setTimeout(() => {
          finished = true;
        }, 50);
      },
    });
    expect(result).toBe('spawned');
    expect(finished).toBe(false);
  });

  it('honours the env opt-outs', () => {
    const spawnWorker = vi.fn();
    vi.stubEnv('CLEO_DISABLE_AUTO_SYNC', '1');
    expect(
      startCommandAutoSync({
        projectRoot: project,
        cleoHome: home,
        spawnWorker,
        unreleasedFlags: released,
      }),
    ).toBe('disabled');
    vi.stubEnv('CLEO_DISABLE_AUTO_SYNC', '');
    vi.stubEnv('CLEO_AUTO_SYNC_INTERVAL_MIN', '0');
    expect(
      startCommandAutoSync({
        projectRoot: project,
        cleoHome: home,
        spawnWorker,
        unreleasedFlags: released,
      }),
    ).toBe('disabled');
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it('never spawns inside a heavy or evidence run, or for run/verify/cloud', () => {
    const spawnWorker = vi.fn();
    vi.stubEnv('CLEO_RUN_CLASS', 'test-run');
    expect(
      startCommandAutoSync({
        projectRoot: project,
        cleoHome: home,
        spawnWorker,
        unreleasedFlags: released,
      }),
    ).toBe('skipped');
    vi.stubEnv('CLEO_RUN_CLASS', undefined);
    for (const verb of ['run', 'verify', 'cloud']) {
      expect(
        startCommandAutoSync({
          projectRoot: project,
          verb,
          cleoHome: home,
          spawnWorker,
          unreleasedFlags: released,
        }),
      ).toBe('skipped');
    }
    expect(spawnWorker).not.toHaveBeenCalled();
  });
});

describe('the test/CI guard (T13553)', () => {
  it('a linked fixture spawns nothing under vitest, NODE_ENV=test or CI, flags released or not', () => {
    // A linked project, as the CLI hook sees it.
    mkdirSync(join(project, '.cleo'), { recursive: true });
    writeFileSync(join(project, '.cleo', 'nexus-link.json'), '{}');
    const spawnWorker = vi.fn();
    const base = { projectRoot: project, verb: 'show', cleoHome: home, spawnWorker };
    for (const [key, value] of [
      ['VITEST', 'true'],
      ['NODE_ENV', 'test'],
      ['CI', 'true'],
      ['CI', '1'],
    ] as const) {
      vi.stubEnv(key, value);
      expect(startCommandAutoSync({ ...base, unreleasedFlags: released }), `${key}=${value}`).toBe(
        'skipped',
      );
      vi.stubEnv(key, undefined);
    }
    expect(spawnWorker).not.toHaveBeenCalled();
    expect(existsSync(join(home, 'auto-sync-command.stamp'))).toBe(false);
    // CI=false is not CI.
    vi.stubEnv('CI', 'false');
    expect(startCommandAutoSync({ ...base, unreleasedFlags: released })).toBe('spawned');
  });
});

describe('runCommandAutoSync (T13553)', () => {
  it('the config opt-out cloud.autoSync: false skips the sync', async () => {
    const sync = vi.fn(async () => 'synced' as const);
    expect(await runCommandAutoSync(project, { readConfig: async () => false, sync })).toBe(
      'disabled',
    );
    expect(sync).not.toHaveBeenCalled();
    expect(await runCommandAutoSync(project, { readConfig: async () => undefined, sync })).toBe(
      'synced',
    );
  });

  it('the real child makes no network call: inert while the flags are unreleased', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('no network in this test');
    });
    vi.stubGlobal('fetch', fetchSpy);
    expect(await runCommandAutoSync(project, { readConfig: async () => undefined })).toBe(
      'disabled',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('cleo cloud status names what suppresses auto-sync (T13602)', () => {
  it('CI=true: the warning names CI', () => {
    const w = autoSyncSuppressedWarning({ CI: 'true' }, released);
    expect(w?.code).toBe(W_AUTO_SYNC_SUPPRESSED);
    expect(w?.message).toContain('CI is set');
  });

  it('names VITEST and NODE_ENV=test; nothing for CI=false or while unreleased', () => {
    expect(autoSyncSuppressedBy({ VITEST: 'true' })).toBe('VITEST');
    expect(autoSyncSuppressedBy({ NODE_ENV: 'test' })).toBe('NODE_ENV=test');
    expect(autoSyncSuppressedWarning({ CI: 'false' }, released)).toBeNull();
    expect(autoSyncSuppressedWarning({ CI: 'true' })).toBeNull();
  });
});
