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
  admit,
  describeAdmissionIoError,
  footprintForClass,
  isLedgerClass,
  type LedgerEntry,
  readLedger,
} from './admission-ledger.js';
import type { ResourceSample } from './backend.js';
import { admitFailOpen, type GovernorIoError, governor } from './governor.js';
import { classifyPressure, type PressureState, pressureScore, ResourceMonitor } from './monitor.js';
import { memoryGateReporter } from './pressure-gate.js';
import {
  buildRunDeferral,
  decidePause,
  isPausable,
  listRunJobs,
  parentRunJob,
  processAncestors,
  processGroupOf,
  processStart,
  type RunAlternative,
  type RunDeferralDetails,
  type RunJob,
  reapOrphans,
  redactCommand,
  removeRunJob,
  runJobsDir,
  runningEntries,
  signalGroup,
  signalPid,
  writeRunJob,
} from './run-admission.js';
import { trackToolGroup } from './tool-groups.js';

/** Niceness applied to the command (children inherit it). */
export const RUN_NICENESS = 10;

/** The minimal child-process surface the loop needs (tests fake it). */
export interface GovernedChild extends EventEmitter {
  readonly pid?: number | undefined;
}

/**
 * How out of the ordinary a notice is. `warn`: the run is ungoverned, or was
 * paused or resumed under pressure (`--passthrough` still prints these).
 * `info`: progress such as a queue admission or a nested run (left out by
 * `--passthrough`).
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
  /** The admission ledger's entries (for the `running[]` of a deferral). */
  readonly ledger: () => readonly LedgerEntry[];
  readonly pid: number;
  /** Process group of a pid (`ps -o pgid=`), or null when unknown. */
  readonly groupOf: (pid: number) => number | null;
  /** Ancestors of a pid, nearest first (one `ps` of the process table), or null when unknown. */
  readonly ancestorsOf: (pid: number) => readonly number[] | null;
}

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
  /** How much of the project the run covers, for status (T13132). */
  readonly scope?: AdmissionScope;
  readonly deps?: Partial<RunGovernedDeps>;
}

