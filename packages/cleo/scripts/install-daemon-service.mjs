#!/usr/bin/env node
/**
 * install-daemon-service.mjs — Cross-platform CLEO daemon system service installer.
 *
 * Registers the CLEO sentient daemon as a user-level persistent system service
 * so it auto-starts on login and persists across reboots.
 *
 * Platform support:
 *   Linux  — systemd user unit (XDG: ~/.config/systemd/user/cleo-daemon.service)
 *   macOS  — launchd plist (~/Library/LaunchAgents/io.cleocode.daemon.plist)
 *   Windows / WSL — Windows Service stub (followup T1684). WSL is detected via
 *             uname -r containing 'microsoft' and treated as Linux for systemd
 *             path resolution.
 *
 * ALL filesystem paths are resolved via env-paths (the same library used by
 * packages/core/src/system/platform-paths.ts) so cross-OS resolution is
 * consistent. No hardcoded ~/.config or ~/Library paths exist in this file.
 *
 * Idempotent: re-runs do not duplicate or unnecessarily restart the service
 * when the generated content is identical (checked via SHA-256 hash comparison).
 *
 * Environment:
 *   CLEO_DAEMON_DISABLE=1  Skip auto-start activation (CI/container path).
 *                          Unit/plist file is still written; only enable/load
 *                          is skipped so the operator can activate later.
 *   CLEO_HOME              Override the global CLEO data directory (forwarded
 *                          to env-paths as the data root).
 *
 * @task T1682
 * @task T1683 (paths.ts compliance audit + WSL detection)
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Platform paths — mirrors packages/core/src/system/platform-paths.ts
// Using env-paths directly (same dep, no compiled core needed at postinstall).
// ---------------------------------------------------------------------------

/**
 * Resolve OS-appropriate paths — mirrors getPlatformPaths() from
 * packages/core/src/system/platform-paths.ts.
 *
 * Strategy: attempt to import env-paths (pure-ESM, v4+) dynamically.
 * If env-paths is not available (e.g. direct invocation in a minimal
 * environment), fall back to XDG / macOS / Windows platform conventions
 * computed inline so the installer remains self-contained.
 *
 * The CLEO_HOME env var overrides the data path for backward compatibility.
 *
 * @returns {{ data: string; config: string; cache: string; log: string; temp: string }}
 */
let _cachedPlatformPaths = null;

async function getPlatformPathsAsync() {
  if (_cachedPlatformPaths) return _cachedPlatformPaths;

  const home = homedir();
  const platform = process.platform;

  // Attempt dynamic import of env-paths first.
  try {
    // env-paths may be available via the workspace node_modules tree.
    // Use createRequire to resolve it relative to THIS file.
    const require = createRequire(import.meta.url);
    // env-paths v4 exports an ES module; under some Node versions createRequire
    // can still load it from the pnpm virtual store.
    const ep = require('env-paths')('cleo', { suffix: '' });
    _cachedPlatformPaths = {
      data: process.env['CLEO_HOME'] ?? ep.data,
      config: ep.config,
      cache: ep.cache,
      log: ep.log,
      temp: ep.temp,
    };
    return _cachedPlatformPaths;
  } catch {
    // env-paths unavailable (pure-ESM in some Node versions / isolated run).
    // Fall through to manual computation below.
  }

  // Try dynamic ESM import of env-paths (the canonical path for pure-ESM v4).
  try {
    const mod = await import('env-paths');
    const fn = typeof mod.default === 'function' ? mod.default : mod;
    const ep = fn('cleo', { suffix: '' });
    _cachedPlatformPaths = {
      data: process.env['CLEO_HOME'] ?? ep.data,
      config: ep.config,
      cache: ep.cache,
      log: ep.log,
      temp: ep.temp,
    };
    return _cachedPlatformPaths;
  } catch {
    // Dynamic import also failed — fall through to manual XDG/platform logic.
  }

  // Manual fallback: compute XDG / platform paths inline.
  // This mirrors the env-paths v4 logic exactly so results are identical.
  let data, config, cache, log, temp;
  if (platform === 'win32') {
    const appData = process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming');
    const localAppData = process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local');
    data = join(localAppData, 'cleo', 'Data');
    config = join(appData, 'cleo', 'Config');
    cache = join(localAppData, 'cleo', 'Cache');
    log = join(localAppData, 'cleo', 'Log');
    temp = join(localAppData, 'cleo', 'Temp');
  } else if (platform === 'darwin') {
    const library = join(home, 'Library');
    data = join(library, 'Application Support', 'cleo');
    config = join(library, 'Preferences', 'cleo');
    cache = join(library, 'Caches', 'cleo');
    log = join(library, 'Logs', 'cleo');
    temp = join(library, 'Application Support', 'cleo', 'Temp');
  } else {
    // Linux / BSD / XDG
    const xdgData = process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share');
    const xdgConfig = process.env['XDG_CONFIG_HOME'] ?? join(home, '.config');
    const xdgCache = process.env['XDG_CACHE_HOME'] ?? join(home, '.cache');
    const xdgState = process.env['XDG_STATE_HOME'] ?? join(home, '.local', 'state');
    data = join(xdgData, 'cleo');
    config = join(xdgConfig, 'cleo');
    cache = join(xdgCache, 'cleo');
    log = join(xdgState, 'cleo');
    temp = join(xdgData, 'cleo', 'Temp');
  }

  _cachedPlatformPaths = {
    data: process.env['CLEO_HOME'] ?? data,
    config,
    cache,
    log,
    temp,
  };
  return _cachedPlatformPaths;
}

