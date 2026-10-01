/**
 * `cleo run` admission: the one front door for heavy commands an agent runs
 * itself (test runners, compilers, builds, installs).
 *
 * Every heavy command goes through the {@link ResourceGovernor} class budgets,
 * so all `cleo run` jobs share one machine-wide budget per class, whichever
 * agent, session or project asks. `cleo verify` still admits through the tool
 * semaphore until #1775 (T12963) routes it through the governor too. This
 * module holds the pure pieces; `run-governed.ts` runs the loop.
 *
 * - {@link resolveRunClass} / {@link isPausable}: the governor class and
 *   whether the job may be paused under pressure
 * - the machine-wide job registry (`<cleoHome>/run/jobs/*.json`): who is
 *   running what, with a heartbeat, so the soft-stop envelope can name the
 *   holders and runners can coordinate pauses
 * - orphan recovery: a runner killed outright (SIGKILL, jetsam) leaves its
 *   detached child group behind; the next reader resumes and terminates it
 *   after checking it is the same process (start time)
 * - {@link decidePause}: under `backoff` only the oldest job runs; a job
 *   resumed by the starvation cap gets a guaranteed run window
 * - {@link buildRunDeferral}: the `E_RESOURCE_DEFERRED` details and the ways
 *   an agent can keep making progress
 *
 * The registry and queue are per `CLEO_HOME` (the machine's CLEO data dir).
 *
 * @module resources/run-admission
 * @task T12979
 * @task T12980
 * @epic T12978
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { ResourceClass } from '@cleocode/contracts';
import { getCleoHome } from '../paths.js';
import type { CanonicalTool } from '../tasks/tool-resolver.js';
import type { PressureState } from './monitor.js';

// ---------------------------------------------------------------------------
// Class resolution
// ---------------------------------------------------------------------------

/** Short class names accepted by `cleo run --class`. */
export const RUN_CLASS_ALIASES: Readonly<Record<string, ResourceClass>> = Object.freeze({
  test: 'test-run',
  'test-run': 'test-run',
  build: 'scoped-build',
  'scoped-build': 'scoped-build',
  typecheck: 'scoped-build',
  install: 'scoped-build',
  scan: 'scoped-build',
  'full-build': 'full-build',
  db: 'db-heavy',
  'db-heavy': 'db-heavy',
});

const TEST_RUNNERS = /^(vitest|jest|mocha|ava|tap|playwright|pytest|rspec|phpunit)$/;
const BUILD_TOOLS =
  /^(tsc|tsup|turbo|vite|esbuild|webpack|rollup|next|nx|biome|eslint|svelte-check)$/;
const PACKAGE_MANAGERS = /^(npm|pnpm|yarn|bun|npx|pnpx|bunx)$/;
const INSTALL_VERBS = /^(install|i|ci|add|update|up|upgrade)$/;
const WORKSPACE_SCOPING = /^(--filter|-F|--workspace|-w|-C|--dir|--prefix)$/;
const RECURSIVE = /^(--recursive|-r)$/;

function base(token: string): string {
  return token.split('/').pop() ?? token;
}

function isWorkspaceRoot(cwd: string): boolean {
  return (
    existsSync(join(cwd, 'pnpm-workspace.yaml')) ||
    existsSync(join(cwd, 'turbo.json')) ||
    existsSync(join(cwd, 'nx.json'))
  );
}

/**
 * The governor class for a command.
 *
 * An explicit `--class` wins (aliases above). Otherwise the command is
 * inferred: a test runner, a `test` script or `npm t` is `test-run`; an
 * unscoped `<pm> build` at a workspace root is `full-build`; anything else is
 * `scoped-build`, the default for heavy work.
 *
 * @param explicit - the `--class` value, if given.
 * @param argv - the command.
 * @param cwd - where it runs (for the workspace-root check).
 * @throws {Error} when `explicit` is not a known class or alias.
 *
 * @example
 * ```ts
 * resolveRunClass(undefined, ['pnpm', 'vitest', 'run', 'a.test.ts']); // 'test-run'
 * resolveRunClass(undefined, ['npx', 'tsc', '-b']);                   // 'scoped-build'
 * resolveRunClass(undefined, ['pnpm', 'build'], '/monorepo');         // 'full-build'
 * ```
 */
