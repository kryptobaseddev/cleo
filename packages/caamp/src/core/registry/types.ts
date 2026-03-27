/**
 * Provider registry types
 *
 * These types map directly to the providers/registry.json schema.
 * The runtime Provider interface (in src/types.ts) is resolved from these
 * with platform-specific path expansion.
 */

/**
 * Raw detection configuration as stored in registry.json.
 *
 * @remarks
 * Defines the methods and parameters used to detect whether a provider
 * is installed on the current system. Each detection method has its own
 * optional parameter (binary name, directory list, etc.).
 *
 * @public
 */
export interface RegistryDetection {
  /** Detection methods to try, in order (e.g. `["binary", "directory"]`). */
  methods: string[];
  /**
   * Binary name to look up on PATH (for the `"binary"` method).
   * @defaultValue undefined
   */
  binary?: string;
  /**
   * Directories to check for existence (for the `"directory"` method).
   * @defaultValue undefined
   */
  directories?: string[];
  /**
   * macOS .app bundle name (for the `"appBundle"` method).
   * @defaultValue undefined
   */
  appBundle?: string;
  /**
   * Flatpak application ID (for the `"flatpak"` method).
   * @defaultValue undefined
   */
  flatpakId?: string;
}

/**
 * Raw provider definition as stored in registry.json before path resolution.
 *
 * @remarks
 * This interface mirrors the JSON schema of each provider entry in
 * `providers/registry.json`. Path values contain platform variable
 * placeholders (e.g. `$HOME`, `$CONFIG`) that are expanded at runtime
 * to produce the resolved {@link Provider} interface from `src/types.ts`.
 *
 * @public
 */
export interface RegistryProvider {
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

  /** Global instruction file directory path (may contain platform variables). */
  pathGlobal: string;
  /** Project-relative instruction file directory path. */
  pathProject: string;

  /** Instruction file name (e.g. `"CLAUDE.md"`, `"AGENTS.md"`). */
  instructFile: string;

  /** Dot-notation key path for MCP server config (e.g. `"mcpServers"`). */
  configKey: string;
  /** Config file format identifier (e.g. `"json"`, `"jsonc"`, `"yaml"`, `"toml"`). */
  configFormat: string;
  /** Global config file path (may contain platform variables). */
  configPathGlobal: string;
  /** Project-relative config file path, or `null` if unsupported. */
  configPathProject: string | null;

  /** Global skills directory path (may contain platform variables). */
  pathSkills: string;
  /** Project-relative skills directory path. */
  pathProjectSkills: string;

  /** Detection configuration for auto-discovering this provider. */
  detection: RegistryDetection;

  /** MCP transport protocol identifiers this provider supports. */
  supportedTransports: string[];
  /** Whether the provider supports custom HTTP headers for remote MCP servers. */
  supportsHeaders: boolean;

  /** Priority tier identifier (`"high"`, `"medium"`, or `"low"`). */
  priority: string;
  /** Lifecycle status identifier (`"active"`, `"beta"`, `"deprecated"`, `"planned"`). */
  status: string;
  /** Whether the provider is compatible with the Agent Skills standard. */
  agentSkillsCompatible: boolean;

  /**
   * Optional provider capabilities for skills, hooks, and spawn.
   * @defaultValue undefined
   */
  capabilities?: RegistryCapabilities;
}

// ── Capability Types (raw JSON schema) ─────────────────────────────

/**
 * How a provider resolves skill file precedence between vendor and agents directories.
 *
 * @remarks
 * Controls the lookup order when a provider searches for skill files.
 * - `"vendor-only"` uses only the provider's own skill directory.
 * - `"agents-canonical"` uses only the shared `.agents/skills` directory.
 * - `"agents-first"` checks `.agents/skills` before the vendor directory.
 * - `"agents-supported"` supports `.agents/skills` but prefers vendor paths.
 * - `"vendor-global-agents-project"` uses vendor paths globally but `.agents/skills` per-project.
 *
 * @public
 */
export type SkillsPrecedence =
  | 'vendor-only'
  | 'agents-canonical'
  | 'agents-first'
  | 'agents-supported'
  | 'vendor-global-agents-project';

/**
 * Raw skills capability definition as stored in registry.json.
 *
 * @remarks
 * Describes a provider's skill path resolution strategy, including
 * whether it supports the shared `.agents/skills` directory structure
 * at global and project levels.
 *
 * @public
 */
