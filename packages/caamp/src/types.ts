/**
 * CAAMP - Central AI Agent Managed Packages
 * Core type definitions
 */

// ── SkillLibrary Types (primary) ─────────────────────────────────────

// Re-export SkillLibrary types as the primary catalog types
export type {
  SkillLibrary,
  SkillLibraryDispatchMatrix,
  SkillLibraryEntry,
  SkillLibraryManifest,
  SkillLibraryManifestSkill,
  SkillLibraryProfile,
  SkillLibraryValidationIssue,
  SkillLibraryValidationResult,
} from './core/skills/skill-library.js';

// ── Backward-compatible aliases (deprecated) ────────────────────────

import type {
  SkillLibraryDispatchMatrix,
  SkillLibraryEntry,
  SkillLibraryManifest,
  SkillLibraryManifestSkill,
  SkillLibraryProfile,
  SkillLibraryValidationIssue,
  SkillLibraryValidationResult,
} from './core/skills/skill-library.js';

/**
 * Backward-compatible alias for {@link SkillLibraryEntry}.
 *
 * @deprecated Use `SkillLibraryEntry` instead.
 * @public
 */
export type CtSkillEntry = SkillLibraryEntry;
/**
 * Backward-compatible alias for {@link SkillLibraryValidationResult}.
 *
 * @deprecated Use `SkillLibraryValidationResult` instead.
 * @public
 */
export type CtValidationResult = SkillLibraryValidationResult;
/**
 * Backward-compatible alias for {@link SkillLibraryValidationIssue}.
 *
 * @deprecated Use `SkillLibraryValidationIssue` instead.
 * @public
 */
export type CtValidationIssue = SkillLibraryValidationIssue;
/**
 * Backward-compatible alias for {@link SkillLibraryProfile}.
 *
 * @deprecated Use `SkillLibraryProfile` instead.
 * @public
 */
export type CtProfileDefinition = SkillLibraryProfile;
/**
 * Backward-compatible alias for {@link SkillLibraryDispatchMatrix}.
 *
 * @deprecated Use `SkillLibraryDispatchMatrix` instead.
 * @public
 */
export type CtDispatchMatrix = SkillLibraryDispatchMatrix;
/**
 * Backward-compatible alias for {@link SkillLibraryManifest}.
 *
 * @deprecated Use `SkillLibraryManifest` instead.
 * @public
 */
export type CtManifest = SkillLibraryManifest;
/**
 * Backward-compatible alias for {@link SkillLibraryManifestSkill}.
 *
 * @deprecated Use `SkillLibraryManifestSkill` instead.
 * @public
 */
export type CtManifestSkill = SkillLibraryManifestSkill;

// ── Config Formats ──────────────────────────────────────────────────

/**
 * Supported configuration file formats.
 *
 * - `"json"` - Standard JSON
 * - `"jsonc"` - JSON with comments (comment-preserving via jsonc-parser)
 * - `"yaml"` - YAML (via js-yaml)
 * - `"toml"` - TOML (via \@iarna/toml)
 *
 * @example
 * ```typescript
 * const format: ConfigFormat = "jsonc";
 * ```
 *
 * @public
 */
export type ConfigFormat = 'json' | 'jsonc' | 'yaml' | 'toml';

// ── Transport Types ─────────────────────────────────────────────────

/**
 * MCP server transport protocol type.
 *
 * - `"stdio"` - Standard input/output (local process)
 * - `"sse"` - Server-Sent Events (remote)
 * - `"http"` - HTTP/Streamable HTTP (remote)
 *
 * @example
 * ```typescript
 * const transport: TransportType = "stdio";
 * ```
 *
 * @public
 */
export type TransportType = 'stdio' | 'sse' | 'http';

// ── Detection ───────────────────────────────────────────────────────

/**
 * Method used to detect whether an AI agent is installed on the system.
 *
 * - `"binary"` - Check if a CLI binary exists on PATH
 * - `"directory"` - Check if known config/data directories exist
 * - `"appBundle"` - Check for macOS .app bundle in standard app directories
 * - `"flatpak"` - Check for Flatpak installation on Linux
 *
 * @public
 */
export type DetectionMethod = 'binary' | 'directory' | 'appBundle' | 'flatpak';

