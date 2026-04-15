import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Provider } from '../../types.js';
import { getPlatformPaths } from '../platform-paths.js';

/**
 * Scope for path resolution, either global (user home) or project-local.
 *
 * @remarks
 * Global scope resolves paths under the user's home directory (e.g., `~/.agents/`).
 * Project scope resolves paths relative to the project root (e.g., `<project>/.agents/`).
 *
 * @public
 */
export type PathScope = 'project' | 'global';

/**
 * Platform-specific directory locations for agent configuration.
 *
 * @remarks
 * Provides resolved paths for the current operating system, accounting for
 * platform differences in config directory locations (XDG on Linux, Library on macOS,
 * AppData on Windows).
 *
 * @public
 */
export interface PlatformLocations {
  /** The user's home directory path. */
  home: string;
  /** The platform-specific configuration directory. */
  config: string;
  /** The VS Code user settings directory. */
  vscodeConfig: string;
  /** The Zed editor configuration directory. */
  zedConfig: string;
  /** The Claude Desktop application configuration directory. */
  claudeDesktopConfig: string;
  /** List of application directories (macOS only). */
  applications: string[];
}

/**
 * Resolves platform-specific directory locations for the current OS.
 *
 * @remarks
 * Detects the current platform and returns appropriate paths for configuration,
 * editor settings, and application directories. Uses `XDG_CONFIG_HOME` on Linux
 * and macOS when available, falls back to conventional defaults. On Windows,
 * uses `APPDATA` or defaults to `~/AppData/Roaming`.
 *
 * @returns Platform-specific directory locations
 *
 * @example
 * ```typescript
 * const locations = getPlatformLocations();
 * console.log(locations.config); // e.g., "/home/user/.config"
 * ```
 *
 * @public
 */
export function getPlatformLocations(): PlatformLocations {
  const home = homedir();
  const platform = process.platform;

  if (platform === 'win32') {
    const appData = process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming');
    return {
      home,
      config: appData,
      vscodeConfig: join(appData, 'Code', 'User'),
      zedConfig: join(appData, 'Zed'),
      claudeDesktopConfig: join(appData, 'Claude'),
      applications: [],
    };
  }

  if (platform === 'darwin') {
    const config = process.env['XDG_CONFIG_HOME'] ?? join(home, '.config');
    return {
      home,
      config,
      vscodeConfig: join(home, 'Library', 'Application Support', 'Code', 'User'),
      zedConfig: join(home, 'Library', 'Application Support', 'Zed'),
      claudeDesktopConfig: join(home, 'Library', 'Application Support', 'Claude'),
      applications: ['/Applications', join(home, 'Applications')],
    };
  }

  const config = process.env['XDG_CONFIG_HOME'] ?? join(home, '.config');
  return {
    home,
    config,
    vscodeConfig: join(config, 'Code', 'User'),
    zedConfig: join(config, 'zed'),
    claudeDesktopConfig: join(config, 'Claude'),
    applications: [],
  };
}

/**
 * Returns the global agents home directory path.
 *
 * @remarks
 * Delegates to the platform paths module to resolve the data directory
 * for the current operating system. This is the root for global agent
 * configuration such as canonical skills and lock files.
 *
 * @returns The absolute path to the global agents home directory
 *
 * @example
 * ```typescript
 * const home = getAgentsHome();
 * // e.g., "/home/user/.local/share/caamp"
 * ```
 *
 * @public
 */
export function getAgentsHome(): string {
  return getPlatformPaths().data;
}

/**
 * Returns the project-local `.agents` directory path.
 *
 * @remarks
 * Joins the project root with `.agents` to produce the conventional
 * project-scoped agent configuration directory.
 *
 * @param projectRoot - The project root directory, defaults to `process.cwd()`
 * @returns The absolute path to the project's `.agents` directory
 *
 * @example
 * ```typescript
 * const dir = getProjectAgentsDir("/home/user/my-project");
 * // returns "/home/user/my-project/.agents"
 * ```
 *
 * @public
 */
