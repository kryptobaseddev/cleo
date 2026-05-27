/**
 * Tests for the Tier-3 kill-switch checker.
 *
 * Covers:
 *   - `__setKillSwitchForTest` helper — fast-path for unit tests (no disk)
 *   - `checkKillSwitch` throws {@link KillSwitchActivatedError} when active
 *   - `checkKillSwitch` resolves silently when inactive
 *   - `KillSwitchActivatedError` carries correct step + ISO killedAt
 *   - `startKillSwitchWatcher` + fs.watch integration:
 *     - watcher detects a false→true flip and causes next checkKillSwitch to throw
 *     - returned stop function closes the watcher and resets the cache
 *   - File-absent fallback (cache undefined → disk read → default false)
 *
 * @task T1027
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetKillSwitchCacheForTest,
  __setKillSwitchForTest,
  checkKillSwitch,
  KillSwitchActivatedError,
  startKillSwitchWatcher,
} from '../kill-switch.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a kill-switch state slice to a temp file. */
async function writeStateFile(
  stateFile: string,
  killSwitch: boolean,
  extra: Record<string, string> = {},
): Promise<void> {
  const obj: Record<string, unknown> = { killSwitch, ...extra };
  await writeFile(stateFile, JSON.stringify(obj, null, 2), 'utf-8');
}

/** Pause for N milliseconds — used to wait for debounced watcher. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// __setKillSwitchForTest
// ---------------------------------------------------------------------------

describe('__setKillSwitchForTest', () => {
  afterEach(() => {
    // Always reset cache fully so tests are isolated.
    __resetKillSwitchCacheForTest();
  });

  it('checkKillSwitch resolves when kill switch is false', async () => {
    __setKillSwitchForTest(false);
    await expect(checkKillSwitch('pre-pick')).resolves.toBeUndefined();
  });

  it('checkKillSwitch throws KillSwitchActivatedError when kill switch is true', async () => {
    __setKillSwitchForTest(true);
    await expect(checkKillSwitch('post-spawn')).rejects.toBeInstanceOf(KillSwitchActivatedError);
  });

  it('KillSwitchActivatedError carries the correct step label', async () => {
    __setKillSwitchForTest(true);
    let err: KillSwitchActivatedError | null = null;
    try {
      await checkKillSwitch('pre-merge');
    } catch (e) {
      err = e as KillSwitchActivatedError;
    }
    expect(err).not.toBeNull();
    expect(err?.step).toBe('pre-merge');
  });

  it('KillSwitchActivatedError.killedAt is a valid ISO-8601 timestamp', async () => {
    __setKillSwitchForTest(true);
    let err: KillSwitchActivatedError | null = null;
    try {
      await checkKillSwitch('pre-sign');
    } catch (e) {
      err = e as KillSwitchActivatedError;
    }
    expect(err).not.toBeNull();
    // ISO-8601 dates parse without NaN.
    expect(Number.isNaN(new Date(err?.killedAt ?? '').getTime())).toBe(false);
  });

  it('KillSwitchActivatedError.name is KillSwitchActivatedError', async () => {
    __setKillSwitchForTest(true);
    let err: KillSwitchActivatedError | null = null;
    try {
      await checkKillSwitch('post-verify');
    } catch (e) {
      err = e as KillSwitchActivatedError;
    }
    expect(err?.name).toBe('KillSwitchActivatedError');
  });

  it('all 10 StepLabel values are accepted without error when inactive', async () => {
    __setKillSwitchForTest(false);
    const steps = [
      'pre-pick',
      'post-pick',
      'pre-spawn',
      'post-spawn',
      'pre-verify',
      'post-verify',
      'pre-sign',
      'post-sign',
      'pre-merge',
      'post-merge',
    ] as const;
    for (const step of steps) {
      await expect(checkKillSwitch(step)).resolves.toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// File-based fallback (no watcher, cache reset to undefined)
// ---------------------------------------------------------------------------

describe('checkKillSwitch — file-based fallback', () => {
  let root: string;
  let stateFile: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cleo-ks-fb-'));
    stateFile = join(root, '.cleo', 'sentient-state.json');
    await mkdir(join(root, '.cleo'), { recursive: true });
    // Reset cache so disk-read fallback is exercised.
    __resetKillSwitchCacheForTest();
  });

  afterEach(async () => {
    __resetKillSwitchCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  it('returns without throwing when state file is absent (default false)', async () => {
    // Cache is undefined (reset above) and state file doesn't exist yet.
    await expect(checkKillSwitch('pre-pick', stateFile)).resolves.toBeUndefined();
  });

  it('reads killSwitch:false from disk when cache is undefined', async () => {
    await writeStateFile(stateFile, false);
    await expect(checkKillSwitch('post-pick', stateFile)).resolves.toBeUndefined();
  });

  it('reads killSwitch:true from disk when cache is undefined', async () => {
    await writeStateFile(stateFile, true, { activatedAt: new Date().toISOString() });
    await expect(checkKillSwitch('pre-verify', stateFile)).rejects.toBeInstanceOf(
      KillSwitchActivatedError,
    );
  });
});

// ---------------------------------------------------------------------------
// fs.watch integration — false → true toggle
// ---------------------------------------------------------------------------

describe('startKillSwitchWatcher — fs.watch integration', () => {
  let root: string;
  let stateFile: string;
  let stopWatcher: (() => void) | null = null;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cleo-ks-watch-'));
    stateFile = join(root, '.cleo', 'sentient-state.json');
    await mkdir(join(root, '.cleo'), { recursive: true });
    __resetKillSwitchCacheForTest();
  });

  afterEach(async () => {
    stopWatcher?.();
    stopWatcher = null;
    __resetKillSwitchCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  it('watcher seeds false on start, checkKillSwitch passes initially', async () => {
    await writeStateFile(stateFile, false);
    stopWatcher = startKillSwitchWatcher(stateFile);
    // Allow the async seed read to complete.
    await pause(80);
    await expect(checkKillSwitch('pre-pick', stateFile)).resolves.toBeUndefined();
  });

  it('watcher detects false→true flip and next checkKillSwitch throws', async () => {
    await writeStateFile(stateFile, false);
    stopWatcher = startKillSwitchWatcher(stateFile);
    await pause(80); // let seed read settle

    // Flip kill switch.
    await writeStateFile(stateFile, true, { activatedAt: new Date().toISOString() });

    // Wait for debounce (100 ms) + IO round-trip.
    await pause(300);

    await expect(checkKillSwitch('post-pick', stateFile)).rejects.toBeInstanceOf(
      KillSwitchActivatedError,
    );
  });

  it('stop function closes watcher and resets cache to undefined', async () => {
    await writeStateFile(stateFile, false);
    const stop = startKillSwitchWatcher(stateFile);
    await pause(80);
    stop();
    // After stop, cache is undefined. A direct file read should pick up the
    // current state (false) without throwing.
    await expect(checkKillSwitch('pre-spawn', stateFile)).resolves.toBeUndefined();
  });

  it('stop is idempotent — calling twice does not throw', async () => {
    await writeStateFile(stateFile, false);
    const stop = startKillSwitchWatcher(stateFile);
    expect(() => {
      stop();
      stop();
    }).not.toThrow();
  });
});
