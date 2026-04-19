/**
 * Nexus Domain Operations (22 operations)
 *
 * Query operations: 13
 * Mutate operations: 9
 *
 * NEXUS is the cross-project coordination layer (the BRAIN Network). It tracks
 * registered projects in a global registry (`nexus.db`), serves cross-project
 * task references (`project:taskId` syntax), answers dependency / blocker /
 * orphan queries, and orchestrates cross-project transfers. These wire-format
 * contracts describe the CLI + HTTP dispatch surface.
 *
 * SYNC: Canonical implementations at
 *   packages/core/src/nexus/* and packages/nexus/*
 * Engine adapter at
 *   packages/cleo/src/dispatch/engines/nexus-engine.ts
 *
 * @task T910 — Orchestration Coherence v4 (contract surface completion)
 * @see packages/cleo/src/dispatch/domains/nexus.ts
 */

import type { LAFSPage } from '../lafs.js';

// ============================================================================
// Shared Nexus wire-format types
// ============================================================================

/** Permission level granted to a registered project. */
export type NexusPermissionLevel = 'read' | 'write' | 'execute';

/** Health status surfaced by `nexus.show` / `nexus.status`. */
export type NexusHealthStatus = 'unknown' | 'healthy' | 'degraded' | 'unreachable';

/** Cross-project transfer mode. */
export type NexusTransferMode = 'copy' | 'move';

/** Cross-project transfer scope. */
export type NexusTransferScope = 'single' | 'subtree';

/** Conflict resolution strategy for transfers. */
export type NexusTransferOnConflict = 'duplicate' | 'rename' | 'skip' | 'fail';

/** Handling strategy when deps are missing in the target project. */
export type NexusTransferOnMissingDep = 'strip' | 'fail';

/** Per-project code intelligence statistics. */
export interface NexusProjectStats {
  /** Indexed node count. */
  nodeCount: number;
  /** Indexed relation (edge) count. */
  relationCount: number;
  /** Indexed file count. */
  fileCount: number;
}

/** Domain representation of a registered Nexus project. */
export interface NexusProjectRecord {
  /** Stable content hash for the project. */
  hash: string;
  /** Human-friendly project identifier (unique). */
  projectId: string;
  /** Absolute filesystem path. */
  path: string;
  /** Display name. */
  name: string;
  /** ISO 8601 registration timestamp. */
  registeredAt: string;
  /** ISO 8601 last-seen timestamp. */
  lastSeen: string;
  /** Current health status. */
  healthStatus: NexusHealthStatus;
  /** ISO 8601 timestamp of the last health check (nullable). */
  healthLastCheck: string | null;
  /** Permission level on this project. */
  permissions: NexusPermissionLevel;
  /** ISO 8601 timestamp of the last metadata sync. */
  lastSync: string;
  /** Total task count (projection). */
  taskCount: number;
  /** Project-level labels. */
  labels: string[];
  /** Absolute path to project's brain.db (nullable until populated). */
  brainDbPath: string | null;
  /** Absolute path to project's tasks.db (nullable until populated). */
  tasksDbPath: string | null;
  /** ISO 8601 timestamp of the last code-intelligence index run. */
  lastIndexed: string | null;
  /** Code intelligence stats from the last index run. */
  stats: NexusProjectStats;
}

/** A single cross-project task reference tuple. */
export interface NexusTaskRef {
  /** Task identifier (e.g. `T001`). */
  taskId: string;
  /** Project identifier this task belongs to. */
  project: string;
}

/** A dependency entry (upstream or downstream) from `nexus.deps`. */
export interface NexusDepsEntry {
  /** Canonical `project:taskId` string. */
  query: string;
  /** Project identifier. */
  project: string;
  /** Task status snapshot. */
  status: string;
  /** Optional task title (when resolvable). */
  title?: string;
}

/** A node in the global cross-project dependency graph. */
export interface NexusGraphNode {
  /** Node identifier (`project:taskId`). */
  id: string;
  /** Project this task belongs to. */
  project: string;
  /** Task status snapshot. */
  status: string;
  /** Task title. */
  title: string;
}

/** An edge in the global cross-project dependency graph. */
export interface NexusGraphEdge {
  /** Source node identifier. */
  from: string;
  /** Source project. */
  fromProject: string;
  /** Target node identifier. */
  to: string;
  /** Target project. */
  toProject: string;
}

