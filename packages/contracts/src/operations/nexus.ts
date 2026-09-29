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

// API contract result types (T1065)
import type { KnowledgeCoverage } from '../knowledge-health.js';
import type { ContractCompatibilityMatrix } from '../nexus-contract-ops.js';
// Living-brain result types (T1068)
import type {
  CodeAnchorResult,
  CodeReasonTrace,
  ImpactFullReport,
  RiskTier,
  SymbolFullContext,
  TaskCodeImpact,
} from '../nexus-living-brain-ops.js';
// CTE query result type (T1057)
import type { NexusCteResult } from '../nexus-query-ops.js';
// Route analysis result types (T1064)
import type { RouteMapResult, ShapeCheckResult } from '../nexus-route-ops.js';
// Task-symbol bridge result types (T1067)
import type { GitLogLinkerResult, SymbolReference } from '../nexus-tasks-bridge-ops.js';
// NexusWikiResult is canonical in nexus-wiki-ops.ts (T1699 dedup)
import type { NexusWikiResult } from '../nexus-wiki-ops.js';
// Profile types are now canonical in nexus-user-profile.ts (T1424 dedup)
import type { SigilCard } from './memory.js';
import type {
  NexusProfileExportParams,
  NexusProfileExportResult,
  NexusProfileGetParams,
  NexusProfileGetResult,
  NexusProfileImportParams,
  NexusProfileImportResult,
  NexusProfileReinforceParams,
  NexusProfileReinforceResult,
  NexusProfileSupersedeParams,
  NexusProfileSupersedeResult,
  NexusProfileUpsertParams,
  NexusProfileUpsertResult,
  NexusProfileViewParams,
  NexusProfileViewResult,
} from './nexus-user-profile.js';

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
  /** Absolute path to the project's live store holding brain tables (`.cleo/cleo.db`; nullable until populated). */
  brainDbPath: string | null;
  /** Absolute path to the project's live store holding task tables (`.cleo/cleo.db`; nullable until populated). */
  tasksDbPath: string | null;
  /** ISO 8601 timestamp of the last code-intelligence index run. */
  lastIndexed: string | null;
  /** Code intelligence stats from the last index run. */
  stats: NexusProjectStats;
  /** ISO 8601 instant of the last health check, sync or git probe (T12512). */
  lastProbedAt?: string | null;
  /** ISO 8601 instant of the last real CLI use inside the project (T12512). */
  lastOpenedAt?: string | null;
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
  /**
   * Rebind the registry row to this checkout even though its previous location
   * still exists on this device (T12470). Without it such a checkout is only
   * recorded as a `candidate` — a second checkout or a clone is not a move.
   */
  forceRebind?: boolean;
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

// ============================================================================
// Additional operations (T1424 — typed narrowing stub types)
// ============================================================================

/** Parameters for `nexus.augment`. */
export interface NexusAugmentParams {
  /** Search pattern (required). */
  pattern: string;
  /** Max results (default 5). */
  limit?: number;
}
/**
 * A single augmented symbol result from `nexus.augment` / `nexus.search-code`.
 *
 * Mirrors the AugmentResult shape produced by core's augmentSymbol().
 */
export interface NexusAugmentSymbol {
  /** Nexus node ID. */
  id: string;
  /** Human-readable symbol name. */
  label: string;
  /** Node kind (function, method, class, …). */
  kind: string;
  /** Source file path (relative to project root), or undefined. */
  filePath?: string;
  /** Start line (1-based), or undefined. */
  startLine?: number;
  /** End line (1-based), or undefined. */
  endLine?: number;
  /** Count of callers of this symbol. */
  callersCount: number;
  /** Count of callees (symbols this one calls). */
  calleesCount: number;
  /**
   * Community identifier string (e.g. "comm_3"), or undefined.
   *
   * Stored as text in nexus_nodes.community_id. Typed as string to match
   * the Leiden community processor output format. (T1765: was incorrectly
   * typed as number.)
   */
  communityId?: string;
  /** Size of the community, or undefined. */
  communitySize?: number;
}
/** Result of `nexus.augment`. */
export interface NexusAugmentResult {
  /** Search pattern that was applied. */
  pattern: string;
  /** Ranked matching symbols. */
  results: NexusAugmentSymbol[];
  /** Human-readable plain-text rendering of the results. */
  text: string;
}

/** Parameters for `nexus.top-entries`. */
export interface NexusTopEntriesParams {
  /** Max results (default 20). */
  limit?: number;
  /** Optional kind filter (nexus.db sources). */
  kind?: string;
  /** Optional nodeType filter (brain.db page_nodes). */
  nodeType?: string;
}
/** Entry from brain.db. */
export interface BrainPageNodeEntry {
  id: string;
  node_type: string;
  label: string;
  quality_score: number;
  last_activity_at: string;
  metadata_json: string | null;
}
/** Entry from nexus.db. */
export interface NexusTopEntry {
  nodeId: string;
  label: string;
  kind: string;
  filePath: string | null;
  totalWeight: number;
  edgeCount: number;
}
/** Result of `nexus.top-entries`. */
export interface NexusTopEntriesResult {
  entries: BrainPageNodeEntry[] | NexusTopEntry[];
  count: number;
  limit: number;
  kind?: string | null;
  nodeType?: string | null;
  note?: string;
}

/** Parameters for `nexus.impact`. */
export interface NexusImpactParams {
  /** Symbol name (required). */
  symbol: string;
  /** Project ID (optional, defaults to current). */
  projectId?: string;
  /** Include "why" reasons (optional). */
  why?: boolean;
  /** Maximum reverse traversal depth (default 3, capped at 5). */
  depth?: number;
}
/** Affected symbol in impact result. */
export interface NexusImpactAffectedNode {
  /** Nexus node ID. */
  nodeId: string;
  /** Human-readable label. */
  label: string;
  /** Node kind. */
  kind: string;
  /** Source file path (nullable). */
  filePath: string | null;
  /** BFS depth from the target (1 = direct caller). */
  depth: number;
  /** Path-strings explaining why this symbol is impacted. */
  reasons: string[];
}
/** Result of `nexus.impact`. */
export interface NexusImpactResult {
  /** Evidence coverage assessed independently of impact severity. */
  coverage?: KnowledgeCoverage;
  /** Original symbol query string. */
  query: string;
  /** Project ID the analysis ran against. */
  projectId: string;
  /** Resolved target node ID (or null when no match was found). */
  targetNodeId: string | null;
  /** Resolved target label (or null when no match was found). */
  targetLabel: string | null;
  /** Whether `why` reasons were requested and populated. */
  why: boolean;
  /** Risk tier based on totalImpact count. */
  riskLevel: RiskTier;
  /** Total affected symbols across all depths (excludes the target itself). */
  totalImpact: number;
  /** Maximum traversal depth applied. */
  maxDepth: number;
  /** Affected symbols grouped by BFS depth. */
  affected: NexusImpactAffectedNode[];
}

/** Parameters for `nexus.full-context`. */
export interface NexusFullContextParams {
  /** Symbol name (required). */
  symbol: string;
}
/**
 * Result of `nexus.full-context`.
 *
 * Cross-substrate context for a code symbol: callers/callees, brain memories,
 * tasks, sentient proposals, and conduit threads.
 *
 * @see SymbolFullContext in nexus-living-brain-ops.ts (T1068)
 */
export type NexusFullContextResult = SymbolFullContext;

/** Parameters for `nexus.task-footprint`. */
export interface NexusTaskFootprintParams {
  /** Task ID (required). */
  taskId: string;
}
/**
 * Result of `nexus.task-footprint`.
 *
 * Code impact analysis for a task: files, symbols, blast radius,
 * brain observations, decisions, and risk tier.
 *
 * @see TaskCodeImpact in nexus-living-brain-ops.ts (T1068)
 */
