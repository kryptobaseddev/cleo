/**
 * install-daemon-service.mjs resolves its dirs through @cleocode/paths (T12602).
 *
 * The script carried a hand-copied env-paths fallback. Only the pure
 * `resolveDaemonPaths()` is exercised here: nothing is installed, loaded or
 * removed.
 *
 * @task T12602
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { getCleoPlatformPaths } from '@cleocode/paths';
import { afterEach, describe, expect, it, vi } from 'vitest';

const INSTALLER = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'scripts',
  'install-daemon-service.mjs',
);

interface DaemonPaths {
  logDir: string;
  logFile: string;
  systemdUnitFile: string | null;
  launchdPlistFile: string | null;
}

async function resolveDaemonPaths(): Promise<DaemonPaths> {
  const mod = (await import(INSTALLER)) as { resolveDaemonPaths: () => DaemonPaths };
  return mod.resolveDaemonPaths();
}

const PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform');

afterEach(() => {
  if (PLATFORM) Object.defineProperty(process, 'platform', PLATFORM);
  vi.unstubAllEnvs();
});

describe('install-daemon-service.mjs — @cleocode/paths SSoT (T12602)', () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    it(`${platform}: logDir is <getCleoPlatformPaths().log>/daemon`, async () => {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\me\\AppData\\Local');
      expect((await resolveDaemonPaths()).logDir).toBe(join(getCleoPlatformPaths().log, 'daemon'));
    });
  }

  it('darwin: the launchd plist stays in ~/Library/LaunchAgents when CLEO_HOME moves the data dir', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.stubEnv('CLEO_HOME', '/opt/cleo-data');
    expect((await resolveDaemonPaths()).launchdPlistFile).toBe(
      join(homedir(), 'Library', 'LaunchAgents', 'io.cleocode.daemon.plist'),
    );
  });
});
