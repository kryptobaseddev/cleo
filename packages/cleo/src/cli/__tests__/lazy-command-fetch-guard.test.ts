/**
 * Loading any CLI command installs the retired-host fetch guard (T13169), so
 * no command can call a SignalDock host, whichever code path it takes.
 *
 * @task T13169
 */

import type { CommandDef } from 'citty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lazyCommand } from '../lazy-command.js';

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lazyCommand installs the retired-host fetch guard (T13169)', () => {
  it('a command loaded through lazyCommand cannot reach SignalDock through the global fetch', async () => {
    const loaded: CommandDef = { meta: { name: 'probe' }, args: {} };
    const command = lazyCommand({ name: 'probe', description: 'probe' }, async () => loaded);
    expect(typeof command.args).toBe('function');
    if (typeof command.args === 'function') await command.args();

    await expect(fetch('https://api.signaldock.io/health')).rejects.toMatchObject({
      code: 'E_SIGNALDOCK_RETIRED',
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    await fetch('https://relay.example.test/health');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
