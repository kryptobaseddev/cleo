/**
 * `runGoverned`: admit a heavy command through the machine-wide governor,
 * run it, and supervise it under pressure. The engine behind `cleo run`,
 * reusable by the supervisor (T12982).
 *
 * Lifecycle:
 *
 * 1. **Admission.** First, orphans of dead runners are reaped. Test, build
 *    and full-build jobs are admitted by the admission ledger (T13133): one
 *    byte budget and one FIFO queue shared with every evidence run on the
 *    machine. Nested in an admitted run's process tree (a `cleo run` under a
 *    `cleo run` or a `cleo verify`), a job rides that admission. Admission is
 *    non-blocking by default: a refused job returns a `deferred` result, with
 *    nothing started. With `wait`, it waits in the queue until admitted or
 *    `timeoutMs`; while the memory gate refuses heavy work (T13127) it warns
 *    "waiting: memory pressure" with the readings (at most once a minute),
 *    after a minute it names the holders and any suspected wait cycle, and it
 *    warns again when pressure falls. Other classes (db-heavy) keep their
 *    governor slot.
 * 2. **Run.** The command is spawned as its own process group (so a pause or
 *    a cancel reaches its workers too), niced, with the caller's env. The job
 *    is recorded in the registry with its start times and a heartbeat. Its
 *    stdout goes to stderr, or with `passthrough` to the caller's stdout. A
 *    `foreground` child (a terminal's job) and a nested one stay in their
 *    group instead, are signalled by pid and are never paused.
 * 3. **Supervise.** One serialized poll loop (never overlapping) samples
 *    pressure and applies {@link decidePause}: SIGSTOP/SIGCONT to the group.
 *    Every await is followed by an exit check, so nothing is signalled or
 *    written after the child exits.
 * 4. **Exit.** If the job was ever paused, the group gets a SIGCONT (workers
 *    of a killed leader must not stay stopped); the record is removed and the
 *    slot released. SIGINT, SIGTERM and SIGHUP to the runner are forwarded to
 *    the group (after a SIGCONT). A runner killed outright is recovered by the
 *    next {@link reapOrphans}, which never acts on an unreadable `ps`.
 *
 * @module resources/run-governed
 * @task T12979
 * @task T12980
 * @task T12981
 * @task T13127
 * @task T13133
 * @epic T12978
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { setPriority } from 'node:os';
import type { AdmissionResult, MemoryPressureReading, ResourceClass } from '@cleocode/contracts';
import { detectTestRunner, GovernedRunInTestRunnerError } from '../tasks/tool-runner-guard.js';
import {
  ADMISSION_ENV,
  type AdmissionOutcome,
  type AdmissionRequest,
  type AdmissionScope,
  type AdmitOptions,
  admissionDir,
  admit,
  describeAdmissionIoError,
  footprintForClass,
  gitHookInstalled,
  isLedgerClass,
  type LedgerChild,
  type LedgerEntry,
  readLedger,
} from './admission-ledger.js';
import type { ResourceSample } from './backend.js';
import { admitFailOpen, type GovernorIoError, governor } from './governor.js';
import { recordHookPeak } from './hook-footprint.js';
import { classifyPressure, type PressureState, pressureScore, ResourceMonitor } from './monitor.js';
import { MEMORY_GATE_RETRY_AFTER_MS, memoryGateReporter } from './pressure-gate.js';
import {
  buildRunDeferral,
  decidePause,
  isPausable,
  listRunJobs,
  type ProcessTreeUsage,
  parentRunJob,
  processAncestors,
  processGroupOf,
  processStart,
  processTreeUsage,
  RUN_WATCH_START,
  type RunAlternative,
  type RunDeferralDetails,
  type RunJob,
  type RunWatchState,
  reapOrphans,
  redactCommand,
  removeRunJob,
  runJobsDir,
  runningEntries,
  runWatchLimits,
  signalGroup,
  signalPid,
  watchRun,
  writeRunJob,
} from './run-admission.js';
import { testPauseExemption } from './run-class.js';
import { trackToolGroup } from './tool-groups.js';
import { memoryPressureCause } from './top-memory.js';

/** Niceness applied to the command (children inherit it). */
export const RUN_NICENESS = 10;

/** The minimal child-process surface the loop needs (tests fake it). */
export interface GovernedChild extends EventEmitter {
  readonly pid?: number | undefined;
}

/**
 * How out of the ordinary a notice is. `warn`: the run is ungoverned, was
 * paused or resumed under pressure, was admitted after waiting in the queue,
 * or the runner was signalled (`--passthrough` still prints these). `info`:
 * progress such as a nested run (left out by `--passthrough`).
 */
export type RunNoticeLevel = 'info' | 'warn';

