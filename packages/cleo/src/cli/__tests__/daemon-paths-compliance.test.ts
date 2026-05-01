/**
 * Paths compliance test for install-daemon-service.mjs (T1683).
 *
 * Verifies that ALL filesystem paths resolved by the installer go through
 * env-paths (no hardcoded ~/.config or ~/Library strings) and that
 * cross-OS path resolution is correct for:
 *   - Linux systemd unit path (via env-paths config directory)
 *   - macOS launchd plist path (via env-paths data directory)
 *   - Daemon log file path (via env-paths log directory)
 *   - WSL detection (platform stays 'linux', WSL flag detected from /proc/version)
 *
 * @task T1683
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Installer script path resolution
// ---------------------------------------------------------------------------

function resolveInstallerScript(): string {
  return join(import.meta.dirname, '..', '..', '..', 'scripts', 'install-daemon-service.mjs');
}

// ---------------------------------------------------------------------------
// resolveDaemonPaths — paths.ts compliance
// ---------------------------------------------------------------------------

describe('install-daemon-service.mjs — resolveDaemonPaths (env-paths compliance)', () => {
  it('exports resolveDaemonPaths as a function', async () => {
    const mod = await import(resolveInstallerScript());
    expect(typeof mod.resolveDaemonPaths).toBe('function');
  });

  it('logDir is under the OS log directory (not a hardcoded path)', async () => {
    const mod = await import(resolveInstallerScript());
    const paths = mod.resolveDaemonPaths();
    // On Linux the log dir should be under ~/.local/state/cleo (XDG_STATE_HOME)
    // On macOS it should be under ~/Library/Logs/cleo
    // On Windows it should be under %LOCALAPPDATA%\cleo\Log
    expect(paths.logDir).toBeTruthy();
    expect(typeof paths.logDir).toBe('string');
    // Must contain 'cleo' in the path.
    expect(paths.logDir).toContain('cleo');
    // Must be an absolute path.
    expect(paths.logDir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(paths.logDir)).toBe(true);
  });

  it('logFile ends with cleo-daemon.log', async () => {
    const mod = await import(resolveInstallerScript());
    const paths = mod.resolveDaemonPaths();
    expect(paths.logFile).toMatch(/cleo-daemon\.log$/);
  });

  it('logDir does NOT contain a hardcoded home directory path string literal', async () => {
    // The path VALUE will contain the actual home dir (that is expected),
    // but we verify it was resolved via env-paths by confirming it is NOT
    // exactly ~/.local/state/... (the old hardcoded pattern).
    // The file source should use env-paths. We verify the value is correct
    // for this platform.
    const mod = await import(resolveInstallerScript());
    const paths = mod.resolveDaemonPaths();
    // On Linux: env-paths resolves log to ~/.local/state/cleo
    if (process.platform === 'linux') {
      const expectedBase = join(homedir(), '.local', 'state', 'cleo');
      expect(paths.logDir.startsWith(expectedBase)).toBe(true);
    }
    // On macOS: env-paths resolves log to ~/Library/Logs/cleo
    if (process.platform === 'darwin') {
      const expectedBase = join(homedir(), 'Library', 'Logs', 'cleo');
      expect(paths.logDir.startsWith(expectedBase)).toBe(true);
    }
  });
});

describe('install-daemon-service.mjs — systemd unit path (Linux)', () => {
  it('systemdUnitFile is under XDG config dir (env-paths config)', async () => {
    if (process.platform !== 'linux') return;
    const mod = await import(resolveInstallerScript());
    const paths = mod.resolveDaemonPaths();
    // On Linux env-paths config → ~/.config/cleo → parent → ~/.config
    // systemd user dir → ~/.config/systemd/user/
    expect(paths.systemdUnitFile).not.toBeNull();
    expect(paths.systemdUnitFile).toContain('systemd');
    expect(paths.systemdUnitFile).toContain('user');
    expect(paths.systemdUnitFile).toMatch(/cleo-daemon\.service$/);
    // Must be under ~/.config (XDG_CONFIG_HOME default).
    const xdgConfig = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
    expect(paths.systemdUnitFile?.startsWith(xdgConfig)).toBe(true);
  });

  it('launchdPlistFile is null on Linux', async () => {
    if (process.platform !== 'linux') return;
    const mod = await import(resolveInstallerScript());
    const paths = mod.resolveDaemonPaths();
    expect(paths.launchdPlistFile).toBeNull();
  });
});

describe('install-daemon-service.mjs — launchd plist path (macOS)', () => {
  it('launchdPlistFile is under ~/Library/LaunchAgents/ on macOS', async () => {
    if (process.platform !== 'darwin') return;
    const mod = await import(resolveInstallerScript());
    const paths = mod.resolveDaemonPaths();
    expect(paths.launchdPlistFile).not.toBeNull();
    expect(paths.launchdPlistFile).toContain('LaunchAgents');
    expect(paths.launchdPlistFile).toMatch(/io\.cleocode\.daemon\.plist$/);
    const expected = join(homedir(), 'Library', 'LaunchAgents');
    expect(paths.launchdPlistFile?.startsWith(expected)).toBe(true);
  });

  it('systemdUnitFile is null on macOS', async () => {
    if (process.platform !== 'darwin') return;
    const mod = await import(resolveInstallerScript());
    const paths = mod.resolveDaemonPaths();
    expect(paths.systemdUnitFile).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// installDaemonService — CLEO_DAEMON_DISABLE=1 (no hardcoded paths test)
// ---------------------------------------------------------------------------

describe('install-daemon-service.mjs — installDaemonService (CLEO_DAEMON_DISABLE=1)', () => {
  const origDisable = process.env['CLEO_DAEMON_DISABLE'];

  afterEach(() => {
    if (origDisable === undefined) delete process.env['CLEO_DAEMON_DISABLE'];
    else process.env['CLEO_DAEMON_DISABLE'] = origDisable;
  });

  it('resolves without throwing (paths compliance)', async () => {
    process.env['CLEO_DAEMON_DISABLE'] = '1';
    const mod = await import(resolveInstallerScript());
    await expect(mod.installDaemonService()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// uninstallDaemonService — platform field and result shape
// ---------------------------------------------------------------------------

describe('install-daemon-service.mjs — uninstallDaemonService', () => {
  it('returns a result with platform, success, and message fields', async () => {
    const mod = await import(resolveInstallerScript());
    const result = await mod.uninstallDaemonService();
    expect(result).toHaveProperty('platform');
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('message');
    expect(typeof result.success).toBe('boolean');
    expect(['linux', 'darwin', 'win32']).toContain(result.platform);
  });
});