/** Result of {@link runGoverned}. */
export type RunGovernedResult =
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
    ledger: () => readLedger(),
    pid: process.pid,
    groupOf: processGroupOf,
    ancestorsOf: processAncestors,
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
  sample: ResourceSample,
  queuePosition: number | null,
  memoryPressure: MemoryPressureReading | null = null,
): Promise<RunGovernedResult> {
  const pressure = classifyPressure(sample);
  const built = buildRunDeferral({
    cls: opts.cls,
    argv: opts.argv,
    reason,
    retryAfterMs,
    queuePosition,
    memoryPressure,
    pressure: {
      state: pressure.state,
      score: Number(pressureScore(sample).toFixed(1)),
      reason: pressure.reason,
      memAvailableBytes: sample.memAvailableBytes,
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
  const notice = opts.notice ?? (() => {});
  const t0 = d.now();

  // ---- 1. admission -------------------------------------------------------
  // Reap what dead runners left behind (never on an unreadable `ps`).
  reapOrphans(d.jobsDir, probesOf(d));
  let sample = await d.sample();

  // A nested run (a script under `cleo run` that itself calls `cleo run`)
  // runs inside its enclosing job's process tree. Of the SAME class it rides
  // the enclosing job's slot (#1777 round 3, M-2); of another class it takes
  // its own slot (round 4, MED-1). Either way its child stays in the
  // enclosing group, is never paused on its own, and is signalled by pid
  // (round 5, N1). See {@link parentRunJob} for why this can't be forged.
  const enclosing = parentRunJob({
    pid: d.pid,
    jobsDir: d.jobsDir,
    probes: probesOf(d),
    groupOf: d.groupOf,
    ancestorsOf: d.ancestorsOf,
  });
  const nested = enclosing !== null;
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
  let admission: RunAdmission;
  if (isLedgerClass(opts.cls)) {
    // T13133: one budget and one FIFO queue for every heavy run. Nested in an
    // admitted run's process tree (any class), it rides that admission; a
    // memory-pressure wait and, after a minute, the holders are warnings, so
    // --passthrough shows them.
    const out = await d.admit(
      {
        label: `run:${opts.cls}`,
        footprintBytes: opts.footprintBytes ?? footprintForClass(opts.cls),
        ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
        // T13237: one full-build machine-wide, whatever its footprint.
        ...(opts.cls === 'full-build' ? { exclusive: true } : {}),
        command,
        cwd: opts.cwd,
      },
      {
        wait: opts.wait === true,
        timeoutMs: Math.max(1, deadline - d.now()),
        ...(opts.queuePollMs !== undefined ? { pollMs: opts.queuePollMs } : {}),
        memoryPressure: memoryGateReporter((line) => notice(line, 'warn'), `${opts.cls} job`, {
          now: d.now,
        }),
        notice: (line) => notice(line, 'warn'),
        now: d.now,
        sleep: (ms) => d.sleep(ms),
      },
    );
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
    if (grant.ungoverned) sayUngoverned(grant.ungoverned);
    if (grant.nested) {
      notice('nested in an admitted run: riding its admission, inside its process tree', 'info');
    } else if (grant.waitedMs >= 1_000 && opts.wait) {
      notice(`admitted after ${Math.round(grant.waitedMs / 1000)}s in the queue`, 'info');
    }
    admission = {
      release: () => grant.release(),
      slot: grant.id === null ? -1 : 0,
      token: grant.token,
      holdsShare: grant.id !== null,
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
      const tryAcquire = async (s: ResourceSample): Promise<AdmissionResult> => {
        const r = await admitFailOpen(opts.cls, () => d.tryAcquire(opts.cls, s));
        if (r.ungoverned !== null) sayUngoverned(r.ungoverned);
        return r.admission;
      };
      let result = await tryAcquire(sample);
      while (result.deferred && opts.wait && d.now() < deadline) {
        await d.sleep(opts.queuePollMs ?? 1000);
        sample = await d.sample();
        result = await tryAcquire(sample);
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
  const grant = admission;
  const waitedMs = d.now() - t0;

  // ---- 2. run -------------------------------------------------------------
  const startedAtMs = d.now();
  // A nested job lives in its enclosing job's group, a foreground job in its
  // terminal's: neither leads a group, so neither is ever paused on its own.
  const leadsGroup = !nested && opts.foreground !== true;
  // Ungoverned, it holds no slot and keeps no reliable record: never paused either.
  const pausable = leadsGroup && ungoverned === null && isPausable(opts.cls, opts.argv);
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
  };
  writeRunJob(job, d.jobsDir);

  let exited = false;
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
  void exit.then(() => {
    exited = true;
  });

  const childPid = child.pid;
  if (childPid !== undefined) {
    d.renice(childPid);
    job = { ...job, childPid, childStart: d.start(childPid) };
    if (!exited) writeRunJob(job, d.jobsDir);
  }
  // T12963: the slot this runner holds lists the child's group, so a SIGKILLed
  // runner's slot stays held while the child runs. A nested or foreground
  // child leads no group of its own.
  const untrackGroup = leadsGroup ? trackToolGroup(childPid) : () => {};

  // A nested or foreground child is not a group leader (it lives in the
  // enclosing job's or the terminal's group): signal the process itself, or
  // kill(-pid) would hit ESRCH and the child would keep running (#1777 round
  // 4, L-A).
  const forwardTo = leadsGroup ? d.signal : d.signalPid;
  const uninstall = d.onRunnerSignal((signal) => {
    if (childPid === undefined || exited) return;
    // A terminal's Ctrl-C already reached its whole foreground group, child
    // included: forwarding it would deliver a second SIGINT, which some
    // runners treat as force-quit (#1777 R8). SIGTERM and SIGHUP still go.
    if (opts.foreground === true && signal === 'SIGINT') return;
    forwardTo(childPid, 'SIGCONT');
    forwardTo(childPid, signal);
  });

  // ---- 3. supervise (serialized: one tick at a time) ----------------------
  let state: PressureState = 'ok';
  const stopTimers = new AbortController();
  void exit.then(() => stopTimers.abort());
  const supervise = async (): Promise<void> => {
    while (!exited) {
      const woke = await Promise.race([
        d.sleep(opts.pollMs ?? 5000, stopTimers.signal).then(() => 'tick' as const),
        exit.then(() => 'exit' as const),
      ]);
      if (woke === 'exit' || exited || childPid === undefined) return;
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
    };
  }
}
