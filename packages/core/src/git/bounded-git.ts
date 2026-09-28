/**
 * Bounded, hardened `git` invocation for read-only probes (T12511).
 *
 * A probe over hundreds of checkouts must neither hang nor run code the
 * repositories configure. This module owns both properties.
 *
 * ## Bounded
 *
 * - Every call has an absolute `deadline`. Git runs in its own process group
 *   (POSIX `detached`), and at the deadline the whole group is SIGKILLed
 *   (`taskkill /T /F` on Windows). The pipes are destroyed and the child is
 *   unref'd, so a grandchild that escaped the group cannot keep the CLI alive.
 * - Output is capped at `maxOutputBytes` per call and optionally by a
 *   run-wide {@link GitOutputBudget}; past either the group is killed.
 * - While any call is live, `SIGINT`/`SIGTERM`/`SIGHUP` and `exit` kill every
 *   live group. A detached group is not in the terminal's foreground group, so
 *   Ctrl-C would otherwise orphan it. The signal is re-raised when no other
 *   listener handles it, which keeps Node's default exit behaviour. Teardown
 *   (`markShuttingDown`) also kills them.
 *
 * ## Hardened
 *
 * Every call carries {@link BASE_CONFIG} — no fsmonitor, no hooks, a protocol
 * allowlist (http/https/ssh/file), empty gitProxy/alternateRefsCommand/
 * credential helper/askpass, batch-mode ssh, no auto gc — plus caller pairs
 * such as {@link filterConfig}. Overrides travel as `GIT_CONFIG_COUNT` /
 * `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`, never `-c`, because `-c` splits
 * at the first `=` and a key may contain one. The environment disables every
 * prompt (`GIT_TERMINAL_PROMPT=0`, empty `GIT_ASKPASS`/`SSH_ASKPASS`,
 * `SSH_ASKPASS_REQUIRE=never`, `GCM_INTERACTIVE=never`), forbids partial-clone
 * lazy fetches (`GIT_NO_LAZY_FETCH=1`), sets `GIT_OPTIONAL_LOCKS=0`, and drops
 * `GIT_SSH`/`GIT_SSH_COMMAND`/`GIT_PROXY_COMMAND`/`GIT_EXTERNAL_DIFF` and any
 * inherited `GIT_CONFIG_PARAMETERS`/`GIT_CONFIG_COUNT`/`GIT_CONFIG_GLOBAL`/
 * `GIT_CONFIG_SYSTEM`.
 *
 * @task T12511
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { devNull } from 'node:os';
import { registerTeardownAbort } from '../teardown-signal.js';
import { discoveryEnv } from './work-tree.js';

/** Default cap on one call's stdout + stderr, bytes. */
export const DEFAULT_GIT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** One config override: `[key, value]`. */
export type GitConfigPair = readonly [key: string, value: string];

/**
 * Overrides applied to EVERY probe call. Any git command can reach the
 * network (a partial clone fetches missing blobs lazily), so the transport
 * pins apply everywhere, not only to `fetch`.
 *
 * - `core.fsmonitor=false`: no fsmonitor hook script, no fsmonitor daemon.
 * - `core.hooksPath=<devnull>`: no hook.
 * - `protocol.allow=never` plus an http/https/ssh/file allowlist: no `ext::`,
 *   `fd::` or `<vcs>::` remote helper, no `git://` (whose `core.gitProxy`
 *   runs a command).
 * - Empty `core.gitProxy`, `core.alternateRefsCommand`, `credential.helper`
 *   (resets the list) and `core.askPass`; plain batch-mode ssh.
 * - `gc.auto=0`, `maintenance.auto=false`: no detached gc holding repo locks.
 */
export const BASE_CONFIG: readonly GitConfigPair[] = [
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', devNull],
  ['protocol.allow', 'never'],
  ['protocol.http.allow', 'always'],
  ['protocol.https.allow', 'always'],
  ['protocol.ssh.allow', 'always'],
  ['protocol.file.allow', 'always'],
  ['core.gitProxy', ''],
  ['core.alternateRefsCommand', ''],
  ['credential.helper', ''],
  ['core.askPass', ''],
  ['core.sshCommand', 'ssh -oBatchMode=yes'],
  ['gc.auto', '0'],
  ['maintenance.auto', 'false'],
  ['fetch.recurseSubmodules', 'false'],
  ['submodule.recurse', 'false'],
];

/**
 * Overrides that disable the named filter drivers. Git has no global switch,
 * so the caller enumerates `filter.<name>.*` from `git config` first. An empty
 * `clean`/`smudge`/`process` is "no driver", and `required=false` keeps a
 * disabled required filter from failing the command. Passed through
 * `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, so a name containing `=` is intact
 * (with `-c` git would split the key at that `=`).
 *
 * @param names - Filter driver names.
 * @returns Config pairs.
 */
