/**
 * Relocation tombstone — `<oldRoot>/.cleo-moved.json` (T12558).
 *
 * `cleo project reroot` renames `.cleo/` out of the old root. Without a marker,
 * the next command run there (or after `git checkout -- .` restores the tracked
 * `.cleo/` files) would resolve the old root as a project and silently create
 * an EMPTY store: every read then answers "no tasks" with `success: true`. The
 * tombstone lets project resolution refuse with `E_PROJECT_MOVED` and name the
 * new root instead.
 *
 * Leaf module: imported by project-scope resolution and the store guard, so it
 * depends on nothing in core.
 *
 * @task T12558
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectMovedTombstone } from '@cleocode/contracts';

/** File name of the tombstone, directly in the old project root. */
export const PROJECT_TOMBSTONE_FILE = '.cleo-moved.json';

/**
 * Read the tombstone at `root`.
 *
 * @param root - Directory that may once have held a project.
 * @returns The tombstone, or `null` when absent or unparseable.
 *
 * @example
 * ```ts
 * const moved = readProjectTombstone('/work/mono');
 * if (moved) console.log(`moved to ${moved.movedTo}`);
 * ```
 */
export function readProjectTombstone(root: string): ProjectMovedTombstone | null {
  const path = join(root, PROJECT_TOMBSTONE_FILE);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const { projectId, movedTo, at } = parsed as Record<string, unknown>;
    if (typeof projectId !== 'string' || typeof movedTo !== 'string' || typeof at !== 'string') {
      return null;
    }
    return { projectId, movedTo, at };
  } catch {
    return null;
  }
}

/**
 * Write the tombstone at `root` atomically (tmp + rename).
 *
 * @param root - The old project root.
 * @param tombstone - Where the project went.
 * @returns Absolute path of the tombstone.
 *
 * @example
 * ```ts
 * writeProjectTombstone(oldRoot, { projectId, movedTo: child, at: new Date().toISOString() });
 * ```
 */
export function writeProjectTombstone(root: string, tombstone: ProjectMovedTombstone): string {
  const path = join(root, PROJECT_TOMBSTONE_FILE);
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, `${JSON.stringify(tombstone, null, 2)}\n`);
  renameSync(temp, path);
  return path;
}

/**
 * Message and fix for a command run where a project used to be.
 *
 * @param root - The old root the command resolved to.
 * @param tombstone - Where the project went.
 * @returns `E_PROJECT_MOVED` message and remedy.
 */
export function projectMovedMessage(
  root: string,
  tombstone: Pick<ProjectMovedTombstone, 'projectId' | 'movedTo'>,
): { message: string; fix: string } {
  return {
    message: `E_PROJECT_MOVED: project ${tombstone.projectId} moved from ${root} to ${tombstone.movedTo}; refusing to create an empty store at the old root`,
    fix: `cd "${tombstone.movedTo}" and run the command there. To start a NEW project at ${root}, delete ${join(root, PROJECT_TOMBSTONE_FILE)} and run \`cleo init\`.`,
  };
}
