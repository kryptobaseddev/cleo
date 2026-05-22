/**
 * Low-level scaffolding primitives: file-existence checks, CLEO block
 * stripping, .gitignore cleanup, and git-identity helpers.
 */

import { execFile } from 'node:child_process';
import { existsSync, constants as fsConstants } from 'node:fs';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Check if a file exists and is readable.
 *
 * @param path - Absolute path to the file to check
 * @returns True if the file exists and is readable, false otherwise
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Strip legacy CLEO:START/CLEO:END blocks from a file.
 * Called before CAAMP injection to prevent competing blocks.
 *
 * @param filePath - Absolute path to the file to strip
 */
export async function stripCLEOBlocks(filePath: string): Promise<void> {
  if (!existsSync(filePath)) return;
  const content = await readFile(filePath, 'utf8');
  const stripped = content.replace(/\n?<!-- CLEO:START[^>]*-->[\s\S]*?<!-- CLEO:END -->\n?/g, '');
  if (stripped !== content) await writeFile(filePath, stripped, 'utf8');
}

/**
 * Remove .cleo/ or .cleo entries from the project root .gitignore.
 *
 * @param projectRoot - Absolute path to the project root directory
 * @returns Whether any lines were removed from the .gitignore
 */
export async function removeCleoFromRootGitignore(
  projectRoot: string,
): Promise<{ removed: boolean }> {
  const rootGitignorePath = join(projectRoot, '.gitignore');
  if (!(await fileExists(rootGitignorePath))) {
    return { removed: false };
  }
  const content = await readFile(rootGitignorePath, 'utf-8');
  const lines = content.split('\n');
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    return !/^\/?\.cleo\/?(\*)?$/.test(trimmed);
  });
  if (filtered.length === lines.length) {
    return { removed: false };
  }
  await writeFile(rootGitignorePath, filtered.join('\n'));
  return { removed: true };
}

/**
 * Check whether git has a user identity field set (locally or globally).
 *
 * @param cwd - Working directory for the git command
 * @param field - Config field name, e.g. `"user.email"` or `"user.name"`
 * @param localEnv - Optional environment to use instead of `process.env`
 * @returns `true` when the field has a value, `false` when unset or git unavailable
 *
 * @task T9088 — extracted guard to avoid clobbering global git identity
 */
export async function hasGitIdentity(
  cwd: string,
  field: string,
  localEnv?: NodeJS.ProcessEnv,
): Promise<boolean> {
  try {
    const env = localEnv ?? process.env;
    const { stdout } = await execFileAsync('git', ['config', '--get', field], { cwd, env });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
