/**
 * CLI command: cleo run [--class <c>] [--wait] [--timeout <s>] -- <command...>
 *
 * The one front door for heavy commands an agent runs itself: test runners,
 * compilers, builds, installs. The command is admitted through the same
 * machine-wide ResourceGovernor budget `cleo verify` uses, so every agent,
 * session and project on the machine shares ONE budget.
 *
 * - Admitted: the command runs niced, with heap and worker limits sized for a
 *   heavy tool, and its output streams to stderr. stdout carries one LAFS
 *   envelope at the end: `{ class, exitCode, durationMs, pausedMs, ... }`.
 * - Not admitted (default): an immediate `E_RESOURCE_DEFERRED` envelope (exit
 *   75) with who is running what and concrete ways to keep making progress.
 *   Nothing was started. `--wait` queues instead.
 * - While it runs: if the machine reaches `backoff` (kernel memory critical,
 *   or CPU more than 2x oversubscribed), only the oldest `cleo run` job
 *   keeps going; younger ones are paused (SIGSTOP) and resumed when pressure
 *   eases. Nothing is killed.
 *
 * @task T12979
 * @task T12980
 * @task T12981
 * @epic T12978
 */

import { spawn } from 'node:child_process';
import { setPriority } from 'node:os';
import { RESOURCE_DEFERRED_CODE } from '@cleocode/contracts';
import { governor } from '@cleocode/core/resources/governor.js';
import type { PressureState } from '@cleocode/core/resources/monitor.js';
import {
  classifyPressure,
  pressureScore,
  ResourceMonitor,
} from '@cleocode/core/resources/monitor.js';
import {
  buildRunDeferral,
  canonicalForClass,
  decidePause,
  listRunJobs,
  type RunJob,
  redactCommand,
  registerRunJob,
  removeRunJob,
  resolveRunClass,
  writeRunJob,
} from '@cleocode/core/resources/run-admission.js';
import { heavyToolEnv } from '@cleocode/core/tasks/heavy-tool-env.js';
import { defineCommand } from 'citty';
import { cliError, cliOutput } from '../renderers/index.js';

/** Exit code for "not admitted, nothing started" (sysexits EX_TEMPFAIL). */
export const RUN_DEFERRED_EXIT = 75;

/** How often a running job re-checks pressure for pause/resume. */
const PRESSURE_POLL_MS = 5_000;

/** Niceness applied to the command (children inherit it). */
const RUN_NICENESS = 10;

