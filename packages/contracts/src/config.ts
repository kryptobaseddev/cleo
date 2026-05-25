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

import type { ModelTransport } from './operations/llm.js';

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

/**
 * Threshold controlling which tasks REQUIRE a declared dependency on creation.
 *
 * - `'critical'` — only critical-priority tasks require `--depends` (default, matches T1856 behaviour)
 * - `'high'`     — critical + high-priority tasks require `--depends`
 * - `'all'`      — all tasks require `--depends`
 * - `'off'`      — no mandatory dep declaration
 *
 * Consumed by T1858 (`orchestrate ready` guard) to decide which tasks to gate.
 *
 * @task T1857
 * @epic T1855
 * @defaultValue 'critical'
 */
export type DepsRequiredAt = 'critical' | 'high' | 'all' | 'off';

/** Lifecycle enforcement configuration. */
export interface LifecycleConfig {
  /** Enforcement mode controlling how lifecycle rules are applied. */
  mode: LifecycleEnforcementMode;
  /**
   * Threshold for mandatory dependency declaration on task creation.
   *
   * @task T1857
   * @epic T1855
   * @defaultValue 'critical'
   */
  depsRequiredAt?: DepsRequiredAt;
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
 * Memory bridge injection mode.
 *
 * - `'cli'`      — AGENTS.md receives a `cleo memory digest --brief` CLI directive instead of
 *                  `@.cleo/memory-bridge.md`. The bridge markdown file is NOT written on refresh.
 *                  This is the default for new installations (T999). Also surfaced to operators
 *                  as the `digest` mode in `cleo setup` (T9425) — the wire value stays `'cli'`
 *                  so existing project configs keep working unchanged.
 * - `'file'`     — Legacy behavior: `.cleo/memory-bridge.md` is written on refresh and
 *                  `@.cleo/memory-bridge.md` is injected into AGENTS.md verbatim.
 *                  Use this for backcompat with tooling that reads the file directly.
 * - `'disabled'` — Bridge injection is suppressed entirely; AGENTS.md gets neither a CLI
 *                  directive nor a file include. Operators select this from `cleo setup`
 *                  when they want to opt out of BRAIN-driven AGENTS.md augmentation (T9425).
 */
export type MemoryBridgeMode = 'cli' | 'file' | 'disabled';

/**
 * Brain memory bridge refresh configuration.
 * Controls when `.cleo/memory-bridge.md` is automatically regenerated.
 *
 * @epic T134
 * @task T135
 * @task T999
 */
export interface BrainMemoryBridgeConfig {
  /** Whether to automatically regenerate memory-bridge.md on lifecycle events (default: true). */
  autoRefresh: boolean;
  /** Whether to include scope-aware memory context in generated bridge (default: false). */
  contextAware: boolean;
  /** Maximum token budget for memory bridge content (default: 2000). */
  maxTokens: number;
  /**
   * Injection mode for the memory and nexus bridges (default: `'cli'`).
   *
   * `'cli'`  — AGENTS.md gets a `cleo memory digest --brief` directive; no `.md` files written.
   * `'file'` — legacy `@.cleo/memory-bridge.md` + `@.cleo/nexus-bridge.md` injection.
   *
   * @defaultValue 'cli'
   */
  mode: MemoryBridgeMode;
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
  /**
   * Anthropic model to use for extraction. Default lives in
   * `@cleocode/core/llm/role-resolver` (`IMPLICIT_FALLBACK_MODEL`) so the
   * literal stays in a single source location (T9255 grep guard).
   */
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
   * legacy keyword regex. Defaults are enabled: true and model defaults to
   * the centralised implicit fallback (cheap Haiku class) defined in
   * `@cleocode/core/llm/role-resolver` so extraction cost stays bounded.
   *
   * @defaultValue { enabled: true, model: IMPLICIT_FALLBACK_MODEL, minImportance: 0.6, maxExtractions: 7, maxTranscriptChars: 60000 }
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

// ---------------------------------------------------------------------------
// LLM daemon + provider config (T1677)
// ---------------------------------------------------------------------------

/**
 * Per-provider API key override in ~/.cleo/config.json or .cleo/config.json.
 *
 * Stored as `llm.providers[<provider>].apiKey`. The centralised
 * `resolveCredentials()` reads this as resolution tier 4 (global-config) or
 * tier 5 (project-config).
 */
export interface LlmProviderEntry {
  /** Override API key for this provider (stored in config, not env). */
  apiKey?: string;
}

/**
 * Config-layer transport identifier — re-export of {@link ModelTransport}
 * from `operations/llm.ts` so config-layer types stay in lock-step with the
 * operations layer with no risk of drift.
 *
 * Previously declared as a separate string-literal union; collapsed in the
 * T-LLM-CRED Phase 2 DRY/SOLID review (P1-2). Adding a new transport now
 * requires editing only `operations/llm.ts`.
 *
 * **Disambiguation**: This is the *config-level* alias for the
 * `ModelTransport` string-literal union (`'anthropic' | 'openai' | ...`).
 * It is intentionally distinct from the `LlmTransport` *interface* defined
 * in `packages/contracts/src/llm/normalized-response.ts` (Phase 4 wire-level
 * protocol). Renamed from `LlmTransport` → `LlmProviderTransport` in T9308
 * to eliminate the name collision.
 *
 * @task T-LLM-CRED-CENTRALIZATION Phase 2 — DRY review P1-2
 * @see T9308 — disambiguation rename
 */
export type LlmProviderTransport = ModelTransport;

/**
 * Logical LLM role name used by role-aware resolvers (BRAIN, sentient, etc.).
 *
 * Each role can pin its own provider + model + credential label, with
 * resolution falling back to `LlmConfig.default`.
 *
 * @task T-LLM-CRED-CENTRALIZATION Phase 4 (T9306)
 */
export type RoleName =
  | 'extraction'
  | 'consolidation'
  | 'derivation'
  | 'hygiene'
  | 'judgement'
  /** Sandbox role for plugin-scoped single-turn calls (T9305). */
  | 'plugin'
  /** Context-compression role — uses a cheap model (haiku) for summarization (T9304). */
  | 'compression';

/**
 * Canonical default LLM target for unscoped (non-role) calls.
 *
 * @task T-LLM-CRED-CENTRALIZATION Phase 4 (T9306)
 */
export interface LlmDefaultConfig {
  /** LLM provider transport for the default model. */
  provider: LlmProviderTransport;
  /** Full model identifier for the selected provider. */
  model: string;
}

/**
 * Per-role LLM configuration entry.
 *
 * Each role may optionally pin to a specific credential label (matching a
 * `CredentialResult.label`) so that, e.g., the `extraction` role can use a
 * different Anthropic API key than `judgement` without changing the global
 * default.
 *
 * @task T-LLM-CRED-CENTRALIZATION Phase 2 (T9256)
 */
export interface LlmRoleConfig {
  /** LLM provider transport for this role. */
  provider: LlmProviderTransport;
  /** Full model identifier for the selected provider. */
  model: string;
  /**
   * Optional credential label to pin this role to a specific credential
   * entry resolved by `resolveCredentials()`. When omitted, the role
   * inherits the default credential resolution order.
   */
  credentialLabel?: string;
}

/**
 * Top-level LLM configuration block inside CleoConfig.
 *
 * Stored at `llm` in config.json.
 *
 * Resolution order for role-scoped calls:
 *   `roles[role]` → `default` → implicit fallback.
 *
 * Note: configs that still carry a `llm.daemon` key are silently ignored
 * at parse time — they will not cause a crash. Migration: remove the key
 * and add `llm.default` or `llm.roles.<role>` instead.
 *
 * @task T-LLM-CRED-CENTRALIZATION Phase 4 (T9306)
 */
export interface LlmConfig {
  /**
   * Per-provider API key overrides.
   * Keys are provider names: 'anthropic' | 'openai' | 'gemini' | 'moonshot'.
   */
  providers?: Record<string, LlmProviderEntry>;
  /**
   * Canonical default LLM for unscoped calls.
   *
   * @task T-LLM-CRED-CENTRALIZATION Phase 4 (T9306)
   */
  default?: LlmDefaultConfig;
  /**
   * Per-role LLM overrides. Each role optionally pins to a credential label.
   *
   * Resolution order: `roles[role]` → `default` → implicit fallback.
   *
   * @task T-LLM-CRED-CENTRALIZATION Phase 4 (T9306)
   */
  roles?: Partial<Record<RoleName, LlmRoleConfig>>;
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

/**
 * Decision memory write-gate configuration.
 *
 * Controls the LLM conflict-validator hook that runs on every ADR-typed
 * decision write (i.e. writes where `adrPath` is set or `adrNumber` is
 * requested).  The hook calls the dialectic evaluator to detect collisions,
 * contradictions, and supersession-graph violations before the decision is
 * persisted.
 *
 * @task T1828
 */
export interface DecisionsConfig {
  /**
   * Minimum confidence score (0.0–1.0) returned by the LLM conflict-validator
   * for an ADR-typed decision write to be accepted.
   *
   * Writes that fall below this threshold are rejected with
   * `E_DECISION_VALIDATOR_FAILED`.
   *
   * @defaultValue 0.7
   */
  validatorConfidenceThreshold?: number;
}

/**
 * Operating mode for the Lead-tier wave roll-up
 * (`packages/core/src/orchestration/lead-rollup.ts`).
 *
 * - `'passive'` — Default, backward-compatible behaviour. `rollupWaveStatus` /
 *   `rollupEpicStatus` compute the rollup contract from manifest +
 *   verification rows only. The Lead reads the result and decides what to do
 *   externally.
 * - `'active'`  — Enables the Lead↔Worker Max-N loop scaffolded by T10383
 *   (E-VALIDATOR-ROLE). The rollup will additionally surface retry-eligible
 *   workers and emit Lead-initiated retry signals.  The wiring of retries
 *   themselves lives in T10512 — this flag is the gate.
 * - `'auto'`    — Reserved for future heuristic selection (e.g. switch to
 *   active mode iff the epic has ≥N pending workers). Treated as `'passive'`
 *   at runtime until the heuristic ships.
 *
 * @task T10513
 * @saga T10377
 * @adr ADR-070
 */
export type LeadRollupMode = 'passive' | 'active' | 'auto';

/**
 * Lead-tier wave roll-up configuration.
 *
 * Single-key config block gating the Lead↔Worker Max-N loop introduced by
 * SG-IVTR-AC-BINDING (T10377) and council action #9 of E-VALIDATOR-ROLE
 * (T10383). The whole point of this block is to keep the existing
 * `rollupWaveStatus` / `rollupEpicStatus` function signatures unchanged —
 * callers pick up new behaviour by flipping the config key, never by
 * threading a new parameter.
 *
 * @task T10513
 * @saga T10377
 */
export interface LeadRollupConfig {
  /**
   * Roll-up operating mode. Defaults to `'passive'` for backward compatibility.
   *
   * @defaultValue 'passive'
   */
  mode?: LeadRollupMode;
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
  /**
   * LLM configuration — daemon provider/model and per-provider API key overrides.
   *
   * @defaultValue undefined
   */
  llm?: LlmConfig;
  /**
   * Decision memory write-gate configuration.
   *
   * When present, the LLM conflict-validator hook is applied to ADR-typed
   * decision writes (`adrPath` set).  When absent, the validator uses its
   * default threshold of 0.7.
   *
   * @defaultValue undefined
   * @task T1828
   */
  decisions?: DecisionsConfig;
  /**
   * Briefing pipeline settings (T1904 / BBTT-W2-3).
   *
   * @defaultValue undefined
   */
  briefing?: BriefingConfig;
  /**
   * Auth-source consent gates for credential seeders.
   *
   * Gates third-party credential imports (e.g. Claude Code OAuth) behind
   * explicit operator opt-in. Mirrors Hermes Agent's PR #4210 consent gate.
   *
   * @defaultValue undefined
   * @task T9410
   */
  auth?: AuthConfig;
  /**
   * Lead-tier wave roll-up configuration.
   *
   * Gates the Lead↔Worker Max-N loop scaffolded under SG-IVTR-AC-BINDING
   * (T10377) and council action #9 of E-VALIDATOR-ROLE (T10383). When
   * absent, the roll-up defaults to `{ mode: 'passive' }` — the legacy
   * compute-from-manifest behaviour — so existing callers continue to work
   * unchanged.
   *
   * @defaultValue undefined
   * @task T10513
   * @saga T10377
   */
  leadRollup?: LeadRollupConfig;
}

/**
 * Auth-source consent configuration.
 *
 * Concrete `CredentialSeeder` implementations consult these flags before
 * reading any third-party credential file (e.g. `~/.claude/.credentials.json`).
 * Defaulting every flag to `false` keeps auxiliary fallback chains opt-in:
 * aux callers cannot silently read user credentials they were never granted.
 *
 * @task T9410
 */
export interface AuthConfig {
  /**
   * Whether the operator has explicitly opted in to import the Claude Code
   * OAuth token (`~/.claude/.credentials.json`) into the CLEO credential
   * pool.
   *
   * When `false` (default), the `claude-code` seeder MUST NOT read the file
   * and MUST return an empty seeder result. When `true`, the seeder reads
   * the file and emits a single `source: 'claude-code'` entry for the
   * `anthropic` provider.
   *
   * @defaultValue false
   */
  claudeCodeConsentGiven?: boolean;
  /**
   * Whether CLEO writes refreshed Anthropic OAuth tokens back to Claude
   * Code's credential file (`~/.claude/.credentials.json`) in addition to
   * CLEO's own canonical token file (`${getCleoHome()}/anthropic-oauth.json`).
   *
   * CLEO ALWAYS writes its own file on every refresh. The cooperative write
   * to Claude Code's file is gated by this flag AND by either
   * (a) the Claude Code file already existing on disk, or
   * (b) `claudeCodeConsentGiven` being `true`.
   *
   * This mirrors the OQ-1 decision in `docs/plans/E-CONFIG-AUTH-UNIFY.md`:
   * cooperative write-back is enabled by default so two CLIs sharing one
   * machine stay token-coherent, but CLEO never creates Claude Code's file
   * unless the operator has explicitly opted in.
   *
   * @defaultValue true
   * @task T9411
   */
  cooperativeWriteBack?: boolean;
}

/**
 * Configuration for the `cleo briefing` pipeline (T1904 / BBTT-W2-3).
 */
export interface BriefingConfig {
  /**
   * Whether `cleo briefing` opportunistically triggers a dream cycle after
   * computing the briefing response.
   *
   * The dream cycle is always subject to its own 5-minute cooldown guard and
   * never blocks the briefing response.
   *
   * @defaultValue true
   */
  opportunisticDream?: boolean;
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