export function resolveRunClass(
  explicit: string | undefined,
  argv: readonly string[],
  cwd: string = process.cwd(),
): ResourceClass {
  if (explicit !== undefined) {
    const cls = RUN_CLASS_ALIASES[explicit];
    if (!cls) {
      throw new Error(
        `unknown --class '${explicit}' (expected one of: ${Object.keys(RUN_CLASS_ALIASES).join(', ')})`,
      );
    }
    return cls;
  }
  const words = argv.map(base);
  if (words.some((w) => TEST_RUNNERS.test(w))) return 'test-run';
  const first = words[0] ?? '';
  if (PACKAGE_MANAGERS.test(first)) {
    // `pnpm test`, `npm run test`, `npm t`, `pnpm --filter x test:unit`
    if (words[1] === 't' || words.some((w, i) => i > 0 && /^test(:|$)/.test(w))) {
      return 'test-run';
    }
    const builds = words.some((w, i) => i > 0 && /^build(:|$)/.test(w));
    const scoped = argv.some((w) => WORKSPACE_SCOPING.test(w) || w.startsWith('--filter='));
    // `pnpm -r build` builds every package wherever it runs (#1777 R3).
    if (builds && !scoped && argv.some((w) => RECURSIVE.test(w))) return 'full-build';
    if (builds && !scoped && isWorkspaceRoot(cwd)) return 'full-build';
  }
  if ((first === 'cargo' || first === 'go') && words[1] === 'test') return 'test-run';
  return 'scoped-build';
}

/** The `heavyToolEnv` canonical tool a run class sizes its env from. */
export function canonicalForClass(cls: ResourceClass): CanonicalTool {
  return cls === 'test-run' ? 'test' : 'build';
}

/**
 * Whether a job may be SIGSTOPped under pressure. Installs and db-heavy work
 * hold shared locks (package store, registry caches, SQLite writers) that
 * the oldest job may need, so pausing them can stall the one job that is
 * meant to keep the machine moving.
 */
export function isPausable(cls: ResourceClass, argv: readonly string[]): boolean {
  if (cls === 'db-heavy') return false;
  const words = argv.map(base);
  const first = words[0] ?? '';
  if (PACKAGE_MANAGERS.test(first) && INSTALL_VERBS.test(words[1] ?? '')) return false;
  if (first === 'cargo' && words[1] === 'fetch') return false;
  return true;
}

