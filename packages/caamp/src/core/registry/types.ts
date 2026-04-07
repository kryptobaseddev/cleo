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
 * Priority tier identifier stored in registry.json.
 *
 * @remarks
 * Providers are tiered to express selection precedence and tooling defaults.
 * Exactly **one** provider in a registry MAY have the `"primary"` tier — it
 * is the first-class harness and default target when no `--agent` flag is
 * given. The registry loader does not enforce this cardinality rule; instead
 * {@link RegistryProvider.priority} consumers such as `getPrimaryProvider()`
 * expect either zero or one provider with `"primary"` priority.
 *
 * @public
 */
export type ProviderPriority = 'primary' | 'high' | 'medium' | 'low';

/**
 * Lifecycle status identifier stored in registry.json.
 *
 * @remarks
 * The registry uses four discrete lifecycle states. The enum is duplicated
 * here (and in `src/types.ts`) so the raw and resolved Provider shapes can
 * share precise typing without circular imports.
 *
 * @public
 */
export type ProviderStatus = 'active' | 'beta' | 'deprecated' | 'planned';

/**
 * Raw provider definition as stored in registry.json before path resolution.
 *
 * @remarks
 * This interface mirrors the JSON schema of each provider entry in
 * `providers/registry.json`. Path values contain platform variable
 * placeholders (e.g. `$HOME`, `$CONFIG`, `$CLEO_HOME`) that are expanded
 * at runtime to produce the resolved {@link Provider} interface from
 * `src/types.ts`.
 *
 * MCP server integration fields (config key, format, paths, transports,
 * headers) no longer live at the top level. Providers that consume MCP
 * servers via a per-agent config file declare those fields inside
 * `capabilities.mcp`. Providers that do not use MCP (e.g. Pi, which uses
 * TypeScript extensions) simply omit the `capabilities.mcp` block.
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

  /** Global skills directory path (may contain platform variables). */
  pathSkills: string;
  /** Project-relative skills directory path. */
  pathProjectSkills: string;

  /** Detection configuration for auto-discovering this provider. */
  detection: RegistryDetection;

  /** Priority tier identifier. Exactly zero or one provider should be `"primary"`. */
  priority: ProviderPriority;
  /** Lifecycle status identifier. */
  status: ProviderStatus;
  /** Whether the provider is compatible with the Agent Skills standard. */
  agentSkillsCompatible: boolean;

  /**
   * Optional provider capabilities for MCP, harness role, skills, hooks, and spawn.
   * @defaultValue undefined
   */
  capabilities?: RegistryCapabilities;
}

// ── Capability Types (raw JSON schema) ─────────────────────────────

/**
 * Supported MCP config file formats.
 *
 * @remarks
 * These mirror the wider {@link ConfigFormat} enum in `src/types.ts` but
 * are restated here to avoid importing the resolved runtime type into the
 * raw JSON schema definitions.
 *
 * @public
 */
export type McpConfigFormat = 'json' | 'jsonc' | 'yaml' | 'toml';

/**
 * MCP transport protocols a provider may advertise.
 *
 * @public
 */
export type McpTransportType = 'stdio' | 'sse' | 'http' | 'websocket';

/**
 * MCP server integration metadata for providers that consume MCP servers
 * via a per-agent config file.
 *
 * @remarks
 * Optional — providers without MCP integration (like Pi, which uses
 * TypeScript extensions instead of a JSON/YAML/TOML config file) omit this
 * block entirely. When present, all fields are required so the loader can
 * resolve config paths and write servers without fallbacks.
 *
 * @public
 */
export interface RegistryMcpIntegration {
  /** Dot-notation key path for MCP server config (e.g. `"mcpServers"`). */
  configKey: string;
  /** Config file format identifier. */
  configFormat: McpConfigFormat;
  /** Global config file path (may contain platform variables). */
  configPathGlobal: string;
  /** Project-relative config file path, or `null` if unsupported. */
  configPathProject: string | null;
  /** MCP transport protocol identifiers this provider supports. */
  supportedTransports: McpTransportType[];
  /** Whether the provider supports custom HTTP headers for remote MCP servers. */
  supportsHeaders: boolean;
}

/**
 * Harness role category for a primary or standalone harness.
 *
 * @remarks
 * - `"orchestrator"` — can spawn subagents and coordinate multi-provider workflows.
 * - `"standalone"` — runs as a single agent without delegating to spawn targets.
 *
 * @public
 */
export type RegistryHarnessKind = 'orchestrator' | 'standalone';

/**
 * First-class harness role declaration.
 *
 * @remarks
 * Present only for providers that act as orchestrators or standalone
 * harnesses rather than pure spawn targets. The primary harness is the
 * default selection when no `--agent` flag is given. Extensions live on
 * the filesystem under {@link extensionsPath}; CAAMP-managed shared
 * extensions may live in a dedicated hub under {@link globalExtensionsHub}.
 *
 * @public
 */
