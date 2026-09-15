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
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { withLock } from '../store/lock.js';
import { heavyToolEnv } from './heavy-tool-env.js';
import { withMemoryLimit } from './heavy-tool-limit.js';
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
  /**
   * Schema version for forwards compatibility.
   *
   * Bumped 1 -> 2 by gh#1419, which added {@link ToolCacheEntry.executionRoot}
   * to the run's identity. Every entry written before that field existed is
   * refused wholesale by {@link readCacheEntry} on this one comparison.
   *
   * That is the mechanism gh#1380 and gh#1404 each rebuilt by hand. Both
   * needed to retire entries already on disk in consumers' caches, and both
   * did it with a bespoke null-check on the field they had just added —
   * `exitCode === null`, then `head === null` — while this field, whose entire
   * purpose is to retire incompatible entries, stayed at 1 through both.
   * Two defects, two hand-written retirement clauses, one unused version
   * counter sitting between them.
   *
   * @task T12190 (gh#1419)
   */
  schemaVersion: 2;
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
  /**
   * Absolute, symlink-resolved path of the tree the tool actually ran in.
   *
   * Part of the run's IDENTITY (see {@link TOOL_RUN_IDENTITY_FIELDS}), so it
   * is in the cache key: two clean worktrees at the same HEAD no longer
   * collide. They used to by construction — a clean tree's
   * `dirtyFingerprint` is the empty-input hash in every worktree, so the old
   * key `{canonical, cmd, args, head, dirtyFingerprint}` was byte-identical
   * across them.
   *
   * Stored as well as keyed, so a hit can be AUDITED. Before this field,
   * `ToolCacheEntry` carried no directory at all: a field survey of 259 tool
   * entries found 0 that could say which tree produced them, and 8 that had
   * been produced in worktrees since deleted — every one `exitCode: 0` and
   * still servable, which makes the evidence unfalsifiable rather than merely
   * stale. Nobody can go and look.
   *
   * @task T12190 (gh#1419)
   */
  executionRoot: string;
  /** Process exit code. */
  exitCode: number | null;
  /**
   * POSIX signal that terminated the run, when one did (gh#1381).
   *
   * Optional because entries written before this field existed do not carry
   * it; absent and `null` both mean "not killed by a signal".
   */
  signal?: NodeJS.Signals | null;
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
  /**
   * POSIX signal that terminated the run, or `null`. Non-null means the tool
   * STARTED and was killed — which is a different fact from `exitCode: null`
   * alone, and the one the caller needs to avoid reporting a killed run as a
   * missing binary (gh#1381).
   */
  signal: NodeJS.Signals | null;
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
 * Wall-clock deadline for the HEAVY tool classes (`test`, `build`), in ms.
 *
 * ## Why these need their own default (gh#1221)
 *
 * A test suite is categorically not a linter. The single 300s default was
 * below a real monorepo suite — measured ~10 min in the gh#1221 report — so
 * EVERY run was killed before finishing, and the timeout path deliberately
 * caches nothing (T12025, correct: an unfinished run is not a result). The
 * cache could therefore never hit, not because the key moved but because no
 * entry was ever produced, on a path that always fired. Each attempt still ran
 * the suite at full parallelism for the full 300s before discarding it — the
 * worst possible shape, and the load multiplier that wedged shared hosts.
 *
 * 30 min is 3x the measured ~10 min suite, so a project whose suite triples
 * still completes on the default rather than discovering an env var after
 * burning 5 CPU-minutes to learn its name. It is a ceiling on a pathological
 * hang, not a budget anyone should plan to use.
 *
 * ## Why a longer rope is safe now, and was not before
 *
 * Raising a deadline means a runaway suite runs LONGER before anything stops
 * it, and the 300s kill was accidentally acting as a crude memory
 * circuit-breaker. Heavy tools are now spawned inside a memory-bounded scope
 * with swap denied (T12116), so duration no longer converts into unbounded
 * host memory: a runaway dies inside its own boundary and CLEO reports a
 * failed run. A failed test run is a result; a frozen workstation is not.
 *
 * `lint`, `typecheck`, `audit` and `security-scan` deliberately do NOT inherit
 * this — they are single-process and CPU-bound, and a lint that has run for 5
 * minutes is hung, not busy.
 *
 * @task T12126 (gh#1221)
 */
export const HEAVY_TOOL_SPAWN_TIMEOUT_MS = 1_800_000;

/**
 * Canonical tools that get {@link HEAVY_TOOL_SPAWN_TIMEOUT_MS}.
 *
 * Matches the memory-bound heavy classes rather than being a second, separate
 * opinion about which tools are expensive — the two must not drift.
 *
 * @task T12126 (gh#1221)
 */
const HEAVY_TIMEOUT_TOOLS: ReadonlySet<string> = new Set(['test', 'build']);

/**
 * The default wall-clock deadline for a canonical tool, before any env
 * override.
 *
 * @param canonical - Canonical tool name from the resolver.
 * @returns Deadline in milliseconds.
 *
 * @task T12126 (gh#1221)
 */
export function defaultSpawnTimeoutMs(canonical: string): number {
  return HEAVY_TIMEOUT_TOOLS.has(canonical)
    ? HEAVY_TOOL_SPAWN_TIMEOUT_MS
    : DEFAULT_SPAWN_TIMEOUT_MS;
}

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
  const fallback = defaultSpawnTimeoutMs(canonical);
  const raw = env[envKey];
  if (raw === undefined || raw.trim() === '') return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `${envKey} must be a positive integer (milliseconds), got "${raw}".`,
      {
        fix: `Set ${envKey} to a millisecond value such as 600000 (10 min), or unset it to use the ${fallback}ms default.`,
      },
    );
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (parsed <= 0) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `${envKey} must be greater than zero, got ${parsed}.`,
      {
        fix: `Set ${envKey} to a positive millisecond value such as 600000 (10 min), or unset it to use the ${fallback}ms default.`,
      },
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Cache key derivation
// ---------------------------------------------------------------------------