export function filterConfig(names: Iterable<string>): GitConfigPair[] {
  const out: GitConfigPair[] = [];
  for (const name of names) {
    for (const key of ['clean', 'smudge', 'process']) out.push([`filter.${name}.${key}`, '']);
    out.push([`filter.${name}.required`, 'false']);
  }
  return out;
}

/**
 * Probe environment: no ambient repo, no prompts, no lazy fetch, no optional
 * locks, no inherited command-scope config (`GIT_CONFIG_PARAMETERS`,
 * `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`) or alternate config files
 * (`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`), and {@link BASE_CONFIG} plus
 * `config` as the only command-scope overrides.
 *
 * @param config - Overrides beyond {@link BASE_CONFIG}.
 * @returns Environment for a probe git process.
 */
export function hardenedGitEnv(config: readonly GitConfigPair[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...discoveryEnv() };
  // Inherited command-scope config (GIT_CONFIG_PARAMETERS is read AFTER
  // GIT_CONFIG_COUNT and would beat the hardening) and alternate config files
  // are dropped, as are ssh/proxy/diff command overrides.
  for (const key of [
    'GIT_SSH',
    'GIT_SSH_COMMAND',
    'GIT_PROXY_COMMAND',
    'GIT_EXTERNAL_DIFF',
    'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM',
  ]) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (key === 'GIT_CONFIG_COUNT' || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  let n = 0;
  for (const [key, value] of [...BASE_CONFIG, ...config]) {
    env[`GIT_CONFIG_KEY_${n}`] = key;
    env[`GIT_CONFIG_VALUE_${n}`] = value;
    n++;
  }
  env['GIT_CONFIG_COUNT'] = String(n);
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    SSH_ASKPASS_REQUIRE: 'never',
    GCM_INTERACTIVE: 'never',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  };
}

/**
 * Bytes of git output held in memory at once across a whole probe run, so a
 * high concurrency cannot multiply the per-call cap into gigabytes.
 */
export class GitOutputBudget {
  private used = 0;

  /**
   * @param limit - Maximum bytes in flight across all calls sharing this budget.
   */
  constructor(readonly limit: number) {}

  /**
   * Reserve `bytes`.
   *
   * @param bytes - Bytes about to be held.
   * @returns `false` when the reservation would exceed the limit.
   */
  take(bytes: number): boolean {
    if (this.used + bytes > this.limit) return false;
    this.used += bytes;
    return true;
  }

  /**
   * Release `bytes` previously taken.
   *
   * @param bytes - Bytes no longer held.
   */
  release(bytes: number): void {
    this.used = Math.max(0, this.used - bytes);
  }
}

/** Outcome of one bounded git invocation. */
export interface BoundedGitRun {
  /** Exit code; `null` when killed or never started. */
  code: number | null;
  /** Captured stdout (UTF-8). */
  stdout: string;
  /** Captured stderr (UTF-8). */
  stderr: string;
  /** Killed at the deadline. */
  timedOut: boolean;
  /** Killed because output passed `maxOutputBytes`. */
  overflowed: boolean;
  /** Spawn failure (ENOENT for a missing git, EACCES for the cwd, …). */
  spawnError: NodeJS.ErrnoException | null;
}

/** Options for {@link runBoundedGit}. */
export interface BoundedGitOptions {
  /** Working directory. */
  cwd: string;
  /** Absolute epoch-ms deadline. */
  deadline: number;
  /** Git executable. Default `git`. */
  gitBin?: string;
  /** Output cap. Default {@link DEFAULT_GIT_MAX_OUTPUT_BYTES}. */
  maxOutputBytes?: number;
  /** Overrides beyond {@link BASE_CONFIG} (e.g. {@link filterConfig}). */
  config?: readonly GitConfigPair[];
  /** Run-wide in-flight output budget. */
  budget?: GitOutputBudget;
}

// ---------------------------------------------------------------------------
// Live process-group registry
// ---------------------------------------------------------------------------

const live = new Map<number, ChildProcess>();
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const signalHandlers = new Map<NodeJS.Signals, () => void>();

/** Kill one child's whole tree. `sync` is required inside an `exit` handler. */
function killTree(child: ChildProcess, sync: boolean): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      const args = ['/T', '/F', '/PID', String(pid)];
      if (sync) spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true });
      else spawn('taskkill', args, { stdio: 'ignore', windowsHide: true }).unref();
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Already gone.
  }
}

/**
 * Kill every live git process group started by {@link runBoundedGit}.
 *
 * Installed on `exit` and on SIGINT/SIGTERM/SIGHUP while any call is live;
 * exported for tests.
 *
 * @returns Number of groups signalled.
 */