export interface RegistryHarnessCapability {
  /** The harness kind (`"orchestrator"` or `"standalone"`). */
  kind: RegistryHarnessKind;
  /** Provider ids this harness can spawn as subagents. Empty for standalone. */
  spawnTargets: string[];
  /** Whether the harness drives a CleoOS conductor loop. */
  supportsConductorLoop: boolean;
  /** Whether the harness accepts stage guidance injection. */
  supportsStageGuidance: boolean;
  /** Whether the harness bridges CANT events. */
  supportsCantBridge: boolean;
  /** Path to the harness's runtime extensions directory (file paths, not a config file). */
  extensionsPath: string;
  /**
   * Optional CLEO-managed shared extensions hub.
   * @defaultValue undefined
   */
  globalExtensionsHub?: string;
}

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
 * The on-disk layout of a provider's hook configuration.
 *
 * @remarks
 * - `"json"`, `"yaml"`, `"toml"`, `"javascript"` — single configuration file
 *   consumed by the provider.
 * - `"typescript-directory"` — a directory of `.ts` extension files (Pi's model).
 *
 * @public
 */
export type RegistryHookFormat = 'json' | 'yaml' | 'toml' | 'javascript' | 'typescript-directory';

/**
 * Which native event catalog a provider's hook system uses.
 *
 * @remarks
 * - `"canonical"` — uses the core CAAMP `canonicalEvents` catalog from
 *   `providers/hook-mappings.json`.
 * - `"pi"` — uses the Pi-specific catalog (sibling entry to `canonicalEvents`)
 *   that enumerates Pi's native lifecycle events such as `before_agent_start`
 *   and `resources_discover`.
 *
 * @public
 */
export type RegistryHookCatalog = 'canonical' | 'pi';

/**
 * Raw hooks capability definition as stored in registry.json.
 *
 * @remarks
 * Describes which hook lifecycle events a provider supports and where
 * hook configuration is stored. The `supported` array contains provider-native
 * event names that may differ from the canonical CAAMP taxonomy. Pi and
 * similar extension-based harnesses declare `hookFormat` as
 * `"typescript-directory"` and point `hookConfigPath` at their extensions
 * directory; `hookConfigPathProject` gives the project-scoped counterpart.
 *
 * @public
 */
export interface RegistryHooksCapability {
  /** Hook lifecycle event identifiers this provider supports. */
  supported: string[];
  /** Path to the hook configuration file or directory, or `null` if not applicable. */
  hookConfigPath: string | null;
  /**
   * Project-relative path to the hook configuration file or directory.
   * @defaultValue undefined
   */
  hookConfigPathProject?: string;
  /** Format of the hook config, or `null` when the provider has no hook system. */
  hookFormat: RegistryHookFormat | null;
  /**
   * Which native event catalog this provider's hooks are drawn from.
   * Defaults to `"canonical"` when omitted.
   * @defaultValue "canonical"
   */
  nativeEventCatalog?: RegistryHookCatalog;
  /**
   * Whether hooks may inject or modify the system prompt.
   * @defaultValue undefined
   */
  canInjectSystemPrompt?: boolean;
  /**
   * Whether hooks may block tool calls.
   * @defaultValue undefined
   */
  canBlockTools?: boolean;
}

/**
 * Mechanism a provider uses to spawn subagents.
 *
 * @remarks
 * - `"native"` - Built-in spawning via the provider's own runtime.
 * - `"native-child-process"` - Built-in spawning that forks a local child
 *   process (Pi's `pi --mode json -p --no-session` pattern).
 * - `"mcp"` - Spawning via MCP tool calls.
 * - `"cli"` - Spawning via CLI subprocess invocation.
 * - `"api"` - Spawning via a remote API endpoint.
 *
 * @public
 */
export type SpawnMechanism = 'native' | 'native-child-process' | 'mcp' | 'cli' | 'api';

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
  spawnMechanism: SpawnMechanism | null;
  /**
   * Literal command-line invocation used by the harness to spawn a child
   * worker (e.g. Pi's `["pi", "--mode", "json", "-p", "--no-session"]`).
   * Only meaningful when `spawnMechanism === "native-child-process"`.
   * @defaultValue undefined
   */
  spawnCommand?: string[];
}

/**
 * Aggregate capability block for a provider in registry.json.
 *
 * @remarks
 * Groups capability dimensions into a single optional block on each
 * provider entry. All members are optional so providers opt in to only
 * the dimensions they support — e.g. Pi populates `harness`, `skills`,
 * `hooks`, and `spawn` but has no `mcp` entry; generic providers populate
 * `mcp`, `skills`, `hooks`, and `spawn` but have no `harness` entry.
 *
 * @public
 */
export interface RegistryCapabilities {
  /**
   * MCP server integration metadata. Omitted for providers (like Pi) that
   * do not consume MCP servers via a config file.
   * @defaultValue undefined
   */
  mcp?: RegistryMcpIntegration;
  /**
   * First-class harness role. Present only for orchestrators or standalone
   * harnesses, not for pure spawn targets.
   * @defaultValue undefined
   */
  harness?: RegistryHarnessCapability;
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