export function getProjectAgentsDir(projectRoot = process.cwd()): string {
  return join(projectRoot, '.agents');
}

/**
 * Resolves a relative path against a project directory.
 *
 * @remarks
 * A simple path join utility that combines the project directory with
 * the given relative path to produce an absolute path.
 *
 * @param relativePath - The relative path to resolve
 * @param projectDir - The project root directory, defaults to `process.cwd()`
 * @returns The resolved absolute path
 *
 * @example
 * ```typescript
 * const path = resolveProjectPath(".agents/config.toml", "/home/user/project");
 * // returns "/home/user/project/.agents/config.toml"
 * ```
 *
 * @public
 */
export function resolveProjectPath(relativePath: string, projectDir = process.cwd()): string {
  return join(projectDir, relativePath);
}

/**
 * Returns the canonical skills storage directory path.
 *
 * @remarks
 * Skills are stored once in this canonical directory and symlinked into
 * provider-specific locations. This is the single source of truth for
 * installed skill files.
 *
 * @returns The absolute path to the canonical skills directory
 *
 * @example
 * ```typescript
 * const dir = getCanonicalSkillsDir();
 * // e.g., "/home/user/.local/share/caamp/skills"
 * ```
 *
 * @public
 */
export function getCanonicalSkillsDir(): string {
  return join(getAgentsHome(), 'skills');
}

/**
 * Returns the path to the CAAMP lock file.
 *
 * @remarks
 * The lock file tracks installed skills and their versions to enable
 * deterministic reinstallation and conflict detection.
 *
 * @returns The absolute path to the `.caamp-lock.json` file
 *
 * @example
 * ```typescript
 * const lockPath = getLockFilePath();
 * // e.g., "/home/user/.local/share/caamp/.caamp-lock.json"
 * ```
 *
 * @public
 */
export function getLockFilePath(): string {
  return join(getAgentsHome(), '.caamp-lock.json');
}

// ── .agents/ Standard Directory Structure ────────────────────────────

/**
 * Gets the MCP directory within the `.agents/` standard structure.
 *
 * @remarks
 * Resolves the MCP configuration directory based on scope. Global scope
 * points to `~/.agents/mcp/`, while project scope points to
 * `<project>/.agents/mcp/`.
 *
 * @param scope - `"global"` for `~/.agents/mcp/`, `"project"` for `<project>/.agents/mcp/`
 * @param projectDir - Project root (defaults to `process.cwd()`)
 * @returns The absolute path to the MCP directory
 *
 * @example
 * ```typescript
 * const globalMcp = getAgentsMcpDir("global");
 * const projectMcp = getAgentsMcpDir("project", "/home/user/project");
 * ```
 *
 * @public
 */
export function getAgentsMcpDir(scope: PathScope = 'global', projectDir?: string): string {
  if (scope === 'global') return join(getAgentsHome(), 'mcp');
  return join(projectDir ?? process.cwd(), '.agents', 'mcp');
}

/**
 * Gets the MCP servers.json path within the `.agents/` standard structure.
 *
 * @remarks
 * Per the `.agents/` standard (Section 9), this is the canonical MCP
 * server registry that should be checked before legacy per-provider configs.
 *
 * @param scope - `"global"` for `~/.agents/mcp/servers.json`, `"project"` for `<project>/.agents/mcp/servers.json`
 * @param projectDir - Project root (defaults to `process.cwd()`)
 * @returns The absolute path to the `servers.json` file
 *
 * @example
 * ```typescript
 * const serversPath = getAgentsMcpServersPath("global");
 * // e.g., "/home/user/.agents/mcp/servers.json"
 * ```
 *
 * @public
 */
export function getAgentsMcpServersPath(scope: PathScope = 'global', projectDir?: string): string {
  return join(getAgentsMcpDir(scope, projectDir), 'servers.json');
}

