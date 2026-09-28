/**
 * T12604 — the pgid fallback must not route through `sh` on Windows.
 *
 * `buildSpawnArgs` used to wrap every command as `sh -c 'ulimit -c 0; exec "$@"'`
 * whenever systemd-run was absent (all of macOS and Windows). Windows has no
 * `sh`, so every heavy-tool evidence run died with ENOENT. The platform is
 * injected by redefining `process.platform`, so this runs on any host.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { _forceSystemdRunAvailable, buildSpawnArgs } from '../spawn-wrapper.js';

const realPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

afterEach(() => {
  setPlatform(realPlatform);
  _forceSystemdRunAvailable(undefined);
});

describe('buildSpawnArgs pgid fallback per platform (T12604)', () => {
  it('spawns the command directly on win32 even with noCoreFile=true (the default)', () => {
    setPlatform('win32');
    _forceSystemdRunAvailable(false);
    const built = buildSpawnArgs('node', ['--version']);
    expect(built).toEqual({ command: 'node', args: ['--version'], mode: 'pgid' });
  });

  it('keeps ulimit core suppression on POSIX', () => {
    setPlatform('darwin');
    _forceSystemdRunAvailable(false);
    const built = buildSpawnArgs('node', ['--version']);
    expect(built.command).toBe('sh');
    expect(built.args).toEqual(['-c', 'ulimit -c 0; exec "$@"', 'sh', 'node', '--version']);
  });
});
