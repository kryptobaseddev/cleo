/**
 * Public SDK daemon control API — @cleocode/core.
 *
 * Exposes programmatic equivalents of every `cleo daemon <subcommand>` CLI
 * command so SDK-only consumers (no CLI) can manage the daemon lifecycle
 * without spawning child processes.
 *
 * All functions are thin wrappers over the low-level primitives in
 * `./daemon.ts` (sentient daemon) and `../gc/daemon.ts` (GC daemon).
 * The install/uninstall path delegates to `install-daemon-service.mjs` in
 * the `@cleocode/cleo` package (resolved dynamically to avoid circular deps).
 *
 * Usage:
 * ```ts
 * import { installDaemon, getDaemonStatus, startDaemon } from '@cleocode/core';
 *
 * await installDaemon({ scope: 'user', superviseStudio: true });
 * const status = await getDaemonStatus(projectRoot);
 * await startDaemon(projectRoot);
 * ```
 *
 * @public
 * @task T1683
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGCDaemonStatus, spawnGCDaemon, stopGCDaemon } from '../gc/daemon.js';
import { getCleoHome } from '../paths.js';
import {
  type BootstrapDaemonOptions,
  getSentientDaemonStatus,
  type SentientStatus,
  spawnSentientDaemon,
  stopSentientDaemon,
} from './daemon.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for {@link installDaemon}.
 *
 * @public
 */
export interface InstallDaemonOptions {
  /**
   * Service scope. Currently only `'user'` is supported (user-level systemd unit
   * or launchd plist). System-level service registration is not yet implemented.
   * @default 'user'
   */
  scope?: 'user' | 'system';
  /**
   * Whether the daemon should supervise the Cleo Studio web server.
   * Stored in `~/.cleo/config.json` as `daemon.superviseStudio`.
   * @default true
   */
  superviseStudio?: boolean;
}

/**
 * Result of {@link installDaemon} / {@link uninstallDaemon} / {@link updateDaemon}.
 *
 * @public
 */
export interface DaemonInstallResult {
  /** Whether the operation succeeded. */
  success: boolean;
  /** Platform on which the operation ran. */
  platform: string;
  /** Path to the installed/removed service file, or null. */
  filePath: string | null;
  /** Human-readable outcome message. */
  message: string;
}

/**
 * Status snapshot returned by {@link getDaemonStatus}.
 *
 * Combines GC daemon status and sentient daemon status into a unified view.
 *
 * @public
 */
export interface DaemonStatus {
  /** Whether the sentient daemon process is alive. */
  running: boolean;
  /** PID of the sentient daemon, or null if stopped. */
  pid: number | null;
  /** ISO-8601 timestamp of daemon start, or null. */
  uptime: string | null;
  /** ISO-8601 timestamp of the last sentient tick, or null. */
  lastHygieneRun: string | null;
  /** ISO-8601 timestamp of the last cross-project hygiene run, or null. */
  lastDreamCycle: string | null;
  /** Whether the daemon supervises the Studio web server. */
  supervisesStudio: boolean;
  /** Current status of the Studio child process. */
  studioStatus: SentientStatus['studioStatus'];
  /** Full sentient status snapshot for detailed inspection. */
  sentient: SentientStatus;
}

// ---------------------------------------------------------------------------
// install / uninstall / update
// ---------------------------------------------------------------------------

/**
 * Install the CLEO daemon as a user-level system service.
 *
 * Writes a systemd user unit (Linux / WSL) or launchd plist (macOS) and
 * activates it so the daemon auto-starts on login.
 *
 * Idempotent: re-running does not restart a running service unless the
 * generated unit content changed.
 *
 * Programmatic equivalent of `cleo daemon install`.
 *
 * @param opts - Optional install options (scope, Studio supervision flag).
 * @returns DaemonInstallResult with success/failure details.
 *
 * @example
 * ```ts
 * import { installDaemon } from '@cleocode/core';
 *
 * const result = await installDaemon({ scope: 'user', superviseStudio: true });
 * if (result.success) console.log('Daemon installed:', result.filePath);
 * ```
 *
 * @public
 */