/**
 * The fields that establish WHICH RUN a cache entry describes.
 *
 * This list is the single source of truth for three things that must agree
 * and previously did not, because each was maintained by hand:
 *
 *   1. what {@link computeCacheKey} hashes,
 *   2. what {@link readCacheEntry} requires before serving an entry,
 *   3. what `runToolCached` requires before persisting one.
 *
 * ## Why this exists rather than a fourth guard clause
 *
 * Three defects in three releases, each invisible to the detector written for
 * the one before it:
 *
 * | | gh#1380 (2026.9.2) | gh#1404 (2026.9.3) | gh#1419 (this) |
 * |---|---|---|---|
 * | signature | `exitCode: null` | real code, `head: null` | well-formed, genuinely succeeded |
 * | wrong how | never ran | key cannot rotate | ran, on the wrong tree |
 * | detector | all-null | real code + null head | neither matches |
 *
 * Each fix added one `if` naming one field, to two separate guards — the read
 * path and the write path — that encode the same rule in different code with
 * nothing asserting they agree. A fourth defect means a fourth pair of `if`s,
 * and the pair for defect five is the one somebody edits only half of.
 *
 * The recurring mistake is not any of the three fields. It is that a field
 * could be added to {@link ToolCacheEntry} without being added to the key:
 * `executionRoot` was threaded all the way through execution by T12112 and
 * never reached `computeCacheKey`, so the tool correctly ran in worktree A
 * and its result was then served to worktree B under an identical key. The
 * execution half of that fix landed; the caching half did not.
 *
 * Deriving all three consumers from this one array makes that specific
 * mistake unavailable: a field added here is keyed, required on read, and
 * required on write, together or not at all.
 *
 * ## What is deliberately NOT here
 *
 * `exitCode` is a RESULT, not an identity — it is what the run produced, not
 * which run it was. It has its own non-null requirement in
 * {@link isEntryUsable} (gh#1380: an unknown outcome must never be cached).
 * Putting it here would key the cache on its own answer.
 *
 * @task T12190 (gh#1419)
 */
