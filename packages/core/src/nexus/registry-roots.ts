/**
 * Default search roots derived from the live nexus registry (T12476).
 *
 * A project is identified by its `project_id` (ADR-094); its path is a
 * per-device hint. A hardcoded search root such as `/mnt/projects` is the
 * layout of ONE past device: after a move it names a directory that does not
 * exist, so a scan silently walks nothing and a fleet survey reports an empty
 * fleet. The registry already knows where this device's projects live — the
 * parent directories of their recorded checkouts are the roots to search.
 *
 * @task T12476
 * @epic T12468
 * @adr ADR-094
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

/** Whether `p` is an existing directory. */
function isDirectory(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Parent directories of the given project paths that exist on this device.
 *
 * Paths whose checkout is gone are skipped (a vanished checkout says nothing
 * about where projects live now), as is a filesystem root — walking `/` is
 * never a sensible default. The result is de-duplicated and sorted so callers
 * produce deterministic output.
 *
 * @param projectPaths - Absolute project checkout paths.
 * @returns Existing parent directories, unique and sorted.
 * @example
 * ```ts
 * parentRootsOf(['/home/me/code/a', '/home/me/code/b', '/srv/c']);
 * // → ['/home/me/code', '/srv']  (when all three exist)
 * ```
 * @task T12476
 */
export function parentRootsOf(projectPaths: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const projectPath of projectPaths) {
    if (!path.isAbsolute(projectPath) || !isDirectory(projectPath)) continue;
    const parent = path.dirname(path.resolve(projectPath));
    if (parent === path.parse(parent).root) continue;
    if (isDirectory(parent)) roots.add(parent);
  }
  return [...roots].sort();
}

/**
 * Parent directories of every live project checkout in the nexus registry.
 *
 * Best-effort: an unreadable registry yields `[]`, and callers choose their
 * own fallback.
 *
 * @returns Existing parent directories of registered projects, sorted.
 * @example
 * ```ts
 * const roots = await listRegistryParentRoots();
 * ```
 * @task T12476
 */
export async function listRegistryParentRoots(): Promise<string[]> {
  try {
    const { nexusList } = await import('./registry.js');
    const projects = await nexusList();
    return parentRootsOf(projects.map((p) => p.path));
  } catch {
    return [];
  }
}