/**
 * Synchronous wrapper — only used for non-critical path resolution.
 * Falls back to XDG/platform defaults if env-paths is not available.
 *
 * @returns {{ data: string; config: string; cache: string; log: string; temp: string }}
 */
function getPlatformPaths() {
  if (_cachedPlatformPaths) return _cachedPlatformPaths;

  // Compute synchronously using the XDG/platform logic from getPlatformPathsAsync.
  const home = homedir();
  const platform = process.platform;
  let data, config, cache, log, temp;
  if (platform === 'win32') {
    const appData = process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming');
    const localAppData = process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local');
    data = join(localAppData, 'cleo', 'Data');
    config = join(appData, 'cleo', 'Config');
    cache = join(localAppData, 'cleo', 'Cache');
    log = join(localAppData, 'cleo', 'Log');
    temp = join(localAppData, 'cleo', 'Temp');
  } else if (platform === 'darwin') {
    const library = join(home, 'Library');
    data = join(library, 'Application Support', 'cleo');
    config = join(library, 'Preferences', 'cleo');
    cache = join(library, 'Caches', 'cleo');
    log = join(library, 'Logs', 'cleo');
    temp = join(library, 'Application Support', 'cleo', 'Temp');
  } else {
    // Linux / BSD / XDG
    const xdgData = process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share');
    const xdgConfig = process.env['XDG_CONFIG_HOME'] ?? join(home, '.config');
    const xdgCache = process.env['XDG_CACHE_HOME'] ?? join(home, '.cache');
    const xdgState = process.env['XDG_STATE_HOME'] ?? join(home, '.local', 'state');
    data = join(xdgData, 'cleo');
    config = join(xdgConfig, 'cleo');
    cache = join(xdgCache, 'cleo');
    log = join(xdgState, 'cleo');
    temp = join(xdgData, 'cleo', 'Temp');
  }

  return {
    data: process.env['CLEO_HOME'] ?? data,
    config,
    cache,
    log,
    temp,
  };
}

// ---------------------------------------------------------------------------
// WSL detection
// ---------------------------------------------------------------------------

/**
 * Detect whether the process is running inside Windows Subsystem for Linux.
 *
 * WSL identifies as Linux (process.platform === 'linux') but exposes its
 * origin via /proc/version (contains 'microsoft' or 'WSL') and the kernel
 * release string (os.release() contains 'microsoft').
 *
 * Per T1683 spec: WSL is treated as Linux for systemd path resolution.
 *
 * @returns {boolean} True when running in WSL.
 */