/**
 * Gets the primary AGENTS.md instruction file path within `.agents/`.
 *
 * @remarks
 * Returns the path to the AGENTS.md file for the given scope. This is the
 * standard instruction file that agents read for project or global guidance.
 *
 * @param scope - `"global"` for `~/.agents/AGENTS.md`, `"project"` for `<project>/.agents/AGENTS.md`
 * @param projectDir - Project root (defaults to `process.cwd()`)
 * @returns The absolute path to the AGENTS.md file
 *
 * @example
 * ```typescript
 * const agentsFile = getAgentsInstructFile("project", "/home/user/project");
 * // returns "/home/user/project/.agents/AGENTS.md"
 * ```
 *
 * @public
 */
export function getAgentsInstructFile(scope: PathScope = 'global', projectDir?: string): string {
  if (scope === 'global') return join(getAgentsHome(), 'AGENTS.md');
  return join(projectDir ?? process.cwd(), '.agents', 'AGENTS.md');
}

/**
 * Gets the config.toml path within the `.agents/` standard structure.
 *
 * @remarks
 * Returns the path to the TOML configuration file for agent settings.
 * Global scope points to `~/.agents/config.toml`, project scope points
 * to `<project>/.agents/config.toml`.
 *
 * @param scope - `"global"` for `~/.agents/config.toml`, `"project"` for `<project>/.agents/config.toml`
 * @param projectDir - Project root (defaults to `process.cwd()`)
 * @returns The absolute path to the config.toml file
 *
 * @example
 * ```typescript
 * const configPath = getAgentsConfigPath("global");
 * // e.g., "/home/user/.agents/config.toml"
 * ```
 *
 * @public
 */
export function getAgentsConfigPath(scope: PathScope = 'global', projectDir?: string): string {
  if (scope === 'global') return join(getAgentsHome(), 'config.toml');
  return join(projectDir ?? process.cwd(), '.agents', 'config.toml');
}

/**
 * Gets the wiki directory within the `.agents/` standard structure.
 *
 * @remarks
 * The wiki directory stores markdown documentation files that agents
 * can reference for project or global knowledge.
 *
 * @param scope - `"global"` or `"project"`
 * @param projectDir - Project root (defaults to `process.cwd()`)
 * @returns The absolute path to the wiki directory
 *
 * @example
 * ```typescript
 * const wikiDir = getAgentsWikiDir("project", "/home/user/project");
 * // returns "/home/user/project/.agents/wiki"
 * ```
 *
 * @public
 */
export function getAgentsWikiDir(scope: PathScope = 'global', projectDir?: string): string {
  if (scope === 'global') return join(getAgentsHome(), 'wiki');
  return join(projectDir ?? process.cwd(), '.agents', 'wiki');
}

/**
 * Gets the spec directory within the `.agents/` standard structure.
 *
 * @remarks
 * The spec directory stores specification files used by agents for
 * project architecture and design reference.
 *
 * @param scope - `"global"` or `"project"`
 * @param projectDir - Project root (defaults to `process.cwd()`)
 * @returns The absolute path to the spec directory
 *
 * @example
 * ```typescript
 * const specDir = getAgentsSpecDir("global");
 * // e.g., "/home/user/.agents/spec"
 * ```
 *
 * @public
 */
export function getAgentsSpecDir(scope: PathScope = 'global', projectDir?: string): string {
  if (scope === 'global') return join(getAgentsHome(), 'spec');
  return join(projectDir ?? process.cwd(), '.agents', 'spec');
}

/**
 * Gets the links directory within the `.agents/` standard structure.
 *
 * @remarks
 * The links directory stores symlinks or references to external resources
 * that agents can follow for additional context.
 *
 * @param scope - `"global"` or `"project"`
 * @param projectDir - Project root (defaults to `process.cwd()`)
 * @returns The absolute path to the links directory
 *
 * @example
 * ```typescript
 * const linksDir = getAgentsLinksDir("project", "/home/user/project");
 * // returns "/home/user/project/.agents/links"
 * ```
 *
 * @public
 */
export function getAgentsLinksDir(scope: PathScope = 'global', projectDir?: string): string {
  if (scope === 'global') return join(getAgentsHome(), 'links');
  return join(projectDir ?? process.cwd(), '.agents', 'links');
}