export function killLiveGitProcesses(): number {
  const n = live.size;
  for (const child of live.values()) killTree(child, true);
  live.clear();
  uninstallHooks();
  return n;
}

/** Number of live bounded git calls (tests). */
export function liveGitProcessCount(): number {
  return live.size;
}

function onExit(): void {
  killLiveGitProcesses();
}

function installHooks(): void {
  if (signalHandlers.size > 0) return;
  process.on('exit', onExit);
  for (const sig of SIGNALS) {
    const handler = (): void => {
      killLiveGitProcesses();
      // Nobody else handles it: restore Node's default (terminate) by
      // re-raising now that our listener is gone.
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    };
    signalHandlers.set(sig, handler);
    process.on(sig, handler);
  }
}

function uninstallHooks(): void {
  if (signalHandlers.size === 0) return;
  process.removeListener('exit', onExit);
  for (const [sig, handler] of signalHandlers) process.removeListener(sig, handler);
  signalHandlers.clear();
}

function track(child: ChildProcess): void {
  if (child.pid === undefined) return;
  live.set(child.pid, child);
  installHooks();
}

function untrack(child: ChildProcess): void {
  if (child.pid !== undefined) live.delete(child.pid);
  if (live.size === 0) uninstallHooks();
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run `git <args>` in `cwd` with {@link hardenedGitEnv}, bounded by `deadline` and
 * `maxOutputBytes`. Never rejects.
 *
 * @param args - Git arguments.
 * @param options - cwd, deadline, git executable and output cap.
 * @returns The run outcome.
 * @example
 * ```ts
 * const r = await runBoundedGit(['status', '--porcelain=v2'], { cwd, deadline: Date.now() + 5000 });
 * ```
 */
export function runBoundedGit(
  args: readonly string[],
  options: BoundedGitOptions,
): Promise<BoundedGitRun> {
  const remaining = options.deadline - Date.now();
  const empty = { stdout: '', stderr: '', overflowed: false, spawnError: null };
  if (remaining <= 0) return Promise.resolve({ ...empty, code: null, timedOut: true });
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_GIT_MAX_OUTPUT_BYTES;

  return new Promise((resolveRun) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const child = spawn(options.gitBin ?? 'git', [...args], {
      cwd: options.cwd,
      env: hardenedGitEnv(options.config),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    track(child);
    const abort = new AbortController();
    const deregister = registerTeardownAbort(abort);

    const finish = (run: Omit<BoundedGitRun, 'stdout' | 'stderr'>, kill: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      deregister();
      options.budget?.release(bytes);
      if (kill) {
        killTree(child, false);
        // A grandchild outside the group may still hold these; release them so
        // the event loop is not kept alive by a process we no longer wait for.
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
      }
      untrack(child);
      resolveRun({
        ...run,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    };

    const timer = setTimeout(
      () => finish({ code: null, timedOut: true, overflowed: false, spawnError: null }, true),
      remaining,
    );
    abort.signal.addEventListener('abort', () =>
      finish({ code: null, timedOut: true, overflowed: false, spawnError: null }, true),
    );
    const collect =
      (into: Buffer[]) =>
      (b: Buffer): void => {
        if (
          bytes + b.length > maxOutputBytes ||
          (options.budget && !options.budget.take(b.length))
        ) {
          finish({ code: null, timedOut: false, overflowed: true, spawnError: null }, true);
          return;
        }
        bytes += b.length;
        into.push(b);
      };
    child.stdout?.on('data', collect(out));
    child.stderr?.on('data', collect(err));
    child.on('error', (e: NodeJS.ErrnoException) => {
      err.push(Buffer.from(e.message));
      finish({ code: null, timedOut: false, overflowed: false, spawnError: e }, false);
    });
    child.on('close', (code) =>
      finish({ code, timedOut: false, overflowed: false, spawnError: null }, false),
    );
  });
}

/** Sentinel for {@link withDeadline}. */
export const DEADLINE_EXCEEDED: unique symbol = Symbol('deadline-exceeded');

/**
 * Race `work` against an absolute deadline. The work is not cancelled (a
 * stuck filesystem call cannot be); the caller simply stops waiting.
 *
 * @param work - Promise to bound.
 * @param deadline - Absolute epoch-ms deadline.
 * @returns The result, or {@link DEADLINE_EXCEEDED}.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  deadline: number,
): Promise<T | typeof DEADLINE_EXCEEDED> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    work.catch(() => undefined);
    return DEADLINE_EXCEEDED;
  }
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<typeof DEADLINE_EXCEEDED>((r) => {
    timer = setTimeout(() => r(DEADLINE_EXCEEDED), remaining);
    timer.unref();
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}
