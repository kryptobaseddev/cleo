/**
 * Configuration type definitions for CLEO.
 *
 * Covers project and global config with cascade resolution.
 * These are stable types shared across core, dispatch, and CLI.
 *
 * @epic T4454
 * @task T4456
 * @task T5710
 */

/** Output format options. */
export type OutputFormat = 'json' | 'text' | 'jsonl' | 'markdown' | 'table';

/** Date format options. */
export type DateFormat = 'relative' | 'iso' | 'short' | 'long';

/** Output configuration. */
export interface OutputConfig {
  /** Default output format for CLI responses. */
  defaultFormat: OutputFormat;
  /** Whether to use ANSI color codes in terminal output. */
  showColor: boolean;
  /** Whether to use Unicode symbols (checkmarks, arrows) in output. */
  showUnicode: boolean;
  /** Whether to display progress bars for long-running operations. */
  showProgressBars: boolean;
  /** Date display format for timestamps in output. */
  dateFormat: DateFormat;
}

/** Backup configuration. */
export interface BackupConfig {
  /** Maximum number of operational backups to retain during normal operations. */
  maxOperationalBackups: number;
  /** Maximum number of safety backups to retain for disaster recovery. */
  maxSafetyBackups: number;
  /** Whether to compress backup files to reduce disk usage. */
  compressionEnabled: boolean;
}

/** Hierarchy enforcement profile preset. */
export type EnforcementProfile = 'llm-agent-first' | 'human-cognitive' | 'custom';

/** Hierarchy configuration. */
export interface HierarchyConfig {
  /** Maximum nesting depth for task hierarchy (epic > task > subtask). */
  maxDepth: number;
  /** Maximum number of sibling tasks under a single parent. */
  maxSiblings: number;
  /** Whether deleting a parent cascades to all descendant tasks. */
  cascadeDelete: boolean;
  /** Maximum number of active (non-done) siblings. 0 = disabled. */
  maxActiveSiblings: number;
  /** Whether done tasks count toward the sibling limit. */
  countDoneInLimit: boolean;
  /** Enforcement profile preset. Explicit fields override preset values. */
  enforcementProfile: EnforcementProfile;
}

/** Session configuration. */
export interface SessionConfig {
  /** Whether to auto-start a session on first mutate operation. */
  autoStart: boolean;
  /** Whether session end requires at least one note. */
  requireNotes: boolean;
  /** Whether multiple concurrent sessions are allowed. */
  multiSession: boolean;
}

/** Pino log levels. */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

/** Logging configuration. */
export interface LoggingConfig {
  /** Minimum log level to record (default: 'info') */
  level: LogLevel;
  /** Log file path relative to .cleo/ (default: 'logs/cleo.log') */
  filePath: string;
  /** Max log file size in bytes before rotation (default: 10MB) */
  maxFileSize: number;
  /** Number of rotated log files to retain (default: 5) */
  maxFiles: number;
  /** Days to retain audit_log rows before pruning (default: 90) */
  auditRetentionDays: number;
  /** Whether to archive pruned rows to compressed JSONL before deletion (default: true) */
  archiveBeforePrune: boolean;
}

/** Acceptance criteria enforcement mode. */
export type AcceptanceEnforcementMode = 'block' | 'warn' | 'off';

/** Acceptance criteria enforcement settings. */
export interface AcceptanceEnforcementConfig {
  /** Enforcement mode. */
  mode: AcceptanceEnforcementMode;
  /** Task priorities that require AC. */
  requiredForPriorities: string[];
  /** Minimum acceptance criteria count. */
  minimumCriteria: number;
}

/** Session enforcement settings. */
export interface SessionEnforcementConfig {
  /** Whether mutate operations require an active session. */
  requiredForMutate: boolean;
}

/** Top-level enforcement configuration. */
export interface EnforcementConfig {
  /** Acceptance criteria enforcement. */
  acceptance: AcceptanceEnforcementConfig;
  /** Session enforcement. */
  session: SessionEnforcementConfig;
}

/** Verification gate configuration. */
export interface VerificationConfig {
  /** Whether verification gates are enabled. */
  enabled: boolean;
  /** Maximum verification rounds. */
  maxRounds: number;
  /** Gate names required for completion. */
  requiredGates: string[];
}

/** Lifecycle enforcement mode. */
export type LifecycleEnforcementMode = 'strict' | 'advisory' | 'off';

/** Lifecycle enforcement configuration. */
export interface LifecycleConfig {
  /** Enforcement mode controlling how lifecycle rules are applied. */
  mode: LifecycleEnforcementMode;
}

/** Sharing mode: whether .cleo/ files are committed to the project git repo. */
export type SharingMode = 'none' | 'project';

