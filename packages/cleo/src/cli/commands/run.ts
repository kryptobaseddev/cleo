/**
 * CLI command: cleo run [--class <c>] [--wait [--timeout <s>]] [--passthrough] -- <command...>
 *
 * The one front door for heavy commands an agent runs itself: test runners,
 * compilers, builds, installs. The command is admitted through the admission
 * ledger (T13133): one machine-wide memory budget and one FIFO queue shared by
 * every `cleo run` job and every `cleo verify` evidence run, from any agent,
 * session or project. A `cleo run` nested in an admitted run rides its
 * admission. The engine is `runGoverned` in core.
 *
 * - Admitted: the command runs niced, with heap and worker limits sized for a
 *   heavy tool, as its own process group; its output streams to stderr.
 *   stdout carries one LAFS envelope at the end, whose `resources` names the
 *   heap and worker count chosen and why (T13122). An inherited NODE_OPTIONS
 *   heap or worker count above the run's budget is clamped, and that is
 *   printed as a warning, so it shows even with `--passthrough`.
 * - Not admitted (default): an immediate `E_RESOURCE_DEFERRED` envelope, exit
 *   75, with who is running what and concrete ways to keep making progress.
 *   Nothing was started. `--wait` joins the machine-wide FIFO queue instead.
 * - While it runs: at `backoff` only the oldest `cleo run` job keeps going;
 *   younger pausable ones are SIGSTOPped and resumed later; pressure never
 *   kills a job. (Only the orphaned group of a runner that died is stopped.)
 * - `--passthrough` (what the provider hook emits, T12983): the command gets
 *   this process's stdin, stdout and stderr, and its exit code is ours.
 *   cleo run writes NOTHING of its own to stdout, an explicit exception to the
 *   one-envelope contract (ADR-086), like `docs fetch --content`: its own
 *   envelopes (invalid input, a deferral, a command that could not start) go
 *   to stderr. It stays quiet otherwise, printing only what is out of the
 *   ordinary: a deferral, an ungoverned run, a pause or resume, a failed
 *   command (one line). With a terminal on stdin the child stays in the
 *   terminal's foreground process group (signalled by pid, never paused), so
 *   it can read and configure the terminal.
 * - A watch/dev/serve command is refused (it would hold a slot forever)
 *   unless `--class` asserts that it is a bounded job.
 *
 * Exit codes: the child's own code; 128+n when a signal killed it; 127 when
 * it could not be started; 75 when not admitted; 6 on invalid input. The same
 * with `--passthrough`.
 *
 * @task T12979
 * @task T12980
 * @task T12981
 * @task T13133
 * @epic T12978
 */

import { constants } from 'node:os';
import type { HeavyToolResourcePlan } from '@cleocode/contracts';
import {
  RESOURCE_DEFERRED_CODE,
  RUN_COMMAND_FAILED_CODE,
  RUN_DEFERRED_EXIT_CODE,
} from '@cleocode/contracts/resource-governor.js';
import { planFootprintBytes } from '@cleocode/core/resources/admission-ledger.js';
import {
  canonicalForClass,
  isWatchCommand,
  namedTestFileCount,
  resolveRunClass,
} from '@cleocode/core/resources/run-admission.js';
import {
  type RunGovernedResult,
  type RunNoticeLevel,
  runGoverned,
} from '@cleocode/core/resources/run-governed.js';
import { planHeavyToolEnv } from '@cleocode/core/tasks/heavy-tool-env.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliError, cliOutput } from '../renderers/index.js';

function commandAfterDashes(rawArgs: readonly string[]): string[] {
  const idx = rawArgs.indexOf('--');
  return idx === -1 ? [] : rawArgs.slice(idx + 1);
}