export type NexusTaskFootprintResult = TaskCodeImpact;

/** Parameters for `nexus.brain-anchors`. */
export interface NexusBrainAnchorsParams {
  /** Entry ID (required). */
  entryId: string;
}
/**
 * Result of `nexus.brain-anchors`.
 *
 * Nexus nodes anchored to a brain memory entry via code-reference edges,
 * and tasks that touched those nodes.
 *
 * @see CodeAnchorResult in nexus-living-brain-ops.ts (T1068)
 */
export type NexusBrainAnchorsResult = CodeAnchorResult;

/** Parameters for `nexus.why`. */
export interface NexusWhyParams {
  /** Symbol name (required). */
  symbol: string;
}
/**
 * Result of `nexus.why`.
 *
 * Causal trace from a code symbol through brain decisions to tasks:
 * symbolId, narrative, and chain of reasoning steps.
 *
 * @see CodeReasonTrace in nexus-living-brain-ops.ts (T1069)
 */
export type NexusWhyResult = CodeReasonTrace;

/** Parameters for `nexus.impact-full`. */
export interface NexusImpactFullParams {
  /** Symbol name (required). */
  symbol: string;
}
/**
 * Result of `nexus.impact-full`.
 *
 * Full merged impact report for a code symbol: structural blast radius,
 * open tasks, brain risk notes, merged risk score, and narrative.
 *
 * @see ImpactFullReport in nexus-living-brain-ops.ts (T1069)
 */
export type NexusImpactFullResult = ImpactFullReport;

/** Parameters for `nexus.route-map`. */
export interface NexusRouteMapParams {
  /** Project ID (optional, auto-generated from projectRoot). */
  projectId?: string;
}
/**
 * Result of `nexus.route-map`.
 *
 * All route nodes with their handlers, downstream dependencies,
 * and distinct fetched modules.
 *
 * @see RouteMapResult in nexus-route-ops.ts (T1064)
 */
export type NexusRouteMapResult = RouteMapResult;

/** Parameters for `nexus.shape-check`. */
export interface NexusShapeCheckParams {
  /** Route symbol (required). */
  routeSymbol: string;
  /** Project ID (optional, auto-generated from projectRoot). */
  projectId?: string;
}
/**
 * Result of `nexus.shape-check`.
 *
 * Route's declared response shape versus all callers' expected shapes:
 * compatibility verdict and recommendation.
 *
 * @see ShapeCheckResult in nexus-route-ops.ts (T1064)
 */
export type NexusShapeCheckResult = ShapeCheckResult;

/** Parameters for `nexus.search-code`. */
export interface NexusSearchCodeParams {
  /** Search pattern (required). */
  pattern: string;
  /** Max results (default 10). */
  limit?: number;
}
/**
 * Result of `nexus.search-code`.
 *
 * Same shape as `NexusAugmentResult` — nexusSearchCode delegates
 * directly to nexusAugment in core (T1061).
 */
export type NexusSearchCodeResult = NexusAugmentResult;

/** Parameters for `nexus.wiki`. */
export interface NexusWikiParams {
  /** Output directory (optional). */
  outputDir?: string;
  /** Community filter (optional). */
  communityFilter?: string;
  /** Incremental mode (optional). */
  incremental?: boolean;
}
// NexusWikiResult re-exported from canonical nexus-wiki-ops.ts (T1699 dedup — single source of truth)
export type { NexusWikiResult };

/** Parameters for `nexus.contracts-show`. */
export interface NexusContractsShowParams {
  /** Project A identifier (required). */
  projectA: string;
  /** Project B identifier (required). */
  projectB: string;
}
/**
 * Result of `nexus.contracts-show`.
 *
 * Compatibility matrix between two projects' HTTP/gRPC/topic contracts:
 * matched contracts, counts, and overall compatibility percentage.
 *
 * @see ContractCompatibilityMatrix in nexus-contract-ops.ts (T1065)
 */
export type NexusContractsShowResult = ContractCompatibilityMatrix;

/** Parameters for `nexus.task-symbols`. */
export interface NexusTaskSymbolsParams {
  /** Task ID (required). */
  taskId: string;
}
/** Result of `nexus.task-symbols`. */
export interface NexusTaskSymbolsResult {
  /** Coverage and unresolved evidence, independent of the number of matches. */
  coverage?: KnowledgeCoverage;
  /** Task ID that was queried. */
  taskId: string;
  /** Count of symbols found. */
  count: number;
  /** Code symbols touched by this task (via task_touches_symbol forward-lookup). */
  symbols: SymbolReference[];
}

/** Parameters for `nexus.sigil.list`. */
export interface NexusSigilListParams {
  /** Role filter (optional). */
  role?: string;
}
/** Result of `nexus.sigil.list`. */
export interface NexusSigilListResult {
  /** Array of sigil records, ordered by displayName ascending. */
  sigils: SigilCard[];
  /** Total count of sigils returned. */
  count: number;
}

/** Parameters for `nexus.sigil.sync` — none. */
export type NexusSigilSyncParams = Record<string, never>;
/** Result of `nexus.sigil.sync`. */
export interface NexusSigilSyncResult {
  /** Total number of sigils upserted (created + updated). */
  count: number;
  /** Peer IDs that were upserted, sorted alphabetically. */
  peerIds: string[];
  /** Absolute path to the seed-agents directory used for the sync (or null). */
  seedAgentsDir: string | null;
  /** Absolute path to the cleo-subagent.cant file used for the sync (or null). */
  cleoSubagentFile: string | null;
  /** Absolute path to the meta agents directory used for the sync (or null). */
  metaDir: string | null;
  /** Warnings encountered during sync (missing files, parse failures). */
  warnings: string[];
}

/** Parameters for `nexus.conduit-scan`. */
export type NexusConduitScanParams = Record<string, never>;
/** Result of `nexus.conduit-scan`. */
export interface NexusConduitScanResult {
  /** Count of conduit messages scanned. */
  scanned: number;
  /** Count of conduit_mentions_symbol edges written. */
  linked: number;
}

/** Parameters for `nexus.contracts-sync`. */
export interface NexusContractsSyncParams {
  /** Repository path (optional). */
  repoPath?: string;
  /** Project ID (optional). */
  projectId?: string;
}
/** Result of `nexus.contracts-sync`. */
export interface NexusContractsSyncResult {
  /** Project ID that was synced. */
  projectId: string;
  /** Absolute repository path that was analyzed. */
  repoPath: string;
  /** Count of HTTP contracts extracted. */
  http: number;
  /** Count of gRPC contracts extracted. */
  grpc: number;
  /** Count of pub/sub topic contracts extracted. */
  topic: number;
  /** Total contracts extracted (http + grpc + topic). */
  totalCount: number;
}

/** Parameters for `nexus.contracts-link-tasks`. */
export interface NexusContractsLinkTasksParams {
  /** Repository path (optional). */
  repoPath?: string;
  /** Project ID (optional). */
  projectId?: string;
}
/**
 * Result of `nexus.contracts-link-tasks`.
 *
 * Outcome of the git-log linker sweep that links contracts to tasks via
 * task_touches_symbol edges.
 *
 * @see GitLogLinkerResult in nexus-tasks-bridge-ops.ts (T1067)
 */
export type NexusContractsLinkTasksResult = GitLogLinkerResult;

// ============================================================================
// T1510 — Phase 2 dispatch ops (clusters, flows, context, projects.*, diff,
//          refresh-bridge, query-cte, hot-paths, hot-nodes, cold-symbols)
// ============================================================================

