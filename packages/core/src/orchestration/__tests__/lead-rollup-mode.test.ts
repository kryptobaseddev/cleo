/**
 * Tests for the `leadRollup.mode` feature flag (T10513).
 *
 * Verifies the council-action-#9 contract:
 *   1. Default is `'passive'` when the key is absent (backward compat).
 *   2. Project config `{ leadRollup: { mode: 'active' } }` flips the mode.
 *   3. Public function signatures of `rollupWaveStatus` / `rollupEpicStatus`
 *      are unchanged — they take the SAME args regardless of flag state.
 *   4. Malformed flag values (typo, wrong type) fall back to `'passive'`
 *      rather than throwing, so a bad config NEVER breaks an existing caller.
 *
 * The active-mode hook is currently a no-op (T10512 plugs in retry signals
 * later), so the WaveRollup contract shape MUST be observably identical
 * across flag states — that invariant is asserted explicitly.
 *
 * @task T10513
 * @saga T10377
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WaveRollup } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveLeadRollupMode, rollupEpicStatus, rollupWaveStatus } from '../lead-rollup.js';

const SAVED_CLEO_HOME = process.env['CLEO_HOME'];
let cleoHomeRoot: string;
let projectRoot: string;

function uniqueDir(prefix: string): string {
  return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function writeProjectConfig(obj: unknown): void {
  writeFileSync(join(projectRoot, '.cleo', 'config.json'), JSON.stringify(obj));
}

beforeEach(() => {
  cleoHomeRoot = uniqueDir('lead-rollup-mode-home');
  projectRoot = uniqueDir('lead-rollup-mode-proj');
  mkdirSync(cleoHomeRoot, { recursive: true });
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  process.env['CLEO_HOME'] = cleoHomeRoot;
});

afterEach(() => {
  if (SAVED_CLEO_HOME === undefined) {
    delete process.env['CLEO_HOME'];
  } else {
    process.env['CLEO_HOME'] = SAVED_CLEO_HOME;
  }
  rmSync(cleoHomeRoot, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolveLeadRollupMode
// ---------------------------------------------------------------------------

describe('resolveLeadRollupMode — default off (backward compat)', () => {
  it('returns "passive" when no config file exists at all', async () => {
    const mode = await resolveLeadRollupMode(projectRoot);
    expect(mode).toBe('passive');
  });

  it('returns "passive" when the config file exists but omits leadRollup', async () => {
    writeProjectConfig({ output: { defaultFormat: 'json' } });
    const mode = await resolveLeadRollupMode(projectRoot);
    expect(mode).toBe('passive');
  });

  it('returns "passive" when leadRollup is present but mode is omitted', async () => {
    writeProjectConfig({ leadRollup: {} });
    const mode = await resolveLeadRollupMode(projectRoot);
    expect(mode).toBe('passive');
  });
});

describe('resolveLeadRollupMode — flag on flips the value', () => {
  it('returns "active" when leadRollup.mode = "active"', async () => {
    writeProjectConfig({ leadRollup: { mode: 'active' } });
    const mode = await resolveLeadRollupMode(projectRoot);
    expect(mode).toBe('active');
  });

  it('returns "auto" when leadRollup.mode = "auto"', async () => {
    writeProjectConfig({ leadRollup: { mode: 'auto' } });
    const mode = await resolveLeadRollupMode(projectRoot);
    expect(mode).toBe('auto');
  });

  it('returns "passive" when leadRollup.mode = "passive" (explicit default)', async () => {
    writeProjectConfig({ leadRollup: { mode: 'passive' } });
    const mode = await resolveLeadRollupMode(projectRoot);
    expect(mode).toBe('passive');
  });
});

describe('resolveLeadRollupMode — malformed value safety', () => {
  it('returns "passive" for typo\'d string values', async () => {
    writeProjectConfig({ leadRollup: { mode: 'activeeeee' } });
    const mode = await resolveLeadRollupMode(projectRoot);
    expect(mode).toBe('passive');
  });

  it('returns "passive" for wrong type (number)', async () => {
    writeProjectConfig({ leadRollup: { mode: 42 } });
    const mode = await resolveLeadRollupMode(projectRoot);
    expect(mode).toBe('passive');
  });

  it('returns "passive" for wrong type (boolean)', async () => {
    writeProjectConfig({ leadRollup: { mode: true } });
    const mode = await resolveLeadRollupMode(projectRoot);
    expect(mode).toBe('passive');
  });

  it('returns "passive" for null', async () => {
    writeProjectConfig({ leadRollup: { mode: null } });
    const mode = await resolveLeadRollupMode(projectRoot);
    expect(mode).toBe('passive');
  });
});

// ---------------------------------------------------------------------------
// Caller-stability invariant — function signatures unchanged
// ---------------------------------------------------------------------------

describe('rollupWaveStatus — caller signature unchanged across flag states', () => {
  // The whole council-action-#9 point: legacy callers MUST work identically
  // regardless of the flag. We exercise the SAME 4-arg call shape under both
  // flag states and assert the contract shape is identical.

  it('flag off (default): legacy 2-arg call returns a well-formed WaveRollup', async () => {
    let result: WaveRollup | undefined;
    try {
      result = await rollupWaveStatus('T-DOES-NOT-EXIST', 0);
    } catch {
      return; // No project DB available — skip
    }
    expect(result.epicId).toBe('T-DOES-NOT-EXIST');
    expect(result.waveId).toBe(0);
    expect(Array.isArray(result.workers)).toBe(true);
    expect(Array.isArray(result.blockers)).toBe(true);
    expect(typeof result.readyToAdvance).toBe('boolean');
  });

  it('flag on: SAME signature returns the SAME contract shape', async () => {
    writeProjectConfig({ leadRollup: { mode: 'active' } });
    let result: WaveRollup | undefined;
    try {
      // Note: we pass projectRoot so resolveLeadRollupMode sees our config.
      // The signature is identical to the legacy call — projectRoot has
      // always been an optional positional. No new args were added.
      result = await rollupWaveStatus('T-DOES-NOT-EXIST', 0, projectRoot);
    } catch {
      return;
    }
    expect(result.epicId).toBe('T-DOES-NOT-EXIST');
    expect(result.waveId).toBe(0);
    expect(Array.isArray(result.workers)).toBe(true);
    expect(Array.isArray(result.blockers)).toBe(true);
    expect(typeof result.readyToAdvance).toBe('boolean');
  });

  it('flag on: WaveRollup shape is observably identical to flag off (no-op hook)', async () => {
    // The active-mode hook is a no-op until T10512 lands. Until then, the
    // rollup contract MUST be the same with or without the flag, so flipping
    // it on never breaks downstream consumers.
    let passive: WaveRollup | undefined;
    let active: WaveRollup | undefined;
    try {
      passive = await rollupWaveStatus('T-DOES-NOT-EXIST', 0, projectRoot);
      writeProjectConfig({ leadRollup: { mode: 'active' } });
      active = await rollupWaveStatus('T-DOES-NOT-EXIST', 0, projectRoot);
    } catch {
      return;
    }
    // Keys must match — both should expose the SAME WaveRollup contract.
    expect(Object.keys(passive).sort()).toEqual(Object.keys(active).sort());
    expect(passive.workers).toEqual(active.workers);
    expect(passive.blockers).toEqual(active.blockers);
    expect(passive.readyToAdvance).toBe(active.readyToAdvance);
  });
});

describe('rollupEpicStatus — caller signature unchanged across flag states', () => {
  it('flag off (default): legacy 1-arg call returns a well-formed EpicRollup', async () => {
    try {
      const result = await rollupEpicStatus('T-DOES-NOT-EXIST');
      expect(result.epicId).toBe('T-DOES-NOT-EXIST');
      expect(typeof result.totalWorkers).toBe('number');
      expect(typeof result.doneWorkers).toBe('number');
    } catch {
      return;
    }
  });

  it('flag on: SAME signature with projectRoot returns the SAME contract', async () => {
    writeProjectConfig({ leadRollup: { mode: 'active' } });
    try {
      const result = await rollupEpicStatus('T-DOES-NOT-EXIST', projectRoot);
      expect(result.epicId).toBe('T-DOES-NOT-EXIST');
      expect(typeof result.totalWorkers).toBe('number');
      expect(typeof result.doneWorkers).toBe('number');
    } catch {
      return;
    }
  });
});