/** Sharing configuration for multi-contributor .cleo/ state management. */
export interface SharingConfig {
  /** Sharing mode (default: 'none'). */
  mode: SharingMode;
  /** Files/patterns in .cleo/ to commit to project git (relative to .cleo/). */
  commitAllowlist: string[];
  /** Files/patterns to always exclude, even if in commitAllowlist. */
  denylist: string[];
}

/**
 * Brain memory bridge refresh configuration.
 * Controls when `.cleo/memory-bridge.md` is automatically regenerated.
 *
 * @epic T134
 * @task T135
 */
export interface BrainMemoryBridgeConfig {
  /** Whether to automatically regenerate memory-bridge.md on lifecycle events (default: true). */
  autoRefresh: boolean;
  /** Whether to include scope-aware memory context in generated bridge (default: false). */
  contextAware: boolean;
  /** Maximum token budget for memory bridge content (default: 2000). */
  maxTokens: number;
}

/**
 * Brain embedding provider configuration.
 *
 * @epic T134
 * @task T136
 */
export interface BrainEmbeddingConfig {
  /** Whether semantic embedding is enabled (default: false). */
  enabled: boolean;
  /** Embedding provider to use (default: 'local'). */
  provider: 'local' | 'openai';
}

/**
 * Brain session summarization configuration.
 *
 * @epic T134
 * @task T140
 */
export interface BrainSummarizationConfig {
  /** Whether session summarization is enabled (default: false). */
  enabled: boolean;
}

/**
 * Brain tiered + typed memory configuration (T549).
 *
 * Controls the tiered cognitive memory model: tier promotion, eviction TTLs,
 * and the sleep-time consolidator. All fields default to disabled/conservative
 * values — the system requires explicit opt-in.
 *
 * @epic T549
 */
export interface BrainTieringConfig {
  /**
   * Enable write-time tier/type/source_confidence assignment and updated quality scoring.
   * When false (default), new entries receive column defaults without routing logic overhead.
   */
  enabled: boolean;
  /**
   * Enable the sleep-time consolidator: runs tier promotion, eviction, and contradiction
   * detection at session end (after VACUUM INTO backup). Fires as setImmediate — non-blocking.
   * Requires `enabled: true` to take effect.
   */
  autoPromote: boolean;
  /**
   * Hours before unverified short-term entries are soft-evicted (default: 48).
   * Set invalidAt on entries older than this threshold that were not promoted.
   */
  shortTermTtlHours: number;
  /**
   * Days before unverified medium-term entries are soft-evicted (default: 30).
   * Medium-term entries with quality_score below the medium decay threshold are evicted.
   */
  mediumTermTtlDays: number;
  /**
   * Minimum citations for medium→long promotion via citation gate (default: 5).
   * An entry at medium tier with citationCount >= promotionThreshold qualifies for long-term.
   */
  promotionThreshold: number;
}

/**
 * Brain LLM-driven extraction gate configuration.
 *
 * Controls the LLM-based extraction pipeline that replaces the legacy keyword
 * regex in `memory/auto-extract.ts`. When enabled and ANTHROPIC_API_KEY is
 * present, session transcripts are processed by an LLM to extract typed,
 * structured memories (decisions, patterns, learnings, constraints,
 * corrections) instead of noise-laden keyword matches.
 */
export interface BrainLlmExtractionConfig {
  /** Enable LLM-driven extraction gate (default: true). */
  enabled: boolean;
  /** Anthropic model to use for extraction (default: 'claude-haiku-4-5-20251001'). */
  model: string;
  /** Minimum importance score (0.0–1.0) below which extractions are dropped (default: 0.6). */
  minImportance: number;
  /** Maximum number of memories to extract per transcript (default: 7). */
  maxExtractions: number;
  /** Maximum transcript characters sent to the model per call (default: 60000). */
  maxTranscriptChars: number;
}

/**
 * Brain (BRAIN memory system) configuration.
 * Controls automated memory capture, embedding generation, memory bridge
 * refresh behavior, and session summarization.
 *
 * @epic T134
 * @task T135
 */
