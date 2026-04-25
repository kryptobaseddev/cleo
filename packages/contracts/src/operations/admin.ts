/**
 * Admin Domain Operations Contract (46 operations)
 *
 * Query operations: 24
 *   version, health (query), config.show, config.presets, stats, context,
 *   context.pull, runtime, paths, job (status + list via action param),
 *   dash, log, sequence, help, token (summary + list + show via action param),
 *   adr.find, adr.show, backup (list), export, map (query), roadmap, smoke,
 *   smoke.provider, hooks.matrix
 *
 * Mutate operations: 19
 *   init, scaffold-hub, health (repair/diagnose via mode param),
 *   config.set, config.set-preset, backup (create + restore + restore.file
 *   via action param), migrate, cleanup, job.cancel, safestop,
 *   inject.generate, adr.sync, import, detect, token (record + delete + clear
 *   via action param), context.inject, map (mutate), install.global
 *
 * SYNC: Implementation lives in packages/cleo/src/dispatch/domains/admin.ts.
 * Typed via TypedDomainHandler<AdminOps> once the T983 migration lands.
 * This is the largest domain — 107 type-cast sites targeted for removal.
 *
 * @task T1035
 * @task T983 — TypedDomainHandler migration
 * @see packages/cleo/src/dispatch/domains/admin.ts
 */

// ============================================================================
// Shared primitive types
// ============================================================================

/**
 * Known transport categories for token recording.
 * Mirrors `TokenTransport` from `@cleocode/core`.
 */
export type AdminTokenTransport = 'cli' | 'api' | 'agent' | 'unknown';

/**
 * Token measurement method classification.
 * Mirrors `TokenMethod` from `@cleocode/core`.
 */
export type AdminTokenMethod = 'otel' | 'provider_api' | 'tokenizer' | 'heuristic';

/**
 * Token measurement confidence level.
 * Mirrors `TokenConfidence` from `@cleocode/core`.
 */
export type AdminTokenConfidence = 'real' | 'high' | 'estimated' | 'coarse';

/**
 * Export scope selector for the unified `admin.export` operation.
 * - `undefined` / default — standard task CSV/JSON export
 * - `"snapshot"` — full project snapshot
 * - `"tasks"` — portable cross-project task package
 */
export type AdminExportScope = 'snapshot' | 'tasks' | undefined;

/**
 * Import scope selector for the unified `admin.import` operation.
 * - `undefined` / default — standard task import from file
 * - `"snapshot"` — full project snapshot restore
 * - `"tasks"` — portable cross-project task package import
 */
export type AdminImportScope = 'snapshot' | 'tasks' | undefined;

/**
 * Backup action discriminator for the unified `admin.backup` mutate operation.
 * - `undefined` / default — create a new backup
 * - `"restore"` — restore by backup ID
 * - `"restore.file"` — restore from an arbitrary backup file path
 */
export type AdminBackupAction = 'restore' | 'restore.file' | undefined;

/**
 * ADR status filter values.
 */
export type AdminAdrStatus = 'proposed' | 'accepted' | 'superseded' | 'deprecated';

/**
 * Strictness preset identifiers.
 */
export type AdminStrictnessPreset = 'strict' | 'standard' | 'minimal';

/**
 * Spawn implementation classification for a provider adapter.
 */
export type AdminSpawnStatus = 'yes' | 'stub' | 'no';

// ============================================================================
// Shared sub-record shapes
// ============================================================================

/**
 * A single backup entry (from backup list).
 */
export interface AdminBackupEntry {
  /** Unique backup identifier (timestamped). */
  backupId: string;
  /** Backup category (`snapshot`, `safety`, `migration`). */
  type: string;
  /** ISO-8601 timestamp when the backup was created. */
  timestamp: string;
  /** Optional human-readable note attached at creation time. */
  note?: string;
  /** File names captured in this backup. */
  files: string[];
}

/**
 * A single entry in the operation log.
 */
export interface AdminLogEntry {
  /** Operation name. */
  operation: string;
  /** Task ID if applicable. */
  taskId?: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Additional log fields (varies by operation). */
  [key: string]: unknown;
}

/**
 * Pagination metadata companion for log/token list results.
 */
export interface AdminPagination {
  /** Total matching entries. */
  total: number;
  /** Current offset. */
  offset: number;
  /** Page size limit. */
  limit: number;
  /** Whether more entries exist beyond this page. */
  hasMore: boolean;
}

/**
 * A single health check result.
 */
export interface AdminHealthCheck {
  /** Check identifier. */
  name: string;
  /** Pass/warn/fail outcome. */
  status: 'pass' | 'warn' | 'fail';
  /** Human-readable message. */
  message?: string;
}

/**
 * A single doctor check result.
 */
export interface AdminDoctorCheck {
  /** Check name. */
  check: string;
  /** Outcome. */
  status: 'ok' | 'error' | 'warning';
  /** Human-readable message. */
  message: string;
  /** Additional check-specific data. */
  details?: Record<string, unknown>;
  /** Suggested fix command. */
  fix?: string;
}

/**
 * An individual token usage record (from `admin.token` list/show).
 */
