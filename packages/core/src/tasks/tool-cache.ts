/**
 * Content-addressed cache for evidence-tool runs (ADR-061).
 *
 * `cleo verify --evidence "tool:<name>"` historically spawned the resolved
 * toolchain (test, build, lint, …) on every call. With N parallel verify
 * processes — common in orchestrator-spawned waves — this multiplied a heavy
 * monorepo test or build by N, saturating CPU and memory.
 *
 * This module wraps tool execution with:
 *
 *   1. **Content-addressed cache** — keyed on `(canonical, cmd, args, head,
 *      dirtyFingerprint)`. Cache hits return the prior `exitCode + stdoutTail`
 *      without spawning the tool.
 *   2. **Cross-process semaphore** — when N processes simultaneously miss the
 *      cache, only one runs the tool; the rest block on a `proper-lockfile`
 *      and read the freshly-written cache entry.
 *   3. **Automatic invalidation** — entries become stale when `git HEAD`
 *      changes or when uncommitted-tree fingerprint changes. Stale entries
 *      are discarded on access (no GC daemon required).
 *
 * Cache layout (under `<projectRoot>/.cleo/cache/evidence/`):
 *
 *   - `<key>.json` — cache entry payload
 *   - `<key>.json.lock` — proper-lockfile state (auto-managed)
 *
 * Each entry is a single small JSON file (≤ 4 KB) so the cache is cheap to
 * keep and easy to inspect / wipe (`rm -rf .cleo/cache/evidence`).
 *
 * @task T1534
 * @adr ADR-061
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { withLock } from '../store/lock.js';
import { heavyToolEnv } from './heavy-tool-env.js';
import type { ResolvedToolCommand } from './tool-resolver.js';
import { type AcquireSlotOptions, acquireGlobalSlot } from './tool-semaphore.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One cached tool execution.
 *
 * @task T1534
 */
export interface ToolCacheEntry {
  /** Schema version for forwards compatibility. */
  schemaVersion: 1;
  /** Cache key (also encoded in the filename). */
  key: string;
  /** Canonical tool name from the resolver. */
  canonical: string;
  /** Display name (the alias the user supplied). */
  displayName: string;
  /** Resolved cmd. */
  cmd: string;
  /** Resolved args. */
  args: string[];
  /** Resolution source from the resolver. */
  source: string;
  /** Git HEAD sha at execution time. */
  head: string | null;
  /** sha256 of `git status --porcelain` (uncommitted tree fingerprint). */
  dirtyFingerprint: string | null;
  /** Process exit code. */
  exitCode: number | null;
  /** Last 512 bytes of stdout. */
  stdoutTail: string;
  /** Last 512 bytes of stderr. */
  stderrTail: string;
  /** Total duration in milliseconds. */
  durationMs: number;
  /** ISO 8601 wall-clock timestamp of the run. */
  capturedAt: string;
}

/**
 * Result of {@link runToolCached}. Mirrors the legacy `validateTool`
 * contract so callers can unconditionally inspect `exitCode + stdoutTail`.
 *
 * @task T1534
 * @task T12025
 */
export interface ToolRunResult {
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
  /** `true` when the result came from cache (no spawn occurred). */
  cacheHit: boolean;
  /**
   * `true` when the wall-clock child-process deadline was exceeded and the
   * tool was terminated before producing a result. The lock + semaphore
   * slot are released; a subsequent retry will attempt a fresh spawn.
   *
   * @task T12025
   */
  timedOut: boolean;
  /**
   * `true` when the per-key cache lock was held by another process and
   * could not be acquired within the fail-fast retry window (~0.7 s).
   * The semaphore slot is released; a subsequent retry will re-attempt
   * lock acquisition.
   *
   * @task T12025
   */
  lockBusy: boolean;
  /**
   * Absolute path of the tree this run was executed in and fingerprinted
   * against.
   *
   * Reported so the operator can SEE which checkout produced the evidence
   * instead of inferring it from a confusing failure — the explicit ask in
   * gh#1220. Lives on the result rather than on {@link ToolCacheEntry}
   * because the entry is content-addressed and shared between worktrees: a
   * hit served to a second worktree must not claim to have run in the first
   * one's directory.
   *
   * @task T12112 (gh#1220)
   */
  executionRoot: string;
  /** Full cache entry — useful for audit / debugging. */
  entry: ToolCacheEntry;
}

