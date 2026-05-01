/**
 * Tests for the public SDK daemon control API (T1683).
 *
 * Covers:
 *   - installDaemon, uninstallDaemon, updateDaemon, getDaemonStatus,
 *     startDaemon, stopDaemon are all exported from @cleocode/core
 *   - getDaemonStatus returns the expected shape
 *   - InstallDaemonOptions, DaemonStatus, DaemonInstallResult types present
 *
 * @task T1683
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Import from the module under test (not from @cleocode/core barrel to avoid
// full package init in test environment)
// ---------------------------------------------------------------------------

import { SENTIENT_STATE_FILE } from '../daemon.js';
import {
  type DaemonInstallResult,
  type DaemonStatus,
  getDaemonStatus,
  type InstallDaemonOptions,
  installDaemon,
  startDaemon,
  stopDaemon,
  uninstallDaemon,
  updateDaemon,
} from '../daemon-api.js';
import { DEFAULT_SENTIENT_STATE, writeSentientState } from '../state.js';

// ---------------------------------------------------------------------------
// Export presence
// ---------------------------------------------------------------------------

describe('daemon-api.ts — export presence', () => {
  it('exports installDaemon as a function', () => {
    expect(typeof installDaemon).toBe('function');
  });

  it('exports uninstallDaemon as a function', () => {
    expect(typeof uninstallDaemon).toBe('function');
  });

  it('exports updateDaemon as a function', () => {
    expect(typeof updateDaemon).toBe('function');
  });

  it('exports getDaemonStatus as a function', () => {
    expect(typeof getDaemonStatus).toBe('function');
  });

  it('exports startDaemon as a function', () => {
    expect(typeof startDaemon).toBe('function');
  });

  it('exports stopDaemon as a function', () => {
    expect(typeof stopDaemon).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// getDaemonStatus — shape validation
// ---------------------------------------------------------------------------

describe('getDaemonStatus — response shape', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cleo-t1683-api-'));
    const statePath = join(root, SENTIENT_STATE_FILE);
    await writeSentientState(statePath, DEFAULT_SENTIENT_STATE);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns an object with required DaemonStatus fields', async () => {
    const status: DaemonStatus = await getDaemonStatus(root);
    expect(status).toHaveProperty('running');
    expect(status).toHaveProperty('pid');
    expect(status).toHaveProperty('uptime');
    expect(status).toHaveProperty('lastHygieneRun');
    expect(status).toHaveProperty('lastDreamCycle');
    expect(status).toHaveProperty('supervisesStudio');
    expect(status).toHaveProperty('studioStatus');
    expect(status).toHaveProperty('sentient');
  });

  it('running is false when no live daemon pid is present', async () => {
    const status = await getDaemonStatus(root);
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
  });

  it('studioStatus is one of the valid StudioStatus values', async () => {
    const status = await getDaemonStatus(root);
    expect(['running', 'stopped', 'crashed', 'disabled']).toContain(status.studioStatus);
  });

  it('supervisesStudio is a boolean', async () => {
    const status = await getDaemonStatus(root);
    expect(typeof status.supervisesStudio).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// installDaemon — CLEO_DAEMON_DISABLE=1 path (no actual service writes)
// ---------------------------------------------------------------------------

describe('installDaemon — with CLEO_DAEMON_DISABLE=1', () => {
  const origDisable = process.env['CLEO_DAEMON_DISABLE'];

  afterEach(() => {
    if (origDisable === undefined) delete process.env['CLEO_DAEMON_DISABLE'];
    else process.env['CLEO_DAEMON_DISABLE'] = origDisable;
  });

  it('resolves to a DaemonInstallResult object even on partial failure', async () => {
    process.env['CLEO_DAEMON_DISABLE'] = '1';
    const result: DaemonInstallResult = await installDaemon({ scope: 'user' });
    // installDaemon never throws — errors become result.success=false.
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('platform');
    expect(result).toHaveProperty('filePath');
    expect(result).toHaveProperty('message');
    expect(typeof result.success).toBe('boolean');
    expect(typeof result.platform).toBe('string');
    expect(typeof result.message).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// uninstallDaemon — shape
// ---------------------------------------------------------------------------

describe('uninstallDaemon — response shape', () => {
  it('returns a DaemonInstallResult object', async () => {
    const result: DaemonInstallResult = await uninstallDaemon();
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('platform');
    expect(result).toHaveProperty('filePath');
    expect(result).toHaveProperty('message');
  });
});

// ---------------------------------------------------------------------------
// InstallDaemonOptions — scope: 'system' is not implemented
// ---------------------------------------------------------------------------

describe('installDaemon — scope: system', () => {
  it('returns success=false for system scope (not implemented)', async () => {
    const opts: InstallDaemonOptions = { scope: 'system' };
    const result = await installDaemon(opts);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not yet implemented/i);
  });
});