export interface AdminTokenRecord {
  /** Record identifier. */
  id: string;
  /** Provider name. */
  provider?: string;
  /** Model name. */
  model?: string;
  /** Transport category. */
  transport?: AdminTokenTransport;
  /** Gateway identifier. */
  gateway?: string;
  /** Domain the call was made from. */
  domain?: string;
  /** Operation name within the domain. */
  operation?: string;
  /** Session ID, if captured. */
  sessionId?: string;
  /** Task ID, if captured. */
  taskId?: string;
  /** Request ID, if captured. */
  requestId?: string;
  /** Input tokens consumed. */
  inputTokens?: number;
  /** Output tokens produced. */
  outputTokens?: number;
  /** Total tokens (input + output). */
  totalTokens?: number;
  /** Measurement method. */
  method?: AdminTokenMethod;
  /** Measurement confidence. */
  confidence?: AdminTokenConfidence;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

/**
 * Per-method token breakdown row in the summary.
 */
export interface AdminTokenMethodBreakdown {
  /** Measurement method. */
  method: string;
  /** Record count. */
  count: number;
  /** Total tokens for this method. */
  totalTokens: number;
}

/**
 * Per-transport token breakdown row in the summary.
 */
export interface AdminTokenTransportBreakdown {
  /** Transport category. */
  transport: string;
  /** Record count. */
  count: number;
  /** Total tokens for this transport. */
  totalTokens: number;
}

/**
 * Per-operation token breakdown row in the summary.
 */
export interface AdminTokenOperationBreakdown {
  /** Domain + operation key. */
  key: string;
  /** Record count. */
  count: number;
  /** Total tokens for this operation. */
  totalTokens: number;
}

/**
 * A single ADR record (summary form, used in lists and find results).
 */
export interface AdminAdrSummary {
  /** ADR identifier (e.g. `ADR-007`). */
  id: string;
  /** ADR title. */
  title: string;
  /** Lifecycle status. */
  status: string;
  /** ISO date string from frontmatter. */
  date: string;
  /** Relative file path from project root. */
  filePath: string;
}

/**
 * A single ADR record (full form, returned by `admin.adr.show`).
 */
export interface AdminAdrRecord extends AdminAdrSummary {
  /** Parsed ADR frontmatter fields. */
  frontmatter: {
    Date: string;
    Status: AdminAdrStatus;
    Accepted?: string;
    Supersedes?: string;
    'Superseded By'?: string;
    Amends?: string;
    'Amended By'?: string;
    'Related ADRs'?: string;
    'Related Tasks'?: string;
    Gate?: 'HITL' | 'automated';
    'Gate Status'?: 'pending' | 'passed' | 'waived';
    Summary?: string;
    Keywords?: string;
    Topics?: string;
  };
}

/**
 * A single smoke probe result.
 */
export interface AdminSmokeProbe {
  /** Domain probed. */
  domain: string;
  /** Operation probed within the domain. */
  operation: string;
  /** Probe outcome. */
  status: 'pass' | 'fail' | 'skip';
  /** Wall-clock duration in milliseconds. */
  timeMs: number;
  /** Error message when status is `fail`. */
  error?: string;
}

/**
 * Locality check for a single CLEO-owned database (from `admin.smoke.provider`).
 */
export interface AdminDbLocalityCheck {
  /** Database name (e.g. `"brain.db"`). */
  name: string;
  /** Whether the DB path resolves under CLEO-owned storage. */
  local: boolean;
  /** Resolved absolute path. */
  path: string;
}

/**
 * Per-provider hook coverage summary row (from `admin.hooks.matrix`).
 */
export interface AdminProviderMatrixEntry {
  /** CAAMP provider identifier (e.g. `"claude-code"`). */
  providerId: string;
  /** Number of canonical events this provider supports. */
  supportedCount: number;
  /** Total canonical events in the taxonomy. */
  totalCanonical: number;
  /** Coverage percentage (0-100, integer). */
  coverage: number;
  /** Canonical events supported by this provider. */
  supported: string[];
  /** Canonical events NOT supported by this provider. */
  unsupported: string[];
}

/**
 * A single background job record.
 */
export interface AdminJobRecord {
  /** Unique job identifier. */
  jobId: string;
  /** Job type or name. */
  type: string;
  /** Current lifecycle status. */
  status: string;
  /** ISO-8601 start timestamp. */
  startedAt?: string;
  /** ISO-8601 finish timestamp (when done or cancelled). */
  finishedAt?: string;
  /** Human-readable progress or result message. */
  message?: string;
}

/**
 * Strictness preset definition as returned by `admin.config.presets`.
 */
export interface AdminPresetDefinition {
  /** Preset identifier. */
  name: AdminStrictnessPreset;
  /** Human-readable description. */
  description: string;
  /** Config keys modified by this preset. */
  settings: Record<string, unknown>;
}

/**
 * A single apply-preset change entry.
 */
export interface AdminPresetChange {
  /** Config key changed. */
  key: string;
  /** Value before the preset was applied. */
  previous: unknown;
  /** Value after the preset was applied. */
  current: unknown;
}

// ============================================================================
// AdminOp — discriminated union key
// ============================================================================

/**
 * All admin domain operation identifiers.
 *
 * Query operations are read-only. Mutate operations write to the filesystem,
 * SQLite, or trigger side-effectful system actions.
 */
export type AdminOp =
  // Query operations
  | 'admin.version'
  | 'admin.health'
  | 'admin.config.show'
  | 'admin.config.presets'
  | 'admin.stats'
  | 'admin.context'
  | 'admin.context.pull'
  | 'admin.runtime'
  | 'admin.paths'
  | 'admin.job'
  | 'admin.dash'
  | 'admin.log'
  | 'admin.sequence'
  | 'admin.help'
  | 'admin.token'
  | 'admin.adr.find'
  | 'admin.adr.show'
  | 'admin.backup'
  | 'admin.export'
  | 'admin.map'
  | 'admin.roadmap'
  | 'admin.smoke'
  | 'admin.smoke.provider'
  | 'admin.hooks.matrix'
  // Mutate operations
  | 'admin.init'
  | 'admin.scaffold-hub'
  | 'admin.health.mutate'
  | 'admin.config.set'
  | 'admin.config.set-preset'
  | 'admin.backup.mutate'
  | 'admin.migrate'
  | 'admin.cleanup'
  | 'admin.job.cancel'
  | 'admin.safestop'
  | 'admin.inject.generate'
  | 'admin.adr.sync'
  | 'admin.import'
  | 'admin.detect'
  | 'admin.token.mutate'
  | 'admin.context.inject'
  | 'admin.map.mutate'
  | 'admin.install.global';

// ============================================================================
// Query operation params + results
// ============================================================================

// ---------------------------------------------------------------------------
// admin.version
// ---------------------------------------------------------------------------

/** Parameters for `admin.version` — none required. */
export type AdminVersionParams = Record<string, never>;

/** Result of `admin.version`. */
export interface AdminVersionResult {
  /** The installed CLEO package version (CalVer `YYYY.M.patch`). */
  version: string;
}

// ---------------------------------------------------------------------------
// admin.health (query)
// ---------------------------------------------------------------------------

/**
 * Parameters for `admin.health` query.
 *
 * @remarks
 * When `mode` is `"diagnose"` the operation delegates to the doctor engine
 * and returns an `AdminDoctorResult`. Otherwise it runs the lightweight
 * health check and returns `AdminHealthQueryResult`.
 */
export interface AdminHealthQueryParams {
  /** When set to `"diagnose"`, runs a full doctor report. */
  mode?: 'diagnose';
  /** Include verbose per-component diagnostics. */
  detailed?: boolean;
}

/** Result of `admin.health` (standard health mode). */
export interface AdminHealthQueryResult {
  /** Aggregate health status. */
  overall: 'healthy' | 'warning' | 'error';
  /** Individual check results. */
  checks: AdminHealthCheck[];
  /** Installed CLEO version. */
  version: string;
  /** Installation quality level. */
  installation: 'ok' | 'degraded';
}

/** Result of `admin.health` when `mode` is `"diagnose"`. */
export interface AdminDoctorResult {
  /** Whether the project passed all checks. */
  healthy: boolean;
  /** Count of error-level checks. */
  errors: number;
  /** Count of warning-level checks. */
  warnings: number;
  /** Individual check results. */
  checks: AdminDoctorCheck[];
}

// ---------------------------------------------------------------------------
// admin.config.show
// ---------------------------------------------------------------------------

/** Parameters for `admin.config.show`. */
export interface AdminConfigShowParams {
  /** Optional dot-notation config key to read a single value. */
  key?: string;
}

/**
 * Result of `admin.config.show`.
 *
 * @remarks
 * Returns the full config object when `key` is omitted, or a single value
 * when `key` is provided. The type is intentionally open because config
 * values are operator-defined key/value pairs.
 */
export type AdminConfigShowResult = Record<string, unknown> | unknown;

// ---------------------------------------------------------------------------
// admin.config.presets
// ---------------------------------------------------------------------------

/** Parameters for `admin.config.presets` — none required. */
export type AdminConfigPresetsParams = Record<string, never>;

/** Result of `admin.config.presets`. */
export interface AdminConfigPresetsResult {
  /** Available strictness presets with their settings. */
  presets: AdminPresetDefinition[];
}

// ---------------------------------------------------------------------------
// admin.stats
// ---------------------------------------------------------------------------

/** Parameters for `admin.stats`. */
export interface AdminStatsParams {
  /** Rolling measurement period in days (default 30). */
  period?: number;
}

/** Result of `admin.stats`. */
export interface AdminStatsResult {
  /** Current task counts by status. */
  currentState: {
    pending: number;
    active: number;
    done: number;
    blocked: number;
    cancelled: number;
    /** Total non-archived tasks. */
    totalActive: number;
    archived: number;
    /** Active + archived total. */
    grandTotal: number;
  };
  /** Task counts grouped by priority level. */
  byPriority: Record<string, number>;
  /** Task counts grouped by task type. */
  byType: Record<string, number>;
  /** Task counts grouped by project phase. */
  byPhase: Record<string, number>;
  /** Completion rate metrics over the configured period. */
  completionMetrics: {
    /** Days in the measurement period. */
    periodDays: number;
    /** Tasks completed in the period. */
    completedInPeriod: number;
    /** Tasks created in the period. */
    createdInPeriod: number;
    /** Completion rate (completed / created). */
    completionRate: number;
  };
  /** Activity metrics over the configured period. */
  activityMetrics: {
    createdInPeriod: number;
    completedInPeriod: number;
    archivedInPeriod: number;
  };
  /** Lifetime metrics across all time. */
  allTime: {
    totalCreated: number;
    totalCompleted: number;
    totalCancelled: number;
    totalArchived: number;
    archivedCompleted: number;
  };
  /** Average time from creation to completion. */
  cycleTimes: {
    /** Average days to complete, or null if insufficient data. */
    averageDays: number | null;
    /** Completed tasks used for the average. */
    samples: number;
  };
}

// ---------------------------------------------------------------------------
// admin.context
// ---------------------------------------------------------------------------

/** Parameters for `admin.context`. */
export interface AdminContextParams {
  /** Session ID to narrow context monitoring to. */
  session?: string;
}

/** A single per-session context state entry. */
export interface AdminContextSessionEntry {
  /** State file path. */
  file: string;
  /** Session ID, or null. */
  sessionId: string | null;
  /** Usage percentage (0-100). */
  percentage: number;
  /** Status level. */
  status: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
}

/** Result of `admin.context`. */
export interface AdminContextResult {
  /** Whether context monitoring data is available. */
  available: boolean;
  /** Aggregate status level (`ok`, `warning`, `caution`, `critical`, `emergency`). */
  status: string;
  /** Usage percentage (0-100). */
  percentage: number;
  /** Current token usage. */
  currentTokens: number;
  /** Maximum context window size. */
  maxTokens: number;
  /** ISO-8601 timestamp of last update, or null. */
  timestamp: string | null;
  /** Whether the data is stale. */
  stale: boolean;
  /** Per-session context state entries. */
  sessions: AdminContextSessionEntry[];
}

// ---------------------------------------------------------------------------
// admin.context.pull
// ---------------------------------------------------------------------------

/** Parameters for `admin.context.pull`. */
export interface AdminContextPullParams {
  /** Task ID to pull JIT context for (required). */
  taskId: string;
}

/** A compact memory hit included in a context pull result. */
export interface AdminContextPullMemoryHit {
  /** Memory entry identifier. */
  id: string;
  /** Entry type (observation, decision, etc.). */
  type: string;
  /** Short display summary. */
  summary: string;
}

/** Result of `admin.context.pull`. */
export interface AdminContextPullResult {
  /** Compact task snapshot. */
  task: {
    /** Task identifier. */
    id: string;
    /** Task title. */
    title: string;
    /** Current status. */
    status: string;
    /** Acceptance criteria array. */
    acceptance: string[];
  };
  /** Relevant brain memory hits (up to 5). */
  relevantMemory: AdminContextPullMemoryHit[];
  /** First 200 chars of the most recent handoff note, or null. */
  lastHandoff: string | null;
  /** Metadata about memory retrieval. */
  meta: {
    /** Tokens consumed by memory retrieval. */
    memoryTokensUsed: number;
    /** Memory entries excluded due to token budget. */
    memoryEntriesExcluded: number;
  };
}

// ---------------------------------------------------------------------------
// admin.runtime
// ---------------------------------------------------------------------------

/** Parameters for `admin.runtime`. */
export interface AdminRuntimeParams {
  /** Include extra diagnostics in the runtime report. */
  detailed?: boolean;
}

/** Result of `admin.runtime`. */
export interface AdminRuntimeResult {
  /** Runtime channel (`stable`, `beta`, `dev`). */
  channel: string;
  /** Runtime mode string. */
  mode: string;
  /** Installation source (e.g. `npm`, `pnpm link`, `local`). */
  source: string;
  /** Installed package version. */
  version: string;
  /** Installed dist path. */
  installed: string;
  /** Global CLEO data root path. */
  dataRoot: string;
  /** Invocation context. */
  invocation: {
    /** Executable path. */
    executable: string;
    /** Script path. */
    script: string;
    /** CLI arguments. */
    args: string[];
  };
  /** CLI and server naming metadata. */
  naming: {
    cli: string;
    server: string;
  };
  /** Node.js version string. */
  node: string;
  /** OS platform string. */
  platform: string;
  /** CPU architecture string. */
  arch: string;
  /** Detected binary paths. */
  binaries?: Record<string, string>;
  /** Package identity (name + version) from package.json. */
  package?: {
    name: string;
    version: string;
  };
  /** Non-fatal warnings encountered during runtime detection. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// admin.paths
// ---------------------------------------------------------------------------

/** Parameters for `admin.paths` — none required. */
export type AdminPathsParams = Record<string, never>;

/** Result of `admin.paths`. */
export interface AdminPathsResult {
  /** Project-local `.cleo` directory (absolute). */
  projectCleoDir: string;
  /** XDG-compliant global data root (e.g. `~/.local/share/cleo`). */
  cleoHome: string;
  /** XDG config directory (e.g. `~/.config/cleo`). */
  configDir: string;
  /** CleoOS Hub path breakdown. */
  hub: {
    globalRecipes: string;
    globalJustfile: string;
    piExtensions: string;
    cantWorkflows: string;
    globalAgents: string;
  };
  /** Scaffolding existence flags (true = directory/file exists). */
  scaffolded: {
    globalRecipes: boolean;
    globalJustfile: boolean;
    piExtensions: boolean;
    cantWorkflows: boolean;
    globalAgents: boolean;
  };
}

// ---------------------------------------------------------------------------
// admin.job (query — dispatches via action param)
// ---------------------------------------------------------------------------

/** Parameters for `admin.job` query (action `"status"`). */
export interface AdminJobStatusParams {
  /** Action discriminator. */
  action?: 'status' | 'list';
  /** Job ID to fetch (required when action is `"status"`). */
  jobId?: string;
  /** Status filter for list mode. */
  status?: string;
  /** Page size limit for list mode. */
  limit?: number;
  /** Page offset for list mode. */
  offset?: number;
}

/** Result of `admin.job` when action is `"status"`. */
export type AdminJobStatusResult = AdminJobRecord;

/** Result of `admin.job` when action is `"list"`. */
export interface AdminJobListResult {
  /** Page of job records. */
  jobs: AdminJobRecord[];
  /** Count of jobs matching the status filter. */
  count: number;
  /** Total unfiltered job count. */
  total: number;
  /** Filtered count (same as count). */
  filtered: number;
}

// ---------------------------------------------------------------------------
// admin.dash
// ---------------------------------------------------------------------------

/** Parameters for `admin.dash`. */
export interface AdminDashParams {
  /** Override the default limit on blocked tasks shown. */
  blockedTasksLimit?: number;
}

/**
 * A compact task record included in dashboard lists.
 *
 * @remarks
 * Uses `unknown` for fields sourced from the full TaskRecord to avoid
 * pulling a package-level type import. Callers that need full task shapes
 * should use the `tasks` domain operations.
 */
export interface AdminDashTaskSummary {
  /** Task identifier. */
  id: string;
  /** Task title. */
  title: string;
  /** Current status. */
  status: string;
  /** Priority level. */
  priority?: string;
  /** Task type. */
  type?: string;
  /** Parent task ID. */
  parentId?: string | null;
  /** Assigned labels. */
  labels?: string[];
}

/** Result of `admin.dash`. */
export interface AdminDashResult {
  /** Project name or directory basename. */
  project: string;
  /** Active project phase, or null. */
  currentPhase: string | null;
  /** Task count breakdown by status. */
  summary: {
    pending: number;
    active: number;
    blocked: number;
    done: number;
    cancelled: number;
    /** Total non-archived tasks. */
    total: number;
    archived: number;
    /** Active + archived total. */
    grandTotal: number;
  };
  /** Currently focused task work state. */
  taskWork: {
    /** Current task ID, or null. */
    currentTask: string | null;
    /** Full task record for the current task, or null. */
    task: AdminDashTaskSummary | null;
  };
  /** Active session ID, or null. */
  activeSession: string | null;
  /** High-priority tasks summary. */
  highPriority: {
    count: number;
    tasks: AdminDashTaskSummary[];
  };
  /** Blocked tasks summary. */
  blockedTasks: {
    count: number;
    /** Display limit applied. */
    limit: number;
    tasks: AdminDashTaskSummary[];
  };
  /** Recently completed task records. */
  recentCompletions: AdminDashTaskSummary[];
  /** Most frequently used labels with counts. */
  topLabels: Array<{ label: string; count: number }>;
}

// ---------------------------------------------------------------------------
// admin.log
// ---------------------------------------------------------------------------

/** Parameters for `admin.log`. */
export interface AdminLogParams {
  /** Filter to a specific operation name. */
  operation?: string;
  /** Filter to entries for a specific task ID. */
  taskId?: string;
  /** ISO-8601 lower bound. */
  since?: string;
  /** ISO-8601 upper bound. */
  until?: string;
  /** Page size limit. */
  limit?: number;
  /** Page offset. */
  offset?: number;
}

/** Result of `admin.log`. */
export interface AdminLogResult {
  /** Matching log entries. */
  entries: AdminLogEntry[];
  /** Pagination metadata. */
  pagination: AdminPagination;
}

// ---------------------------------------------------------------------------
// admin.sequence
// ---------------------------------------------------------------------------

/** Parameters for `admin.sequence`. */
export interface AdminSequenceParams {
  /** `"show"` returns current state; `"check"` validates integrity. */
  action?: 'show' | 'check';
}

/** Result of `admin.sequence`. */
export interface AdminSequenceResult {
  /** Current counter value. */
  counter: number;
  /** Last assigned task ID. */
  lastId: string;
  /** Integrity checksum. */
  checksum: string;
  /** Next task ID that would be assigned. */
  nextId: string;
}

// ---------------------------------------------------------------------------
// admin.help
// ---------------------------------------------------------------------------

/** Parameters for `admin.help`. */
export interface AdminHelpParams {
  /** Help tier depth (0 = minimal, 1 = standard, 2 = full). */
  tier?: number;
  /** Include verbose examples and cross-references. */
  verbose?: boolean;
}

/** Result of `admin.help`. */
export interface AdminHelpResult {
  /** Optional topic identifier. */
  topic?: string;
  /** Human-readable help content. */
  content: string;
  /** Related CLI commands for cross-reference. */
  relatedCommands?: string[];
}

// ---------------------------------------------------------------------------
// admin.token (query — dispatches via action param)
// ---------------------------------------------------------------------------

/**
 * Shared filter parameters used by all three `admin.token` query actions.
 *
 * @remarks
 * The `action` field selects between `summary`, `list`, and `show` sub-operations.
 */
export interface AdminTokenQueryParams {
  /** Sub-operation selector (default `"summary"`). */
  action?: 'summary' | 'list' | 'show';
  /** Filter by provider name. */
  provider?: string;
  /** Filter by transport category. */
  transport?: AdminTokenTransport;
  /** Filter by gateway identifier. */
  gateway?: string;
  /** Filter by domain name. */
  domain?: string;
  /** Filter by operation name within a domain. */
  operationName?: string;
  /** Filter by session ID. */
  sessionId?: string;
  /** Filter by task ID. */
  taskId?: string;
  /** Filter by measurement method. */
  method?: AdminTokenMethod;
  /** Filter by confidence level. */
  confidence?: AdminTokenConfidence;
  /** Filter by request ID. */
  requestId?: string;
  /** ISO-8601 lower bound for `createdAt`. */
  since?: string;
  /** ISO-8601 upper bound for `createdAt`. */
  until?: string;
  /** Token record ID (required when action is `"show"`). */
  tokenId?: string;
  /** Page size limit (used by action `"list"`). */
  limit?: number;
  /** Page offset (used by action `"list"`). */
  offset?: number;
}

/** Result of `admin.token` when action is `"summary"`. */
export interface AdminTokenSummaryResult {
  /** Total records matching the filters. */
  totalRecords: number;
  /** Total input tokens. */
  inputTokens: number;
  /** Total output tokens. */
  outputTokens: number;
  /** Total tokens (input + output). */
  totalTokens: number;
  /** Breakdown by measurement method. */
  byMethod: AdminTokenMethodBreakdown[];
  /** Breakdown by transport category. */
  byTransport: AdminTokenTransportBreakdown[];
  /** Breakdown by domain + operation key. */
  byOperation: AdminTokenOperationBreakdown[];
}

/** Result of `admin.token` when action is `"list"`. */
export interface AdminTokenListResult {
  /** Page of token records. */
  records: AdminTokenRecord[];
  /** Total record count matching filters. */
  total: number;
  /** Filtered count (same as total when no post-filter applied). */
  filtered: number;
}

/** Result of `admin.token` when action is `"show"`. */
export type AdminTokenShowResult = AdminTokenRecord;

// ---------------------------------------------------------------------------
// admin.adr.find
// ---------------------------------------------------------------------------

/** Parameters for `admin.adr.find`. */
export interface AdminAdrFindParams {
  /** Free-text search query. When omitted, all ADRs are listed. */
  query?: string;
  /** Filter by topic keywords. */
  topics?: string;
  /** Filter by content keywords. */
  keywords?: string;
  /** Filter by lifecycle status. */
  status?: AdminAdrStatus;
  /** ISO date lower bound. */
  since?: string;
  /** Page size limit. */
  limit?: number;
  /** Page offset. */
  offset?: number;
}

/** A scored ADR search hit (from `admin.adr.find` when query is provided). */
export interface AdminAdrFindHit extends AdminAdrSummary {
  /** Optional short summary from frontmatter. */
  summary?: string;
  /** Matched keywords from frontmatter. */
  keywords?: string;
  /** Matched topics from frontmatter. */
  topics?: string;
  /** Relevance score (higher = better match). */
  score: number;
  /** Fields that contributed to the match. */
  matchedFields: string[];
}

/** Result of `admin.adr.find`. */
export interface AdminAdrFindResult {
  /** ADR records or search hits. */
  adrs: AdminAdrSummary[] | AdminAdrFindHit[];
  /** Search query applied (empty string when listing all). */
  query: string;
  /** Total result count. */
  total: number;
  /** Count after status/since filtering. */
  filtered: number;
}

// ---------------------------------------------------------------------------
// admin.adr.show
// ---------------------------------------------------------------------------

/** Parameters for `admin.adr.show`. */
export interface AdminAdrShowParams {
  /** ADR identifier to fetch (e.g. `"ADR-007"`) — required. */
  adrId: string;
}

/** Result of `admin.adr.show`. */
export type AdminAdrShowResult = AdminAdrRecord;

// ---------------------------------------------------------------------------
// admin.backup (query — list backups)
// ---------------------------------------------------------------------------

/** Parameters for `admin.backup` query — none required. */
export type AdminBackupListParams = Record<string, never>;

/** Result of `admin.backup` query. */
export interface AdminBackupListResult {
  /** Available backup entries ordered by timestamp descending. */
  backups: AdminBackupEntry[];
  /** Total count of available backups. */
  count: number;
}

// ---------------------------------------------------------------------------
// admin.export
// ---------------------------------------------------------------------------

/** Parameters for `admin.export`. */
export interface AdminExportParams {
  /**
   * Export scope.
   * - `undefined` — standard task CSV/JSON export
   * - `"snapshot"` — full project snapshot
   * - `"tasks"` — portable cross-project task package
   */
  scope?: AdminExportScope;
  /** Output file path override. */
  output?: string;
  /** Export format for standard task export (`json`, `csv`, `tsv`, `markdown`). */
  format?: 'json' | 'csv' | 'tsv' | 'markdown';
  /** Filter by status for standard task export. */
  status?: string;
  /** Filter by parent task ID for standard task export. */
  parent?: string;
  /** Filter by phase for standard task export. */
  phase?: string;
  /** Task IDs to export (task package scope). */
  taskIds?: string[];
  /** Include entire subtree when exporting task packages. */
  subtree?: boolean;
  /** Label filters for task package scope. */
  filter?: string[];
  /** Include dependency tasks automatically. */
  includeDeps?: boolean;
  /** Dry-run mode (preview only, no file written). */
  dryRun?: boolean;
}

/** Result of `admin.export` (standard mode). */
export interface AdminExportStandardResult {
  /** Export format used. */
  format: string;
  /** Number of tasks exported. */
  taskCount: number;
  /** Output file path, when written to disk. */
  file?: string;
  /** Serialized content, when not written to disk. */
  content?: string;
}

/** Result of `admin.export` (snapshot scope). */
export interface AdminExportSnapshotResult {
  /** Whether the export succeeded. */
  exported: boolean;
  /** Number of tasks in the snapshot. */
  taskCount: number;
  /** Output file path. */
  outputPath: string;
  /** SHA-256 checksum of the snapshot. */
  checksum: string;
}

/** Result of `admin.export` (tasks package scope). */
export interface AdminExportTasksPackageResult {
  /** Export mode indicator. */
  exportMode: string;
  /** Number of tasks exported. */
  taskCount: number;
  /** Task IDs included in the package. */
  taskIds: string[];
  /** Output file path, when written. */
  outputPath?: string;
  /** Package content, when not written to disk. */
  content?: string;
  /** Whether this was a dry run. */
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// admin.map (query)
// ---------------------------------------------------------------------------

/** Parameters for `admin.map` query. */
export interface AdminMapQueryParams {
  /** Narrow analysis to a specific aspect. */
  focus?:
    | 'stack'
    | 'architecture'
    | 'structure'
    | 'conventions'
    | 'testing'
    | 'integrations'
    | 'concerns';
}

/**
 * Result of `admin.map` query.
 *
 * @remarks
 * Shape mirrors `CodebaseMapResult` from `@cleocode/core`. Full sub-types
 * (`StackAnalysis`, `ArchAnalysis`, etc.) are omitted here to avoid pulling
 * core internals into the contracts package. Consumers that need the precise
 * shapes should import from `@cleocode/core/internal`.
 */
export interface AdminMapResult {
  /** Project context metadata (type, monorepo, conventions). */
  projectContext: Record<string, unknown>;
  /** Technology stack analysis. */
  stack: Record<string, unknown>;
  /** Architecture analysis. */
  architecture: Record<string, unknown>;
  /** Directory/file structure analysis. */
  structure: Record<string, unknown>;
  /** Coding conventions analysis. */
  conventions: Record<string, unknown>;
  /** Testing setup analysis. */
  testing: Record<string, unknown>;
  /** External integrations detected. */
  integrations: Record<string, unknown>;
  /** Cross-cutting concerns detected. */
  concerns: Record<string, unknown>;
  /** ISO-8601 timestamp when the analysis ran. */
  analyzedAt: string;
}

// ---------------------------------------------------------------------------
// admin.roadmap
// ---------------------------------------------------------------------------

/** Parameters for `admin.roadmap`. */
export interface AdminRoadmapParams {
  /** Include completed release history. */
  includeHistory?: boolean;
  /** Only show upcoming epics (exclude completed). */
  upcomingOnly?: boolean;
}

/** An upcoming epic or milestone entry in the roadmap. */
export interface AdminRoadmapEpic {
  /** Task identifier. */
  id: string;
  /** Epic title. */
  title: string;
  /** Current status. */
  status: string;
  /** Priority level. */
  priority: string;
  /** Active phase, if set. */
  phase?: string;
  /** Total child task count. */
  childCount: number;
  /** Count of completed child tasks. */
  completedChildren: number;
}

/** A past release entry in the roadmap history. */
export interface AdminRoadmapRelease {
  /** CalVer version tag. */
  version: string;
  /** ISO-8601 release date. */
  date: string;
}

/** Result of `admin.roadmap`. */
export interface AdminRoadmapResult {
  /** Current project version. */
  currentVersion: string;
  /** Upcoming epics and milestones. */
  upcoming: AdminRoadmapEpic[];
  /** Past releases (when `includeHistory` is true). */
  releaseHistory?: AdminRoadmapRelease[];
  /** Total completed epics. */
  completedEpics?: number;
  /** Summary counts. */
  summary: {
    /** Total upcoming epics. */
    totalUpcoming: number;
    /** Total tasks across upcoming epics. */
    totalTasks: number;
  };
}

// ---------------------------------------------------------------------------
// admin.smoke
// ---------------------------------------------------------------------------

/** Parameters for `admin.smoke` — none required. */
export type AdminSmokeParams = Record<string, never>;

/** Result of `admin.smoke`. */
export interface AdminSmokeResult {
  /** Per-domain dispatch probes. */
  probes: AdminSmokeProbe[];
  /** Per-database connectivity probes. */
  dbChecks: AdminSmokeProbe[];
  /** Count of probes that passed. */
  passed: number;
  /** Count of probes that failed. */
  failed: number;
  /** Count of probes that were skipped. */
  skipped: number;
  /** Total wall-clock duration in milliseconds. */
  totalMs: number;
}

// ---------------------------------------------------------------------------
// admin.smoke.provider
// ---------------------------------------------------------------------------

/** Parameters for `admin.smoke.provider`. */
export interface AdminSmokeProviderParams {
  /** Provider ID to probe (e.g. `"claude-code"`, `"pi"`, `"opencode"`). */
  provider: string;
}

/** Result of `admin.smoke.provider`. */
export interface AdminSmokeProviderResult {
  /** Provider ID that was probed. */
  providerId: string;
  /** Whether the adapter dist module resolved with the expected shape. */
  adapterLoaded: boolean;
  /** Locality checks for the four CLEO-owned databases. */
  dbChecks: AdminDbLocalityCheck[];
  /** Count of CAAMP canonical hook events referenced in the provider's hooks.ts. */
  hooksDeclared: number;
  /** Spawn implementation classification. */
  spawnStatus: AdminSpawnStatus;
  /** Absolute path returned by `getProviderAgentFolder`, or null. */
  agentFolder: string | null;
  /** Whether all ADR-049 invariants passed. */
  passed: boolean;
  /** Human-readable failure reason when `passed` is false. */
  failureReason?: string;
  /** Formatted plain-text report block for CLI rendering. */
  report: string;
}

// ---------------------------------------------------------------------------
// admin.hooks.matrix
// ---------------------------------------------------------------------------

/** Parameters for `admin.hooks.matrix`. */
export interface AdminHooksMatrixParams {
  /** Filter matrix to specific provider IDs. */
  providerIds?: string[];
  /** Whether to run provider auto-detection (default true). */
  detectProvider?: boolean;
}

/** Result of `admin.hooks.matrix`. */
export interface AdminHooksMatrixResult {
  /** CAAMP hook mappings version string. */
  caampVersion: string;
  /** All canonical CAAMP event names (matrix rows). */
  events: string[];
  /** Provider IDs included in the matrix (matrix columns). */
  providers: string[];
  /**
   * Two-dimensional matrix: event name → provider ID → support flag.
   * `true` means the provider natively supports the canonical event.
   */
  matrix: Record<string, Record<string, boolean>>;
  /** Per-provider summary rows with coverage statistics. */
  summary: AdminProviderMatrixEntry[];
  /** Provider ID detected as the current runtime, or null. */
  detectedProvider: string | null;
}

// ============================================================================
// Mutate operation params + results
// ============================================================================

// ---------------------------------------------------------------------------
// admin.init
// ---------------------------------------------------------------------------

/** Parameters for `admin.init`. */
export interface AdminInitParams {
  /** Project name override. */
  projectName?: string;
  /** Overwrite existing files. */
  force?: boolean;
  /** Run codebase analysis and store findings to brain.db. */
  mapCodebase?: boolean;
  /** Install canonical CleoOS seed agents. */
  installSeedAgents?: boolean;
}

/** Result of `admin.init`. */
export interface AdminInitResult {
  /** Whether initialization succeeded. */
  initialized: boolean;
  /** Absolute path to the `.cleo` directory created. */
  directory: string;
  /** Files that were created. */
  created: string[];
  /** Files that were skipped (already existed). */
  skipped: string[];
  /** Non-fatal warnings emitted during init. */
  warnings: string[];
  /** Whether only documentation files were updated (brownfield scenario). */
  updateDocsOnly?: boolean;
  /** Greenfield/brownfield classification of the directory. */
  classification?: {
    kind: 'greenfield' | 'brownfield';
    signalCount: number;
    topLevelFileCount: number;
    hasGit: boolean;
  };
}

// ---------------------------------------------------------------------------
// admin.scaffold-hub
// ---------------------------------------------------------------------------

/** Parameters for `admin.scaffold-hub` — none required. */
export type AdminScaffoldHubParams = Record<string, never>;

/** Result of `admin.scaffold-hub`. */
export interface AdminScaffoldHubResult {
  /** Whether the hub was created, repaired, or already current. */
  action: 'created' | 'repaired' | 'skipped';
  /** Absolute path to the hub root. */
  path: string;
  /** Additional details about what changed. */
  details?: string;
}

// ---------------------------------------------------------------------------
// admin.health (mutate — repair / diagnose via mode param)
// ---------------------------------------------------------------------------

/** Parameters for `admin.health` mutate. */
export interface AdminHealthMutateParams {
  /**
   * Mode selector.
   * - `"diagnose"` — runs doctor report (same result shape as query diagnose).
   * - `undefined`  — runs auto-repair and returns per-check fix results.
   */
  mode?: 'diagnose';
}

/** A single auto-fix result entry (from `admin.health` repair mode). */
export interface AdminFixResult {
  /** Check identifier that was attempted. */
  check: string;
  /** Outcome of the fix attempt. */
  action: 'fixed' | 'skipped' | 'failed';
  /** Human-readable message. */
  message: string;
}

/** Result of `admin.health` mutate (repair mode). */
export type AdminHealthRepairResult = AdminFixResult[];

// ---------------------------------------------------------------------------
// admin.config.set
// ---------------------------------------------------------------------------

/** Parameters for `admin.config.set`. */
export interface AdminConfigSetParams {
  /** Dot-notation config key (required). */
  key: string;
  /** Value to assign. */
  value?: unknown;
}

/** Result of `admin.config.set`. */
export interface AdminConfigSetResult {
  /** Config key that was written. */
  key: string;
  /** New value assigned. */
  value: unknown;
}

// ---------------------------------------------------------------------------
// admin.config.set-preset
// ---------------------------------------------------------------------------

/** Parameters for `admin.config.set-preset`. */
export interface AdminConfigSetPresetParams {
  /** Preset to apply (`strict`, `standard`, or `minimal`). */
  preset: AdminStrictnessPreset;
}

/** Result of `admin.config.set-preset`. */
export interface AdminConfigSetPresetResult {
  /** Preset that was applied. */
  preset: string;
  /** Config changes made by the preset. */
  changes: AdminPresetChange[];
}

// ---------------------------------------------------------------------------
// admin.backup (mutate — create / restore / restore.file via action)
// ---------------------------------------------------------------------------

/** Parameters for `admin.backup` mutate. */
export interface AdminBackupMutateParams {
  /**
   * Action selector.
   * - `undefined` / default — create a new backup
   * - `"restore"` — restore by backup ID
   * - `"restore.file"` — restore from an arbitrary file path
   */
  action?: AdminBackupAction;
  /** Backup type when creating (`snapshot`, `safety`, `migration`). */
  type?: string;
  /** Optional note to attach when creating a backup. */
  note?: string;
  /** Backup ID to restore (required when action is `"restore"`). */
  backupId?: string;
  /** Overwrite existing files without prompt when restoring by ID. */
  force?: boolean;
  /** Absolute path to backup file to restore (required when action is `"restore.file"`). */
  file?: string;
  /** Preview the restore without writing (restore.file only). */
  dryRun?: boolean;
}

/** Result of `admin.backup` mutate (create action). */
export interface AdminBackupCreateResult {
  /** Unique backup identifier. */
  backupId: string;
  /** Absolute path to the backup directory. */
  path: string;
  /** ISO-8601 creation timestamp. */
  timestamp: string;
  /** Backup category. */
  type: string;
  /** Files captured in the backup. */
  files: string[];
}

/** Result of `admin.backup` mutate (restore action — by ID). */
export interface AdminBackupRestoreByIdResult {
  /** Whether any files were actually restored. */
  restored: boolean;
  /** The backup identifier that was restored. */
  backupId: string;
  /** ISO-8601 timestamp of the original backup. */
  timestamp: string;
  /** File names successfully restored into `.cleo/`. */
  filesRestored: string[];
}

/** Result of `admin.backup` mutate (restore.file action). */
export interface AdminBackupRestoreFileResult {
  /** Source backup file path. */
  source: string;
  /** Files restored from the backup. */
  restored: string[];
  /** Whether this was a dry run. */
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// admin.migrate
// ---------------------------------------------------------------------------

/** Parameters for `admin.migrate`. */
export interface AdminMigrateParams {
  /** Target migration version. */
  target?: string;
  /** Preview migrations without applying. */
  dryRun?: boolean;
}

/** A single migration step. */
export interface AdminMigrationStep {
  /** Migration name. */
  name: string;
  /** Whether the migration was applied. */
  applied: boolean;
}

/** Result of `admin.migrate`. */
export interface AdminMigrateResult {
  /** Schema version before migration. */
  from: string;
  /** Schema version after migration (or target when dryRun). */
  to: string;
  /** Individual migration steps. */
  migrations: AdminMigrationStep[];
  /** Whether this was a dry run. */
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// admin.cleanup
// ---------------------------------------------------------------------------

/** Parameters for `admin.cleanup`. */
export interface AdminCleanupParams {
  /** Cleanup target (`backups`, `logs`, `sessions`, `archive`, etc.) — required. */
  target: string;
  /** ISO-8601 age threshold for item retention. */
  olderThan?: string;
  /** Preview without deleting. */
  dryRun?: boolean;
}

/** Result of `admin.cleanup`. */
export interface AdminCleanupResult {
  /** Cleanup target applied. */
  target: string;
  /** Number of items deleted. */
  deleted: number;
  /** Identifiers of items deleted. */
  items: string[];
  /** Whether this was a dry run. */
  dryRun: boolean;
  /** Rows pruned from the database (when applicable). */
  prunedRows?: number;
  /** Rows moved to archive (when applicable). */
  archivedRows?: number;
  /** Archive file path created (when applicable). */
  archivePath?: string;
}

// ---------------------------------------------------------------------------
// admin.job.cancel
// ---------------------------------------------------------------------------

/** Parameters for `admin.job.cancel`. */
export interface AdminJobCancelParams {
  /** Job ID to cancel — required. */
  jobId: string;
}

/** Result of `admin.job.cancel`. */
export interface AdminJobCancelResult {
  /** The job ID that was cancelled. */
  jobId: string;
  /** Whether the cancellation succeeded. */
  cancelled: boolean;
}

// ---------------------------------------------------------------------------
// admin.safestop
// ---------------------------------------------------------------------------

/** Parameters for `admin.safestop`. */
export interface AdminSafestopParams {
  /** Human-readable reason for the stop. */
  reason?: string;
  /** Commit any staged changes before stopping. */
  commit?: boolean;
  /** Handoff note to persist for the next session. */
  handoff?: string;
  /** Skip ending the active session. */
  noSessionEnd?: boolean;
  /** Preview the stop without performing side effects. */
  dryRun?: boolean;
}

/** Result of `admin.safestop`. */
export interface AdminSafestopResult {
  /** Whether the stop completed successfully. */
  stopped: boolean;
  /** Stop reason applied. */
  reason: string;
  /** Whether the active session was ended. */
  sessionEnded: boolean;
  /** Handoff note written (when provided). */
  handoff?: string;
  /** Whether this was a dry run. */
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// admin.inject.generate
// ---------------------------------------------------------------------------

/** Parameters for `admin.inject.generate` — none required. */
export type AdminInjectGenerateParams = Record<string, never>;

/** Result of `admin.inject.generate`. */
export interface AdminInjectGenerateResult {
  /** Generated injection Markdown content. */
  injection: string;
  /** Size in bytes of the generated content. */
  sizeBytes: number;
  /** CLEO protocol version used for generation. */
  version: string;
}

// ---------------------------------------------------------------------------
// admin.adr.sync
// ---------------------------------------------------------------------------

/** Parameters for `admin.adr.sync`. */
export interface AdminAdrSyncParams {
  /**
   * When true, runs validation only without writing to the database.
   * Returns `AdminAdrValidateResult` instead of `AdminAdrSyncResult`.
   */
  validate?: boolean;
}

/** Result of `admin.adr.sync` (default sync mode). */
export interface AdminAdrSyncResult {
  /** ADR records inserted into the database. */
  inserted: number;
  /** ADR records updated in the database. */
  updated: number;
  /** ADR records skipped (no changes). */
  skipped: number;
  /** Per-file sync errors. */
  errors: Array<{ file: string; error: string }>;
  /** Non-fatal warnings. */
  warnings: string[];
}

/** A single ADR validation error. */
export interface AdminAdrValidationError {
  /** ADR identifier. */
  adrId?: string;
  /** File that failed validation. */
  file?: string;
  /** Human-readable error description. */
  message: string;
}

/** Result of `admin.adr.sync` when `validate` is true. */
export interface AdminAdrValidateResult {
  /** Whether all ADRs passed validation. */
  valid: boolean;
  /** Validation errors found. */
  errors: AdminAdrValidationError[];
  /** Number of ADR files checked. */
  checked: number;
}

// ---------------------------------------------------------------------------
// admin.import
// ---------------------------------------------------------------------------

/** Parameters for `admin.import`. */
export interface AdminImportParams {
  /**
   * Import scope.
   * - `undefined` — standard task import from file
   * - `"snapshot"` — full project snapshot restore
   * - `"tasks"` — portable cross-project task package import
   */
  scope?: AdminImportScope;
  /** Input file path — required. */
  file: string;
  /** Preview import without writing. */
  dryRun?: boolean;
  /** Parent task ID to attach imported tasks under. */
  parent?: string;
  /** Target phase for imported tasks. */
  phase?: string;
  /** Label to add to all imported tasks. */
  addLabel?: string;
  /** Duplicate resolution strategy for standard import. */
  onDuplicate?: 'skip' | 'overwrite' | 'rename';
  /** Conflict resolution for task package import. */
  onConflict?: 'duplicate' | 'rename' | 'skip' | 'fail';
  /** Missing dependency resolution for task package import. */
  onMissingDep?: 'strip' | 'placeholder' | 'fail';
  /** Force import even with validation warnings. */
  force?: boolean;
  /** Reset task status on import. */
  resetStatus?: 'pending' | 'active' | 'blocked';
  /** Write provenance metadata to imported tasks. */
  provenance?: boolean;
}

/** Result of `admin.import` (standard mode). */
export interface AdminImportStandardResult {
  /** Number of tasks imported. */
  imported: number;
  /** Number of tasks skipped. */
  skipped: number;
  /** Tasks renamed during import (oldId → newId). */
  renamed: Array<{ oldId: string; newId: string }>;
  /** Total tasks in the source file. */
  totalTasks: number;
  /** Whether this was a dry run. */
  dryRun?: boolean;
}

/** Result of `admin.import` (snapshot scope). */
export interface AdminImportSnapshotResult {
  /** Whether the import was a dry run preview. */
  dryRun?: boolean;
  /** Snapshot source identifier (dry-run only). */
  source?: string;
  /** Task count in snapshot (dry-run only). */
  taskCount?: number;
  /** Snapshot creation timestamp (dry-run only). */
  createdAt?: string;
  /** Tasks added (live import). */
  added?: number;
  /** Tasks updated (live import). */
  updated?: number;
  /** Tasks skipped (live import). */
  skipped?: number;
  /** Conflicting task IDs (live import). */
  conflicts?: string[];
  /** Whether the import was successful. */
  imported?: boolean;
}

/** Result of `admin.import` (tasks package scope). */
export interface AdminImportTasksPackageResult {
  /** Number of tasks imported. */
  imported: number;
  /** Number of tasks skipped. */
  skipped: number;
  /** ID remapping (source ID → new project ID). */
  idRemap: Record<string, string>;
  /** Whether this was a dry run. */
  dryRun?: boolean;
  /** Preview data (dry-run only). */
  preview?: {
    tasks: Array<{ id: string; title: string; type: string }>;
  };
}

// ---------------------------------------------------------------------------
// admin.detect
// ---------------------------------------------------------------------------

/** Parameters for `admin.detect` — none required. */
export type AdminDetectParams = Record<string, never>;

/** Result of `admin.detect`. */
export interface AdminDetectResult {
  /** Project context detection result. */
  context: Record<string, unknown>;
  /** Contributor / dev-channel channel setup result. */
  devChannel: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// admin.token (mutate — record / delete / clear via action)
// ---------------------------------------------------------------------------

/** Parameters for `admin.token` mutate. */
export interface AdminTokenMutateParams {
  /** Sub-operation selector (default `"record"`). */
  action?: 'record' | 'delete' | 'clear';
  /** Provider name (record action). */
  provider?: string;
  /** Model name (record action). */
  model?: string;
  /** Transport category (record / clear actions). */
  transport?: AdminTokenTransport;
  /** Gateway identifier (record / clear actions). */
  gateway?: string;
  /** Domain name (record / clear actions). */
  domain?: string;
  /** Operation name within a domain (record / clear actions). */
  operationName?: string;
  /** Session ID (record / clear actions). */
  sessionId?: string;
  /** Task ID (record / clear actions). */
  taskId?: string;
  /** Request ID (record / clear actions). */
  requestId?: string;
  /** Raw request payload object (record action). */
  requestPayload?: unknown;
  /** Raw response payload object (record action). */
  responsePayload?: unknown;
  /** Arbitrary metadata (record action). */
  metadata?: Record<string, unknown>;
  /** Measurement method (clear action). */
  method?: AdminTokenMethod;
  /** Confidence level (clear action). */
  confidence?: AdminTokenConfidence;
  /** ISO-8601 lower bound (clear action). */
  since?: string;
  /** ISO-8601 upper bound (clear action). */
  until?: string;
  /** Token record ID to delete (delete action, required). */
  tokenId?: string;
}

/** Result of `admin.token` mutate when action is `"record"`. */
export interface AdminTokenRecordResult {
  /** Newly-created record identifier. */
  id: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

/** Result of `admin.token` mutate when action is `"delete"`. */
export interface AdminTokenDeleteResult {
  /** Record identifier deleted. */
  id: string;
  /** Whether the deletion succeeded. */
  deleted: boolean;
}

/** Result of `admin.token` mutate when action is `"clear"`. */
export interface AdminTokenClearResult {
  /** Number of records deleted. */
  cleared: number;
}

// ---------------------------------------------------------------------------
// admin.context.inject
// ---------------------------------------------------------------------------

/** Parameters for `admin.context.inject`. */
export interface AdminContextInjectParams {
  /** Protocol type identifier (e.g. `"cleo"`, `"rcasd"`) — required. */
  protocolType: string;
  /** Task ID to embed in the injection context. */
  taskId?: string;
  /** Variant of the protocol to inject. */
  variant?: string;
}

/** Result of `admin.context.inject`. */
export interface AdminContextInjectResult {
  /** Protocol type that was injected. */
  protocolType: string;
  /** Rendered injection content (Markdown). */
  content: string;
  /** Absolute file path the content was read from, or null. */
  path: string | null;
  /** Length of the content in characters. */
  contentLength: number;
  /** Estimated token count. */
  estimatedTokens: number;
  /** Task ID embedded in the injection, or null. */
  taskId: string | null;
  /** Variant applied, or null. */
  variant: string | null;
}

// ---------------------------------------------------------------------------
// admin.map (mutate — store findings to brain.db)
// ---------------------------------------------------------------------------

/** Parameters for `admin.map` mutate. */
export interface AdminMapMutateParams {
  /** Narrow analysis to a specific aspect. */
  focus?:
    | 'stack'
    | 'architecture'
    | 'structure'
    | 'conventions'
    | 'testing'
    | 'integrations'
    | 'concerns';
}

/** Result of `admin.map` mutate (same shape as query result but also persisted). */
export type AdminMapMutateResult = AdminMapResult;

// ---------------------------------------------------------------------------
// admin.install.global
// ---------------------------------------------------------------------------

/** Parameters for `admin.install.global` — none required. */
export type AdminInstallGlobalParams = Record<string, never>;

/** Result of `admin.install.global`. */
export interface AdminInstallGlobalResult {
  /** Global scaffold setup result. */
  scaffold: Record<string, unknown>;
  /** Global template installation result. */
  templates: Record<string, unknown>;
}

// ============================================================================
// AdminOps — discriminated union
// ============================================================================

/**
 * Discriminated union of all admin domain operations.
 *
 * Each member fully specifies the `op`, `params`, and `result` for a single
 * operation. Consumed by `TypedDomainHandler<AdminOps>` in the T983 migration.
 *
 * @remarks
 * Operations that are unified at the handler level via an `action` param
 * (e.g. `admin.job`, `admin.token`, `admin.backup`) are represented with
 * their most permissive param union. Type-narrowing on `params.action` should
 * be performed by callers that need the precise result shape.
 *
 * Operations that differ by gateway (query vs mutate) are suffixed with
 * `.mutate` on the mutate variant when there is a name collision
 * (e.g. `admin.health` / `admin.health.mutate`, `admin.map` / `admin.map.mutate`).
 */
export type AdminOps =
  // ---- Query ----
  | { op: 'admin.version'; params: AdminVersionParams; result: AdminVersionResult }
  | {
      op: 'admin.health';
      params: AdminHealthQueryParams;
      result: AdminHealthQueryResult | AdminDoctorResult;
    }
  | { op: 'admin.config.show'; params: AdminConfigShowParams; result: AdminConfigShowResult }
  | {
      op: 'admin.config.presets';
      params: AdminConfigPresetsParams;
      result: AdminConfigPresetsResult;
    }
  | { op: 'admin.stats'; params: AdminStatsParams; result: AdminStatsResult }
  | { op: 'admin.context'; params: AdminContextParams; result: AdminContextResult }
  | { op: 'admin.context.pull'; params: AdminContextPullParams; result: AdminContextPullResult }
  | { op: 'admin.runtime'; params: AdminRuntimeParams; result: AdminRuntimeResult }
  | { op: 'admin.paths'; params: AdminPathsParams; result: AdminPathsResult }
  | {
      op: 'admin.job';
      params: AdminJobStatusParams;
      result: AdminJobStatusResult | AdminJobListResult;
    }
  | { op: 'admin.dash'; params: AdminDashParams; result: AdminDashResult }
  | { op: 'admin.log'; params: AdminLogParams; result: AdminLogResult }
  | { op: 'admin.sequence'; params: AdminSequenceParams; result: AdminSequenceResult }
  | { op: 'admin.help'; params: AdminHelpParams; result: AdminHelpResult }
  | {
      op: 'admin.token';
      params: AdminTokenQueryParams;
      result: AdminTokenSummaryResult | AdminTokenListResult | AdminTokenShowResult;
    }
  | { op: 'admin.adr.find'; params: AdminAdrFindParams; result: AdminAdrFindResult }
  | { op: 'admin.adr.show'; params: AdminAdrShowParams; result: AdminAdrShowResult }
  | { op: 'admin.backup'; params: AdminBackupListParams; result: AdminBackupListResult }
  | {
      op: 'admin.export';
      params: AdminExportParams;
      result: AdminExportStandardResult | AdminExportSnapshotResult | AdminExportTasksPackageResult;
    }
  | { op: 'admin.map'; params: AdminMapQueryParams; result: AdminMapResult }
  | { op: 'admin.roadmap'; params: AdminRoadmapParams; result: AdminRoadmapResult }
  | { op: 'admin.smoke'; params: AdminSmokeParams; result: AdminSmokeResult }
  | {
      op: 'admin.smoke.provider';
      params: AdminSmokeProviderParams;
      result: AdminSmokeProviderResult;
    }
  | { op: 'admin.hooks.matrix'; params: AdminHooksMatrixParams; result: AdminHooksMatrixResult }
  // ---- Mutate ----
  | { op: 'admin.init'; params: AdminInitParams; result: AdminInitResult }
  | { op: 'admin.scaffold-hub'; params: AdminScaffoldHubParams; result: AdminScaffoldHubResult }
  | {
      op: 'admin.health.mutate';
      params: AdminHealthMutateParams;
      result: AdminHealthRepairResult | AdminDoctorResult;
    }
  | { op: 'admin.config.set'; params: AdminConfigSetParams; result: AdminConfigSetResult }
  | {
      op: 'admin.config.set-preset';
      params: AdminConfigSetPresetParams;
      result: AdminConfigSetPresetResult;
    }
  | {
      op: 'admin.backup.mutate';
      params: AdminBackupMutateParams;
      result: AdminBackupCreateResult | AdminBackupRestoreByIdResult | AdminBackupRestoreFileResult;
    }
  | { op: 'admin.migrate'; params: AdminMigrateParams; result: AdminMigrateResult }
  | { op: 'admin.cleanup'; params: AdminCleanupParams; result: AdminCleanupResult }
  | { op: 'admin.job.cancel'; params: AdminJobCancelParams; result: AdminJobCancelResult }
  | { op: 'admin.safestop'; params: AdminSafestopParams; result: AdminSafestopResult }
  | {
      op: 'admin.inject.generate';
      params: AdminInjectGenerateParams;
      result: AdminInjectGenerateResult;
    }
  | {
      op: 'admin.adr.sync';
      params: AdminAdrSyncParams;
      result: AdminAdrSyncResult | AdminAdrValidateResult;
    }
  | {
      op: 'admin.import';
      params: AdminImportParams;
      result: AdminImportStandardResult | AdminImportSnapshotResult | AdminImportTasksPackageResult;
    }
  | { op: 'admin.detect'; params: AdminDetectParams; result: AdminDetectResult }
  | {
      op: 'admin.token.mutate';
      params: AdminTokenMutateParams;
      result: AdminTokenRecordResult | AdminTokenDeleteResult | AdminTokenClearResult;
    }
  | {
      op: 'admin.context.inject';
      params: AdminContextInjectParams;
      result: AdminContextInjectResult;
    }
  | { op: 'admin.map.mutate'; params: AdminMapMutateParams; result: AdminMapMutateResult }
  | {
      op: 'admin.install.global';
      params: AdminInstallGlobalParams;
      result: AdminInstallGlobalResult;
    };

// ============================================================================
// AdminHandlerOps — TypedOpRecord for TypedDomainHandler<AdminHandlerOps>
//
// Maps each handler-level operation name (without the "admin." prefix used in
// AdminOps) to a `[Params, Result]` tuple.  This is the format consumed by
// `defineTypedHandler` and `typedDispatch` in the dispatch adapter.
//
// Operations that support multiple result shapes (e.g. `admin.job` returns
// either a status record or a list) use a union result type — callers narrow
// on the `action` param they supplied.
//
// @task T1426 — typed-narrowing migration for admin domain
// @see AdminOps (discriminated-union form, kept for facade / external callers)
// ============================================================================

/**
 * TypedOpRecord for the `admin` domain handler.
 *
 * Each entry maps the bare operation name (as dispatched by the handler
 * switch, without the `admin.` domain prefix) to `[Params, Result]`.
 *
 * @task T1426 — Wave D typed-dispatch migration for admin domain
 */
export type AdminHandlerOps = {
  // ---- Query ops ----
  readonly version: readonly [AdminVersionParams, AdminVersionResult];
  readonly health: readonly [AdminHealthQueryParams, AdminHealthQueryResult | AdminDoctorResult];
  readonly 'config.show': readonly [AdminConfigShowParams, AdminConfigShowResult];
  readonly 'config.presets': readonly [AdminConfigPresetsParams, AdminConfigPresetsResult];
  readonly stats: readonly [AdminStatsParams, AdminStatsResult];
  readonly context: readonly [AdminContextParams, AdminContextResult];
  readonly 'context.pull': readonly [AdminContextPullParams, AdminContextPullResult];
  readonly runtime: readonly [AdminRuntimeParams, AdminRuntimeResult];
  readonly paths: readonly [AdminPathsParams, AdminPathsResult];
  readonly job: readonly [AdminJobStatusParams, AdminJobStatusResult | AdminJobListResult];
  readonly dash: readonly [AdminDashParams, AdminDashResult];
  readonly log: readonly [AdminLogParams, AdminLogResult];
  readonly sequence: readonly [AdminSequenceParams, AdminSequenceResult];
  readonly help: readonly [AdminHelpParams, AdminHelpResult];
  readonly token: readonly [
    AdminTokenQueryParams,
    AdminTokenSummaryResult | AdminTokenListResult | AdminTokenShowResult,
  ];
  readonly 'adr.find': readonly [AdminAdrFindParams, AdminAdrFindResult];
  readonly 'adr.show': readonly [AdminAdrShowParams, AdminAdrShowResult];
  readonly backup: readonly [AdminBackupListParams, AdminBackupListResult];
  readonly export: readonly [
    AdminExportParams,
    AdminExportStandardResult | AdminExportSnapshotResult | AdminExportTasksPackageResult,
  ];
  readonly map: readonly [AdminMapQueryParams, AdminMapResult];
  readonly roadmap: readonly [AdminRoadmapParams, AdminRoadmapResult];
  readonly smoke: readonly [AdminSmokeParams, AdminSmokeResult];
  readonly 'smoke.provider': readonly [AdminSmokeProviderParams, AdminSmokeProviderResult];
  readonly 'hooks.matrix': readonly [AdminHooksMatrixParams, AdminHooksMatrixResult];
  // ---- Mutate ops ----
  readonly init: readonly [AdminInitParams, AdminInitResult];
  readonly 'scaffold-hub': readonly [AdminScaffoldHubParams, AdminScaffoldHubResult];
  readonly 'health.mutate': readonly [
    AdminHealthMutateParams,
    AdminHealthRepairResult | AdminDoctorResult,
  ];
  readonly 'config.set': readonly [AdminConfigSetParams, AdminConfigSetResult];
  readonly 'config.set-preset': readonly [AdminConfigSetPresetParams, AdminConfigSetPresetResult];
  readonly 'backup.mutate': readonly [
    AdminBackupMutateParams,
    AdminBackupCreateResult | AdminBackupRestoreByIdResult | AdminBackupRestoreFileResult,
  ];
  readonly migrate: readonly [AdminMigrateParams, AdminMigrateResult];
  readonly cleanup: readonly [AdminCleanupParams, AdminCleanupResult];
  readonly 'job.cancel': readonly [AdminJobCancelParams, AdminJobCancelResult];
  readonly safestop: readonly [AdminSafestopParams, AdminSafestopResult];
  readonly 'inject.generate': readonly [AdminInjectGenerateParams, AdminInjectGenerateResult];
  readonly 'adr.sync': readonly [AdminAdrSyncParams, AdminAdrSyncResult | AdminAdrValidateResult];
  readonly import: readonly [
    AdminImportParams,
    AdminImportStandardResult | AdminImportSnapshotResult | AdminImportTasksPackageResult,
  ];
  readonly detect: readonly [AdminDetectParams, AdminDetectResult];
  readonly 'token.mutate': readonly [
    AdminTokenMutateParams,
    AdminTokenRecordResult | AdminTokenDeleteResult | AdminTokenClearResult,
  ];
  readonly 'context.inject': readonly [AdminContextInjectParams, AdminContextInjectResult];
  readonly 'map.mutate': readonly [AdminMapMutateParams, AdminMapMutateResult];
  readonly 'install.global': readonly [AdminInstallGlobalParams, AdminInstallGlobalResult];
};