/** An orphaned cross-project reference (unresolved). */
export interface NexusOrphanEntry {
  /** Source project holding the reference. */
  sourceProject: string;
  /** Source task id holding the reference. */
  sourceTask: string;
  /** Target project (unresolved). */
  targetProject: string;
  /** Target task id (unresolved). */
  targetTask: string;
  /** Why this entry is orphaned. */
  reason: 'project_not_registered' | 'task_not_found';
}

/** A single discover result from `nexus.discover`. */
export interface NexusDiscoverHit {
  /** Project containing the match. */
  project: string;
  /** Matched task id. */
  taskId: string;
  /** Task title. */
  title: string;
  /** Similarity score [0..1]. */
  score: number;
  /** Discovery method attribution (e.g. `keyword`, `semantic`). */
  type: string;
  /** Rationale string shown to humans. */
  reason: string;
}

/** A single search hit from `nexus.search`. */
export interface NexusSearchHit {
  /** Task id. */
  id: string;
  /** Task title. */
  title: string;
  /** Task status. */
  status: string;
  /** Task priority (when set). */
  priority?: string;
  /** Task description (may be truncated). */
  description?: string;
  /** Project identifier. */
  _project: string;
}

/** A single entry in the cross-project transfer manifest. */
export interface NexusTransferManifestEntry {
  /** Source task id. */
  sourceId: string;
  /** Target task id (post-transfer). */
  targetId: string;
  /** Task title. */
  title: string;
  /** Task type (task/epic/milestone/...). */
  type: string;
}

/** Transfer manifest describing what was (or would be) transferred. */
export interface NexusTransferManifest {
  /** Source project name. */
  sourceProject: string;
  /** Target project name. */
  targetProject: string;
  /** Transfer mode applied. */
  mode: NexusTransferMode;
  /** Transfer scope applied. */
  scope: NexusTransferScope;
  /** Tasks included in the manifest. */
  entries: NexusTransferManifestEntry[];
  /** Source id → target id remap table. */
  idRemap: Record<string, string>;
  /** Count of brain observations carried over. */
  brainObservationsTransferred: number;
}

/** Sharing status for the current project (multi-contributor mode). */
export interface NexusSharingStatus {
  /** Sharing mode identifier. */
  mode: string;
  /** Allow-list patterns. */
  allowlist: string[];
  /** Deny-list patterns. */
  denylist: string[];
  /** Tracked files (currently committed). */
  tracked: string[];
  /** Ignored files (excluded by config). */
  ignored: string[];
  /** Whether `.cleo/.git` is initialized. */
  hasGit: boolean;
  /** Configured git remote names. */
  remotes: string[];
  /** Whether the `.cleo/.git` worktree has uncommitted changes. */
  pendingChanges: boolean;
  /** ISO 8601 timestamp of last push/pull, or null. */
  lastSync: string | null;
}

// ============================================================================
// Query Operations
// ============================================================================

// --------------------------------------------------------------------------
// nexus.status → registry health
// --------------------------------------------------------------------------

/** Parameters for `nexus.status` — none. */
export type NexusStatusParams = Record<string, never>;
/** Result of `nexus.status`. */
export interface NexusStatusResult {
  /** True when nexus.db has been initialised. */
  initialized: boolean;
  /** Count of registered projects. */
  projectCount: number;
  /** ISO 8601 timestamp of last registry update, or null. */
  lastUpdated: string | null;
}

// --------------------------------------------------------------------------
// nexus.list → all registered projects (paginated)
// --------------------------------------------------------------------------

/** Parameters for `nexus.list`. */
export interface NexusListParams {
  /** Max results per page. */
  limit?: number;
  /** Offset into the result set. */
  offset?: number;
}
/** Result of `nexus.list`. */
export interface NexusListResult {
  /** Projects on this page. */
  projects: NexusProjectRecord[];
  /** Count of items on this page. */
  count: number;
  /** Total registered projects. */
  total: number;
  /** Filtered count (post-limit). */
  filtered: number;
  /** Pagination descriptor. */
  page: LAFSPage;
}

// --------------------------------------------------------------------------
// nexus.show → single project lookup by name or hash
// --------------------------------------------------------------------------

/** Parameters for `nexus.show`. */
export interface NexusShowParams {
  /** Project name or hash (required). */
  name: string;
}
/** Result of `nexus.show`. */
export type NexusShowResult = NexusProjectRecord;

