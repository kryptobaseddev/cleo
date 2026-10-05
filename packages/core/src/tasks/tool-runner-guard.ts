/**
 * Test-runner guard for the evidence tool runner (T13203).
 *
 * `runToolCached` starts a project's own toolchain (`pnpm run test`, the build,
 * lint, typecheck). Called from inside a test runner, the most likely cause is a
 * mock that no longer intercepts. A stale barrel mock once let a vitest worker
 * run `pnpm run test`, and every worker of that suite did the same: whole-suite
 * runs multiplied across the machine (the T13121 saturation class).
 *
 * Inside a test runner the runner therefore refuses to spawn a tool, with
 * {@link ToolSpawnInTestRunnerError}, unless the test injected a process
 * runner through {@link injectToolProcessRunner}. A test that really wants a
 * child process (the tool-cache suites run tiny `node -e` commands) opts in by
 * injecting the real runner on purpose; nothing reaches it by accident.
 *
 * @module
 * @task T13203
 */

import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { CleoError } from '../errors.js';

/** Captured output of one tool process. */
export interface ToolProcessResult {
  /** Exit code, or `null` when the process never started or died by a signal. */
  exitCode: number | null;
  /**
   * POSIX signal name that terminated the child, or `null` when it exited
   * normally (or never started).
   *
   * gh#1381: Node's `close` event is `(code, signal)` and exactly one of them
   * is non-null. Binding only `code` collapses "killed after running" and
   * "never started" into the same `exitCode: null`.
   */
  signal: NodeJS.Signals | null;
  /** Captured stdout (tail-bounded by the runner). */
  stdout: string;
  /** Captured stderr (tail-bounded by the runner). */
  stderr: string;
  /** `true` when the wall-clock deadline was exceeded and the process was force-killed. */
  timedOut: boolean;
  /**
   * Node's spawn-error message (`ENOENT`, `EACCES`, `EAGAIN`, …) when the child
   * could not be started at all, else `null` (gh#1397).
   */
  spawnError: string | null;
}

/**
 * Starts one tool process and resolves with its captured output.
 *
 * @param cmd - Executable.
 * @param args - Arguments.
 * @param cwd - Working directory.
 * @param spawnTimeoutMs - Kill the process tree after this many ms.
 * @param envOverlay - Variables layered over `process.env`.
 */
export type ToolProcessRunner = (
  cmd: string,
  args: string[],
  cwd: string,
  spawnTimeoutMs?: number,
  envOverlay?: Readonly<Record<string, string>>,
) => Promise<ToolProcessResult>;

/** Environment variables that mean "this process is a test runner or its worker". */
export const TEST_RUNNER_ENV_MARKERS = ['VITEST', 'VITEST_WORKER_ID', 'JEST_WORKER_ID'] as const;

/**
 * Name the test-runner marker present in `env`, if any.
 *
 * @param env - Environment to inspect (injectable for tests).
 * @returns The marker (`VITEST`, `VITEST_WORKER_ID`, `JEST_WORKER_ID` or
 *   `NODE_ENV=test`), or `null` outside a test runner.
 */
export function detectTestRunner(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const name of TEST_RUNNER_ENV_MARKERS) {
    if (env[name] !== undefined && env[name] !== '') return name;
  }
  if (env['NODE_ENV'] === 'test') return 'NODE_ENV=test';
  return null;
}

/**
 * The evidence tool runner refused to start a tool inside a test runner.
 *
 * @example
 * ```ts
 * try { await runToolCached(cmd, root); }
 * catch (e) { if (e instanceof ToolSpawnInTestRunnerError) console.error(e.codeName); }
 * ```
 */
export class ToolSpawnInTestRunnerError extends CleoError {
  /** Stable machine-readable error code. */
  readonly codeName = 'E_TOOL_SPAWN_IN_TEST_RUNNER';

  /**
   * @param tool - Canonical tool name (`test`, `build`, …).
   * @param command - The command line that was refused.
   * @param marker - The test-runner marker that was detected.
   */
  constructor(tool: string, command: string, marker: string) {
    super(
      ExitCode.CONFIG_ERROR,
      `Refused to run tool '${tool}' (${command}) inside a test runner (${marker}): ` +
        'a test reached the real evidence tool runner, usually through a mock that no longer intercepts.',
      {
        fix:
          'Mock the module that calls runToolCached, or inject a runner with ' +
          'injectToolProcessRunner() in the test that means to spawn a process.',
        details: {
          field: 'tool',
          expected: 'an injected ToolProcessRunner inside a test runner',
          actual: marker,
          tool,
          command,
        },
      },
    );
    this.name = 'ToolSpawnInTestRunnerError';
  }
}

let _injected: ToolProcessRunner | null = null;

/**
 * Inject the process runner the evidence tool runner uses (tests only).
 *
 * Passing the real runner (`spawnToolProcess` from `tool-cache.ts`) is the
 * explicit opt-in for a test that means to start a child process. Pass `null`
 * to restore the default.
 *
 * @param runner - Runner to use, or `null` for the default.
 */
export function injectToolProcessRunner(runner: ToolProcessRunner | null): void {
  _injected = runner;
}

/**
 * Pick the process runner for one tool run.
 *
 * @param tool - Canonical tool name, for the refusal message.
 * @param command - The command line, for the refusal message.
 * @param fallback - The real runner, used outside a test runner.
 * @param env - Environment to inspect (injectable for tests).
 * @returns The injected runner, else `fallback` outside a test runner.
 * @throws ToolSpawnInTestRunnerError inside a test runner with no injected runner.
 */
export function resolveToolProcessRunner(
  tool: string,
  command: string,
  fallback: ToolProcessRunner,
  env: NodeJS.ProcessEnv = process.env,
): ToolProcessRunner {
  if (_injected !== null) return _injected;
  const marker = detectTestRunner(env);
  // @sync-invariant none:local-only refuses a local child process from a test runner; no row is written
  if (marker !== null) throw new ToolSpawnInTestRunnerError(tool, command, marker);
  return fallback;
}
