/**
 * Portable storage of graph source roots (T12474).
 *
 * `_nexus_meta` used to persist the absolute project root, source root and
 * per-repository paths of the machine that last ran `cleo nexus analyze`. The
 * graph database lives inside the project's own `.cleo/`, so after the project
 * moved (another mount, another machine, a copied checkout) every reader walked
 * the OLD path: `cleo nexus status` failed with `scandir ENOENT`, and the
 * ownership fingerprint changed, forcing a full rebuild.
 *
 * Paths are now stored relative to the canonical project root and resolved
 * against the LIVE project root on read. A legacy absolute record is rebased
 * onto the live root when every path it holds lies inside the project root it
 * recorded (a moved project); a record whose paths are inconsistent is returned
 * unchanged, so a genuinely foreign binding still fails its ownership checks.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 *
 * @task T12474
 * @module nexus/stored-roots
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { GraphIndexAssessment } from '@cleocode/contracts';

/** Stored form of the project root itself. */
const PROJECT_ROOT_TOKEN = '.';

/**
 * Canonicalize a live project root the way source-root observation does.
 * @param projectRoot - Live project root, possibly relative or through a symlink.
 * @returns Its real path, or the resolved path when it does not exist.
 */
export function canonicalProjectRoot(projectRoot: string): string {
  const resolved = resolve(projectRoot);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Express an absolute path relative to the project root, with `/` separators.
 * @param projectRoot - Canonical project root.
 * @param path - Absolute path to store.
 * @returns `'.'` for the root itself, otherwise the project-relative path.
 * @example
 * ```ts
 * toStoredPath('/repo', '/repo/app'); // 'app'
 * ```
 */
export function toStoredPath(projectRoot: string, path: string): string {
  if (!isAbsolute(path)) return path;
  const local = relative(projectRoot, path);
  if (local === '') return PROJECT_ROOT_TOKEN;
  // A different Windows drive cannot be expressed relatively; keep it verbatim.
  if (isAbsolute(local)) return path;
  return local.split(sep).join('/');
}

/**
 * Resolve a stored path against the live project root.
 * @param projectRoot - Canonical live project root.
 * @param stored - Stored path; relative since T12474, absolute before it.
 * @param legacyRoot - Project root a legacy absolute record was written under.
 * @returns The absolute path in the live project.
 */
export function fromStoredPath(projectRoot: string, stored: string, legacyRoot?: string): string {
  if (!isAbsolute(stored)) return resolve(projectRoot, stored);
  if (legacyRoot && isWithin(legacyRoot, stored))
    return resolve(projectRoot, relative(legacyRoot, stored));
  return stored;
}

/** Whether `path` is `root` or lies beneath it. */
export function isWithin(root: string, path: string): boolean {
  const local = relative(root, path);
  return local === '' || (!isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`));
}

/** Path fields of one observed root, stored or live. */
export interface RootPathFields {
  /** Requested location. */
  readonly requestedPath: string;
  /** Real location, when observed. */
  readonly canonicalPath: string | null;
}

/** Path fields of a source-root observation, stored or live. */
export interface SourceRootPathFields<R extends RootPathFields = RootPathFields> {
  /** Parent project location. */
  readonly projectRoot: string;
  /** Graph source location. */
  readonly sourceRoot: string;
  /** Source root followed by explicitly included repositories. */
  readonly roots: readonly R[];
}

/**
 * Every path a source-root observation holds, for consistency checks.
 * @param roots - Stored observation.
 * @returns Project root, source root and each root's requested/canonical path.
 */
function observationPaths(roots: SourceRootPathFields): string[] {
  return [
    roots.projectRoot,
    roots.sourceRoot,
    ...roots.roots.flatMap((root) =>
      root.canonicalPath === null ? [root.requestedPath] : [root.requestedPath, root.canonicalPath],
    ),
  ];
}

/**
 * Map every path of a source-root observation, keeping all other fields.
 * @param roots - Observation to rewrite.
 * @param map - Path transform.
 * @returns A copy with every path rewritten.
 */
function mapRootPaths<R extends RootPathFields, S extends SourceRootPathFields<R>>(
  roots: S,
  map: (path: string) => string,
): S {
  return {
    ...roots,
    projectRoot: map(roots.projectRoot),
    sourceRoot: map(roots.sourceRoot),
    roots: roots.roots.map((root) => ({
      ...root,
      requestedPath: map(root.requestedPath),
      canonicalPath: root.canonicalPath === null ? null : map(root.canonicalPath),
    })),
  };
}

/**
 * Project-relative form of an observation — no absolute root survives.
 *
 * Used both for storage and for ownership fingerprints, so a project that moved
 * keeps the same fingerprint and its graph stays incrementally reusable.
 *
 * @param roots - Observation with absolute paths.
 * @returns The same observation with every path relative to its project root.
 */
export function portableSourceRoots<S extends SourceRootPathFields>(roots: S): S {
  const base = roots.projectRoot;
  if (!isAbsolute(base)) return roots;
  return mapRootPaths(roots, (path) => toStoredPath(base, path));
}

/**
 * Encode an assessment for `_nexus_meta`: every root path project-relative.
 *
 * An assessment without source-root provenance has no recorded project root to
 * be relative to and is stored unchanged; every analysis records provenance.
 *
 * @param assessment - Assessment with absolute paths, as held in memory.
 * @returns The stored form.
 */
export function encodeStoredAssessment(assessment: GraphIndexAssessment): GraphIndexAssessment {
  const roots = assessment.sourceRoots;
  if (!roots || !isAbsolute(roots.projectRoot)) return assessment;
  return {
    ...assessment,
    sourceRoot: toStoredPath(roots.projectRoot, assessment.sourceRoot),
    sourceRoots: portableSourceRoots(roots),
  };
}

/** Shape of a stored assessment's path fields before validation. */
export interface StoredAssessmentRoots {
  /** Stored source root. */
  readonly sourceRoot: string;
  /** Stored source-root observation, when recorded. */
  readonly sourceRoots?: SourceRootPathFields;
}

/**
 * Resolve a stored assessment's paths against the live project root.
 *
 * Relative paths (T12474+) resolve directly. A legacy absolute record is
 * rebased only when all of its paths sit inside the project root it recorded —
 * the signature of a moved project. An inconsistent record is returned as
 * stored so ownership validation still rejects it.
 *
 * @param stored - Parsed stored value.
 * @param liveProjectRoot - Project the database was opened for.
 * @returns The value with absolute, live paths.
 */
export function decodeStoredAssessment<T extends StoredAssessmentRoots>(
  stored: T,
  liveProjectRoot: string,
): T {
  const roots = stored.sourceRoots;
  if (!roots) return stored;
  const base = canonicalProjectRoot(liveProjectRoot);
  if (!isAbsolute(roots.projectRoot)) {
    return {
      ...stored,
      sourceRoot: fromStoredPath(base, stored.sourceRoot),
      sourceRoots: mapRootPaths(roots, (path) => fromStoredPath(base, path)),
    };
  }
  const legacyRoot = roots.projectRoot;
  if (legacyRoot === base) return stored;
  const consistent = [stored.sourceRoot, ...observationPaths(roots)].every((path) =>
    isWithin(legacyRoot, path),
  );
  if (!consistent) return stored;
  return {
    ...stored,
    sourceRoot: fromStoredPath(base, stored.sourceRoot, legacyRoot),
    sourceRoots: mapRootPaths(roots, (path) => fromStoredPath(base, path, legacyRoot)),
  };
}

/**
 * Command that proves or repairs the live project identity; the remedy when a
 * stored graph names a different project id (T12659).
 */
export const NEXUS_IDENTITY_REMEDY_COMMAND = 'cleo doctor project-identity';

/**
 * Exact command that re-binds a moved project's graph to its live root: a full
 * rebuild at that root. Accepted only when the stored project id equals the
 * live, verified one (T12659).
 *
 * @param projectRoot - Canonical live project root.
 * @returns The runnable command, with the root quoted.
 * @example
 * ```ts
 * nexusRebindCommand('/Users/me/app'); // 'cleo nexus analyze "/Users/me/app" --full'
 * ```
 */
export function nexusRebindCommand(projectRoot: string): string {
  return `cleo nexus analyze ${JSON.stringify(projectRoot)} --full`;
}

/** Recorded vs live ownership of a stored graph. */
export interface GraphOwnershipMismatch {
  /** Project root the stored graph was built under. */
  readonly recordedRoot: string;
  /** Project id the stored graph was built for. */
  readonly recordedProjectId: string;
  /** Canonical live project root. */
  readonly liveRoot: string;
  /** Verified live project id, when it could be read. */
  readonly liveProjectId: string | undefined;
}

/**
 * The single remedy for a stored graph whose ownership differs from the live
 * binding: a `--full` re-bind when the project ids match (the project moved),
 * otherwise the identity check (the graph may belong to another project).
 *
 * @param mismatch - Recorded vs live ownership.
 * @returns The exact command to run.
 */
export function graphOwnershipRemedy(mismatch: GraphOwnershipMismatch): string {
  return mismatch.liveProjectId !== undefined &&
    mismatch.liveProjectId === mismatch.recordedProjectId
    ? nexusRebindCommand(mismatch.liveRoot)
    : NEXUS_IDENTITY_REMEDY_COMMAND;
}

/**
 * One-line detail naming the recorded and live root and id plus the remedy.
 *
 * @param mismatch - Recorded vs live ownership.
 * @returns Human-readable detail for an ownership error.
 */
export function describeGraphOwnershipMismatch(mismatch: GraphOwnershipMismatch): string {
  const sameId =
    mismatch.liveProjectId !== undefined && mismatch.liveProjectId === mismatch.recordedProjectId;
  const why = sameId
    ? 'Same project id: the project moved. Re-bind the graph to the live root with a full rebuild'
    : 'Different project id: this graph may belong to another project. Check the live identity';
  return (
    `recorded root ${mismatch.recordedRoot} (project ${mismatch.recordedProjectId}), ` +
    `live root ${mismatch.liveRoot} (project ${mismatch.liveProjectId ?? 'unknown'}). ` +
    `${why}: ${graphOwnershipRemedy(mismatch)}`
  );
}
