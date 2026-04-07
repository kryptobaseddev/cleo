/**
 * Provider registry loader
 *
 * Loads providers from providers/registry.json and resolves
 * platform-specific paths at runtime.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DetectionMethod,
  Provider,
  ProviderCapabilities,
  ProviderHarnessCapability,
  ProviderHooksCapability,
  ProviderMcpCapability,
  ProviderSkillsCapability,
  ProviderSpawnCapability,
} from '../../types.js';
import {
  type PathScope,
  resolveProviderSkillsDir,
  resolveProvidersRegistryPath,
  resolveRegistryTemplatePath,
} from '../paths/standard.js';
import type {
  HookEvent,
  ProviderPriority,
  ProviderRegistry,
  ProviderStatus,
  RegistryCapabilities,
  RegistryHarnessCapability,
  RegistryHooksCapability,
  RegistryMcpIntegration,
  RegistryProvider,
  RegistrySpawnCapability,
  SkillsPrecedence,
} from './types.js';

// ── Capability Defaults ──────────────────────────────────────────────

const DEFAULT_SKILLS_CAPABILITY: ProviderSkillsCapability = {
  agentsGlobalPath: null,
  agentsProjectPath: null,
  precedence: 'vendor-only',
};

const DEFAULT_HOOKS_CAPABILITY: ProviderHooksCapability = {
  supported: [],
  hookConfigPath: null,
  hookConfigPathProject: null,
  hookFormat: null,
  nativeEventCatalog: 'canonical',
  canInjectSystemPrompt: false,
  canBlockTools: false,
};

const DEFAULT_SPAWN_CAPABILITY: ProviderSpawnCapability = {
  supportsSubagents: false,
  supportsProgrammaticSpawn: false,
  supportsInterAgentComms: false,
  supportsParallelSpawn: false,
  spawnMechanism: null,
  spawnCommand: null,
};

function resolveMcpCapability(raw: RegistryMcpIntegration): ProviderMcpCapability {
  return {
    configKey: raw.configKey,
    configFormat: raw.configFormat,
    configPathGlobal: resolveRegistryTemplatePath(raw.configPathGlobal),
    configPathProject: raw.configPathProject,
    supportedTransports: [...raw.supportedTransports],
    supportsHeaders: raw.supportsHeaders,
  };
}

function resolveHarnessCapability(raw: RegistryHarnessCapability): ProviderHarnessCapability {
  return {
    kind: raw.kind,
    spawnTargets: [...raw.spawnTargets],
    supportsConductorLoop: raw.supportsConductorLoop,
    supportsStageGuidance: raw.supportsStageGuidance,
    supportsCantBridge: raw.supportsCantBridge,
    extensionsPath: resolveRegistryTemplatePath(raw.extensionsPath),
    globalExtensionsHub: raw.globalExtensionsHub
      ? resolveRegistryTemplatePath(raw.globalExtensionsHub)
      : null,
  };
}

function resolveHooksCapability(raw: RegistryHooksCapability): ProviderHooksCapability {
  return {
    supported: [...raw.supported],
    hookConfigPath: raw.hookConfigPath ? resolveRegistryTemplatePath(raw.hookConfigPath) : null,
    hookConfigPathProject: raw.hookConfigPathProject ?? null,
    hookFormat: raw.hookFormat,
    nativeEventCatalog: raw.nativeEventCatalog ?? 'canonical',
    canInjectSystemPrompt: raw.canInjectSystemPrompt ?? false,
    canBlockTools: raw.canBlockTools ?? false,
  };
}

function resolveSpawnCapability(raw: RegistrySpawnCapability): ProviderSpawnCapability {
  return {
    supportsSubagents: raw.supportsSubagents,
    supportsProgrammaticSpawn: raw.supportsProgrammaticSpawn,
    supportsInterAgentComms: raw.supportsInterAgentComms,
    supportsParallelSpawn: raw.supportsParallelSpawn,
    spawnMechanism: raw.spawnMechanism,
    spawnCommand: raw.spawnCommand ? [...raw.spawnCommand] : null,
  };
}

function resolveCapabilities(raw?: RegistryCapabilities): ProviderCapabilities {
  const skills: ProviderSkillsCapability = raw?.skills
    ? {
        agentsGlobalPath: raw.skills.agentsGlobalPath
          ? resolveRegistryTemplatePath(raw.skills.agentsGlobalPath)
          : null,
        agentsProjectPath: raw.skills.agentsProjectPath,
        precedence: raw.skills.precedence,
      }
    : { ...DEFAULT_SKILLS_CAPABILITY };

  const hooks: ProviderHooksCapability = raw?.hooks
    ? resolveHooksCapability(raw.hooks)
    : { ...DEFAULT_HOOKS_CAPABILITY, supported: [] };

  const spawn: ProviderSpawnCapability = raw?.spawn
    ? resolveSpawnCapability(raw.spawn)
    : { ...DEFAULT_SPAWN_CAPABILITY };

  const mcp: ProviderMcpCapability | null = raw?.mcp ? resolveMcpCapability(raw.mcp) : null;

  const harness: ProviderHarnessCapability | null = raw?.harness
    ? resolveHarnessCapability(raw.harness)
    : null;

  return { mcp, harness, skills, hooks, spawn };
}

function findRegistryPath(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return resolveProvidersRegistryPath(thisDir);
}

let _registry: ProviderRegistry | null = null;
let _providers: Map<string, Provider> | null = null;
let _aliasMap: Map<string, string> | null = null;

function resolveProvider(raw: RegistryProvider): Provider {
  return {
    id: raw.id,
    toolName: raw.toolName,
    vendor: raw.vendor,
    agentFlag: raw.agentFlag,
    aliases: raw.aliases,
    pathGlobal: resolveRegistryTemplatePath(raw.pathGlobal),
    pathProject: raw.pathProject,
    instructFile: raw.instructFile,
    pathSkills: resolveRegistryTemplatePath(raw.pathSkills),
    pathProjectSkills: raw.pathProjectSkills,
    detection: {
      methods: raw.detection.methods as DetectionMethod[],
      binary: raw.detection.binary,
      directories: raw.detection.directories?.map(resolveRegistryTemplatePath),
      appBundle: raw.detection.appBundle,
      flatpakId: raw.detection.flatpakId,
    },
    priority: raw.priority,
    status: raw.status,
    agentSkillsCompatible: raw.agentSkillsCompatible,
    capabilities: resolveCapabilities(raw.capabilities),
  };
}

function loadRegistry(): ProviderRegistry {
  if (_registry) return _registry;

  const registryPath = findRegistryPath();
  const raw = readFileSync(registryPath, 'utf-8');
  _registry = JSON.parse(raw) as ProviderRegistry;
  return _registry;
}

function ensureProviders(): void {
  if (_providers) return;

  const registry = loadRegistry();
  _providers = new Map<string, Provider>();
  _aliasMap = new Map<string, string>();

  for (const [id, raw] of Object.entries(registry.providers)) {
    const provider = resolveProvider(raw);
    _providers.set(id, provider);

    // Build alias map
    for (const alias of provider.aliases) {
      _aliasMap.set(alias, id);
    }
  }
}

/**
 * Retrieve all registered providers with resolved platform paths.
 *
 * Providers are lazily loaded from `providers/registry.json` on first call
 * and cached for subsequent calls.
 *
 * @remarks
 * The registry is parsed once and cached in-module state. Platform-specific
 * template paths (e.g. `~/.config/...`) are resolved at load time via
 * {@link resolveRegistryTemplatePath}. Call {@link resetRegistry} to force
 * a reload.
 *
 * @returns Array of all provider definitions
 *
 * @example
 * ```typescript
 * const providers = getAllProviders();
 * console.log(`${providers.length} providers registered`);
 * ```
 *
 * @public
 */
