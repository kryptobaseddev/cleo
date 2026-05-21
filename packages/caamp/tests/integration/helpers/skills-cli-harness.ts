/**
 * Test harness for skills CLI integration tests.
 *
 * Eliminates ~700 LOC of duplicated `new Command()` plumbing, `process.exit`
 * stubs, and `console.log`/`console.error` spy boilerplate from
 * `packages/caamp/tests/integration/skills-commands-coverage.test.ts` (T9836).
 *
 * @remarks
 * Each `runCli()` invocation creates a fresh `Command` program, registers the
 * caller's command via `register(program)`, captures `stdout`/`stderr`/`exit`
 * by stubbing the matching globals, and returns a {@link CliInvocation} that
 * exposes typed parsers for the captured output. Spies are scoped to the
 * invocation — callers do not need to remember to `vi.restoreAllMocks()`
 * (Vitest's outer `beforeEach` already covers that). Process-exit semantics
 * are preserved exactly: by default, `expectExit: 1` will throw if the CLI
 * does NOT call `process.exit(N)` so coverage-equivalence with the legacy
 * `expect(...).rejects.toThrow("process-exit")` pattern is maintained.
 *
 * @public
 */

import { Command } from 'commander';
import { type MockInstance, expect, vi } from 'vitest';

/**
 * Function that registers a single skills sub-command on a `Command` program.
 *
 * @example
 * ```typescript
 * import { registerSkillsAudit } from '../../src/commands/skills/audit.js';
 * const inv = await runCli(registerSkillsAudit, ["audit", "/path", "--json"]);
 * ```
 *
 * @public
 */
export type Registrar = (program: Command) => void;

/**
 * Captured output from a single CLI invocation.
 *
 * @remarks
 * `stdout` and `stderr` are arrays of the raw first argument passed to each
 * `console.log` / `console.error` call, stringified via `String(arg ?? "")`.
 * The `jsonStdout()` / `jsonStderr()` helpers parse the FIRST captured line
 * as JSON — matching the existing test pattern
 * `JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"))`.
 *
 * @public
 */
export interface CliInvocation {
  /** All `console.log` first-args, stringified. */
  stdout: string[];
  /** All `console.error` first-args, stringified. */
  stderr: string[];
  /** Exit code passed to `process.exit`, or `null` if exit was never called. */
  exitCode: number | null;
  /** Parse the FIRST stdout line as JSON. Returns `{}` if no output. */
  jsonStdout: () => unknown;
  /** Parse the FIRST stderr line as JSON. Returns `{}` if no output. */
  jsonStderr: () => unknown;
  /** Concatenate all stdout lines with `\n` for human-mode substring assertions. */
  humanStdout: () => string;
  /** Concatenate all stderr lines with `\n` for human-mode substring assertions. */
  humanStderr: () => string;
}

/**
 * Options for {@link runCli}.
 *
 * @public
 */
export interface RunCliOptions {
  /**
   * Expected exit behaviour:
   *
   * - A number `N` — `process.exit(N)` must be called; the call is intercepted
   *   via `throw new Error("process-exit")` and the invocation resolves
   *   normally with `exitCode === N`.
   * - `"any"` — any `process.exit(...)` is accepted.
   * - `undefined` — `process.exit` is stubbed as a no-op (matches the legacy
   *   pattern used by tests that exit but never assert the exit code).
   *
   * @defaultValue undefined
   */
  expectExit?: number | 'any';
}

/**
 * Stringify a console call's first argument the same way the legacy tests do.
 *
 * @internal
 */
function captureArg(value: unknown): string {
  return String(value ?? '');
}

