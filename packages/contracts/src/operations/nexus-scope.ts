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
  /**
   * When `true`, the decorator stamps `meta._nexus.indexFreshness` on the
   * response envelope (top-level CLI invocations only; sub-calls inherit via
   * `meta.requestId` lineage to avoid per-call git-status shell-outs).
   *
   * @defaultValue `false`
   * @task T9146
   */
  readonly indexSensitive?: boolean;
}

// ---------------------------------------------------------------------------
// W2: NexusScopeMeta — namespaced _nexus block stamped on every response
// ---------------------------------------------------------------------------

/**
 * Source of the `projectId` binding for a nexus operation.
 *
 * - `arg-project-id` — caller supplied `--project-id` explicitly.
 * - `arg-path`       — resolved from `--path` argument.
 * - `cwd`            — derived from current working directory.
 * - `registry`       — looked up via the global project registry.
 * - `none`           — operation does not require a project binding.
 *
 * @task T9146
 */
export type NexusBindingSource = 'arg-project-id' | 'arg-path' | 'cwd' | 'registry' | 'none';

/**
 * A structured suggestion for the next action an agent should take after a
 * Nexus operation completes.
 *
 * Machine-readable — display strings are derived from these fields.
 *
 * @task T9146
 */
export interface SuggestedNextOp {
  /** Nexus operation key (must exist in NEXUS_SCOPE_MAP). */
  readonly op: string;
  /** Arguments to pass to the operation. */
  readonly args: Readonly<Record<string, unknown>>;
  /** Scope of the suggested operation. */
  readonly scope: NexusScope;
  /** Side-effect classification of the suggested operation. */
  readonly effect: NexusEffect;
  /** Whether the agent should confirm with the user before executing. */
  readonly requiresConfirmation: boolean;
  /** Human-readable rationale for why this next step is suggested. */
  readonly reason: string;
}

/**
 * Namespaced `_nexus` block attached to every nexus-domain dispatch response
 * under `meta._nexus`.
 *
 * Consumed by agents, renderers, and downstream middleware for scope-aware
 * routing and display.
 *
 * @task T9146
 */
export interface NexusScopeMeta {
  /** Scope classification of the operation that produced this envelope. */
  readonly scope: NexusScope;
  /** Side-effect classification of the operation. */
  readonly effect: NexusEffect;
  /**
   * Resolved project identifier (undefined for `global` / `living-brain`
   * scope operations that do not require a project).
   */
  readonly projectId?: string;
  /** Human-readable project name from the registry (if available). */
  readonly projectName?: string;
  /** Absolute filesystem path to the project root. */
  readonly projectPath?: string;
  /** Absolute path to the nexus DB or registry file. */
  readonly registryPath?: string;
  /** How the `projectId` was resolved for this request. */
  readonly bindingSource: NexusBindingSource;
  /**
   * For `hybrid`-scope operations: the ID of the secondary project
   * (the one whose data is being compared or merged with the primary).
   */
  readonly counterpartProjectId?: string;
  /**
   * Whether the nexus index was considered fresh at the time of this call.
   * Only present when `descriptor.indexSensitive === true` AND this was a
   * top-level CLI invocation (sub-calls inherit via `meta.requestId` lineage).
   */
  readonly indexFreshness?: 'fresh' | 'stale' | 'unknown';
  /**
   * The canonical CLI command string for this operation (e.g. `"cleo nexus context"`).
   */
  readonly canonicalCommand: string;
  /**
   * If this operation is a legacy alias, the canonical op key it maps to.
   * Absent when the operation is already canonical.
   */
  readonly legacyAliasFor?: string;
  /** Non-fatal warnings surfaced from descriptor or runtime resolution. */
  readonly warnings?: ReadonlyArray<string>;
  /**
   * Structured suggestions for what the agent should do next.
   * Every entry's `.op` MUST resolve to a known NEXUS_SCOPE_MAP entry
   * (enforced at build time by the typed-registry gate in nexus-decorator.ts).
   */
  readonly suggestedNext?: ReadonlyArray<SuggestedNextOp>;
}

/**
 * Utility type that intersects {@link NexusScopeMeta} into `meta._nexus` for
 * nexus-domain dispatch responses.
 *
 * Use this to narrow the `meta` field when processing nexus responses.
 *
 * @task T9146
 */
export interface MetaWithNexusScope {
  _nexus: NexusScopeMeta;
  [key: string]: unknown;
}
