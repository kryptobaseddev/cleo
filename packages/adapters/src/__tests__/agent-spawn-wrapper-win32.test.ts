/**
 * T12604 — agent spawns must not route through `sh` on Windows.
 *
 * `buildAgentSpawnArgs` wrapped the agent binary in `sh -c 'ulimit -c 0; …'`
 * whenever systemd-run was absent, so no agent could be spawned on Windows.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  _forceSystemdRunAvailable,
  buildAgentSpawnArgs,
} from '../providers/shared/agent-spawn-wrapper.js';

const realPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

afterEach(() => {
  setPlatform(realPlatform);
  _forceSystemdRunAvailable(false);
});

describe('buildAgentSpawnArgs pgid fallback per platform (T12604)', () => {
  it('spawns the agent binary directly on win32', () => {
    setPlatform('win32');
    _forceSystemdRunAvailable(false);
    const built = buildAgentSpawnArgs('claude', ['--print', 'prompt.txt'], 'T1');
    expect(built.command).toBe('claude');
    expect(built.args).toEqual(['--print', 'prompt.txt']);
    expect(built.ownership.mode).toBe('pgid');
  });

  it('keeps ulimit core suppression on POSIX', () => {
    setPlatform('linux');
    _forceSystemdRunAvailable(false);
    const built = buildAgentSpawnArgs('claude', ['--print'], 'T1');
    expect(built.command).toBe('sh');
    expect(built.args.slice(0, 2)).toEqual(['-c', 'ulimit -c 0; exec "$@"']);
  });
});
