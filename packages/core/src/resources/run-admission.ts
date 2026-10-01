/**
 * `cleo run` admission: the one front door for heavy commands an agent runs
 * itself (test runners, compilers, builds, installs).
 *
 * Every heavy command goes through the same {@link ResourceGovernor} class
 * budgets that `cleo verify` uses, so the machine has ONE budget no matter
 * which agent, session or project asks. This module holds the pure pieces:
 *
 * - {@link resolveRunClass}: which governor class a command belongs to
 * - the machine-wide job registry (`<cleoHome>/run/jobs/*.json`): who is
 *   running what, used for the soft-stop envelope and for pause coordination
 * - {@link decidePause}: under `backoff` only the oldest job keeps running;
 *   the rest are paused (SIGSTOP) and resumed, never killed
 * - {@link buildRunDeferral}: the `E_RESOURCE_DEFERRED` details and the ways
 *   an agent can keep making progress
 *
 * @module resources/run-admission
 * @task T12979
 * @task T12980
 * @epic T12978
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function base(token: string): string {
  return token.split('/').pop() ?? token;
}

/**
 * The governor class for a command.
 *
 * An explicit `--class` wins (aliases above). Otherwise the command is
 * inferred: a test runner or a `test` script is `test-run`; anything else is
 * `scoped-build`, the default for heavy work.
 *
 * @throws {Error} when `explicit` is not a known class or alias.
 *
 * @example
 * ```ts
 * resolveRunClass(undefined, ['pnpm', 'vitest', 'run', 'a.test.ts']); // 'test-run'
 * resolveRunClass(undefined, ['npx', 'tsc', '-b']);                   // 'scoped-build'
 * resolveRunClass('full-build', ['pnpm', 'build']);                    // 'full-build'
 * ```
 */
export function resolveRunClass(
  explicit: string | undefined,
  argv: readonly string[],
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
    // `pnpm test`, `npm run test`, `pnpm --filter x test:unit`, `cargo test`
    if (words.some((w, i) => i > 0 && /^test(:|$)/.test(w))) return 'test-run';
  }
  if (first === 'cargo' || first === 'go') {
    if (words[1] === 'test') return 'test-run';
  }
  return 'scoped-build';
}

/** The `heavyToolEnv` canonical tool a run class sizes its env from. */
export function canonicalForClass(cls: ResourceClass): CanonicalTool {
  return cls === 'test-run' ? 'test' : 'build';
}

/** Whether `argv` looks like a heavy command (test runner, compiler, build, install); for hooks. */
export function looksHeavy(argv: readonly string[]): boolean {
  const words = argv.map(base);
  const first = words[0] ?? '';
  if (words.some((w) => TEST_RUNNERS.test(w) || BUILD_TOOLS.test(w))) return true;
  if (PACKAGE_MANAGERS.test(first)) {
    return words.some((w, i) => i > 0 && /^(test|build|install|i|ci|typecheck)(:|$)/.test(w));
  }
  return (first === 'cargo' || first === 'go') && /^(build|test)$/.test(words[1] ?? '');
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
  /** The command's process (group leader), once spawned. */
  readonly childPid: number | null;
  readonly class: ResourceClass;
  /** Redacted, truncated command line. Never the environment. */
  readonly command: string;
  readonly cwd: string;
  readonly startedAtMs: number;
  /** The CLEO or agent session that asked, when known. */
  readonly sessionId: string | null;
  /** When the job was paused under pressure, else `null`. */
  readonly pausedAtMs: number | null;
}

/** Registry directory: `<cleoHome>/run/jobs`. */
export function runJobsDir(cleoHome: string = getCleoHome()): string {
  return join(cleoHome, 'run', 'jobs');
}

const SECRETISH = /\b([A-Za-z0-9_-]*(?:token|secret|password|passwd|apikey|api_key|key))=\S+/gi;

/**
 * The command line as recorded: secret-looking `name=value` pairs masked,
 * truncated to 160 characters.
 */