// --------------------------------------------------------------------------
// nexus.resolve → resolve `project:taskId` reference
// --------------------------------------------------------------------------

/** Parameters for `nexus.resolve`. */
export interface NexusResolveParams {
  /** Cross-project reference (e.g. `my-app:T001`, `.:T001`, `*:T001`). */
  query: string;
  /** Current project name (used for `.` and bare id resolution). */
  currentProject?: string;
}
/** Result of `nexus.resolve`. */
export interface NexusResolveResult {
  /** Parsed query descriptor. */
  parsed: {
    /** Project identifier. */
    project: string;
    /** Task id. */
    taskId: string;
    /** True when the query was `*:...`. */
    wildcard: boolean;
  };
  /** Resolved task records (one per matching project for wildcards). */
  resolved: Array<{
    /** Fully-qualified identifier. */
    id: string;
    /** Project the task belongs to. */
    project: string;
    /** Task title. */
    title: string;
    /** Task status. */
    status: string;
  }>;
}

// --------------------------------------------------------------------------
// nexus.deps → cross-project dependency analysis
// --------------------------------------------------------------------------

/** Parameters for `nexus.deps`. */
export interface NexusDepsParams {
  /** Cross-project reference (required). */
  query: string;
  /** Direction to walk (default `forward`). */
  direction?: 'forward' | 'reverse';
}
/** Result of `nexus.deps`. */
export interface NexusDepsResult {
  /** Task id queried. */
  task: string;
  /** Project of the queried task. */
  project: string;
  /** Upstream deps (things this task depends on). */
  depends: NexusDepsEntry[];
  /** Downstream deps (things that depend on this task). */
  blocking: NexusDepsEntry[];
}

// --------------------------------------------------------------------------
// nexus.graph → full cross-project graph
// --------------------------------------------------------------------------

/** Parameters for `nexus.graph` — none. */
export type NexusGraphParams = Record<string, never>;
/** Result of `nexus.graph`. */
export interface NexusGraphResult {
  /** All nodes in the graph. */
  nodes: NexusGraphNode[];
  /** All edges in the graph. */
  edges: NexusGraphEdge[];
}

// --------------------------------------------------------------------------
// nexus.path.show → critical path across projects
// --------------------------------------------------------------------------

/** Parameters for `nexus.path.show` — none. */
export type NexusPathShowParams = Record<string, never>;
/** Result of `nexus.path.show`. */
export interface NexusPathShowResult {
  /** Ordered path entries (upstream → downstream). */
  criticalPath: Array<{ query: string; title: string }>;
  /** Length of the critical path. */
  length: number;
  /** The root blocker id that seeded the path. */
  blockedBy: string;
}

// --------------------------------------------------------------------------
// nexus.blockers.show → blocking impact for a task query
// --------------------------------------------------------------------------

/** Parameters for `nexus.blockers.show`. */
export interface NexusBlockersShowParams {
  /** Cross-project reference (required). */
  query: string;
}
/** Result of `nexus.blockers.show`. */
export interface NexusBlockersShowResult {
  /** Task id queried. */
  task: string;
  /** Tasks this one is blocking. */
  blocking: Array<{ query: string; project: string }>;
  /** Aggregate impact score. */
  impactScore: number;
}

// --------------------------------------------------------------------------
// nexus.orphans.list → list orphaned cross-project references
// --------------------------------------------------------------------------

/** Parameters for `nexus.orphans.list`. */
export interface NexusOrphansListParams {
  /** Max results per page. */
  limit?: number;
  /** Offset into the result set. */
  offset?: number;
}
/** Result of `nexus.orphans.list`. */
export interface NexusOrphansListResult {
  /** Orphan entries on this page. */
  orphans: NexusOrphanEntry[];
  /** Count on this page. */
  count: number;
  /** Total orphan count. */
  total: number;
  /** Filtered count. */
  filtered: number;
  /** Pagination descriptor. */
  page: LAFSPage;
}

// --------------------------------------------------------------------------
// nexus.discover → discover related tasks across projects
// --------------------------------------------------------------------------