/**
 * Configuration for detecting whether a provider is installed.
 *
 * @remarks
 * Each detection config specifies one or more methods to try in order.
 * The first method that succeeds determines the provider as installed.
 * Method-specific fields (binary, directories, appBundle, flatpakId) are
 * only used when their corresponding method is listed in `methods`.
 *
 * @example
 * ```typescript
 * const config: DetectionConfig = {
 *   methods: ["binary", "directory"],
 *   binary: "claude",
 *   directories: ["~/.config/claude"],
 * };
 * ```
 *
 * @public
 */
export interface DetectionConfig {
  /** Detection methods to try, in order. */
  methods: DetectionMethod[];
  /**
   * Binary name to look up on PATH (for `"binary"` method).
   * @defaultValue undefined
   */
  binary?: string;
  /**
   * Directories to check for existence (for `"directory"` method).
   * @defaultValue undefined
   */
  directories?: string[];
  /**
   * macOS .app bundle name (for `"appBundle"` method).
   * @defaultValue undefined
   */
  appBundle?: string;
  /**
   * Flatpak application ID (for `"flatpak"` method).
   * @defaultValue undefined
   */
  flatpakId?: string;
}

// ── Provider Capabilities ────────────────────────────────────────────

// Re-export capability enums from registry types for convenience
export type { HookEvent, SkillsPrecedence, SpawnMechanism } from './core/registry/types.js';

/**
 * Resolved skills capability for a provider at runtime.
 *
 * @remarks
 * Describes how a provider resolves skill file paths, including whether
 * it supports the shared `.agents/skills` directory at global and project
 * scopes, and the precedence order for skill file lookup.
 *
 * @public
 */
export interface ProviderSkillsCapability {
  /** Resolved global `.agents/skills` path, or `null` if unsupported. */
  agentsGlobalPath: string | null;
  /** Project-relative `.agents/skills` path, or `null` if unsupported. */
  agentsProjectPath: string | null;
  /** How this provider resolves skill file precedence. */
  precedence: import('./core/registry/types.js').SkillsPrecedence;
}

/**
 * Resolved hooks capability for a provider at runtime.
 *
 * @remarks
 * Describes which hook lifecycle events a provider supports and where
 * the hook configuration file is located. The hook format indicates how
 * the configuration should be read and written.
 *
 * @public
 */
export interface ProviderHooksCapability {
  /** Hook lifecycle events this provider supports. */
  supported: import('./core/registry/types.js').HookEvent[];
  /** Resolved path to hook configuration file, or `null`. */
  hookConfigPath: string | null;
  /** Format of the hook config file. */
  hookFormat: 'json' | 'yaml' | 'toml' | 'javascript' | null;
}

/**
 * Resolved spawn capability for a provider at runtime.
 *
 * @remarks
 * Describes whether a provider can spawn subagents and the features
 * available for multi-agent coordination. This includes programmatic
 * spawning, inter-agent communication, and parallel execution support.
 *
 * @public
 */
export interface ProviderSpawnCapability {
  /** Whether the provider supports spawning subagents. */
  supportsSubagents: boolean;
  /** Whether subagents can be spawned programmatically. */
  supportsProgrammaticSpawn: boolean;
  /** Whether spawned agents can communicate with each other. */
  supportsInterAgentComms: boolean;
  /** Whether multiple agents can be spawned in parallel. */
  supportsParallelSpawn: boolean;
  /** Mechanism used for spawning. */
  spawnMechanism: import('./core/registry/types.js').SpawnMechanism | null;
}

/**
 * Aggregate provider capabilities for skills, hooks, and spawn.
 *
 * @remarks
 * Groups the three capability dimensions into a single object that is
 * always populated on the resolved {@link Provider} interface at runtime.
 * Unlike the raw registry type, all three fields are required here.
 *
 * @public
 */
export interface ProviderCapabilities {
  /** Skills path resolution and precedence. */
  skills: ProviderSkillsCapability;
  /** Hook/lifecycle event support. */
  hooks: ProviderHooksCapability;
  /** Subagent spawn capabilities. */
  spawn: ProviderSpawnCapability;
}

// ── Provider ────────────────────────────────────────────────────────