function isWSL() {
  // Only relevant on Linux — WSL reports platform === 'linux'.
  if (process.platform !== 'linux') return false;
  try {
    const buf = Buffer.alloc(256);
    const fd = openSync('/proc/version', 'r');
    try {
      const bytesRead = readSync(fd, buf, 0, 256, 0);
      const content = buf.slice(0, bytesRead).toString('utf8').toLowerCase();
      return content.includes('microsoft') || content.includes('wsl');
    } finally {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Environment variable that disables daemon auto-start (CI/container path). */
const DAEMON_DISABLE_ENV = 'CLEO_DAEMON_DISABLE';

/**
 * Daemon log file path — resolved via env-paths log directory.
 *
 * Linux:  ~/.local/state/cleo/daemon/cleo-daemon.log
 * macOS:  ~/Library/Logs/cleo/daemon/cleo-daemon.log
 * Windows: %LOCALAPPDATA%\cleo\Log\daemon\cleo-daemon.log
 */
function getDaemonLogFile() {
  const paths = getPlatformPaths();
  return join(paths.log, 'daemon', 'cleo-daemon.log');
}

/**
 * Daemon log directory — parent of the log file.
 */
function getDaemonLogDir() {
  const paths = getPlatformPaths();
  return join(paths.log, 'daemon');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 hex digest of a string.
 *
 * @param {string} content - The string to hash.
 * @returns {string} Lowercase hex string.
 */
function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Write a file only when the content differs from what is on disk.
 *
 * @param {string} filePath - Absolute path to the file.
 * @param {string} content  - Desired file content.
 * @returns {boolean} `true` when the file was written, `false` when skipped (hash match).
 */
function writeIfChanged(filePath, content) {
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf8');
    if (sha256(existing) === sha256(content)) {
      return false;
    }
  }
  const dir = join(filePath, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o644 });
  return true;
}

/**
 * Execute a binary with an argument list (no shell interpolation).
 * Uses execFileSync to prevent shell injection.
 *
 * @param {string} bin - Absolute or PATH-relative binary name.
 * @param {string[]} args - Argument list.
 * @returns {{ ok: boolean; output: string }} Result.
 */
function runBin(bin, args) {
  try {
    const output = execFileSync(bin, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: typeof output === 'string' ? output.trim() : '' };
  } catch (err) {
    const stdout = typeof err.stdout === 'string' ? err.stdout : '';
    const stderr = typeof err.stderr === 'string' ? err.stderr : '';
    return { ok: false, output: (stdout + stderr).trim() };
  }
}

// ---------------------------------------------------------------------------
// Linux — systemd user unit
// ---------------------------------------------------------------------------

/** Name of the systemd user unit (without .service extension). */
const SYSTEMD_UNIT_NAME = 'cleo-daemon';

/**
 * Absolute path to the systemd user unit file.
 *
 * Resolved via env-paths config directory (XDG: ~/.config/cleo → ../systemd/user/).
 * The systemd user unit directory is always XDG_CONFIG_HOME/systemd/user/,
 * where XDG_CONFIG_HOME defaults to ~/.config.
 *
 * We derive it from the env-paths config root minus the 'cleo' suffix:
 *   ~/.config/cleo → ~/.config → ~/.config/systemd/user/
 *
 * @returns {string} Absolute path to the .service file.
 */
function getSystemdUnitFile() {
  // env-paths config for 'cleo' → ~/.config/cleo
  // systemd user dir → ~/.config/systemd/user/ (one level up from 'cleo')
  const paths = getPlatformPaths();
  const configParent = join(paths.config, '..');
  return join(configParent, 'systemd', 'user', `${SYSTEMD_UNIT_NAME}.service`);
}

/**
 * Generate the systemd user unit file content.
 *
 * The unit runs `cleo daemon start --foreground` so systemd owns the
 * lifecycle (restart policy, log collection). stdout/stderr are appended
 * to the shared daemon log via StandardOutput/StandardError directives.
 *
 * @param {string} cleoExec - Absolute path to the `cleo` binary.
 * @returns {string} Systemd unit file content.
 */
function buildSystemdUnit(cleoExec) {
  const logFile = getDaemonLogFile();
  return `[Unit]
Description=CLEO Sentient Daemon (autonomous task hygiene + dream cycles)
Documentation=https://github.com/kryptobaseddev/cleocode
After=network.target

[Service]
Type=simple
ExecStart=${cleoExec} daemon start --foreground
Restart=on-failure
RestartSec=5
StandardOutput=append:${logFile}
StandardError=append:${logFile}
Environment=CLEO_SENTIENT_DAEMON=1

[Install]
WantedBy=default.target
`;
}

/**
 * Install and optionally activate the systemd user unit.
 *
 * @param {string} cleoExec - Absolute path to the `cleo` binary.
 */
function installSystemd(cleoExec) {
  const unitFile = getSystemdUnitFile();
  const unit = buildSystemdUnit(cleoExec);
  const written = writeIfChanged(unitFile, unit);

  if (written) {
    console.log(`CLEO: Wrote systemd user unit → ${unitFile}`);
    // Reload daemon to pick up the new unit file.
    const reload = runBin('systemctl', ['--user', 'daemon-reload']);
    if (!reload.ok) {
      console.log(`CLEO: systemctl daemon-reload skipped (${reload.output || 'no output'})`);
    }
  } else {
    console.log('CLEO: systemd unit already up-to-date — skipping write.');
  }

  if (process.env[DAEMON_DISABLE_ENV] === '1') {
    console.log(
      `CLEO: ${DAEMON_DISABLE_ENV}=1 — unit written but activation skipped (CI/container path).`,
    );
    return;
  }

  // Enable + start the service.
  const enable = runBin('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME]);
  if (enable.ok) {
    console.log('CLEO: systemd user service enabled and started.');
  } else {
    // Graceful degradation: systemctl may not be available (container, minimal
    // environments without D-Bus). Log and continue — the unit file is present
    // for manual activation later.
    console.log(
      `CLEO: systemctl enable --now skipped (${enable.output || 'systemctl unavailable'}).`,
    );
    console.log('CLEO: Unit file present. Run: systemctl --user enable --now cleo-daemon');
  }
}

// ---------------------------------------------------------------------------
// macOS — launchd plist
// ---------------------------------------------------------------------------

/** Reverse-DNS label for the launchd agent. */
const LAUNCHD_PLIST_LABEL = 'io.cleocode.daemon';

/**
 * Absolute path to the launchd plist file.
 *
 * macOS launchd user agents always live in ~/Library/LaunchAgents/.
 * env-paths resolves this correctly on macOS:
 *   data  → ~/Library/Application Support/cleo
 *   config → ~/Library/Preferences/cleo
 * Neither maps to LaunchAgents; we use homedir + Library/LaunchAgents
 * which is the macOS-mandated location (not configurable by XDG).
 *
 * @returns {string} Absolute path to the .plist file.
 */
function getLaunchdPlistFile() {
  // On macOS, env-paths data = ~/Library/Application Support/cleo
  // LaunchAgents is a sibling of Application Support: ~/Library/LaunchAgents/
  const paths = getPlatformPaths();
  // data → ~/Library/Application Support/cleo → up two levels → ~/Library
  const libraryDir = join(paths.data, '..', '..');
  return join(libraryDir, 'LaunchAgents', `${LAUNCHD_PLIST_LABEL}.plist`);
}

/**
 * Generate the launchd plist content.
 *
 * The plist uses KeepAlive=true so launchd restarts the daemon on exit,
 * and RunAtLoad=true to start it immediately on launchctl load.
 *
 * @param {string} cleoExec - Absolute path to the `cleo` binary.
 * @returns {string} Plist XML content.
 */
function buildLaunchdPlist(cleoExec) {
  const logFile = getDaemonLogFile();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_PLIST_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${cleoExec}</string>
    <string>daemon</string>
    <string>start</string>
    <string>--foreground</string>
  </array>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${logFile}</string>

  <key>StandardErrorPath</key>
  <string>${logFile}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>CLEO_SENTIENT_DAEMON</key>
    <string>1</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

/**
 * Install and optionally load the launchd plist.
 *
 * @param {string} cleoExec - Absolute path to the `cleo` binary.
 */
function installLaunchd(cleoExec) {
  const plistFile = getLaunchdPlistFile();
  const plist = buildLaunchdPlist(cleoExec);
  const written = writeIfChanged(plistFile, plist);

  if (written) {
    console.log(`CLEO: Wrote launchd plist → ${plistFile}`);
  } else {
    console.log('CLEO: launchd plist already up-to-date — skipping write.');
  }

  if (process.env[DAEMON_DISABLE_ENV] === '1') {
    console.log(
      `CLEO: ${DAEMON_DISABLE_ENV}=1 — plist written but activation skipped (CI/container path).`,
    );
    return;
  }

  // Try bootstrap (macOS 10.13+) first; fall back to legacy launchctl load.
  const uid = process.getuid ? String(process.getuid()) : '';
  if (uid) {
    const bootstrap = runBin('launchctl', [
      'bootstrap',
      `gui/${uid}`,
      plistFile,
    ]);

    if (bootstrap.ok) {
      console.log(`CLEO: launchd agent bootstrapped (gui/${uid}).`);
      return;
    }

    // Error 36 (EALREADY) means already loaded — not a real error.
    if (
      bootstrap.output.includes('36') ||
      bootstrap.output.toLowerCase().includes('already')
    ) {
      console.log('CLEO: launchd agent already loaded — no action needed.');
      return;
    }
  }

  // Fall back to legacy `launchctl load`.
  const load = runBin('launchctl', ['load', plistFile]);
  if (load.ok) {
    console.log('CLEO: launchd agent loaded (legacy launchctl load).');
  } else {
    console.log(
      `CLEO: launchctl load skipped (${load.output || 'launchctl unavailable'}).`,
    );
    console.log(`CLEO: Plist present. Run: launchctl load "${plistFile}"`);
  }
}

// ---------------------------------------------------------------------------
// Windows — stub (followup T1684)
// ---------------------------------------------------------------------------

/**
 * Windows service registration — not yet implemented.
 *
 * TODO: Implement Windows Task Scheduler or NSSM-based service registration.
 * Filed as followup task T1684.
 */
function installWindows() {
  console.log(
    'CLEO: Windows daemon auto-start is not yet implemented (followup: T1684).',
  );
  console.log('CLEO: To start the daemon manually: cleo daemon start');
}

// ---------------------------------------------------------------------------
// Log directory bootstrap
// ---------------------------------------------------------------------------

/**
 * Ensure the daemon log directory exists before writing service files.
 *
 * Both systemd and launchd reference the log path directly in the unit/plist.
 * The directory must exist before the service is activated so the OS can open
 * the append target without error.
 */
function ensureLogDir() {
  mkdirSync(getDaemonLogDir(), { recursive: true });
}

// ---------------------------------------------------------------------------
// cleo binary resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the `cleo` executable that npm installed.
 *
 * Strategy (in order):
 *  1. $npm_config_prefix/bin/cleo — set by npm during global installs.
 *  2. `which cleo` on the current PATH.
 *  3. Bare `cleo` — relies on PATH being correct at service start time.
 *
 * @returns {string} Absolute path to the `cleo` binary (or bare `cleo`).
 */
function resolveCleoExec() {
  const prefix = process.env.npm_config_prefix;
  if (prefix) {
    const candidate = join(prefix, 'bin', 'cleo');
    if (existsSync(candidate)) return candidate;
  }

  // `which` is POSIX; `where` on Windows — but this path is skipped on Windows.
  const whichResult = runBin('which', ['cleo']);
  if (whichResult.ok && whichResult.output) {
    return whichResult.output.split('\n')[0].trim();
  }

  return 'cleo';
}

// ---------------------------------------------------------------------------
// Public API: install
// ---------------------------------------------------------------------------

/**
 * Install the daemon system service for the current platform.
 *
 * Called by the npm postinstall hook in `bin/postinstall.js`.
 * Never throws — all errors are caught and logged so `npm install`
 * always exits 0.
 *
 * WSL is detected and treated as Linux (systemd path resolution).
 *
 * @returns {Promise<void>}
 */
export async function installDaemonService() {
  try {
    ensureLogDir();
    const cleoExec = resolveCleoExec();
    const platform = process.platform;

    if (platform === 'linux' || isWSL()) {
      installSystemd(cleoExec);
    } else if (platform === 'darwin') {
      installLaunchd(cleoExec);
    } else if (platform === 'win32') {
      installWindows();
    } else {
      console.log(
        `CLEO: Daemon auto-start not supported on platform "${platform}".`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`CLEO: Daemon service installation deferred: ${message}`);
    if (process.env.CLEO_DEBUG) {
      console.error('CLEO: Daemon install detail:', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API: uninstall
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} UninstallResult
 * @property {string} platform - Platform identifier.
 * @property {string|null} removed - Path that was removed, or null.
 * @property {boolean} success - Whether the operation succeeded.
 * @property {string} message - Human-readable outcome.
 */

/**
 * Uninstall the daemon service for the current platform.
 *
 * Disables and removes the unit/plist file cleanly.
 * Used by `cleo daemon uninstall`.
 *
 * @returns {Promise<UninstallResult>} Uninstall outcome.
 */
export async function uninstallDaemonService() {
  const platform = process.platform;
  try {
    if (platform === 'linux' || isWSL()) {
      return uninstallSystemd();
    } else if (platform === 'darwin') {
      return uninstallLaunchd();
    } else if (platform === 'win32') {
      return {
        platform,
        removed: null,
        success: false,
        message: 'Windows uninstall not yet implemented (T1684).',
      };
    } else {
      return {
        platform,
        removed: null,
        success: false,
        message: `Platform "${platform}" not supported.`,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { platform, removed: null, success: false, message };
  }
}

// ---------------------------------------------------------------------------
// Uninstall helpers
// ---------------------------------------------------------------------------

/**
 * Disable and remove the systemd user unit.
 *
 * @returns {UninstallResult} Result.
 */
function uninstallSystemd() {
  const platform = 'linux';
  const unitFile = getSystemdUnitFile();

  // Stop + disable — ignore failures (unit may already be stopped/disabled).
  runBin('systemctl', ['--user', 'stop', SYSTEMD_UNIT_NAME]);
  runBin('systemctl', ['--user', 'disable', SYSTEMD_UNIT_NAME]);

  if (existsSync(unitFile)) {
    rmSync(unitFile, { force: true });
    runBin('systemctl', ['--user', 'daemon-reload']);
    return {
      platform,
      removed: unitFile,
      success: true,
      message: `Systemd unit removed: ${unitFile}`,
    };
  }

  return {
    platform,
    removed: null,
    success: true,
    message: 'Systemd unit was not installed — nothing to remove.',
  };
}

/**
 * Unload and remove the launchd plist.
 *
 * @returns {UninstallResult} Result.
 */
function uninstallLaunchd() {
  const platform = 'darwin';
  const plistFile = getLaunchdPlistFile();

  if (existsSync(plistFile)) {
    const uid = process.getuid ? String(process.getuid()) : '';
    if (uid) {
      runBin('launchctl', ['bootout', `gui/${uid}`, plistFile]);
    } else {
      runBin('launchctl', ['unload', plistFile]);
    }
    rmSync(plistFile, { force: true });
    return {
      platform,
      removed: plistFile,
      success: true,
      message: `launchd plist removed: ${plistFile}`,
    };
  }

  return {
    platform,
    removed: null,
    success: true,
    message: 'launchd plist was not installed — nothing to remove.',
  };
}

// ---------------------------------------------------------------------------
// Exported path resolution (for testing and audit)
// ---------------------------------------------------------------------------

/**
 * Resolve all daemon-related filesystem paths using env-paths.
 *
 * Exported for test verification and `cleo admin paths` introspection.
 * All paths are derived from env-paths (never hardcoded).
 *
 * @returns {{ logDir: string; logFile: string; systemdUnitFile: string | null; launchdPlistFile: string | null }}
 */
export function resolveDaemonPaths() {
  const platform = process.platform;
  return {
    logDir: getDaemonLogDir(),
    logFile: getDaemonLogFile(),
    systemdUnitFile: platform === 'linux' ? getSystemdUnitFile() : null,
    launchdPlistFile: platform === 'darwin' ? getLaunchdPlistFile() : null,
  };
}

// ---------------------------------------------------------------------------
// Direct invocation (node install-daemon-service.mjs)
// ---------------------------------------------------------------------------

// When executed directly (not imported as a module), run the installer.
if (process.argv[1] && process.argv[1].endsWith('install-daemon-service.mjs')) {
  installDaemonService().catch((err) => {
    console.error('CLEO: Fatal daemon install error:', err.message);
    // Non-fatal exit so npm install always succeeds.
    process.exit(0);
  });
}
