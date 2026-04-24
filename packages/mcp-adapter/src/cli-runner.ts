/**
 * CLI subprocess runner for the CLEO MCP Adapter.
 *
 * Executes `cleo` commands as child processes and returns structured results.
 * All CLEO interaction happens via subprocess — the adapter has no direct
 * dependency on internal CLEO packages.
 *
 * @task T1148 W8-9
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CliResult } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Invoke a `cleo` CLI command and return the structured result.
 *
 * @param args    - CLI arguments after the `cleo` binary (e.g. `['sentient', 'propose', 'list']`).
 * @param opts    - Optional execution options.
 * @param opts.cwd - Working directory for the subprocess (defaults to `process.cwd()`).
 * @returns Structured result with stdout, stderr, exitCode, and success flag.
 */
export async function runCleo(args: string[], opts?: { cwd?: string }): Promise<CliResult> {
  const cwd = opts?.cwd ?? process.cwd();
  try {
    const { stdout, stderr } = await execFileAsync('cleo', args, {
      cwd,
      env: { ...process.env },
      timeout: 30_000,
    });
    return { success: true, stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number };
    return {
      success: false,
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? String(err),
      exitCode: typeof execErr.code === 'number' ? execErr.code : 1,
    };
  }
}