/**
 * Options for {@link runToolCached}.
 *
 * @task T1534
 */
export interface RunToolOptions {
  /**
   * When `true`, bypass the cache (always spawn). The fresh result is still
   * written to cache for subsequent calls.
   *
   * When omitted, `CLEO_EVIDENCE_FRESH=1` in the environment turns this on.
   * That is the documented escape hatch for the tracked-only fingerprint
   * (see {@link captureDirtyFingerprint}): an uncommitted NEW file does not
   * move the cache key, so this is how an operator forces a measured run
   * without committing first.
   *
   * @defaultValue `false` (or `CLEO_EVIDENCE_FRESH === '1'`)
   * @task T12112 (gh#1221)
   */
  bypassCache?: boolean;
  /**
   * Lock-acquire timeout in ms. The default (10 minutes) covers full
   * monorepo test suites.
   *
   * @defaultValue `600_000`
   */
  lockStaleMs?: number;
  /**
   * Maximum tail length for stdout / stderr capture.
   *
   * @defaultValue `512`
   */
  tailBytes?: number;
  /**
   * When `true`, skip the global cross-process semaphore that bounds the
   * total number of concurrent runs of this canonical tool across the
   * whole machine. Use only in tests where the semaphore would block
   * arbitrary parallel sibling tests.
   *
   * @defaultValue `false`
   */
  skipGlobalSemaphore?: boolean;
  /**
   * Tuning for the global semaphore acquisition. Forwarded to
   * {@link acquireGlobalSlot}.
   *
   * @internal
   */
  semaphoreOptions?: AcquireSlotOptions;
  /**
   * Wall-clock deadline for the child process (ms). When exceeded the
   * process is SIGTERM'd, then SIGKILL'd after a 5 s grace period.
   * The lock and semaphore slot are always released so a subsequent
   * retry can proceed. When omitted, the deadline resolves via
   * {@link resolveSpawnTimeoutMs} (`CLEO_TOOL_TIMEOUT_<CANONICAL>` env
   * override over {@link DEFAULT_SPAWN_TIMEOUT_MS}); tests inject shorter
   * values for determinism.
   *
   * @defaultValue `300_000` (5 min)
   * @task T12025
   * @task T12105
   */
  spawnTimeoutMs?: number;
  /**
   * Absolute path of the tree the tool should actually RUN in, and whose git
   * state is fingerprinted for the cache key.
   *
   * `projectRoot` is the CLEO **store** root: for a git worktree,
   * `getProjectRoot()` deliberately resolves to the MAIN repo so every
   * worktree shares one `.cleo/` database. Reusing that value as the tool's
   * working directory is what made evidence describe the wrong tree
   * (gh#1220, gh#1226, gh#1230) — a verify launched from a worktree measured
   * the main checkout, which on a shared box carries a peer's in-flight
   * branch and untracked files. That yields a false FAIL when the peer is
   * red, and — the dangerous direction — a silent false PASS when the peer is
   * green, attesting a run that never touched the code under test.
   *
   * Defaults to `projectRoot`, preserving single-checkout behaviour exactly.
   *
   * @task T12112 (gh#1220, gh#1226, gh#1230)
   */
  executionRoot?: string;
}

// ---------------------------------------------------------------------------
// Wall-clock deadline resolution (T12105 / gh#1193)
// ---------------------------------------------------------------------------

/**
 * Default wall-clock deadline for one evidence-tool child process, in ms.
 *
 * 5 minutes covers a full monorepo test suite on an idle machine. Loaded
 * CI runners sharing the box can push a suite past this — raise it per
 * tool with `CLEO_TOOL_TIMEOUT_<CANONICAL>` rather than weakening the
 * deadline globally in code.
 *
 * @task T12025
 * @task T12105
 */
export const DEFAULT_SPAWN_TIMEOUT_MS = 300_000;

