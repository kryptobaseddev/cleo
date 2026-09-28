/**
 * The pgid-fallback notice is platform-aware (T12621).
 *
 * `[cleo:spawn-wrapper] systemd-run unavailable` printed on every macOS run,
 * where pgid IS the expected mode, and read to the agent in agentmbx T083 like
 * the cause of an unrelated deadline failure. It must be silent off Linux and,
 * on Linux, appear at most once and only under `CLEO_DEBUG`.
 *
 * The notice is latched in module state, so each case loads a fresh module.
 *
 * @task T12621
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

async function noticesFor(platform: NodeJS.Platform, calls: number): Promise<number> {
  setPlatform(platform);
  vi.resetModules();
  const wrapper = await import('../spawn-wrapper.js');
  wrapper._forceSystemdRunAvailable(false);
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    for (let i = 0; i < calls; i++) wrapper.buildSpawnArgs('node', ['--version']);
    return write.mock.calls.filter(([chunk]) => String(chunk).includes('systemd-run unavailable'))
      .length;
  } finally {
    write.mockRestore();
    wrapper._forceSystemdRunAvailable(undefined);
  }
}

describe('systemd-run fallback notice (T12621)', () => {
  beforeEach(() => {
    vi.stubEnv('CLEO_DEBUG', '');
  });

  afterEach(() => {
    setPlatform(realPlatform);
    vi.unstubAllEnvs();
  });

  it('is silent on darwin, even under CLEO_DEBUG', async () => {
    expect(await noticesFor('darwin', 3)).toBe(0);
    vi.stubEnv('CLEO_DEBUG', '1');
    expect(await noticesFor('darwin', 3)).toBe(0);
  });

  it('is silent on win32', async () => {
    vi.stubEnv('CLEO_DEBUG', '1');
    expect(await noticesFor('win32', 3)).toBe(0);
  });

  it('is silent on linux without CLEO_DEBUG', async () => {
    expect(await noticesFor('linux', 3)).toBe(0);
  });

  it('appears once on linux under CLEO_DEBUG', async () => {
    vi.stubEnv('CLEO_DEBUG', '1');
    expect(await noticesFor('linux', 3)).toBe(1);
  });
});
