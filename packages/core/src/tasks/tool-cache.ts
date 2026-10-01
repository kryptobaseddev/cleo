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
 *   1. **Content-addressed cache** — keyed on `(canonical, cmd, args,
 *      treeHash)`, where `treeHash` is the git tree of the tracked content as
 *      it sits in the working tree (T12958, see {@link captureTreeHash}).
 *      Cache hits return the prior `exitCode + stdoutTail` without spawning
 *      the tool. Two worktrees holding the same content, or a commit, rebase
 *      or amend that leaves the tree unchanged, share one result.
 *   2. **Cross-process semaphore** — when N processes simultaneously miss the
 *      cache, only one runs the tool; the rest block on a `proper-lockfile`
 *      and read the freshly-written cache entry.
 *   3. **Automatic invalidation** — entries become unreachable as soon as the
 *      tracked content changes, because the key moves with it. Nothing is
 *      deleted on access (no GC daemon required).
 *   4. **Failed-first reruns** — a failing `test` run remembers its failing
 *      test files; the next run re-runs those first and stops if they still
 *      fail (T12961, see `tool-cache-failed-first.ts`).
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
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { isLocked, withLock } from '../store/lock.js';
import { heavyToolEnv } from './heavy-tool-env.js';
import {
  confinementStartupFailure,
  isSystemdRunCommand,
  withMemoryLimit,
} from './heavy-tool-limit.js';
import {
  FAILED_FIRST_TOOLS,
  type FailedFirstReport,
  type FocusedRun,
  parseFailingTestFiles,
  planFocusedRuns,
  readFailedFirstPointer,
  reportsNoTestFiles,
  summarizedFailedFileCount,
  writeFailedFirstPointer,
} from './tool-cache-failed-first.js';
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
   * to the run's identity, and 2 -> 3 by T12958, which replaced HEAD + dirty
   * fingerprint + execution root with the tree hash. Every entry written under
   * an older identity is refused wholesale by {@link readCacheEntry} on this
   * one comparison — the retirement mechanism gh#1380 and gh#1404 each rebuilt
   * by hand with a bespoke null-check on the field they had just added.
   *
   * @task T12190 (gh#1419)
   * @task T12958
   */
  schemaVersion: typeof TOOL_CACHE_SCHEMA_VERSION;
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
  /**
   * Git tree object of the tracked content the run measured — HEAD's tree with
   * every uncommitted tracked change applied (see {@link captureTreeHash}).
   *
   * This is the run's content IDENTITY and the only repo-state input to the
   * key (T12958). It replaced `head` + `dirtyFingerprint` + `executionRoot`,
   * which named WHERE and AFTER WHICH COMMIT a run happened rather than WHAT it
   * measured, so every worktree and every commit missed — including an empty
   * commit or a rebase that left the content byte-identical.
   *
   * The tree object is written to the repository's (shared) object database,
   * so a hit stays auditable after the worktree that produced it is deleted:
   * `git ls-tree <treeHash>` shows exactly the content that ran.
   *
   * @task T12958
   */
  treeHash: string | null;
  /** Git HEAD sha at execution time. Informational since T12958: NOT keyed. */
  head: string | null;
  /**
   * Absolute, symlink-resolved path of the tree the tool actually ran in.
   *
   * Recorded for audit, NOT part of the key since T12958. gh#1419 keyed it to
   * stop two worktrees at one HEAD sharing a result while their content
   * differed; the tree hash keys on the content itself, so two trees share a
   * result exactly when they hold the same tracked content, which is the case
   * sharing is correct for. Nothing the tool returns depends on the directory
   * name: the command and args are keyed, and script resolution is a function
   * of the tracked `package.json` content the tree hash covers.
   *
   * The gh#1419 "unfalsifiable after the worktree is deleted" concern is met by
   * {@link ToolCacheEntry.treeHash}: the content is a git object, not a path.
   *
   * @task T12190 (gh#1419)
   * @task T12958
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
  /**
   * Test files (relative to the execution root) that failed in this run, when
   * the tool is `test`, the run failed and the runner's output named them.
   * Absent when unknown.
   *
   * @task T12961
   */
  failedTestFiles?: string[];
  /**
   * Present when a failed-first stage ran before this result. An entry whose
   * `failedFirst.outcome` is `failed` was decided by the focused rerun alone:
   * the previously failing files still failed, so the normal command was
   * never spawned. A failing subset is a failing suite, which is why that
   * result is cached under the normal command's key.
   *
   * @task T12961
   */
  failedFirst?: FailedFirstReport;
  /**
   * Test files that failed and then passed on their single retry (T12961).
   * Present only on a PASSING entry: the run counts as a pass, but a flaky
   * pass, which is visible here rather than indistinguishable from a clean
   * one.
   *
   * @task T12961
   */
  flaky?: string[];
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
  /**
   * The diagnostic line from CLEO's own confinement wrapper when it failed to
   * START the tool, else `null`.
   *
   * gh#1397: `systemd-run --scope` is transparent on success — it exits with
   * the wrapped command's status — but exits `1` when it cannot create the
   * transient unit, and `1` is also what a suite with a failing test exits
   * with. "The harness never started" and "the suite ran and was red" are
   * therefore identical in `exitCode`, and CLEO reported both as
   * `E_EVIDENCE_TOOL_FAILED`: a fast red suite. Five occurrences of gh#1396
   * produced no diagnosis for exactly this reason.
   *
   * Non-null means the tool did NOT run, so nothing is cached and the caller
   * must report an unavailable harness rather than a failing tool.
   *
   * @task T12116 (gh#1397)
   */
  harnessFailure: string | null;
  /**
   * The failed-first stage of this run (T12961), when one ran: which files
   * were re-run first and whether they decided the result.
   */
  failedFirst?: FailedFirstReport;
  /** Test files that failed and passed on retry; set only on a pass (T12961). */
  flaky?: string[];
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
  /**
   * How long a caller that finds this key's lock held waits for the holder's
   * result before giving up with `lockBusy` (T12958). The holder is running
   * the identical command on identical content, so waiting and reusing its
   * result is always cheaper than running in parallel.
   *
   * @defaultValue the spawn deadline + 60 s
   */
  lockWaitMs?: number;
  /**
   * Poll interval while waiting on a held lock.
   *
   * @defaultValue `1_000`
   * @internal
   */
  lockPollMs?: number;
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
 * `head` and `executionRoot` are recorded on every entry but are no longer
 * identity (T12958). Both name a LOCATION — which commit, which directory —
 * rather than the content measured, so keying on them made every worktree and
 * every commit a miss even when the tracked content was byte-identical.
 * `treeHash` is the content itself; it subsumes the old `dirtyFingerprint`.
 *
 * @task T12190 (gh#1419)
 * @task T12958
 */
export const TOOL_RUN_IDENTITY_FIELDS = ['canonical', 'cmd', 'args', 'treeHash'] as const;

/**
 * Current {@link ToolCacheEntry.schemaVersion}. Entries of any other version
 * are refused on read.
 *
 * @task T12958
 */
export const TOOL_CACHE_SCHEMA_VERSION = 3;

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
 * Symlinks are resolved so two spellings of one directory compare equal. A
 * path that cannot be resolved (it has been deleted) falls back to lexical
 * resolution rather than throwing.
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
 * Compute the cache key for a resolved tool command + tracked tree content.
 *
 * The key covers exactly {@link TOOL_RUN_IDENTITY_FIELDS} — canonical tool
 * name, resolved command and args, and the tree hash. Fields are projected in
 * the order that array declares, so the hashed payload is a function of the
 * array and adding a field there changes every key by construction.
 *
 * There is deliberately no directory parameter (T12958): two checkouts with
 * the same tracked content get the same key, which is what lets parallel
 * worktrees and post-rebase re-verifies reuse one run.
 *
 * Using `createHash('sha256')` makes the key collision-resistant and bounded
 * to 32 hex chars regardless of input size.
 *
 * @param command - Resolved tool command.
 * @param treeHash - {@link captureTreeHash} of the execution root.
 * @returns 32 hex chars.
 *
 * @task T1534
 * @task T12190 (gh#1419)
 * @task T12958
 */
export function computeCacheKey(command: ResolvedToolCommand, treeHash: string | null): string {
  const identity: ToolRunIdentity = {
    canonical: command.canonical,
    cmd: command.cmd,
    args: command.args,
    treeHash,
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
 * when the tool runs off a non-git root `treeHash` is null on EVERY run, so
 * the key is a function of the command alone and nothing a developer
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
  /**
   * Node's spawn-error message (`ENOENT`, `EACCES`, `EAGAIN`, …) when the child
   * could not be started at all, else `null`.
   *
   * gh#1397: the `error` handler used to take no argument and resolve
   * `(null, null)`, discarding the one object that said WHY nothing started —
   * the same defect gh#1381 fixed one event-handler over, for `signal`.
   */
  spawnError: string | null;
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

    let spawnError: string | null = null;
    const finalise = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      clearTimers();
      const stderr = stderrBuf.toString();
      resolve({
        exitCode,
        signal,
        stdout: stdoutBuf.toString(),
        // gh#1397: a child that never started wrote nothing to stderr, so the
        // spawn error IS the only diagnostic that exists. Folding it in here
        // means every downstream consumer gets the reason without each one
        // having to remember a second field.
        stderr: spawnError !== null && stderr === '' ? spawnError : stderr,
        timedOut,
        spawnError,
      });
    };

    // A genuine pre-start failure: ENOENT, EACCES, EAGAIN. No signal, no code.
    // gh#1397: keep the reason. `(null, null)` says only "nothing ran"; the
    // error object says which of missing / not-executable / out-of-resources
    // it was, and the caller has no other source for that fact.
    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnError = err.code ? `${err.code}: ${err.message}` : err.message;
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
 * `git diff HEAD` over tracked paths (gh#1452 — see the note on the body for
 * why NOT `git status --porcelain`). Returns `null` for
 * non-git roots.
 *
 * Since T12958 this is NOT part of the tool-cache key — {@link captureTreeHash}
 * replaced it there. It remains the dirty-tree identity for the gate-result
 * cache, and the untracked-file rule below applies to both.
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
/**
 * Pathspec shared by the fingerprint command.
 *
 * CLEO's own runtime state is excluded so a tracked-and-modified CLEO file
 * cannot self-invalidate the cache it is the key for.
 */
const FINGERPRINT_PATHSPEC: readonly string[] = [
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
];

/**
 * Run `git` and hash its stdout as it arrives, without ever holding the whole
 * output in memory.
 *
 * gh#1452: this exists instead of `spawnCmd` because `spawnCmd` accumulates
 * stdout in a {@link TailBuffer} capped at {@link STREAM_TAIL_CAP_BYTES}
 * (64 KiB) and **keeps only the tail**. That is correct for an error tail and
 * catastrophic for a fingerprint: a diff longer than the cap would be hashed
 * from its last 64 KiB only, so a change earlier in the diff would not move the
 * key. Measured: 200 small changed files produce ~30 KB of diff, so a shared
 * working tree reaches the cap at roughly 430 — precisely the large-dirty-tree
 * case gh#1452 was reported from. A fix built on `spawnCmd` would pass on a
 * small repo and fail exactly where it matters.
 *
 * @param args - argv after `git`.
 * @param cwd - directory to run in.
 * @returns 32 hex chars of sha256 over stdout, or `null` if git exited non-zero
 *   or could not be spawned.
 *
 * @task T12218 (gh#1452)
 */
function hashGitStdout(args: readonly string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = createHash('sha256');
    const child = spawn('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout?.on('data', (chunk: Buffer) => hash.update(chunk));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      resolve(code === 0 ? hash.digest('hex').slice(0, 32) : null);
    });
  });
}

export async function captureDirtyFingerprint(projectRoot: string): Promise<string | null> {
  // gh#1452: `git diff HEAD`, NOT `git status --porcelain`.
  //
  // Porcelain reports WHICH paths are dirty and never WHAT is in them, so it is
  // a summary of dirtiness rather than an identity for it. Measured in a
  // scratch repo — a broken edit and its fix to the same tracked file both
  // produce ` M src.ts`, hashing to the identical fingerprint. The key
  // therefore could not rotate when a failure's cause was fixed, and the stale
  // FAILED entry was replayed indefinitely: the reported symptom was an
  // identical error text with `(cached)` in ~700 ms across four task ids, with
  // the only cure being to delete the cache file by hand.
  //
  // `--raw` is NOT an alternative, though it looks like one: for an UNSTAGED
  // edit git reports the destination blob as `0000000`, so
  // `:100644 100644 4b48dee 0000000 M\ta.txt` is byte-identical before and
  // after the fix. It is the same summary defect one layer down.
  //
  // Still TRACKED-only (`diff HEAD` ignores untracked), so the deliberate
  // gh#1221 tradeoff documented above is unchanged — including its escape
  // hatch, `CLEO_EVIDENCE_FRESH=1`. Widening this to untracked content would
  // trade a stale-FAILED bug for the every-tool-invalidates-its-own-cache bug
  // that tradeoff exists to prevent.
  return hashGitStdout(['diff', 'HEAD', ...FINGERPRINT_PATHSPEC], projectRoot);
}

/**
 * Capture the git tree hash of the TRACKED content as it sits in the working
 * tree: HEAD's tree with every uncommitted change to a tracked file applied,
 * whether staged or not. Returns `null` for non-git roots or on any git
 * failure (the entry is then unusable and nothing is cached).
 *
 * ## How (T12958)
 *
 * 1. Copy the checkout's own index to a private temporary file. The copy keeps
 *    the index's stat cache, so git re-hashes only files whose stat changed —
 *    ~90 ms on this ~10k-file monorepo. The real index is never touched, so
 *    this is safe to run while an agent is mid-`git add`.
 * 2. `GIT_INDEX_FILE=<copy> git add -u -- <pathspec>` stages every modified or
 *    deleted TRACKED path into the copy. `-u` never adds untracked files.
 * 3. `GIT_INDEX_FILE=<copy> git write-tree` prints the tree.
 *
 * A clean checkout yields exactly `HEAD^{tree}`. Two worktrees with the same
 * tracked content yield the same hash wherever they live, and an empty commit,
 * an amend of only the message, or a rebase that reproduces the same content
 * leave it unchanged — all of which used to miss.
 *
 * Rejected alternatives: `git stash create` prints nothing for a clean tree,
 * writes a commit object per call, and keys on the stash commit rather than
 * the tree; `HEAD^{tree}` + {@link captureDirtyFingerprint} would still split
 * one content across commits (the diff is relative to a moving HEAD).
 *
 * ## Untracked files
 *
 * Unchanged from the gh#1221 rule documented on
 * {@link captureDirtyFingerprint}: untracked files are NOT part of the key, so
 * a tool that writes artifacts cannot invalidate its own entry. Paths in
 * {@link FINGERPRINT_PATHSPEC}'s exclusions (CLEO runtime state) keep their
 * index state rather than their working-tree state. The escape hatch for a
 * brand-new untracked source file is still `CLEO_EVIDENCE_FRESH=1`.
 *
 * Side effect: `git add -u` writes blob objects for dirty files into the
 * repository's object database. They are ordinary loose objects that
 * `git gc` prunes once unreferenced, and they are what keeps the tree
 * auditable after the worktree is gone.
 *
 * @param root - Directory to fingerprint (the execution root).
 * @returns 40/64 hex chars of the tree object id, or `null`.
 *
 * @task T12958
 */
export async function captureTreeHash(root: string): Promise<string | null> {
  const gitPath = await spawnCmd('git', ['rev-parse', '--git-path', 'index'], root);
  if (gitPath.exitCode !== 0) return null;
  const realIndex = resolve(root, gitPath.stdout.trim());
  let tmpDir: string | null = null;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), 'cleo-tree-'));
    const env = { GIT_INDEX_FILE: join(tmpDir, 'index') };
    if (existsSync(realIndex)) {
      copyFileSync(realIndex, env.GIT_INDEX_FILE);
    } else {
      // No index yet: seed from HEAD. An unborn HEAD leaves the index empty,
      // which is correct — nothing is tracked.
      await spawnCmd('git', ['read-tree', 'HEAD'], root, undefined, env);
    }
    const added = await spawnCmd(
      'git',
      ['add', '-u', ...FINGERPRINT_PATHSPEC],
      root,
      undefined,
      env,
    );
    if (added.exitCode !== 0) return null;
    const tree = await spawnCmd('git', ['write-tree'], root, undefined, env);
    if (tree.exitCode !== 0) return null;
    return tree.stdout.trim() || null;
  } catch {
    return null;
  } finally {
    if (tmpDir !== null) rmSync(tmpDir, { recursive: true, force: true });
  }
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

    // Schema gate. Bumped to 2 by gh#1419 and to 3 by T12958; every entry
    // written under an older identity is refused here, on this one line.
    if (parsed.schemaVersion !== TOOL_CACHE_SCHEMA_VERSION || parsed.key !== key) return null;

    // A placeholder written by `runToolCached` to satisfy proper-lockfile's
    // "file must exist" requirement. It carries no real result — treat as
    // a miss until the lock holder writes the entry. Checked before the
    // identity gate below because a placeholder legitimately has none.
    if (parsed.pending === true) return null;

    // The identity + result gate (gh#1380, gh#1404, gh#1419), derived from
    // TOOL_RUN_IDENTITY_FIELDS rather than written out field by field, and
    // shared verbatim with the persist guard in `runToolCached`.
    if (!isEntryUsable(parsed)) return null;

    // No "originating directory still exists" check since T12958. gh#1419
    // refused hits from deleted worktrees because a path was the only record
    // of what ran; the entry now names the content itself (`treeHash`, a git
    // object in the shared object database), and the key guarantees the
    // reader holds that same content. Refusing on a deleted directory would
    // only force a re-run of identical code in a live sibling worktree.

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
 * Outcome of the failed-first stage, before it is turned into a result.
 *
 * @internal
 */
