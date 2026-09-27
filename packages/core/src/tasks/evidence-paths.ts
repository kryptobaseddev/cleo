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
 * Two halves:
 *
 * - {@link toPortableEvidencePath} — NEW atoms persist a path relative to the
 *   root it was found under. A path outside every project root (for example a
 *   report in the system temp directory) is kept absolute, because no
 *   relative form of it would resolve anywhere.
 * - {@link rebaseLegacyEvidencePath} — LEGACY absolute atoms whose path no
 *   longer exists are mapped onto the live root, either through a recorded
 *   former checkout root or by finding the path's relative tail under the
 *   live root.
 *
 * Neither half decides validity. Rebasing only chooses WHICH bytes to hash;
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

/**
 * Convert an evidence path to the form an atom should persist.
 *
 * A relative path is returned unchanged. An absolute path inside one of
 * `roots` becomes relative to the FIRST such root. Callers pass exactly the
 * root the atom kind re-validates against, so the stored form names one file. Symlinked roots are
 * compared both literally and through `realpath`, so `/tmp/x` and
 * `/private/tmp/x` on macOS agree. An absolute path outside every root is
 * returned unchanged.
 *
 * @param path - Path as supplied in the evidence string.
 * @param roots - Candidate project roots, in resolution order.
 * @returns The portable (root-relative) path, or `path` when none applies.
 * @example
 * ```ts
 * toPortableEvidencePath('/home/me/app/src/a.ts', ['/home/me/app']); // 'src/a.ts'
 * toPortableEvidencePath('src/a.ts', ['/home/me/app']);              // 'src/a.ts'
 * toPortableEvidencePath('/tmp/report.json', ['/home/me/app']);      // '/tmp/report.json'
 * ```
 * @task T12476
 */
export function toPortableEvidencePath(path: string, roots: readonly string[]): string {
  if (!isAbsolute(path)) return path;
  const targets = [path, realOrSelf(path)];
  for (const root of roots) {
    for (const r of [root, realOrSelf(root)]) {
      for (const t of targets) {
        const rel = relativeInside(r, t);
        if (rel !== null) return rel;
      }
    }
  }
  return path;
}

/** Whether `target` resolves (through symlinks) strictly inside `root`. */
function staysInside(root: string, target: string): boolean {
  return relativeInside(realOrSelf(root), realOrSelf(target)) !== null;
}

/**
 * Map a legacy absolute evidence path onto the live project root.
 *
 * Returns `null` unless ALL of these hold, so a rebase can never widen what a
 * path could mean:
 *
 * - the path is absolute, does not exist, and has no `.` / `..` segments;
 * - the project root the path was recorded under no longer exists (a file
 *   deleted from a project that did NOT move is reported removed, never
 *   re-pointed at some other file);
 * - the rebased file exists and its realpath stays inside the live root.
 *
 * Candidates, in order:
 *
 * 1. A recorded former checkout root of this project that contains the path
 *    and is itself gone — the tail is exactly the path's position under it.
 * 2. Otherwise the LONGEST tail of at least two segments whose implied former
 *    root (the path minus the tail) is gone and which exists under a live
 *    root. Two segments minimum keeps a bare file name (`LICENSE`) from
 *    matching whatever happens to share it.
 *
 * The result is a candidate, not a verdict: the caller must still compare
 * the bytes it reads against the recorded sha256.
 *
 * @param path - Path as stored in the legacy atom.
 * @param liveRoots - Live project roots (execution root first, store root second).
 * @param recordedRoots - Former checkout roots recorded for this project.
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
  recordedRoots: readonly string[] = [],
): string | null {
  if (!isAbsolute(path) || existsSync(path)) return null;
  const segments = path.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.some((s) => s === '.' || s === '..')) return null;

  const firstExistingUnderLive = (tail: string): string | null => {
    for (const root of liveRoots) {
      const candidate = join(root, tail);
      if (existsSync(candidate) && staysInside(root, candidate)) return candidate;
    }
    return null;
  };

  for (const oldRoot of recordedRoots) {
    if (liveRoots.includes(oldRoot) || existsSync(oldRoot)) continue;
    const rel = relativeInside(oldRoot, path);
    if (rel === null) continue;
    const hit = firstExistingUnderLive(rel);
    if (hit !== null) return hit;
  }

  // start >= 1: the implied former root is never the filesystem root, which
  // always exists. Tails keep at least two segments.
  for (let start = 1; start <= segments.length - 2; start++) {
    const impliedRoot = `/${segments.slice(0, start).join('/')}`;
    if (existsSync(impliedRoot)) continue;
    const hit = firstExistingUnderLive(segments.slice(start).join('/'));
    if (hit !== null) return hit;
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
