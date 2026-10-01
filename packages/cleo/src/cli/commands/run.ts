/**
 * CLI command: cleo run [--class <c>] [--wait [--timeout <s>]] -- <command...>
 *
 * The one front door for heavy commands an agent runs itself: test runners,
 * compilers, builds, installs. The command is admitted through the
 * machine-wide ResourceGovernor, so every agent, session and project on the
 * machine shares one budget. The engine is `runGoverned` in core.
 *
 * - Admitted: the command runs niced, with heap and worker limits sized for a
 *   heavy tool, as its own process group; its output streams to stderr.
 *   stdout carries one LAFS envelope at the end.
 * - Not admitted (default): an immediate `E_RESOURCE_DEFERRED` envelope, exit
 *   75, with who is running what and concrete ways to keep making progress.
 *   Nothing was started. `--wait` joins the class's FIFO queue instead.
 * - While it runs: at `backoff` only the oldest `cleo run` job keeps going;
 *   younger pausable ones are SIGSTOPped and resumed later. Nothing is killed.
 *
 * Exit codes: the child's own code; 128+n when a signal killed it; 127 when
 * it could not be started; 75 when not admitted; 6 on invalid input.
 *
 * @task T12979
 * @task T12980
 * @task T12981
 * @epic T12978
 */

import { constants } from 'node:os';
import {
  RESOURCE_DEFERRED_CODE,
  RUN_COMMAND_FAILED_CODE,
  RUN_DEFERRED_EXIT_CODE,
} from '@cleocode/contracts';
import { canonicalForClass, resolveRunClass } from '@cleocode/core/resources/run-admission.js';
import { runGoverned } from '@cleocode/core/resources/run-governed.js';
import { heavyToolEnv } from '@cleocode/core/tasks/heavy-tool-env.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliError, cliOutput } from '../renderers/index.js';

function commandAfterDashes(rawArgs: readonly string[]): string[] {
  const idx = rawArgs.indexOf('--');
  return idx === -1 ? [] : rawArgs.slice(idx + 1);
}

function invalid(message: string, fix: string): never {
  cliError(message, 'E_VALIDATION', { name: 'E_VALIDATION', fix }, { operation: 'resources.run' });
  process.exit(6);
}

/** Map a child outcome to the runner's exit code. */
export function runExitCode(r: {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError: string | null;
}): number {
  if (r.spawnError !== null) return 127;
  if (r.signal !== null) return 128 + (constants.signals[r.signal] ?? 0);
  return r.exitCode ?? 1;
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
      description: 'Join the FIFO queue for the class instead of returning E_RESOURCE_DEFERRED',
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
      invalid(
        'cleo run needs a command after --',
        'cleo run --class test -- npx vitest run path/to/file.test.ts',
      );
    }

    let timeoutMs = 1_800_000;
    if (args.timeout !== undefined) {
      if (!args.wait)
        invalid('--timeout requires --wait', 'cleo run --wait --timeout 600 -- <cmd>');
      const seconds = Number(args.timeout);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        invalid(
          `--timeout must be a positive number of seconds (got '${args.timeout}')`,
          '--timeout 600',
        );
      }
      timeoutMs = seconds * 1000;
    }

    let cls: ReturnType<typeof resolveRunClass>;
    try {
      cls = resolveRunClass(args.class as string | undefined, argv, process.cwd());
    } catch (err) {
      invalid(err instanceof Error ? err.message : String(err), 'cleo run --class test -- <cmd>');
    }

    const result = await runGoverned({
      argv,
      cls,
      cwd: process.cwd(),
      env: { ...process.env, ...heavyToolEnv(canonicalForClass(cls)) },
      sessionId: process.env.CLEO_SESSION_ID ?? process.env.CLAUDE_CODE_SESSION_ID ?? null,
      wait: Boolean(args.wait),
      timeoutMs,
      notice: (line) => process.stderr.write(`[cleo run] ${line}\n`),
    });

    if (result.kind === 'deferred') {
      cliError(
        `not started: ${result.reason}`,
        RESOURCE_DEFERRED_CODE,
        {
          name: RESOURCE_DEFERRED_CODE,
          details: result.details,
          fix: result.fix,
          alternatives: result.alternatives,
        },
        { operation: 'resources.run' },
      );
      process.exit(RUN_DEFERRED_EXIT_CODE);
    }

    const { kind: _kind, ...data } = result;
    const code = runExitCode(result);
    if (code !== 0) {
      const message =
        result.spawnError !== null
          ? `could not start command: ${result.spawnError}`
          : `command ${result.signal !== null ? `killed by ${result.signal}` : `exited with ${result.exitCode}`}`;
      cliError(
        message,
        RUN_COMMAND_FAILED_CODE,
        { name: RUN_COMMAND_FAILED_CODE, details: data },
        { operation: 'resources.run' },
      );
      process.exit(code);
    }
    cliOutput(data, { command: 'run', operation: 'resources.run' });
  },
});