export interface RegistrySkillsCapability {
  /** Resolved global `.agents/skills` path, or `null` if unsupported. */
  agentsGlobalPath: string | null;
  /** Project-relative `.agents/skills` path, or `null` if unsupported. */
  agentsProjectPath: string | null;
  /** How this provider resolves skill file precedence. */
  precedence: SkillsPrecedence;
}

/**
 * Hook lifecycle event identifier from registry.json.
 *
 * @remarks
 * This is a raw string type for backward compatibility with registry.json's
 * `capabilities.hooks.supported` arrays. For the normalized CAAMP hook
 * taxonomy, use `CanonicalHookEvent` from `../hooks/types.js` instead.
 *
 * @deprecated Use `CanonicalHookEvent` from `../hooks/types.js` for the
 * normalized CAAMP taxonomy. This type remains for backward compatibility
 * with registry.json's `capabilities.hooks.supported` string arrays.
 *
 * @public
 */
export type HookEvent = string;

/**
 * Raw hooks capability definition as stored in registry.json.
 *
 * @remarks
 * Describes which hook lifecycle events a provider supports and where
 * hook configuration is stored. The `supported` array contains provider-native
 * event names that may differ from the canonical CAAMP taxonomy.
 *
 * @public
 */
export interface RegistryHooksCapability {
  /** Hook lifecycle event identifiers this provider supports. */
  supported: string[];
  /** Path to the hook configuration file, or `null` if not applicable. */
  hookConfigPath: string | null;
  /** Format of the hook config file (e.g. `"json"`, `"yaml"`), or `null`. */
  hookFormat: string | null;
}

/**
 * Mechanism a provider uses to spawn subagents.
 *
 * @remarks
 * - `"native"` - Built-in spawning via the provider's own runtime.
 * - `"mcp"` - Spawning via MCP tool calls.
 * - `"cli"` - Spawning via CLI subprocess invocation.
 * - `"api"` - Spawning via a remote API endpoint.
 *
 * @public
 */
export type SpawnMechanism = 'native' | 'mcp' | 'cli' | 'api';

/**
 * Raw spawn capability definition as stored in registry.json.
 *
 * @remarks
 * Describes whether a provider can spawn subagents and the features
 * available for multi-agent coordination, including programmatic spawning,
 * inter-agent communication, and parallel execution.
 *
 * @public
 */
export interface RegistrySpawnCapability {
  /** Whether the provider supports spawning subagents. */
  supportsSubagents: boolean;
  /** Whether subagents can be spawned programmatically. */
  supportsProgrammaticSpawn: boolean;
  /** Whether spawned agents can communicate with each other. */
  supportsInterAgentComms: boolean;
  /** Whether multiple agents can be spawned in parallel. */
  supportsParallelSpawn: boolean;
  /** Mechanism used for spawning, or `null` if spawning is unsupported. */
  spawnMechanism: string | null;
}

/**
 * Aggregate capability block for a provider in registry.json.
 *
 * @remarks
 * Groups the three capability dimensions (skills, hooks, spawn) into a
 * single optional block on each provider entry. Not all providers define
 * capabilities; when absent, CAAMP infers safe defaults.
 *
 * @public
 */
export interface RegistryCapabilities {
  /**
   * Skills path resolution and precedence capabilities.
   * @defaultValue undefined
   */
  skills?: RegistrySkillsCapability;
  /**
   * Hook/lifecycle event capabilities.
   * @defaultValue undefined
   */
  hooks?: RegistryHooksCapability;
  /**
   * Subagent spawn capabilities.
   * @defaultValue undefined
   */
  spawn?: RegistrySpawnCapability;
}

/**
 * Top-level structure of the provider registry JSON file.
 *
 * @remarks
 * Represents the complete `providers/registry.json` file, which is the
 * single source of truth for all AI agent provider definitions in CAAMP.
 * The registry is loaded once at startup and cached for the process lifetime.
 *
 * @public
 */
export interface ProviderRegistry {
  /** Schema version of the registry file. */
  version: string;
  /** ISO 8601 timestamp of the last registry update. */
  lastUpdated: string;
  /** Provider definitions keyed by provider ID. */
  providers: Record<string, RegistryProvider>;
}
