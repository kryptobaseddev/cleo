/**
 * CLI command: cleo run [--class <c>] [--wait [--timeout <s>]] [--urgent] [--no-pause] [--passthrough] -- <command...>
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
 *   Nothing was started. `--wait` joins the machine-wide FIFO queue instead;
 *   `--urgent` queues ahead of routine waiters, still within the budget
 *   (T13921).
 * - While it runs: at `backoff` only the oldest `cleo run` job keeps going;
 *   younger pausable ones are SIGSTOPped and resumed later; pressure never
 *   kills a job. (Only the orphaned group of a runner that died is stopped.)
 *   `--no-pause` (T14075) marks a run with wall-clock deadlines (an external
 *   database, a child timeout) that a pause would break: it is charged like
 *   any run of its class, is never SIGSTOPped, and starts only below backoff,
 *   waiting in the queue (with `--wait`) or deferred while the machine is at
 *   backoff.
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
 * - A vitest run that names no test file, directory, `--project` or `-t`
 *   filter (an empty or `.` filter names nothing), or a package script that
 *   runs vitest (`pnpm test`, `pnpm -r test`) without narrowing arguments, is
 *   refused: it is the whole suite, and the usual cause is an empty generated
 *   file list (T13236). `--whole-suite` says it is deliberate.
 * - Inside a test runner (VITEST, VITEST_WORKER_ID, JEST_WORKER_ID) nothing
 *   is started (`E_RUN_SPAWN_IN_TEST_RUNNER`, exit 8): a stale mock must not
 *   start the suite again from one of its own workers (T13236, after T13203).
 *
 * Exit codes: the child's own code; 128+n when a signal killed it; 127 when
 * it could not be started; 75 when not admitted; 6 on invalid input; 8 inside a test runner. The same
 * with `--passthrough`.
 *
 * @task T12979
 * @task T12980
 * @task T12981
 * @task T13133
 * @task T13236
 * @epic T12978
 */