/** Parameters for `nexus.clusters`. */
export interface NexusClustersParams {
  /** Project ID (optional, auto-generated from repoPath). */
  projectId?: string;
  /** Path to project directory (optional, defaults to cwd). */
  repoPath?: string;
}
/** One detected Louvain community entry. */
export interface NexusCommunityEntry {
  id: string;
  label: string | null;
  symbolCount: number;
  cohesion: number;
}
/** Result of `nexus.clusters`. */
export interface NexusClustersResult {
  projectId: string;
  repoPath: string;
  count: number;
  communities: NexusCommunityEntry[];
}

/** Parameters for `nexus.flows`. */
export interface NexusFlowsParams {
  /** Project ID (optional, auto-generated from repoPath). */
  projectId?: string;
  /** Path to project directory (optional, defaults to cwd). */
  repoPath?: string;
}
/** One detected execution flow entry. */
export interface NexusFlowEntry {
  id: string;
  label: string | null;
  stepCount: number;
  processType: string;
  entryPointId: string | null;
}
/** Result of `nexus.flows`. */
export interface NexusFlowsResult {
  projectId: string;
  repoPath: string;
  count: number;
  flows: NexusFlowEntry[];
}

/** Parameters for `nexus.context`. */
export interface NexusContextParams {
  /** Symbol name to look up (required). */
  symbol: string;
  /** Project ID (optional, auto-generated from cwd). */
  projectId?: string;
  /** Max callers/callees per side (default: 20). */
  limit?: number;
  /** When true, fetch source code content. */
  content?: boolean;
}
/** A single caller or callee relationship from `nexus.context`. */
export interface NexusContextRelation {
  /** Relation type (calls, imports, accesses). */
  relationType: string;
  /** Node ID of the related symbol. */
  nodeId: string | null;
  /** Human-readable symbol name. */
  name: string;
  /** Node kind (function, method, class, …). */
  kind: string;
  /** Relative file path, or null. */
  filePath: string | null;
}

/** Process participation entry from `nexus.context`. */
export interface NexusContextProcess {
  /** Process node ID. */
  processId: string | null;
  /** Human-readable process label. */
  label: string | null;
  /** Role of this symbol in the process. */
  role: string;
  /** Step order within the process, or null. */
  step: number | null;
}

/** Extracted source code content for a symbol. */
export interface NexusContextSourceContent {
  /** Extracted source text. */
  source: string;
  /** Start line (1-based). */
  startLine: number;
  /** End line (1-based). */
  endLine: number;
  /** Any parse errors encountered. */
  errors: string[];
}

/** Per-node context entry from `nexus.context`. */
export interface NexusContextNode {
  /** Node ID. */
  nodeId: string;
  /** Symbol name. */
  name: string | null;
  /** Node kind (function, method, class, …). */
  kind: string | null;
  /** Relative file path. */
  filePath: string | null;
  /** Start line (1-based), or null. */
  startLine: number | null;
  /** End line (1-based), or null. */
  endLine: number | null;
  /** Whether the symbol is exported. */
  isExported: boolean | null;
  /** One-line doc summary (if present). */
  docSummary: string | null;
  /** Community membership, or null. */
  community: { id: string | null; label: string | null } | null;
  /** Incoming call/import edges (callers). */
  callers: NexusContextRelation[];
  /** Outgoing call/import edges (callees). */
  callees: NexusContextRelation[];
  /** Process participation records. */
  processes: NexusContextProcess[];
  /** Source content (populated when opts.showContent is true). */
  source?: NexusContextSourceContent;
}

/** Result of `nexus.context`. */
export interface NexusContextResult {
  /** Original symbol query. */
  query: string;
  /** Project ID. */
  projectId: string;
  /** Total matching nodes count. */
  matchCount: number;
  /** Per-node context entries (up to 5). */
  results: NexusContextNode[];
}

/** Parameters for `nexus.projects.list`. */
export type NexusProjectsListParams = Record<string, never>;
/** Result of `nexus.projects.list`. */
export interface NexusProjectsListResult {
  /** All registered projects. */
  projects: NexusProjectRecord[];
  /** Count of projects returned. */
  count: number;
  /**
   * Every device known to the global store (`nexus_devices`, T12510), most
   * recent heartbeat first. A location's `deviceId` resolves against this list.
   */
  devices: NexusDeviceRecord[];
}

/**
 * One machine that runs CLEO against the global store (`nexus_devices`, T12510).
 * `deviceId` is the persisted `<cleoHome>/device-id` UUID that
 * {@link NexusProjectCheckout.deviceId} carries.
 */
export interface NexusDeviceRecord {
  /** Stable device id (`<cleoHome>/device-id`). */
  deviceId: string;
  /** Hostname at the last heartbeat. */
  hostname: string;
  /** Operating system (`process.platform`, e.g. `darwin`, `linux`, `win32`). */
  os: string;
  /** CPU architecture (`process.arch`, e.g. `arm64`, `x64`). */
  arch: string;
  /** CLEO version that sent the last heartbeat. */
  cleoVersion: string;
  /** ISO 8601 timestamp of the first heartbeat. */
  firstSeen: string;
  /** ISO 8601 timestamp of the most recent heartbeat. */
  lastHeartbeatAt: string;
  /** `true` for the device running this command. */
  current: boolean;
}

/**
 * One registry row a project NAME matched when the name is not unique
 * (T12510). Carried in the `E_NEXUS_PROJECT_AMBIGUOUS` error's
 * `details.candidates`; select one by its `projectId`.
 */
export interface NexusProjectCandidate {
  /** Immutable project id — pass this instead of the name. */
  projectId: string;
  /** Registered project name (shared by every candidate). */
  name: string;
  /** Most recently encountered checkout path. */
  path: string;
  /** ISO 8601 timestamp the project was last seen. */
  lastSeen: string;
}

/**
 * Why a git state probe could not describe (all of) a location (T12511).
 *
 * - `E_PATH_MISSING` — the location's directory does not exist.
 * - `E_PATH_ACCESS` — the directory exists but cannot be read (EACCES/EPERM).
 * - `E_NOT_GIT_REPO` — neither the directory nor its declared
 *   `evidence.gitRoot` is inside a git work tree.
 * - `E_GIT_TIMEOUT` — git did not finish inside the per-row budget (a lock,
 *   a credential prompt, a slow filesystem); its process group was killed.
 * - `E_GIT_FAILED` — git exited non-zero for another reason.
 * - `E_FETCH_FAILED` — `--fetch` was requested and the fetch failed; the local
 *   fields are still filled and remote fields describe the PREVIOUS fetch.
 */
export type NexusGitProbeErrorCode =
  | 'E_PATH_MISSING'
  | 'E_PATH_ACCESS'
  | 'E_NOT_GIT_REPO'
  | 'E_GIT_TIMEOUT'
  | 'E_GIT_FAILED'
  | 'E_FETCH_FAILED';

/**
 * Git state of one project location on one device (`nexus_project_git_state`,
 * T12511). Keyed like its location: `(projectId, deviceId, path)`.
 *
 * Remote fields (`ahead`, `behind`, `remoteHeadSha`) describe the remote as of
 * the LAST FETCH, never now: the probe does not touch the network unless asked.
 * `remoteFetchedAt` is that fetch's instant and `remoteStale` says whether it
 * is older than the staleness window (or unknown), so a `behind: 0` is never
 * read as "up to date" on the strength of a fetch from last month.
 */