export const TOOL_RUN_IDENTITY_FIELDS = [
  'canonical',
  'cmd',
  'args',
  'head',
  'dirtyFingerprint',
  'executionRoot',
] as const;

/**
 * The identity half of a {@link ToolCacheEntry} — the inputs that determine
 * which run it is, independent of what that run produced.
 *
 * @task T12190 (gh#1419)
 */
export type ToolRunIdentity = Pick<ToolCacheEntry, (typeof TOOL_RUN_IDENTITY_FIELDS)[number]>;

/**
 * Normalise an execution root to a stable, comparable absolute path.
 *
 * Symlinks are resolved so that two spellings of one directory produce one
 * key — the safe direction, since collapsing an alias can only merge entries
 * that genuinely describe the same tree, while failing to collapse it would
 * split one tree's cache across spellings. A path that cannot be resolved
 * (it has been deleted) falls back to lexical resolution rather than
 * throwing: callers of {@link computeCacheKey} must be able to compute the
 * key of a run whose directory is already gone, precisely so
 * {@link readCacheEntry} can then refuse it.
 *
 * @task T12190 (gh#1419)
 */
function normalizeExecutionRoot(executionRoot: string): string {
  try {
    return realpathSync(executionRoot);
  } catch {
    return resolve(executionRoot);
  }
}

/**
 * Compute the cache key for a resolved tool command + repo state.
 *
 * The key covers exactly {@link TOOL_RUN_IDENTITY_FIELDS} — canonical tool
 * name, resolved command and args, git HEAD, dirty-tree fingerprint, and the
 * normalised execution root. Fields are projected in the order that array
 * declares, so the hashed payload is a function of the array and adding a
 * field there changes every key by construction.
 *
 * `executionRoot` is a REQUIRED parameter, deliberately. A defaulted one
 * would let every callsite that was not updated keep computing the old,
 * colliding key while the type-checker reported success — which is the exact
 * shape of the defect this fixes, since `executionRoot` already existed and
 * already reached this function's caller.
 *
 * Using `createHash('sha256')` makes the key collision-resistant and bounded
 * to 32 hex chars regardless of input size.
 *
 * @task T1534
 * @task T12190 (gh#1419)
 */