/**
 * Execute a registered CLI command with isolated stdout/stderr/exit capture.
 *
 * @param register - Registrar function (e.g. `registerSkillsAudit`)
 * @param argv - Argument vector AFTER `["node", "test"]` prefix. For example,
 *   to run `skills audit /path --json`, pass `["audit", "/path", "--json"]`.
 *   The `["node", "test"]` prefix is added automatically.
 * @param opts - See {@link RunCliOptions}.
 * @returns The captured {@link CliInvocation}.
 *
 * @example
 * ```typescript
 * const inv = await runCli(registerSkillsAudit, ["audit", "/p", "--json"], { expectExit: 1 });
 * expect(inv.exitCode).toBe(1);
 * const env = inv.jsonStderr() as { result: { findings: number } };
 * expect(env.result.findings).toBe(0);
 * ```
 *
 * @public
 */
export async function runCli(
  register: Registrar,
  argv: string[],
  opts: RunCliOptions = {},
): Promise<CliInvocation> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | null = null;

  const logSpy: MockInstance = vi
    .spyOn(console, 'log')
    .mockImplementation((arg?: unknown) => {
      stdout.push(captureArg(arg));
    });
  const errorSpy: MockInstance = vi
    .spyOn(console, 'error')
    .mockImplementation((arg?: unknown) => {
      stderr.push(captureArg(arg));
    });

  const shouldThrowOnExit = opts.expectExit !== undefined;
  const exitImpl = (code?: number | string | null): never => {
    exitCode = typeof code === 'number' ? code : code != null ? Number(code) : 0;
    if (shouldThrowOnExit) {
      throw new Error('process-exit');
    }
    return undefined as never;
  };
  const exitSpy: MockInstance = vi
    .spyOn(process, 'exit')
    .mockImplementation(exitImpl as (code?: number | string | null) => never);

  const program = new Command();
  register(program);

  try {
    await program.parseAsync(['node', 'test', ...argv]);
  } catch (err) {
    if (!(err instanceof Error) || err.message !== 'process-exit') {
      throw err;
    }
    // expected — exit threw to short-circuit downstream code paths
  }

  if (typeof opts.expectExit === 'number') {
    expect(exitSpy).toHaveBeenCalledWith(opts.expectExit);
  }

  return {
    stdout,
    stderr,
    exitCode,
    jsonStdout: () => JSON.parse(stdout[0] ?? '{}'),
    jsonStderr: () => JSON.parse(stderr[0] ?? '{}'),
    humanStdout: () => stdout.join('\n'),
    humanStderr: () => stderr.join('\n'),
  };
  // Spy instances are intentionally not restored here — Vitest's outer
  // `beforeEach(() => { vi.restoreAllMocks(); ... })` in the test file owns
  // teardown. Restoring here would double-restore for every test.
  // The variables `logSpy`/`errorSpy` are kept for readability of intent.
  void logSpy;
  void errorSpy;
}

/**
 * Assert that a CLI registrar exits with code 1 when invoked with both
 * `--json` and `--human` simultaneously.
 *
 * @remarks
 * Collapses 8+ near-byte-identical tests of the form:
 * ```typescript
 * it("format conflict exits when both --json and --human passed", async () => {
 *   const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
 *   const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
 *     throw new Error("process-exit");
 *   }) as never);
 *   const program = new Command();
 *   registerSkillsX(program);
 *   await expect(
 *     program.parseAsync(["node", "test", ...baseArgv, "--json", "--human"]),
 *   ).rejects.toThrow("process-exit");
 *   expect(exitSpy).toHaveBeenCalledWith(1);
 * });
 * ```
 *
 * @param register - Registrar function (e.g. `registerSkillsAudit`)
 * @param baseArgv - Base argv WITHOUT the `--json --human` flags (which
 *   `expectFormatConflict` appends). For `skills audit /path`, pass
 *   `["audit", "/path"]`.
 *
 * @example
 * ```typescript
 * await expectFormatConflict(registerSkillsAudit, ["audit", "/path"]);
 * ```
 *
 * @public
 */
export async function expectFormatConflict(
  register: Registrar,
  baseArgv: string[],
): Promise<void> {
  const inv = await runCli(register, [...baseArgv, '--json', '--human'], {
    expectExit: 1,
  });
  expect(inv.exitCode).toBe(1);
}