/**
 * Resolve the CLEO home directory for template path expansion.
 *
 * @remarks
 * Honors the `CLEO_HOME` environment variable when set. Otherwise falls
 * back to a platform-appropriate data directory for the `cleo` app name
 * (e.g. `~/.local/share/cleo` on Linux, `~/Library/Application Support/cleo`
 * on macOS, `%LOCALAPPDATA%\cleo\Data` on Windows). This mirrors the
 * resolution strategy used by the `@cleocode/core` package's `getCleoHome`
 * helper but is duplicated here to avoid a cross-package runtime dependency.
 *
 * @internal
 */
function getCleoHomeForTemplate(): string {
  const envOverride = process.env['CLEO_HOME'];
  if (envOverride && envOverride.trim().length > 0) {
    return envOverride.trim();
  }
  const home = getPlatformLocations().home;
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local');
    return join(localAppData, 'cleo', 'Data');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'cleo');
  }
  const xdgData = process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share');
  return join(xdgData, 'cleo');
}

/**
 * Resolves a registry template path by substituting platform variables.
 *
 * @remarks
 * Replaces template variables like `$HOME`, `$CONFIG`, `$VSCODE_CONFIG`,
 * `$ZED_CONFIG`, `$CLAUDE_DESKTOP_CONFIG`, `$AGENTS_HOME`, and `$CLEO_HOME`
 * with their actual platform-specific values. Used to resolve paths from
 * the provider registry JSON.
 *
 * @param template - The template string containing `$VARIABLE` placeholders
 * @returns The resolved absolute path with all variables expanded
 *
 * @example
 * ```typescript
 * const path = resolveRegistryTemplatePath("$HOME/.config/claude/settings.json");
 * // e.g., "/home/user/.config/claude/settings.json"
 * ```
 *
 * @public
 */
export function resolveRegistryTemplatePath(template: string): string {
  const locations = getPlatformLocations();
  return template
    .replace(/\$HOME/g, locations.home)
    .replace(/\$CONFIG/g, locations.config)
    .replace(/\$VSCODE_CONFIG/g, locations.vscodeConfig)
    .replace(/\$ZED_CONFIG/g, locations.zedConfig)
    .replace(/\$CLAUDE_DESKTOP_CONFIG/g, locations.claudeDesktopConfig)
    .replace(/\$AGENTS_HOME/g, getAgentsHome())
    .replace(/\$CLEO_HOME/g, getCleoHomeForTemplate());
}

/**
 * Resolves the configuration file path for a provider at the given scope.
 *
 * @remarks
 * For global scope, returns the provider's `configPathGlobal` directly.
 * For project scope, joins the project directory with the provider's
 * `configPathProject`. Returns null if the provider has no project-scoped
 * config path defined.
 *
 * @param provider - The provider whose config path to resolve
 * @param scope - Whether to resolve global or project config path
 * @param projectDir - The project root directory, defaults to `process.cwd()`
 * @returns The resolved config file path, or null if unavailable for the given scope
 *
 * @example
 * ```typescript
 * const configPath = resolveProviderConfigPath(provider, "project", "/home/user/project");
 * if (configPath) {
 *   console.log("Config at:", configPath);
 * }
 * ```
 *
 * @public
 */
export function resolveProviderConfigPath(
  provider: Provider,
  scope: PathScope,
  projectDir = process.cwd(),
): string | null {
  const mcp = provider.capabilities.mcp;
  if (!mcp) {
    return null;
  }
  if (scope === 'global') {
    return mcp.configPathGlobal;
  }
  if (!mcp.configPathProject) {
    return null;
  }
  return resolveProjectPath(mcp.configPathProject, projectDir);
}