export function getAllProviders(): Provider[] {
  ensureProviders();
  if (!_providers) return [];
  return Array.from(_providers.values());
}

/**
 * Look up a provider by its ID or any of its aliases.
 *
 * @remarks
 * Alias resolution is performed via an internal map built during registry loading.
 * If the input matches an alias, it is resolved to the canonical provider ID before
 * lookup. If it matches neither an alias nor a canonical ID, `undefined` is returned.
 *
 * @param idOrAlias - Provider ID (e.g. `"claude-code"`) or alias (e.g. `"claude"`)
 * @returns The matching provider, or `undefined` if not found
 *
 * @example
 * ```typescript
 * const provider = getProvider("claude");
 * // Returns the claude-code provider via alias resolution
 * ```
 *
 * @public
 */
export function getProvider(idOrAlias: string): Provider | undefined {
  ensureProviders();
  const resolved = _aliasMap?.get(idOrAlias) ?? idOrAlias;
  return _providers?.get(resolved);
}

/**
 * Resolve an alias to its canonical provider ID.
 *
 * If the input is already a canonical ID (or unrecognized), it is returned as-is.
 *
 * @remarks
 * Alias mappings are built from the `aliases` array in each provider's registry
 * entry. This function is safe to call with canonical IDs -- they pass through unchanged.
 *
 * @param idOrAlias - Provider ID or alias to resolve
 * @returns The canonical provider ID
 *
 * @example
 * ```typescript
 * resolveAlias("claude"); // "claude-code"
 * resolveAlias("claude-code"); // "claude-code"
 * resolveAlias("unknown"); // "unknown"
 * ```
 *
 * @public
 */
