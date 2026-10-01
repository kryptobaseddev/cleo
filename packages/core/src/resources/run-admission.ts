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
 * - orphan recovery ({@link reapOrphans}): a runner killed outright
 *   (SIGKILL, jetsam) leaves its detached child group behind; the next reap
 *   resumes and terminates it after checking it is the same process (start
 *   time). A failed `ps` is "unknown" and never acted on.
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
import type { PressureState } from './monitor.js';

// Class resolution lives in the dependency-free run-class module (the provider
// hook imports it on every Bash call); re-exported here for existing callers.
export {
  type CommandTarget,
  canonicalForClass,
  commandTarget,
  isPausable,
  looksHeavy,
  RUN_CLASS_ALIASES,
  resolveRunClass,
} from './run-class.js';

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

/** What a record says about its runner, from probes that may fail. */
export type RunnerState = 'live' | 'dead' | 'unknown';

/**
 * The runner of a record: `dead` when its pid is free, or (only once the
 * heartbeat is stale, keeping `ps` off the hot path) when the pid now belongs
 * to a different process. A failed `ps` is `unknown`, never `dead`: under the
 * very overload this governor exists for, `ps` times out or cannot fork, and
 * acting on that would signal live jobs (#1777 round 3, H-1).
 */
export function runnerState(job: RunJob, probes: RegistryProbes): RunnerState {
  if (!probes.alive(job.pid)) return 'dead';
  if (!heartbeatStale(job.heartbeatAtMs, probes.now())) return 'live';
  const start = probes.start(job.pid);
  if (start === null) return 'unknown';
  if (job.runnerStart !== null && start !== job.runnerStart) return 'dead';
  return 'live';
}

/** A heartbeat older than the window, or implausibly far in the future. */
function heartbeatStale(at: number, now: number): boolean {
  return now - at > JOB_STALE_MS || at - now > JOB_STALE_MS;
}

/**
 * Resume and stop a dead runner's detached child group, which keeps running
 * and may sit SIGSTOPped forever.
 *
 * - The child pid is held by a process: signal only when its start time
 *   matches the record (never a reused pid); when `ps` fails, `retry` later.
 * - No process holds the pid: the leader is gone, but its workers may still
 *   be stopped in the group. Nothing else can lead a group with that id while
 *   the pid is free, so the group signal reaches only what is left of ours
 *   (or fails with ESRCH).
 *
 * @returns `done` when the record may be removed, `retry` to keep it.
 */
function recoverOrphan(job: RunJob, probes: RegistryProbes): 'done' | 'retry' {
  if (job.childPid === null || job.childStart === null) return 'done';
  if (probes.alive(job.childPid)) {
    const start = probes.start(job.childPid);
    if (start === null) return 'retry';
    if (start !== job.childStart) return 'done';
  }
  probes.signal(job.childPid, 'SIGCONT');
  probes.signal(job.childPid, 'SIGTERM');
  return 'done';
}

function isJob(v: unknown): v is RunJob {
  const j = v as Partial<RunJob> | null;
  return (
    typeof j === 'object' &&
    j !== null &&
    typeof j.id === 'string' &&
    typeof j.pid === 'number' &&
    typeof j.startedAtMs === 'number' &&
    typeof j.heartbeatAtMs === 'number'
  );
}

/** Parsed records; `null` for an unreadable file. */
function readRecords(dir: string): Array<{ path: string; job: RunJob | null }> {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
  } catch {
    return [];
  }
  return names.map((name) => {
    const path = join(dir, name);
    try {
      const v: unknown = JSON.parse(readFileSync(path, 'utf-8'));
      return { path, job: isJob(v) ? v : null };
    } catch {
      return { path, job: null };
    }
  });
}

/**
 * Live jobs, oldest first. A pure read: it never signals or deletes (reaping
 * is {@link reapOrphans}). Records whose runner is dead, unknown, or alive
 * with a stale heartbeat (a suspended machine) are left out.
 */