/**
 * Resolve the wall-clock child-process deadline for a canonical tool.
 *
 * Precedence:
 *   1. `CLEO_TOOL_TIMEOUT_<CANONICAL>` env var (canonical name uppercased,
 *      dashes → underscores — the same convention as
 *      `CLEO_TOOL_CONCURRENCY_<CANONICAL>` in tool-semaphore.ts). Value is
 *      milliseconds, digits only, strictly positive.
 *   2. {@link DEFAULT_SPAWN_TIMEOUT_MS}.
 *
 * A set-but-invalid value (non-numeric, zero, negative) is a configuration
 * ERROR, not a fallback: silently ignoring it would let an operator believe
 * they raised the deadline while the old one still fires (gh#1193).
 *
 * @param canonical - Canonical tool name from the resolver.
 * @param env - Environment to read (injectable for tests).
 * @returns Deadline in milliseconds.
 * @throws CleoError(VALIDATION_ERROR) when the env var is set but invalid.
 *
 * @task T12105 (gh#1193)
 */
export function resolveSpawnTimeoutMs(
  canonical: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const envKey = `CLEO_TOOL_TIMEOUT_${canonical.toUpperCase().replace(/-/g, '_')}`;
  const raw = env[envKey];
  if (raw === undefined || raw.trim() === '') return DEFAULT_SPAWN_TIMEOUT_MS;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `${envKey} must be a positive integer (milliseconds), got "${raw}".`,
      {
        fix: `Set ${envKey} to a millisecond value such as 600000 (10 min), or unset it to use the ${DEFAULT_SPAWN_TIMEOUT_MS}ms default.`,
      },
    );
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (parsed <= 0) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `${envKey} must be greater than zero, got ${parsed}.`,
      {
        fix: `Set ${envKey} to a positive millisecond value such as 600000 (10 min), or unset it to use the ${DEFAULT_SPAWN_TIMEOUT_MS}ms default.`,
      },
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Cache key derivation
// ---------------------------------------------------------------------------

/**
 * Compute the cache key for a resolved tool command + repo state.
 *
 * Key includes:
 *   - Canonical tool name
 *   - Resolved command + args (sensitive to project-context updates)
 *   - Git HEAD sha (so a new commit invalidates everything)
 *   - Dirty-tree fingerprint (so an uncommitted edit invalidates everything)
 *
 * Using `createHash('sha256')` makes the key collision-resistant and bounded
 * to 64 hex chars regardless of input size.
 *
 * @task T1534
 */
export function computeCacheKey(
  command: ResolvedToolCommand,
  head: string | null,
  dirtyFingerprint: string | null,
): string {
  const payload = JSON.stringify({
    canonical: command.canonical,
    cmd: command.cmd,
    args: command.args,
    head,
    dirtyFingerprint,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// Repo-state fingerprinting
// ---------------------------------------------------------------------------

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** `true` when the wall-clock deadline was exceeded and the process was force-killed. */
  timedOut: boolean;
}

/**
 * Maximum bytes retained from a child's stdout / stderr stream during
 * spawn. The tool-evidence atom only needs the trailing 512 bytes for
 * audit context, so anything older than this window is dropped at the
 * data-event boundary. This bounds resident memory at ~64 KB per stream
 * per spawn regardless of how much the tool emits.
 *
 * Pre-T1534 we accumulated the *entire* stdout into a JS string — for a
 * vitest run emitting 100 MB+ of progress output that was 100 MB resident
 * per spawn, multiplied by N parallel verifies. That was the "memory
 * leak that built up" reported in production.
 *
 * @task T1534
 */
const STREAM_TAIL_CAP_BYTES = 64 * 1024;

/**
 * Bounded tail accumulator. Appending data beyond `cap` discards the
 * oldest bytes. `toString('utf-8')` returns the retained tail.
 *
 * @internal
 */
class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly cap: number) {}

  append(chunk: Buffer): void {
    // If the new chunk alone exceeds capacity, only keep its tail and
    // discard everything we had previously.
    if (chunk.length >= this.cap) {
      this.chunks = [chunk.subarray(chunk.length - this.cap)];
      this.size = this.cap;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    // Trim from the front until we're under the cap.
    while (this.size > this.cap && this.chunks.length > 0) {
      const head = this.chunks[0];
      if (!head) break;
      const overflow = this.size - this.cap;
      if (head.length <= overflow) {
        this.size -= head.length;
        this.chunks.shift();
      } else {
        this.chunks[0] = head.subarray(overflow);
        this.size -= overflow;
      }
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.size).toString('utf-8');
  }
}

/**
 * Delta between SIGTERM and SIGKILL when the child-process deadline fires.
 * Gives well-behaved toolchains a grace window to flush buffers and exit.
 *
 * @task T12025
 */
const GRACEFUL_KILL_MS = 5_000;

/**
 * Terminate a process and all its descendants reliably.
 *
 * On POSIX, spawns with {@link https://nodejs.org/api/child_process.html#optionsdetached | `detached: true`}
 * which creates a new process group; a negative PID kill
 * (`process.kill(-pid, sig)`) signals every process in the group.
 * On Windows, falls back to `taskkill /T /F /PID <pid>`.
 *
 * @task T12025
 */
function killProcessTree(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (process.platform === 'win32') {
    const sigFlag = signal === 'SIGKILL' ? '/F' : '';
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', sigFlag].filter(Boolean), {
        stdio: 'ignore',
      });
    } catch {
      // Best-effort — process may already be dead.
    }
    return;
  }
  // POSIX: negative PID = process group
  try {
    process.kill(-pid, signal);
  } catch (err: unknown) {
    // ESRCH = process already dead; ignore. EPERM = not our group — in that
    // case fall back to killing just the immediate child (detached wasn't
    // honored, e.g. inside a container without CAP_SYS_PTRACE).
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') {
      try {
        process.kill(pid, signal);
      } catch {
        // Already dead.
      }
    }
  }
}