export function resolveAlias(idOrAlias: string): string {
  ensureProviders();
  return _aliasMap?.get(idOrAlias) ?? idOrAlias;
}

/**
 * Filter providers by their priority tier.
 *
 * @remarks
 * Provider priority is assigned in `providers/registry.json` and indicates the
 * relative importance of a provider for detection ordering and display.
 * Callers filtering by `"primary"` should expect zero or one result; the
 * registry loader does not enforce the single-primary invariant.
 *
 * @param priority - Priority level to filter by (`"primary"`, `"high"`, `"medium"`, or `"low"`)
 * @returns Array of providers matching the given priority
 *
 * @example
 * ```typescript
 * const highPriority = getProvidersByPriority("high");
 * console.log(highPriority.map(p => p.toolName));
 * ```
 *
 * @public
 */
export function getProvidersByPriority(priority: ProviderPriority): Provider[] {
  return getAllProviders().filter((p) => p.priority === priority);
}

/**
 * Get the single primary harness provider, if any is registered.
 *
 * @remarks
 * Returns the provider with `priority === "primary"`. By convention a
 * registry defines at most one primary harness; this function returns
 * the first match if the invariant is violated and logs no warning. Use
 * {@link getProvidersByPriority} instead if you need to diagnose
 * duplicates.
 *
 * @returns The primary provider, or `undefined` if none is registered
 *
 * @example
 * ```typescript
 * const primary = getPrimaryProvider();
 * if (primary) {
 *   console.log(`Primary harness: ${primary.toolName}`);
 * }
 * ```
 *
 * @public
 */
export function getPrimaryProvider(): Provider | undefined {
  return getAllProviders().find((p) => p.priority === 'primary');
}

/**
 * Filter providers by their lifecycle status.
 *
 * @remarks
 * Lifecycle status is maintained per-provider in the registry and reflects
 * the provider's stability and support level within CAAMP.
 *
 * @param status - Status to filter by (`"active"`, `"beta"`, `"deprecated"`, or `"planned"`)
 * @returns Array of providers matching the given status
 *
 * @example
 * ```typescript
 * const active = getProvidersByStatus("active");
 * console.log(`${active.length} active providers`);
 * ```
 *
 * @public
 */
export function getProvidersByStatus(status: ProviderStatus): Provider[] {
  return getAllProviders().filter((p) => p.status === status);
}

/**
 * Filter providers that use a specific instruction file.
 *
 * Multiple providers often share the same instruction file (e.g. many use `"AGENTS.md"`).
 *
 * @remarks
 * CAAMP supports three instruction file types: `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md`.
 * Most providers read from `AGENTS.md` as the universal standard, while a few
 * have vendor-specific files.
 *
 * @param file - Instruction file name (e.g. `"CLAUDE.md"`, `"AGENTS.md"`)
 * @returns Array of providers that use the given instruction file
 *
 * @example
 * ```typescript
 * const claudeProviders = getProvidersByInstructFile("CLAUDE.md");
 * console.log(claudeProviders.map(p => p.id));
 * ```
 *
 * @public
 */
export function getProvidersByInstructFile(file: string): Provider[] {
  return getAllProviders().filter((p) => p.instructFile === file);
}

/**
 * Get the set of all unique instruction file names across all providers.
 *
 * @remarks
 * Iterates over all registered providers and collects the distinct
 * `instructFile` values. The result is deduplicated via a `Set`.
 *
 * @returns Array of unique instruction file names (e.g. `["CLAUDE.md", "AGENTS.md", "GEMINI.md"]`)
 *
 * @example
 * ```typescript
 * const files = getInstructionFiles();
 * // ["CLAUDE.md", "AGENTS.md", "GEMINI.md"]
 * ```
 *
 * @public
 */
export function getInstructionFiles(): string[] {
  const files = new Set<string>();
  for (const p of getAllProviders()) {
    files.add(p.instructFile);
  }
  return Array.from(files);
}