export interface NexusProjectGitState {
  /** Immutable project id. */
  projectId: string;
  /** Registered project name, when the registry row is present. */
  projectName: string | null;
  /** Stable id of the device the location is on. */
  deviceId: string;
  /** `true` when `deviceId` is the device running this command. */
  current: boolean;
  /** Location path (the checkout root CLEO recorded). */
  path: string;
  /** Directory git actually ran in: `path`, or its declared `evidence.gitRoot`. */
  gitRoot: string | null;
  /** Checked-out branch; `null` when detached or unknown. */
  branch: string | null;
  /** HEAD commit; `null` for an unborn branch or when the probe failed. */
  headSha: string | null;
  /** `true` when HEAD is detached. */
  detached: boolean;
  /** `true` for a shallow clone (ahead/behind may be truncated by the graft). */
  shallow: boolean;
  /** Tracked entries with staged or unstaged changes (incl. conflicts). */
  dirtyCount: number | null;
  /** Untracked, not-ignored entries. */
  untrackedCount: number | null;
  /** Upstream ref (e.g. `origin/main`); `null` when none is configured. */
  upstream: string | null;
  /** Commits on HEAD not on the upstream, as of the last fetch. */
  ahead: number | null;
  /** Commits on the upstream not on HEAD, as of the last fetch. */
  behind: number | null;
  /** Remote the upstream belongs to, else `origin`, else the first remote. */
  remoteName: string | null;
  /** That remote's configured URL. */
  remoteUrl: string | null;
  /** Upstream tracking-ref commit, as of the last fetch. */
  remoteHeadSha: string | null;
  /** ISO 8601 instant of the last fetch (FETCH_HEAD mtime); `null` if never. */
  remoteFetchedAt: string | null;
  /** `true` when `remoteFetchedAt` is unknown or older than the staleness window. */
  remoteStale: boolean;
  /** ISO 8601 instant this probe ran. */
  probedAt: string;
  /** Wall time of the probe, milliseconds. */
  durationMs: number;
  /** Why the probe could not describe (all of) the location; `null` on success. */
  probeErrorCode: NexusGitProbeErrorCode | null;
  /** Human-readable detail for `probeErrorCode` (git's stderr, the errno, …). */
  probeError: string | null;
}

/** Parameters for `nexus.projects.status` (T12511). */
export interface NexusProjectsStatusParams {
  /** Run `git fetch` per location first (network). Default `false`. */
  fetch?: boolean;
  /** Locations probed at once. Default 8, clamped to 1..64. */
  concurrency?: number;
  /** Per-location budget for every git call it makes, ms. Default 10000 (30000 with fetch). */
  timeoutMs?: number;
  /** A fetch older than this is `remoteStale`, ms. Default 24h. */
  staleAfterMs?: number;
}

/** Result of `nexus.projects.status` (T12511). */
export interface NexusProjectsStatusResult {
  /** Fresh probes of this device's live and missing locations. */
  rows: NexusProjectGitState[];
  /** Last recorded state of locations on OTHER devices (not re-probed). */
  otherDevices: NexusProjectGitState[];
  /** Number of fresh rows. */
  count: number;
  /** Device the probe ran on. */
  deviceId: string;
  /** Whether a fetch was attempted. */
  fetched: boolean;
  /** Effective concurrency. */
  concurrency: number;
  /** Effective per-location timeout, ms. */
  timeoutMs: number;
  /** Effective staleness window, ms. */
  staleAfterMs: number;
  /** Wall time of the whole probe, ms. */
  durationMs: number;
  /** Aggregate counts over `rows`. */
  summary: {
    /** Rows with no probe error. */
    ok: number;
    /** Rows with a probe error. */
    errored: number;
    /** Rows that timed out. */
    timedOut: number;
    /** Rows with at least one dirty or untracked entry. */
    dirty: number;
    /** Rows whose remote state is stale. */
    remoteStale: number;
  };
}

/**
 * A condition on one project location in the fleet view (T12513).
 *
 * - `missing` — the location is recorded `missing`, or its last probe found no directory.
 * - `dirty` — the last probe saw tracked changes or untracked files.
 * - `behind` / `ahead` — the upstream had commits HEAD lacks / HEAD has commits
 *   the upstream lacks, as of the LAST FETCH (see `remote.fetchedAt`).
 * - `stale` — never probed, probed longer ago than the staleness window, or its
 *   remote was last fetched longer ago than the window (or never).
 * - `errored` — the last probe recorded a probe error.
 * - `unprobed` — no probe row exists for the location yet.
 */
export type NexusFleetFlag =
  | 'missing'
  | 'dirty'
  | 'behind'
  | 'ahead'
  | 'stale'
  | 'errored'
  | 'unprobed';

/** Parameters for `nexus.projects.fleet` (T12513). Filters combine with AND. */
export interface NexusProjectsFleetParams {
  /** Keep only locations on this device: a device id, a hostname, or `current`. */
  device?: string;
  /** Keep projects with a `missing` location. */
  missing?: boolean;
  /** Keep projects with a `dirty` location. */
  dirty?: boolean;
  /** Keep projects with a location `behind` its upstream (as of the last fetch). */
  behind?: boolean;
  /** Keep projects with a location `ahead` of its upstream (as of the last fetch). */
  ahead?: boolean;
  /** Keep projects with a `stale` location. */
  stale?: boolean;
  /** Keep projects with a location whose last probe errored. */
  errored?: boolean;
  /** Staleness window for probes, fetches and heartbeats, ms. Default 24h. */
  staleAfterMs?: number;
  /** Page size (projects). Default 50, max 500; `0` returns every match. */
  limit?: number;
  /** Projects skipped before the page. Default 0. */
  offset?: number;
}

/** One device as the fleet view shows it (T12513). */
export interface NexusFleetDevice {
  /** Stable device id (`<cleoHome>/device-id`). */
  deviceId: string;
  /** Hostname at the last heartbeat; `null` when the device never sent one. */
  hostname: string | null;
  /** Operating system at the last heartbeat. */
  os: string | null;
  /** CPU architecture at the last heartbeat. */
  arch: string | null;
  /** CLEO version at the last heartbeat. */
  cleoVersion: string | null;
  /** ISO 8601 instant of the last heartbeat; `null` if never. */
  lastHeartbeatAt: string | null;
  /** `true` when the last heartbeat is unknown or older than the staleness window. */
  heartbeatStale: boolean;
  /** `true` for the device running this command. */
  current: boolean;
}

/** Per-device counts in the fleet view (T12513). */
export interface NexusFleetDeviceSummary extends NexusFleetDevice {
  /** Visible (live or missing) locations on the device. */
  locations: number;
  /** Of those, locations flagged `missing`. */
  missing: number;
  /** Of those, locations flagged `dirty`. */
  dirty: number;
  /** Of those, locations flagged `behind`. */
  behind: number;
  /** Of those, locations flagged `stale`. */
  stale: number;
}

/**
 * Last recorded git state of one location (T12513, from T12511's probe rows).
 * Path-free, so a cloud mirror can carry it as replica presence.
 */
export interface NexusFleetGitSummary {
  /** Checked-out branch; `null` when detached or unknown. */
  branch: string | null;
  /** HEAD commit. */
  headSha: string | null;
  /** `true` when HEAD is detached. */
  detached: boolean;
  /** Tracked entries with changes. */
  dirtyCount: number | null;
  /** Untracked, not-ignored entries. */
  untrackedCount: number | null;
  /** Remote side, as of the last fetch — never "now". */
  remote: {
    /** Remote name. */
    name: string | null;
    /** Remote URL, credentials removed. */
    url: string | null;
    /** Upstream ref (e.g. `origin/main`). */
    upstream: string | null;
    /** Upstream tracking-ref commit. */
    headSha: string | null;
    /** Commits on HEAD not on the upstream. */
    ahead: number | null;
    /** Commits on the upstream not on HEAD. */
    behind: number | null;
    /** ISO 8601 instant of the last fetch; `null` if never. */
    fetchedAt: string | null;
    /** `true` when the last fetch is unknown or older than the staleness window. */
    stale: boolean;
  };
  /** ISO 8601 instant of the probe that recorded this state. */
  probedAt: string;
  /** `true` when `probedAt` is older than the staleness window. */
  probeStale: boolean;
  /** Probe error code, `null` on success. */
  probeErrorCode: NexusGitProbeErrorCode | null;
  /** Probe error detail. */
  probeError: string | null;
}