/** Whether `argv` looks like a heavy command (test runner, compiler, build, install); for hooks. */
export function looksHeavy(argv: readonly string[]): boolean {
  const words = argv.map(base);
  const first = words[0] ?? '';
  if (words.some((w) => TEST_RUNNERS.test(w) || BUILD_TOOLS.test(w))) return true;
  if (PACKAGE_MANAGERS.test(first)) {
    return words.some((w, i) => i > 0 && /^(test|t|build|install|i|ci|typecheck)(:|$)/.test(w));
  }
  return (first === 'cargo' || first === 'go') && /^(build|test)$/.test(words[1] ?? '');
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const SECRET_NAME = '[A-Za-z0-9_-]*(?:token|secret|password|passwd|apikey|api-key|api_key|key)';
const ASSIGNMENT = new RegExp(`\\b(${SECRET_NAME})=\\S+`, 'gi');
const SECRET_FLAG = new RegExp(`^--?${SECRET_NAME}$`, 'i');

/**
 * The command line as recorded: secret-looking `name=value` pairs, the value
 * after a secret-looking flag (`--token X`), URL userinfo and bearer tokens
 * masked; truncated to 160 characters.
 */
export function redactCommand(argv: readonly string[]): string {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    out.push(token);
    if (SECRET_FLAG.test(token) && i + 1 < argv.length) {
      out.push('***');
      i++;
    }
  }
  const line = out
    .join(' ')
    .replace(ASSIGNMENT, '$1=***')
    .replace(/(\w+:\/\/)[^/\s@]+@/g, '$1***@')
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 ***');
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

// ---------------------------------------------------------------------------
// Process identity
// ---------------------------------------------------------------------------

/** Process start time as `ps` prints it, or `null` when the pid is gone. */
export type ProcessStartFn = (pid: number) => string | null;

/** One `ps -o lstart=` exec. Used only off the hot path (spawn, stale records). */
export const processStart: ProcessStartFn = (pid) => {
  try {
    const out = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
};

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: some process holds the pid (maybe not ours); ESRCH: gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Signal a whole process group. Never falls back to a bare pid. */
export function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Job registry
// ---------------------------------------------------------------------------

/** One running `cleo run` job, as recorded machine-wide. */
export interface RunJob {
  /** `<pid>-<startedAtMs>`, also the file name. */
  readonly id: string;
  /** The `cleo run` process. */
  readonly pid: number;
  /** `ps` start time of the runner, to tell a reused pid apart. */
  readonly runnerStart: string | null;
  /** The command's process group leader, once spawned. */
  readonly childPid: number | null;
  /** `ps` start time of the child, checked before any orphan signal. */
  readonly childStart: string | null;
  readonly class: ResourceClass;
  /** Redacted, truncated command line. Never the environment. */
  readonly command: string;
  readonly cwd: string;
  readonly startedAtMs: number;
  /** The CLEO or agent session that asked, when known. */
  readonly sessionId: string | null;
  /** When the job was paused under pressure, else `null`. */
  readonly pausedAtMs: number | null;
  /** Whether the job may be paused ({@link isPausable}). */
  readonly pausable: boolean;
  /** Refreshed by the runner on every poll. */
  readonly heartbeatAtMs: number;
}

/** A record whose heartbeat is older than this is checked for a dead runner. */
export const JOB_STALE_MS = 60_000;

/** Registry directory: `<cleoHome>/run/jobs`. */
export function runJobsDir(cleoHome: string = getCleoHome()): string {
  return join(cleoHome, 'run', 'jobs');
}

/** Wait-queue directory for a class: `<cleoHome>/run/queue/<class>`. */
export function runQueueDir(cls: ResourceClass, cleoHome: string = getCleoHome()): string {
  return join(cleoHome, 'run', 'queue', cls);
}

function writeAtomic(dir: string, name: string, value: unknown): void {
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${name}.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(value)}\n`);
    renameSync(tmp, join(dir, name));
  } catch {
    // Best effort: a registry failure must never block work.
  }
}

/** Overwrite a job record atomically. Never throws. */
export function writeRunJob(job: RunJob, dir: string = runJobsDir()): void {
  writeAtomic(dir, `${job.id}.json`, job);
}

/** Remove a job record. Never throws. */
export function removeRunJob(id: string, dir: string = runJobsDir()): void {
  try {
    rmSync(join(dir, `${id}.json`), { force: true });
  } catch {
    // Best effort.
  }
}

/** Injectable process probes for {@link listRunJobs} (tests). */
export interface RegistryProbes {
  readonly alive: (pid: number) => boolean;
  readonly start: ProcessStartFn;
  readonly signal: (pid: number, signal: NodeJS.Signals) => boolean;
  readonly now: () => number;
}

const DEFAULT_PROBES: RegistryProbes = {
  alive: pidAlive,
  start: processStart,
  signal: signalGroup,
  now: Date.now,
};

/**
 * Whether a record's runner is gone: the pid is free, or (only once the
 * heartbeat is stale, to keep `ps` off the hot path) the pid now belongs to a
 * different process.
 */
function runnerDead(job: RunJob, probes: RegistryProbes): boolean {
  if (!probes.alive(job.pid)) return true;
  if (probes.now() - job.heartbeatAtMs <= JOB_STALE_MS) return false;
  const start = probes.start(job.pid);
  return start === null || (job.runnerStart !== null && start !== job.runnerStart);
}

/**
 * A dead runner's detached child group keeps running, possibly SIGSTOPped
 * forever. Resume it and terminate it, but only when the child pid is still
 * the same process (start time matches): never signal a reused pid.
 */
function recoverOrphan(job: RunJob, probes: RegistryProbes): void {
  if (job.childPid === null || job.childStart === null) return;
  const start = probes.start(job.childPid);
  // A different live process now holds the pid: never signal it.
  if (start !== null && start !== job.childStart) return;
  // Same leader, or the leader is gone (#1777 round 2, R2): its workers may
  // still sit SIGSTOPped in the group. No process holds the pid, so nothing
  // else can lead a group with that id; the group signal reaches only what is
  // left of ours (or fails with ESRCH).
  probes.signal(job.childPid, 'SIGCONT');
  probes.signal(job.childPid, 'SIGTERM');
}

/**
 * Live jobs, oldest first. Records of dead runners are deleted (and their
 * orphaned child groups resumed and terminated); records whose heartbeat is
 * stale but whose runner is alive (a suspended machine) are skipped, not
 * deleted. Unreadable files older than the stale window are removed.
 */
export function listRunJobs(
  dir: string = runJobsDir(),
  probes: Partial<RegistryProbes> = {},
): RunJob[] {
  const p: RegistryProbes = { ...DEFAULT_PROBES, ...probes };
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
  } catch {
    return [];
  }
  const jobs: RunJob[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let job: RunJob;
    try {
      job = JSON.parse(readFileSync(path, 'utf-8')) as RunJob;
      if (typeof job.pid !== 'number' || typeof job.heartbeatAtMs !== 'number') {
        throw new Error('not a job record');
      }
    } catch {
      try {
        if (p.now() - statSync(path).mtimeMs > JOB_STALE_MS) rmSync(path, { force: true });
      } catch {
        // Gone already.
      }
      continue;
    }
    if (runnerDead(job, p)) {
      recoverOrphan(job, p);
      rmSync(path, { force: true });
      continue;
    }
    if (p.now() - job.heartbeatAtMs > JOB_STALE_MS) continue;
    jobs.push(job);
  }
  return jobs.sort((a, b) => a.startedAtMs - b.startedAtMs || a.pid - b.pid);
}

/** A job waiting in the `--wait` queue. */
export interface QueueTicket {
  readonly id: string;
  readonly pid: number;
  readonly runnerStart: string | null;
  readonly enqueuedAtMs: number;
  readonly heartbeatAtMs: number;
  readonly command: string;
}

/** Add or refresh a wait ticket. Never throws. */
export function writeQueueTicket(ticket: QueueTicket, dir: string): void {
  writeAtomic(dir, `${ticket.id}.json`, ticket);
}

/** Remove a wait ticket. Never throws. */
export function removeQueueTicket(id: string, dir: string): void {
  removeRunJob(id, dir);
}

/** Live tickets in arrival order (FIFO); dead or stale ones are dropped. */
export function listQueueTickets(dir: string, probes: Partial<RegistryProbes> = {}): QueueTicket[] {
  const p: RegistryProbes = { ...DEFAULT_PROBES, ...probes };
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
  } catch {
    return [];
  }
  const tickets: QueueTicket[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const t = JSON.parse(readFileSync(path, 'utf-8')) as QueueTicket;
      const stale = p.now() - t.heartbeatAtMs > JOB_STALE_MS;
      if (!p.alive(t.pid) || stale) {
        rmSync(path, { force: true });
        continue;
      }
      tickets.push(t);
    } catch {
      // Torn write: its owner rewrites it within a poll.
    }
  }
  return tickets.sort((a, b) => a.enqueuedAtMs - b.enqueuedAtMs || a.pid - b.pid);
}

// ---------------------------------------------------------------------------
// `cleo verify` holders (read-only view of the tool semaphore)
// ---------------------------------------------------------------------------

/** One holder of a `cleo verify` tool slot (`<cleoHome>/locks/tool-*`). */
export interface VerifyHolder {
  readonly tool: string;
  readonly pid: number;
  readonly acquiredAtMs: number;
}

/**
 * Live holders of `cleo verify` tool slots on this host, read from the tool
 * semaphore's holder sidecars. Read-only: never touches a lock.
 */
export function listVerifyHolders(
  cleoHome: string = getCleoHome(),
  alive: (pid: number) => boolean = pidAlive,
): VerifyHolder[] {
  const locks = join(cleoHome, 'locks');
  const out: VerifyHolder[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(locks).filter((d) => d.startsWith('tool-'));
  } catch {
    return out;
  }
  const host = hostname();
  for (const d of dirs) {
    let files: string[];
    try {
      files = readdirSync(join(locks, d)).filter((f) => f.endsWith('.holder.json'));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const slot = join(locks, d, f.slice(0, -'.holder.json'.length));
        if (!existsSync(`${slot}.lock`)) continue;
        const h = JSON.parse(readFileSync(join(locks, d, f), 'utf-8')) as {
          pid: number;
          host: string;
          acquiredAt: string;
        };
        if (h.host !== host || !alive(h.pid)) continue;
        out.push({
          tool: d.slice('tool-'.length),
          pid: h.pid,
          acquiredAtMs: Date.parse(h.acquiredAt),
        });
      } catch {
        // Unreadable sidecar: skip.
      }
    }
  }
  return out.sort((a, b) => a.acquiredAtMs - b.acquiredAtMs);
}

// ---------------------------------------------------------------------------
// Pause policy
// ---------------------------------------------------------------------------

/** A paused job resumes after this long even under pressure (no starvation). */
export const MAX_PAUSE_MS = 15 * 60_000;

/** After a cap resume, the job runs at least this long before it can pause again. */
export const CAP_RUN_WINDOW_MS = 5 * 60_000;

/** Why {@link decidePause} decided what it did. */
export type PauseReason =
  | 'below-backoff'
  | 'not-pausable'
  | 'oldest'
  | 'cap'
  | 'run-window'
  | 'younger';

/**
 * Should this job run or pause right now?
 *
 * - Below `backoff`, or a job that may not be paused: run.
 * - At `backoff`: the oldest live job keeps running so the machine always
 *   makes progress; every younger pausable job pauses. Pausing frees CPU at
 *   once and stops memory growth; nothing is killed and no work is lost.
 * - A job paused for {@link MAX_PAUSE_MS} resumes (`'cap'`) and then runs for
 *   at least {@link CAP_RUN_WINDOW_MS} (`'run-window'`) before it can pause
 *   again, so a long backoff alternates jobs instead of starving them.
 *
 * @example
 * ```ts
 * decidePause({ state: 'backoff', self, jobs: [old, self], nowMs }).decision; // 'pause'
 * decidePause({ state: 'hold', self, jobs: [old, self], nowMs }).decision;    // 'run'
 * ```
 */
export function decidePause(input: {
  readonly state: PressureState;
  readonly self: Pick<RunJob, 'id' | 'pausable'>;
  readonly jobs: readonly Pick<RunJob, 'id'>[];
  readonly nowMs: number;
  readonly pausedAtMs?: number | null;
  readonly capResumedAtMs?: number | null;
  readonly maxPauseMs?: number;
  readonly runWindowMs?: number;
}): { decision: 'run' | 'pause'; reason: PauseReason } {
  if (!input.self.pausable) return { decision: 'run', reason: 'not-pausable' };
  if (input.state !== 'backoff') return { decision: 'run', reason: 'below-backoff' };
  const capAt = input.capResumedAtMs ?? null;
  if (capAt !== null && input.nowMs - capAt < (input.runWindowMs ?? CAP_RUN_WINDOW_MS)) {
    return { decision: 'run', reason: 'run-window' };
  }
  const paused = input.pausedAtMs ?? null;
  if (paused !== null && input.nowMs - paused >= (input.maxPauseMs ?? MAX_PAUSE_MS)) {
    return { decision: 'run', reason: 'cap' };
  }
  const oldest = input.jobs[0];
  if (!oldest || oldest.id === input.self.id) return { decision: 'run', reason: 'oldest' };
  return { decision: 'pause', reason: 'younger' };
}

// ---------------------------------------------------------------------------
// Soft-stop envelope (T12980)
// ---------------------------------------------------------------------------

/** One way forward offered with a deferral. Matches the LAFS `alternatives` shape. */
export interface RunAlternative {
  readonly action: string;
  readonly command: string;
}

/** One entry of `running[]`: a `cleo run` job or a `cleo verify` tool slot. */
export interface RunningEntry {
  readonly source: 'run' | 'verify';
  readonly class: string;
  readonly command: string;
  readonly cwd: string | null;
  readonly startedAtMs: number;
  readonly sessionId: string | null;
  readonly pausedAtMs: number | null;
}

/** `error.details` of an `E_RESOURCE_DEFERRED` from `cleo run`. */
export interface RunDeferralDetails {
  readonly class: ResourceClass;
  readonly reason: string;
  readonly retryAfterMs: number;
  /** Position in the class's wait queue when it timed out under `--wait`. */
  readonly queuePosition: number | null;
  readonly pressure: {
    readonly state: PressureState;
    /** Memory-scale score (see `pressureScore`). */
    readonly score: number;
    readonly reason: string;
    readonly memAvailableBytes: number | null;
  };
  /** Live `cleo run` jobs and `cleo verify` tool slots, oldest first. */
  readonly running: readonly RunningEntry[];
}

function shellQuote(token: string): string {
  return /^[\w@%+=:,./-]+$/.test(token) ? token : `'${token.replace(/'/g, `'\\''`)}'`;
}

