/**
 * Nexus operation scope contracts — discriminated unions and descriptor
 * interface used by the NEXUS_SCOPE_MAP SSoT.
 *
 * @task T9145
 * @module operations/nexus-scope
 */

// ---------------------------------------------------------------------------
// NexusScope — five-state discriminated union
// ---------------------------------------------------------------------------

/**
 * Five-state scope classification for Nexus operations.
 *
 * - `project`      — Operates on a single registered project graph.
 * - `living-brain` — Reads/writes the BRAIN (memory) store.
 * - `cross`        — Spans multiple project graphs or compares them.
 * - `hybrid`       — Touches both the project graph AND BRAIN.
 * - `global`       — Operates on the global Nexus registry (all projects).
 */
export type NexusScope = 'project' | 'living-brain' | 'cross' | 'hybrid' | 'global';

// ---------------------------------------------------------------------------
// NexusEffect — read / write / admin axis
// ---------------------------------------------------------------------------

/**
 * Side-effect classification for a Nexus operation.
 *
 * - `read`  — Pure query; no persistent state change.
 * - `write` — Mutates the target store(s).
 * - `admin` — Administrative operation (register/unregister/permission).
 */
export type NexusEffect = 'read' | 'write' | 'admin';

// ---------------------------------------------------------------------------
// NexusStore — target data stores
// ---------------------------------------------------------------------------

/**
 * The persistent stores a Nexus operation may touch.
 *
 * - `nexus-graph`    — The graph DB (nodes + relations for a project).
 * - `nexus-registry` — The global project registry.
 * - `brain`          — The BRAIN memory / observation store.
 * - `tasks`          — The task store (nexus → task bridge operations).
 * - `fs`             — The local filesystem (scan / walk / snapshot).
 */
export type NexusStore = 'nexus-graph' | 'nexus-registry' | 'brain' | 'tasks' | 'fs';

// ---------------------------------------------------------------------------
// ScopeBinding — links an operation key to scope + effect metadata
// ---------------------------------------------------------------------------

/**
 * A single scope binding, attaching NexusScope and NexusEffect metadata to
 * a named Nexus operation.
 */
export interface ScopeBinding {
  /** The operation key as declared in {@link NexusOps}. */
  readonly op: string;
  /** Scope classification of this operation. */
  readonly scope: NexusScope;
  /** Side-effect classification. */
  readonly effect: NexusEffect;
  /** Stores this operation reads or writes. */
  readonly stores: ReadonlyArray<NexusStore>;
}

// ---------------------------------------------------------------------------
// NexusOperationDescriptor — full operation metadata
// ---------------------------------------------------------------------------

/**
 * Rich metadata descriptor for a single Nexus operation.
 *
 * Used by the NEXUS_SCOPE_MAP SSoT to provide compile-time exhaustiveness
 * checking and runtime helpers (`getNexusDescriptor`, `listOpsByScope`).
 */
export interface NexusOperationDescriptor {
  /** The operation key as declared in {@link NexusOps}. */
  readonly op: string;
  /** Human-readable summary of the operation. */
  readonly description: string;
  /** Scope classification. */
  readonly scope: NexusScope;
  /** Side-effect classification. */
  readonly effect: NexusEffect;
  /** Stores this operation reads or writes. */
  readonly stores: ReadonlyArray<NexusStore>;
  /**
   * Whether this operation requires a `projectId` parameter.
   * Operations with `scope === 'global'` typically do NOT require one.
   * @defaultValue `true`
   */
  readonly requiresProject: boolean;
}
