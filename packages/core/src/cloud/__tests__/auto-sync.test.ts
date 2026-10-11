/**
 * Automatic main-brain sync (T13468): session end and the tick run
 * `cloud sync` without the user, throttled, single-flight, skipped when no
 * store syncs, and a failure becomes one `cloud status` warning.
 *
 * @task T13468
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_SYNC_INTERVAL_MS,
  AUTO_SYNC_TIMEOUT_MS,
  type AutoSyncOptions,
  autoCloudSync,
  autoSyncWarning,
  readAutoSyncState,
  W_AUTO_SYNC_FAILED,
} from '../auto-sync.js';

let dir: string;
let home: string;
let project: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-auto-sync-'));
  home = join(dir, 'home');
  project = join(dir, 'project');
  mkdirSync(join(project, '.cleo'), { recursive: true });
  mkdirSync(home, { recursive: true });
  vi.stubEnv('CLEO_AUTO_SYNC_INTERVAL_MIN', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/** Seams: sync on, admitted, a free lock, and a counting sync. */
function seams(over: Partial<AutoSyncOptions> = {}) {
  const sync = vi.fn(async () => ({}));
  const opts: AutoSyncOptions = {
    cleoHome: home,
    syncEnabled: async () => true,
    admit: async () => ({ release: async () => {} }),
    lock: async () => ({ release: async () => {} }),
    sync,
    ...over,
  };
  return { opts, sync };
}