function commandAfterDashes(rawArgs: readonly string[]): string[] {
  const idx = rawArgs.indexOf('--');
  return idx === -1 ? [] : rawArgs.slice(idx + 1);
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/** cleo run — admit a heavy command through the machine-wide governor. */
export const runCommand = defineCommand({
  meta: {
    name: 'run',
    description:
      'Run a heavy command (tests, builds, installs) under the machine-wide resource budget: cleo run [--class test|build|full-build] [--wait] -- <command...>',
  },
  args: {
    class: {
      type: 'string',
      description:
        'Resource class: test, build, typecheck, install, scan, full-build, db (default: inferred from the command)',
    },
    wait: {
      type: 'boolean',
      description: 'Queue until a slot frees instead of returning E_RESOURCE_DEFERRED',
      default: false,
    },
    timeout: {
      type: 'string',
      description: 'With --wait: give up after this many seconds (default 1800)',
    },
  },
  async run({ args, rawArgs }) {
    const argv = commandAfterDashes(rawArgs ?? []);
    if (argv.length === 0) {
      cliError(
        'cleo run needs a command after --',
        'E_VALIDATION',
        {
          name: 'E_VALIDATION',
          fix: 'cleo run --class test -- npx vitest run path/to/file.test.ts',
        },
        { operation: 'resources.run' },
      );
      process.exit(6);
    }

    let cls: ReturnType<typeof resolveRunClass>;
    try {
      cls = resolveRunClass(args.class as string | undefined, argv);
    } catch (err) {
      cliError(
        err instanceof Error ? err.message : String(err),
        'E_VALIDATION',
        { name: 'E_VALIDATION' },
        { operation: 'resources.run' },
      );
      process.exit(6);
    }

    const monitor = new ResourceMonitor();
    const sample = await monitor.sample();
    let pressure = classifyPressure(sample);
    const timeoutMs = Math.max(1, Number(args.timeout ?? 1800)) * 1000;

    if (args.wait) {
      process.stderr.write(
        `[cleo run] waiting for a ${cls} slot (pressure ${pressure.state})...\n`,
      );
    }
    const admission = args.wait
      ? await governor.acquire(cls, { sample, blocking: true, timeoutMs, pollMs: 1000 })
      : await governor.tryAcquire(cls, { sample });

    if (admission.deferred) {
      const { details, alternatives, fix } = buildRunDeferral({
        cls,
        argv,
        reason: admission.reason,
        retryAfterMs: admission.retryAfterMs,
        pressure: {
          state: pressure.state,
          score: Number(pressureScore(sample).toFixed(1)),
          reason: pressure.reason,
          memAvailableBytes: sample.memAvailableBytes,
        },
        running: listRunJobs(),
      });
      cliError(
        `not started: ${admission.reason}`,
        RESOURCE_DEFERRED_CODE,
        { name: RESOURCE_DEFERRED_CODE, details, fix, alternatives },
        { operation: 'resources.run' },
      );
      process.exit(RUN_DEFERRED_EXIT);
    }

    const startedAtMs = Date.now();
    const sessionId = process.env.CLEO_SESSION_ID ?? process.env.CLAUDE_CODE_SESSION_ID ?? null;
    let job: RunJob = registerRunJob({
      pid: process.pid,
      class: cls,
      command: redactCommand(argv),
      cwd: process.cwd(),
      startedAtMs,
      sessionId,
    });

    const [file, ...rest] = argv as [string, ...string[]];
    const child = spawn(file, rest, {
      // stdout is reserved for the envelope: the command's output goes to stderr.
      stdio: ['inherit', 2, 2],
      detached: true,
      env: { ...process.env, ...heavyToolEnv(canonicalForClass(cls)), CLEO_RUN_CLASS: cls },
    });
    const childPid = child.pid;
    if (childPid !== undefined) {
      try {
        setPriority(childPid, RUN_NICENESS);
      } catch {
        // Not permitted on this platform: run at normal priority.
      }
      job = { ...job, childPid };
      writeRunJob(job);
    }

    // Forward termination to the whole process group (vitest/tsc workers too).
    const forward = (signal: NodeJS.Signals) => () => {
      if (childPid !== undefined) {
        signalGroup(childPid, 'SIGCONT');
        signalGroup(childPid, signal);
      }
    };
    const onInt = forward('SIGINT');
    const onTerm = forward('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);

    // Pause/resume under backoff: only the oldest job keeps running.
    let pausedAtMs: number | null = null;
    let pausedTotalMs = 0;
    let pauses = 0;
    const poll = setInterval(async () => {
      if (childPid === undefined) return;
      try {
        const s = await monitor.sample();
        pressure = classifyPressure(s, pressure.state as PressureState);
        const decision = decidePause({
          state: pressure.state,
          selfId: job.id,
          jobs: listRunJobs(),
          nowMs: Date.now(),
          pausedAtMs,
        });
        if (decision === 'pause' && pausedAtMs === null) {
          signalGroup(childPid, 'SIGSTOP');
          pausedAtMs = Date.now();
          pauses++;
          job = { ...job, pausedAtMs };
          writeRunJob(job);
          process.stderr.write(
            `[cleo run] paused: machine at backoff (${pressure.reason}); an older job keeps running. Resumes automatically.\n`,
          );
        } else if (decision === 'run' && pausedAtMs !== null) {
          signalGroup(childPid, 'SIGCONT');
          pausedTotalMs += Date.now() - pausedAtMs;
          pausedAtMs = null;
          job = { ...job, pausedAtMs: null };
          writeRunJob(job);
          process.stderr.write('[cleo run] resumed.\n');
        }
      } catch {
        // A failed sample never pauses anything.
      }
    }, PRESSURE_POLL_MS);
    poll.unref();

    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
    }>((resolve) => {
      child.once('error', (error) => resolve({ code: null, signal: null, error }));
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });

    clearInterval(poll);
    if (pausedAtMs !== null) pausedTotalMs += Date.now() - pausedAtMs;
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    removeRunJob(job.id);
    await admission.release();

    const data = {
      class: cls,
      command: job.command,
      exitCode: result.code,
      signal: result.signal,
      durationMs: Date.now() - startedAtMs,
      pausedMs: pausedTotalMs,
      pauses,
      slot: admission.slot,
    };

    if (result.error || result.code !== 0) {
      const message = result.error
        ? `could not start command: ${result.error.message}`
        : `command exited with ${result.code ?? result.signal}`;
      cliError(
        message,
        'E_COMMAND_FAILED',
        { name: 'E_COMMAND_FAILED', details: data },
        { operation: 'resources.run' },
      );
      process.exit(result.code && result.code > 0 ? result.code : 1);
    }

    cliOutput(data, { command: 'run', operation: 'resources.run' });
  },
});