/** Parameters for `nexus.discover`. */
export interface NexusDiscoverParams {
  /** Free-text query (required). */
  query: string;
  /** Discovery method (`auto`, `keyword`, `semantic`, ...). Default `auto`. */
  method?: string;
  /** Max results (default 10). */
  limit?: number;
}
/** Result of `nexus.discover`. */
export interface NexusDiscoverResult {
  /** Query that was executed. */
  query: string;
  /** Method that was selected. */
  method: string;
  /** Ranked matches. */
  results: NexusDiscoverHit[];
  /** Total match count. */
  total: number;
}

// --------------------------------------------------------------------------
// nexus.search → pattern search across projects
// --------------------------------------------------------------------------

/** Parameters for `nexus.search`. */
export interface NexusSearchParams {
  /** Search pattern (required). */
  pattern: string;
  /** Optional project name/hash filter. */
  project?: string;
  /** Max results (default 20). */
  limit?: number;
}
/** Result of `nexus.search`. */
export interface NexusSearchResult {
  /** Pattern that was searched. */
  pattern: string;
  /** Matching tasks. */
  results: NexusSearchHit[];
  /** Count of matches. */
  resultCount: number;
}

// --------------------------------------------------------------------------
// nexus.share.status → multi-contributor sharing status
// --------------------------------------------------------------------------

/** Parameters for `nexus.share.status` — none. */
export type NexusShareStatusParams = Record<string, never>;
/** Result of `nexus.share.status`. */
export type NexusShareStatusResult = NexusSharingStatus;

// --------------------------------------------------------------------------
// nexus.transfer.preview → dry-run of a cross-project transfer
// --------------------------------------------------------------------------

/** Parameters for `nexus.transfer.preview`. */
export interface NexusTransferPreviewParams {
  /** Task IDs to transfer (required, non-empty). */
  taskIds: string[];
  /** Source project name or hash (required). */
  sourceProject: string;
  /** Target project name or hash (required). */
  targetProject: string;
  /** Transfer mode (default `copy`). */
  mode?: NexusTransferMode;
  /** Transfer scope (default `subtree`). */
  scope?: NexusTransferScope;
  /** Conflict resolution strategy. */
  onConflict?: NexusTransferOnConflict;
  /** Missing-dependency strategy. */
  onMissingDep?: NexusTransferOnMissingDep;
  /** Carry over brain observations linked to transferred tasks. */
  transferBrain?: boolean;
  /** Override parent id in target project. */
  targetParent?: string;
}
/** Result of `nexus.transfer.preview`. */
export interface NexusTransferPreviewResult {
  /** Always `true` for preview (dry-run). */
  dryRun: true;
  /** Tasks that would be transferred. */
  transferred: number;
  /** Tasks that would be skipped (by conflict rule). */
  skipped: number;
  /** Source tasks that would be archived (move mode). */
  archived: number;
  /** Cross-project link count that would be created. */
  linksCreated: number;
  /** Count of brain observations that would be transferred. */
  brainObservationsTransferred: number;
  /** Manifest for inspection. */
  manifest: NexusTransferManifest;
}

// ============================================================================
// Mutate Operations
// ============================================================================

// --------------------------------------------------------------------------
// nexus.init → initialise the global registry
// --------------------------------------------------------------------------

/** Parameters for `nexus.init` — none. */
export type NexusInitParams = Record<string, never>;
/** Result of `nexus.init`. */
export interface NexusInitResult {
  /** Human-readable status line. */
  message: string;
}

// --------------------------------------------------------------------------
// nexus.register → add a project to the registry
// --------------------------------------------------------------------------

/** Parameters for `nexus.register`. */
export interface NexusRegisterParams {
  /** Absolute project path (required). */
  path: string;
  /** Optional explicit name (defaults to directory basename). */
  name?: string;
  /** Permission level to grant (default `read`). */
  permission?: NexusPermissionLevel;
}
/** Result of `nexus.register`. */
export interface NexusRegisterResult {
  /** Generated project hash. */
  hash: string;
  /** Human-readable status line. */
  message: string;
}

// --------------------------------------------------------------------------
// nexus.unregister → remove a project from the registry
// --------------------------------------------------------------------------

/** Parameters for `nexus.unregister`. */
export interface NexusUnregisterParams {
  /** Project name or hash (required). */
  name: string;
}
/** Result of `nexus.unregister`. */
export interface NexusUnregisterResult {
  /** Human-readable status line. */
  message: string;
}

// --------------------------------------------------------------------------
// nexus.sync → resync a project (or all projects)
// --------------------------------------------------------------------------