/**
 * Priority tier for a provider, used for sorting and default selection.
 *
 * - `"high"` - Major, widely-used agents
 * - `"medium"` - Established but less common agents
 * - `"low"` - Niche or experimental agents
 *
 * @public
 */
export type ProviderPriority = 'high' | 'medium' | 'low';

/**
 * Lifecycle status of a provider in the registry.
 *
 * - `"active"` - Fully supported
 * - `"beta"` - Supported but may have rough edges
 * - `"deprecated"` - Still present but no longer recommended
 * - `"planned"` - Not yet implemented
 *
 * @public
 */
export type ProviderStatus = 'active' | 'beta' | 'deprecated' | 'planned';

/**
 * A resolved AI agent provider definition with platform-specific paths.
 *
 * @remarks
 * Providers are loaded from `providers/registry.json` and resolved at runtime
 * to expand platform-specific path variables (`$HOME`, `$CONFIG`, etc.).
 * This is the primary type used throughout the CAAMP codebase for working
 * with provider configurations.
 *
 * @example
 * ```typescript
 * const provider = getProvider("claude-code");
 * if (provider) {
 *   console.log(provider.configPathGlobal);
 * }
 * ```
 *
 * @public
 */
export interface Provider {
  /** Unique provider identifier (e.g. `"claude-code"`). */
  id: string;
  /** Human-readable tool name (e.g. `"Claude Code"`). */
  toolName: string;
  /** Vendor/company name (e.g. `"Anthropic"`). */
  vendor: string;
  /** CLI flag name for `--agent` selection. */
  agentFlag: string;
  /** Alternative names that resolve to this provider. */
  aliases: string[];

  /** Resolved global instruction file directory path. */
  pathGlobal: string;
  /** Project-relative instruction file directory path. */
  pathProject: string;

  /** Instruction file name (e.g. `"CLAUDE.md"`, `"AGENTS.md"`). */
  instructFile: string;

  /** Dot-notation key path for MCP server config (e.g. `"mcpServers"`). */
  configKey: string;
  /** Config file format used by this provider. */
  configFormat: ConfigFormat;
  /** Resolved global config file path. */
  configPathGlobal: string;
  /** Project-relative config file path, or `null` if unsupported. */
  configPathProject: string | null;

  /** Resolved global skills directory path. */
  pathSkills: string;
  /** Project-relative skills directory path. */
  pathProjectSkills: string;

  /** Detection configuration for auto-discovering this provider. */
  detection: DetectionConfig;

  /** MCP transport protocols this provider supports. */
  supportedTransports: TransportType[];
  /** Whether the provider supports custom HTTP headers for remote MCP servers. */
  supportsHeaders: boolean;

  /** Priority tier for sorting and default selection. */
  priority: ProviderPriority;
  /** Lifecycle status in the registry. */
  status: ProviderStatus;
  /** Whether the provider is compatible with the Agent Skills standard. */
  agentSkillsCompatible: boolean;

  /** Provider capabilities for skills, hooks, and spawn. Always populated at runtime. */
  capabilities: ProviderCapabilities;
}

// ── MCP Server Config (Canonical) ───────────────────────────────────

/**
 * Canonical MCP server configuration.
 *
 * @remarks
 * Represents either a remote server (via `url`) or a local stdio process
 * (via `command` + `args`). This canonical format is transformed to
 * provider-specific shapes before writing to config files. The transform
 * layer handles differences in key naming, nesting, and transport defaults
 * across the 28+ supported providers.
 *
 * @example
 * ```typescript
 * // Remote server
 * const remote: McpServerConfig = {
 *   type: "http",
 *   url: "https://mcp.example.com/sse",
 * };
 *
 * // Local stdio server
 * const local: McpServerConfig = {
 *   command: "npx",
 *   args: ["-y", "@modelcontextprotocol/server-filesystem"],
 * };
 * ```
 *
 * @public
 */