function spawnCmd(
  cmd: string,
  args: string[],
  cwd: string,
  spawnTimeoutMs?: number,
  envOverlay?: Readonly<Record<string, string>>,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const stdoutBuf = new TailBuffer(STREAM_TAIL_CAP_BYTES);
    const stderrBuf = new TailBuffer(STREAM_TAIL_CAP_BYTES);
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // T12096: the overlay carries a hard memory ceiling for heavy tools. It is
      // applied HERE, at the one place CLEO starts a project's own toolchain,
      // because a consuming project cannot be relied on to bound its own test
      // runner — and CLEO's semaphore counts this whole tree as a single slot
      // even when it fans out across a workspace.
      env: envOverlay === undefined ? process.env : { ...process.env, ...envOverlay },
      // T12025: detached creates a new process group on POSIX so that
      // killProcessTree can signal every descendant. Without this a
      // tool like `pnpm test` that forks worker processes inheriting
      // stdout/stderr pipes would leave descendants keeping pipes open,
      // preventing the `close` event from ever firing.
      detached: true,
    });
    child.stdout?.on('data', (d: Buffer) => {
      stdoutBuf.append(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderrBuf.append(d);
    });

    let timedOut = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = () => {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    };

    const finalise = (exitCode: number | null) => {
      clearTimers();
      resolve({ exitCode, stdout: stdoutBuf.toString(), stderr: stderrBuf.toString(), timedOut });
    };

    child.on('error', () => {
      finalise(null);
    });
    child.on('close', (code) => {
      finalise(code);
    });

    if (spawnTimeoutMs !== undefined && spawnTimeoutMs > 0) {
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        if (child.exitCode === null && child.signalCode === null) {
          killProcessTree(child.pid!, 'SIGTERM');
        }
        forceKillTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            killProcessTree(child.pid!, 'SIGKILL');
          }
        }, GRACEFUL_KILL_MS);
      }, spawnTimeoutMs);
    }
  });
}

/**
 * Capture the repo's git HEAD sha. Returns `null` when the directory is not
 * a git checkout or the command fails.
 *
 * @task T1534
 */
export async function captureHead(projectRoot: string): Promise<string | null> {
  const r = await spawnCmd('git', ['rev-parse', 'HEAD'], projectRoot);
  if (r.exitCode !== 0) return null;
  return r.stdout.trim() || null;
}

