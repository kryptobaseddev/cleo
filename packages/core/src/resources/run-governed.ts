/**
 * `runGoverned`: admit a heavy command through the machine-wide governor,
 * run it, and supervise it under pressure. The engine behind `cleo run`,
 * reusable by the supervisor (T12982).
 *
 * Lifecycle:
 *
 * 1. **Admission.** Non-blocking by default: a denied admission returns a
 *    `deferred` result (nothing started). With `wait`, the job takes a ticket
 *    in the class's FIFO queue; only the head of the queue tries to acquire,
 *    re-sampling pressure each time, until admitted or `timeoutMs`.
 * 2. **Run.** The command is spawned as its own process group (so a pause or
 *    a cancel reaches its workers too), niced, with the caller's env. The job
 *    is recorded in the registry with its start times and a heartbeat.
 * 3. **Supervise.** One serialized poll loop (never overlapping) samples
 *    pressure and applies {@link decidePause}: SIGSTOP/SIGCONT to the group.
 *    Every await is followed by an exit check, so nothing is signalled or
 *    written after the child exits.
 * 4. **Exit.** If the job was ever paused, the group gets a SIGCONT (workers
 *    of a killed leader must not stay stopped); the record is removed and the
 *    slot released. SIGINT, SIGTERM and SIGHUP to the runner are forwarded to
 *    the group (after a SIGCONT). A runner killed outright is recovered by the
 *    next registry reader (`listRunJobs`).
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
import type { AdmissionResult, ResourceClass } from '@cleocode/contracts';
import type { ResourceSample } from './backend.js';
import { governor } from './governor.js';
import { classifyPressure, type PressureState, pressureScore, ResourceMonitor } from './monitor.js';
import {
  buildRunDeferral,
  decidePause,
  isPausable,
  listQueueTickets,
  listRunJobs,
  listVerifyHolders,
  processStart,
  type RunAlternative,
  type RunDeferralDetails,
  type RunJob,
  redactCommand,
  removeQueueTicket,
  removeRunJob,
  runJobsDir,
  runningEntries,
  runQueueDir,
  signalGroup,
  writeQueueTicket,
  writeRunJob,
} from './run-admission.js';

/** Niceness applied to the command (children inherit it). */
export const RUN_NICENESS = 10;

/** The minimal child-process surface the loop needs (tests fake it). */
export interface GovernedChild extends EventEmitter {
  readonly pid?: number | undefined;
}

/** Injectable effects. Defaults are the real process, governor and clock. */
export interface RunGovernedDeps {
  readonly sample: () => Promise<ResourceSample>;
  readonly tryAcquire: (cls: ResourceClass, sample: ResourceSample) => Promise<AdmissionResult>;
  readonly spawn: (
    file: string,
    args: readonly string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv },
  ) => GovernedChild;
  readonly signal: (pid: number, signal: NodeJS.Signals) => boolean;
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
  /** One-line progress notices (stderr in the CLI). */
  readonly notice?: (line: string) => void;
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
    };

function defaultDeps(): RunGovernedDeps {
  const monitor = new ResourceMonitor();
  return {
    sample: () => monitor.sample(),
    tryAcquire: (cls, sample) => governor.tryAcquire(cls, { sample }),
    spawn: (file, args, opts) =>
      nodeSpawn(file, [...args], {
        cwd: opts.cwd,
        env: opts.env,
        // stdout is reserved for the caller's envelope: output goes to stderr.
        stdio: ['inherit', 2, 2],
        detached: true,
      }),
    signal: signalGroup,
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
  };
}

/** Registry probes bound to the injected clock, start-time probe and signaller. */
function probesOf(d: RunGovernedDeps) {
  return { now: d.now, start: d.start, signal: d.signal };
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
  let sample = await d.sample();
  const qdir = d.queueDir(opts.cls);
  // No barging (#1777 round 2, M5): while anyone waits in this class's queue,
  // a newcomer queues behind them (or defers) instead of trying first.
  const waiting = listQueueTickets(qdir, probesOf(d)).length;
  let admission: AdmissionResult =
    waiting > 0
      ? {
          deferred: true,
          class: opts.cls,
          retryAfterMs: opts.queuePollMs ?? 1000,
          reason: `${waiting} job(s) already waiting in the ${opts.cls} queue`,
        }
      : await d.tryAcquire(opts.cls, sample);
  if (admission.deferred && opts.wait) {
    const ticketId = `${d.pid}-${t0}`;
    const ticket = {
      id: ticketId,
      pid: d.pid,
      runnerStart: d.start(d.pid),
      enqueuedAtMs: t0,
      heartbeatAtMs: t0,
      command,
    };
    writeQueueTicket(ticket, qdir);
    const deadline = t0 + (opts.timeoutMs ?? 30 * 60_000);
    let position = 0;
    try {
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
        const queue = listQueueTickets(qdir, probesOf(d));
        const at = queue.findIndex((t) => t.id === ticketId);
        position = at < 0 ? 0 : at;
        if (position !== 0) continue; // FIFO: only the head tries.
        sample = await d.sample();
        admission = await d.tryAcquire(opts.cls, sample);
      }
    } finally {
      removeQueueTicket(ticketId, qdir);
    }
    notice(`admitted after ${Math.round((d.now() - t0) / 1000)}s in the ${opts.cls} queue`);
  }
  if (admission.deferred) {
    return deferral(opts, d, admission.reason, admission.retryAfterMs, sample, null);
  }
  const grant = admission;
  const waitedMs = d.now() - t0;

  // ---- 2. run -------------------------------------------------------------
  const startedAtMs = d.now();
  const pausable = isPausable(opts.cls, opts.argv);
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
  };
  writeRunJob(job, d.jobsDir);

  let exited = false;
  let pausedAtMs: number | null = null;
  let capResumedAtMs: number | null = null;
  let pausedTotalMs = 0;
  let pauses = 0;

  let child: GovernedChild;
  try {
    child = d.spawn(file, args, { cwd: opts.cwd, env });
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

  const uninstall = d.onRunnerSignal((signal) => {
    if (childPid === undefined || exited) return;
    d.signal(childPid, 'SIGCONT');
    d.signal(childPid, signal);
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
        );
      } else if (decision === 'run' && pausedAtMs !== null) {
        d.signal(childPid, 'SIGCONT');
        pausedTotalMs += now - pausedAtMs;
        pausedAtMs = null;
        if (reason === 'cap') capResumedAtMs = now;
        notice(reason === 'cap' ? 'resumed: paused for the maximum time' : 'resumed.');
      }
      job = { ...job, pausedAtMs, heartbeatAtMs: now };
      if (!exited) writeRunJob(job, d.jobsDir);
    }
  };
  const supervisor = supervise();

  const result = await exit;
  exited = true;
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
    };
  }
}