/** One place a project lives, on one device (T12513). */
export interface NexusFleetLocation {
  /** Device the location is on. */
  deviceId: string;
  /** Hostname of that device, when it has sent a heartbeat. */
  hostname: string | null;
  /** `true` when the location is on the device running this command. */
  current: boolean;
  /** Checkout root on that device. */
  path: string;
  /** Location lifecycle state. */
  state: 'live' | 'missing';
  /** ISO 8601 instant the location was last encountered. */
  lastSeen: string;
  /** Last recorded git state; `null` when never probed. */
  git: NexusFleetGitSummary | null;
  /** Conditions that hold for this location. */
  flags: NexusFleetFlag[];
}

/** One project in the fleet view (T12513). */
export interface NexusFleetProject {
  /** Immutable project id. */
  projectId: string;
  /** Registered name (not unique). */
  name: string;
  /** ISO 8601 instant of the last real CLI use; `null` if never recorded. */
  lastOpenedAt: string | null;
  /** ISO 8601 instant of the last health check, sync or git probe; `null` if never. */
  lastProbedAt: string | null;
  /** Number of distinct devices holding a visible location. */
  deviceCount: number;
  /** Union of the flags of its locations. */
  flags: NexusFleetFlag[];
  /** Every visible location (within the `device` filter), by device then path. */
  locations: NexusFleetLocation[];
}

/**
 * Result of `nexus.projects.fleet` (T12513). Counts come first; `projects` is
 * one page. Read-only: it reports the probe rows recorded by
 * `nexus.projects.status` and never runs git.
 */
export interface NexusProjectsFleetResult {
  /** Projects in the registry. */
  total: number;
  /** Projects matching the filters. */
  matched: number;
  /** Projects on this page. */
  returned: number;
  /** Offset of this page. */
  offset: number;
  /** Page size applied (`0` = unbounded). */
  limit: number;
  /** `true` when more matches follow this page. */
  hasMore: boolean;
  /** Staleness window applied, ms. */
  staleAfterMs: number;
  /** ISO 8601 instant staleness was evaluated at. */
  generatedAt: string;
  /** Device the command ran on. */
  currentDeviceId: string;
  /** Fleet-wide counts of PROJECTS with at least one location in each condition (within `device`). */
  summary: {
    /** Projects with a visible location. */
    located: number;
    /** Distinct visible locations. */
    locations: number;
    /** Projects flagged per condition. */
    missing: number;
    /** Projects with a dirty location. */
    dirty: number;
    /** Projects with a location behind its upstream. */
    behind: number;
    /** Projects with a location ahead of its upstream. */
    ahead: number;
    /** Projects with a stale location. */
    stale: number;
    /** Projects with an errored probe. */
    errored: number;
    /** Projects with a never-probed location. */
    unprobed: number;
  };
  /** Every device holding a visible location or known by heartbeat, with counts. */
  devices: NexusFleetDeviceSummary[];
  /** This page of projects, by name then id. */
  projects: NexusFleetProject[];
}

/** Parameters for `nexus.projects.register`. */
export interface NexusProjectsRegisterParams {
  /** Path to the project directory (required). */
  path: string;
  /** Custom project name (optional). */
  name?: string;
}
/** Result of `nexus.projects.register`. */
export interface NexusProjectsRegisterResult {
  hash: string;
  path: string;
}

/** Parameters for `nexus.projects.remove`. */
export interface NexusProjectsRemoveParams {
  /** Project name or hash to remove (required). */
  nameOrHash: string;
}
/** Result of `nexus.projects.remove`. */
export interface NexusProjectsRemoveResult {
  removed: string;
}

/** Parameters for `nexus.projects.scan`. */
export interface NexusProjectsScanParams {
  /** Comma-separated search roots (optional). */
  roots?: string;
  /** Maximum directory traversal depth (default: 4). */
  maxDepth?: number;
  /** Auto-register all discovered unregistered projects. */
  autoRegister?: boolean;
  /** Also report already-registered projects. */
  includeExisting?: boolean;
}
/** Auto-register error entry from `nexus.projects.scan`. */
export interface NexusScanAutoRegisterError {
  /** Project path that failed to auto-register. */
  path: string;
  /** Error message. */
  error: string;
}
/** Result of `nexus.projects.scan`. */
export interface NexusProjectsScanResult {
  /** Search roots actually walked. */
  roots: string[];
  /** Unregistered project paths found. */
  unregistered: string[];
  /** Already-registered project paths (only populated when includeExisting). */
  registered: string[];
  /** Summary counts. */
  tally: { total: number; unregistered: number; registered: number };
  /** Paths auto-registered (only when autoRegister). */
  autoRegistered: string[];
  /** Auto-register errors (only when autoRegister). */
  autoRegisterErrors: NexusScanAutoRegisterError[];
}

/** Parameters for `nexus.projects.clean`. */
export interface NexusProjectsCleanParams {
  /** Dry-run only (no deletions). */
  dryRun?: boolean;
  /** JS regex matched against project_path. */
  pattern?: string;
  /** Match paths containing a .temp/ segment or under the OS temp directory (T12324). */
  includeTemp?: boolean;
  /** Match paths containing tmp/test(s)/__tests__/fixture(s)/scratch/sandbox segments. */
  includeTests?: boolean;
  /** Also match unhealthy rows. */
  matchUnhealthy?: boolean;
  /** Also match never-indexed rows. */
  matchNeverIndexed?: boolean;
  /** Also match rows whose project_path does not exist on disk (T9117). */
  matchOrphaned?: boolean;
  /** Also `rm -rf` matched paths from disk after DB delete (T9117). */
  removeFs?: boolean;
  /** VACUUM the GLOBAL registry store (`<cleoHome>/cleo.db`) after delete (T9117 · T12324). */
  vacuum?: boolean;
}

/**
 * Lifecycle state of one project location in `nexus_project_locations` (T12469).
 * `candidate` (T12470): the checkout declares the id but was never confirmed —
 * it holds no registry binding and no permissions until promoted explicitly.
 */
export type NexusProjectLocationState = 'live' | 'missing' | 'superseded' | 'candidate';

/** One recorded location (checkout) of a project on a device (T12354 · T12469). */
export interface NexusProjectCheckout {
  /** Absolute checkout root on the device named by `deviceId`. */
  projectPath: string;
  /** Path fingerprint of the checkout. */
  projectHash: string;
  /** ISO 8601 timestamp the checkout was first recorded. */
  firstSeen: string;
  /** ISO 8601 timestamp the checkout was last encountered. */
  lastSeen: string;
  /** Whether the checkout directory exists now (always `false` for another device). */
  exists: boolean;
  /** Stable id of the device the checkout is on (T12469). */
  deviceId: string;
  /** Location state: `live`, `missing` (directory gone) or `superseded` (T12469). */
  state: NexusProjectLocationState;
}

/** Why a registry row matched `nexus.projects.clean` criteria (T12324). */
export type NexusProjectsCleanReason =
  | 'pattern'
  | 'temp-path'
  | 'test-path'
  | 'unhealthy'
  | 'never-indexed'
  | 'missing-path'
  | 'path-divergent-duplicate';