export async function installDaemon(opts: InstallDaemonOptions = {}): Promise<DaemonInstallResult> {
  const platform = process.platform;
  try {
    if (opts.scope === 'system') {
      return {
        success: false,
        platform,
        filePath: null,
        message: 'System-scope service registration is not yet implemented.',
      };
    }

    // Optionally persist superviseStudio preference to global config before install.
    if (typeof opts.superviseStudio === 'boolean') {
      await _writeSuperviseStudioConfig(opts.superviseStudio);
    }

    const installer = await _resolveInstallerModule();
    await installer.installDaemonService();

    return {
      success: true,
      platform,
      filePath: null,
      message: 'Daemon service installation complete.',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, platform, filePath: null, message };
  }
}

/**
 * Uninstall the CLEO daemon system service.
 *
 * Disables the unit/plist and removes the service file from disk.
 * Idempotent: safe to run even when the service is not installed.
 *
 * Programmatic equivalent of `cleo daemon uninstall`.
 *
 * @returns DaemonInstallResult with removed file path (when applicable).
 *
 * @public
 */
export async function uninstallDaemon(): Promise<DaemonInstallResult> {
  const platform = process.platform;
  try {
    const installer = await _resolveInstallerModule();
    const result = await installer.uninstallDaemonService();
    return {
      success: result.success,
      platform: result.platform,
      filePath: result.removed,
      message: result.message,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, platform, filePath: null, message };
  }
}

/**
 * Update the CLEO daemon system service (idempotent re-install).
 *
 * Re-runs install: regenerates the unit/plist with current binary paths and
 * configuration, writing only when the content changed. Safe to call on every
 * `npm install -g @cleocode/cleo` upgrade.
 *
 * Programmatic equivalent of running `cleo daemon install` on an already-installed
 * service.
 *
 * @param opts - Optional options (same as {@link installDaemon}).
 * @returns DaemonInstallResult.
 *
 * @public
 */
export async function updateDaemon(opts: InstallDaemonOptions = {}): Promise<DaemonInstallResult> {
  return installDaemon(opts);
}

// ---------------------------------------------------------------------------
// start / stop
// ---------------------------------------------------------------------------

/**
 * Start the CLEO sentient daemon as a detached background process.
 *
 * Programmatic equivalent of `cleo daemon start`.
 *
 * @param projectRoot - Absolute path to the project root (contains `.cleo/`)
 * @param opts - Optional bootstrap options (Studio supervision, etc.)
 * @returns PID of the spawned daemon process.
 *
 * @example
 * ```ts
 * import { startDaemon } from '@cleocode/core';
 *
 * const { pid } = await startDaemon('/my/project');
 * console.log(`Daemon started (PID ${pid})`);
 * ```
 *
 * @public
 */
export async function startDaemon(
  projectRoot: string,
  opts: Pick<BootstrapDaemonOptions, 'superviseStudio' | 'studioOptions'> = {},
): Promise<{ pid: number; statePath: string; logPath: string }> {
  // Persist superviseStudio preference to global config before spawning so
  // the daemon process reads the correct value from bootstrapDaemon().
  if (typeof opts.superviseStudio === 'boolean') {
    await _writeSuperviseStudioConfig(opts.superviseStudio);
  }
  // Also start the GC daemon alongside the sentient daemon.
  const cleoDir = join(projectRoot, '.cleo');
  const gcStatus = await getGCDaemonStatus(cleoDir);
  if (!gcStatus.running) {
    await spawnGCDaemon(cleoDir);
  }
  return spawnSentientDaemon(projectRoot);
}

/**
 * Stop the CLEO sentient daemon.
 *
 * Flips the kill-switch and delivers SIGTERM to the daemon process.
 * The daemon cascades SIGTERM to the Studio child (T1683 §graceful-shutdown).
 *
 * Programmatic equivalent of `cleo daemon stop`.
 *
 * @param projectRoot - Absolute path to the project root
 * @param reason - Optional diagnostic reason stored in sentient-state.json
 * @returns Stop result with pid and outcome message.
 *
 * @public
 */