/** Injectable effects. Defaults are the real process, governor and clock. */
export interface RunGovernedDeps {
  readonly sample: () => Promise<ResourceSample>;
  /** Admission for a ledger class (test, build, full-build): the admission ledger. */
  readonly admit: (req: AdmissionRequest, opts: AdmitOptions) => Promise<AdmissionOutcome>;
  /** Admission for any other class (db-heavy): a governor slot. */
  readonly tryAcquire: (cls: ResourceClass, sample: ResourceSample) => Promise<AdmissionResult>;
  /**
   * Start the child. `passthrough`: it gets the runner's stdin, stdout and
   * stderr; otherwise its stdout goes to stderr. `detached`: its own session
   * and process group.
   */
  readonly spawn: (
    file: string,
    args: readonly string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; passthrough: boolean },
  ) => GovernedChild;
  readonly signal: (pid: number, signal: NodeJS.Signals) => boolean;
  /** Signal a single process (a nested job's child shares its parent's group). */
  readonly signalPid: (pid: number, signal: NodeJS.Signals) => boolean;
  readonly start: (pid: number) => string | null;
  readonly renice: (pid: number) => void;
  readonly now: () => number;
  /**
   * Wait `ms`. The timer keeps the process alive (a `--wait` queue has
   * nothing else to); `signal` cancels it early so a finished run exits at once.
   */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Install runner signal forwarding; returns an uninstall function. */
  readonly onRunnerSignal: (handler: (signal: NodeJS.Signals) => void) => () => void;
  readonly jobsDir: string;
  /** The runner's parent pid, recorded with a signal the runner received (T13680). */
  readonly ppid: number;
  /**
   * The runner's parent pid now (T14080). When it no longer equals
   * {@link RunGovernedDeps.ppid}, the parent died (a wrapper shell SIGKILLed
   * by a harness) and the runner stops its child. @defaultValue process.ppid
   */
  readonly currentPpid: () => number;
  /** The admission ledger's entries (for the `running[]` of a deferral). */
  readonly ledger: () => readonly LedgerEntry[];
  readonly pid: number;
  /** Process group of a pid (`ps -o pgid=`), or null when unknown. */
  readonly groupOf: (pid: number) => number | null;
  /** Ancestors of a pid, nearest first (one `ps` of the process table), or null when unknown. */
  readonly ancestorsOf: (pid: number) => readonly number[] | null;
  /** CPU time and resident memory of a pid's process tree (one `ps`), or null when unknown (T13563). */
  readonly treeUsage: (pid: number, withCommands?: boolean) => ProcessTreeUsage | null;
  /** Where hook measurements are kept (T13921). @defaultValue the admission directory */
  readonly hookFootprintsDir: string;
  /**
   * Whether a git hook is installed for the run's checkout (T14093).
   * @defaultValue probes `opts.cwd` with `gitHookInstalled`
   */
  readonly hookInstalled?: (hook: string, globals: readonly string[]) => boolean;
}

/** How often the watchdog measures the child's process tree (T13563). */
export const TREE_SAMPLE_MS = 30_000;

/** How often a run that measures its hook's peak samples its tree (T13921). */
export const HOOK_SAMPLE_MS = 5_000;

/**
 * How recently an enclosing runner must have forwarded a signal to its child's
 * group for a nested runner to treat the same signal as that delivery (T13002).
 */
export const GROUP_SIGNAL_WINDOW_MS = 2_000;

/** How long a run whose parent died gets after SIGTERM before SIGKILL (T14080). */
export const PARENT_GONE_KILL_MS = 10_000;

/** Options for {@link runGoverned}. */
export interface RunGovernedOptions {
  readonly argv: readonly string[];
  readonly cls: ResourceClass;
  readonly cwd: string;
  /** Child environment (caller applies heavyToolEnv). */
  readonly env: NodeJS.ProcessEnv;
  readonly sessionId: string | null;
  readonly wait?: boolean;
  /** With `wait`: give up after this long. @defaultValue 30 min */
  readonly timeoutMs?: number;
  /** Supervision cadence. @defaultValue 5000 */
  readonly pollMs?: number;
  /** Queue cadence under `wait`. @defaultValue 1000 */
  readonly queuePollMs?: number;
  /**
   * The child gets the runner's stdin, stdout and stderr (`cleo run
   * --passthrough`), so its stdout reaches the caller byte for byte.
   * @defaultValue false (stdout goes to stderr; the caller's stdout is reserved)
   */
  readonly passthrough?: boolean;
  /**
   * Keep the child in the runner's process group instead of a detached one:
   * a terminal's foreground job, so reading or configuring the terminal never
   * stops it (SIGTTIN/SIGTTOU) and Ctrl-C reaches it. Such a child is never
   * paused. SIGTERM and SIGHUP to the runner are forwarded to it by pid;
   * SIGINT is not, since the terminal already sent it to the whole group.
   * @defaultValue false
   */
  readonly foreground?: boolean;
  /** One-line notices (stderr in the CLI); see {@link RunNoticeLevel}. */
  readonly notice?: (line: string, level: RunNoticeLevel) => void;
  /**
   * Bytes to ask the ledger for: what the planned env lets the child start
   * (`planFootprintBytes`, T13132). @defaultValue the class's default footprint
   */
  readonly footprintBytes?: number;
  /** Why the run is charged `footprintBytes`, for the ledger and status (T13367). */
  readonly footprintReason?: string;
  /** How much of the project the run covers, for status (T13132). */
  readonly scope?: AdmissionScope;
  /** Queue ahead of routine waiters, still within the budget (T13921). @defaultValue false */
  readonly urgent?: boolean;
  /**
   * Never SIGSTOP this run (`cleo run --no-pause`, T14075): a test with
   * wall-clock deadlines (an external database, a child timeout) fails if it
   * is frozen mid-run. It is admitted and charged like any run of its class,
   * and since pressure cannot pause it later, at `backoff` the ledger starts
   * it only by the idle rule (T14098): one at a time, in queue order, while no
   * CLEO run is admitted and its charge fits the reclaimable memory. Otherwise
   * it waits (with `wait`) or is deferred.
   * @defaultValue false
   */
  readonly noPause?: boolean;
  /**
   * The run is meant to outlive the process that started it (`nohup`, a
   * launcher script that exits): it is exempt from the parent-death stop
   * (T14080) and keeps running when its parent exits. @defaultValue false
   */
  readonly detach?: boolean;
  /**
   * The git hook or heavy `node` script the command carries
   * (`planRunFootprint`'s `hookKey`): its tree is sampled every
   * {@link HOOK_SAMPLE_MS} and the peak is recorded under this key, so the
   * next run of that hook (T13921) or script (T14050) is charged by it.
   */
  readonly hookKey?: string;
  readonly deps?: Partial<RunGovernedDeps>;
}