/**
 * Get the total number of registered providers.
 *
 * @remarks
 * Triggers lazy loading of the registry if not already loaded.
 * The count reflects the number of entries in `providers/registry.json`.
 *
 * @returns Count of providers in the registry
 *
 * @example
 * ```typescript
 * console.log(`Registry has ${getProviderCount()} providers`);
 * ```
 *
 * @public
 */
export function getProviderCount(): number {
  ensureProviders();
  return _providers?.size ?? 0;
}

/**
 * Get the semantic version string of the provider registry.
 *
 * @remarks
 * The version is read from the top-level `version` field in `providers/registry.json`
 * and follows semver conventions. It is bumped when provider definitions change.
 *
 * @returns Version string from `providers/registry.json` (e.g. `"2.0.0"`)
 *
 * @example
 * ```typescript
 * console.log(`Registry version: ${getRegistryVersion()}`);
 * ```
 *
 * @public
 */
export function getRegistryVersion(): string {
  return loadRegistry().version;
}

/**
 * Filter providers that support a specific hook event.
 *
 * @remarks
 * Hook events are declared per-provider in the `capabilities.hooks.supported`
 * array within the registry. Only providers that explicitly list the event
 * are returned.
 *
 * @param event - Hook event to filter by (e.g. `"onToolComplete"`)
 * @returns Array of providers whose hooks capability includes the given event
 *
 * @example
 * ```typescript
 * const providers = getProvidersByHookEvent("onToolComplete");
 * console.log(providers.map(p => p.id));
 * ```
 *
 * @public
 */
export function getProvidersByHookEvent(event: HookEvent): Provider[] {
  return getAllProviders().filter((p) => p.capabilities.hooks.supported.includes(event));
}

/**
 * Get hook events common to all specified providers.
 *
 * If providerIds is provided, returns the intersection of their supported events.
 * If providerIds is undefined or empty, uses all providers.
 *
 * @remarks
 * Computes the set intersection of `capabilities.hooks.supported` across the
 * target providers. Useful for determining which hook events can be reliably
 * used across a multi-agent installation.
 *
 * @param providerIds - Optional array of provider IDs to intersect
 * @returns Array of hook events supported by ALL specified providers
 *
 * @example
 * ```typescript
 * const common = getCommonHookEvents(["claude-code", "gemini-cli"]);
 * console.log(`${common.length} common hook events`);
 * ```
 *
 * @public
 */
export function getCommonHookEvents(providerIds?: string[]): HookEvent[] {
  const providers =
    providerIds && providerIds.length > 0
      ? providerIds.map((id) => getProvider(id)).filter((p): p is Provider => p !== undefined)
      : getAllProviders();

  if (providers.length === 0) return [];

  const first = providers[0]!.capabilities.hooks.supported as HookEvent[];
  return first.filter((event) =>
    providers.every((p) => p.capabilities.hooks.supported.includes(event)),
  );
}

/**
 * Check whether a provider supports a specific capability via dot-path query.
 *
 * The dot-path addresses a value inside `provider.capabilities`. For boolean
 * fields the provider "supports" the capability when the value is `true`.
 * For non-boolean fields the provider "supports" it when the value is neither
 * `null` nor `undefined` (and, for arrays, non-empty).
 *
 * @remarks
 * This function traverses the capabilities object using dot-delimited path
 * segments. It handles three value types: booleans (must be `true`), arrays
 * (must be non-empty), and all other values (must be non-null/undefined).
 * Invalid paths return `false`.
 *
 * @param provider - Provider to inspect
 * @param dotPath  - Dot-delimited capability path (e.g. `"spawn.supportsSubagents"`, `"hooks.supported"`)
 * @returns `true` when the provider has the specified capability
 *
 * @example
 * ```typescript
 * const claude = getProvider("claude-code");
 * providerSupports(claude!, "spawn.supportsSubagents"); // true
 * providerSupports(claude!, "hooks.supported"); // true (non-empty array)
 * ```
 *
 * @public
 */
export function providerSupports(provider: Provider, dotPath: string): boolean {
  const parts = dotPath.split('.');
  let current: unknown = provider.capabilities;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return false;
    current = (current as Record<string, unknown>)[part];
  }
  if (typeof current === 'boolean') return current;
  if (Array.isArray(current)) return current.length > 0;
  return current != null;
}

