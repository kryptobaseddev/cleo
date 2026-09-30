/**
 * Cross-platform shape of the CLEO dir resolvers (T12602 · T12608).
 *
 * `process.platform` is stubbed to each OS: env-paths reads it on every call,
 * so the macOS and Windows shapes are exercised on any host. Values are
 * compared against `getCleoHome()` rather than literals where the host's
 * `path.join` separator would otherwise leak into the expectation.
 *
 * @task T12602
 * @task T12608
 */

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCleoHome,
  getCleoPlatformPaths,
  getCleoStateDir,
  resolveSyncReplicaRegistryPath,
} from '../cleo-paths.js';
import { expandTildePath } from '../platform-paths.js';
import { getCleoWorktreesRoot } from '../worktree-paths.js';

const PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform');

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(() => {
  vi.stubEnv('CLEO_HOME', undefined);
  vi.stubEnv('CLEO_CONFIG_HOME', undefined);
});

afterEach(() => {
  if (PLATFORM) Object.defineProperty(process, 'platform', PLATFORM);
  vi.unstubAllEnvs();
});

describe('getCleoHome / getCleoWorktreesRoot per platform', () => {
  it('macOS: rooted at ~/Library/Application Support/cleo, not ~/.local/share', () => {
    stubPlatform('darwin');
    vi.stubEnv('XDG_DATA_HOME', '/xdg/data');
    expect(getCleoHome()).toBe(join(homedir(), 'Library', 'Application Support', 'cleo'));
    expect(getCleoWorktreesRoot()).toBe(join(getCleoHome(), 'worktrees'));
    expect(getCleoWorktreesRoot()).not.toContain('.local');
  });

  it('Windows: rooted at %LOCALAPPDATA%/cleo/Data', () => {
    stubPlatform('win32');
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\me\\AppData\\Local');
    expect(getCleoHome().startsWith('C:\\Users\\me\\AppData\\Local')).toBe(true);
    expect(getCleoHome()).toContain('Data');
    expect(getCleoWorktreesRoot()).toBe(join(getCleoHome(), 'worktrees'));
  });

  it('Linux: honours XDG_DATA_HOME', () => {
    stubPlatform('linux');
    vi.stubEnv('XDG_DATA_HOME', '/xdg/data');
    expect(getCleoHome()).toBe(join('/xdg/data', 'cleo'));
    expect(getCleoWorktreesRoot()).toBe(join('/xdg/data', 'cleo', 'worktrees'));
  });
});

describe('getCleoStateDir', () => {
  it('macOS: <getCleoHome()>/state', () => {
    stubPlatform('darwin');
    vi.stubEnv('XDG_STATE_HOME', '/xdg/state');
    expect(getCleoStateDir()).toBe(join(getCleoHome(), 'state'));
  });

  it('Windows: <getCleoHome()>/state', () => {
    stubPlatform('win32');
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\me\\AppData\\Local');
    expect(getCleoStateDir()).toBe(join(getCleoHome(), 'state'));
  });

  it('Linux: $XDG_STATE_HOME/cleo', () => {
    stubPlatform('linux');
    vi.stubEnv('XDG_STATE_HOME', '/xdg/state');
    expect(getCleoStateDir()).toBe(join('/xdg/state', 'cleo'));
  });

  it('follows a CLEO_HOME override off Linux', () => {
    stubPlatform('darwin');
    vi.stubEnv('CLEO_HOME', '/opt/cleo');
    expect(getCleoStateDir()).toBe(join('/opt/cleo', 'state'));
  });
});

describe('resolveSyncReplicaRegistryPath (T12342, N6)', () => {
  it('lives in the machine-local state dir, named by the device id', () => {
    stubPlatform('linux');
    vi.stubEnv('XDG_STATE_HOME', '/xdg/state');
    expect(resolveSyncReplicaRegistryPath('dev-1')).toBe(
      join('/xdg/state', 'cleo', 'sync', 'replicas-dev-1.json'),
    );
    stubPlatform('darwin');
    vi.stubEnv('CLEO_HOME', '/opt/cleo');
    expect(resolveSyncReplicaRegistryPath('dev-1')).toBe(
      join('/opt/cleo', 'state', 'sync', 'replicas-dev-1.json'),
    );
  });

  it('refuses a device id that is not a plain identifier', () => {
    expect(() => resolveSyncReplicaRegistryPath('../x')).toThrow(/invalid device id/);
    expect(() => resolveSyncReplicaRegistryPath('')).toThrow(/invalid device id/);
  });
});

describe('getCleoPlatformPaths().config per platform', () => {
  it('macOS config dir is under ~/Library/Preferences, not ~/.config', () => {
    stubPlatform('darwin');
    vi.stubEnv('XDG_CONFIG_HOME', '/xdg/config');
    expect(getCleoPlatformPaths().config).toBe(join(homedir(), 'Library', 'Preferences', 'cleo'));
  });
});

describe('expandTildePath', () => {
  it('expands ~ and ~/x against the given home', () => {
    expect(expandTildePath('~', '/home/me')).toBe('/home/me');
    expect(expandTildePath('~/a/b.cant', '/home/me')).toBe(join('/home/me', 'a/b.cant'));
  });

  it('expands ~\\x on Windows', () => {
    stubPlatform('win32');
    const out = expandTildePath('~\\proj\\a.cant', 'C:\\Users\\me');
    expect(out.startsWith('C:\\Users\\me')).toBe(true);
    expect(out).not.toContain('~');
  });

  it('leaves ~\\x alone on POSIX, where \\ is a filename character', () => {
    stubPlatform('linux');
    expect(expandTildePath('~\\a', '/home/me')).toBe('~\\a');
  });

  it('leaves ~user and non-leading ~ alone', () => {
    expect(expandTildePath('~bob/x', '/home/me')).toBe('~bob/x');
    expect(expandTildePath('a/~/b', '/home/me')).toBe('a/~/b');
  });

  it('defaults to os.homedir(), so an unset HOME (Windows) still yields an absolute path', () => {
    // process.env.HOME ?? '' is the shape this replaces: with HOME unset it
    // turned `~/x` into the relative path `x`.
    vi.stubEnv('HOME', undefined);
    const out = expandTildePath('~/x.cant');
    expect(isAbsolute(out)).toBe(true);
    expect(out).toBe(join(homedir(), 'x.cant'));
  });
});
