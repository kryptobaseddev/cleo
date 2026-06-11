/**
 * Gateway auto-start-on-demand helper (T11980 · T11984 option-B shape).
 *
 * When `cleo` (TUI) or `cleo web` discovers the gateway is unreachable on the
 * configured port, this module spawns `cleo daemon serve` as a DETACHED
 * background child (stdio → log file, `child.unref()`), then polls the port
 * with an exponential-backoff probe until the gateway accepts connections or a
 * timeout elapses.
 *
 * ## Design contracts
 *
 * - **NEVER activates/enables the systemd cleo-daemon.service unit.** Auto-start
 *   here means "spawn-on-demand child process only". The spawned process exits
 *   when its parent chain terminates or when signalled; it is NOT the long-lived
 *   daemon managed by the service manager.
 * - **Respects `daemon.autoStart === false`.** The caller MUST check
 *   {@link shouldAutoStartGateway} before calling {@link spawnGatewayIfDown}.
 *   The flag is read tolerantly (missing field defaults to `true`) so the code
 *   works whether or not the field exists in the config.
 * - **CORE-reuse.** Port probing uses a plain `net.connect()` (no HTTP stack)
 *   so it is fast and dependency-free. Spawn uses the resolved CLI binary path
 *   (`process.execPath` + the compiled `dist/cli/index.js` bundle) to avoid
 *   any PATH ambiguity.
 * - **Failure is graceful.** If spawn fails or the gateway does not become
 *   reachable within `GATEWAY_WAIT_TIMEOUT_MS`, the helper resolves
 *   `{ started: false, reason }` — never throws. The caller decides how to
 *   surface the degraded state.
 *
 * @module
 * @task T11980
 */

import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnWrapped } from '@cleocode/core/resources/spawn-wrapper.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default gateway port (`cleo daemon serve` default). */
export const GATEWAY_DEFAULT_PORT = 7777;

/** Default gateway host (loopback). */
export const GATEWAY_DEFAULT_HOST = '127.0.0.1';

/**
 * How long (ms) to wait for the gateway to become reachable after spawning.
 * The poll runs at increasing intervals (see {@link pollPort}).
 */
export const GATEWAY_WAIT_TIMEOUT_MS = 10_000;

/** Initial poll delay in ms (doubles each attempt, capped at {@link POLL_MAX_DELAY_MS}). */
const POLL_INITIAL_DELAY_MS = 100;

/** Maximum poll interval cap in ms. */
const POLL_MAX_DELAY_MS = 1_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of {@link spawnGatewayIfDown}. */
export interface SpawnGatewayResult {
  /** Whether the gateway is now reachable (started new OR was already up). */
  readonly reachable: boolean;
  /** Whether this call spawned a new gateway process. */
  readonly spawned: boolean;
  /** Human-readable failure reason when `reachable === false`. */
  readonly reason?: string;
}

/** Options for {@link spawnGatewayIfDown}. */
export interface SpawnGatewayOptions {
  /** Gateway port (default 7777). */
  readonly port?: number;
  /** Gateway host (default `127.0.0.1`). */
  readonly host?: string;
  /**
   * How long (ms) to wait for the port to accept after spawning.
   * Default {@link GATEWAY_WAIT_TIMEOUT_MS}.
   */
  readonly waitTimeoutMs?: number;
  /**
   * Override the CLI entry-point path (test seam). Defaults to
   * `<package>/dist/cli/index.js` resolved relative to this module.
   */
  readonly cliEntryPath?: string;
}

// ---------------------------------------------------------------------------
// Config flag reader
// ---------------------------------------------------------------------------

/**
 * Whether the gateway auto-start is enabled per CLEO config.
 *
 * Reads `daemon.autoStart` from the project config tolerantly:
 * - field absent → `true` (safe default; callers can always opt out)
 * - field `false` → `false`
 * - field `true` → `true`
 *
 * This is a pure, synchronous helper so the TTY-guard path in `startCli` can
 * call it without dynamic imports. The config is read lazily by the consumer
 * (only after the TTY+no-args check passes).
 *
 * @param config - The project config object (or `undefined` when unavailable).
 * @returns `true` when auto-start is permitted.
 */