/**
 * Capture a fingerprint of the uncommitted TRACKED tree by sha256-hashing
 * `git status --porcelain=v1 --untracked-files=no`. Returns `null` for
 * non-git roots.
 *
 * Two repos with identical tracked content but different uncommitted edits
 * produce different fingerprints — so editing a tracked file before
 * re-verifying always invalidates the cache for tools sensitive to that file.
 *
 * ## Why untracked files are excluded (gh#1221)
 *
 * The fingerprint is captured BEFORE the tool spawns and is the key the
 * result is stored under. When untracked files were included, a tool that
 * emitted any untracked artifact changed the fingerprint that the NEXT call
 * computes — so the tool invalidated its own cache entry simply by running,
 * and the cache could never hit. This is not hypothetical or
 * multi-agent-specific: in this repo `coverage/`, `.vitest/` and `*.log` are
 * not gitignored, so a single suite run is enough. A one-line marker file is
 * enough.
 *
 * Excluding untracked files fixes that at the root, rather than maintaining a
 * per-project list of build-output paths that rots as tooling changes.
 *
 * TRADEOFF (deliberate): a brand-new UNTRACKED source or test file no longer
 * invalidates the cache either, so `cleo verify` can return a cached pass
 * that did not exercise it. Commit the file (HEAD moves, the key moves) or
 * force a fresh run with {@link RunToolOptions.bypassCache} — surfaced as
 * `CLEO_EVIDENCE_FRESH=1`. The alternative — a maintained exclude list — trades
 * a loud, documented staleness for a silent, per-project one.
 *
 * The cache directory itself (`.cleo/cache/`) and other CLEO-managed runtime
 * state (`.cleo/tasks.db`, `.cleo/brain.db`, journal/log files) remain
 * excluded via pathspec so a tracked-and-modified CLEO file cannot reintroduce
 * the same self-invalidation.
 *
 * @task T1534
 * @task T12112 (gh#1221)
 */
export async function captureDirtyFingerprint(projectRoot: string): Promise<string | null> {
  const r = await spawnCmd(
    'git',
    [
      'status',
      '--porcelain=v1',
      // gh#1221: untracked files are the tool's own output as often as they
      // are the operator's input; including them made every tool invalidate
      // its own cache entry. See the docblock TRADEOFF note.
      '--untracked-files=no',
      '--',
      '.',
      ':(exclude).cleo/cache',
      ':(exclude).cleo/cache/**',
      ':(exclude).cleo/audit',
      ':(exclude).cleo/audit/**',
      ':(exclude).cleo/backups',
      ':(exclude).cleo/backups/**',
      ':(exclude).cleo/session-journals',
      ':(exclude).cleo/session-journals/**',
      ':(exclude).cleo/*.db',
      ':(exclude).cleo/*.db-wal',
      ':(exclude).cleo/*.db-shm',
    ],
    projectRoot,
  );
  if (r.exitCode !== 0) return null;
  return createHash('sha256').update(r.stdout).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// Cache directory + entry IO
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path for a cache entry by key.
 *
 * @task T1534
 */
export function cacheEntryPath(projectRoot: string, key: string): string {
  return join(projectRoot, '.cleo', 'cache', 'evidence', `${key}.json`);
}

function ensureCacheDir(projectRoot: string): string {
  const dir = join(projectRoot, '.cleo', 'cache', 'evidence');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Read a cache entry by key. Returns `null` when the entry is missing,
 * unreadable, schema-incompatible, or a transient lock placeholder
 * (`{ pending: true }`) written by a concurrent process that has not yet
 * captured a real result.
 *
 * @task T1534
 */
export function readCacheEntry(projectRoot: string, key: string): ToolCacheEntry | null {
  const path = cacheEntryPath(projectRoot, key);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ToolCacheEntry> & {
      pending?: boolean;
    };
    if (parsed.schemaVersion !== 1 || parsed.key !== key) return null;
    // A placeholder written by `runToolCached` to satisfy proper-lockfile's
    // "file must exist" requirement. It carries no real result — treat as
    // a miss until the lock holder writes the entry.
    if (parsed.pending === true) return null;
    return parsed as ToolCacheEntry;
  } catch {
    return null;
  }
}

/**
 * Atomically write a cache entry: writes to `.tmp` then renames so concurrent
 * readers never observe a half-written file.
 *
 * @task T1534
 */
export function writeCacheEntry(projectRoot: string, entry: ToolCacheEntry): void {
  ensureCacheDir(projectRoot);
  const finalPath = cacheEntryPath(projectRoot, entry.key);
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(entry, null, 2), 'utf-8');
  renameSync(tmpPath, finalPath);
}

// ---------------------------------------------------------------------------
// runToolCached — the main entry point used by validateTool
// ---------------------------------------------------------------------------

