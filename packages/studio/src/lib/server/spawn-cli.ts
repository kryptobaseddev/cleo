/**
 * Shared utility for shelling out to the `cleo` CLI from Studio API endpoints.
 *
 * Uses child_process.spawn (NOT execFileSync) so long-running commands
 * (nexus analyze, nexus projects scan, etc.) do not block the event loop.
 * Stdout is buffered and the final JSON envelope is parsed on process exit.
 * Stderr is captured and surfaced on failure.
 *
 * @task T657
 */

import { spawn } from 'node:child_process';

/** Timeout for CLI commands in milliseconds. */
const CLI_TIMEOUT_MS = 60_000;

/** LAFS-style envelope returned by all `cleo … --json` commands. */
export interface CliEnvelope {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { message: string; code?: string };
  meta?: Record<string, unknown>;
}

/** Result returned by runCleoCli. */
export interface CliResult {
  ok: boolean;
  envelope: CliEnvelope | null;
  /** Raw stdout text (may be non-JSON on CLI error). */
  stdout: string;
  /** Raw stderr text. */
  stderr: string;
  /** OS exit code. */
  exitCode: number;
}

/**
 * Run a `cleo` CLI command and collect its output.
 *
 * @param args - Arguments to pass to the `cleo` binary (e.g. `['nexus', 'analyze', '/path']`).
 * @returns A promise that resolves with the collected CLI output.
 *
 * @example
 * const result = await runCleoCli(['nexus', 'projects', 'remove', 'proj-123', '--json']);
 */
export function runCleoCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    const cleoBin = process.env['CLEO_BIN'] ?? 'cleo';
    const child = spawn(cleoBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({
        ok: false,
        envelope: null,
        stdout,
        stderr: stderr || 'CLI command timed out after 60s',
        exitCode: -1,
      });
    }, CLI_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      const exitCode = code ?? -1;

      let envelope: CliEnvelope | null = null;
      try {
        const trimmed = stdout.trim();
        if (trimmed.startsWith('{')) {
          envelope = JSON.parse(trimmed) as CliEnvelope;
        }
      } catch {
        // stdout was not valid JSON; keep envelope null
      }

      resolve({
        ok: exitCode === 0 && (envelope?.success ?? true),
        envelope,
        stdout,
        stderr,
        exitCode,
      });
    });
  });
}
