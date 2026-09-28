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
import { readDeclaredProjectIdentity, readPortableProjectId } from '@cleocode/paths';
import {
  isStrictlyInsideDir,
  type ProjectMovedEvidence,
  projectMovedError,
  readValidProjectTombstone,
} from '../project-tombstone.js';

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
 * location of it and the live path is STRICTLY INSIDE `root` — reroot
 * geometry. A `move` destination is never inside its source, so a fresh clone
 * into a directory a project was MOVED away from is a normal candidate, not a
 * refusal (T12558 round 3). Read-only; any failure to read the registry
 * answers `null` (the guard only refuses on proof).
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
    if (!live || paths.has(live) || !existsSync(live)) return null;
    if (!isStrictlyInsideDir(root, live)) return null;
    // Proof, not a pointer: the live path must still hold this project.
    return readDeclaredProjectIdentity(live)?.projectId === projectId ? live : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** A root a project was relocated away from, and the proof. */
export interface RelocatedRoot {
  /** The relocated project. */
  projectId: string;
  /** Its live root now. */
  movedTo: string;
  /** What proved it: a valid tombstone, or the registry (reroot geometry). */
  via: ProjectMovedEvidence;
}

/**
 * Detect whether `root` is a directory a project was rerooted away from.
 * Read-only.
 *
 * @param root - Candidate project root.
 * @param globalDbPath - The global registry store path.
 * @returns The relocation, or `null` when `root` may hold a store.
 *
 * @example
 * ```ts
 * const moved = detectRelocatedRoot('/work/mono', globalDbPath);
 * ```
 */
export function detectRelocatedRoot(root: string, globalDbPath: string): RelocatedRoot | null {
  const tombstone = readValidProjectTombstone(root);
  if (tombstone)
    return { projectId: tombstone.projectId, movedTo: tombstone.movedTo, via: 'tombstone' };
  const declared = readPortableProjectId(root);
  if (declared.status !== 'valid' || !existsSync(globalDbPath)) return null;
  const movedTo = liveElsewhere(globalDbPath, declared.projectId, root);
  return movedTo ? { projectId: declared.projectId, movedTo, via: 'registry' } : null;
}

/** Roots whose owner explicitly chose a new store anyway (`cleo init --here`). */
const _adopted = new Set<string>();

/**
 * Let THIS process create a store at `root` even though it is a relocated
 * root — the explicit, audited opt-out behind `cleo init --here`.
 *
 * @param root - The root the operator adopted.
 *
 * @example
 * ```ts
 * allowStoreAtRelocatedRoot('/work/mono');
 * ```
 */
export function allowStoreAtRelocatedRoot(root: string): void {
  _adopted.add(root);
  _adopted.add(real(root));
}

/**
 * Refuse to create a project store where a project used to live.
 *
 * @param dbPath - The project-scope store path about to be opened.
 * @param globalDbPath - The global registry store path.
 * @throws CleoError (`E_PROJECT_MOVED`, exit PROJECT_MOVED) naming the new root.
 *
 * @example
 * ```ts
 * assertStoreNotRelocated('/work/mono/.cleo/cleo.db', '/home/u/.local/share/cleo/cleo.db');
 * ```
 */
export function assertStoreNotRelocated(dbPath: string, globalDbPath: string): void {
  if (basename(dbPath) !== 'cleo.db' || basename(dirname(dbPath)) !== '.cleo') return;
  if (existsSync(dbPath) || globalDbPath === dbPath) return;
  const root = dirname(dirname(dbPath));
  if (_adopted.has(root)) return;
  const moved = detectRelocatedRoot(root, globalDbPath);
  if (moved) throw projectMovedError(root, moved, undefined, moved.via);
}