/**
 * Run a resolved tool command with caching + cross-process locking.
 *
 * Flow:
 *
 *   1. Compute cache key (canonical+cmd+args+head+dirtyFingerprint).
 *   2. If a fresh entry exists → return it (no spawn).
 *   3. Acquire a `proper-lockfile` on the cache entry path.
 *   4. Re-check cache inside the lock (another process may have written it
 *      while we were waiting).
 *   5. Spawn the tool, capture stdout/stderr tails, write the entry, return.
 *
 * Locks are auto-released on success or failure. Stale locks are reaped per
 * the `lockStaleMs` option (default 10 min — long enough to cover a full
 * monorepo test suite).
 *
 * @param command - Resolved tool command from the resolver.
 * @param projectRoot - Absolute path to the project root.
 * @param opts - Options.
 * @returns Result envelope with `exitCode`, `stdoutTail`, `cacheHit`, etc.
 *
 * @task T1534
 * @adr ADR-061
 */
export async function runToolCached(
  command: ResolvedToolCommand,
  projectRoot: string,
  opts: RunToolOptions = {},
): Promise<ToolRunResult> {
  const tailBytes = opts.tailBytes ?? 512;
  const lockStaleMs = opts.lockStaleMs ?? 600_000;
  // T12105 / gh#1193: an explicit opts value (tests) wins; otherwise the
  // CLEO_TOOL_TIMEOUT_<CANONICAL> env override, else the 5 min default.
  const spawnTimeoutMs = opts.spawnTimeoutMs ?? resolveSpawnTimeoutMs(command.canonical);

  // gh#1220/#1226/#1230: the tool runs in — and is fingerprinted against —
  // the caller's tree, which is NOT necessarily the store root. The cache
  // ENTRY still lives under `projectRoot` so every worktree shares one cache;
  // that is sound because the key is content-addressed (HEAD + tracked
  // fingerprint), so two trees only collide when they hold the same code.
  const executionRoot = opts.executionRoot ?? projectRoot;

  // gh#1221 escape hatch. The fingerprint covers TRACKED content only, so an
  // uncommitted NEW file does not invalidate the cache; this is the
  // documented way to force a measured run without committing first.
  // An explicit option always wins over the env var.
  const bypassCache = opts.bypassCache ?? process.env['CLEO_EVIDENCE_FRESH'] === '1';

  const head = await captureHead(executionRoot);
  const dirtyFingerprint = await captureDirtyFingerprint(executionRoot);
  const key = computeCacheKey(command, head, dirtyFingerprint);

  // Fast path — fresh cache hit
  if (!bypassCache) {
    const existing = readCacheEntry(projectRoot, key);
    if (existing) {
      return {
        exitCode: existing.exitCode,
        stdoutTail: existing.stdoutTail,
        stderrTail: existing.stderrTail,
        durationMs: existing.durationMs,
        cacheHit: true,
        timedOut: false,
        lockBusy: false,
        executionRoot,
        entry: existing,
      };
    }
  }

  // Slow path:
  //   1. Acquire the global per-tool semaphore (bounds total concurrent
  //      runs of this canonical across all worktrees / projects on the
  //      machine — protects CPU and resident memory).
  //   2. Inside the semaphore, acquire a per-key file lock to coalesce
  //      concurrent verifies that share the same cache key.
  //   3. Re-check cache inside the per-key lock; spawn only if still
  //      missing; write the entry; release in reverse order.
  //
  // Order matters: acquiring the semaphore FIRST means workers blocked on
  // the global limit are not also holding per-key locks, which keeps the
  // per-key lock turnover fast. Acquiring the per-key lock SECOND means
  // we still get cache-hit coalescing for sibling verifies.
  ensureCacheDir(projectRoot);
  const cachePath = cacheEntryPath(projectRoot, key);
  if (!existsSync(cachePath)) {
    writeFileSync(cachePath, JSON.stringify({ schemaVersion: 1, key, pending: true }), 'utf-8');
  }

  const releaseSemaphore = opts.skipGlobalSemaphore
    ? undefined
    : await acquireGlobalSlot(command.canonical, opts.semaphoreOptions);

  try {
    return await withLock(
      cachePath,
      async () => {
        // Inside the lock — re-check the cache. If another process beat us to
        // it, prefer its result.
        if (!bypassCache) {
          const fresh = readCacheEntry(projectRoot, key);
          if (fresh) {
            return {
              exitCode: fresh.exitCode,
              stdoutTail: fresh.stdoutTail,
              stderrTail: fresh.stderrTail,
              durationMs: fresh.durationMs,
              cacheHit: true,
              timedOut: false,
              lockBusy: false,
              executionRoot,
              entry: fresh,
            };
          }
        }

        // Spawn the tool ourselves.
        const startedAt = Date.now();
        const result = await spawnCmd(
          command.cmd,
          command.args,
          executionRoot,
          spawnTimeoutMs,
          heavyToolEnv(command.canonical),
        );
        const durationMs = Date.now() - startedAt;

        // T12025: when the child exceeded its wall-clock deadline, do NOT
        // persist a cache entry — the run produced no real result. The lock
        // is released via withLock's finally so a subsequent retry can
        // acquire it and attempt a fresh spawn from the same pending entry.
        if (result.timedOut) {
          return {
            exitCode: result.exitCode,
            stdoutTail: tailString(result.stdout, tailBytes),
            stderrTail: tailString(result.stderr, tailBytes),
            durationMs,
            cacheHit: false,
            timedOut: true,
            lockBusy: false,
            executionRoot,
            entry: {
              schemaVersion: 1,
              key,
              canonical: command.canonical,
              displayName: command.displayName,
              cmd: command.cmd,
              args: command.args,
              source: command.source,
              head,
              dirtyFingerprint,
              exitCode: null,
              stdoutTail: '',
              stderrTail: '',
              durationMs,
              capturedAt: new Date().toISOString(),
            },
          };
        }

        const entry: ToolCacheEntry = {
          schemaVersion: 1,
          key,
          canonical: command.canonical,
          displayName: command.displayName,
          cmd: command.cmd,
          args: command.args,
          source: command.source,
          head,
          dirtyFingerprint,
          exitCode: result.exitCode,
          stdoutTail: tailString(result.stdout, tailBytes),
          stderrTail: tailString(result.stderr, tailBytes),
          durationMs,
          capturedAt: new Date().toISOString(),
        };

        writeCacheEntry(projectRoot, entry);

        return {
          exitCode: entry.exitCode,
          stdoutTail: entry.stdoutTail,
          stderrTail: entry.stderrTail,
          durationMs: entry.durationMs,
          cacheHit: false,
          timedOut: false,
          lockBusy: false,
          executionRoot,
          entry,
        };
      },
      { stale: lockStaleMs, retries: 3 },
    );
  } catch (err: unknown) {
    // T12025 (lock contention): a held cache lock causes ~47 s of blind
    // proper-lockfile retries (50 × exponential backoff). Reduce to 3
    // retries (~0.7 s fail-fast) and return a typed actionable result
    // so callers surface E_EVIDENCE_TOOL_BUSY instead of a generic error.
    // Only surface lockBusy for actual ELOCKED contention — permission
    // errors and other lock failures are re-thrown as real errors.
    if (err instanceof CleoError && err.code === ExitCode.LOCK_TIMEOUT) {
      const causeCode = (err.cause as { code?: string } | undefined)?.code;
      if (causeCode === 'ELOCKED') {
        return {
          exitCode: null,
          stdoutTail: '',
          stderrTail: '',
          durationMs: 0,
          cacheHit: false,
          timedOut: false,
          lockBusy: true,
          executionRoot,
          entry: {
            schemaVersion: 1,
            key,
            canonical: command.canonical,
            displayName: command.displayName,
            cmd: command.cmd,
            args: command.args,
            source: command.source,
            head,
            dirtyFingerprint,
            exitCode: null,
            stdoutTail: '',
            stderrTail: '',
            durationMs: 0,
            capturedAt: new Date().toISOString(),
          },
        };
      }
    }
    throw err;
  } finally {
    if (releaseSemaphore) await releaseSemaphore();
  }
}

function tailString(s: string, max: number): string {
  if (s.length <= max) return s;
  return '…' + s.slice(s.length - max + 1);
}

// ---------------------------------------------------------------------------
// Cache maintenance — exposed for `cleo admin` and tests
// ---------------------------------------------------------------------------

/**
 * Clear all cached evidence-tool entries for a project.
 *
 * @task T1534
 */
export function clearToolCache(projectRoot: string): { removed: number } {
  const dir = join(projectRoot, '.cleo', 'cache', 'evidence');
  if (!existsSync(dir)) return { removed: 0 };
  const entries = readdirSync(dir);
  let removed = 0;
  for (const e of entries) {
    if (e.endsWith('.json')) {
      try {
        rmSync(join(dir, e), { force: true });
        removed++;
      } catch {
        // ignore — best-effort
      }
    }
  }
  return { removed };
}
