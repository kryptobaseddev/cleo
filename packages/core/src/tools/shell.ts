/**
 * Atomic shell tool primitives (E3 · T11406 · SG-PACKAGE-ARCH).
 *
 * The canonical `shell`-class implementations of the
 * `@cleocode/contracts/tools/atomic` contracts (T11403). `executeShell` runs a
 * single executable with explicit args/cwd/env/timeout (NEVER a shell string —
 * args are passed as an argv array, so there is no shell-injection surface) and
 * returns a captured `{ stdout, stderr, code }`. The executor is INJECTABLE so
 * unit tests (and future sandboxes) substitute the process layer without
 * spawning real subprocesses. `runGit` is a constrained wrapper.
 *
 * Pure function of input + executor — no session/loop/global coupling. The
 * forward-only consolidation TARGET for the ~60 ad-hoc `node:child_process`
 * call sites in core (migrated under T11410); this module adds the canonical
 * primitives only.
 *
 * @epic T11390
 * @task T11406
 * @saga T11387
 */

import { spawn } from 'node:child_process';
import type {
  ExecuteShellInput,
  ExecuteShellResult,
  RunGitInput,
} from '@cleocode/contracts/tools/atomic';

/**
 * The process layer behind {@link executeShell}. Injecting a custom executor in
 * tests removes the real-subprocess dependency; production uses
 * {@link defaultShellExecutor}.
 */
export type ShellExecutor = (input: ExecuteShellInput) => Promise<ExecuteShellResult>;

/**
 * Default executor: `spawn(command, args)` with no shell, capturing stdout +
 * stderr and resolving `{ stdout, stderr, code }`. A `timeoutMs` kills the
 * process (code resolves to `null` on signal/timeout). Never rejects on a
 * non-zero exit — the exit code is the result, not an error.
 */
export const defaultShellExecutor: ShellExecutor = (input) =>
  new Promise<ExecuteShellResult>((resolve, reject) => {
    const child = spawn(input.command, [...(input.args ?? [])], {
      cwd: input.cwd,
      env: input.env ? { ...process.env, ...input.env } : process.env,
      timeout: input.timeoutMs,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, code });
    });
  });

/**
 * Run a single command (argv form — no shell interpolation).
 *
 * @param input - {@link ExecuteShellInput}.
 * @param executor - process layer; defaults to {@link defaultShellExecutor}.
 * @returns captured `{ stdout, stderr, code }` (`code` is `null` when killed).
 *
 * @example
 * ```ts
 * const { stdout, code } = await executeShell({ command: 'node', args: ['-v'] });
 * ```
 */
export function executeShell(
  input: ExecuteShellInput,
  executor: ShellExecutor = defaultShellExecutor,
): Promise<ExecuteShellResult> {
  return executor(input);
}

/**
 * Run a `git` subcommand — a constrained {@link executeShell} with
 * `command: 'git'`.
 *
 * @param input - {@link RunGitInput} (git args + optional cwd/timeout).
 * @param executor - process layer; defaults to {@link defaultShellExecutor}.
 * @returns captured `{ stdout, stderr, code }`.
 *
 * @example
 * ```ts
 * const { stdout } = await runGit({ args: ['rev-parse', 'HEAD'], cwd: repo });
 * ```
 */
export function runGit(
  input: RunGitInput,
  executor: ShellExecutor = defaultShellExecutor,
): Promise<ExecuteShellResult> {
  return executeShell(
    { command: 'git', args: input.args, cwd: input.cwd, timeoutMs: input.timeoutMs },
    executor,
  );
}