describe('autoCloudSync (T13468)', () => {
  it('session end runs one sync and records success', async () => {
    const { opts, sync } = seams();
    expect(await autoCloudSync(project, 'session-end', opts)).toBe('synced');
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith(project);
    const s = readAutoSyncState(home);
    expect(s.lastOkAt).toBeDefined();
    expect(s.lastError).toBeNull();
    expect(autoSyncWarning(home)).toBeNull();
  });

  it('a failed sync is swallowed and becomes one cloud status warning, cleared by a success', async () => {
    const t0 = new Date('2026-10-10T00:00:00Z');
    const failing = seams({
      now: t0,
      sync: async () => {
        throw Object.assign(new Error('no answer'), { code: 'E_NEXUS_UNREACHABLE' });
      },
    });
    expect(await autoCloudSync(project, 'session-end', failing.opts)).toBe('failed');
    const w = autoSyncWarning(home);
    expect(w?.code).toBe(W_AUTO_SYNC_FAILED);
    expect(w?.message).toContain('E_NEXUS_UNREACHABLE');

    const ok = seams({ now: new Date(t0.getTime() + 2 * 60_000) });
    expect(await autoCloudSync(project, 'session-end', ok.opts)).toBe('synced');
    expect(autoSyncWarning(home)).toBeNull();
  });

  it('the tick throttles: no second sync within the interval, one after it', async () => {
    const t0 = new Date('2026-10-10T00:00:00Z');
    const a = seams({ now: t0 });
    expect(await autoCloudSync(project, 'tick', a.opts)).toBe('synced');
    const b = seams({ now: new Date(t0.getTime() + AUTO_SYNC_INTERVAL_MS - 1) });
    expect(await autoCloudSync(project, 'tick', b.opts)).toBe('throttled');
    expect(b.sync).not.toHaveBeenCalled();
    const c = seams({ now: new Date(t0.getTime() + AUTO_SYNC_INTERVAL_MS) });
    expect(await autoCloudSync(project, 'tick', c.opts)).toBe('synced');
  });

  it('CLEO_AUTO_SYNC_INTERVAL_MIN=0 turns the tick sync off; session end still syncs', async () => {
    vi.stubEnv('CLEO_AUTO_SYNC_INTERVAL_MIN', '0');
    const a = seams();
    expect(await autoCloudSync(project, 'tick', a.opts)).toBe('disabled');
    expect(a.sync).not.toHaveBeenCalled();
    expect(await autoCloudSync(project, 'session-end', a.opts)).toBe('synced');
  });

  it('a held lock means another process is syncing: no second sync', async () => {
    const { opts, sync } = seams({
      lock: async () => {
        throw new Error('lock held');
      },
    });
    expect(await autoCloudSync(project, 'session-end', opts)).toBe('busy');
    expect(sync).not.toHaveBeenCalled();
  });

  it('a sync that outlives its timeout keeps the lock until it settles (T13500)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let held = false;
      let released = 0;
      const lock = async () => {
        if (held) throw new Error('lock held');
        held = true;
        return {
          release: async () => {
            held = false;
            released += 1;
          },
        };
      };
      let finish: () => void = () => {};
      const sync = vi.fn(() => new Promise<unknown>((resolve) => (finish = () => resolve({}))));
      const start = new Date('2026-10-11T00:00:00Z');
      const { opts } = seams({ lock, sync, now: start });
      const first = autoCloudSync(project, 'session-end', opts);
      await vi.advanceTimersByTimeAsync(AUTO_SYNC_TIMEOUT_MS + 1);
      // The race has timed out, but the sync is still running: a second sync is busy.
      const later = new Date(start.getTime() + AUTO_SYNC_TIMEOUT_MS + 61_000);
      expect(await autoCloudSync(project, 'session-end', { ...opts, now: later })).toBe('busy');
      expect(sync).toHaveBeenCalledTimes(1);
      expect(released).toBe(0);
      finish();
      expect(await first).toBe('failed');
      expect(released).toBe(1);
      expect(readAutoSyncState(home).lastError?.code).toBe('E_AUTO_SYNC_TIMEOUT');
    } finally {
      vi.useRealTimers();
    }
  });

  it('two concurrent session ends sync once under the real lock', async () => {
    const sync = vi.fn(
      () => new Promise((resolve) => setTimeout(() => resolve({}), 50)) as Promise<unknown>,
    );
    const { lock: _lock, ...base } = seams({ sync }).opts;
    const outcomes = await Promise.all([
      autoCloudSync(project, 'session-end', base),
      autoCloudSync(project, 'session-end', base),
    ]);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(outcomes.sort()).toEqual(['busy', 'synced']);
  });

  it('a lock lost mid-sync is abandoned, never released or thrown (T13468 LOW)', async () => {
    const release = vi.fn(async () => {});
    const abandon = vi.fn(async () => {});
    let lose: ((err: Error) => void) | undefined;
    const { opts } = seams({
      lock: async (onCompromised) => {
        lose = onCompromised;
        return { release, abandon };
      },
      sync: vi.fn(async () => {
        lose?.(new Error('lock compromised'));
        return {};
      }),
    });
    expect(await autoCloudSync(project, 'session-end', opts)).toBe('synced');
    expect(abandon).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });

  it('skips quietly when no store has sync on', async () => {
    const { opts, sync } = seams({ syncEnabled: async () => false });
    expect(await autoCloudSync(project, 'session-end', opts)).toBe('skipped');
    expect(sync).not.toHaveBeenCalled();
    expect(autoSyncWarning(home)).toBeNull();
  });

  it('a signed-out device is a quiet skip, never a warning', async () => {
    const { opts } = seams({
      sync: async () => {
        throw Object.assign(new Error('sign in'), { code: 'E_NEXUS_NOT_SIGNED_IN' });
      },
    });
    expect(await autoCloudSync(project, 'session-end', opts)).toBe('skipped');
    expect(autoSyncWarning(home)).toBeNull();
  });

  it('under machine pressure the sync is deferred, not run', async () => {
    const { opts, sync } = seams({ admit: async () => null });
    expect(await autoCloudSync(project, 'session-end', opts)).toBe('deferred');
    expect(sync).not.toHaveBeenCalled();
  });

  it('the default sync-enabled check reads the real stores: absent stores are off', async () => {
    const { syncEnabled: _s, ...opts } = seams().opts;
    expect(await autoCloudSync(project, 'session-end', opts)).toBe('skipped');
  });
});