export function listRunJobs(
  dir: string = runJobsDir(),
  probes: Partial<RegistryProbes> = {},
): RunJob[] {
  const p: RegistryProbes = { ...DEFAULT_PROBES, ...probes };
  const jobs: RunJob[] = [];
  for (const { job } of readRecords(dir)) {
    if (!job || heartbeatStale(job.heartbeatAtMs, p.now())) continue;
    if (runnerState(job, p) === 'live') jobs.push(job);
  }
  return jobs.sort((a, b) => a.startedAtMs - b.startedAtMs || a.pid - b.pid);
}

/**
 * Reap the records of dead runners: resume and stop their orphaned child
 * groups ({@link recoverOrphan}) and delete the record, unless the child's
 * identity could not be read (kept for the next reap). Records whose runner
 * is `unknown` are never touched. Unreadable files older than the stale
 * window are removed.
 *
 * @returns how many records were removed.
 */
export function reapOrphans(
  dir: string = runJobsDir(),
  probes: Partial<RegistryProbes> = {},
): number {
  const p: RegistryProbes = { ...DEFAULT_PROBES, ...probes };
  let removed = 0;
  for (const { path, job } of readRecords(dir)) {
    if (!job) {
      try {
        if (p.now() - statSync(path).mtimeMs > JOB_STALE_MS) {
          rmSync(path, { force: true });
          removed++;
        }
      } catch {
        // Gone already.
      }
      continue;
    }
    if (runnerState(job, p) !== 'dead') continue;
    if (recoverOrphan(job, p) === 'done') {
      rmSync(path, { force: true });
      removed++;
    }
  }
  return removed;
}

/** The process group a pid belongs to, from one `ps` exec; null when unknown. */
export function processGroupOf(pid: number): number | null {
  try {
    const out = execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const n = Number.parseInt(out, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * The running `cleo run` job whose process tree `pid` belongs to, or null.
 *
 * A governed child is spawned detached, so it leads its own session and
 * process group (pgid = its pid). A process whose group id equals a live
 * job's `childPid`, with the leader's start time matching the record, runs
 * inside that job. This cannot be forged from outside: a session leader's
 * group can only be joined by processes in its own session, and the
 * start-time check rules out a reused pid. Any failure to read `ps` returns
 * null (normal admission).
 */
export function parentRunJob(input: {
  readonly pid: number;
  readonly jobsDir?: string;
  readonly probes?: Partial<RegistryProbes>;
  readonly groupOf?: (pid: number) => number | null;
}): RunJob | null {
  const pgid = (input.groupOf ?? processGroupOf)(input.pid);
  // pgid === pid is fine: `cleo run -- cleo run -- …` makes the inner runner
  // the outer job's child and its group leader, and it is nested.
  if (pgid === null) return null;
  const p: RegistryProbes = { ...DEFAULT_PROBES, ...input.probes };
  const job = listRunJobs(input.jobsDir ?? runJobsDir(), p).find((j) => j.childPid === pgid);
  if (!job || job.childStart === null) return null;
  return p.start(pgid) === job.childStart ? job : null;
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

function isTicket(v: unknown): v is QueueTicket {
  const t = v as Partial<QueueTicket> | null;
  return (
    typeof t === 'object' &&
    t !== null &&
    typeof t.id === 'string' &&
    typeof t.pid === 'number' &&
    typeof t.enqueuedAtMs === 'number' &&
    typeof t.heartbeatAtMs === 'number'
  );
}

/**
 * Live tickets in arrival order (FIFO). Invalid tickets, tickets of a dead
 * runner, and tickets whose heartbeat is stale or implausibly far in the
 * future are dropped (#1777 round 3, L-2): an abandoned ticket never blocks
 * a class for longer than the stale window.
 */
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
    let v: unknown;
    try {
      v = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      continue; // Torn write: its owner rewrites it within a poll.
    }
    if (!isTicket(v) || heartbeatStale(v.heartbeatAtMs, p.now()) || !p.alive(v.pid)) {
      rmSync(path, { force: true });
      continue;
    }
    tickets.push(v);
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
    fix:
      input.pressure.state === 'ok'
        ? `The ${input.cls} class is at capacity; nothing was started. Continue other work, or re-run with --wait to queue.`
        : `The machine is under pressure (${input.pressure.state}) and the ${input.cls} class is at capacity; nothing was started. Continue other work, or re-run with --wait to queue.`,
  };
}