/**
 * Criteria-independent classification of every registry row (T12324).
 *
 * Categories overlap (a missing temp dir counts in both); `stale` is their
 * union and `retained` its complement.
 */
export interface NexusRegistryClassification {
  /** Registry rows scanned. */
  total: number;
  /** Rows whose `project_path` no longer exists on disk. */
  missingPath: number;
  /** Rows under a `.temp/` segment or the OS temp directory. */
  tempPath: number;
  /** Rows with a tmp/test(s)/__tests__/fixture(s)/scratch/sandbox path segment. */
  testPath: number;
  /** Rows in at least one of the categories above. */
  stale: number;
  /** Rows in none of the categories above. */
  retained: number;
  /** Rows in `nexus_project_id_aliases`. */
  aliases: number;
  /** Alias rows whose canonical project no longer has a registry row. */
  orphanAliases: number;
}

/** One registry row removed by `nexus.projects.clean` (T12324). */
export interface NexusProjectsCleanRemoval {
  /** Immutable registry project ID. */
  projectId: string;
  /** Registered project path. */
  projectPath: string;
  /** Every criterion the row matched. */
  reasons: NexusProjectsCleanReason[];
}

/** Durable record of an applied `nexus.projects.clean` (T12324). */
export interface NexusProjectsCleanReceipt {
  /** `nexus_audit_log.id` written in the same transaction as the deletes. */
  auditId: string;
  /** Global store the rows were removed from. */
  storePath: string;
  /** Every removed registry row. */
  removed: NexusProjectsCleanRemoval[];
  /** Alias rows removed because their project row was removed. */
  aliasesRemoved: number;
  /** Pre-existing orphan alias rows swept in the same transaction. */
  orphanAliasesRemoved: number;
  /** Global store size before/after VACUUM, when `vacuum` was requested. */
  vacuum?: { beforeBytes: number; afterBytes: number };
}

/** Result of `nexus.projects.clean`. */
export interface NexusProjectsCleanResult {
  /** Whether this was a dry-run (no deletions performed). */
  dryRun: boolean;
  /** Number of rows matching criteria. */
  matched: number;
  /** Number of rows actually deleted (0 when dryRun is true). */
  purged: number;
  /** Rows remaining after deletion. */
  remaining: number;
  /** Sample of matched project paths (first 10). */
  sample: string[];
  /** Total registry rows scanned. */
  totalCount: number;
  /** Number of on-disk paths removed when `removeFs` is set (T9117). */
  fsRemoved?: number;
  /** Number of on-disk paths that failed to remove (T9117). */
  fsFailed?: number;
  /** Bytes freed by VACUUM when `vacuum` is set (T9117). */
  vacuumBytesFreed?: number;
  /** Classification of every registry row, independent of criteria (T12324). */
  classification: NexusRegistryClassification;
  /** Matched-row counts per criterion; a row matching several counts in each (T12324). */
  matchedByReason: Partial<Record<NexusProjectsCleanReason, number>>;
  /** Receipt of the applied removal; absent on dry-run or when nothing matched (T12324). */
  receipt?: NexusProjectsCleanReceipt;
  /**
   * Matched rows that were NOT removed because their id was found at another
   * path (T12471): the project moved, it is not an orphan. Absent when none.
   */
  relocated?: NexusProjectsCleanRelocated[];
  /**
   * Matched rows that were NOT removed because their path could not be read
   * (EACCES, EPERM, timeout): only ENOENT/ENOTDIR or a different declared id
   * prove a project gone (T12471). Absent when none.
   */
  unreadable?: NexusProjectsCleanUnreadable[];
  /**
   * Matched rows that were NOT removed because their path exists but declares
   * another project id (T12471). `.cleo/project-id` is tracked, so a branch
   * checkout, rebase or merge conflict flips it transiently; only an absent
   * path proves a project gone. Absent when none.
   */
  idMismatch?: NexusProjectsCleanIdMismatch[];
}

/** A registry row `nexus.projects.clean` kept because its path declares another id (T12471). */
export interface NexusProjectsCleanIdMismatch {
  /** Immutable registry project ID. */
  projectId: string;
  /** Registered path. */
  projectPath: string;
  /** The id the path declares now. */
  declares: string;
}

/** A registry row `nexus.projects.clean` kept because its path was unreadable (T12471). */
export interface NexusProjectsCleanUnreadable {
  /** Immutable registry project ID. */
  projectId: string;
  /** Registered path that could not be read. */
  projectPath: string;
}

/**
 * A registry row `nexus.projects.clean` refused to remove because its project
 * id was found at another path on this device (T12471).
 */
export interface NexusProjectsCleanRelocated {
  /** Immutable registry project ID. */
  projectId: string;
  /** Registered path (gone from disk). */
  projectPath: string;
  /** Path(s) that declare the same id now. */
  foundAt: string[];
  /** Exact command that rebinds the row instead of deleting it. */
  remedy: string;
}

/**
 * Classification of one registry row by `cleo doctor projects` (T12471).
 *
 * - `ok` — the registered path holds the project.
 * - `moved` — the path provably no longer holds it and another path on this
 *   device declares the id. `--apply` rebinds the row only when that path's
 *   untracked checkout nonce equals one recorded for the id (`proof:
 *   'nonce'`); an `id-only` match (a clone, a copied `.cleo/project-id`) is
 *   reported with the `cleo doctor project-identity --resolve` remedy and
 *   never applied. Trash, CLEO-home, tombstoned and reroot-demoted paths are
 *   never targets.
 * - `ambiguous` — the path is gone and several paths carry the id's nonce;
 *   the operator confirms one with `cleo doctor project-identity --resolve`.
 * - `split` — one project under two ids, proven by repository evidence: the
 *   registered path is gone and a same-named path with the same git remote or
 *   root commit holds a different id (a re-minted identity), or two registered
 *   rows, neither nested in another registered project, share a git remote.
 *   Never changed automatically.
 * - `possible-split` — the path is gone and a same-named path holds another
 *   id, with no repository evidence tying them: informational (inspect, never
 *   rewrite or unregister the other project). `--apply` still records the
 *   gone location as `missing`.
 * - `missing` — the path is gone and the id was found nowhere. `--apply`
 *   records the location as `missing`; the row is kept.
 * - `temp` — the path is under a temp directory while the registry is
 *   persistent (a fixture or scratch directory left in the registry).
 * - `root` — the path is the home directory or a filesystem root.
 * - `unreadable` — the path could not be read (EACCES, EPERM, timeout). Only
 *   ENOENT/ENOTDIR prove a path gone, so nothing is changed.
 * - `other-device` — the path was recorded on another device; not probed.
 */
export type NexusRegistryFindingKind =
  | 'ok'
  | 'moved'
  | 'ambiguous'
  | 'split'
  | 'possible-split'
  | 'missing'
  | 'temp'
  | 'root'
  | 'unreadable'
  | 'other-device';

/** The other side of a split identity (T12471). */
export interface NexusRegistrySplitPeer {
  /** The other project id. */
  projectId: string;
  /** Where the other id lives. */
  projectPath: string;
  /** Whether the other id has its own registry row. */
  registered: boolean;
  /** What paired the two ids: a shared git remote or root commit, or the directory name alone. */
  matchedBy: 'name' | 'remote' | 'root-commit';
}

