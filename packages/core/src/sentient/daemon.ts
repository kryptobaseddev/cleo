/**
 * Sentient Daemon — Tier-1 autonomous loop sidecar.
 *
 * Runs as a detached Node.js process and executes `runTick()` every 5
 * minutes. Mirrors the gc/daemon.ts sidecar pattern (ADR-047) and honours
 * the worktree protocol — all state lives under the project's `.cleo/`.
 *
 * Scoped IN (this module):
 *   - Tier-1 execution of unblocked tasks via `cleo orchestrate spawn`
 *   - Kill-switch with re-check at every tick checkpoint
 *   - Advisory locking via an OS-level lockfile (two daemons cannot coexist)
 *   - Stuck detection + self-pause on stuck-rate threshold
 *   - fs.watch-based fast kill propagation
 *   - Studio supervision: daemon spawns and restarts the Studio web server
 *     child process (T1683). Enabled by default; disable via
 *     `daemon.superviseStudio = false` in `~/.cleo/config.json`.
 *
 * Scoped OUT (separate epics):
 *   - Tier-2 proposal queue (`cleo propose` / status='proposed' generation)
 *   - Tier-3 sandbox auto-merge (requires agent-in-container infra)
 *   - Ed25519 signing of receipts (handled by Agent B2 llmtxt/identity wiring)
 *
 * @see ADR-054 — Sentient Loop Tier-1
 * @task T946
 * @task T1683 — Studio supervision + SDK control API
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import type { FSWatcher } from 'node:fs';
import { createWriteStream, existsSync, constants as fsConstants, watch } from 'node:fs';
import { type FileHandle, open as fsOpen, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { installDaemonExitGuard } from '../llm/pi/pi-errors.js';
import { reVerifyWorkerReport } from '../orchestrate/worker-verify.js';
import { spawnWrapped } from '../resources/spawn-wrapper.js';
import { safeRunCrossProjectHygiene } from './cross-project-hygiene.js';
import { type ProposeTickOptions, safeRunProposeTick } from './propose-tick.js';
import { patchSentientState, readSentientState, type SentientState } from './state.js';
import { safeRunTick, type TickOptions } from './tick.js';
import { warmupWorktreeBackend } from './worktree-dispatch.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Relative subpath under a project root where sentient state lives. */
export const SENTIENT_STATE_FILE = '.cleo/sentient-state.json' as const;

/** Relative subpath for the daemon lockfile. */
export const SENTIENT_LOCK_FILE = '.cleo/sentient.lock' as const;

/** Cron expression: every 5 minutes (Tier-1 tick). */
export const SENTIENT_CRON_EXPR = '*/5 * * * *';

/**
 * Cron expression: every 2 hours (Tier-2 propose tick).
 *
 * Separate from the Tier-1 cron to avoid proposal flooding.
 * Only fires when `tier2Enabled = true` in sentient-state.json.
 *
 * @task T1008
 */
export const SENTIENT_PROPOSE_CRON_EXPR = '0 */2 * * *';

/**
 * Cron expression: nightly at 02:00 local time (cross-project hygiene loop).
 *
 * Runs after the usual low-traffic window. Configurable via
 * `CLEO_HYGIENE_CRON` environment variable override.
 *
 * @task T1637
 */
export const SENTIENT_HYGIENE_CRON_EXPR = process.env['CLEO_HYGIENE_CRON'] ?? '0 2 * * *';

/** Subdirectory for daemon logs. */
export const SENTIENT_LOG_DIR = '.cleo/logs' as const;

/** Log filename (stdout). */
export const SENTIENT_LOG = 'sentient.log' as const;

/** Log filename (stderr). */
export const SENTIENT_ERR = 'sentient.err' as const;

// ---------------------------------------------------------------------------
// Studio supervision constants (T1683)
// ---------------------------------------------------------------------------

/**
 * Default port for the Cleo Studio web server.
 * Matches the `dev` script in packages/studio/package.json.
 */
export const STUDIO_DEFAULT_PORT = 3456;

/**
 * Initial restart delay (ms) for Studio crash-restart backoff.
 * Doubles on each consecutive crash up to {@link STUDIO_MAX_RESTART_DELAY_MS}.
 */
export const STUDIO_INITIAL_RESTART_DELAY_MS = 1_000;

/**
 * Maximum restart delay (ms) — caps the exponential backoff to 30 seconds.
 * Prevents infinite tight-loop crashes from consuming resources.
 */
export const STUDIO_MAX_RESTART_DELAY_MS = 30_000;

// ---------------------------------------------------------------------------
// Studio supervisor (T1683)
// ---------------------------------------------------------------------------

/**
 * Options for the Studio supervision loop.
 *
 * @public
 */
export interface StudioSupervisorOptions {
  /**
   * Absolute path to the Studio package root.
   * The supervisor runs `node build/index.js` inside this directory.
   * Defaults to locating the `@cleocode/studio` package relative to this file.
   */
  studioPackageDir?: string;
  /**
   * Port the Studio server should listen on.
   * @default 3456
   */
  port?: number;
  /**
   * Initial backoff delay (ms) after the first crash.
   * @default 1000
   */
  initialRestartDelayMs?: number;
  /**
   * Maximum backoff delay (ms) after repeated crashes.
   * @default 30000
   */
  maxRestartDelayMs?: number;
}

/**
 * Studio status returned by the supervisor.
 *
 * - `'running'`       — Studio child process is active.
 * - `'stopped'`       — Supervisor was stopped cleanly.
 * - `'crashed'`       — Studio child exited unexpectedly; restart pending.
 * - `'disabled'`      — Studio supervision is disabled in config.
 * - `'not-available'` — Studio package is not installed (graceful degrade,
 *                       T1684 hotfix). Daemon continues without Studio.
 *
 * @public
 */
export type StudioStatus = 'running' | 'stopped' | 'crashed' | 'disabled' | 'not-available';

