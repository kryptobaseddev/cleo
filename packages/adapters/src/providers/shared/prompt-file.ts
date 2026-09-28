/**
 * Private temp files for spawn-adapter prompts.
 *
 * Prompts used to be written to a literal `/tmp/<provider>-spawn-<id>.txt`.
 * Windows has no `/tmp`, so every spawn failed there, and on macOS the path
 * ignored `$TMPDIR` and the per-user sandbox temp. Each prompt now lives in a
 * fresh `mkdtemp` directory under `os.tmpdir()`, removed with the file (T12606).
 *
 * @task T12606
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Write a prompt to `prompt.txt` inside a new private temp directory.
 *
 * @param prefix - Directory-name prefix identifying the provider, e.g. `claude-spawn`.
 * @param prompt - Prompt text.
 * @returns Absolute path of the written prompt file.
 * @example
 * ```ts
 * const file = await writeSpawnPromptFile('codex-spawn', prompt);
 * // …spawn the child with `file`, then on exit:
 * await removeSpawnPromptFile(file);
 * ```
 */
export async function writeSpawnPromptFile(prefix: string, prompt: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `cleo-${prefix}-`));
  const file = join(dir, 'prompt.txt');
  await writeFile(file, prompt, 'utf-8');
  return file;
}

/**
 * Remove a prompt file written by {@link writeSpawnPromptFile} and its directory.
 * Never throws: cleanup failure must not mask the spawn outcome.
 *
 * @param file - Path returned by {@link writeSpawnPromptFile}.
 */
export async function removeSpawnPromptFile(file: string): Promise<void> {
  await rm(dirname(file), { recursive: true, force: true }).catch(() => undefined);
}
