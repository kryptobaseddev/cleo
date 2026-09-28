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
 * A tombstone is a plain file, so it can be committed, copied or forged. It is
 * honoured ONLY when it is provably current ({@link readValidProjectTombstone});
 * anything else is ignored with a `W_TOMBSTONE_IGNORED` warning, so a stray or
 * committed tombstone can never brick a clone.
 *
 * Leaf module: imported by project-scope resolution and the store guard.
 *
 * @task T12558
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectMovedTombstone } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { pushWarning } from '@cleocode/lafs';
import { readDeclaredProjectIdentity } from '@cleocode/paths';
import { CleoError } from './errors.js';

/** File name of the tombstone, directly in the old project root. */
export const PROJECT_TOMBSTONE_FILE = '.cleo-moved.json';

/**
 * Whether project-root resolution refuses at a tombstoned root. The CLI turns
 * this off for `cleo doctor *`, which must be able to inspect a relocated
 * project. The store guard ignores it: an empty store is never wanted.
 */
let _resolutionRefusal = true;

/**
 * Enable or disable the `E_PROJECT_MOVED` refusal in project-root resolution.
 *
 * @param enabled - `false` lets resolution fall through as if no tombstone
 *   existed (diagnostic commands only).
 *
 * @example
 * ```ts
 * setProjectMovedRefusal(false); // `cleo doctor …`
 * ```
 */
export function setProjectMovedRefusal(enabled: boolean): void {
  _resolutionRefusal = enabled;
}

/**
 * Whether project-root resolution currently refuses at a tombstoned root.
 *
 * @returns `true` unless {@link setProjectMovedRefusal} turned it off.
 */
export function isProjectMovedRefusalEnabled(): boolean {
  return _resolutionRefusal;
}

/**
 * Read the tombstone at `root` as written, without validating it.
 *
 * @param root - Directory that may once have held a project.
 * @returns The tombstone, or `null` when absent or unparseable.
 *
 * @example
 * ```ts
 * const raw = readProjectTombstone('/work/mono');
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
 * Why a present tombstone is not honoured, or `null` when it is valid:
 * the root's own declared id (when it declares one) and the project at
 * `movedTo` must both be the tombstone's project.
 */
function tombstoneDefect(root: string, tombstone: ProjectMovedTombstone): string | null {
  const here = readDeclaredProjectIdentity(root);
  if (here && here.projectId !== tombstone.projectId) {
    return `it names project ${tombstone.projectId} but ${root} declares ${here.projectId}`;
  }
  if (!existsSync(join(tombstone.movedTo, '.cleo'))) {
    return `${tombstone.movedTo} holds no .cleo/`;
  }
  const there = readDeclaredProjectIdentity(tombstone.movedTo);
  if (there?.projectId !== tombstone.projectId) {
    return `${tombstone.movedTo} declares ${there?.projectId ?? 'no project id'}, not ${tombstone.projectId}`;
  }
  return null;
}

/**
 * Read the tombstone at `root` and return it only when it is provably current.
 * A present but invalid tombstone (committed to git, copied with a clone,
 * stale after the project moved again, or forged) is ignored and reported as
 * a `W_TOMBSTONE_IGNORED` warning.
 *
 * @param root - Directory that may once have held a project.
 * @returns The tombstone when valid, else `null`.
 *
 * @example
 * ```ts
 * const moved = readValidProjectTombstone(root);
 * if (moved) throw projectMovedError(root, moved);
 * ```
 */
export function readValidProjectTombstone(root: string): ProjectMovedTombstone | null {
  const path = join(root, PROJECT_TOMBSTONE_FILE);
  if (!existsSync(path)) return null;
  const tombstone = readProjectTombstone(root);
  const defect = tombstone ? tombstoneDefect(root, tombstone) : 'it is not valid JSON';
  if (defect === null) return tombstone;
  pushWarning({
    code: 'W_TOMBSTONE_IGNORED',
    message: `Ignoring ${path}: ${defect}. Delete it if the project no longer moved from here.`,
    severity: 'warn',
  });
  return null;
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
 * The `E_PROJECT_MOVED` refusal for a command that resolved to `root`.
 *
 * @param root - The old root the command resolved to.
 * @param tombstone - Where the project went.
 * @param from - Directory the command started in, when it is below `root`
 *   (a would-be new project there gets its own remedy).
 * @returns A {@link CleoError} with exit `PROJECT_MOVED`, a `cd` fix and
 *   `details.movedTo`.
 *
 * @example
 * ```ts
 * throw projectMovedError(root, tombstone);
 * ```
 */
export function projectMovedError(
  root: string,
  tombstone: Pick<ProjectMovedTombstone, 'projectId' | 'movedTo'>,
  from?: string,
): CleoError {
  const below = from && from !== root ? from : null;
  const fix = below
    ? `cd "${tombstone.movedTo}" to work on project ${tombstone.projectId}. To start a NEW project in ${below}, run \`cleo init --here\` there.`
    : `cd "${tombstone.movedTo}" and run the command there. To start a NEW project at ${root}, delete ${join(root, PROJECT_TOMBSTONE_FILE)} and run \`cleo init\`.`;
  return new CleoError(
    ExitCode.PROJECT_MOVED,
    `E_PROJECT_MOVED: project ${tombstone.projectId} moved from ${root} to ${tombstone.movedTo}; refusing to create an empty store at the old root`,
    {
      fix,
      details: {
        field: 'projectRoot',
        projectId: tombstone.projectId,
        movedFrom: root,
        movedTo: tombstone.movedTo,
      },
    },
  );
}