export function redactCommand(argv: readonly string[]): string {
  const line = argv.join(' ').replace(SECRETISH, '$1=***');
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive but not ours. ESRCH: gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Record a job. Returns it. Never throws (a registry failure must not block work). */
export function registerRunJob(
  job: Omit<RunJob, 'id' | 'pausedAtMs' | 'childPid'> & { childPid?: number | null },
  dir: string = runJobsDir(),
): RunJob {
  const full: RunJob = {
    ...job,
    id: `${job.pid}-${job.startedAtMs}`,
    childPid: job.childPid ?? null,
    pausedAtMs: null,
  };
  writeRunJob(full, dir);
  return full;
}

/** Overwrite a job record. Never throws. */
export function writeRunJob(job: RunJob, dir: string = runJobsDir()): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${job.id}.json`), `${JSON.stringify(job)}\n`);
  } catch {
    // Best effort.
  }
}

/** Remove a job record. Never throws. */
export function removeRunJob(id: string, dir: string = runJobsDir()): void {
  try {
    rmSync(join(dir, `${id}.json`), { force: true });
  } catch {
    // Best effort.
  }
}

/**
 * Live jobs, oldest first. Records whose `cleo run` process is gone are
 * deleted on the way (a crashed runner leaves no ghost holder).
 */
export function listRunJobs(
  dir: string = runJobsDir(),
  alive: (pid: number) => boolean = isAlive,
): RunJob[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const jobs: RunJob[] = [];
  for (const name of names) {
    try {
      const job = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as RunJob;
      if (typeof job.pid === 'number' && alive(job.pid)) jobs.push(job);
      else rmSync(join(dir, name), { force: true });
    } catch {
      // Torn write or junk: skip it; its owner rewrites it.
    }
  }
  return jobs.sort((a, b) => a.startedAtMs - b.startedAtMs || a.pid - b.pid);
}

// ---------------------------------------------------------------------------
// Pause policy
// ---------------------------------------------------------------------------

/** A paused job resumes after this long even under pressure (no starvation). */
export const MAX_PAUSE_MS = 15 * 60_000;

/**
 * Should this job run or pause right now?
 *
 * - Below `backoff`: run.
 * - At `backoff`: the oldest live job keeps running so the machine always
 *   makes progress; every younger job pauses. Pausing frees CPU at once and
 *   stops memory growth; nothing is killed and no work is lost.
 * - A job paused for {@link MAX_PAUSE_MS} resumes regardless.
 *
 * @example
 * ```ts
 * decidePause({ state: 'backoff', selfId: 'b', jobs: [a, b], nowMs }); // 'pause'
 * decidePause({ state: 'hold', selfId: 'b', jobs: [a, b], nowMs });    // 'run'
 * ```
 */
export function decidePause(input: {
  readonly state: PressureState;
  readonly selfId: string;
  readonly jobs: readonly RunJob[];
  readonly nowMs: number;
  readonly pausedAtMs?: number | null;
  readonly maxPauseMs?: number;
}): 'run' | 'pause' {
  if (input.state !== 'backoff') return 'run';
  const paused = input.pausedAtMs ?? null;
  if (paused !== null && input.nowMs - paused >= (input.maxPauseMs ?? MAX_PAUSE_MS)) return 'run';
  const oldest = input.jobs[0];
  if (!oldest || oldest.id === input.selfId) return 'run';
  return 'pause';
}

// ---------------------------------------------------------------------------
// Soft-stop envelope (T12980)
// ---------------------------------------------------------------------------

/** One way forward offered with a deferral. Matches the LAFS `alternatives` shape. */
export interface RunAlternative {
  readonly action: string;
  readonly command: string;
}

/** `error.details` of an `E_RESOURCE_DEFERRED` from `cleo run`. */
export interface RunDeferralDetails {
  readonly class: ResourceClass;
  readonly reason: string;
  readonly retryAfterMs: number;
  readonly pressure: {
    readonly state: PressureState;
    /** Memory-scale score (see `pressureScore`). */
    readonly score: number;
    readonly reason: string;
    readonly memAvailableBytes: number | null;
  };
  /** Live `cleo run` jobs, oldest first (command lines are redacted). */
  readonly running: readonly Pick<
    RunJob,
    'class' | 'command' | 'cwd' | 'startedAtMs' | 'sessionId' | 'pausedAtMs'
  >[];
}

function shellQuote(token: string): string {
  return /^[\w@%+=:,./-]+$/.test(token) ? token : `'${token.replace(/'/g, `'\\''`)}'`;
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
  readonly pressure: RunDeferralDetails['pressure'];
  readonly running: readonly RunJob[];
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
      action: 'Queue fairly and start automatically when a slot frees',
      command: `cleo run --wait -- ${cmd}`,
    },
  );
  const running = input.running.map((j) => ({
    class: j.class,
    command: j.command,
    cwd: j.cwd,
    startedAtMs: j.startedAtMs,
    sessionId: j.sessionId,
    pausedAtMs: j.pausedAtMs,
  }));
  return {
    details: {
      class: input.cls,
      reason: input.reason,
      retryAfterMs: input.retryAfterMs,
      pressure: input.pressure,
      running,
    },
    alternatives,
    fix: `The machine is busy (${input.pressure.state}). Continue other work, or re-run with --wait to queue.`,
  };
}