/**
 * Determines the preferred configuration scope for a provider.
 *
 * @remarks
 * If the global flag is explicitly set, always returns `"global"`. Otherwise,
 * returns `"project"` if the provider supports project-scoped configuration,
 * or `"global"` as a fallback.
 *
 * @param provider - The provider to determine scope for
 * @param useGlobalFlag - Optional flag to force global scope
 * @returns The preferred path scope for configuration
 *
 * @example
 * ```typescript
 * const scope = resolvePreferredConfigScope(provider, false);
 * // returns "project" if provider has configPathProject, otherwise "global"
 * ```
 *
 * @public
 */
export function resolvePreferredConfigScope(
  provider: Provider,
  useGlobalFlag?: boolean,
): PathScope {
  if (useGlobalFlag) {
    return 'global';
  }
  return provider.capabilities.mcp?.configPathProject ? 'project' : 'global';
}

/**
 * Resolves the skills directory path for a provider at the given scope.
 *
 * @remarks
 * For global scope, returns the provider's `pathSkills` directly.
 * For project scope, joins the project directory with the provider's
 * `pathProjectSkills` relative path.
 *
 * @param provider - The provider whose skills directory to resolve
 * @param scope - Whether to resolve global or project skills path
 * @param projectDir - The project root directory, defaults to `process.cwd()`
 * @returns The resolved skills directory path
 *
 * @example
 * ```typescript
 * const skillsDir = resolveProviderSkillsDir(provider, "global");
 * // e.g., "/home/user/.claude/skills"
 * ```
 *
 * @public
 */
export function resolveProviderSkillsDir(
  provider: Provider,
  scope: PathScope,
  projectDir = process.cwd(),
): string {
  if (scope === 'global') {
    return provider.pathSkills;
  }
  return resolveProjectPath(provider.pathProjectSkills, projectDir);
}

/**
 * Gets all target directories for skill installation based on provider precedence.
 *
 * @remarks
 * Resolves one or more skill directories based on the provider's skills
 * precedence setting. The precedence determines whether vendor-only, agents-canonical,
 * agents-first, agents-supported, or vendor-global-agents-project strategies are used.
 * Falls back to the vendor path when the agents path is not configured.
 *
 * @param provider - Provider to resolve paths for
 * @param scope - Whether to resolve global or project paths
 * @param projectDir - Project directory for project-scope resolution
 * @returns Array of target directories for symlink creation
 *
 * @example
 * ```typescript
 * const dirs = resolveProviderSkillsDirs(provider, "project", "/home/user/project");
 * for (const dir of dirs) {
 *   console.log("Install skill to:", dir);
 * }
 * ```
 *
 * @public
 */
export function resolveProviderSkillsDirs(
  provider: Provider,
  scope: PathScope,
  projectDir = process.cwd(),
): string[] {
  const vendorPath = resolveProviderSkillsDir(provider, scope, projectDir);
  const precedence = provider.capabilities?.skills?.precedence ?? 'vendor-only';

  const resolveAgentsPath = (): string | null => {
    if (scope === 'global') {
      return provider.capabilities?.skills?.agentsGlobalPath ?? null;
    }
    const projectRelative = provider.capabilities?.skills?.agentsProjectPath ?? null;
    return projectRelative ? join(projectDir, projectRelative) : null;
  };

  switch (precedence) {
    case 'vendor-only':
      return [vendorPath];

    case 'agents-canonical': {
      const agentsPath = resolveAgentsPath();
      return agentsPath ? [agentsPath] : [vendorPath];
    }

    case 'agents-first': {
      const agentsPath = resolveAgentsPath();
      return agentsPath ? [agentsPath, vendorPath] : [vendorPath];
    }

    case 'agents-supported': {
      const agentsPath = resolveAgentsPath();
      return agentsPath ? [vendorPath, agentsPath] : [vendorPath];
    }

    case 'vendor-global-agents-project': {
      if (scope === 'global') {
        return [vendorPath];
      }
      const agentsPath = resolveAgentsPath();
      return agentsPath ? [agentsPath, vendorPath] : [vendorPath];
    }

    default:
      return [vendorPath];
  }
}