export interface BrainConfig {
  /** Whether to automatically capture observations from lifecycle events (default: true). */
  autoCapture: boolean;
  /** Whether to capture file change events (default: false). */
  captureFiles: boolean;
  /** Whether to capture active-work dispatch mutations (tasks.add, tasks.update) (default: false). */
  captureWork: boolean;
  /** Embedding provider settings. */
  embedding: BrainEmbeddingConfig;
  /** Memory bridge auto-refresh settings. */
  memoryBridge: BrainMemoryBridgeConfig;
  /** Session summarization settings. */
  summarization: BrainSummarizationConfig;
  /**
   * Tiered + typed memory settings (T549).
   * Controls tier routing, sleep-time consolidation, and TTL-based eviction.
   * All fields default to disabled. Opt-in required.
   *
   * @defaultValue { enabled: false, autoPromote: false, shortTermTtlHours: 48, mediumTermTtlDays: 30, promotionThreshold: 5 }
   */
  tiering?: BrainTieringConfig;
  /**
   * LLM-driven extraction gate settings.
   * When enabled and ANTHROPIC_API_KEY is present, session transcripts are
   * processed by an LLM to extract typed structured memories instead of the
   * legacy keyword regex. Defaults are enabled: true and model is the cheap
   * Haiku class so extraction cost stays bounded.
   *
   * @defaultValue { enabled: true, model: 'claude-haiku-4-5-20251001', minImportance: 0.6, maxExtractions: 7, maxTranscriptChars: 60000 }
   */
  llmExtraction?: BrainLlmExtractionConfig;
}

/**
 * Structured session summary input for ingestStructuredSummary().
 *
 * @epic T134
 * @task T140
 */
export interface SessionSummaryInput {
  /** Key learnings from this session. */
  keyLearnings: string[];
  /** Decisions made during this session. */
  decisions: string[];
  /** Patterns observed during this session. */
  patterns: string[];
  /** Suggested next actions. */
  nextActions: string[];
}

/** SignalDock transport mode. */
export type SignalDockMode = 'http' | 'native';

/** SignalDock integration configuration. */
export interface SignalDockConfig {
  /** Whether SignalDock transport is enabled (default: false). */
  enabled: boolean;
  /** Transport mode: 'http' for REST API client, 'native' for napi-rs bindings (default: 'http'). */
  mode: SignalDockMode;
  /** SignalDock API server endpoint (default: 'http://localhost:4000'). */
  endpoint: string;
  /** Prefix for CLEO agent names in SignalDock registry (default: 'cleo-'). */
  agentPrefix: string;
  /** Default privacy tier for registered agents (default: 'private'). */
  privacyTier: 'public' | 'discoverable' | 'private';
}

/** CLEO project configuration (config.json). */
export interface CleoConfig {
  /** Configuration schema version string. */
  version: string;
  /** Output formatting preferences. */
  output: OutputConfig;
  /** Database backup retention and compression settings. */
  backup: BackupConfig;
  /** Task hierarchy depth and sibling constraints. */
  hierarchy: HierarchyConfig;
  /** Session auto-start and multi-session policies. */
  session: SessionConfig;
  /** Acceptance criteria and session enforcement rules. */
  enforcement: EnforcementConfig;
  /** Verification gate pipeline settings. */
  verification: VerificationConfig;
  /** Task lifecycle enforcement mode. */
  lifecycle: LifecycleConfig;
  /** Log level, rotation, and audit retention settings. */
  logging: LoggingConfig;
  /** Multi-contributor `.cleo/` state sharing settings. */
  sharing: SharingConfig;
  /**
   * SignalDock inter-agent transport (optional, disabled by default).
   *
   * @defaultValue undefined
   */
  signaldock?: SignalDockConfig;
  /**
   * Brain memory system configuration (optional, uses defaults when absent).
   *
   * @defaultValue undefined
   */
  brain?: BrainConfig;
  /**
   * Provider-specific configuration (optional, uses defaults when absent).
   *
   * @defaultValue undefined
   */
  provider?: ProviderConfig;
}

/**
 * Claude provider spawn mode.
 *
 * - `'cli'` — use the `ClaudeCodeSpawnProvider` (shells out to `claude` CLI).
 *   This is the default and requires the Claude Code CLI to be installed.
 * - `'sdk'` — use the `ClaudeSDKSpawnProvider` (programmatic SDK, requires
 *   `ANTHROPIC_API_KEY`). Enables structured output, session IDs, and
 *   multi-turn resumption.
 */
export type ClaudeSpawnMode = 'cli' | 'sdk';

/** Configuration for the Claude provider adapter. */
export interface ClaudeProviderConfig {
  /**
   * Spawn mode for Claude subagents.
   *
   * @defaultValue 'cli'
   */
  mode?: ClaudeSpawnMode;
}

/** Top-level provider adapter configuration. */
export interface ProviderConfig {
  /**
   * Claude-specific provider settings.
   *
   * @defaultValue undefined
   */
  claude?: ClaudeProviderConfig;
}

/** Configuration resolution priority. */
export type ConfigSource = 'cli' | 'env' | 'project' | 'global' | 'default';

/** A resolved config value with its source. */
export interface ResolvedValue<T> {
  /** The resolved configuration value. */
  value: T;
  /** Where this value was resolved from in the cascade. */
  source: ConfigSource;
}
