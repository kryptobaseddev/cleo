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

import { spawn } from 'node:child_process';
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

import { withLock } from '../store/lock.js';
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
 */
export interface ToolRunResult {
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
  /** `true` when the result came from cache (no spawn occurred). */
  cacheHit: boolean;
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
   * @defaultValue `false`
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

function spawnCmd(cmd: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    const stdoutBuf = new TailBuffer(STREAM_TAIL_CAP_BYTES);
    const stderrBuf = new TailBuffer(STREAM_TAIL_CAP_BYTES);
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    child.stdout?.on('data', (d: Buffer) => {
      stdoutBuf.append(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderrBuf.append(d);
    });
    child.on('error', () => {
      resolve({ exitCode: null, stdout: stdoutBuf.toString(), stderr: stderrBuf.toString() });
    });
    child.on('close', (code) => {
      resolve({ exitCode: code, stdout: stdoutBuf.toString(), stderr: stderrBuf.toString() });
    });
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
 * Capture a fingerprint of the uncommitted tree by sha256-hashing
 * `git status --porcelain=v1`. Returns `null` for non-git roots.
 *
 * Two repos with identical tracked content but different uncommitted edits
 * produce different fingerprints — so editing a file before re-verifying
 * always invalidates the cache for tools sensitive to that file.
 *
 * The cache directory itself (`.cleo/cache/`) and other CLEO-managed runtime
 * state (`.cleo/tasks.db`, `.cleo/brain.db`, journal/log files) are excluded
 * from the fingerprint via pathspec. Without this exclusion the cache would
 * invalidate itself on every write — call #1 writes its entry, call #2 sees
 * the new file in `git status` and records a different fingerprint.
 *
 * @task T1534
 */
export async function captureDirtyFingerprint(projectRoot: string): Promise<string | null> {
  const r = await spawnCmd(
    'git',
    [
      'status',
      '--porcelain=v1',
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

  const head = await captureHead(projectRoot);
  const dirtyFingerprint = await captureDirtyFingerprint(projectRoot);
  const key = computeCacheKey(command, head, dirtyFingerprint);

  // Fast path — fresh cache hit
  if (!opts.bypassCache) {
    const existing = readCacheEntry(projectRoot, key);
    if (existing) {
      return {
        exitCode: existing.exitCode,
        stdoutTail: existing.stdoutTail,
        stderrTail: existing.stderrTail,
        durationMs: existing.durationMs,
        cacheHit: true,
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
        if (!opts.bypassCache) {
          const fresh = readCacheEntry(projectRoot, key);
          if (fresh) {
            return {
              exitCode: fresh.exitCode,
              stdoutTail: fresh.stdoutTail,
              stderrTail: fresh.stderrTail,
              durationMs: fresh.durationMs,
              cacheHit: true,
              entry: fresh,
            };
          }
        }

        // Spawn the tool ourselves.
        const startedAt = Date.now();
        const result = await spawnCmd(command.cmd, command.args, projectRoot);
        const durationMs = Date.now() - startedAt;

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
          entry,
        };
      },
      { stale: lockStaleMs, retries: 50 },
    );
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