/** Merge `cleo run` jobs and `cleo verify` holders into one oldest-first list. */
export function runningEntries(
  jobs: readonly RunJob[],
  holders: readonly VerifyHolder[],
): RunningEntry[] {
  const entries: RunningEntry[] = [
    ...jobs.map((j) => ({
      source: 'run' as const,
      class: j.class,
      command: j.command,
      cwd: j.cwd,
      startedAtMs: j.startedAtMs,
      sessionId: j.sessionId,
      pausedAtMs: j.pausedAtMs,
    })),
    ...holders.map((h) => ({
      source: 'verify' as const,
      class: `tool:${h.tool}`,
      command: `cleo verify (${h.tool})`,
      cwd: null,
      startedAtMs: h.acquiredAtMs,
      sessionId: null,
      pausedAtMs: null,
    })),
  ];
  return entries.sort((a, b) => a.startedAtMs - b.startedAtMs);
}

/**
 * Build the deferral details plus the ways forward. The alternatives are
 * concrete commands, ordered by how little they cost the machine.
 */
export function buildRunDeferral(input: {
  readonly cls: ResourceClass;
  readonly argv: readonly string[];
  readonly reason: string;
  readonly retryAfterMs: number;
  readonly queuePosition?: number | null;
  readonly pressure: RunDeferralDetails['pressure'];
  readonly running: readonly RunningEntry[];
}): { details: RunDeferralDetails; alternatives: RunAlternative[]; fix: string } {
  const cmd = input.argv.map(shellQuote).join(' ');
  const alternatives: RunAlternative[] = [];
  if (input.cls === 'test-run') {
    alternatives.push(
      {
        action: 'Use CI as test evidence instead of a local run (zero local cost)',
        command: 'cleo verify <taskId> --gate testsPassed --evidence "ci:<pr>"',
      },
      {
        action: 'Run only the test file(s) you changed',
        command: 'cleo run --class test -- npx vitest run <path/to/changed.test.ts>',
      },
    );
  } else {
    alternatives.push({
      action: 'Narrow the build to the package you changed',
      command: 'cleo run -- pnpm --filter <package> run build',
    });
  }
  alternatives.push(
    {
      action: 'Keep coding and retry later; nothing was started',
      command: `cleo run -- ${cmd}`,
    },
    {
      action: 'Wait in the FIFO queue for this class and start when admitted',
      command: `cleo run --wait --timeout 1800 -- ${cmd}`,
    },
  );
  return {
    details: {
      class: input.cls,
      reason: input.reason,
      retryAfterMs: input.retryAfterMs,
      queuePosition: input.queuePosition ?? null,
      pressure: input.pressure,
      running: input.running,
    },
    alternatives,
    fix: `The machine is busy (${input.pressure.state}); nothing was started. Continue other work, or re-run with --wait to queue.`,
  };
}