/**
 * StudioSupervisor manages the Cleo Studio web server as a child process
 * of the sentient daemon.
 *
 * One daemon = sentient ticks + Studio HTTP server (T1683).
 *
 * Lifecycle:
 *   - `start()` — spawn Studio; attach crash handler
 *   - On crash: wait (with exponential backoff), then respawn
 *   - `stop()` — send SIGTERM with 10 s grace period, then SIGKILL
 *
 * @public
 */
export class StudioSupervisor {
  readonly #studioPackageDir: string;
  readonly #port: number;
  #initialDelay: number;
  readonly #maxDelay: number;

  #child: ChildProcess | null = null;
  #status: StudioStatus = 'stopped';
  #currentDelay: number;
  #restartTimer: NodeJS.Timeout | null = null;
  #stopped = false;

  /**
   * @param opts - Optional configuration overrides.
   */
  constructor(opts: StudioSupervisorOptions = {}) {
    this.#studioPackageDir = opts.studioPackageDir ?? StudioSupervisor.#resolveStudioPackageDir();
    this.#port = opts.port ?? STUDIO_DEFAULT_PORT;
    this.#initialDelay = opts.initialRestartDelayMs ?? STUDIO_INITIAL_RESTART_DELAY_MS;
    this.#maxDelay = opts.maxRestartDelayMs ?? STUDIO_MAX_RESTART_DELAY_MS;
    this.#currentDelay = this.#initialDelay;
  }

  /**
   * Current status of the Studio child process.
   */
  get status(): StudioStatus {
    return this.#status;
  }

  /**
   * PID of the current Studio child process, or null if not running.
   */
  get pid(): number | null {
    return this.#child?.pid ?? null;
  }