/** A signal the runner itself received, and forwarded to its child (T13680). */
export interface RunnerSignal {
  readonly signal: NodeJS.Signals;
  /** When it arrived (epoch ms). */
  readonly atMs: number;
  /** The runner's parent pid then: the likeliest sender, or its process. */
  readonly ppid: number;
}

/** Result of {@link runGoverned}. */
export type RunGovernedResult =
  | {
      /** A signal reached the runner while it waited in the queue; nothing started (T13681). */
      readonly kind: 'interrupted';
      readonly signal: NodeJS.Signals;
      readonly waitedMs: number;
      readonly class: ResourceClass;
      readonly command: string;
    }
  | {
      readonly kind: 'deferred';
      readonly reason: string;
      readonly details: RunDeferralDetails;
      readonly alternatives: RunAlternative[];
      readonly fix: string;
    }
  | {
      readonly kind: 'exited';
      readonly class: ResourceClass;
      readonly command: string;
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      /** Set when the command could not be started at all. */
      readonly spawnError: string | null;
      readonly durationMs: number;
      readonly waitedMs: number;
      readonly pausedMs: number;
      readonly pauses: number;
      readonly slot: number;
      /**
       * Set when the governor's state could not be written (a sandboxed or read-only CLEO home, a
       * full disk): the command ran ungoverned rather than not at all.
       */
      readonly ungoverned: GovernorIoError | null;
      /**
       * The first SIGINT/SIGTERM/SIGHUP the runner itself received while the
       * child ran, which it forwarded; null when the runner was not signalled,
       * so a `signal` here with no `runnerSignal` was aimed at the child (T13680).
       */
      readonly runnerSignal: RunnerSignal | null;
      /** True exactly when the run waited in the queue and said "admitted after" (T13681). */
      readonly queued: boolean;
      /**
       * Why the run was never paused under pressure, when it may not be
       * (T14093): `--no-pause`, or it runs tests on wall-clock deadlines.
       */
      readonly notPausable?: string;
    };

/** What admission handed the run: how to give it back, and what to tell the child. */
interface RunAdmission {
  readonly release: () => Promise<void>;
  /** The slot index (governor classes), `0` for a ledger share, `-1` when riding another's. */
  readonly slot: number;
  /** The `CLEO_ADMISSION` value for the child, or `''`. */
  readonly token: string;
  /** Whether this run holds a share or slot of its own (not riding an enclosing one). */
  readonly holdsShare: boolean;
  /** Record the spawned child on the ledger entry (T13046); absent for governor slots. */
  readonly recordChild?: (child: LedgerChild) => void;
  /** Report the child tree's RSS, so the ledger charge follows it (T14116); ledger shares only. */
  readonly observeRss?: (rssBytes: number) => void;
}

// The classifier moved to the governor, which every admission shares (R8-1).
export { governorIoError } from './governor.js';

/**
 * The real child spawner {@link runGoverned} uses. Unless passed through,
 * stdout is reserved for the caller's envelope: output goes to stderr.
 *
 * Exported as the explicit opt-in for a test that means to start a process:
 * inside a test runner `runGoverned` refuses to spawn unless `deps.spawn` is
 * injected (T13236), and passing this one says "really spawn".
 *
 * @param file - Executable.
 * @param args - Arguments.
 * @param opts - Working directory, environment, process-group and stdio mode.
 * @returns The started child.
 */
export const spawnGovernedChild: RunGovernedDeps['spawn'] = (file, args, opts) =>
  nodeSpawn(file, [...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: opts.passthrough ? 'inherit' : ['inherit', 2, 2],
    detached: opts.detached,
  });

function defaultDeps(): RunGovernedDeps {
  const monitor = new ResourceMonitor();
  return {
    sample: () => monitor.sample(),
    admit,
    tryAcquire: (cls, sample) => governor.tryAcquire(cls, { sample }),
    spawn: spawnGovernedChild,
    signal: signalGroup,
    signalPid,
    start: processStart,
    renice: (pid) => {
      try {
        setPriority(pid, RUN_NICENESS);
      } catch {
        // Not permitted here: normal priority.
      }
    },
    now: Date.now,
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      }),
    onRunnerSignal: (handler) => {
      const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
      const fns = signals.map((s) => {
        const fn = () => handler(s);
        process.on(s, fn);
        return [s, fn] as const;
      });
      return () => {
        for (const [s, fn] of fns) process.off(s, fn);
      };
    },
    jobsDir: runJobsDir(),
    ppid: process.ppid,
    currentPpid: () => process.ppid,
    ledger: () => readLedger(),
    pid: process.pid,
    groupOf: processGroupOf,
    ancestorsOf: processAncestors,
    treeUsage: processTreeUsage,
    hookFootprintsDir: admissionDir(),
  };
}

/** Registry probes bound to the injected clock, start-time probe and signaller. */
function probesOf(d: RunGovernedDeps) {
  return { now: d.now, start: d.start, signal: d.signal, signalPid: d.signalPid };
}