export interface McpServerConfig {
  /**
   * Transport type (`"stdio"`, `"sse"`, or `"http"`).
   * @defaultValue undefined
   */
  type?: TransportType;
  /**
   * URL for remote MCP servers.
   * @defaultValue undefined
   */
  url?: string;
  /**
   * HTTP headers for remote MCP servers.
   * @defaultValue undefined
   */
  headers?: Record<string, string>;
  /**
   * Command to run for stdio MCP servers.
   * @defaultValue undefined
   */
  command?: string;
  /**
   * Arguments for the stdio command.
   * @defaultValue undefined
   */
  args?: string[];
  /**
   * Environment variables for the stdio process.
   * @defaultValue undefined
   */
  env?: Record<string, string>;
}

// ── Source Parsing ───────────────────────────────────────────────────

/**
 * Classified type of an MCP server or skill source.
 *
 * - `"remote"` - HTTP/HTTPS URL to a remote MCP server
 * - `"package"` - npm package name
 * - `"command"` - Shell command string
 * - `"github"` - GitHub repository (URL or shorthand)
 * - `"gitlab"` - GitLab repository URL
 * - `"local"` - Local filesystem path
 * - `"library"` - Built-in skill library reference
 *
 * @public
 */
export type SourceType =
  | 'remote'
  | 'package'
  | 'command'
  | 'github'
  | 'gitlab'
  | 'local'
  | 'library';

/**
 * Result of parsing a source string into its typed components.
 *
 * @remarks
 * Produced by the source parser, which classifies raw source strings
 * (URLs, paths, package names, GitHub shorthands) into structured objects.
 * Optional fields like `owner`, `repo`, `path`, and `ref` are only
 * populated for GitHub and GitLab source types.
 *
 * @example
 * ```typescript
 * const parsed: ParsedSource = {
 *   type: "github",
 *   value: "https://github.com/owner/repo",
 *   inferredName: "repo",
 *   owner: "owner",
 *   repo: "repo",
 * };
 * ```
 *
 * @public
 */
export interface ParsedSource {
  /** Classified source type. */
  type: SourceType;
  /** Original or normalized source value. */
  value: string;
  /** Display name inferred from the source. */
  inferredName: string;
  /**
   * Repository owner (for GitHub/GitLab sources).
   * @defaultValue undefined
   */
  owner?: string;
  /**
   * Repository name (for GitHub/GitLab sources).
   * @defaultValue undefined
   */
  repo?: string;
  /**
   * Path within the repository (for GitHub/GitLab sources).
   * @defaultValue undefined
   */
  path?: string;
  /**
   * Git ref / branch / tag (for GitHub/GitLab sources).
   * @defaultValue undefined
   */
  ref?: string;
}

// ── Skills ──────────────────────────────────────────────────────────

/**
 * Metadata extracted from a SKILL.md frontmatter.
 *
 * @remarks
 * Parsed from the YAML frontmatter block at the top of a SKILL.md file.
 * Only `name` and `description` are required; all other fields are optional
 * and provide additional context for skill discovery and compatibility checks.
 *
 * @example
 * ```typescript
 * const meta: SkillMetadata = {
 *   name: "my-skill",
 *   description: "A useful skill for code generation",
 *   version: "1.0.0",
 * };
 * ```
 *
 * @public
 */
export interface SkillMetadata {
  /** Skill name (lowercase, hyphens only). */
  name: string;
  /** Human-readable description. */
  description: string;
  /**
   * SPDX license identifier.
   * @defaultValue undefined
   */
  license?: string;
  /**
   * Compatibility notes (e.g. agent versions).
   * @defaultValue undefined
   */
  compatibility?: string;
  /**
   * Arbitrary key-value metadata.
   * @defaultValue undefined
   */
  metadata?: Record<string, string>;
  /**
   * List of tools the skill is allowed to use.
   * @defaultValue undefined
   */
  allowedTools?: string[];
  /**
   * Semantic version string.
   * @defaultValue undefined
   */
  version?: string;
}

/**
 * A discovered skill entry with its location and metadata.
 *
 * @remarks
 * Represents a skill that has been found on disk, either through the
 * canonical skills directory or via project-local discovery. Contains
 * the parsed metadata from SKILL.md along with path information needed
 * for installation and symlinking.
 *
 * @example
 * ```typescript
 * import { getCanonicalSkillsDir } from "./core/paths/standard.js";
 * import { join } from "node:path";
 *
 * const entry: SkillEntry = {
 *   name: "my-skill",
 *   scopedName: "my-skill",
 *   path: join(getCanonicalSkillsDir(), "my-skill"),
 *   metadata: { name: "my-skill", description: "A skill" },
 * };
 * ```
 *
 * @public
 */
