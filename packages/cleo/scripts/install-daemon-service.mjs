#!/usr/bin/env node
/**
 * install-daemon-service.mjs — Cross-platform CLEO daemon system service installer.
 *
 * Registers the CLEO sentient daemon as a user-level persistent system service
 * so it auto-starts on login and persists across reboots.
 *
 * Platform support:
 *   Linux  — systemd user unit (~/.config/systemd/user/cleo-daemon.service)
 *   macOS  — launchd plist (~/Library/LaunchAgents/io.cleocode.daemon.plist)
 *   Windows — TODO: Windows Service / Task Scheduler (followup task T1683 filed)
 *
 * Idempotent: re-runs do not duplicate or unnecessarily restart the service
 * when the generated content is identical (checked via SHA-256 hash comparison).
 *
 * Environment:
 *   CLEO_DAEMON_DISABLE=1  Skip auto-start activation (CI/container path).
 *                          Unit/plist file is still written; only enable/load
 *                          is skipped so the operator can activate later.
 *
 * @task T1682
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Environment variable that disables daemon auto-start (CI/container path). */
const DAEMON_DISABLE_ENV = 'CLEO_DAEMON_DISABLE';

/** Log directory for the CLEO daemon (both platforms). */
const LOG_DIR = join(homedir(), '.local', 'state', 'cleo', 'daemon');

/** Absolute path to the combined daemon log file. */
const LOG_FILE = join(LOG_DIR, 'cleo-daemon.log');

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
  mkdirSync(dirname(filePath), { recursive: true });
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

/** Absolute path to the systemd user unit file. */
const SYSTEMD_UNIT_FILE = join(
  homedir(),
  '.config',
  'systemd',
  'user',
  `${SYSTEMD_UNIT_NAME}.service`,
);

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
  return `[Unit]
Description=CLEO Sentient Daemon (autonomous task hygiene + dream cycles)
Documentation=https://github.com/kryptobaseddev/cleocode
After=network.target

[Service]
Type=simple
ExecStart=${cleoExec} daemon start --foreground
Restart=on-failure
RestartSec=5
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}
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
  const unit = buildSystemdUnit(cleoExec);
  const written = writeIfChanged(SYSTEMD_UNIT_FILE, unit);

  if (written) {
    console.log(`CLEO: Wrote systemd user unit → ${SYSTEMD_UNIT_FILE}`);
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

/** Absolute path to the launchd plist file. */
const LAUNCHD_PLIST_FILE = join(
  homedir(),
  'Library',
  'LaunchAgents',
  `${LAUNCHD_PLIST_LABEL}.plist`,
);

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
  <string>${LOG_FILE}</string>

  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>

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
  const plist = buildLaunchdPlist(cleoExec);
  const written = writeIfChanged(LAUNCHD_PLIST_FILE, plist);

  if (written) {
    console.log(`CLEO: Wrote launchd plist → ${LAUNCHD_PLIST_FILE}`);
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
      LAUNCHD_PLIST_FILE,
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
  const load = runBin('launchctl', ['load', LAUNCHD_PLIST_FILE]);
  if (load.ok) {
    console.log('CLEO: launchd agent loaded (legacy launchctl load).');
  } else {
    console.log(
      `CLEO: launchctl load skipped (${load.output || 'launchctl unavailable'}).`,
    );
    console.log(`CLEO: Plist present. Run: launchctl load "${LAUNCHD_PLIST_FILE}"`);
  }
}

// ---------------------------------------------------------------------------
// Windows — stub (followup T1683)
// ---------------------------------------------------------------------------

/**
 * Windows service registration — not yet implemented.
 *
 * TODO: Implement Windows Task Scheduler or NSSM-based service registration.
 * Filed as followup task T1683.
 */
function installWindows() {
  console.log(
    'CLEO: Windows daemon auto-start is not yet implemented (followup: T1683).',
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
  mkdirSync(LOG_DIR, { recursive: true });
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
 * @returns {Promise<void>}
 */
export async function installDaemonService() {
  try {
    ensureLogDir();
    const cleoExec = resolveCleoExec();
    const platform = process.platform;

    if (platform === 'linux') {
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
    if (platform === 'linux') {
      return uninstallSystemd();
    } else if (platform === 'darwin') {
      return uninstallLaunchd();
    } else if (platform === 'win32') {
      return {
        platform,
        removed: null,
        success: false,
        message: 'Windows uninstall not yet implemented (T1683).',
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

  // Stop + disable — ignore failures (unit may already be stopped/disabled).
  runBin('systemctl', ['--user', 'stop', SYSTEMD_UNIT_NAME]);
  runBin('systemctl', ['--user', 'disable', SYSTEMD_UNIT_NAME]);

  if (existsSync(SYSTEMD_UNIT_FILE)) {
    rmSync(SYSTEMD_UNIT_FILE, { force: true });
    runBin('systemctl', ['--user', 'daemon-reload']);
    return {
      platform,
      removed: SYSTEMD_UNIT_FILE,
      success: true,
      message: `Systemd unit removed: ${SYSTEMD_UNIT_FILE}`,
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

  if (existsSync(LAUNCHD_PLIST_FILE)) {
    const uid = process.getuid ? String(process.getuid()) : '';
    if (uid) {
      runBin('launchctl', ['bootout', `gui/${uid}`, LAUNCHD_PLIST_FILE]);
    } else {
      runBin('launchctl', ['unload', LAUNCHD_PLIST_FILE]);
    }
    rmSync(LAUNCHD_PLIST_FILE, { force: true });
    return {
      platform,
      removed: LAUNCHD_PLIST_FILE,
      success: true,
      message: `launchd plist removed: ${LAUNCHD_PLIST_FILE}`,
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