/**
 * Filter providers that support spawning subagents.
 *
 * @remarks
 * This is a convenience wrapper that checks the `capabilities.spawn.supportsSubagents`
 * boolean flag. For more granular spawn capability filtering, use
 * {@link getProvidersBySpawnCapability}.
 *
 * @returns Array of providers where `capabilities.spawn.supportsSubagents === true`
 *
 * @example
 * ```typescript
 * const spawnCapable = getSpawnCapableProviders();
 * console.log(spawnCapable.map(p => p.id));
 * ```
 *
 * @public
 */
export function getSpawnCapableProviders(): Provider[] {
  return getAllProviders().filter((p) => p.capabilities.spawn.supportsSubagents);
}

/**
 * Filter providers by a specific boolean spawn capability flag.
 *
 * @remarks
 * The spawn capability has four boolean flags that can be queried independently.
 * The `spawnMechanism` and `spawnCommand` fields are excluded from the flag
 * type since they are not boolean checks.
 *
 * @param flag - One of the four boolean flags on {@link ProviderSpawnCapability}
 *              (`"supportsSubagents"`, `"supportsProgrammaticSpawn"`,
 *               `"supportsInterAgentComms"`, `"supportsParallelSpawn"`)
 * @returns Array of providers where the specified flag is `true`
 *
 * @example
 * ```typescript
 * const parallel = getProvidersBySpawnCapability("supportsParallelSpawn");
 * console.log(parallel.map(p => p.id));
 * ```
 *
 * @see {@link getSpawnCapableProviders}
 *
 * @public
 */
export function getProvidersBySpawnCapability(
  flag: keyof Omit<ProviderSpawnCapability, 'spawnMechanism' | 'spawnCommand'>,
): Provider[] {
  return getAllProviders().filter((p) => p.capabilities.spawn[flag] === true);
}

/**
 * Reset cached registry data, forcing a reload on next access.
 *
 * @remarks
 * Clears the in-memory provider map, alias map, and raw registry cache.
 * Primarily used in test suites to ensure a clean state between test cases.
 *
 * @example
 * ```typescript
 * resetRegistry();
 * // Next call to getAllProviders() will re-read registry.json
 * ```
 *
 * @public
 */
export function resetRegistry(): void {
  _registry = null;
  _providers = null;
  _aliasMap = null;
}

// ── Skills Query Functions ──────────────────────────────────────────

/**
 * Filter providers by their skills precedence value.
 *
 * @remarks
 * Skills precedence controls how a provider resolves skill files when both
 * vendor-specific and `.agents/` standard paths exist. Values include
 * `"vendor-only"`, `"agents-canonical"`, `"agents-first"`, `"agents-supported"`,
 * and `"vendor-global-agents-project"`.
 *
 * @param precedence - Skills precedence to filter by
 * @returns Array of providers matching the given precedence
 *
 * @example
 * ```typescript
 * const vendorOnly = getProvidersBySkillsPrecedence("vendor-only");
 * console.log(vendorOnly.map(p => p.id));
 * ```
 *
 * @public
 */
export function getProvidersBySkillsPrecedence(precedence: SkillsPrecedence): Provider[] {
  return getAllProviders().filter((p) => p.capabilities.skills.precedence === precedence);
}

/**
 * Get the effective skills paths for a provider, ordered by precedence.
 *
 * @remarks
 * The returned array is ordered by precedence priority. For example, with
 * `"agents-first"` precedence the `.agents/` path appears before the vendor
 * path. The `source` field indicates whether the path comes from the vendor
 * directory or the `.agents/` standard directory.
 *
 * @param provider - Provider to resolve paths for
 * @param scope - Whether to resolve global or project paths
 * @param projectDir - Project directory for project-scope resolution
 * @returns Ordered array of paths with source and scope metadata
 *
 * @example
 * ```typescript
 * const provider = getProvider("claude-code")!;
 * const paths = getEffectiveSkillsPaths(provider, "global");
 * for (const p of paths) {
 *   console.log(`${p.source} (${p.scope}): ${p.path}`);
 * }
 * ```
 *
 * @public
 */
