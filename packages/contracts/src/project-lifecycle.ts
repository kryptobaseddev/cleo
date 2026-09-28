/**
 * Project relocation contracts — `cleo project move` and `cleo project reroot`
 * (T12552 · T12558).
 *
 * A relocation either COPIES the project tree to an unrelated directory
 * (`move`) or RENAMES `.cleo/` into a child directory of the current root
 * (`reroot`). Both support a dry run that returns a {@link ProjectRelocationPlan}
 * and touches neither the disk nor the registry.
 *
 * @task T12552
 * @task T12558
 */

/** Which relocation a plan or result describes. */
export type ProjectRelocationKind = 'move' | 'reroot';

/**
 * How the project's files reach the target.
 *
 * - `copy` — `move`: the tree is copied; the source is left in place.
 * - `rename` — `reroot`: `.cleo/` (and `.worktreeinclude`) are renamed.
 */
export type ProjectRelocationTransfer = 'copy' | 'rename';

/** The registry change a relocation makes. */
export interface ProjectRelocationRegistryAction {
  /**
   * `rebind` points the project's registry row at the target (registering the
   * project first when it has no row). Always explicit — never inferred.
   */
  action: 'rebind';
  /** Location that becomes `live`. */
  livePath: string;
  /** Location that is demoted. */
  demotedPath: string;
  /**
   * State the old location is demoted to: `candidate` when it still declares
   * the id (`move` leaves a copy), `missing` when it no longer does (`reroot`).
   */
  demotedState: 'candidate' | 'missing';
  /**
   * `fresh` — the target gets a new checkout nonce, so the copy can never be
   * mistaken for the original (T12556). `carried` — the nonce moves with the
   * renamed `.cleo/`, as in any real move.
   */
  nonce: 'fresh' | 'carried';
}

/**
 * What a relocation WOULD do, returned by a dry run. Producing it writes
 * nothing to disk and opens no registry handle.
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
  /** Project hash the target would have. */
  newProjectHash: string;
  /** How files reach the target. */
  transfer: ProjectRelocationTransfer;
  /** Top-level entries of `source` that are copied or renamed. */
  entries: string[];
  /** Top-level entries of `source` that are NOT transferred. */
  excluded: string[];
  /** Files written at the target, relative to it. */
  writes: string[];
  /** The registry change. */
  registry: ProjectRelocationRegistryAction;
  /** Snapshot taken before any change (`reroot` only), as a description. */
  checkpoint?: string;
  /** Conditions that would make the real run refuse. Empty when none found. */
  blockers: string[];
  /** Checks that only the real run performs (they would open a database). */
  deferredChecks: string[];
}

/** Result of a completed `cleo project reroot`. */
export interface RerootProjectResult {
  /** Discriminant: always `false` for a completed reroot. */
  dryRun: false;
  /** Stable project id — unchanged. */
  projectId: string;
  /** Previous absolute project root (no longer holds `.cleo/`). */
  oldRoot: string;
  /** New absolute project root (the child directory). */
  newRoot: string;
  /** Project hash of the new root. */
  newProjectHash: string;
  /** Id of the checkpoint taken before any change (under `.cleo/backups/sqlite/`). */
  checkpointId: string;
  /** Top-level entries renamed from the old root into the new one. */
  renamed: string[];
  /** Whether `.cleo/project-id` was already present or had to be written. */
  projectIdFile: 'present' | 'written';
  /** Registry status after the rebind. */
  reconcileStatus: 'ok' | 'path_updated' | 'auto_registered' | 'candidate';
  /** Follow-up the operator must do by hand (git bookkeeping). */
  notes: string[];
}
