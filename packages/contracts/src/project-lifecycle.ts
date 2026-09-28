/**
 * Project relocation contracts — `cleo project move` and `cleo project reroot`
 * (T12552 · T12558).
 *
 * Both relocations RENAME; nothing is copied, so the live database, its WAL
 * sidecars and `.git` move atomically and there is never a second copy to
 * diverge from the first.
 *
 * - `move` renames the whole project root to a new path on the SAME device.
 *   A cross-device target is refused (`E_CROSS_DEVICE`).
 * - `reroot` renames `.cleo/` (and CLEO's own top-level files) into a child
 *   directory of the current root and leaves a {@link ProjectMovedTombstone}.
 *
 * Both support a dry run that returns a {@link ProjectRelocationPlan} and
 * touches neither the disk nor the registry.
 *
 * @task T12552
 * @task T12558
 */

/** Which relocation a plan or result describes. */
export type ProjectRelocationKind = 'move' | 'reroot';

/** The registry change a relocation makes. */
export interface ProjectRelocationRegistryAction {
  /**
   * `rebind` points the project's registry row at the target (registering the
   * project first when it has no row). Always explicit — never inferred.
   */
  action: 'rebind';
  /** Location that becomes `live`. */
  livePath: string;
  /** Location demoted to `missing` — it no longer holds the project. */
  demotedPath: string;
  /** Always `missing`: after a rename the old location holds no store. */
  demotedState: 'missing';
  /** Always `carried`: the checkout nonce moves with the renamed `.cleo/`. */
  nonce: 'carried';
}

/** A top-level entry a relocation leaves behind, and why. */
export interface ProjectRelocationExclusion {
  /** Entry name, relative to the source root. */
  entry: string;
  /** Why it is not moved. */
  reason: string;
}

/**
 * What a relocation WOULD do, returned by a dry run. Producing it writes
 * nothing to disk and opens no database.
 */
export interface ProjectRelocationPlan {
  /** Discriminant: always `true` for a plan. */
  dryRun: true;
  /** Which relocation. */
  kind: ProjectRelocationKind;
  /** Stable project id — preserved by every relocation. */
  projectId: string;
  /** Current absolute project root. */
  source: string;
  /** Absolute project root after the relocation. */
  target: string;
  /** Always `rename`: relocations never copy. */
  transfer: 'rename';
  /**
   * Entries renamed, relative to `source`. `move` renames the root itself
   * (`['.']`); `reroot` lists each top-level entry it moves into `target`.
   */
  entries: string[];
  /** Top-level entries left behind, with the reason (reroot only). */
  excluded: ProjectRelocationExclusion[];
  /** Absolute paths of files the relocation writes. */
  writes: string[];
  /** The registry change. */
  registry: ProjectRelocationRegistryAction;
  /** Where the required pre-change checkpoint is written. */
  checkpoint: string;
  /**
   * Conditions that make the real run refuse (`E_CROSS_DEVICE`, CLEO or git
   * worktrees). Empty when none were found.
   */
  blockers: string[];
  /** Checks only the real run performs (they would open a database). */
  deferredChecks: string[];
}

/** Result of a completed `cleo project move`. */
export interface MoveProjectResult {
  /** Discriminant: always `false` for a completed move. */
  dryRun: false;
  /** Stable project id — unchanged. */
  projectId: string;
  /** The old absolute project root (no longer exists). */
  oldPath: string;
  /** The new absolute project root. */
  newPath: string;
  /** Id of the checkpoint taken before the rename. */
  checkpointId: string;
  /** Directory holding the checkpoint, outside the moved tree. */
  checkpointPath: string;
  /** Registry status after the rebind. */
  reconcileStatus: 'ok' | 'path_updated' | 'auto_registered' | 'candidate';
}

/** Result of a completed (or resumed) `cleo project reroot`. */
export interface RerootProjectResult {
  /** Discriminant: always `false` for a completed reroot. */
  dryRun: false;
  /** Stable project id — unchanged. */
  projectId: string;
  /** Previous absolute project root (now holds only the tombstone). */
  oldRoot: string;
  /** New absolute project root (the child directory). */
  newRoot: string;
  /**
   * `true` when this run finished a reroot an earlier run left half done
   * (`.cleo/` already in the child, registry still on the old root).
   */
  resumed: boolean;
  /** Id of the checkpoint taken before any change (empty on a resume). */
  checkpointId: string;
  /** Directory holding the checkpoint, outside the moved tree (empty on a resume). */
  checkpointPath: string;
  /** Top-level entries renamed from the old root into the new one. */
  renamed: string[];
  /** Whether `.cleo/project-id` was already present or had to be written. */
  projectIdFile: 'present' | 'written';
  /** Absolute path of the tombstone left at the old root. */
  tombstone: string;
  /** Registry status after the rebind. */
  reconcileStatus: 'ok' | 'path_updated' | 'auto_registered' | 'candidate';
  /** Follow-up the operator must do by hand (git bookkeeping). */
  notes: string[];
}

/**
 * `<oldRoot>/.cleo-moved.json` — left by `cleo project reroot` so a command
 * run at the old root refuses with `E_PROJECT_MOVED` instead of silently
 * creating an empty store there.
 */
export interface ProjectMovedTombstone {
  /** The project that used to live here. */
  projectId: string;
  /** Absolute path of its new root. */
  movedTo: string;
  /** ISO 8601 timestamp of the relocation. */
  at: string;
}
