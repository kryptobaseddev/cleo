/**
 * The cleo-cant-bridge extension resolves its global and user CANT tiers
 * through `@cleocode/paths` (T12602).
 *
 * It used `$XDG_DATA_HOME ?? ~/.local/share` and `$XDG_CONFIG_HOME ?? ~/.config`
 * on every OS, which are not CLEO's dirs on macOS or Windows. When the paths
 * module cannot be loaded it now drops those tiers instead of guessing.
 *
 * @task T12602
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCleoPaths, resolveThreeTierPaths } from '../extensions/cleo-cant-bridge.js';

const PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform');

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

afterEach(() => {
  if (PLATFORM) Object.defineProperty(process, 'platform', PLATFORM);
  vi.unstubAllEnvs();
});

describe('cleo-cant-bridge resolveThreeTierPaths (T12602)', () => {
  it('macOS: global and user tiers are under ~/Library, not the XDG dirs', async () => {
    stubPlatform('darwin');
    vi.stubEnv('CLEO_HOME', undefined);
    vi.stubEnv('CLEO_CONFIG_HOME', undefined);
    vi.stubEnv('XDG_DATA_HOME', '/xdg/data');
    vi.stubEnv('XDG_CONFIG_HOME', '/xdg/config');

    const paths = resolveThreeTierPaths('/my/project', await loadCleoPaths());

    expect(paths.global).toBe(join(homedir(), 'Library', 'Application Support', 'cleo', 'cant'));
    expect(paths.user).toBe(join(homedir(), 'Library', 'Preferences', 'cleo', 'cant'));
    expect(paths.project).toBe(join('/my/project', '.cleo', 'cant'));
  });

  it('Windows: global tier is under %LOCALAPPDATA%', async () => {
    stubPlatform('win32');
    vi.stubEnv('CLEO_HOME', undefined);
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\me\\AppData\\Local');
    vi.stubEnv('XDG_DATA_HOME', '/xdg/data');

    const paths = resolveThreeTierPaths('/my/project', await loadCleoPaths());

    expect(paths.global?.startsWith('C:\\Users\\me\\AppData\\Local')).toBe(true);
    expect(paths.global).not.toContain('/xdg/data');
  });

  it('drops the global and user tiers when @cleocode/paths is unavailable', () => {
    const paths = resolveThreeTierPaths('/my/project', null);
    expect(paths.global).toBeNull();
    expect(paths.user).toBeNull();
    expect(paths.project).toBe(join('/my/project', '.cleo', 'cant'));
  });
});