export interface SkillEntry {
  /** Skill name. */
  name: string;
  /** Scoped name (may include marketplace scope). */
  scopedName: string;
  /** Absolute path to the skill directory. */
  path: string;
  /** Parsed SKILL.md frontmatter metadata. */
  metadata: SkillMetadata;
  /**
   * Original source from which the skill was installed.
   * @defaultValue undefined
   */
  source?: string;
}

// ── Lock File ───────────────────────────────────────────────────────

/**
 * A single entry in the CAAMP lock file tracking an installed skill or MCP server.
 *
 * @remarks
 * Lock entries record the provenance and installation state of each skill
 * or MCP server. They are used to detect version drift, resolve update
 * operations, and maintain the mapping between canonical installations
 * and per-agent symlinks.
 *
 * @example
 * ```typescript
 * import { getCanonicalSkillsDir } from "./core/paths/standard.js";
 * import { join } from "node:path";
 *
 * const entry: LockEntry = {
 *   name: "my-skill",
 *   scopedName: "my-skill",
 *   source: "https://github.com/owner/repo",
 *   sourceType: "github",
 *   installedAt: "2025-01-15T10:30:00.000Z",
 *   agents: ["claude-code", "cursor"],
 *   canonicalPath: join(getCanonicalSkillsDir(), "my-skill"),
 *   isGlobal: true,
 * };
 * ```
 *
 * @public
 */
export interface LockEntry {
  /** Skill or server name. */
  name: string;
  /** Scoped name (may include marketplace scope). */
  scopedName: string;
  /** Original source string. */
  source: string;
  /** Classified source type. */
  sourceType: SourceType;
  /**
   * Version string or commit SHA.
   * @defaultValue undefined
   */
  version?: string;
  /** ISO 8601 timestamp of first installation. */
  installedAt: string;
  /**
   * ISO 8601 timestamp of last update.
   * @defaultValue undefined
   */
  updatedAt?: string;
  /** Provider IDs this entry is linked to. */
  agents: string[];
  /** Absolute path to canonical installation. */
  canonicalPath: string;
  /** Whether this was installed globally. */
  isGlobal: boolean;
  /**
   * Project directory (for project-scoped installs).
   * @defaultValue undefined
   */
  projectDir?: string;
}

/**
 * The CAAMP lock file structure, stored at the resolved canonical lock path.
 *
 * @remarks
 * Tracks all installed skills and MCP servers along with their sources,
 * versions, and linked agents. The lock file is the persistent state that
 * enables CAAMP to detect drift, perform updates, and maintain installation
 * integrity across sessions.
 *
 * @example
 * ```typescript
 * const lock: CaampLockFile = {
 *   version: 1,
 *   skills: {},
 *   mcpServers: {},
 *   lastSelectedAgents: ["claude-code"],
 * };
 * ```
 *
 * @public
 */
export interface CaampLockFile {
  /** Lock file schema version. */
  version: 1;
  /** Installed skills keyed by name. */
  skills: Record<string, LockEntry>;
  /** Installed MCP servers keyed by name. */
  mcpServers: Record<string, LockEntry>;
  /**
   * Last selected agent IDs for UX persistence.
   * @defaultValue undefined
   */
  lastSelectedAgents?: string[];
}

// ── Marketplace ─────────────────────────────────────────────────────

/**
 * A skill listing from a marketplace search result.
 *
 * @remarks
 * Represents a skill as returned from marketplace APIs (agentskills.in
 * or skills.sh). Contains display information and repository metadata
 * for presenting search results and initiating installation.
 *
 * @example
 * ```typescript
 * const skill: MarketplaceSkill = {
 *   id: "abc123",
 *   name: "my-skill",
 *   scopedName: "@author/my-skill",
 *   description: "A useful skill",
 *   author: "author",
 *   stars: 42,
 *   forks: 5,
 *   githubUrl: "https://github.com/author/my-skill",
 *   repoFullName: "author/my-skill",
 *   path: "/",
 *   hasContent: true,
 * };
 * ```
 *
 * @public
 */