/** One registry row as classified by `cleo doctor projects` (T12471). */
export interface NexusRegistryFinding {
  /** Immutable registry project ID. */
  projectId: string;
  /** Registered project name. */
  name: string;
  /** Registered path (may be a `superseded:<id>` sentinel). */
  projectPath: string;
  /** Classification. */
  kind: NexusRegistryFindingKind;
  /** One-line explanation. */
  message: string;
  /** Exact command(s) that fix it, or `null` when nothing needs fixing. */
  remedy: string | null;
  /** `true` when `--apply` changes registry rows for this finding. */
  applicable: boolean;
  /** Paths on this device that declare this id (`moved`, `ambiguous`). */
  foundAt?: string[];
  /**
   * What ties a `moved` checkout to the row: `nonce` when its untracked
   * checkout nonce equals one recorded for the id (a real move), `id-only`
   * when only the committed id matches.
   */
  proof?: 'nonce' | 'id-only';
  /** The other ids of a `split` or `possible-split` identity. */
  splitWith?: NexusRegistrySplitPeer[];
}

/**
 * An alias key that more than one registered project claims (T12589).
 *
 * The legacy project id encodes only the first 24 bytes of a path, so every
 * project under a long shared prefix derives the same key. Such a key names
 * no project: resolvers refuse it, and `cleo doctor projects --apply` removes
 * its alias row under a receipt.
 */
export interface NexusRegistryAmbiguousAlias {
  /** The alias key (`nexus_project_id_aliases.legacy_id`). */
  legacyId: string;
  /** The project the alias row currently points at (the first to record it). */
  canonicalId: string;
  /** Every registered project that claims the key, sorted. */
  claimants: string[];
  /** One-line explanation. */
  message: string;
  /** Exact command that removes the row. */
  remedy: string;
}

/** One registry change made by `cleo doctor projects --apply` (T12471). */
export interface NexusRegistryRepairAction {
  /**
   * `rebind` points the row at `to`; `mark-missing` records the location as
   * `missing`; `drop-ambiguous-alias` removes the alias row for `alias`
   * (T12589).
   */
  action: 'rebind' | 'mark-missing' | 'drop-ambiguous-alias';
  /** Project the action applies to (for an alias, the row's `canonical_id`). */
  projectId: string;
  /** Registered path before the action. */
  from: string;
  /** New registered path (`rebind` only). */
  to?: string;
  /** Alias key removed (`drop-ambiguous-alias` only). */
  alias?: string;
  /** `applied`, or `skipped` when the row changed between inspection and apply. */
  outcome: 'applied' | 'skipped';
}

/** Durable receipt of an applied `cleo doctor projects` run (T12471). */
export interface NexusRegistryRepairReceipt {
  /** `nexus_audit_log.id` written in the same transaction as the changes. */
  receiptId: string;
  /** Absolute path of the global registry store that was changed. */
  storePath: string;
  /** ISO 8601 timestamp of the apply. */
  appliedAt: string;
  /** Every action, in order. */
  actions: NexusRegistryRepairAction[];
  /** Registry row count before and after; equal counts show no row was lost. */
  registryRows: { before: number; after: number };
  /** Exact command that restores the prior rows. */
  rollback: string;
}

/** Result of `cleo doctor projects` (dry run or apply) (T12471). */
export interface NexusRegistryIntegrityReport {
  /** `true` when nothing was written. */
  dryRun: boolean;
  /** Absolute path of the global registry store inspected. */
  storePath: string;
  /** Directories scanned for `.cleo/project-id`. */
  roots: string[];
  /** Scan coverage: projects found, and directories that timed out or were unreadable. */
  scan: { projectsFound: number; timedOut: string[]; unreadable: string[] };
  /** Registry rows per kind; every row is counted. */
  counts: Record<NexusRegistryFindingKind, number>;
  /** Every row whose kind is not `ok`. */
  findings: NexusRegistryFinding[];
  /** Alias rows whose key more than one project claims (T12589). */
  ambiguousAliases: NexusRegistryAmbiguousAlias[];
  /** Receipt of the applied changes; absent on a dry run or when nothing applied. */
  receipt?: NexusRegistryRepairReceipt;
}

/** Result of `cleo doctor projects --rollback <receiptId>` (T12471). */
export interface NexusRegistryRollbackResult {
  /** The receipt that was rolled back. */
  receiptId: string;
  /** `nexus_audit_log.id` of the rollback itself. */
  rollbackReceiptId: string;
  /** Rows written back per table (`aliases` when the repair removed alias rows). */
  restored: { registry: number; locations: number; paths: number; aliases?: number };
}

/** Parameters for `nexus.refresh-bridge`. */
export interface NexusRefreshBridgeParams {
  /** Path to project directory (optional, defaults to cwd). */
  repoPath?: string;
  /** Override the project ID. */
  projectId?: string;
}
/** Result of `nexus.refresh-bridge`. */
export interface NexusRefreshBridgeResult {
  path: string;
  written: boolean;
  projectId: string;
  repoPath: string;
}

/** Parameters for `nexus.diff`. */
export interface NexusDiffParams {
  /** Git ref for the "before" snapshot (default: HEAD~1). */
  beforeRef?: string;
  /** Git ref for the "after" snapshot (default: HEAD). */
  afterRef?: string;
  /** Repository path (optional, defaults to cwd). */
  repoPath?: string;
  /** Override the project ID. */
  projectId?: string;
}
/** Health classification for a nexus index diff result. */
export type NexusDiffHealth =
  | 'STABLE'
  | 'RELATIONS_ADDED'
  | 'RELATIONS_REDUCED'
  | 'REGRESSIONS_DETECTED';
/** Result of `nexus.diff`. */
export interface NexusDiffResult {
  /** Resolved "before" ref. */
  beforeRef: string;
  /** Resolved "after" ref. */
  afterRef: string;
  /** Short SHA for beforeRef. */
  beforeSha: string;
  /** Short SHA for afterRef. */
  afterSha: string;
  /** Project ID. */
  projectId: string;
  /** Absolute repository path. */
  repoPath: string;
  /** Changed files detected between the refs. */
  changedFiles: string[];
  /** Node count before the incremental run. */
  nodesBefore: number;
  /** Node count after. */
  nodesAfter: number;
  /** New nodes added. */
  newNodes: number;
  /** Nodes removed. */
  removedNodes: number;
  /** Relation count before. */
  relationsBefore: number;
  /** Relation count after. */
  relationsAfter: number;
  /** New relations added. */
  newRelations: number;
  /** Relations removed. */
  removedRelations: number;
  /** Health classification. */
  healthStatus: NexusDiffHealth;
  /** Regression messages (empty if none). */
  regressions: string[];
}

/** Parameters for `nexus.query-cte`. */
export interface NexusQueryCteParams {
  /** CTE SQL or template alias (required). */
  cte: string;
  /** Positional parameters for the CTE (optional). */
  params?: string[];
}
/**
 * Result of `nexus.query-cte`.
 *
 * Rows returned from a recursive CTE query against nexus.db,
 * plus execution metadata.
 *
 * @see NexusCteResult in nexus-query-ops.ts (T1057)
 */
export type NexusQueryCteResult = NexusCteResult;

/** One hot-path relation edge. */
export interface NexusHotPath {
  sourceId: string;
  targetId: string;
  type: string;
  weight: number;
  lastAccessedAt: string | null;
  coAccessedCount: number;
}
/** Parameters for `nexus.hot-paths`. */
export interface NexusHotPathsParams {
  /** Maximum number of edges to return (default: 20). */
  limit?: number;
}
/** Result of `nexus.hot-paths`. */
export interface NexusHotPathsResult {
  paths: NexusHotPath[];
  count: number;
  note?: string;
}

