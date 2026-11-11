/**
 * The once-up-front own-project decision for the census's status reads
 * (T14440, round 6/7): the target is OWN only when its realpath and its
 * `.cleo/project.json` identity match the current process's resolved
 * project — never a binding cache and never an ambient pin; both store
 * paths, both realpaths and both declared ids must agree. Any doubt
 * (unresolvable path, missing identity, mismatched ids) answers `false` —
 * fail closed, the target is treated as foreign.
 *
 * Own projects read task status through the normal accessor (fresh); every
 * other store is read only through the immutable, sidecar-free snapshot
 * (`openProjectTasksReadOnly`), whose output is labelled as a display
 * snapshot that may lag uncommitted writes. No removal decision consumes
 * snapshot reads.
 *
 * @task T14440
 */

import { readFileSync, realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { getProjectRoot } from '../paths.js';
import { resolveDualScopeDbPath } from '../store/dual-scope-db.js';

/** The write-once `.cleo/project.json` id of a project, or `null` when absent/unreadable. */
function readProjectIdentityId(projectRoot: string): string | null {
  try {
    const parsed = JSON.parse(
      readFileSync(
        resolvePath(resolveDualScopeDbPath('project', projectRoot), '..', 'project.json'),
        'utf-8',
      ),
    ) as { id?: string };
    return typeof parsed.id === 'string' ? parsed.id : null;
  } catch {
    return null;
  }
}

/**
 * Whether the target project is the CURRENT process's own project.
 *
 * @param projectRoot - Absolute path to the project in question.
 * @param ownRoot - The current process's project root (tests inject it;
 *   default: the process's resolved project).
 * @returns True when the target IS the own project.
 */
export function isOwnProjectStore(projectRoot: string, ownRoot?: string): boolean {
  try {
    const own = ownRoot ?? getProjectRoot();
    const ownStore = resolvePath(resolveDualScopeDbPath('project', own));
    const targetStore = resolvePath(resolveDualScopeDbPath('project', projectRoot));
    if (ownStore !== targetStore) return false;
    if (realpathSync(projectRoot) !== realpathSync(own)) return false;
    const targetId = readProjectIdentityId(projectRoot);
    const ownId = readProjectIdentityId(own);
    // Strict: a missing identity on either side is any doubt → foreign.
    if (targetId === null || ownId === null || targetId !== ownId) return false;
    return true;
  } catch {
    return false;
  }
}
