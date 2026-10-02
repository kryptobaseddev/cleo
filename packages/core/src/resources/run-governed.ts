/**
 * `runGoverned`: admit a heavy command through the machine-wide governor,
 * run it, and supervise it under pressure. The engine behind `cleo run`,
 * reusable by the supervisor (T12982).
 *
 * Lifecycle:
 *
 * 1. **Admission.** First, orphans of dead runners are reaped. A run nested
 *    inside a running job's process group runs on that job's slot. Otherwise
 *    admission is non-blocking by default: a denied admission (or anyone
 *    already waiting) returns a `deferred` result, with nothing started. With
 *    `wait`, the job takes a ticket in the class's FIFO queue before its
 *    first try; only the head of the queue tries to acquire, re-sampling
 *    pressure each time, until admitted or `timeoutMs`.
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
 * @epic T12978
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { setPriority } from 'node:os';
import {
  type AdmissionResult,
  DEFAULT_RESOURCE_RETRY_AFTER_MS,
  type ResourceClass,
} from '@cleocode/contracts';
import type { ResourceSample } from './backend.js';
import { admitFailOpen, type GovernorIoError, governor, passThroughGrant } from './governor.js';
import { classifyPressure, type PressureState, pressureScore, ResourceMonitor } from './monitor.js';
import {
  buildRunDeferral,
  decidePause,
  isPausable,
  listQueueTickets,
  listRunJobs,
  listVerifyHolders,
  parentRunJob,
  processAncestors,
  processGroupOf,
  processStart,
  type RunAlternative,
  type RunDeferralDetails,
  type RunJob,
  reapOrphans,
  redactCommand,
  removeQueueTicket,
  removeRunJob,
  runJobsDir,
  runningEntries,
  runQueueDir,
  signalGroup,
  signalPid,
  writeQueueTicket,
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
  readonly queueDir: (cls: ResourceClass) => string;
  readonly verifyHolders: () => ReturnType<typeof listVerifyHolders>;
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

// The classifier moved to the governor, which every admission shares (R8-1).
export { governorIoError } from './governor.js';

function defaultDeps(): RunGovernedDeps {
  const monitor = new ResourceMonitor();
  return {
    sample: () => monitor.sample(),
    tryAcquire: (cls, sample) => governor.tryAcquire(cls, { sample }),
    spawn: (file, args, opts) =>
      nodeSpawn(file, [...args], {
        cwd: opts.cwd,
        env: opts.env,
        // Unless passed through, stdout is reserved for the caller's envelope:
        // output goes to stderr.
        stdio: opts.passthrough ? 'inherit' : ['inherit', 2, 2],
        detached: opts.detached,
      }),
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
    queueDir: (cls) => runQueueDir(cls),
    verifyHolders: () => listVerifyHolders(),
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
): Promise<RunGovernedResult> {
  const pressure = classifyPressure(sample);
  const built = buildRunDeferral({
    cls: opts.cls,
    argv: opts.argv,
    reason,
    retryAfterMs,
    queuePosition,
    pressure: {
      state: pressure.state,
      score: Number(pressureScore(sample).toFixed(1)),
      reason: pressure.reason,
      memAvailableBytes: sample.memAvailableBytes,
    },
    running: runningEntries(listRunJobs(d.jobsDir, probesOf(d)), d.verifyHolders()),
  });
  return { kind: 'deferred', reason, ...built };
}

/**
 * Admit, run and supervise one heavy command. Never throws for admission or
 * child failures; those are results.
 */