type FocusedOutcome =
  | { kind: 'passed' | 'inconclusive' }
  | { kind: 'timedOut' | 'failed'; result: CommandResult; durationMs: number; cwd: string }
  | { kind: 'harness'; result: CommandResult; durationMs: number; harnessFailure: string };

/**
 * Run the planned focused invocations in order, stopping at the first one
 * that decides anything (T12961). Each runs under the same memory bound and
 * heavy-tool env as the normal command, and inside the caller's semaphore
 * slot and per-key lock.
 *
 * Only a real, non-zero exit counts as `failed`. A spawn error, a signal kill
 * or vitest reporting that the filters matched nothing is `inconclusive`, and
 * the caller falls back to the normal command — a focused run may shorten a
 * red result but must never invent one.
 */
async function runFocused(
  command: ResolvedToolCommand,
  plan: readonly FocusedRun[],
  executionRoot: string,
  spawnTimeoutMs: number,
): Promise<FocusedOutcome> {
  for (const run of plan) {
    const limited = withMemoryLimit(command.canonical, run.cmd, run.args, { executionRoot });
    const startedAt = Date.now();
    const result = await spawnCmd(
      limited.cmd,
      [...limited.args],
      run.cwd,
      spawnTimeoutMs,
      heavyToolEnv(command.canonical),
    );
    const durationMs = Date.now() - startedAt;
    if (result.timedOut) return { kind: 'timedOut', result, durationMs, cwd: run.cwd };
    const harnessFailure = confinementStartupFailure(result.stderr, limited.confined);
    if (harnessFailure !== null) return { kind: 'harness', result, durationMs, harnessFailure };
    if (result.exitCode === null) return { kind: 'inconclusive' };
    if (result.exitCode !== 0) {
      if (reportsNoTestFiles(`${result.stdout}\n${result.stderr}`)) return { kind: 'inconclusive' };
      return { kind: 'failed', result, durationMs, cwd: run.cwd };
    }
  }
  return { kind: 'passed' };
}