export interface MarketplaceSkill {
  /** Unique marketplace identifier. */
  id: string;
  /** Skill name. */
  name: string;
  /** Scoped name (e.g. `"@author/my-skill"`). */
  scopedName: string;
  /** Short description. */
  description: string;
  /** Author / publisher name. */
  author: string;
  /** GitHub star count. */
  stars: number;
  /** GitHub fork count. */
  forks: number;
  /** GitHub repository URL. */
  githubUrl: string;
  /** Full `owner/repo` name. */
  repoFullName: string;
  /** Path within the repository. */
  path: string;
  /**
   * Optional category tag.
   * @defaultValue undefined
   */
  category?: string;
  /** Whether SKILL.md content was fetched. */
  hasContent: boolean;
}

/**
 * Paginated search results from a marketplace API.
 *
 * @remarks
 * Wraps an array of marketplace skill listings with pagination metadata.
 * Both marketplace adapters (agentskills.in and skills.sh) normalize their
 * responses into this common structure.
 *
 * @example
 * ```typescript
 * const result: MarketplaceSearchResult = {
 *   skills: [],
 *   total: 0,
 *   limit: 20,
 *   offset: 0,
 * };
 * ```
 *
 * @public
 */
export interface MarketplaceSearchResult {
  /** Array of matching skills. */
  skills: MarketplaceSkill[];
  /** Total number of matching results. */
  total: number;
  /** Maximum results per page. */
  limit: number;
  /** Offset into the result set. */
  offset: number;
}

// ── Audit ───────────────────────────────────────────────────────────

/**
 * Severity level for a security audit finding.
 *
 * Ordered from most to least severe: `"critical"` \> `"high"` \> `"medium"` \> `"low"` \> `"info"`.
 *
 * @public
 */
export type AuditSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/**
 * A security audit rule definition with a regex pattern to match against skill content.
 *
 * @remarks
 * Each rule defines a single pattern to detect a specific security concern
 * in SKILL.md files. Rules are organized by category (injection, exfiltration,
 * etc.) and assigned a severity level that determines whether findings cause
 * audit failure.
 *
 * @example
 * ```typescript
 * const rule: AuditRule = {
 *   id: "SEC001",
 *   name: "shell-injection",
 *   description: "Potential shell injection vector",
 *   severity: "critical",
 *   category: "injection",
 *   pattern: /rm\s+-rf\s+\//,
 * };
 * ```
 *
 * @public
 */
export interface AuditRule {
  /** Unique rule identifier (e.g. `"SEC001"`). */
  id: string;
  /** Rule name. */
  name: string;
  /** Human-readable description of what the rule detects. */
  description: string;
  /** Severity level of findings from this rule. */
  severity: AuditSeverity;
  /** Category grouping (e.g. `"injection"`, `"exfiltration"`). */
  category: string;
  /** Regex pattern to match against each line of content. */
  pattern: RegExp;
}

/**
 * A single finding from a security audit scan, with line-level location.
 *
 * @remarks
 * Produced by running an audit rule's pattern against each line of a
 * SKILL.md file. Contains enough location information (line, column,
 * context) to display actionable diagnostic messages to the user.
 *
 * @example
 * ```typescript
 * const finding: AuditFinding = {
 *   rule: myRule,
 *   line: 42,
 *   column: 10,
 *   match: "rm -rf /",
 *   context: "Execute: rm -rf / to clean up",
 * };
 * ```
 *
 * @public
 */
export interface AuditFinding {
  /** The rule that triggered this finding. */
  rule: AuditRule;
  /** Line number (1-based). */
  line: number;
  /** Column number (1-based). */
  column: number;
  /** The matched text. */
  match: string;
  /** The full line of text for context. */
  context: string;
}

/**
 * Aggregate audit result for a single file.
 *
 * @remarks
 * Includes a security score (100 = clean, 0 = very dangerous) and a pass/fail
 * status based on the presence of critical or high severity findings. The score
 * is computed by deducting points for each finding based on its severity level.
 *
 * @example
 * ```typescript
 * const result: AuditResult = {
 *   file: "/path/to/SKILL.md",
 *   findings: [],
 *   score: 100,
 *   passed: true,
 * };
 * ```
 *
 * @public
 */