export function getEffectiveSkillsPaths(
  provider: Provider,
  scope: PathScope,
  projectDir?: string,
): Array<{ path: string; source: string; scope: string }> {
  const vendorPath = resolveProviderSkillsDir(provider, scope, projectDir);
  const { precedence, agentsGlobalPath, agentsProjectPath } = provider.capabilities.skills;

  const resolveAgentsPath = (): string | null => {
    if (scope === 'global' && agentsGlobalPath) return agentsGlobalPath;
    if (scope === 'project' && agentsProjectPath && projectDir) {
      return join(projectDir, agentsProjectPath);
    }
    return null;
  };

  const agentsPath = resolveAgentsPath();
  const scopeLabel = scope === 'global' ? 'global' : 'project';

  switch (precedence) {
    case 'vendor-only':
      return [{ path: vendorPath, source: 'vendor', scope: scopeLabel }];
    case 'agents-canonical':
      return agentsPath ? [{ path: agentsPath, source: 'agents', scope: scopeLabel }] : [];
    case 'agents-first':
      return [
        ...(agentsPath ? [{ path: agentsPath, source: 'agents', scope: scopeLabel }] : []),
        { path: vendorPath, source: 'vendor', scope: scopeLabel },
      ];
    case 'agents-supported':
      return [
        { path: vendorPath, source: 'vendor', scope: scopeLabel },
        ...(agentsPath ? [{ path: agentsPath, source: 'agents', scope: scopeLabel }] : []),
      ];
    case 'vendor-global-agents-project':
      if (scope === 'global') {
        return [{ path: vendorPath, source: 'vendor', scope: 'global' }];
      }
      return [
        ...(agentsPath ? [{ path: agentsPath, source: 'agents', scope: 'project' }] : []),
        { path: vendorPath, source: 'vendor', scope: 'project' },
      ];
    default:
      return [{ path: vendorPath, source: 'vendor', scope: scopeLabel }];
  }
}

/**
 * Build a full skills map for all providers.
 *
 * @remarks
 * Produces a summary of each provider's skills configuration including
 * the precedence mode and resolved global/project paths. For `"vendor-only"`
 * providers the paths point to the vendor skills directory; for others they
 * point to the `.agents/` standard paths.
 *
 * @returns Array of skills map entries with provider ID, tool name, precedence, and paths
 *
 * @example
 * ```typescript
 * const skillsMap = buildSkillsMap();
 * for (const entry of skillsMap) {
 *   console.log(`${entry.providerId}: ${entry.precedence}`);
 * }
 * ```
 *
 * @public
 */
export function buildSkillsMap(): Array<{
  providerId: string;
  toolName: string;
  precedence: SkillsPrecedence;
  paths: { global: string | null; project: string | null };
}> {
  return getAllProviders().map((p) => {
    const { precedence, agentsGlobalPath, agentsProjectPath } = p.capabilities.skills;
    const isVendorOnly = precedence === 'vendor-only';
    return {
      providerId: p.id,
      toolName: p.toolName,
      precedence,
      paths: {
        global: isVendorOnly ? p.pathSkills : (agentsGlobalPath ?? null),
        project: isVendorOnly ? p.pathProjectSkills : (agentsProjectPath ?? null),
      },
    };
  });
}

/**
 * Get capabilities for a provider by ID or alias.
 *
 * @remarks
 * Shorthand for `getProvider(idOrAlias)?.capabilities`. Returns the full
 * capabilities object containing mcp, harness, skills, hooks, and spawn
 * sub-objects.
 *
 * @param idOrAlias - Provider ID or alias
 * @returns The provider's capabilities, or undefined if not found
 *
 * @example
 * ```typescript
 * const caps = getProviderCapabilities("claude-code");
 * if (caps?.spawn.supportsSubagents) {
 *   console.log("Supports subagent spawning");
 * }
 * ```
 *
 * @public
 */
export function getProviderCapabilities(idOrAlias: string): ProviderCapabilities | undefined {
  return getProvider(idOrAlias)?.capabilities;
}

/**
 * Check if a provider supports a capability using ID/alias lookup.
 *
 * Convenience wrapper that resolves the provider first, then delegates
 * to the provider-level {@link providerSupports}.
 *
 * @remarks
 * Returns `false` both when the provider is not found and when the capability
 * is not supported. Use {@link getProvider} first if you need to distinguish
 * between these cases.
 *
 * @param idOrAlias - Provider ID or alias
 * @param capabilityPath - Dot-path into capabilities (e.g. "spawn.supportsSubagents")
 * @returns true if the provider supports the capability, false otherwise
 *
 * @example
 * ```typescript
 * if (providerSupportsById("claude-code", "spawn.supportsSubagents")) {
 *   console.log("Claude Code supports subagent spawning");
 * }
 * ```
 *
 * @see {@link providerSupports}
 *
 * @public
 */
export function providerSupportsById(idOrAlias: string, capabilityPath: string): boolean {
  const provider = getProvider(idOrAlias);
  if (!provider) return false;
  return providerSupports(provider, capabilityPath);
}