/** Parameters for `nexus.sync`. */
export interface NexusSyncParams {
  /** Project name to sync. Omit to sync all. */
  name?: string;
}
/** Result of `nexus.sync`. */
export interface NexusSyncResult {
  /** Human-readable status line. */
  message: string;
  /** Projects actually synced (populated when `name` omitted). */
  synced?: string[];
}

// --------------------------------------------------------------------------
// nexus.permission.set → update project permission level
// --------------------------------------------------------------------------

/** Parameters for `nexus.permission.set`. */
export interface NexusPermissionSetParams {
  /** Project name (required). */
  name: string;
  /** New permission level (required; read|write|execute). */
  level: NexusPermissionLevel;
}
/** Result of `nexus.permission.set`. */
export interface NexusPermissionSetResult {
  /** Human-readable status line. */
  message: string;
}

// --------------------------------------------------------------------------
// nexus.reconcile → reconcile project identity with global registry
// --------------------------------------------------------------------------

/** Parameters for `nexus.reconcile`. */
export interface NexusReconcileParams {
  /** Override project root (defaults to cwd). */
  projectRoot?: string;
}
/** Result of `nexus.reconcile`. */
export interface NexusReconcileResult {
  /** Whether the registry entry was created or updated. */
  changed: boolean;
  /** The reconciled hash. */
  hash: string;
  /** Project identifier. */
  projectId: string;
  /** Human-readable status line. */
  message: string;
}

// --------------------------------------------------------------------------
// nexus.share.snapshot.export → export .cleo state snapshot
// --------------------------------------------------------------------------

/** Parameters for `nexus.share.snapshot.export`. */
export interface NexusShareSnapshotExportParams {
  /** Override output path (defaults to .cleo/snapshots/...). */
  outputPath?: string;
}
/** Result of `nexus.share.snapshot.export`. */
export interface NexusShareSnapshotExportResult {
  /** Final output path written. */
  path: string;
  /** Tasks included in the snapshot. */
  taskCount: number;
  /** SHA-256 checksum of the snapshot payload. */
  checksum: string;
}

// --------------------------------------------------------------------------
// nexus.share.snapshot.import → import .cleo state snapshot
// --------------------------------------------------------------------------

/** Parameters for `nexus.share.snapshot.import`. */
export interface NexusShareSnapshotImportParams {
  /** Input snapshot file path (required). */
  inputPath: string;
}
/** Result of `nexus.share.snapshot.import`. */
export interface NexusShareSnapshotImportResult {
  /** Tasks written to the local store. */
  imported: number;
  /** Tasks skipped (duplicates, etc.). */
  skipped: number;
  /** Source id → target id remap table. */
  idRemap: Record<string, string>;
}

// --------------------------------------------------------------------------
// nexus.transfer → execute a cross-project transfer
// --------------------------------------------------------------------------

/** Parameters for `nexus.transfer`. */
export interface NexusTransferParams {
  /** Task IDs to transfer (required, non-empty). */
  taskIds: string[];
  /** Source project name or hash (required). */
  sourceProject: string;
  /** Target project name or hash (required). */
  targetProject: string;
  /** Transfer mode (default `copy`). */
  mode?: NexusTransferMode;
  /** Transfer scope (default `subtree`). */
  scope?: NexusTransferScope;
  /** Conflict resolution strategy (default `rename`). */
  onConflict?: NexusTransferOnConflict;
  /** Missing-dependency strategy. */
  onMissingDep?: NexusTransferOnMissingDep;
  /** Carry over brain observations linked to transferred tasks (default false). */
  transferBrain?: boolean;
  /** Override parent id in target project. */
  targetParent?: string;
  /** Attach provenance notes to transferred tasks. */
  provenance?: boolean;
}
/** Result of `nexus.transfer`. */
export interface NexusTransferResult {
  /** Always `false` for execute (as opposed to `nexus.transfer.preview`). */
  dryRun: false;
  /** Tasks actually transferred. */
  transferred: number;
  /** Tasks skipped by conflict rule. */
  skipped: number;
  /** Source tasks archived (move mode). */
  archived: number;
  /** Cross-project links created. */
  linksCreated: number;
  /** Brain observations transferred. */
  brainObservationsTransferred: number;
  /** Manifest describing what was moved. */
  manifest: NexusTransferManifest;
}