export async function runGoverned(opts: RunGovernedOptions): Promise<RunGovernedResult> {
  const d: RunGovernedDeps = { ...defaultDeps(), ...opts.deps };
  const notice = opts.notice ?? (() => {});
  const command = redactCommand(opts.argv);
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
  const parent = enclosing !== null && enclosing.class === opts.cls ? enclosing : null;
  if (enclosing && !parent) {
    notice(
      `nested in a running ${enclosing.class} job (${enclosing.command}): admitted on its own ${opts.cls} slot, inside that job's process group`,
      'info',
    );
  }
  // Fail open (#1781 review, HIGH): when the governor cannot write its slot locks (Codex's
  // workspace-write sandbox, Claude Code's sandboxed Bash, a read-only CLEO home), run the command
  // ungoverned instead of failing a test that would have passed. Only filesystem errors; anything
  // else is a bug and propagates. E_RESOURCE_DEFERRED is unchanged.
  let ungoverned: GovernorIoError | null = null;
  const tryAcquire = async (s: ResourceSample): Promise<AdmissionResult> => {
    const r = await admitFailOpen(opts.cls, () => d.tryAcquire(opts.cls, s));
    if (r.ungoverned !== null) {
      const io = r.ungoverned;
      ungoverned = io;
      notice(
        `governor state is not writable (${io.code}${io.path ? ` ${io.path}` : ''}): running ungoverned`,
        'warn',
      );
    }
    return r.admission;
  };
  let admission: AdmissionResult;
  if (parent) {
    admission = passThroughGrant(opts.cls);
    notice(
      `nested in a running ${parent.class} job (${parent.command}): running on its slot`,
      'info',
    );
  } else {
    const qdir = d.queueDir(opts.cls);
    const ticketId = `${d.pid}-${t0}`;
    const ticket = {
      id: ticketId,
      pid: d.pid,
      runnerStart: d.start(d.pid),
      enqueuedAtMs: t0,
      heartbeatAtMs: t0,
      command,
    };
    // With --wait the ticket goes in BEFORE the first try (L-1): nobody can
    // slip in between a denied try and the enqueue.
    if (opts.wait) writeQueueTicket(ticket, qdir);
    /** How many tickets are ahead of this job (all of them without --wait). */
    const ahead = (): number => {
      const queue = listQueueTickets(qdir, probesOf(d));
      if (!opts.wait) return queue.length;
      const at = queue.findIndex((t) => t.id === ticketId);
      if (at >= 0) return at;
      writeQueueTicket({ ...ticket, heartbeatAtMs: d.now() }, qdir); // lost: re-enqueue
      return queue.length;
    };
    const queued = (n: number): AdmissionResult => ({
      deferred: true,
      class: opts.cls,
      retryAfterMs: DEFAULT_RESOURCE_RETRY_AFTER_MS,
      reason: `${n} job(s) ahead in the ${opts.cls} queue`,
    });
    try {
      // No barging (M5): while anyone waits ahead, never try first.
      let position = ahead();
      admission = position > 0 ? queued(position) : await tryAcquire(sample);
      if (admission.deferred && opts.wait) {
        const deadline = t0 + (opts.timeoutMs ?? 30 * 60_000);
        while (admission.deferred) {
          if (d.now() >= deadline) {
            return await deferral(
              opts,
              d,
              `timed out after ${Math.round((d.now() - t0) / 1000)}s in the ${opts.cls} queue (position ${position + 1}): ${admission.reason}`,
              admission.retryAfterMs,
              sample,
              position + 1,
            );
          }
          await d.sleep(opts.queuePollMs ?? 1000);
          writeQueueTicket({ ...ticket, heartbeatAtMs: d.now() }, qdir);
          position = ahead();
          if (position !== 0) {
            admission = queued(position);
            continue; // FIFO: only the head tries.
          }
          sample = await d.sample();
          admission = await tryAcquire(sample);
        }
        notice(
          `admitted after ${Math.round((d.now() - t0) / 1000)}s in the ${opts.cls} queue`,
          'info',
        );
      }
    } finally {
      if (opts.wait) removeQueueTicket(ticketId, qdir);
    }
  }
  if (admission.deferred) {
    return deferral(opts, d, admission.reason, admission.retryAfterMs, sample, null);
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
  const env: NodeJS.ProcessEnv = { ...opts.env, CLEO_RUN_CLASS: opts.cls };

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
    holdsSlot: parent === null,
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