export interface AuditResult {
  /** Path to the scanned file. */
  file: string;
  /** All findings for this file. */
  findings: AuditFinding[];
  /** Security score from 0 (dangerous) to 100 (clean). */
  score: number;
  /** Whether the file passed the audit (no critical/high findings). */
  passed: boolean;
}

// ── Instructions ────────────────────────────────────────────────────

/**
 * Status of a CAAMP injection block in an instruction file.
 *
 * - `"current"` - Injection block exists and matches expected content
 * - `"outdated"` - Injection block exists but content differs
 * - `"missing"` - Instruction file does not exist
 * - `"none"` - File exists but has no CAAMP injection block
 *
 * @public
 */
export type InjectionStatus = 'current' | 'outdated' | 'missing' | 'none';

/**
 * Result of checking a single instruction file for CAAMP injection status.
 *
 * @remarks
 * Produced by the instruction injector's check operation. Indicates whether
 * the CAAMP marker block is present, up-to-date, or needs updating for a
 * specific provider's instruction file.
 *
 * @example
 * ```typescript
 * const check: InjectionCheckResult = {
 *   file: "/project/CLAUDE.md",
 *   provider: "claude-code",
 *   status: "current",
 *   fileExists: true,
 * };
 * ```
 *
 * @public
 */
export interface InjectionCheckResult {
  /** Absolute path to the instruction file. */
  file: string;
  /** Provider ID that owns this instruction file. */
  provider: string;
  /** Current injection status. */
  status: InjectionStatus;
  /** Whether the instruction file exists on disk. */
  fileExists: boolean;
}

// ── MCP Server Entry (list results) ─────────────────────────────────

/**
 * An MCP server entry read from a provider's config file.
 *
 * @remarks
 * Returned by the MCP list operations when enumerating servers across
 * provider config files. Contains both the raw server configuration and
 * metadata about which provider and scope (global/project) it belongs to.
 *
 * @see {@link McpServerConfig} for the canonical server configuration format.
 *
 * @example
 * ```typescript
 * const entry: McpServerEntry = {
 *   name: "filesystem",
 *   providerId: "claude-code",
 *   providerName: "Claude Code",
 *   scope: "project",
 *   configPath: "/project/.claude.json",
 *   config: { command: "npx", args: ["-y", "@mcp/server-filesystem"] },
 * };
 * ```
 *
 * @public
 */
export interface McpServerEntry {
  /** Server name (the key in the config file). */
  name: string;
  /** Provider ID that owns this config file. */
  providerId: string;
  /** Human-readable provider name. */
  providerName: string;
  /** Whether from project or global config. */
  scope: 'project' | 'global';
  /** Absolute path to the config file. */
  configPath: string;
  /** Raw server configuration object. */
  config: Record<string, unknown>;
}

// ── CLI Options ─────────────────────────────────────────────────────

/**
 * Global CLI options shared across all CAAMP commands.
 *
 * @remarks
 * These options are defined on the root Commander program and inherited
 * by all subcommands. They control agent targeting, scope selection,
 * output formatting, and execution behavior (dry-run, verbose, quiet).
 *
 * @example
 * ```typescript
 * const opts: GlobalOptions = {
 *   agent: ["claude-code", "cursor"],
 *   global: true,
 *   json: true,
 * };
 * ```
 *
 * @public
 */
export interface GlobalOptions {
  /**
   * Target agent IDs (repeatable).
   * @defaultValue undefined
   */
  agent?: string[];
  /**
   * Operate on global config instead of project.
   * @defaultValue false
   */
  global?: boolean;
  /**
   * Skip confirmation prompts.
   * @defaultValue false
   */
  yes?: boolean;
  /**
   * Target all detected agents.
   * @defaultValue false
   */
  all?: boolean;
  /**
   * Output as JSON.
   * @defaultValue false
   */
  json?: boolean;
  /**
   * Preview changes without writing.
   * @defaultValue false
   */
  dryRun?: boolean;
  /**
   * Enable debug logging.
   * @defaultValue false
   */
  verbose?: boolean;
  /**
   * Suppress non-error output.
   * @defaultValue false
   */
  quiet?: boolean;
}