/** One hot-node symbol. */
export interface NexusHotNode {
  nodeId: string;
  sourceId: string;
  label: string;
  filePath: string | null;
  kind: string;
  totalWeight: number;
  pathCount: number;
}
/** Parameters for `nexus.hot-nodes`. */
export interface NexusHotNodesParams {
  /** Maximum number of nodes to return (default: 20). */
  limit?: number;
}
/** Result of `nexus.hot-nodes`. */
export interface NexusHotNodesResult {
  nodes: NexusHotNode[];
  count: number;
  note?: string;
}

/** One cold symbol. */
export interface NexusColdSymbol {
  nodeId: string;
  sourceId: string;
  label: string;
  filePath: string | null;
  kind: string;
  lastAccessedAt: string | null;
  lastAccessed: string | null;
  ageDays: number | null;
  pathCount: number;
  maxWeight: number;
}
/** Parameters for `nexus.cold-symbols`. */
export interface NexusColdSymbolsParams {
  /** Age threshold in days (default: 30). */
  days?: number;
}
/** Result of `nexus.cold-symbols`. */
export interface NexusColdSymbolsResult {
  symbols: NexusColdSymbol[];
  count: number;
  thresholdDays: number;
  note?: string;
}

// ============================================================================
// Typed Operations Union (T1424 — Wave D typed-dispatch migration)
// ============================================================================

/**
 * All Nexus domain operations mapped to their [Params, Result] tuples.
 *
 * This type enables {@link TypedDomainHandler} to provide compile-time safety
 * for every nexus operation, eliminating the ~76 type casts in the legacy
 * handler pattern (T988 audit follow-on).
 *
 * @task T1424 — Nexus domain typed narrowing
 */
export type NexusOps = {
  readonly status: readonly [NexusStatusParams, NexusStatusResult];
  readonly list: readonly [NexusListParams, NexusListResult];
  readonly show: readonly [NexusShowParams, NexusShowResult];
  readonly resolve: readonly [NexusResolveParams, NexusResolveResult];
  readonly deps: readonly [NexusDepsParams, NexusDepsResult];
  readonly graph: readonly [NexusGraphParams, NexusGraphResult];
  readonly 'path.show': readonly [NexusPathShowParams, NexusPathShowResult];
  readonly 'blockers.show': readonly [NexusBlockersShowParams, NexusBlockersShowResult];
  readonly 'orphans.list': readonly [NexusOrphansListParams, NexusOrphansListResult];
  readonly discover: readonly [NexusDiscoverParams, NexusDiscoverResult];
  readonly search: readonly [NexusSearchParams, NexusSearchResult];
  readonly augment: readonly [NexusAugmentParams, NexusAugmentResult];
  readonly 'share.status': readonly [NexusShareStatusParams, NexusShareStatusResult];
  readonly 'transfer.preview': readonly [NexusTransferPreviewParams, NexusTransferPreviewResult];
  readonly 'top-entries': readonly [NexusTopEntriesParams, NexusTopEntriesResult];
  readonly impact: readonly [NexusImpactParams, NexusImpactResult];
  readonly 'full-context': readonly [NexusFullContextParams, NexusFullContextResult];
  readonly 'task-footprint': readonly [NexusTaskFootprintParams, NexusTaskFootprintResult];
  readonly 'brain-anchors': readonly [NexusBrainAnchorsParams, NexusBrainAnchorsResult];
  readonly why: readonly [NexusWhyParams, NexusWhyResult];
  readonly 'impact-full': readonly [NexusImpactFullParams, NexusImpactFullResult];
  readonly 'route-map': readonly [NexusRouteMapParams, NexusRouteMapResult];
  readonly 'shape-check': readonly [NexusShapeCheckParams, NexusShapeCheckResult];
  readonly 'search-code': readonly [NexusSearchCodeParams, NexusSearchCodeResult];
  readonly wiki: readonly [NexusWikiParams, NexusWikiResult];
  readonly 'contracts-show': readonly [NexusContractsShowParams, NexusContractsShowResult];
  readonly 'task-symbols': readonly [NexusTaskSymbolsParams, NexusTaskSymbolsResult];
  readonly 'profile.view': readonly [NexusProfileViewParams, NexusProfileViewResult];
  readonly 'profile.get': readonly [NexusProfileGetParams, NexusProfileGetResult];
  readonly 'profile.import': readonly [NexusProfileImportParams, NexusProfileImportResult];
  readonly 'profile.export': readonly [NexusProfileExportParams, NexusProfileExportResult];
  readonly 'profile.reinforce': readonly [NexusProfileReinforceParams, NexusProfileReinforceResult];
  readonly 'profile.upsert': readonly [NexusProfileUpsertParams, NexusProfileUpsertResult];
  readonly 'profile.supersede': readonly [NexusProfileSupersedeParams, NexusProfileSupersedeResult];
  readonly 'sigil.list': readonly [NexusSigilListParams, NexusSigilListResult];
  readonly 'sigil.sync': readonly [NexusSigilSyncParams, NexusSigilSyncResult];
  readonly init: readonly [NexusInitParams, NexusInitResult];
  readonly register: readonly [NexusRegisterParams, NexusRegisterResult];
  readonly unregister: readonly [NexusUnregisterParams, NexusUnregisterResult];
  readonly sync: readonly [NexusSyncParams, NexusSyncResult];
  readonly 'permission.set': readonly [NexusPermissionSetParams, NexusPermissionSetResult];
  readonly reconcile: readonly [NexusReconcileParams, NexusReconcileResult];
  readonly 'share.snapshot.export': readonly [
    NexusShareSnapshotExportParams,
    NexusShareSnapshotExportResult,
  ];
  readonly 'share.snapshot.import': readonly [
    NexusShareSnapshotImportParams,
    NexusShareSnapshotImportResult,
  ];
  readonly transfer: readonly [NexusTransferParams, NexusTransferResult];
  readonly 'contracts-sync': readonly [NexusContractsSyncParams, NexusContractsSyncResult];
  readonly 'contracts-link-tasks': readonly [
    NexusContractsLinkTasksParams,
    NexusContractsLinkTasksResult,
  ];
  readonly 'conduit-scan': readonly [NexusConduitScanParams, NexusConduitScanResult];
  // T1510 — Phase 2 dispatch ops
  readonly clusters: readonly [NexusClustersParams, NexusClustersResult];
  readonly flows: readonly [NexusFlowsParams, NexusFlowsResult];
  readonly context: readonly [NexusContextParams, NexusContextResult];
  readonly 'projects.list': readonly [NexusProjectsListParams, NexusProjectsListResult];
  readonly 'projects.register': readonly [NexusProjectsRegisterParams, NexusProjectsRegisterResult];
  readonly 'projects.remove': readonly [NexusProjectsRemoveParams, NexusProjectsRemoveResult];
  readonly 'projects.scan': readonly [NexusProjectsScanParams, NexusProjectsScanResult];
  readonly 'projects.clean': readonly [NexusProjectsCleanParams, NexusProjectsCleanResult];
  readonly 'projects.status': readonly [NexusProjectsStatusParams, NexusProjectsStatusResult];
  readonly 'projects.fleet': readonly [NexusProjectsFleetParams, NexusProjectsFleetResult];
  readonly 'refresh-bridge': readonly [NexusRefreshBridgeParams, NexusRefreshBridgeResult];
  readonly diff: readonly [NexusDiffParams, NexusDiffResult];
  readonly 'query-cte': readonly [NexusQueryCteParams, NexusQueryCteResult];
  readonly 'hot-paths': readonly [NexusHotPathsParams, NexusHotPathsResult];
  readonly 'hot-nodes': readonly [NexusHotNodesParams, NexusHotNodesResult];
  readonly 'cold-symbols': readonly [NexusColdSymbolsParams, NexusColdSymbolsResult];
};