export function computeCacheKey(
  command: ResolvedToolCommand,
  head: string | null,
  dirtyFingerprint: string | null,
  executionRoot: string,
): string {
  const identity: ToolRunIdentity = {
    canonical: command.canonical,
    cmd: command.cmd,
    args: command.args,
    head,
    dirtyFingerprint,
    executionRoot: normalizeExecutionRoot(executionRoot),
  };
  // Projected through TOOL_RUN_IDENTITY_FIELDS rather than written as an
  // object literal: the literal is what drifted from the entry shape before.
  const payload = JSON.stringify(TOOL_RUN_IDENTITY_FIELDS.map((f) => identity[f]));
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/**
 * Whether a cache entry may be SERVED or PERSISTED as a real result.
 *
 * One predicate, used by both {@link readCacheEntry} and the persist guard in
 * `runToolCached`, so the two cannot drift apart. Two rules:
 *
 *   1. every field in {@link TOOL_RUN_IDENTITY_FIELDS} is present and
 *      non-null — an entry that cannot say which run it describes is not
 *      evidence of anything;
 *   2. `exitCode` is non-null — a run that produced no exit code records that
 *      we do not know what happened, and an unknown must never be cached
 *      (gh#1380).
 *
 * Rule 1 subsumes gh#1404's `head === null` clause without naming `head`:
 * when the tool runs off a non-git root both git fields are null on EVERY
 * run, so the key is a function of the command alone and nothing a developer
 * does to the source can rotate it. That is not a cache, it is a hardcoded
 * answer with a filename — and unlike gh#1380 it holds a real exit code,
 * which can be a PASS. A poisoned red is investigated within minutes; nobody
 * debugs a passing gate.
 *
 * The cost is stated rather than hidden: a project whose CLEO root is not a
 * git checkout gets no tool-result caching at all. Such projects are not
 * getting valid caching today — they are getting one answer forever.
 *
 * @task T12190 (gh#1419)
 */
export function isEntryUsable(entry: Partial<ToolCacheEntry>): boolean {
  for (const field of TOOL_RUN_IDENTITY_FIELDS) {
    const value = entry[field];
    if (value === null || value === undefined) return false;
  }
  return entry.exitCode !== null && entry.exitCode !== undefined;
}

// ---------------------------------------------------------------------------
// Repo-state fingerprinting
// ---------------------------------------------------------------------------

interface CommandResult {
  exitCode: number | null;
  /**
   * POSIX signal name that terminated the child, or `null` when it exited
   * normally (or never started).
   *
   * gh#1381: Node's `close` event is `(code, signal)` and exactly one of them
   * is non-null. Binding only `code` collapses "killed after running" and
   * "never started" into the same `exitCode: null`, one line after the two
   * were distinguishable — and the caller then reports a 41-minute OOM-killed
   * test suite as "binary missing or spawn error".
   */
  signal: NodeJS.Signals | null;
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

    const finalise = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      clearTimers();
      resolve({
        exitCode,
        signal,
        stdout: stdoutBuf.toString(),
        stderr: stderrBuf.toString(),
        timedOut,
      });
    };

    // A genuine pre-start failure: ENOENT, EACCES, EAGAIN. No signal, no code.
    child.on('error', () => {
      finalise(null, null);
    });
    // gh#1381: `close` passes `(code, signal)` and exactly one is non-null.
    // The signal arm is the OOM case — `withMemoryLimit` runs `test`/`build`
    // inside a systemd scope with `MemorySwapMax=0`, so the kernel SIGKILLs
    // the whole cgroup when the suite exceeds the ceiling. Dropping `signal`
    // here is what made that indistinguishable from a missing binary.
    child.on('close', (code, signal) => {
      finalise(code, signal);
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

    // Schema gate. Bumped to 2 by gh#1419; every entry written before
    // `executionRoot` was part of a run's identity is refused here, on this
    // one line. gh#1380 and gh#1404 each needed exactly this and each
    // reimplemented it as a bespoke null-check on their own field, while this
    // counter sat unused at 1 through both.
    if (parsed.schemaVersion !== 2 || parsed.key !== key) return null;

    // A placeholder written by `runToolCached` to satisfy proper-lockfile's
    // "file must exist" requirement. It carries no real result — treat as
    // a miss until the lock holder writes the entry. Checked before the
    // identity gate below because a placeholder legitimately has none.
    if (parsed.pending === true) return null;

    // The identity + result gate (gh#1380, gh#1404, gh#1419), derived from
    // TOOL_RUN_IDENTITY_FIELDS rather than written out field by field, and
    // shared verbatim with the persist guard in `runToolCached`.
    if (!isEntryUsable(parsed)) return null;

    // gh#1419: refuse a hit whose originating tree is GONE.
    //
    // Keying on `executionRoot` stops one live worktree from being served
    // another live worktree's result. It does not address the worse case the
    // field survey actually found: 8 entries produced in worktrees that had
    // since been deleted, all `exitCode: 0`, all still servable. A stale
    // result is merely wrong; a result whose tree no longer exists is
    // UNFALSIFIABLE — there is nowhere left to go and check what ran.
    //
    // This is the one rule that is genuinely read-only. At write time the
    // directory exists by construction, so it cannot live in `isEntryUsable`
    // alongside the rules both paths share.
    if (!existsSync(parsed.executionRoot as string)) return null;

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
  const key = computeCacheKey(command, head, dirtyFingerprint, executionRoot);

  // Fast path — fresh cache hit
  if (!bypassCache) {
    const existing = readCacheEntry(projectRoot, key);
    if (existing) {
      return {
        exitCode: existing.exitCode,
        signal: existing.signal ?? null,
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
    writeFileSync(cachePath, JSON.stringify({ schemaVersion: 2, key, pending: true }), 'utf-8');
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
              signal: fresh.signal ?? null,
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
        //
        // T12116: `test` and `build` run inside a transient systemd scope with
        // a hard `MemoryMax` and `MemorySwapMax=0`, so the kernel bounds the
        // ENTIRE process tree — a `pnpm -r` fan-out into fifteen packages is
        // still one cgroup, which is the multiplier the semaphore could not
        // see. Denying swap is the point: the failure this guards against was
        // a throttle-and-thrash host freeze, not an OOM kill. Degrades to an
        // unwrapped spawn off Linux or without a user systemd manager.
        const limited = withMemoryLimit(command.canonical, command.cmd, command.args);
        const startedAt = Date.now();
        const result = await spawnCmd(
          limited.cmd,
          [...limited.args],
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
            signal: result.signal,
            stdoutTail: tailString(result.stdout, tailBytes),
            stderrTail: tailString(result.stderr, tailBytes),
            durationMs,
            cacheHit: false,
            timedOut: true,
            lockBusy: false,
            executionRoot,
            entry: {
              schemaVersion: 2,
              key,
              canonical: command.canonical,
              displayName: command.displayName,
              cmd: command.cmd,
              args: command.args,
              source: command.source,
              head,
              dirtyFingerprint,
              executionRoot,
              exitCode: null,
              signal: result.signal,
              stdoutTail: '',
              stderrTail: '',
              durationMs,
              capturedAt: new Date().toISOString(),
            },
          };
        }

        const entry: ToolCacheEntry = {
          schemaVersion: 2,
          key,
          canonical: command.canonical,
          displayName: command.displayName,
          cmd: command.cmd,
          args: command.args,
          source: command.source,
          head,
          dirtyFingerprint,
          executionRoot,
          exitCode: result.exitCode,
          signal: result.signal,
          stdoutTail: tailString(result.stdout, tailBytes),
          stderrTail: tailString(result.stderr, tailBytes),
          durationMs,
          capturedAt: new Date().toISOString(),
        };

        // Persist only a usable entry. `isEntryUsable` is the SAME predicate
        // `readCacheEntry` applies, which is the point: these two guards used
        // to be independent transcriptions of one rule — `exitCode !== null
        // && head !== null`, written out twice — so a field added to one had
        // to be remembered into the other. gh#1380 and gh#1404 each edited
        // both, and nothing checked that they still agreed.
        //
        // What the shared predicate refuses, and why none of it is an
        // overcorrection:
        //   - unknown outcome (`exitCode: null`) — a signal kill, or a
        //     failure to start. The `timedOut` branch above already returns
        //     without writing for this reason; an OOM kill that is not a CLEO
        //     timeout (gh#1381) had no equivalent guard and fell through here.
        //   - unrotatable key (`head: null`) — costs a non-git CLEO root all
        //     caching. Stated rather than hidden: those projects are not
        //     getting valid caching today, they are getting ONE answer
        //     forever, and a slow correct answer beats a fast fabricated one.
        //   - unattributable run (`executionRoot` absent) — cannot occur on
        //     this path, and is required here anyway so that read and write
        //     stay ONE rule rather than two that happen to match today.
        //
        // Deliberately narrow in the other direction too: refusing, say, all
        // non-zero exits would trade a fabricated pass for a permanent cache
        // miss on healthy projects — the same overcorrection pointed the
        // other way.
        if (isEntryUsable(entry)) {
          writeCacheEntry(projectRoot, entry);
        }

        return {
          exitCode: entry.exitCode,
          signal: entry.signal ?? null,
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
          signal: null,
          stdoutTail: '',
          stderrTail: '',
          durationMs: 0,
          cacheHit: false,
          timedOut: false,
          lockBusy: true,
          executionRoot,
          entry: {
            schemaVersion: 2,
            key,
            canonical: command.canonical,
            displayName: command.displayName,
            cmd: command.cmd,
            args: command.args,
            source: command.source,
            head,
            dirtyFingerprint,
            executionRoot,
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