function invalid(message: string, fix: string, stderr: boolean): never {
  cliError(
    message,
    'E_VALIDATION',
    { name: 'E_VALIDATION', fix },
    { operation: 'resources.run' },
    { stderr },
  );
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

/**
 * Report a command that failed and exit with its code. With `--passthrough`
 * the child's own output is the report: one stderr line, unless it could not
 * be started at all (a runner error: the envelope, on stderr).
 */
function exitFailed(
  result: Extract<RunGovernedResult, { kind: 'exited' }>,
  code: number,
  passthrough: boolean,
  resources: HeavyToolResourcePlan | null,
): never {
  const { kind: _kind, ...rest } = result;
  const data = resources === null ? rest : { ...rest, resources };
  const message =
    result.spawnError !== null
      ? `could not start command: ${result.spawnError}`
      : `command ${result.signal !== null ? `killed by ${result.signal}` : `exited with ${result.exitCode}`}`;
  if (passthrough && result.spawnError === null) {
    process.stderr.write(`[cleo run] ${RUN_COMMAND_FAILED_CODE}: ${message}\n`); // json-stream-hygiene-allowed: --passthrough failure line; stdout belongs to the child
  } else {
    cliError(
      message,
      RUN_COMMAND_FAILED_CODE,
      { name: RUN_COMMAND_FAILED_CODE, details: data },
      { operation: 'resources.run' },
      { stderr: passthrough },
    );
  }
  process.exit(code);
}

/** cleo run — admit a heavy command through the machine-wide governor. */
export const runCommand = defineCommand({
  meta: {
    name: 'run',
    description:
      'Run a heavy command (tests, builds, installs) under the machine-wide resource budget: cleo run [--class test|build|full-build] [--wait] [--passthrough] -- <command...>',
  },
  args: {
    class: {
      type: 'string',
      description:
        'Resource class: test, build, typecheck, install, scan, full-build, db (default: inferred from the command)',
    },
    wait: {
      type: 'boolean',
      description:
        'Join the machine-wide FIFO admission queue instead of returning E_RESOURCE_DEFERRED',
      default: false,
    },
    timeout: {
      type: 'string',
      description: 'With --wait: give up after this many seconds (default 1800)',
    },
    passthrough: {
      type: 'boolean',
      description:
        "Give the command this process's stdin, stdout and stderr and exit with its code. cleo run then writes nothing to stdout (an explicit ADR-086 exception, like docs fetch --content): its own envelopes go to stderr, and it prints only a deferral (exit 75), an ungoverned run, a pause or a failure",
      default: false,
    },
  },
  async run({ args, rawArgs }) {
    const passthrough = args.passthrough === true;
    const argv = commandAfterDashes(rawArgs ?? []);
    if (argv.length === 0) {
      invalid(
        'cleo run needs a command after --',
        'cleo run --class test -- npx vitest run path/to/file.test.ts',
        passthrough,
      );
    }

    // A watcher or server never exits: admitted, it would hold its slot (for
    // turbo/nx, the single machine-wide full-build slot) forever. An explicit
    // --class asserts a bounded job and skips the check (R7-2).
    if (args.class === undefined && isWatchCommand(argv)) {
      invalid(
        `cleo run refuses watch/dev/serve commands, which never exit and would hold a resource slot forever: ${argv.join(' ')}`,
        'Run the watcher directly, without cleo run. If it is a bounded job, say so with --class (cleo run --class test -- <cmd>)',
        passthrough,
      );
    }

    let timeoutMs = 1_800_000;
    if (args.timeout !== undefined) {
      if (!args.wait)
        invalid('--timeout requires --wait', 'cleo run --wait --timeout 600 -- <cmd>', passthrough);
      const seconds = Number(args.timeout);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        invalid(
          `--timeout must be a positive number of seconds (got '${args.timeout}')`,
          '--timeout 600',
          passthrough,
        );
      }
      timeoutMs = seconds * 1000;
    }

    let cls: ReturnType<typeof resolveRunClass>;
    try {
      cls = resolveRunClass(args.class as string | undefined, argv, process.cwd());
    } catch (err) {
      invalid(
        err instanceof Error ? err.message : String(err),
        'cleo run --class test -- <cmd>',
        passthrough,
      );
    }

    // Notices go to stderr; stdout carries only the final LAFS envelope, or
    // with --passthrough only the child's output (and then only warnings).
    const notice = (line: string, level: RunNoticeLevel): void => {
      if (passthrough && level === 'info') return;
      process.stderr.write(`[cleo run] ${line}\n`); // json-stream-hygiene-allowed: progress notices, not data
    };
    // T13122: the heap and worker plan, and why — printed before admission, so
    // it is labelled as planned (a deferred run never starts). A clamped
    // inherited value is a warning, so it shows even under --passthrough.
    // T13132: a test run that names its files needs at most one worker per
    // file; it is planned, charged and spawned with that many.
    const namedFiles = namedTestFileCount(cls, argv);
    const { overlay, resources } = planHeavyToolEnv(
      canonicalForClass(cls),
      process.env,
      undefined,
      namedFiles ?? undefined,
    );
    if (resources !== null) {
      notice(
        `planned resources: ${resources.summary}`,
        resources.clamped.length > 0 || resources.overBudget ? 'warn' : 'info',
      );
    }

    let result: RunGovernedResult;
    try {
      result = await runGoverned({
        argv,
        cls,
        cwd: process.cwd(),
        env: { ...process.env, ...overlay },
        sessionId: process.env.CLEO_SESSION_ID ?? process.env.CLAUDE_CODE_SESSION_ID ?? null,
        wait: Boolean(args.wait),
        timeoutMs,
        passthrough,
        // A terminal on stdin: keep the child in its foreground group.
        foreground: passthrough && process.stdin.isTTY === true,
        notice,
        ...(resources !== null ? { footprintBytes: planFootprintBytes(resources) } : {}),
        ...(namedFiles !== null ? { scope: 'narrowed' as const } : {}),
      });
    } catch (err) {
      // A runner error is reported here, not by the CLI's top-level catch,
      // which writes to stdout: under --passthrough that is the child's
      // byte stream (#1777 R8-2).
      cliError(
        `cleo run failed: ${err instanceof Error ? err.message : String(err)}`,
        1,
        { name: 'E_GENERAL' },
        { operation: 'resources.run' },
        { stderr: passthrough },
      );
      process.exit(1);
    }

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
        { stderr: passthrough },
      );
      process.exit(RUN_DEFERRED_EXIT_CODE);
    }

    const code = runExitCode(result);
    if (code !== 0) exitFailed(result, code, passthrough, resources);
    if (passthrough) return;
    const { kind: _kind, ...data } = result;
    cliOutput(resources === null ? data : { ...data, resources }, {
      command: 'run',
      operation: 'resources.run',
    });
  },
});