import { constants } from 'node:os';
import type { HeavyToolResourcePlan } from '@cleocode/contracts';
import {
  RESOURCE_DEFERRED_CODE,
  RUN_COMMAND_FAILED_CODE,
  RUN_DEFERRED_EXIT_CODE,
  RUN_INTERRUPTED_CODE,
} from '@cleocode/contracts/resource-governor.js';
import { getProjectRoot } from '@cleocode/core/paths.js';
import { describeCharge, planRunFootprint } from '@cleocode/core/resources/admission-ledger.js';
import {
  isWatchCommand,
  isWholeSuiteTestRun,
  resolveRunClass,
} from '@cleocode/core/resources/run-admission.js';
import {
  type RunGovernedResult,
  type RunNoticeLevel,
  runGoverned,
} from '@cleocode/core/resources/run-governed.js';
import { GovernedRunInTestRunnerError } from '@cleocode/core/tasks/tool-runner-guard.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { negatedFlag } from '../lib/negated-flag.js';
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
      'Run a heavy command (tests, builds, installs) under the machine-wide resource budget: cleo run [--class test|build|full-build] [--wait] [--urgent] [--no-pause] [--detach] [--passthrough] -- <command...>',
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
    urgent: {
      type: 'boolean',
      description:
        'Queue ahead of routine waiters (a fix for a red main), still admitted only within the budget; nothing running is paused for it',
      default: false,
    },
    // T14075 — `--no-pause` keeps a run with wall-clock deadlines from being SIGSTOPped
    pause: {
      type: 'boolean',
      default: true,
      description:
        'Allow pausing under pressure (default for builds, typechecks and lint). --no-pause never SIGSTOPs the run: it is charged like any run of its class and starts only below backoff, waiting in the queue (with --wait) or deferred while the machine is at backoff. A run that executes tests (class test, a test runner or test script, node --test, or a git push/commit whose hook is installed) is never paused without the flag, since its wall-clock test timeouts keep counting while it is stopped',
    },
    'whole-suite': {
      type: 'boolean',
      description:
        'Allow a whole-suite test run (a vitest run naming no file, directory, --project or -t filter, or a vitest test script without narrowing arguments): refused by default, since an empty file list is the usual cause',
      default: false,
    },
    detach: {
      type: 'boolean',
      description:
        'The run is meant to outlive the process that started it (nohup, a launcher script that exits): it keeps running when its parent exits. Without it, a run whose parent dies (a wrapper shell killed by a harness) stops its command and releases its budget (T14080). Also set by CLEO_RUN_DETACHED=1',
      default: false,
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

    // T13236: `vitest run` with nothing named (or an empty/`.` filter), or a
    // package `test` script that runs vitest, is the whole suite. Twice an
    // empty generated file list did exactly that by accident.
    if (args['whole-suite'] !== true && isWholeSuiteTestRun(argv, process.cwd())) {
      invalid(
        `cleo run refuses a test run that names no test file, directory, --project or -t filter: it would run the whole suite (${argv.join(' ')}). An empty generated file list is the usual cause`,
        'Name what to run: cleo run -- pnpm exec vitest run path/to/a.test.ts (check a generated list is not empty), or pass test files to the script (pnpm test path/to/a.test.ts). For a deliberate whole-suite run: cleo run --whole-suite -- <cmd>',
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
    // file; it is planned, charged and spawned with that many. T13367: a
    // formatter on named files is charged light, a one-process linter or
    // `tsc -p` one process, so neither queues behind a 24 GiB reservation.
    // T14097: a test run in a checkout whose workspace packages resolve into
    // another checkout would test that checkout's build; T14123: so would one
    // whose dist was built from other source. Refuse both before admission.
    if (cls === 'test-run') {
      const {
        borrowedBuildWarning,
        unstampedDistWarning,
        workspaceResolutionError,
        workspaceResolutionForTestRun,
      } = await import('@cleocode/core/tasks/workspace-resolution.js');
      const report = workspaceResolutionForTestRun(process.cwd(), argv);
      const err = report === null ? null : workspaceResolutionError(report);
      if (err !== null) {
        cliError(
          err.message,
          err.codeName,
          { name: err.codeName, fix: err.fix, details: err.details },
          { operation: 'resources.run' },
          { stderr: passthrough },
        );
        process.exit(err.code);
      }
      // Warnings go to stderr (notice), never into --passthrough's stdout.
      for (const warning of report === null
        ? []
        : [borrowedBuildWarning(report), unstampedDistWarning(report)])
        if (warning !== null) notice(warning, 'warn');
    }
    // T14162: an explicit --class is charged its plan until measured, and the
    // project may declare heavy scripts.
    const plan = planRunFootprint(
      cls,
      argv,
      process.env,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { explicitClass: args.class !== undefined, ...projectRootOption() },
    );
    const { overlay, resources, footprintBytes, footprintReason, namedFiles, hookKey } = plan;
    if (resources !== null) {
      notice(
        `planned resources: ${resources.summary}`,
        resources.clamped.length > 0 || resources.overBudget ? 'warn' : 'info',
      );
      // T14038: a project setting the overlay overrides is named, so a run that
      // behaves differently from the project's own setup says why.
      for (const o of resources.projectOverrides ?? []) {
        notice(
          `overrides the project's ${o.setting} ${o.projectValue} (${o.file}) with ${o.variable}=${o.appliedValue}`,
          'warn',
        );
      }
    }
    // T14050: the bytes asked of the ledger and how they were derived.
    notice(`charged footprint: ${describeCharge(cls, plan)}`, 'info');

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
        urgent: args.urgent === true,
        ...(negatedFlag(args, 'pause') ? { noPause: true } : {}),
        // T14080: an intentionally detached run survives its parent's exit.
        detach: args.detach === true || process.env.CLEO_RUN_DETACHED === '1',
        ...(hookKey !== undefined ? { hookKey } : {}),
        passthrough,
        // A terminal on stdin: keep the child in its foreground group.
        foreground: passthrough && process.stdin.isTTY === true,
        notice,
        ...(footprintBytes !== undefined ? { footprintBytes } : {}),
        footprintReason,
        ...(namedFiles !== null ? { scope: 'narrowed' as const } : {}),
      });
    } catch (err) {
      // A runner error is reported here, not by the CLI's top-level catch,
      // which writes to stdout: under --passthrough that is the child's
      // byte stream (#1777 R8-2).
      if (err instanceof GovernedRunInTestRunnerError) {
        cliError(
          err.message,
          err.codeName,
          { name: err.codeName, fix: err.fix, details: err.details },
          { operation: 'resources.run' },
          { stderr: passthrough },
        );
        process.exit(err.code);
      }
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

    if (result.kind === 'interrupted') {
      // T13681: a signal while queued is reported, never a silent exit.
      const { kind: _interrupted, ...details } = result;
      cliError(
        `interrupted by ${result.signal} while waiting in the queue: nothing started`,
        RUN_INTERRUPTED_CODE,
        { name: RUN_INTERRUPTED_CODE, details },
        { operation: 'resources.run' },
        { stderr: passthrough },
      );
      process.exit(128 + (constants.signals[result.signal] ?? 0));
    }

    const code = runExitCode(result);
    if (code !== 0) exitFailed(result, code, passthrough, resources);
    if (passthrough) {
      // T13681: a run that said "admitted after" ends with one line too, so a
      // finished queued run never looks like a no-op; the two always come as a
      // pair. A run admitted at once stays byte-silent (#1777 R7): the hook
      // rewrites every heavy command.
      if (result.queued) notice(`exited 0 after ${Math.round(result.durationMs / 1000)}s`, 'warn');
      return;
    }
    const { kind: _kind, ...data } = result;
    cliOutput(resources === null ? data : { ...data, resources }, {
      command: 'run',
      operation: 'resources.run',
    });
  },
});

/** The project root for project-declared heavy scripts (T14162), when inside a project. */
function projectRootOption(): { projectRoot?: string } {
  try {
    return { projectRoot: getProjectRoot() };
  } catch {
    return {};
  }
}