/**
 * Tracked files of `root`, relative to it, for failing-file suffix lookup.
 * Empty on any git failure.
 */
function listTrackedFiles(root: string): string[] {
  try {
    return execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\0')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Run a resolved tool command with caching + cross-process locking.
 *
 * Flow:
 *
 *   1. Compute cache key (canonical+cmd+args+treeHash).
 *   2. If a fresh entry exists → return it (no spawn).
 *   3. Acquire a `proper-lockfile` on the cache entry path. When another
 *      caller holds it (same command, same content — possibly another
 *      worktree), wait for its result and reuse it (T12958).
 *   4. Re-check cache inside the lock (another process may have written it
 *      while we were waiting).
 *   5. For `test`, when the previous run in this execution root failed, re-run
 *      only its failing files first; if they still fail (twice), cache and
 *      return that failure without the normal run (T12961).
 *   6. Spawn the tool, capture stdout/stderr tails. For a failing `test`,
 *      re-run the failing files once; a pass there is a `flaky` pass
 *      (T12961). Write the entry, return.
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
 * @task T12958
 * @task T12961
 * @adr ADR-061
 */
export async function runToolCached(
  command: ResolvedToolCommand,
  projectRoot: string,
  opts: RunToolOptions = {},
): Promise<ToolRunResult> {
  const callStartedAt = Date.now();
  const tailBytes = opts.tailBytes ?? 512;
  const lockStaleMs = opts.lockStaleMs ?? 600_000;
  // T12105 / gh#1193: an explicit opts value (tests) wins; otherwise the
  // CLEO_TOOL_TIMEOUT_<CANONICAL> env override, else the 5 min default.
  const spawnTimeoutMs = opts.spawnTimeoutMs ?? resolveSpawnTimeoutMs(command.canonical);

  // gh#1220/#1226/#1230: the tool runs in — and is fingerprinted against —
  // the caller's tree, which is NOT necessarily the store root. The cache
  // ENTRY still lives under `projectRoot` so every worktree shares one cache;
  // that is sound because the key is content-addressed (the tracked tree
  // hash, T12958), so two trees share an entry exactly when they hold the
  // same tracked code.
  const executionRoot = opts.executionRoot ?? projectRoot;
  const recordedRoot = normalizeExecutionRoot(executionRoot);

  // gh#1221 escape hatch. The tree hash covers TRACKED content only, so an
  // uncommitted NEW file does not invalidate the cache; this is the
  // documented way to force a measured run without committing first.
  // An explicit option always wins over the env var.
  const bypassCache = opts.bypassCache ?? process.env['CLEO_EVIDENCE_FRESH'] === '1';

  const treeHash = await captureTreeHash(executionRoot);
  const head = await captureHead(executionRoot);
  const key = computeCacheKey(command, treeHash);

  const makeEntry = (
    run: Pick<ToolCacheEntry, 'exitCode' | 'stdoutTail' | 'stderrTail' | 'durationMs'> &
      Partial<Pick<ToolCacheEntry, 'signal' | 'failedTestFiles' | 'failedFirst' | 'flaky'>>,
  ): ToolCacheEntry => ({
    schemaVersion: TOOL_CACHE_SCHEMA_VERSION,
    key,
    canonical: command.canonical,
    displayName: command.displayName,
    cmd: command.cmd,
    args: command.args,
    source: command.source,
    treeHash,
    head,
    executionRoot: recordedRoot,
    ...run,
    capturedAt: new Date().toISOString(),
  });

  const hit = (entry: ToolCacheEntry): ToolRunResult => ({
    exitCode: entry.exitCode,
    signal: entry.signal ?? null,
    stdoutTail: entry.stdoutTail,
    stderrTail: entry.stderrTail,
    durationMs: entry.durationMs,
    cacheHit: true,
    timedOut: false,
    lockBusy: false,
    harnessFailure: null,
    executionRoot,
    ...(entry.failedFirst ? { failedFirst: entry.failedFirst } : {}),
    ...(entry.flaky ? { flaky: entry.flaky } : {}),
    entry,
  });

  // T12025: when the child exceeded its wall-clock deadline, do NOT persist a
  // cache entry — the run produced no real result. The lock is released via
  // withLock's finally so a subsequent retry can acquire it and attempt a
  // fresh spawn from the same pending entry.
  const timedOutResult = (
    result: CommandResult,
    durationMs: number,
    failedFirst?: FailedFirstReport,
  ): ToolRunResult => ({
    exitCode: result.exitCode,
    signal: result.signal,
    stdoutTail: tailString(result.stdout, tailBytes),
    stderrTail: tailString(result.stderr, tailBytes),
    durationMs,
    cacheHit: false,
    timedOut: true,
    lockBusy: false,
    harnessFailure: null,
    executionRoot,
    ...(failedFirst ? { failedFirst } : {}),
    entry: makeEntry({
      exitCode: null,
      signal: result.signal,
      stdoutTail: '',
      stderrTail: '',
      durationMs,
    }),
  });

  // gh#1397: a failure of CLEO's own confinement WRAPPER is not a verdict on
  // the project's tool. Like the `timedOut` branch, this run produced no
  // result to cache — caching one would serve a fabricated "your tests
  // failed" from a key that cannot rotate until the tree changes.
  const harnessResult = (
    result: CommandResult,
    durationMs: number,
    harnessFailure: string,
    failedFirst?: FailedFirstReport,
  ): ToolRunResult => ({
    exitCode: result.exitCode,
    signal: result.signal,
    stdoutTail: tailString(result.stdout, tailBytes),
    stderrTail: tailString(result.stderr, tailBytes),
    durationMs,
    cacheHit: false,
    timedOut: false,
    lockBusy: false,
    executionRoot,
    harnessFailure,
    ...(failedFirst ? { failedFirst } : {}),
    entry: makeEntry({
      exitCode: null,
      signal: result.signal,
      stdoutTail: '',
      stderrTail: tailString(result.stderr, tailBytes),
      durationMs,
    }),
  });

  // Fast path — fresh cache hit
  if (!bypassCache) {
    const existing = readCacheEntry(projectRoot, key);
    if (existing) return hit(existing);
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
    writeFileSync(
      cachePath,
      JSON.stringify({ schemaVersion: TOOL_CACHE_SCHEMA_VERSION, key, pending: true }),
      'utf-8',
    );
  }

  // The body run under the per-key lock: re-check, failed-first, spawn.
  const runLocked = async (): Promise<ToolRunResult> => {
    // Inside the lock — re-check the cache. If another process beat us to
    // it, prefer its result.
    if (!bypassCache) {
      const fresh = readCacheEntry(projectRoot, key);
      if (fresh) return hit(fresh);
    }

    // T12961: failed-first. When the last run of this tool in this tree
    // failed, re-run only its failing files before the normal command.
    const failedFirstEnabled = FAILED_FIRST_TOOLS.has(command.canonical);
    let trackedCache: string[] | null = null;
    const tracked = (): string[] => {
      trackedCache ??= listTrackedFiles(executionRoot);
      return trackedCache;
    };
    // Files that failed once and then passed on their single retry.
    let flaky: string[] | undefined;
    let failedFirst: FailedFirstReport | undefined;
    if (failedFirstEnabled) {
      const pointer = readFailedFirstPointer(projectRoot, command.canonical, recordedRoot);
      const plan = pointer ? planFocusedRuns(pointer.files, executionRoot) : null;
      if (pointer && plan) {
        const report = (outcome: FailedFirstReport['outcome']): FailedFirstReport => ({
          files: [...pointer.files],
          outcome,
        });
        let focused = await runFocused(command, plan, executionRoot, spawnTimeoutMs);
        let firstFailure: string[] | null = null;
        if (focused.kind === 'failed') {
          // Flake check: one retry of the files that just failed. A pass
          // here does not skip anything — the normal command still runs and
          // decides — it only stops a load-induced flake from being reported
          // as the suite's result without a second look.
          const out = `${focused.result.stdout}\n${focused.result.stderr}`;
          const parsed = parseFailingTestFiles(out, executionRoot, tracked, focused.cwd);
          firstFailure = parsed.length > 0 ? parsed : [...pointer.files];
          const retryPlan = planFocusedRuns(firstFailure, executionRoot);
          if (retryPlan) {
            const retry = await runFocused(command, retryPlan, executionRoot, spawnTimeoutMs);
            if (retry.kind === 'passed') flaky = firstFailure;
            else if (retry.kind === 'failed') focused = retry;
          }
        }
        switch (focused.kind) {
          case 'timedOut':
            return timedOutResult(focused.result, focused.durationMs, report('inconclusive'));
          case 'harness':
            return harnessResult(
              focused.result,
              focused.durationMs,
              focused.harnessFailure,
              report('inconclusive'),
            );
          case 'failed': {
            if (flaky) {
              failedFirst = report('passed');
              break;
            }
            // Still red, twice: this IS the suite's result. A failing subset
            // is a failing suite, so it is cached under the normal key.
            const out = `${focused.result.stdout}\n${focused.result.stderr}`;
            const parsed = parseFailingTestFiles(out, executionRoot, tracked, focused.cwd);
            const files = parsed.length > 0 ? parsed : (firstFailure ?? [...pointer.files]);
            const entry = makeEntry({
              exitCode: focused.result.exitCode,
              signal: focused.result.signal,
              stdoutTail: tailString(focused.result.stdout, tailBytes),
              stderrTail: tailString(focused.result.stderr, tailBytes),
              durationMs: focused.durationMs,
              failedTestFiles: files,
              failedFirst: report('failed'),
            });
            if (isEntryUsable(entry)) writeCacheEntry(projectRoot, entry);
            writeFailedFirstPointer(projectRoot, command.canonical, recordedRoot, files, treeHash);
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
              harnessFailure: null,
              failedFirst: report('failed'),
              entry,
            };
          }
          default:
            failedFirst = report(focused.kind);
        }
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
    const limited = withMemoryLimit(command.canonical, command.cmd, command.args, {
      // The scope name's rootHash8 comes off the execution root the tool
      // runs in (T12112 / gh#1220).
      executionRoot,
    });
    const startedAt = Date.now();
    const result = await spawnCmd(
      limited.cmd,
      [...limited.args],
      executionRoot,
      spawnTimeoutMs,
      heavyToolEnv(command.canonical),
    );
    const durationMs = Date.now() - startedAt;

    if (result.timedOut) return timedOutResult(result, durationMs, failedFirst);

    // gh#1397: checked before the cache entry is built — see
    // `harnessResult`. `limited.confined` OR the project's own pinned
    // wrapper: post-detection (gh#1396) CLEO declines to wrap a command
    // that is already `systemd-run`, so `confined` is false for exactly
    // the project whose harness failures prompted gh#1397.
    const harnessFailure = confinementStartupFailure(
      result.stderr,
      limited.confined || isSystemdRunCommand(command.cmd),
    );
    if (harnessFailure !== null) {
      return harnessResult(result, durationMs, harnessFailure, failedFirst);
    }

    // T12961: remember which test files failed, so the next run can try
    // them first. A pass, or a failure whose files cannot be named,
    // clears the pointer; an unknown outcome (signal kill) leaves it.
    let exitCode = result.exitCode;
    let failedTestFiles: string[] | undefined;
    if (failedFirstEnabled && exitCode !== null) {
      const out = `${result.stdout}\n${result.stderr}`;
      let files = exitCode === 0 ? [] : parseFailingTestFiles(out, executionRoot, tracked);
      // Flake check: re-run the failing files ONCE before deciding. Only when
      // the parsed files are provably the WHOLE failure — the runner's own
      // summary counts exactly that many failed files and no unhandled
      // errors — may a passing retry turn the run into a (flaky) pass.
      // Anything else (a crash outside a test file, a coverage threshold, a
      // truncated tail) stays a failure.
      const retryPlan =
        files.length > 0 && summarizedFailedFileCount(out) === files.length
          ? planFocusedRuns(files, executionRoot)
          : null;
      if (retryPlan) {
        const retry = await runFocused(command, retryPlan, executionRoot, spawnTimeoutMs);
        if (retry.kind === 'passed') {
          flaky = [...(flaky ?? []), ...files];
          exitCode = 0;
          files = [];
        } else if (retry.kind === 'failed') {
          const again = parseFailingTestFiles(
            `${retry.result.stdout}\n${retry.result.stderr}`,
            executionRoot,
            tracked,
            retry.cwd,
          );
          if (again.length > 0) files = again;
        }
      }
      if (files.length > 0) failedTestFiles = files;
      writeFailedFirstPointer(projectRoot, command.canonical, recordedRoot, files, treeHash);
    }

    const entry = makeEntry({
      exitCode,
      signal: result.signal,
      stdoutTail: tailString(result.stdout, tailBytes),
      stderrTail: tailString(result.stderr, tailBytes),
      durationMs,
      ...(failedTestFiles ? { failedTestFiles } : {}),
      ...(failedFirst ? { failedFirst } : {}),
      ...(flaky && exitCode === 0 ? { flaky: [...new Set(flaky)].sort() } : {}),
    });

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
    //   - unrotatable key (`treeHash: null`) — costs a non-git CLEO root
    //     all caching. Stated rather than hidden: those projects are not
    //     getting valid caching today, they are getting ONE answer
    //     forever, and a slow correct answer beats a fast fabricated one.
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
      harnessFailure: null,
      ...(failedFirst ? { failedFirst } : {}),
      ...(entry.flaky ? { flaky: entry.flaky } : {}),
      entry,
    };
  };

  // Coalescing (T12958): with a content key, N agents in N worktrees at the
  // same tree compute the SAME key, so the per-key lock is what turns N
  // identical suites into one. A caller that finds the lock held WAITS for
  // the holder's result instead of failing fast (T12025's ~0.7 s give-up
  // made every second caller report E_EVIDENCE_TOOL_BUSY and retry, i.e.
  // run the suite anyway). The wait happens OUTSIDE the global semaphore so a
  // waiter does not occupy a slot a different key could use.
  //
  // When the holder releases without a usable entry (timeout, harness
  // failure, crash) the waiter loops and runs the tool itself. The total wait
  // is bounded by `lockWaitMs`; past it the caller gets `lockBusy`.
  const lockWaitMs = opts.lockWaitMs ?? spawnTimeoutMs + 60_000;
  const lockPollMs = opts.lockPollMs ?? 1_000;
  const waitDeadline = Date.now() + lockWaitMs;
  // A bypassing caller must not accept the entry it chose to bypass.
  const acceptable = (e: ToolCacheEntry): boolean =>
    !bypassCache || Date.parse(e.capturedAt) >= callStartedAt;

  for (;;) {
    const releaseSemaphore = opts.skipGlobalSemaphore
      ? undefined
      : await acquireGlobalSlot(command.canonical, opts.semaphoreOptions);
    try {
      return await withLock(cachePath, runLocked, { stale: lockStaleMs, retries: 3 });
    } catch (err: unknown) {
      // Only ELOCKED contention is waited out — permission errors and other
      // lock failures are re-thrown as real errors.
      const causeCode =
        err instanceof CleoError && err.code === ExitCode.LOCK_TIMEOUT
          ? (err.cause as { code?: string } | undefined)?.code
          : undefined;
      if (causeCode !== 'ELOCKED') throw err;
    } finally {
      if (releaseSemaphore) await releaseSemaphore();
    }

    // Another caller is running this exact key. Wait for its result.
    while (Date.now() < waitDeadline) {
      const done = readCacheEntry(projectRoot, key);
      if (done && acceptable(done)) return hit(done);
      if (!(await isLocked(cachePath, { stale: lockStaleMs }))) break;
      await new Promise((r) => setTimeout(r, Math.min(lockPollMs, waitDeadline - Date.now())));
    }
    const done = readCacheEntry(projectRoot, key);
    if (done && acceptable(done)) return hit(done);
    if (Date.now() >= waitDeadline) {
      // T12025: a typed, actionable result so callers surface
      // E_EVIDENCE_TOOL_BUSY instead of a generic error.
      return {
        exitCode: null,
        signal: null,
        stdoutTail: '',
        stderrTail: '',
        durationMs: 0,
        cacheHit: false,
        timedOut: false,
        lockBusy: true,
        harnessFailure: null,
        executionRoot,
        entry: makeEntry({ exitCode: null, stdoutTail: '', stderrTail: '', durationMs: 0 }),
      };
    }
    // The holder released without a usable result: run it ourselves.
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
