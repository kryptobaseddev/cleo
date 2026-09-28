/**
 * Relocated-store guard — never CREATE an empty project store where a project
 * used to live (T12558).
 *
 * After `cleo project reroot` the old root has no `.cleo/`. A command run there,
 * or after `git checkout -- .` restores the tracked `.cleo/project-id`, would
 * otherwise open `<oldRoot>/.cleo/cleo.db` fresh: an empty store, every read
 * answering "nothing" with `success: true`. This guard runs on the physical
 * open, only when the project store file does not exist yet, and refuses with
 * `E_PROJECT_MOVED` when either:
 *
 * - the old root carries the reroot tombstone (`.cleo-moved.json`), or
 * - the declared id's location at this path is `missing` in the registry and
 *   the registry row names another path that exists — the project is live
 *   somewhere else on this device.
 *
 * A `candidate` location (a clone that declares a registered id) is NOT refused:
 * a clone legitimately starts with an empty store of its own (T12470).
 *
 * @task T12558
 */

import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ExitCode } from '@cleocode/contracts';
import { readPortableProjectId } from '@cleocode/paths';
import { CleoError } from '../errors.js';
import { projectMovedMessage, readProjectTombstone } from '../project-tombstone.js';

const _require = createRequire(import.meta.url);

/** `realpath` when it resolves, else the path unchanged. */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Where `projectId` is live, when the registry marks `root` as a `missing`
 * location of it and names another existing path. Read-only; any failure to
 * read the registry answers `null` (the guard only refuses on proof).
 */
function liveElsewhere(globalDbPath: string, projectId: string, root: string): string | null {
  const { DatabaseSync: Ctor } = _require('node:sqlite') as {
    DatabaseSync: new (path: string, opts: { readOnly: boolean }) => DatabaseSync;
  };
  let db: DatabaseSync | null = null;
  try {
    db = new Ctor(globalDbPath, { readOnly: true }); // db-open-allowed: read-only registry probe before a project store is created
    const paths = new Set([root, real(root)]);
    const states = db
      .prepare('SELECT path, state FROM nexus_project_locations WHERE project_id = ?')
      .all(projectId) as Array<{ path: string; state: string }>;
    if (!states.some((row) => paths.has(row.path) && row.state === 'missing')) return null;
    const row = db
      .prepare(
        'SELECT project_path AS projectPath FROM nexus_project_registry WHERE project_id = ?',
      )
      .get(projectId) as { projectPath?: string } | undefined;
    const live = row?.projectPath;
    return live && !paths.has(live) && existsSync(live) ? live : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Refuse to create a project store where a project used to live.
 *
 * @param dbPath - The project-scope store path about to be opened.
 * @param globalDbPath - The global registry store path.
 * @throws CleoError (`E_PROJECT_MOVED`, exit NOT_FOUND) naming the new root.
 *
 * @example
 * ```ts
 * assertStoreNotRelocated('/work/mono/.cleo/cleo.db', '/home/u/.local/share/cleo/cleo.db');
 * ```
 */
export function assertStoreNotRelocated(dbPath: string, globalDbPath: string): void {
  if (basename(dbPath) !== 'cleo.db' || basename(dirname(dbPath)) !== '.cleo') return;
  if (existsSync(dbPath)) return;
  const root = dirname(dirname(dbPath));

  const tombstone = readProjectTombstone(root);
  const declared = readPortableProjectId(root);
  const movedTo =
    tombstone?.movedTo ??
    (declared.status === 'valid' && existsSync(globalDbPath) && globalDbPath !== dbPath
      ? liveElsewhere(globalDbPath, declared.projectId, root)
      : null);
  if (!movedTo) return;

  const projectId =
    tombstone?.projectId ?? (declared.status === 'valid' ? declared.projectId : 'unknown');
  const moved = projectMovedMessage(root, { projectId, movedTo });
  throw new CleoError(ExitCode.NOT_FOUND, moved.message, {
    fix: moved.fix,
    details: { field: 'projectRoot', code: 'E_PROJECT_MOVED', movedTo },
  });
}
