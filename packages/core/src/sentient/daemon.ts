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
import { safeRunCrossProjectHygiene } from './cross-project-hygiene.js';
import { type ProposeTickOptions, safeRunProposeTick } from './propose-tick.js';
import { patchSentientState, readSentientState, type SentientState } from './state.js';
import { safeRunTick, type TickOptions } from './tick.js';

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

    const child = spawn(process.execPath, [studioEntry], {
      cwd: this.#studioPackageDir,
      env,
      stdio: 'inherit',
      detached: false,
    });

    this.#child = child;
    this.#status = 'running';

    process.stdout.write(
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
async function readSuperviseStudioConfig(globalConfigPath: string): Promise<boolean> {
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
      process.stdout.write('[CLEO DAEMON] Studio supervision enabled.\n');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[CLEO DAEMON] Studio supervision start failed: ${msg}\n`);
      // Non-fatal — sentient ticks continue without Studio.
      studioSupervisor = null;
    }
  } else {
    process.stdout.write(
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
      process.stdout.write('[CLEO DAEMON] Forwarding shutdown to Studio (SIGTERM)…\n');
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
    process.exit(0);
  };
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  // Kick off one tick immediately, then schedule cron.
  const tickOptions: TickOptions = { projectRoot, statePath };
  const outcome = await safeRunTick(tickOptions);
  process.stdout.write(
    `[CLEO SENTIENT] boot tick: ${outcome.kind} ` +
      `(task=${outcome.taskId ?? 'n/a'}) ${outcome.detail}\n`,
  );

  // Tier-1: every 5 minutes
  cron.schedule(
    SENTIENT_CRON_EXPR,
    async () => {
      const result = await safeRunTick(tickOptions);
      process.stdout.write(
        `[CLEO SENTIENT] tick: ${result.kind} ` +
          `(task=${result.taskId ?? 'n/a'}) ${result.detail}\n`,
      );
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
      const state = await readSentientState(statePath);
      if (!state.tier2Enabled) return;
      const result = await safeRunProposeTick(proposeOptions);
      process.stdout.write(
        `[CLEO SENTIENT T2] propose: ${result.kind} ` +
          `(written=${result.written}, count=${result.count}) ${result.detail}\n`,
      );
    },
    {
      timezone: 'UTC',
      noOverlap: true,
      name: 'cleo-sentient-propose',
    },
  );

  // Nightly cross-project hygiene loop (T1637).
  // Runs at 02:00 local time (or CLEO_HYGIENE_CRON override).
  // Checks kill-switch before starting — daemon shutdown prevents mid-loop runs.
  cron.schedule(
    SENTIENT_HYGIENE_CRON_EXPR,
    async () => {
      const hygieneState = await readSentientState(statePath);
      if (hygieneState.killSwitch) return;

      process.stdout.write('[CLEO SENTIENT HYGIENE] nightly cross-project hygiene loop starting\n');
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

      process.stdout.write(`[CLEO SENTIENT HYGIENE] complete: ${digest.summary}\n`);
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