export function shouldAutoStartGateway(config: Record<string, unknown> | undefined): boolean {
  if (config === null || config === undefined) return true;
  const daemon = config['daemon'];
  if (daemon === null || daemon === undefined) return true;
  if (typeof daemon !== 'object') return true;
  const daemonObj = daemon as Record<string, unknown>;
  const autoStart = daemonObj['autoStart'];
  if (autoStart === false) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Port probe
// ---------------------------------------------------------------------------

/**
 * Probe whether a TCP port is accepting connections.
 *
 * Opens a raw socket (no HTTP), connects, closes immediately, resolves `true`.
 * Resolves `false` on any connection error. Never throws.
 *
 * @param port - TCP port to probe.
 * @param host - Host to probe (default `127.0.0.1`).
 * @returns `true` when the port accepted the connection.
 */
export function probePort(port: number, host: string = GATEWAY_DEFAULT_HOST): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Poll `probePort` with exponential backoff until the port accepts or the
 * deadline is exceeded.
 *
 * @param port - TCP port.
 * @param host - Host.
 * @param timeoutMs - Total wait budget in ms.
 * @returns `true` when the port accepted within the budget.
 */
export async function pollPort(port: number, host: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let delay = POLL_INITIAL_DELAY_MS;

  while (Date.now() < deadline) {
    const ok = await probePort(port, host);
    if (ok) return true;
    // Wait before next probe; clamp so we don't overshoot the deadline.
    const remaining = deadline - Date.now();
    const wait = Math.min(delay, remaining, POLL_MAX_DELAY_MS);
    if (wait <= 0) break;
    await new Promise<void>((r) => setTimeout(r, wait));
    delay = Math.min(delay * 2, POLL_MAX_DELAY_MS);
  }

  // One final probe right at the deadline.
  return probePort(port, host);
}

// ---------------------------------------------------------------------------
// CLI entry-point resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the compiled CLI bundle (`dist/cli/index.js`).
 *
 * Walks upward from this compiled module to find `dist/cli/index.js` within
 * the same package. Works in both source (`src/`) and compiled (`dist/`) trees
 * because the relative distance from this file to the package root is the same.
 *
 * @returns Absolute path to the CLI entry-point JS file.
 * @internal
 */
function resolveCliEntryPath(): string {
  // __dirname in ESM → dirname(fileURLToPath(import.meta.url))
  const thisDir = dirname(fileURLToPath(import.meta.url));
  // From packages/cleo/src/cli/lib/ → packages/cleo/ is 4 levels up
  // From packages/cleo/dist/cli/lib/ → packages/cleo/ is 4 levels up
  // We go up to the package root then descend to dist/cli/index.js
  const pkgRoot = join(thisDir, '..', '..', '..', '..', '..');
  return join(pkgRoot, 'dist', 'cli', 'index.js');
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Ensure the gateway is reachable, spawning `cleo daemon serve` as a detached
 * child process if it is not.
 *
 * ## Behaviour
 *
 * 1. Probe the port — if already reachable, return `{ reachable: true, spawned: false }`.
 * 2. If `opts.cliEntryPath` is absent and the bundle is not on disk, return
 *    `{ reachable: false, reason: '...' }` (no spawn possible).
 * 3. Spawn `node <cliEntry> daemon serve [--port N] [--host H]` with
 *    `detached: true`, stdio redirected to `<cleoLogDir>/gateway.log`, and
 *    `child.unref()` so the parent exits independently.
 * 4. Poll the port until reachable or `opts.waitTimeoutMs` elapses.
 * 5. Return a {@link SpawnGatewayResult} that is NEVER throwing — callers print
 *    their own "start-it-yourself" hint on `reachable: false`.
 *
 * **NEVER calls `systemctl` or any service-manager command.**
 *
 * @param opts - Spawn options.
 * @returns Resolved result describing the outcome.
 */
export async function spawnGatewayIfDown(
  opts: SpawnGatewayOptions = {},
): Promise<SpawnGatewayResult> {
  const port = opts.port ?? GATEWAY_DEFAULT_PORT;
  const host = opts.host ?? GATEWAY_DEFAULT_HOST;
  const waitTimeoutMs = opts.waitTimeoutMs ?? GATEWAY_WAIT_TIMEOUT_MS;

  // 1. Already up?
  if (await probePort(port, host)) {
    return { reachable: true, spawned: false };
  }

  // 2. Resolve CLI entry.
  let cliEntry: string;
  try {
    cliEntry = opts.cliEntryPath ?? resolveCliEntryPath();
  } catch (err) {
    const reason = `gateway auto-start: cannot resolve CLI entry path — ${err instanceof Error ? err.message : String(err)}`;
    return { reachable: false, spawned: false, reason };
  }

  // 3. Set up log file — best-effort, fall back to /dev/null on failure.
  let outFd: ReturnType<typeof createWriteStream> | 'ignore' = 'ignore';
  let errFd: ReturnType<typeof createWriteStream> | 'ignore' = 'ignore';
  try {
    // Lazy-import getCleoLogDir from @cleocode/core to stay on the fast path
    // (only needed when actually spawning, so we don't pay the cost up-front).
    const { getCleoLogDir } = await import('@cleocode/core');
    const logDir = getCleoLogDir();
    await mkdir(logDir, { recursive: true });
    const outStream = createWriteStream(join(logDir, 'gateway.log'), { flags: 'a' });
    const errStream = createWriteStream(join(logDir, 'gateway.err'), { flags: 'a' });
    await Promise.all([once(outStream, 'open'), once(errStream, 'open')]);
    outFd = outStream;
    errFd = errStream;
  } catch {
    // Non-fatal: log setup failure does not block spawn.
  }

  // 4. Spawn detached.
  const spawnArgs: string[] = ['daemon', 'serve'];
  if (port !== GATEWAY_DEFAULT_PORT) spawnArgs.push('--port', String(port));
  if (host !== GATEWAY_DEFAULT_HOST) spawnArgs.push('--host', host);

  try {
    // Route through the spawn-wrapper SSoT (T11993) so the gateway child lands
    // inside cleo.slice with LimitCORE=0 and — as a daemon-class scope — the
    // ManagedOOMPreference=avoid flag (write-txn holder protection).
    const { child } = spawnWrapped(
      process.execPath,
      [cliEntry, ...spawnArgs],
      {
        detached: true,
        stdio: ['ignore', outFd, errFd],
        env: { ...process.env, CLEO_GATEWAY_AUTO_STARTED: '1' },
      },
      { scopeClass: 'daemon', scopeId: 'gateway' },
    );
    child.unref();
  } catch (err) {
    const reason = `gateway auto-start: spawn failed — ${err instanceof Error ? err.message : String(err)}`;
    return { reachable: false, spawned: false, reason };
  }

  // 5. Poll until reachable.
  const reachable = await pollPort(port, host, waitTimeoutMs);
  return {
    reachable,
    spawned: true,
    reason: reachable ? undefined : 'gateway did not become reachable within the timeout',
  };
}
