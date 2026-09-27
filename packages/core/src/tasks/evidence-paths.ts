/**
 * Portable paths for `files:` and `test-run:` evidence atoms (T12476).
 *
 * A project is identified by its `project_id` (ADR-094); its path is only a
 * per-device hint. Evidence that stores an absolute path therefore breaks the
 * moment the checkout moves (another device, another OS, a rename): the
 * re-validation at `cleo complete` looks for `/mnt/projects/x/src/a.ts` and
 * reports "File removed since verify" for a file that is present, unchanged,
 * under the new root.
 *
 * Atoms therefore record, next to the path as supplied, the ABSOLUTE file
 * that was hashed (`resolvedPath`). Re-validation reads that file whatever
 * directory `cleo complete` runs from; a relative form would be re-resolved
 * against the completing process's tree and could hash a different copy. A
 * move is handled only at re-validation, when that absolute path is gone:
 * {@link rebaseLegacyEvidencePath} maps it through a vanished, recorded
 * checkout root of this project onto the live root.
 *
 * Rebasing never decides validity. It only chooses WHICH bytes to hash;
 * the caller still compares them against the sha256 captured at verify time,
 * so a rebased path pointing at different content fails exactly as a modified
 * file does.
 *
 * @task T12476
 * @epic T12468
 * @adr ADR-094
 */

import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { readPortableProjectId } from '@cleocode/paths';

/** Resolve symlinks when the path exists; otherwise return it unchanged. */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The path of `target` relative to `root`, in POSIX form, or `null` when the
 * target is not strictly inside the root.
 */
function relativeInside(root: string, target: string): string | null {
  const rel = relative(root, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/** Whether `target` resolves (through symlinks) strictly inside `root`. */
function staysInside(root: string, target: string): boolean {
  return relativeInside(realOrSelf(root), realOrSelf(target)) !== null;
}

/**
 * Split a path into segments on this platform's separators only: `/` on
 * POSIX (where `\` is an ordinary file-name character), `\` and `/` on
 * Windows.
 */
function pathSegments(path: string): string[] {
  const parts = sep === '\\' ? path.split(/[\\/]/) : path.split('/');
  return parts.filter((s) => s.length > 0);
}

/**
 * Map a legacy absolute evidence path onto the live project root.
 *
 * Rebasing happens ONLY through a recorded former checkout root of THIS
 * project that no longer exists. There is no tail-matching heuristic: a file
 * that moved or vanished inside a project that did NOT move is reported
 * removed, never re-pointed at some other file that happens to share a name
 * or a suffix.
 *
 * Returns `null` unless all of these hold:
 *
 * - the path is absolute, does not exist, and has no `.` / `..` segments;
 * - a recorded root that is gone, and neither is nor nests with a live root,
 *   contains the path;
 * - the same relative position exists under a live root, and its realpath
 *   stays inside that live root.
 *
 * The result is a candidate, not a verdict: the caller must still compare
 * the bytes it reads against the recorded sha256.
 *
 * @param path - Path as stored in the atom.
 * @param liveRoots - Live project roots (execution root first, store root second).
 * @param recordedRoots - Checkout roots recorded for this project in the registry.
 * @returns The absolute rebased path under a live root, or `null`.
 * @example
 * ```ts
 * // Project moved from /mnt/projects/app to /home/me/app:
 * rebaseLegacyEvidencePath('/mnt/projects/app/src/a.ts', ['/home/me/app'], ['/mnt/projects/app']);
 * // → '/home/me/app/src/a.ts'
 * ```
 * @task T12476
 */
export function rebaseLegacyEvidencePath(
  path: string,
  liveRoots: readonly string[],
  recordedRoots: readonly string[],
): string | null {
  if (!isAbsolute(path) || existsSync(path)) return null;
  if (pathSegments(path).some((s) => s === '.' || s === '..')) return null;

  for (const oldRoot of recordedRoots) {
    if (existsSync(oldRoot)) continue;
    // A former checkout is never nested inside (or around) the live one; a
    // "root" that overlaps a live root describes a move WITHIN the project.
    if (
      liveRoots.some(
        (live) =>
          live === oldRoot ||
          relativeInside(live, oldRoot) !== null ||
          relativeInside(oldRoot, live) !== null,
      )
    ) {
      continue;
    }
    const rel = relativeInside(oldRoot, path);
    if (rel === null) continue;
    for (const root of liveRoots) {
      const candidate = join(root, rel);
      if (existsSync(candidate) && staysInside(root, candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Former checkout roots recorded for the project at `storeRoot`.
 *
 * Read from the device-local path map (`nexus_project_paths`) by the
 * project's portable id. Best-effort: a project without a valid
 * `.cleo/project-id`, or a registry that cannot be opened, yields `[]` and
 * rebasing falls back to tail matching.
 *
 * @param storeRoot - The CLEO project root.
 * @returns Absolute checkout roots of this project other than `storeRoot`.
 * @example
 * ```ts
 * const oldRoots = await loadRecordedProjectRoots(projectRoot);
 * ```
 * @task T12476
 */
export async function loadRecordedProjectRoots(storeRoot: string): Promise<string[]> {
  const identity = readPortableProjectId(storeRoot);
  if (identity.status !== 'valid') return [];
  try {
    const { listProjectCheckouts } = await import('../nexus/path-map.js');
    const checkouts = await listProjectCheckouts(identity.projectId);
    return checkouts.map((c) => c.projectPath).filter((p) => p !== storeRoot);
  } catch {
    return [];
  }
}