/**
 * Resolves a provider's project-level path against a project directory.
 *
 * @remarks
 * Joins the project directory with the provider's `pathProject` relative path
 * to produce an absolute path for project-scoped provider configuration.
 *
 * @param provider - The provider whose project path to resolve
 * @param projectDir - The project root directory, defaults to `process.cwd()`
 * @returns The resolved absolute path for the provider's project directory
 *
 * @example
 * ```typescript
 * const projectPath = resolveProviderProjectPath(provider, "/home/user/project");
 * // e.g., "/home/user/project/.claude"
 * ```
 *
 * @public
 */
export function resolveProviderProjectPath(provider: Provider, projectDir = process.cwd()): string {
  return resolveProjectPath(provider.pathProject, projectDir);
}

/**
 * Locates the providers registry.json file by searching up from a start directory.
 *
 * @remarks
 * First checks common relative locations (3 levels up and 1 level up),
 * then walks up to 8 parent directories looking for `providers/registry.json`.
 * Throws if the registry file cannot be found.
 *
 * @param startDir - The directory to start searching from
 * @returns The absolute path to the found `providers/registry.json` file
 * @throws Error if `providers/registry.json` cannot be found within 8 parent levels
 *
 * @example
 * ```typescript
 * const registryPath = resolveProvidersRegistryPath(__dirname);
 * // e.g., "/home/user/caamp/providers/registry.json"
 * ```
 *
 * @public
 */
export function resolveProvidersRegistryPath(startDir: string): string {
  const candidates = [
    join(startDir, '..', '..', '..', 'providers', 'registry.json'),
    join(startDir, '..', 'providers', 'registry.json'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  let current = startDir;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(current, 'providers', 'registry.json');
    if (existsSync(candidate)) {
      return candidate;
    }
    current = dirname(current);
  }

  throw new Error(`Cannot find providers/registry.json (searched from ${startDir})`);
}

/**
 * Normalizes a skill sub-path by cleaning separators and removing SKILL.md suffix.
 *
 * @remarks
 * Converts backslashes to forward slashes, strips leading slashes and
 * trailing `/SKILL.md`, and trims whitespace. Returns undefined for
 * empty or falsy inputs.
 *
 * @param path - The raw skill sub-path to normalize
 * @returns The normalized path, or undefined if the input is empty or falsy
 *
 * @example
 * ```typescript
 * const normalized = normalizeSkillSubPath("skills/my-skill/SKILL.md");
 * // returns "skills/my-skill"
 * ```
 *
 * @public
 */
export function normalizeSkillSubPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const normalized = path
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/SKILL\.md$/i, '')
    .trim();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Builds a list of candidate sub-paths for skill file resolution.
 *
 * @remarks
 * Normalizes both the marketplace and parsed paths, then generates additional
 * candidates by prepending known prefixes (`.agents`, `.claude`) to paths
 * starting with `skills/`. Returns a deduplicated list of candidates, with
 * an undefined entry as fallback if no candidates are found.
 *
 * @param marketplacePath - The sub-path from the marketplace listing
 * @param parsedPath - The sub-path parsed from the source URL
 * @returns A deduplicated array of candidate sub-paths
 *
 * @example
 * ```typescript
 * const candidates = buildSkillSubPathCandidates("skills/my-skill", undefined);
 * // returns ["skills/my-skill", ".agents/skills/my-skill", ".claude/skills/my-skill"]
 * ```
 *
 * @public
 */
export function buildSkillSubPathCandidates(
  marketplacePath: string | undefined,
  parsedPath: string | undefined,
): (string | undefined)[] {
  const candidates: (string | undefined)[] = [];
  const base = normalizeSkillSubPath(marketplacePath);
  const parsed = normalizeSkillSubPath(parsedPath);

  if (base) candidates.push(base);
  if (parsed) candidates.push(parsed);

  const knownPrefixes = ['.agents', '.claude'];
  for (const value of [base, parsed]) {
    if (!value?.startsWith('skills/')) continue;
    for (const prefix of knownPrefixes) {
      candidates.push(`${prefix}/${value}`);
    }
  }

  if (candidates.length === 0) {
    candidates.push(undefined);
  }

  return Array.from(new Set(candidates));
}
