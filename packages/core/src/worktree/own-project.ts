/**
 * The once-up-front own-project decision for census status and reaper liveness reads
 * (T14440, round 6/7): the target is OWN only when its realpath and its
 * portable identity (`.cleo/project.json`, legacy `.cleo/project-id`) match
 * the process's resolved project — never a binding cache and never an ambient pin; both store
 * paths, both realpaths and both declared ids must agree. Any doubt
 * (unresolvable path, missing identity, mismatched ids) answers `false` —
 * fail closed, the target is treated as foreign.
 *
 * Own projects read task and worker state through normal accessors (fresh); every
 * other store is read only through the immutable, sidecar-free snapshot
 * (`openProjectTasksReadOnly`). Display callers label its WAL lag; reapers
 * reject nonempty WALs, open executors and snapshots changed during the read.
 *
 * @task T14440
 * @packageDocumentation
 */

import { lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { projectManifestPath, readPortableProjectId } from '@cleocode/paths';
import { getProjectRoot } from '../paths.js';
import { resolveDualScopeDbPath } from '../store/dual-scope-db.js';

/** The project's portable id, or `null` when absent/invalid. */
function readProjectIdentityId(projectRoot: string): string | null {
  const identity = readPortableProjectId(projectRoot);
  return identity.status === 'valid' ? identity.projectId : null;
}

/**
 * Whether the target project is the CURRENT process's own project.
 *
 * @param projectRoot - Absolute path to the project in question.
 * @param ownRoot - The current process's project root (tests inject it;
 *   default: the process's resolved project).
 * @returns True when the target IS the own project.
 * @remarks Missing or invalid project identity fails closed, even for an identical realpath.
 * @example
 * ```ts
 * const own = isOwnProjectStore('/workspace/project', '/workspace/project');
 * ```
 */
export function isOwnProjectStore(projectRoot: string, ownRoot?: string): boolean {
  try {
    const own = ownRoot ?? getProjectRoot();
    if (realpathSync(projectRoot) !== realpathSync(own)) return false;
    const ownStore = resolvePath(resolveDualScopeDbPath('project', own));
    const targetStore = resolvePath(resolveDualScopeDbPath('project', projectRoot));
    if (ownStore !== targetStore) return false;
    // Overrides and file symlinks must not redirect an own project to foreign metadata.
    const storeDirectory = lstatSync(ownStore, { throwIfNoEntry: false })
      ? dirname(realpathSync(ownStore))
      : realpathSync(dirname(ownStore));
    if (storeDirectory !== realpathSync(dirname(projectManifestPath(own)))) return false;
    const targetId = readProjectIdentityId(projectRoot);
    const ownId = readProjectIdentityId(own);
    // Strict: a missing identity on either side is any doubt → foreign.
    if (targetId === null || ownId === null || targetId !== ownId) return false;
    return true;
  } catch {
    return false;
  }
}