async function deferral(
  opts: RunGovernedOptions,
  d: RunGovernedDeps,
  reason: string,
  retryAfterMs: number,
  sample: ResourceSample | null,
  queuePosition: number | null,
  memoryPressure: MemoryPressureReading | null = null,
): Promise<RunGovernedResult> {
  const pressure = sample === null ? null : classifyPressure(sample);
  const built = buildRunDeferral({
    cls: opts.cls,
    argv: opts.argv,
    reason,
    retryAfterMs,
    queuePosition,
    memoryPressure,
    pressure: {
      state: pressure?.state ?? 'hold',
      score: sample === null ? 0 : Number(pressureScore(sample).toFixed(1)),
      reason: pressure?.reason ?? 'resource sample unavailable',
      memAvailableBytes: sample?.memAvailableBytes ?? null,
    },
    running: runningEntries(listRunJobs(d.jobsDir, probesOf(d)), d.ledger()),
  });
  return { kind: 'deferred', reason, ...built };
}

/**
 * Admit, run and supervise one heavy command. Never throws for admission or
 * child failures; those are results.
 */
export async function runGoverned(opts: RunGovernedOptions): Promise<RunGovernedResult> {
  const command = redactCommand(opts.argv);
  // T13236: inside a test runner nothing starts unless the test injected a
  // spawner on purpose — a stale mock must not start the suite again from one
  // of its own workers (the T13203 class, through cleo run's front door).
  if (opts.deps?.spawn === undefined) {
    const marker = detectTestRunner(process.env);
    if (marker !== null) throw new GovernedRunInTestRunnerError(command, marker);
  }
  const d: RunGovernedDeps = { ...defaultDeps(), ...opts.deps };
  // T14093: a run is never paused when asked (`--no-pause`, T14075) or when it
  // runs tests on wall-clock deadlines (a test run, a hooked push or commit).
  const hookInstalled =
    d.hookInstalled ??
    ((hook: string, globals: readonly string[]) => gitHookInstalled(opts.cwd, hook, globals));
  const neverPause: string | null =
    opts.noPause === true ? '--no-pause' : testPauseExemption(opts.cls, opts.argv, hookInstalled);
  const notice = opts.notice ?? (() => {});
  const t0 = d.now();

  // ---- 1. admission -------------------------------------------------------
  // Reap what dead runners left behind (never on an unreadable `ps`).
  reapOrphans(d.jobsDir, probesOf(d));
  let sample: ResourceSample | null = null;

  // A nested run (a script under `cleo run` that itself calls `cleo run`)
  // runs inside its enclosing job's process tree. Of the SAME class it rides
  // the enclosing job's slot (#1777 round 3, M-2); of another class it takes
  // its own slot (round 4, MED-1). Either way its child stays in the
  // enclosing group, is never paused on its own, and is signalled by pid
  // (round 5, N1). See {@link parentRunJob} for why this can't be forged.
  // T12994: note whether `ps` failed, so a nested run that could not see its
  // enclosing job re-checks on every queue poll instead of waiting on it.
  let psFailed = false;
  const detectEnclosing = (): RunJob | null => {
    psFailed = false;
    return parentRunJob({
      pid: d.pid,
      jobsDir: d.jobsDir,
      probes: probesOf(d),
      groupOf: (pid) => {
        const g = d.groupOf(pid);
        if (g === null) psFailed = true;
        return g;
      },
      ancestorsOf: (pid) => {
        const a = d.ancestorsOf(pid);
        if (a === null) psFailed = true;
        return a;
      },
    });
  };
  let enclosing = detectEnclosing();
  let nested = enclosing !== null;
  // Fail open (#1781 review, HIGH): when admission state cannot be written (Codex's
  // workspace-write sandbox, Claude Code's sandboxed Bash, a read-only CLEO home), run the command
  // ungoverned instead of failing a test that would have passed. Only filesystem errors; anything
  // else is a bug and propagates. E_RESOURCE_DEFERRED is unchanged.
  let ungoverned: GovernorIoError | null = null;
  const sayUngoverned = (io: GovernorIoError): void => {
    ungoverned = io;
    notice(`${describeAdmissionIoError(io)}: running ungoverned`, 'warn');
  };
  const deadline = t0 + (opts.timeoutMs ?? 30 * 60_000);
  // T13681: a signal while queued leaves the queue and reports it, never a
  // silent death with no envelope.
  const queueAbort = new AbortController();
  let queuedSignal: NodeJS.Signals | null = null;
  const uninstallQueue = opts.wait
    ? d.onRunnerSignal((signal) => {
        queuedSignal ??= signal;
        queueAbort.abort();
      })
    : () => {};
  const queueStopped = new Promise<null>((resolve) => {
    queueAbort.signal.addEventListener('abort', () => resolve(null), { once: true });
  });
  let queueTimer: NodeJS.Timeout | undefined;
  const expireQueue = (): void => {
    const remaining = deadline - d.now();
    if (remaining <= 0) queueAbort.abort();
    else queueTimer = setTimeout(expireQueue, Math.min(2_147_483_647, remaining));
  };
  if (opts.wait) expireQueue();
  const queueEnded = (): boolean => {
    if (opts.wait && d.now() >= deadline) queueAbort.abort();
    return queueAbort.signal.aborted;
  };
  const releaseLate = (release: () => Promise<void>): void => {
    void release().catch((err) => {
      notice(
        `admission cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
        'warn',
      );
    });
  };
  let waitingPressure: MemoryPressureReading | null = null;
  const pressureReporter = memoryGateReporter((line) => notice(line, 'warn'), `${opts.cls} job`, {
    now: d.now,
  });
  const endQueue = (): Promise<RunGovernedResult> =>
    queuedSignal !== null
      ? Promise.resolve(interrupted(queuedSignal))
      : deferral(
          opts,
          d,
          `timed out after ${Math.round((d.now() - t0) / 1000)}s waiting for the machine budget` +
            (waitingPressure === null
              ? ''
              : `; last reported memory pressure ${waitingPressure.score} (refused above ${waitingPressure.refuseAbove}, resumes at ${waitingPressure.resumeAtOrBelow} or below): ${memoryPressureCause(waitingPressure)}`),
          waitingPressure === null ? 2_000 : MEMORY_GATE_RETRY_AFTER_MS,
          sample,
          null,
          waitingPressure,
        );
  let admission: RunAdmission;
  let queued = false;
  try {
    if (queueEnded()) return endQueue();
    const initial = await Promise.race([d.sample(), queueStopped]);
    if (initial === null || queueEnded()) return endQueue();
    sample = initial;
    // T14075: a run that may never be paused starts only below backoff, so
    // pressure keeps it queued instead of freezing it mid-run. A nested run
    // rides its enclosing admission and is never paused on its own anyway.
    // T14093: so is a run that executes tests on wall-clock deadlines.
    // T14098: a ledger class is held by the ledger instead, whose idle rule
    // starts it while CLEO holds nothing (the pressure is someone else's).
    if (neverPause !== null && !nested && !isLedgerClass(opts.cls)) {
      let said = false;
      while (classifyPressure(sample).state === 'backoff') {
        const reason =
          `machine at backoff (${classifyPressure(sample).reason}); a run that is never paused ` +
          `(${neverPause}) starts only below backoff`;
        if (!opts.wait) return deferral(opts, d, reason, MEMORY_GATE_RETRY_AFTER_MS, sample, null);
        if (!said) notice(`waiting: ${reason}`, 'warn');
        said = true;
        await d.sleep(Math.min(opts.queuePollMs ?? 1000, deadline - d.now()), queueAbort.signal);
        if (queueEnded()) return endQueue();
        const next = await Promise.race([d.sample(), queueStopped]);
        if (next === null || queueEnded()) return endQueue();
        sample = next;
      }
    }
    if (isLedgerClass(opts.cls)) {
      // T13133: one budget and one FIFO queue for every heavy run. Nested in an
      // admitted run's process tree (any class), it rides that admission; a
      // memory-pressure wait and, after a minute, the holders are warnings, so
      // --passthrough shows them.
      const pending = d
        .admit(
          {
            label: `run:${opts.cls}`,
            footprintBytes: opts.footprintBytes ?? footprintForClass(opts.cls),
            ...(opts.footprintReason !== undefined
              ? { footprintReason: opts.footprintReason }
              : {}),
            ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
            // T13237: one full-build machine-wide, whatever its footprint.
            ...(opts.cls === 'full-build' ? { exclusive: true } : {}),
            ...(opts.urgent === true ? { urgent: true } : {}),
            ...(neverPause !== null && !nested ? { neverPause: true } : {}),
            command,
            cwd: opts.cwd,
          },
          {
            wait: opts.wait === true,
            timeoutMs: Math.max(1, deadline - d.now()),
            ...(opts.queuePollMs !== undefined ? { pollMs: opts.queuePollMs } : {}),
            memoryPressure: {
              waiting: (reading, waitedMs, remainingMs) => {
                waitingPressure = reading;
                pressureReporter.waiting(reading, waitedMs, remainingMs);
              },
              admitted: (waitedMs, score) => {
                waitingPressure = null;
                pressureReporter.admitted(waitedMs, score);
              },
            },
            notice: (line) => notice(line, 'warn'),
            // T14066: a waiter stops dead runners' orphaned children on every
            // pass, not only when a run starts, so their charge is freed.
            onPass: () => {
              reapOrphans(d.jobsDir, probesOf(d));
            },
            now: d.now,
            sleep: (ms) => d.sleep(ms, queueAbort.signal),
            signal: queueAbort.signal,
          },
        )
        .then((out) => {
          if (out.admitted && queueEnded()) {
            releaseLate(() => out.grant.release());
            return null;
          }
          return out;
        });
      const out = await Promise.race([pending, queueStopped]);
      if (out === null) return endQueue();
      if (queuedSignal !== null) {
        if (out.admitted) releaseLate(() => out.grant.release());
        return interrupted(queuedSignal);
      }
      if (!out.admitted) {
        const { refusal } = out;
        return deferral(
          opts,
          d,
          opts.wait
            ? `timed out after ${Math.round((d.now() - t0) / 1000)}s waiting for the machine budget (position ${refusal.ahead + 1}): ${refusal.reason}`
            : refusal.reason,
          refusal.retryAfterMs,
          sample,
          opts.wait ? refusal.ahead + 1 : null,
          refusal.memoryPressure,
        );
      }
      const { grant } = out;
      if (queueEnded()) {
        releaseLate(() => grant.release());
        return endQueue();
      }
      if (grant.ungoverned) sayUngoverned(grant.ungoverned);
      if (grant.nested) {
        notice('nested in an admitted run: riding its admission, inside its process tree', 'info');
      } else if (grant.admittedBy === 'idle') {
        queued = grant.waitedMs >= 1_000 && opts.wait === true;
        notice(
          'admitted by the idle rule: no CLEO run was admitted and its charge fits the reclaimable ' +
            'memory, so it starts while pressure outside CLEO keeps the budget closed (one at a time)',
          'warn',
        );
      } else if (grant.waitedMs >= 1_000 && opts.wait) {
        queued = true;
        notice(`admitted after ${Math.round(grant.waitedMs / 1000)}s in the queue`, 'warn');
      }
      admission = {
        release: () => grant.release(),
        slot: grant.id === null ? -1 : 0,
        token: grant.token,
        holdsShare: grant.id !== null,
        recordChild: (child) => grant.recordChild?.(child),
        observeRss: (rssBytes) => grant.observeRss?.(rssBytes),
      };
    } else {
      // Classes outside the ledger (db-heavy) keep their governor slots. A run
      // nested in a job of the SAME class rides its slot (#1777 round 3, M-2).
      const parent = enclosing !== null && enclosing.class === opts.cls ? enclosing : null;
      if (parent) {
        notice(
          `nested in a running ${parent.class} job (${parent.command}): running on its slot`,
          'info',
        );
        admission = { release: async () => {}, slot: -1, token: '', holdsShare: false };
      } else {
        const tryAcquire = (s: ResourceSample): Promise<AdmissionResult | null> => {
          const pending = admitFailOpen(opts.cls, () => d.tryAcquire(opts.cls, s)).then((r) => {
            if (queueEnded()) {
              const acquired = r.admission;
              if (!acquired.deferred) releaseLate(() => acquired.release());
              return null;
            }
            if (r.ungoverned !== null) sayUngoverned(r.ungoverned);
            return r.admission;
          });
          return Promise.race([pending, queueStopped]);
        };
        let result = await tryAcquire(sample);
        let rideParent: RunJob | null = null;
        while (result?.deferred && opts.wait && !queueEnded()) {
          await d.sleep(Math.min(opts.queuePollMs ?? 1000, deadline - d.now()), queueAbort.signal);
          if (queueEnded()) return endQueue();
          if (enclosing === null && psFailed) {
            // T12994: the first detection could not read the process tree; a
            // nested run must not wait for its own enclosing job's slot.
            const found = detectEnclosing();
            if (found !== null) {
              enclosing = found;
              nested = true;
              if (found.class === opts.cls) {
                rideParent = found;
                break;
              }
            }
          }
          const next = await Promise.race([d.sample(), queueStopped]);
          if (next === null || queueEnded()) return endQueue();
          sample = next;
          result = await tryAcquire(sample);
        }
        if (rideParent !== null) {
          // T12994: nested in a job of the same class after all: ride its slot.
          notice(
            `nested in a running ${rideParent.class} job (${rideParent.command}): running on its slot`,
            'info',
          );
          admission = { release: async () => {}, slot: -1, token: '', holdsShare: false };
        } else {
          if (result === null || queueEnded()) {
            if (result !== null && !result.deferred) {
              const acquired = result;
              releaseLate(() => acquired.release());
            }
            return endQueue();
          }
          if (result.deferred) {
            return deferral(
              opts,
              d,
              result.reason,
              result.retryAfterMs,
              sample,
              null,
              result.memoryPressure ?? null,
            );
          }
          const granted = result;
          admission = {
            release: () => granted.release(),
            slot: granted.slot,
            token: '',
            holdsShare: true,
          };
        }
      }
    }
    if (queueEnded()) {
      releaseLate(admission.release);
      return endQueue();
    }
  } finally {
    clearTimeout(queueTimer);
    // Every admission path, a throw or a nested ride included, drops the queue handler.
    uninstallQueue();
  }
  const grant = admission;
  const waitedMs = d.now() - t0;

  // ---- 2. run -------------------------------------------------------------
  const startedAtMs = d.now();
  // A nested job lives in its enclosing job's group, a foreground job in its
  // terminal's: neither leads a group, so neither is ever paused on its own.
  const leadsGroup = !nested && opts.foreground !== true;
  // Ungoverned, it holds no slot and keeps no reliable record: never paused
  // either. T14075: nor is a run that asked not to be (`--no-pause`).
  const pausable =
    leadsGroup &&
    ungoverned === null &&
    neverPause === null &&
    isPausable(opts.cls, opts.argv, hookInstalled);
  if (neverPause !== null && leadsGroup) notice(`never paused: ${neverPause}`, 'info');
  const [file, ...args] = opts.argv as [string, ...string[]];
  // No inherited grant marker (#1777 round 2): every nested `cleo run` is
  // admitted on its own; verify joins the same budgets with #1775 (T12963).
  // T13133: the child carries the admission token, so a cleo command it runs
  // rides this job's admission instead of queueing behind it.
  const env: NodeJS.ProcessEnv = {
    ...opts.env,
    CLEO_RUN_CLASS: opts.cls,
    ...(grant.token ? { [ADMISSION_ENV]: grant.token } : {}),
  };

  let job: RunJob = {
    id: `${d.pid}-${startedAtMs}`,
    pid: d.pid,
    runnerStart: d.start(d.pid),
    childPid: null,
    childStart: null,
    class: opts.cls,
    command,
    cwd: opts.cwd,
    startedAtMs,
    sessionId: opts.sessionId,
    pausedAtMs: null,
    pausable,
    heartbeatAtMs: startedAtMs,
    parentJob: enclosing?.id ?? null,
    holdsSlot: grant.holdsShare,
    leadsGroup,
    ...(opts.detach === true ? { detached: true } : {}),
  };
  writeRunJob(job, d.jobsDir);

  let exited = false;
  // Declared before the spawn: a spawn failure reports it too (null).
  let runnerSignal: RunnerSignal | null = null;
  let pausedAtMs: number | null = null;
  let capResumedAtMs: number | null = null;
  let pausedTotalMs = 0;
  let pauses = 0;

  let child: GovernedChild;
  try {
    child = d.spawn(file, args, {
      cwd: opts.cwd,
      env,
      detached: leadsGroup,
      passthrough: opts.passthrough === true,
    });
  } catch (err) {
    removeRunJob(job.id, d.jobsDir);
    await grant.release();
    return exitedResult(err instanceof Error ? err.message : String(err), null, null);
  }

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>(
    (resolve) => {
      child.once('error', (error: Error) => resolve({ code: null, signal: null, error }));
      child.once('exit', (code: number | null, signal: NodeJS.Signals | null) =>
        resolve({ code, signal }),
      );
    },
  );
  // T12963: the slot this runner holds lists the child's group, so a SIGKILLed
  // runner's slot stays held while the child runs. A nested or foreground
  // child leads no group of its own. T13046: tracked before anything else
  // runs after the spawn, so no window leaves a live child unlisted.
  const childPid = child.pid;
  const untrackGroup = leadsGroup ? trackToolGroup(childPid) : () => {};

  void exit.then(() => {
    exited = true;
  });

  if (childPid !== undefined) {
    const childStart = d.start(childPid);
    // T13046: a non-leader child is listed too, so its charge outlives a dead runner.
    grant.recordChild?.({ pid: childPid, startedAt: childStart });
    d.renice(childPid);
    job = { ...job, childPid, childStart };
    if (!exited) writeRunJob(job, d.jobsDir);
  }

  // A nested or foreground child is not a group leader (it lives in the
  // enclosing job's or the terminal's group): signal the process itself, or
  // kill(-pid) would hit ESRCH and the child would keep running (#1777 round
  // 4, L-A).
  const forwardTo = leadsGroup ? d.signal : d.signalPid;
  const uninstall = d.onRunnerSignal((signal) => {
    runnerSignal ??= { signal, atMs: d.now(), ppid: d.ppid };
    if (childPid === undefined || exited) return;
    // A terminal's Ctrl-C already reached its whole foreground group, child
    // included: forwarding it would deliver a second SIGINT, which some
    // runners treat as force-quit (#1777 R8). SIGTERM and SIGHUP still go.
    if (opts.foreground === true && signal === 'SIGINT') return;
    // T13002: a nested child shares this runner's group. When the enclosing
    // runner just forwarded this signal to that whole group, or the enclosing
    // job runs in a terminal's foreground group that a Ctrl-C reached, the
    // child already got it: forwarding again would deliver it twice. A signal
    // sent to this runner alone still goes to its child.
    if (nested && enclosing !== null && groupAlreadyDelivered(signal, enclosing)) return;
    if (leadsGroup) {
      // T13002: tell nested runners in the child's group this delivery reached them.
      job = { ...job, forwardedSignal: { signal, atMs: d.now() } };
      if (!exited) writeRunJob(job, d.jobsDir);
    }
    notice(
      `runner received ${signal} (its parent pid ${d.ppid}); forwarding it to pid ${childPid}`,
      'warn',
    );
    forwardTo(childPid, 'SIGCONT');
    forwardTo(childPid, signal);
  });

  // ---- 3. supervise (serialized: one tick at a time) ----------------------
  let state: PressureState = 'ok';
  // T13563: an admitted run that overstays or hangs is reported, never killed.
  const limits = runWatchLimits(opts.cls);
  let watch: RunWatchState = RUN_WATCH_START;
  let treeSampledAtMs = Number.NEGATIVE_INFINITY;
  let peakRssBytes = 0;
  let treeSamples = 0;
  // T13972: a sample counts toward the hook's measurement only while the hook
  // itself runs in the tree (a no-op push or a disabled hook never does).
  const hookName = opts.hookKey?.split(':')[0];
  const hookInTree = (commands: readonly string[] | undefined): boolean =>
    hookName !== undefined &&
    (commands ?? []).some((c) =>
      c.split(/\s+/).some((w) => w === hookName || w.endsWith(`/${hookName}`)),
    );
  const treeSampleMs = opts.hookKey !== undefined ? HOOK_SAMPLE_MS : TREE_SAMPLE_MS;
  const watchdog = (now: number): void => {
    if (childPid === undefined || now - treeSampledAtMs < treeSampleMs) return;
    treeSampledAtMs = now;
    const usage = d.treeUsage(childPid, hookName !== undefined);
    if (usage && hookInTree(usage.commands)) {
      treeSamples++;
      peakRssBytes = Math.max(peakRssBytes, usage.rssBytes);
    }
    // T14116: the ledger charge follows the measured tree after a warm-up.
    if (usage) admission.observeRss?.(usage.rssBytes);
    // A pause still in progress is not run time either (T13570).
    const pausedMs = pausedTotalMs + (pausedAtMs !== null ? now - pausedAtMs : 0);
    const step = watchRun(
      watch,
      { nowMs: now, startedAtMs, pausedTotalMs: pausedMs, paused: pausedAtMs !== null, usage },
      limits,
    );
    watch = step.next;
    const minutes = (ms: number) => Math.round(ms / 60_000);
    for (const event of step.events) {
      if (event === 'overdue')
        notice(
          `overdue: running ${minutes(now - startedAtMs - pausedMs)} min, past the ${opts.cls} limit of ${minutes(limits.maxWallMs ?? 0)} min (pid ${childPid}, ${command}). It keeps its reservation until it exits; check it or stop it.`,
          'warn',
        );
      else if (event === 'hung')
        notice(
          `hung? its process tree used no CPU for ${minutes(now - (watch.idleSinceMs ?? now))} min (pid ${childPid}, session ${opts.sessionId ?? 'unknown'}, ${command}). It still holds its reservation; check it or stop it.`,
          'warn',
        );
      else notice('active again: its process tree is using CPU.', 'warn');
    }
    job = {
      ...job,
      ...(usage ? { measuredRssBytes: usage.rssBytes, cpuMs: usage.cpuMs } : {}),
      idleSinceMs: watch.idleSinceMs,
      overdueAtMs: watch.overdueAtMs,
      hungAtMs: watch.hungAtMs,
    };
  };
  /**
   * T13002: whether a signal this nested runner received was a group delivery
   * its child got too: the enclosing runner recorded forwarding it to the group
   * moments ago, or it is a SIGINT in an enclosing foreground (terminal) group.
   */
  function groupAlreadyDelivered(signal: NodeJS.Signals, parent: RunJob): boolean {
    if (signal === 'SIGINT' && parent.leadsGroup === false && (parent.parentJob ?? null) === null) {
      return true;
    }
    const current = listRunJobs(d.jobsDir, probesOf(d)).find((j) => j.id === parent.id);
    const sent = current?.forwardedSignal;
    return (
      sent !== undefined && sent.signal === signal && d.now() - sent.atMs <= GROUP_SIGNAL_WINDOW_MS
    );
  }

  // T14080: the runner's parent died (a wrapper shell SIGKILLed by a harness
  // TaskStop): nothing will wait for this run, so stop its child. SIGTERM
  // first, SIGKILL after a grace; the exit path then releases the charge.
  let parentGoneAtMs: number | null = null;
  const checkParent = (now: number): void => {
    if (childPid === undefined || exited || opts.detach === true) return;
    if (parentGoneAtMs === null) {
      if (d.currentPpid() === d.ppid) return;
      parentGoneAtMs = now;
      notice(
        `its parent process (pid ${d.ppid}) is gone; stopping the command (pid ${childPid}) and releasing its reservation`,
        'warn',
      );
      forwardTo(childPid, 'SIGCONT');
      forwardTo(childPid, 'SIGTERM');
    } else if (now - parentGoneAtMs >= PARENT_GONE_KILL_MS) {
      forwardTo(childPid, 'SIGKILL');
    }
  };

  const stopTimers = new AbortController();
  void exit.then(() => stopTimers.abort());
  const supervise = async (): Promise<void> => {
    while (!exited) {
      const woke = await Promise.race([
        d.sleep(opts.pollMs ?? 5000, stopTimers.signal).then(() => 'tick' as const),
        exit.then(() => 'exit' as const),
      ]);
      if (woke === 'exit' || exited || childPid === undefined) return;
      checkParent(d.now());
      // Before the pressure sample: a failed sample must not hide a hung run.
      watchdog(d.now());
      let s: ResourceSample;
      try {
        s = await d.sample();
      } catch {
        continue; // A failed sample never pauses anything.
      }
      if (exited) return;
      state = classifyPressure(s, state).state;
      const now = d.now();
      const { decision, reason } = decidePause({
        state,
        self: job,
        jobs: listRunJobs(d.jobsDir, probesOf(d)),
        nowMs: now,
        pausedAtMs,
        capResumedAtMs,
      });
      if (exited) return;
      if (decision === 'pause' && pausedAtMs === null) {
        if (!d.signal(childPid, 'SIGSTOP')) continue;
        pausedAtMs = now;
        pauses++;
        notice(
          `paused: machine at backoff (${classifyPressure(s).reason}); an older job keeps running. Resumes automatically.`,
          'warn',
        );
      } else if (decision === 'run' && pausedAtMs !== null) {
        d.signal(childPid, 'SIGCONT');
        pausedTotalMs += now - pausedAtMs;
        pausedAtMs = null;
        if (reason === 'cap') capResumedAtMs = now;
        notice(reason === 'cap' ? 'resumed: paused for the maximum time' : 'resumed.', 'warn');
      }
      job = { ...job, pausedAtMs, heartbeatAtMs: now };
      if (!exited) writeRunJob(job, d.jobsDir);
    }
  };
  const supervisor = supervise();

  const result = await exit;
  exited = true;
  untrackGroup();
  await supervisor;
  uninstall();
  // Workers of a killed (or paused) leader must never stay stopped.
  if (childPid !== undefined && pauses > 0) d.signal(childPid, 'SIGCONT');
  if (pausedAtMs !== null) pausedTotalMs += d.now() - pausedAtMs;
  removeRunJob(job.id, d.jobsDir);
  await grant.release();
  // T13921/T13972: only a hooked run that exited 0, with its hook seen in the
  // tree at HOOK_MIN_SAMPLES samples, is a measurement (recordHookPeak decides).
  if (opts.hookKey !== undefined && result.code === 0) {
    await recordHookPeak(opts.hookKey, peakRssBytes, treeSamples, d.hookFootprintsDir, d.now());
  }
  return exitedResult(result.error ? result.error.message : null, result.code, result.signal);

  function exitedResult(
    spawnError: string | null,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): RunGovernedResult {
    return {
      kind: 'exited',
      class: opts.cls,
      command,
      exitCode,
      signal,
      spawnError,
      durationMs: d.now() - startedAtMs,
      waitedMs,
      pausedMs: pausedTotalMs,
      pauses,
      slot: grant.slot,
      ungoverned,
      runnerSignal,
      queued,
      ...(neverPause !== null ? { notPausable: neverPause } : {}),
    };
  }

  function interrupted(signal: NodeJS.Signals): RunGovernedResult {
    notice(`${signal} while waiting in the queue: left the queue, nothing started`, 'warn');
    return { kind: 'interrupted', signal, waitedMs: d.now() - t0, class: opts.cls, command };
  }
}
