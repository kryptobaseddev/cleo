/**
 * Spawn a provider CLI the same way on every platform.
 *
 * On Windows an npm-installed CLI (`codex`, `gemini`, `opencode`, `pi`) is a
 * `.cmd` shim. Node's bare-name lookup only tries `.exe`/`.com`, and Node
 * refuses to spawn a `.cmd` without a shell (CVE-2024-27980), so a bare
 * `spawn('codex', …)` failed there. {@link resolveSpawnInvocation} spawns the
 * absolute path, routing batch files through cmd.exe with injection-safe
 * quoting. POSIX is unchanged.
 *
 * @task T12618
 */

import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import { resolveSpawnInvocation } from '@cleocode/paths';

/**
 * Spawn `command args` without a user-visible shell on any platform.
 *
 * @param command - CLI name or path, e.g. `codex` or `PI_CLI_PATH`.
 * @param args - Literal arguments; never interpreted by a shell.
 * @param options - Spawn options (cwd, stdio, detached, env).
 * @returns The child process.
 * @throws When a win32 batch-file argument contains a line break.
 * @example
 * ```ts
 * const child = spawnCli('codex', ['--full-auto', promptFile], { detached: true, stdio: 'ignore' });
 * ```
 */
export function spawnCli(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  const inv = resolveSpawnInvocation(command, args);
  return spawn(
    inv.file,
    inv.args,
    inv.windowsVerbatimArguments ? { ...options, windowsVerbatimArguments: true } : options,
  );
}