  /**
   * Start the Studio server and enable crash-restart supervision.
   *
   * Safe to call when already running — a no-op in that case.
   */
  start(): void {
    if (this.#stopped) return;
    if (this.#child !== null) return; // already running
    this.#spawn();
  }

  /**
   * Stop the Studio server gracefully.
   *
   * Sends SIGTERM to the Studio child, waits up to 10 seconds for it to
   * exit, then sends SIGKILL if it has not exited.
   *
   * @returns Promise that resolves when the child has exited.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#restartTimer !== null) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    const child = this.#child;
    if (child === null) {
      this.#status = 'stopped';
      return;
    }
    this.#status = 'stopped';
    child.removeAllListeners('exit');

    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 10_000);

      child.once('exit', () => {
        clearTimeout(killTimer);
        this.#child = null;
        resolve();
      });

      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(killTimer);
        this.#child = null;
        resolve();
      }
    });
  }

  /** Spawn the Studio child process. */
  #spawn(): void {
    if (this.#stopped) return;

    // T1684 hotfix: verify Studio entrypoint exists before spawning.
    // When @cleocode/studio is not installed (e.g. global install without the
    // package), degrade gracefully rather than crash-looping on ENOENT.
    const studioEntry = join(this.#studioPackageDir, 'build', 'index.js');
    if (!existsSync(studioEntry)) {
      this.#status = 'not-available';
      process.stderr.write(
        `[CLEO STUDIO] Studio entrypoint not found at ${studioEntry} — supervision disabled (not-available).\n`,
      );
      return;
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(this.#port),
      NODE_ENV: 'production',
    };

    // Route through the spawn-wrapper SSoT (T11993) so the Studio child lands
    // inside cleo.slice.  Studio is a daemon-class process (it holds the
    // Studio HTTP server state and may hold open DB handles), so it gets
    // ManagedOOMPreference=avoid + LimitCORE=0.
    const { child } = spawnWrapped(
      process.execPath,
      [studioEntry],
      {
        cwd: this.#studioPackageDir,
        env,
        stdio: 'inherit',
        detached: false,
      },
      { scopeClass: 'daemon', scopeId: 'studio' },
    );

    this.#child = child;
    this.#status = 'running';

    // T9928 — daemon log lines go to stderr; stdout is reserved for the
    // single LAFS envelope written by any cleo verb that may shell out to
    // the daemon. Studio inherits stdio, so its own stdout still flows
    // through this process's stdout — that is intentional and not subject
    // to this discipline (the daemon is a long-running supervisor, not a
    // CLI verb).
    process.stderr.write(
      `[CLEO STUDIO] Started Studio server (pid=${child.pid ?? '?'} port=${this.#port})\n`,
    );

    child.on('exit', (code, signal) => {
      this.#child = null;
      if (this.#stopped) {
        this.#status = 'stopped';
        return;
      }
      this.#status = 'crashed';
      process.stderr.write(
        `[CLEO STUDIO] Studio exited (code=${code ?? 'null'} signal=${signal ?? 'null'}) — restarting in ${this.#currentDelay}ms\n`,
      );
      this.#restartTimer = setTimeout(() => {
        this.#restartTimer = null;
        // Reset delay on successful long-run (>= 30 s uptime handled by caller).
        this.#spawn();
      }, this.#currentDelay);
      // Exponential backoff: double up to max.
      this.#currentDelay = Math.min(this.#currentDelay * 2, this.#maxDelay);
    });
  }

  /**
   * Resolve the Studio package directory for the installed `@cleocode/studio`
   * package.
   *
   * Resolution strategy (in order):
   *   1. `import.meta.resolve('@cleocode/studio')` — resolves the package
   *      entrypoint as installed by npm/pnpm (works in both global npm installs
   *      and workspace dev setups).
   *   2. Walk from this file's directory up to the workspace root and into
   *      `packages/studio/` — dev-only fallback (T1684 hotfix).
   *
   * Returns an empty string on total failure; callers MUST handle graceful
   * degradation when the path is empty (Studio supervision disabled).
   */
  static #resolveStudioPackageDir(): string {
    // Strategy 1: use import.meta.resolve to find the installed package.
    try {
      // import.meta.resolve('@cleocode/studio') returns the URL of the
      // package's main export (e.g. file:///…/build/index.js). We walk
      // up one level to get the package root (build/index.js → package root).
      const resolved = import.meta.resolve('@cleocode/studio');
      // resolved is a file URL to build/index.js — go up to package root.
      const indexPath = fileURLToPath(resolved);
      // build/index.js → .. (build/) → .. (package root)
      return join(indexPath, '..', '..');
    } catch {
      // import.meta.resolve not available or package not found — fall through.
    }

    // Strategy 2: dev workspace fallback — walk to workspace root.
    // packages/core/dist/sentient/daemon.js → up 5 → workspace root → packages/studio/
    const selfDir = join(fileURLToPath(import.meta.url), '..');
    const workspaceRoot = join(selfDir, '..', '..', '..', '..', '..');
    return join(workspaceRoot, 'packages', 'studio');
  }
}

// ---------------------------------------------------------------------------
// Config helpers (Studio supervision opt-out)
// ---------------------------------------------------------------------------

/**
 * Read the `daemon.superviseStudio` flag from `~/.cleo/config.json`.
 *
 * Returns `true` (default on) when the flag is absent or when the config
 * file cannot be read. Callers can explicitly set `false` to disable:
 *
 * ```json
 * { "daemon": { "superviseStudio": false } }
 * ```
 *
 * @param globalConfigPath - Absolute path to `~/.cleo/config.json`.
 * @returns Whether the daemon should supervise Studio.
 */
export async function readSuperviseStudioConfig(globalConfigPath: string): Promise<boolean> {
  try {
    const raw = await readFile(globalConfigPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const daemonCfg = parsed['daemon'];
    if (typeof daemonCfg === 'object' && daemonCfg !== null) {
      const flag = (daemonCfg as Record<string, unknown>)['superviseStudio'];
      if (typeof flag === 'boolean') return flag;
    }
  } catch {
    // Config absent or parse error — use default (true).
  }
  return true;
}

// ---------------------------------------------------------------------------
// Curator config (T9682 / T9683) — opt-in skill curator integration
// ---------------------------------------------------------------------------

/**
 * Resolved curator configuration as read from `~/.cleo/config.json`.
 *
 * @public
 */
export interface CuratorConfig {
  /**
   * Master enable flag. When `false` (the default), the curator cron is
   * NEVER scheduled — `cleo sentient kill` cannot affect what isn't running.
   *
   * @defaultValue `false`
   */
  enabled: boolean;
  /**
   * Interval (hours) between curator ticks. Default: 168 (every 7 days).
   *
   * The cron expression is rounded to the nearest whole-hour cadence so
   * fractional intervals (e.g. `0.5`) are clamped UP to `1`.
   *
   * @defaultValue 168
   */
  runEveryHours: number;
  /**
   * Days of no activity after which an `active` row flips to `stale`.
   *
   * @defaultValue 30
   */
  staleAfterDays: number;
  /**
   * Days of no activity after which a row is archived to disk.
   *
   * @defaultValue 90
   */
  archiveAfterDays: number;
}

/** Default curator configuration when none is present in the config file. */
export const DEFAULT_CURATOR_CONFIG: CuratorConfig = {
  enabled: false,
  runEveryHours: 168,
  staleAfterDays: 30,
  archiveAfterDays: 90,
};

/**
 * Read `daemon.curator.*` from `~/.cleo/config.json` (T9683).
 *
 * @remarks
 * Schema (all keys optional, defaults applied per-field):
 *
 * ```json
 * {
 *   "daemon": {
 *     "curator": {
 *       "enabled": false,
 *       "runEveryHours": 168,
 *       "staleAfterDays": 30,
 *       "archiveAfterDays": 90
 *     }
 *   }
 * }
 * ```
 *
 * Any field that is missing, malformed, or out-of-range falls back to the
 * default in {@link DEFAULT_CURATOR_CONFIG}. The config file as a whole may
 * be absent — that case also yields the defaults (enabled=false).
 *
 * @param globalConfigPath - Absolute path to `~/.cleo/config.json`.
 * @returns The resolved curator config (always populated).
 */
export async function readCuratorConfig(globalConfigPath: string): Promise<CuratorConfig> {
  const resolved: CuratorConfig = { ...DEFAULT_CURATOR_CONFIG };
  try {
    const raw = await readFile(globalConfigPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const daemonCfg = parsed['daemon'];
    if (typeof daemonCfg !== 'object' || daemonCfg === null) return resolved;
    const curatorCfg = (daemonCfg as Record<string, unknown>)['curator'];
    if (typeof curatorCfg !== 'object' || curatorCfg === null) return resolved;

    const fields = curatorCfg as Record<string, unknown>;
    if (typeof fields['enabled'] === 'boolean') resolved.enabled = fields['enabled'];
    if (typeof fields['runEveryHours'] === 'number' && fields['runEveryHours'] > 0) {
      resolved.runEveryHours = fields['runEveryHours'];
    }
    if (typeof fields['staleAfterDays'] === 'number' && fields['staleAfterDays'] > 0) {
      resolved.staleAfterDays = fields['staleAfterDays'];
    }
    if (typeof fields['archiveAfterDays'] === 'number' && fields['archiveAfterDays'] > 0) {
      resolved.archiveAfterDays = fields['archiveAfterDays'];
    }
  } catch {
    // Config absent or parse error — return defaults.
  }
  return resolved;
}

/**
 * Convert an hourly interval into a node-cron expression.
 *
 * @remarks
 * - For intervals < 24 hours, emits `0 *\/<n> * * *` (every N hours on the hour).
 * - For intervals that are an exact multiple of 24, emits `0 0 *\/<days> * *`
 *   (every N days at midnight UTC).
 * - For intervals that don't divide cleanly, falls back to `0 *\/<n> * * *`
 *   capped at 23 hours — node-cron does not natively support multi-day
 *   periodicity except via day-of-month, which has the usual 28-31 footgun.
 *
 * @param runEveryHours - Interval as configured (must be >= 1).
 * @returns A valid 5-field cron expression.
 */
export function curatorCronExpression(runEveryHours: number): string {
  const hours = Math.max(1, Math.round(runEveryHours));
  if (hours < 24) {
    return `0 */${hours} * * *`;
  }
  if (hours % 24 === 0) {
    const days = hours / 24;
    if (days <= 28) {
      return `0 0 */${days} * *`;
    }
  }
  // Long intervals that don't divide into days — emit a once-per-day cron so
  // the daemon still fires AT LEAST once in the configured window; the tick
  // itself will read the last-run timestamp and no-op if it isn't time yet
  // (mirroring Hermes' `should_run_now` gate).
  return '0 0 * * *';
}

// ---------------------------------------------------------------------------
// Advisory lock
// ---------------------------------------------------------------------------

/** Handle to an active advisory lock. */
export interface LockHandle {
  /** Absolute path to the lockfile. */
  path: string;
  /** Underlying file handle held exclusively by this process. */
  handle: FileHandle;
}

/**
 * Acquire an exclusive advisory lock on the sentient lockfile.
 *
 * Uses `fs.open` with `O_CREAT | O_EXCL` semantics — if the file already
 * exists AND its recorded pid is alive, acquisition fails. Stale lockfiles
 * (pid dead) are reclaimed automatically.
 *
 * @param lockPath - Absolute path to `.cleo/sentient.lock`
 * @returns Lock handle, or null if lock is held by a live process
 */
export async function acquireLock(lockPath: string): Promise<LockHandle | null> {
  await mkdir(join(lockPath, '..'), { recursive: true });

  // First attempt: atomic create with O_EXCL.
  try {
    const handle = await fsOpen(
      lockPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR,
      0o644,
    );
    await handle.writeFile(String(process.pid), 'utf-8');
    return { path: lockPath, handle };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw err;
  }

  // Lockfile exists. Check if the recorded pid is alive.
  let existing: FileHandle | null = null;
  try {
    existing = await fsOpen(lockPath, fsConstants.O_RDWR);
    const buf = await existing.readFile({ encoding: 'utf-8' });
    const recordedPid = Number.parseInt(buf.trim(), 10);
    if (Number.isFinite(recordedPid) && recordedPid > 0) {
      try {
        process.kill(recordedPid, 0);
        // Process alive — lock is held.
        await existing.close();
        return null;
      } catch {
        // Process dead — fall through to reclaim.
      }
    }
    // Reclaim: truncate, rewind, write our pid, keep the handle.
    await existing.truncate(0);
    const pidBytes = Buffer.from(String(process.pid), 'utf-8');
    await existing.write(pidBytes, 0, pidBytes.length, 0);
    return { path: lockPath, handle: existing };
  } catch (err) {
    if (existing) {
      try {
        await existing.close();
      } catch {
        // ignore
      }
    }
    throw err;
  }
}

/**
 * Release an advisory lock acquired via {@link acquireLock}.
 * Does NOT remove the lockfile — the pid inside is a useful diagnostic.
 */
export async function releaseLock(lock: LockHandle): Promise<void> {
  try {
    await lock.handle.close();
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Daemon bootstrap
// ---------------------------------------------------------------------------

/**
 * Options for {@link bootstrapDaemon}.
 *
 * @public
 */
export interface BootstrapDaemonOptions {
  /**
   * Whether the daemon should supervise the Cleo Studio web server.
   *
   * When `true` (default), Studio is spawned as a child process inside the
   * daemon and restarted on crash. Set to `false` to run Studio independently.
   * Overrides the `daemon.superviseStudio` flag in `~/.cleo/config.json` when
   * supplied explicitly.
   */
  superviseStudio?: boolean;
  /**
   * Path to the global CLEO config file.
   * Defaults to `~/.cleo/config.json` (resolved via getCleoHome()).
   * Used to read `daemon.superviseStudio` when `opts.superviseStudio` is not
   * supplied explicitly.
   */
  globalConfigPath?: string;
  /**
   * Studio supervisor options (port, restart delays, package dir).
   * Only used when Studio supervision is enabled.
   */
  studioOptions?: StudioSupervisorOptions;
  /**
   * Scope the task picker to tasks within this Saga (member Epics + their
   * children). When set, the daemon operates as a walk-away / headless
   * autopilot scoped to a single Saga. Read from `CLEO_SENTIENT_SAGA` env
   * var in the daemon-entry process when not supplied directly.
   *
   * @task T11497 E5-HEADLESS AC1 + AC3
   */
  scopeSagaId?: string;
  /**
   * Scope the task picker to tasks directly under this Epic. Overrides
   * `scopeSagaId` when both are set.
   *
   * @task T11497 E5-HEADLESS AC1 + AC3
   */
  scopeEpicId?: string;
}

/**
 * Bootstrap the sentient daemon process.
 *
 * Steps:
 *   1. Acquire advisory lock (fail fast if another daemon is running)
 *   2. Persist our pid + startedAt to state.json
 *   3. Optionally start Studio supervision (T1683)
 *   4. Watch state.json for killSwitch changes (fast propagation)
 *   5. Register a SIGTERM handler for graceful shutdown (cascades to Studio)
 *   6. Schedule cron with noOverlap so long ticks don't stack
 *
 * @param projectRoot - Absolute path to the project (contains `.cleo/`)
 * @param opts - Optional overrides for Studio supervision and config path.
 */
export async function bootstrapDaemon(
  projectRoot: string,
  opts: BootstrapDaemonOptions = {},
): Promise<void> {
  const statePath = join(projectRoot, SENTIENT_STATE_FILE);
  const lockPath = join(projectRoot, SENTIENT_LOCK_FILE);

  const lock = await acquireLock(lockPath);
  if (!lock) {
    process.stderr.write(`[CLEO SENTIENT] lock acquisition failed — another daemon is running\n`);
    process.exit(2);
  }

  // Reset pid + counters baseline for this run.
  await patchSentientState(statePath, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    // Clear killSwitch on boot only if owner did not explicitly leave it set.
    // We preserve it here: re-starting a killed daemon must not silently
    // resume. Owner explicitly clears via `cleo sentient resume`.
  });

  // ---------------------------------------------------------------------------
  // Pi exit-guard pin (T11761 · S2 · T11898)
  // ---------------------------------------------------------------------------
  // The in-process Pi agent loop runs inside THIS daemon process with ZERO
  // authority. `wrapPiCall` ref-counts a process.exit trap for the duration of
  // each active Pi call, but a detached/deferred exit fired AFTER the last call
  // settles would escape that ref-counted window. Pinning the trap here — once,
  // for the whole daemon lifetime — closes that residual window: a `process.exit`
  // from ANY Pi code path (sync, awaited, deferred, detached, present/future) is
  // neutralized for as long as the daemon runs. This MUST be installed before any
  // Pi-touching work is dispatched (i.e. before the flag is ever enabled). The
  // returned un-pin is called in `shutdown()` so the daemon's own graceful exit
  // still reaches the real `process.exit`.
  const unpinExitGuard = installDaemonExitGuard();

  // ---------------------------------------------------------------------------
  // Studio supervision (T1683)
  // ---------------------------------------------------------------------------

  // Determine whether to supervise Studio.
  // Priority: explicit opts.superviseStudio > config file > default (true).
  let shouldSuperviseStudio: boolean;
  if (typeof opts.superviseStudio === 'boolean') {
    shouldSuperviseStudio = opts.superviseStudio;
  } else {
    // Resolve global config path: ~/.cleo/config.json
    const { getCleoHome } = await import('../paths.js');
    const defaultConfigPath = join(getCleoHome(), 'config.json');
    const configPath = opts.globalConfigPath ?? defaultConfigPath;
    shouldSuperviseStudio = await readSuperviseStudioConfig(configPath);
  }

  let studioSupervisor: StudioSupervisor | null = null;
  if (shouldSuperviseStudio) {
    studioSupervisor = new StudioSupervisor(opts.studioOptions ?? {});
    try {
      studioSupervisor.start();
      process.stderr.write('[CLEO DAEMON] Studio supervision enabled.\n');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[CLEO DAEMON] Studio supervision start failed: ${msg}\n`);
      // Non-fatal — sentient ticks continue without Studio.
      studioSupervisor = null;
    }
  } else {
    process.stderr.write(
      '[CLEO DAEMON] Studio supervision disabled (daemon.superviseStudio=false).\n',
    );
  }

  // ---------------------------------------------------------------------------
  // State file watcher
  // ---------------------------------------------------------------------------

  // fs.watch on state file — lets us surface kill very quickly.
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(statePath, { persistent: false }, () => {
      // Just log — actual kill-switch check happens inside each tick. The
      // file watcher exists so that an active tick can notice flipping
      // without waiting for the 5-min cadence. Ticks re-read state at every
      // checkpoint (Round 2 audit §1).
    });
  } catch {
    watcher = null;
  }

  // ---------------------------------------------------------------------------
  // Graceful shutdown — cascades SIGTERM to Studio child (T1683)
  // ---------------------------------------------------------------------------
  const shutdown = async (reason: string): Promise<void> => {
    // 1. Stop Studio first (SIGTERM with 10 s grace period).
    if (studioSupervisor !== null) {
      process.stderr.write('[CLEO DAEMON] Forwarding shutdown to Studio (SIGTERM)…\n');
      try {
        await studioSupervisor.stop();
      } catch {
        // ignore
      }
    }
    try {
      watcher?.close();
    } catch {
      // ignore
    }
    try {
      await patchSentientState(statePath, {
        pid: null,
        killSwitchReason: reason,
      });
    } catch {
      // ignore
    }
    try {
      await releaseLock(lock);
    } catch {
      // ignore
    }
    // Un-pin the Pi exit guard so this controlled shutdown reaches the REAL
    // process.exit (the trap would otherwise convert it into a thrown error and
    // the daemon would never terminate).
    unpinExitGuard();
    process.exit(0);
  };
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  // Warm up the worktree backend so synchronous operations are available
  // for the tick loop (T1161).
  await warmupWorktreeBackend();

  // Kick off one tick immediately, then schedule cron.
  // Wire reVerify (AC2/T11497) so the T1589 re-verify gate re-runs gates
  // on worker exit=0 instead of trusting the self-report.
  // Wire scope filter (AC1/T11497) for headless / walk-away autopilot.
  const tickOptions: TickOptions = {
    projectRoot,
    statePath,
    reVerify: reVerifyWorkerReport,
    scopeSagaId: opts.scopeSagaId,
    scopeEpicId: opts.scopeEpicId,
  };
  await patchSentientState(statePath, { lastCronFiredAt: new Date().toISOString() });
  const outcome = await safeRunTick(tickOptions);
  process.stderr.write(
    `${new Date().toISOString()} [CLEO SENTIENT] boot tick: ${outcome.kind} ` +
      `(task=${outcome.taskId ?? 'n/a'}) ${outcome.detail}\n`,
  );

  // Tier-1: every 5 minutes
  cron.schedule(
    SENTIENT_CRON_EXPR,
    async () => {
      // Heartbeat BEFORE invoking the tick — distinguishes "cron didn't fire"
      // from "cron fired but tick hung" (T-DAEMON-LASTTICKAT diagnosis).
      try {
        await patchSentientState(statePath, { lastCronFiredAt: new Date().toISOString() });
      } catch (err) {
        // Heartbeat write failure is non-fatal — fall through to the tick.
        process.stderr.write(
          `${new Date().toISOString()} [CLEO SENTIENT] heartbeat write failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }

      // Belt-and-braces try/catch — safeRunTick already catches its own
      // exceptions, but an unhandled rejection here would leak through
      // node-cron's noOverlap lock and stop subsequent ticks from firing.
      // (Suspected H1 root cause of the 2026-05-13 lastTickAt freeze.)
      try {
        const result = await safeRunTick(tickOptions);
        process.stderr.write(
          `${new Date().toISOString()} [CLEO SENTIENT] tick: ${result.kind} ` +
            `(task=${result.taskId ?? 'n/a'}) ${result.detail}\n`,
        );
      } catch (err) {
        process.stderr.write(
          `${new Date().toISOString()} [CLEO SENTIENT] tick error (caught at cron boundary): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
        );
      }
    },
    {
      timezone: 'UTC',
      noOverlap: true,
      name: 'cleo-sentient',
    },
  );

  // Tier-2: every 2 hours (only when tier2Enabled = true)
  // Runs under the same advisory lock as the Tier-1 cron — the lock is held
  // for the lifetime of the daemon process, so both crons run inside it.
  const proposeOptions: ProposeTickOptions = { projectRoot, statePath };
  cron.schedule(
    SENTIENT_PROPOSE_CRON_EXPR,
    async () => {
      try {
        const state = await readSentientState(statePath);
        if (!state.tier2Enabled) return;
        const result = await safeRunProposeTick(proposeOptions);
        process.stderr.write(
          `${new Date().toISOString()} [CLEO SENTIENT T2] propose: ${result.kind} ` +
            `(written=${result.written}, count=${result.count}) ${result.detail}\n`,
        );
      } catch (err) {
        process.stderr.write(
          `${new Date().toISOString()} [CLEO SENTIENT T2] propose error (caught at cron boundary): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
        );
      }
    },
    {
      timezone: 'UTC',
      noOverlap: true,
      name: 'cleo-sentient-propose',
    },
  );

  // Skill curator tick (T9682) — opt-in, default off.
  // Reads `daemon.curator.enabled` + `daemon.curator.runEveryHours` from
  // ~/.cleo/config.json. When disabled, no cron is scheduled.
  {
    const { getCleoHome } = await import('../paths.js');
    const curatorConfigPath = opts.globalConfigPath ?? join(getCleoHome(), 'config.json');
    const curatorCfg = await readCuratorConfig(curatorConfigPath);

    if (curatorCfg.enabled) {
      const expr = curatorCronExpression(curatorCfg.runEveryHours);
      process.stderr.write(
        `[CLEO SENTIENT CURATOR] enabled (interval=${curatorCfg.runEveryHours}h, cron='${expr}', staleAfterDays=${curatorCfg.staleAfterDays}, archiveAfterDays=${curatorCfg.archiveAfterDays})\n`,
      );
      cron.schedule(
        expr,
        async () => {
          try {
            // Honour kill-switch before doing any work.
            const curatorState = await readSentientState(statePath);
            if (curatorState.killSwitch) return;

            // Lazy-import so the curator module is not loaded unless enabled.
            const { runCuratorTick } = await import('./curator.js');
            const result = await runCuratorTick({
              staleAfterDays: curatorCfg.staleAfterDays,
              archiveAfterDays: curatorCfg.archiveAfterDays,
            });
            process.stderr.write(
              `${new Date().toISOString()} [CLEO SENTIENT CURATOR] tick complete: ` +
                `checked=${result.summary.checked} stale=${result.summary.markedStale} ` +
                `archived=${result.summary.archived} reactivated=${result.summary.reactivated}\n`,
            );
          } catch (err) {
            process.stderr.write(
              `${new Date().toISOString()} [CLEO SENTIENT CURATOR] tick error (caught at cron boundary): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
            );
          }
        },
        {
          timezone: 'UTC',
          noOverlap: true,
          name: 'cleo-sentient-curator',
        },
      );
    } else {
      process.stderr.write(
        '[CLEO SENTIENT CURATOR] disabled (daemon.curator.enabled=false). Skipping schedule.\n',
      );
    }
  }

  // Nightly cross-project hygiene loop (T1637).
  // Runs at 02:00 local time (or CLEO_HYGIENE_CRON override).
  // Checks kill-switch before starting — daemon shutdown prevents mid-loop runs.
  cron.schedule(
    SENTIENT_HYGIENE_CRON_EXPR,
    async () => {
      try {
        const hygieneState = await readSentientState(statePath);
        if (hygieneState.killSwitch) return;

        process.stderr.write(
          `${new Date().toISOString()} [CLEO SENTIENT HYGIENE] nightly cross-project hygiene loop starting\n`,
        );
        const digest = await safeRunCrossProjectHygiene();

        // Persist digest counts to sentient state so `cleo daemon status` can read them.
        await patchSentientState(statePath, {
          hygieneLastRunAt: digest.completedAt,
          hygieneSummary: digest.summary,
          hygieneStats: {
            projectsChecked: digest.nexusIntegrity.total,
            projectsHealthy: digest.nexusIntegrity.healthy,
            tempGcCandidates: digest.tempGc.candidates.length,
            duplicateEpicGroups: digest.duplicateEpics.groups.length,
            worktreesPruned: digest.worktreePrune.totalPruned,
          },
        });

        process.stderr.write(
          `${new Date().toISOString()} [CLEO SENTIENT HYGIENE] complete: ${digest.summary}\n`,
        );
      } catch (err) {
        process.stderr.write(
          `${new Date().toISOString()} [CLEO SENTIENT HYGIENE] error (caught at cron boundary): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
        );
      }
    },
    {
      noOverlap: true,
      name: 'cleo-sentient-hygiene',
    },
  );
}

// ---------------------------------------------------------------------------
// Spawn helpers (parent-process side)
// ---------------------------------------------------------------------------

/** Outcome of {@link spawnSentientDaemon}. */
export interface SpawnDaemonResult {
  /** PID of the spawned daemon. */
  pid: number;
  /** Absolute path to the .cleo/sentient-state.json file. */
  statePath: string;
  /** Absolute path to the log file. */
  logPath: string;
}

/**
 * Spawn the sentient daemon as a detached background process.
 *
 * All three T751 §2.2 requirements:
 *   1. `detached: true` — process-group leader survives parent exit
 *   2. File-based stdio — no TTY inheritance
 *   3. `child.unref()` — parent CLI returns immediately
 *
 * @param projectRoot - Absolute path to the project root (contains `.cleo/`)
 * @returns PID + log paths
 */
export async function spawnSentientDaemon(projectRoot: string): Promise<SpawnDaemonResult> {
  const logsDir = join(projectRoot, SENTIENT_LOG_DIR);
  await mkdir(logsDir, { recursive: true });

  const logPath = join(logsDir, SENTIENT_LOG);
  const errPath = join(logsDir, SENTIENT_ERR);

  const outStream = createWriteStream(logPath, { flags: 'a' });
  const errStream = createWriteStream(errPath, { flags: 'a' });

  // Node 24 requires WriteStream file descriptors to be open before passing
  // to spawn stdio. Await the 'open' event on both streams first.
  await Promise.all([once(outStream, 'open'), once(errStream, 'open')]);

  // Resolve daemon-entry.js in the compiled output (sibling to this module).
  const daemonEntry = join(fileURLToPath(import.meta.url), '..', 'daemon-entry.js');

  const child = spawn(process.execPath, [daemonEntry, projectRoot], {
    detached: true,
    stdio: ['ignore', outStream, errStream],
    env: { ...process.env, CLEO_SENTIENT_DAEMON: '1' },
  });

  child.unref();

  const pid = child.pid ?? 0;
  const statePath = join(projectRoot, SENTIENT_STATE_FILE);

  // Pre-persist our pid so subsequent `cleo sentient status` calls can find it
  // even before the child writes its own pid.
  await patchSentientState(statePath, {
    pid,
    startedAt: new Date().toISOString(),
  });

  return { pid, statePath, logPath };
}

/** Outcome of {@link stopSentientDaemon}. */
export interface StopDaemonResult {
  /** Whether the stop signal was delivered. */
  stopped: boolean;
  /** Last known pid; null if no pid was recorded. */
  pid: number | null;
  /** Human-readable reason. */
  reason: string;
}

/**
 * Stop the sentient daemon.
 *
 * Flips killSwitch=true FIRST (so an in-flight tick notices on its next
 * checkpoint re-read), then sends SIGTERM. This gives the daemon a fast,
 * graceful shutdown path even during a long-running spawn.
 *
 * @param projectRoot - Absolute path to the project root
 * @param reason - Optional reason stored on state file for diagnostics
 * @returns Stop result
 */
export async function stopSentientDaemon(
  projectRoot: string,
  reason = 'cleo sentient stop',
): Promise<StopDaemonResult> {
  const statePath = join(projectRoot, SENTIENT_STATE_FILE);
  const state = await readSentientState(statePath);

  // Flip killSwitch before signalling so an in-progress tick exits on the
  // next checkpoint, even if SIGTERM is delayed or lost.
  await patchSentientState(statePath, {
    killSwitch: true,
    killSwitchReason: reason,
  });

  const pid = state.pid;
  if (!pid) {
    return {
      stopped: false,
      pid: null,
      reason: 'killSwitch set; no daemon pid recorded (no active process to signal)',
    };
  }

  try {
    process.kill(pid, 0);
  } catch {
    await patchSentientState(statePath, { pid: null });
    return {
      stopped: true,
      pid,
      reason: `killSwitch set; daemon pid ${pid} was already dead (cleared)`,
    };
  }

  try {
    process.kill(pid, 'SIGTERM');
    return { stopped: true, pid, reason: `killSwitch set + SIGTERM delivered to pid ${pid}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      stopped: false,
      pid,
      reason: `killSwitch set but SIGTERM failed: ${message}`,
    };
  }
}

/**
 * Clear the kill switch so the cron schedule resumes executing ticks.
 *
 * Does NOT restart the daemon process — that is the caller's responsibility
 * via `cleo sentient start` if the process itself exited.
 *
 * @param projectRoot - Absolute path to the project root
 */
export async function resumeSentientDaemon(projectRoot: string): Promise<SentientState> {
  const statePath = join(projectRoot, SENTIENT_STATE_FILE);
  const current = await readSentientState(statePath);
  // T1074: reject plain-resume when state is paused by revert — owner must
  // provide a valid attestation via `resumeAfterRevert()` instead.
  if (current.pausedByRevert) {
    const { E_OWNER_ATTESTATION_REQUIRED } = await import('./state.js');
    const err = new Error(
      `${E_OWNER_ATTESTATION_REQUIRED}: daemon is paused by revert (receipt ${current.revertReceiptId}); use resumeAfterRevert with owner attestation`,
    ) as NodeJS.ErrnoException;
    err.code = E_OWNER_ATTESTATION_REQUIRED;
    throw err;
  }
  return patchSentientState(statePath, {
    killSwitch: false,
    killSwitchReason: null,
  });
}

/** Status snapshot returned by {@link getSentientDaemonStatus}. */
export interface SentientStatus {
  /** Whether the pid on file is currently alive. */
  running: boolean;
  /** Recorded pid (null when never started or cleared on stop). */
  pid: number | null;
  /** ISO-8601 timestamp of last start. */
  startedAt: string | null;
  /** ISO-8601 timestamp of the last completed tick. */
  lastTickAt: string | null;
  /**
   * ISO-8601 timestamp of the last cron-callback dispatch — written BEFORE
   * `safeRunTick` runs. Use the delta `lastTickAt - lastCronFiredAt` to
   * detect tick hangs: when the heartbeat advances but the tick stamp does
   * not, a tick is stuck mid-execution.
   *
   * @task T-DAEMON-LASTTICKAT (T9320 follow-up)
   */
  lastCronFiredAt: string | null;
  /** Kill-switch state. */
  killSwitch: boolean;
  /** Reason supplied with the last kill. */
  killSwitchReason: string | null;
  /** Rolling stats. */
  stats: SentientState['stats'];
  /** Number of currently-stuck tasks. */
  stuckCount: number;
  /** Currently active task id (set mid-tick). */
  activeTaskId: string | null;
  /**
   * T1637: ISO-8601 timestamp of the last cross-project hygiene loop run.
   * Null when the hygiene loop has never executed.
   */
  hygieneLastRunAt: string | null;
  /**
   * T1637: One-line summary of the last hygiene run (for `cleo daemon status`).
   */
  hygieneSummary: string | null;
  /**
   * T1637: Summary counts from the last hygiene loop.
   */
  hygieneStats: SentientState['hygieneStats'];
  /**
   * T1683: Whether the daemon is configured to supervise the Studio web server.
   * Read from `daemon.superviseStudio` in `~/.cleo/config.json` (default: true).
   */
  supervisesStudio: boolean;
  /**
   * T1683: Current status of the Studio child process.
   * `'disabled'` when Studio supervision is off.
   */
  studioStatus: StudioStatus;
}

/**
 * Return a diagnostic snapshot for `cleo sentient status`.
 *
 * Includes T1683 Studio supervision fields: `supervisesStudio` and `studioStatus`.
 * Studio status is determined from the config file (not live process state, since
 * the supervisor runs inside the daemon process, not the status caller).
 *
 * @param projectRoot - Absolute path to the project root
 */
export async function getSentientDaemonStatus(projectRoot: string): Promise<SentientStatus> {
  const statePath = join(projectRoot, SENTIENT_STATE_FILE);
  const state = await readSentientState(statePath);

  let running = false;
  if (state.pid) {
    try {
      process.kill(state.pid, 0);
      running = true;
    } catch {
      running = false;
    }
  }

  // T1683: resolve Studio supervision flag from global config.
  const { getCleoHome } = await import('../paths.js');
  const globalConfigPath = join(getCleoHome(), 'config.json');
  const supervisesStudio = await readSuperviseStudioConfig(globalConfigPath);

  return {
    running,
    pid: running ? state.pid : null,
    startedAt: state.startedAt,
    lastTickAt: state.lastTickAt,
    lastCronFiredAt: state.lastCronFiredAt,
    killSwitch: state.killSwitch,
    killSwitchReason: state.killSwitchReason,
    stats: state.stats,
    stuckCount: Object.keys(state.stuckTasks).length,
    activeTaskId: state.activeTaskId,
    hygieneLastRunAt: state.hygieneLastRunAt,
    hygieneSummary: state.hygieneSummary,
    hygieneStats: state.hygieneStats,
    supervisesStudio,
    // Studio status is 'running' only if daemon is alive and supervises Studio.
    // We can't inspect the in-process supervisor from outside, so we report
    // 'running' when the daemon is up + superviseStudio=true, else the appropriate state.
    studioStatus: !supervisesStudio ? 'disabled' : running ? 'running' : 'stopped',
  };
}

// ---------------------------------------------------------------------------
// Runaway worker detection (T1658)
// ---------------------------------------------------------------------------

/**
 * Size-based wall-clock budget thresholds in milliseconds.
 *
 * Workers active beyond 2× their size budget are considered runaway and
 * eligible for abort. Budget is sized around human-comparable work units:
 * `small` ~ half an hour, `medium` ~ two hours, `large` ~ four hours.
 *
 * @task T1658
 */
export const WORKER_BUDGET_MS: Record<string, number> = {
  small: 30 * 60 * 1000, // 30 minutes
  medium: 2 * 60 * 60 * 1000, // 2 hours
  large: 4 * 60 * 60 * 1000, // 4 hours
};

/**
 * Multiplier applied to the size budget before flagging a worker as runaway.
 *
 * At 2× a worker has consumed twice the expected wall-clock time for its size.
 * The sentient monitor emits a warning at 1× (budget) and aborts at 2×.
 */
export const RUNAWAY_BUDGET_MULTIPLIER = 2;

/** A single active-worker row returned by {@link monitorWorkers}. */
export interface WorkerMonitorRow {
  /** Task ID of the worker. */
  taskId: string;
  /** Task title for display. */
  title: string;
  /** Task size (small | medium | large | unknown). */
  size: string;
  /** ISO-8601 timestamp when the task transitioned to in_progress. */
  startedAt: string;
  /** Elapsed wall-clock time in milliseconds. */
  elapsedMs: number;
  /** Expected budget in milliseconds based on size. */
  budgetMs: number;
  /** True when elapsed > budget (warn). */
  overBudget: boolean;
  /** True when elapsed > RUNAWAY_BUDGET_MULTIPLIER × budget (abort). */
  runaway: boolean;
}

/**
 * Scan for in-progress tasks and evaluate their wall-clock elapsed time
 * against their size budget.
 *
 * Runaway detection does NOT automatically abort workers — the caller
 * (`cleo sentient monitor`) decides what action to take. This function is
 * read-only and safe to call at any frequency.
 *
 * The task store is accessed via the CLEO CLI (`cleo list --status in_progress`)
 * rather than direct SQLite access to respect ADR-013 DB-separation rules.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Array of monitor rows for all in-progress tasks.
 *
 * @task T1658
 */
export async function monitorWorkers(projectRoot: string): Promise<WorkerMonitorRow[]> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  let stdout: string;
  try {
    const result = await execFileAsync('cleo', ['find', '--status', 'in_progress', '--json'], {
      cwd: projectRoot,
    });
    stdout = result.stdout;
  } catch {
    // If cleo isn't available or no tasks exist, return empty.
    return [];
  }

  let tasks: Array<{ id: string; title: string; size?: string; updatedAt?: string }>;
  try {
    const envelope = JSON.parse(stdout) as { success: boolean; data?: { tasks?: unknown[] } };
    if (!envelope.success || !Array.isArray(envelope.data?.tasks)) return [];
    tasks = envelope.data.tasks as typeof tasks;
  } catch {
    return [];
  }

  const now = Date.now();
  const rows: WorkerMonitorRow[] = [];

  for (const task of tasks) {
    const size = task.size ?? 'medium';
    const budgetMs = WORKER_BUDGET_MS[size] ?? WORKER_BUDGET_MS['medium'] ?? 7200000;
    // Use updatedAt as proxy for when the task transitioned to in_progress.
    const startTs = task.updatedAt ? new Date(task.updatedAt).getTime() : now;
    const elapsedMs = now - startTs;

    rows.push({
      taskId: task.id,
      title: task.title ?? task.id,
      size,
      startedAt: task.updatedAt ?? new Date().toISOString(),
      elapsedMs,
      budgetMs,
      overBudget: elapsedMs > budgetMs,
      runaway: elapsedMs > budgetMs * RUNAWAY_BUDGET_MULTIPLIER,
    });
  }

  return rows.sort((a, b) => b.elapsedMs - a.elapsedMs);
}