export async function stopDaemon(
  projectRoot: string,
  reason = 'sdk: stopDaemon()',
): Promise<{ stopped: boolean; pid: number | null; reason: string }> {
  // Stop GC daemon too.
  const cleoDir = join(projectRoot, '.cleo');
  await stopGCDaemon(cleoDir).catch(() => {
    /* GC stop is best-effort */
  });
  return stopSentientDaemon(projectRoot, reason);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * Get the current status of the CLEO daemon.
 *
 * Returns a unified snapshot combining sentient + GC daemon state.
 *
 * Programmatic equivalent of `cleo daemon status`.
 *
 * @param projectRoot - Absolute path to the project root
 * @returns DaemonStatus snapshot.
 *
 * @example
 * ```ts
 * import { getDaemonStatus } from '@cleocode/core';
 *
 * const status = await getDaemonStatus('/my/project');
 * if (status.running) {
 *   console.log(`Daemon is running (PID ${status.pid})`);
 *   console.log(`Studio: ${status.studioStatus}`);
 * }
 * ```
 *
 * @public
 */
export async function getDaemonStatus(projectRoot: string): Promise<DaemonStatus> {
  const sentient = await getSentientDaemonStatus(projectRoot);

  return {
    running: sentient.running,
    pid: sentient.pid,
    uptime: sentient.startedAt,
    lastHygieneRun: sentient.hygieneLastRunAt,
    lastDreamCycle: sentient.lastTickAt,
    supervisesStudio: sentient.supervisesStudio,
    studioStatus: sentient.studioStatus,
    sentient,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve and import the daemon service installer module.
 *
 * The installer lives in `@cleocode/cleo/scripts/install-daemon-service.mjs`.
 * We resolve it via `import.meta.resolve('@cleocode/cleo')` (which returns the
 * package main entrypoint) and walk from there to `scripts/` — this works for
 * both global npm installs and workspace dev setups (T1684 hotfix).
 *
 * Fallback: if `import.meta.resolve` is unavailable, walk from this compiled
 * module's directory up to the workspace root (dev-only path).
 */
async function _resolveInstallerModule(): Promise<{
  installDaemonService: () => Promise<void>;
  uninstallDaemonService: () => Promise<{
    platform: string;
    removed: string | null;
    success: boolean;
    message: string;
  }>;
}> {
  let scriptPath: string;

  // Strategy 1: use import.meta.resolve to find @cleocode/cleo's install root.
  try {
    // import.meta.resolve('@cleocode/cleo') → e.g. file:///…/@cleocode/cleo/dist/cli/index.js
    // Walk up from main entrypoint to pkg root: dist/cli/index.js → ../../.. = pkg root
    const cleoMain = import.meta.resolve('@cleocode/cleo');
    const cleoMainPath = fileURLToPath(cleoMain);
    // dist/cli/index.js → up 3 levels → pkg root
    const cleoRoot = join(cleoMainPath, '..', '..', '..');
    scriptPath = join(cleoRoot, 'scripts', 'install-daemon-service.mjs');
  } catch {
    // import.meta.resolve unavailable — dev workspace fallback.
    // packages/core/dist/sentient/daemon-api.js → up 4 → workspace root → packages/cleo/scripts/
    const selfDir = join(fileURLToPath(import.meta.url), '..');
    const workspaceRoot = join(selfDir, '..', '..', '..', '..');
    scriptPath = join(workspaceRoot, 'packages', 'cleo', 'scripts', 'install-daemon-service.mjs');
  }

  return import(scriptPath) as Promise<{
    installDaemonService: () => Promise<void>;
    uninstallDaemonService: () => Promise<{
      platform: string;
      removed: string | null;
      success: boolean;
      message: string;
    }>;
  }>;
}

/**
 * Write `daemon.superviseStudio` to the global CLEO config file.
 *
 * Merges into the existing config (creates the file if absent).
 *
 * @param value - The superviseStudio flag value to persist.
 */
async function _writeSuperviseStudioConfig(value: boolean): Promise<void> {
  const { readFile, writeFile, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');

  const configPath = join(getCleoHome(), 'config.json');
  let config: Record<string, unknown> = {};
  try {
    const raw = await readFile(configPath, 'utf-8');
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // File absent or parse error — start fresh.
  }

  const daemonCfg = (config['daemon'] as Record<string, unknown> | undefined) ?? {};
  config['daemon'] = { ...daemonCfg, superviseStudio: value };

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}
