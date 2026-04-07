# @cleocode/caamp — API Reference

## Table of Contents

- [Functions](#functions)
- [Types](#types)
- [Classes](#classes)
- [Constants](#constants)

## Functions

### `getPlatformPaths`

Get OS-appropriate paths for CAAMP's global directories.

```typescript
() => PlatformPaths
```

**Returns:** Resolved platform paths

```typescript
const paths = getPlatformPaths();
console.log(paths.data); // e.g. "/home/user/.local/share/agents"
```

### `getSystemInfo`

Get a cached system information snapshot.

```typescript
() => SystemInfo
```

**Returns:** Cached system info object

```typescript
const info = getSystemInfo();
console.log(`Running on ${info.platform}/${info.arch}`);
```

### `_resetPlatformPathsCache`

Invalidate the path and system info caches. Use in tests after mutating AGENTS_HOME env var.

```typescript
() => void
```

### `getPlatformLocations`

Resolves platform-specific directory locations for the current OS.

```typescript
() => PlatformLocations
```

**Returns:** Platform-specific directory locations

```typescript
const locations = getPlatformLocations();
console.log(locations.config); // e.g., "/home/user/.config"
```

### `getAgentsHome`

Returns the global agents home directory path.

```typescript
() => string
```

**Returns:** The absolute path to the global agents home directory

```typescript
const home = getAgentsHome();
// e.g., "/home/user/.local/share/caamp"
```

### `getProjectAgentsDir`

Returns the project-local `.agents` directory path.

```typescript
(projectRoot?: string) => string
```

**Parameters:**

- `projectRoot` — The project root directory, defaults to `process.cwd()`

**Returns:** The absolute path to the project's `.agents` directory

```typescript
const dir = getProjectAgentsDir("/home/user/my-project");
// returns "/home/user/my-project/.agents"
```

### `resolveProjectPath`

Resolves a relative path against a project directory.

```typescript
(relativePath: string, projectDir?: string) => string
```

**Parameters:**

- `relativePath` — The relative path to resolve
- `projectDir` — The project root directory, defaults to `process.cwd()`

**Returns:** The resolved absolute path

```typescript
const path = resolveProjectPath(".agents/config.toml", "/home/user/project");
// returns "/home/user/project/.agents/config.toml"
```

### `getCanonicalSkillsDir`

Returns the canonical skills storage directory path.

```typescript
() => string
```

**Returns:** The absolute path to the canonical skills directory

```typescript
const dir = getCanonicalSkillsDir();
// e.g., "/home/user/.local/share/caamp/skills"
```

### `getLockFilePath`

Returns the path to the CAAMP lock file.

```typescript
() => string
```

**Returns:** The absolute path to the `.caamp-lock.json` file

```typescript
const lockPath = getLockFilePath();
// e.g., "/home/user/.local/share/caamp/.caamp-lock.json"
```

### `getAgentsMcpDir`

Gets the MCP directory within the `.agents/` standard structure.

```typescript
(scope?: PathScope, projectDir?: string) => string
```

**Parameters:**

- `scope` — `"global"` for `~/.agents/mcp/`, `"project"` for `<project>/.agents/mcp/`
- `projectDir` — Project root (defaults to `process.cwd()`)

**Returns:** The absolute path to the MCP directory

```typescript
const globalMcp = getAgentsMcpDir("global");
const projectMcp = getAgentsMcpDir("project", "/home/user/project");
```

### `getAgentsMcpServersPath`

Gets the MCP servers.json path within the `.agents/` standard structure.

```typescript
(scope?: PathScope, projectDir?: string) => string
```

**Parameters:**

- `scope` — `"global"` for `~/.agents/mcp/servers.json`, `"project"` for `<project>/.agents/mcp/servers.json`
- `projectDir` — Project root (defaults to `process.cwd()`)

**Returns:** The absolute path to the `servers.json` file

```typescript
const serversPath = getAgentsMcpServersPath("global");
// e.g., "/home/user/.agents/mcp/servers.json"
```

### `getAgentsInstructFile`

Gets the primary AGENTS.md instruction file path within `.agents/`.

```typescript
(scope?: PathScope, projectDir?: string) => string
```

**Parameters:**

- `scope` — `"global"` for `~/.agents/AGENTS.md`, `"project"` for `<project>/.agents/AGENTS.md`
- `projectDir` — Project root (defaults to `process.cwd()`)

**Returns:** The absolute path to the AGENTS.md file

```typescript
const agentsFile = getAgentsInstructFile("project", "/home/user/project");
// returns "/home/user/project/.agents/AGENTS.md"
```

### `getAgentsConfigPath`

Gets the config.toml path within the `.agents/` standard structure.

```typescript
(scope?: PathScope, projectDir?: string) => string
```

**Parameters:**

- `scope` — `"global"` for `~/.agents/config.toml`, `"project"` for `<project>/.agents/config.toml`
- `projectDir` — Project root (defaults to `process.cwd()`)

**Returns:** The absolute path to the config.toml file

```typescript
const configPath = getAgentsConfigPath("global");
// e.g., "/home/user/.agents/config.toml"
```

### `getAgentsWikiDir`

Gets the wiki directory within the `.agents/` standard structure.

```typescript
(scope?: PathScope, projectDir?: string) => string
```

**Parameters:**

- `scope` — `"global"` or `"project"`
- `projectDir` — Project root (defaults to `process.cwd()`)

**Returns:** The absolute path to the wiki directory

```typescript
const wikiDir = getAgentsWikiDir("project", "/home/user/project");
// returns "/home/user/project/.agents/wiki"
```

### `getAgentsSpecDir`

Gets the spec directory within the `.agents/` standard structure.

```typescript
(scope?: PathScope, projectDir?: string) => string
```

**Parameters:**

- `scope` — `"global"` or `"project"`
- `projectDir` — Project root (defaults to `process.cwd()`)

**Returns:** The absolute path to the spec directory

```typescript
const specDir = getAgentsSpecDir("global");
// e.g., "/home/user/.agents/spec"
```

### `getAgentsLinksDir`

Gets the links directory within the `.agents/` standard structure.

```typescript
(scope?: PathScope, projectDir?: string) => string
```

**Parameters:**

- `scope` — `"global"` or `"project"`
- `projectDir` — Project root (defaults to `process.cwd()`)

**Returns:** The absolute path to the links directory

```typescript
const linksDir = getAgentsLinksDir("project", "/home/user/project");
// returns "/home/user/project/.agents/links"
```

### `resolveRegistryTemplatePath`

Resolves a registry template path by substituting platform variables.

```typescript
(template: string) => string
```

**Parameters:**

- `template` — The template string containing `$VARIABLE` placeholders

**Returns:** The resolved absolute path with all variables expanded

```typescript
const path = resolveRegistryTemplatePath("$HOME/.config/claude/settings.json");
// e.g., "/home/user/.config/claude/settings.json"
```

### `resolveProviderConfigPath`

Resolves the configuration file path for a provider at the given scope.

```typescript
(provider: Provider, scope: PathScope, projectDir?: string) => string | null
```

**Parameters:**

- `provider` — The provider whose config path to resolve
- `scope` — Whether to resolve global or project config path
- `projectDir` — The project root directory, defaults to `process.cwd()`

**Returns:** The resolved config file path, or null if unavailable for the given scope

```typescript
const configPath = resolveProviderConfigPath(provider, "project", "/home/user/project");
if (configPath) {
  console.log("Config at:", configPath);
}
```

### `resolvePreferredConfigScope`

Determines the preferred configuration scope for a provider.

```typescript
(provider: Provider, useGlobalFlag?: boolean) => PathScope
```

**Parameters:**

- `provider` — The provider to determine scope for
- `useGlobalFlag` — Optional flag to force global scope

**Returns:** The preferred path scope for configuration

```typescript
const scope = resolvePreferredConfigScope(provider, false);
// returns "project" if provider has configPathProject, otherwise "global"
```

### `resolveProviderSkillsDir`

Resolves the skills directory path for a provider at the given scope.

```typescript
(provider: Provider, scope: PathScope, projectDir?: string) => string
```

**Parameters:**

- `provider` — The provider whose skills directory to resolve
- `scope` — Whether to resolve global or project skills path
- `projectDir` — The project root directory, defaults to `process.cwd()`

**Returns:** The resolved skills directory path

```typescript
const skillsDir = resolveProviderSkillsDir(provider, "global");
// e.g., "/home/user/.claude/skills"
```

### `resolveProviderSkillsDirs`

Gets all target directories for skill installation based on provider precedence.

```typescript
(provider: Provider, scope: PathScope, projectDir?: string) => string[]
```

**Parameters:**

- `provider` — Provider to resolve paths for
- `scope` — Whether to resolve global or project paths
- `projectDir` — Project directory for project-scope resolution

**Returns:** Array of target directories for symlink creation

```typescript
const dirs = resolveProviderSkillsDirs(provider, "project", "/home/user/project");
for (const dir of dirs) {
  console.log("Install skill to:", dir);
}
```

### `resolveProviderProjectPath`

Resolves a provider's project-level path against a project directory.

```typescript
(provider: Provider, projectDir?: string) => string
```

**Parameters:**

- `provider` — The provider whose project path to resolve
- `projectDir` — The project root directory, defaults to `process.cwd()`

**Returns:** The resolved absolute path for the provider's project directory

```typescript
const projectPath = resolveProviderProjectPath(provider, "/home/user/project");
// e.g., "/home/user/project/.claude"
```

### `resolveProvidersRegistryPath`

Locates the providers registry.json file by searching up from a start directory.

```typescript
(startDir: string) => string
```

**Parameters:**

- `startDir` — The directory to start searching from

**Returns:** The absolute path to the found `providers/registry.json` file

```typescript
const registryPath = resolveProvidersRegistryPath(__dirname);
// e.g., "/home/user/caamp/providers/registry.json"
```

### `normalizeSkillSubPath`

Normalizes a skill sub-path by cleaning separators and removing SKILL.md suffix.

```typescript
(path: string | undefined) => string | undefined
```

**Parameters:**

- `path` — The raw skill sub-path to normalize

**Returns:** The normalized path, or undefined if the input is empty or falsy

```typescript
const normalized = normalizeSkillSubPath("skills/my-skill/SKILL.md");
// returns "skills/my-skill"
```

### `buildSkillSubPathCandidates`

Builds a list of candidate sub-paths for skill file resolution.

```typescript
(marketplacePath: string | undefined, parsedPath: string | undefined) => (string | undefined)[]
```

**Parameters:**

- `marketplacePath` — The sub-path from the marketplace listing
- `parsedPath` — The sub-path parsed from the source URL

**Returns:** A deduplicated array of candidate sub-paths

```typescript
const candidates = buildSkillSubPathCandidates("skills/my-skill", undefined);
// returns ["skills/my-skill", ".agents/skills/my-skill", ".claude/skills/my-skill"]
```

### `getAllProviders`

Retrieve all registered providers with resolved platform paths.  Providers are lazily loaded from `providers/registry.json` on first call and cached for subsequent calls.

```typescript
() => Provider[]
```

**Returns:** Array of all provider definitions

```typescript
const providers = getAllProviders();
console.log(`${providers.length} providers registered`);
```

### `getProvider`

Look up a provider by its ID or any of its aliases.

```typescript
(idOrAlias: string) => Provider | undefined
```

**Parameters:**

- `idOrAlias` — Provider ID (e.g. `"claude-code"`) or alias (e.g. `"claude"`)

**Returns:** The matching provider, or `undefined` if not found

```typescript
const provider = getProvider("claude");
// Returns the claude-code provider via alias resolution
```

### `resolveAlias`

Resolve an alias to its canonical provider ID.  If the input is already a canonical ID (or unrecognized), it is returned as-is.

```typescript
(idOrAlias: string) => string
```

**Parameters:**

- `idOrAlias` — Provider ID or alias to resolve

**Returns:** The canonical provider ID

```typescript
resolveAlias("claude"); // "claude-code"
resolveAlias("claude-code"); // "claude-code"
resolveAlias("unknown"); // "unknown"
```

### `getProvidersByPriority`

Filter providers by their priority tier.

```typescript
(priority: ProviderPriority) => Provider[]
```

**Parameters:**

- `priority` — Priority level to filter by (`"primary"`, `"high"`, `"medium"`, or `"low"`)

**Returns:** Array of providers matching the given priority

```typescript
const highPriority = getProvidersByPriority("high");
console.log(highPriority.map(p => p.toolName));
```

### `getPrimaryProvider`

Get the single primary harness provider, if any is registered.

```typescript
() => Provider | undefined
```

**Returns:** The primary provider, or `undefined` if none is registered

```typescript
const primary = getPrimaryProvider();
if (primary) {
  console.log(`Primary harness: ${primary.toolName}`);
}
```

### `getProvidersByStatus`

Filter providers by their lifecycle status.

```typescript
(status: ProviderStatus) => Provider[]
```

**Parameters:**

- `status` — Status to filter by (`"active"`, `"beta"`, `"deprecated"`, or `"planned"`)

**Returns:** Array of providers matching the given status

```typescript
const active = getProvidersByStatus("active");
console.log(`${active.length} active providers`);
```

### `getProvidersByInstructFile`

Filter providers that use a specific instruction file.  Multiple providers often share the same instruction file (e.g. many use `"AGENTS.md"`).

```typescript
(file: string) => Provider[]
```

**Parameters:**

- `file` — Instruction file name (e.g. `"CLAUDE.md"`, `"AGENTS.md"`)

**Returns:** Array of providers that use the given instruction file

```typescript
const claudeProviders = getProvidersByInstructFile("CLAUDE.md");
console.log(claudeProviders.map(p => p.id));
```

### `getInstructionFiles`

Get the set of all unique instruction file names across all providers.

```typescript
() => string[]
```

**Returns:** Array of unique instruction file names (e.g. `["CLAUDE.md", "AGENTS.md", "GEMINI.md"]`)

```typescript
const files = getInstructionFiles();
// ["CLAUDE.md", "AGENTS.md", "GEMINI.md"]
```

### `getProviderCount`

Get the total number of registered providers.

```typescript
() => number
```

**Returns:** Count of providers in the registry

```typescript
console.log(`Registry has ${getProviderCount()} providers`);
```

### `getRegistryVersion`

Get the semantic version string of the provider registry.

```typescript
() => string
```

**Returns:** Version string from `providers/registry.json` (e.g. `"2.0.0"`)

```typescript
console.log(`Registry version: ${getRegistryVersion()}`);
```

### `getProvidersByHookEvent`

Filter providers that support a specific hook event.

```typescript
(event: HookEvent) => Provider[]
```

**Parameters:**

- `event` — Hook event to filter by (e.g. `"onToolComplete"`)

**Returns:** Array of providers whose hooks capability includes the given event

```typescript
const providers = getProvidersByHookEvent("onToolComplete");
console.log(providers.map(p => p.id));
```

### `getCommonHookEvents`

Get hook events common to all specified providers.  If providerIds is provided, returns the intersection of their supported events. If providerIds is undefined or empty, uses all providers.

```typescript
(providerIds?: string[]) => HookEvent[]
```

**Parameters:**

- `providerIds` — Optional array of provider IDs to intersect

**Returns:** Array of hook events supported by ALL specified providers

```typescript
const common = getCommonHookEvents(["claude-code", "gemini-cli"]);
console.log(`${common.length} common hook events`);
```

### `providerSupports`

Check whether a provider supports a specific capability via dot-path query.  The dot-path addresses a value inside `provider.capabilities`. For boolean fields the provider "supports" the capability when the value is `true`. For non-boolean fields the provider "supports" it when the value is neither `null` nor `undefined` (and, for arrays, non-empty).

```typescript
(provider: Provider, dotPath: string) => boolean
```

**Parameters:**

- `provider` — Provider to inspect
- `dotPath` — Dot-delimited capability path (e.g. `"spawn.supportsSubagents"`, `"hooks.supported"`)

**Returns:** `true` when the provider has the specified capability

```typescript
const claude = getProvider("claude-code");
providerSupports(claude!, "spawn.supportsSubagents"); // true
providerSupports(claude!, "hooks.supported"); // true (non-empty array)
```

### `getSpawnCapableProviders`

Filter providers that support spawning subagents.

```typescript
() => Provider[]
```

**Returns:** Array of providers where `capabilities.spawn.supportsSubagents === true`

```typescript
const spawnCapable = getSpawnCapableProviders();
console.log(spawnCapable.map(p => p.id));
```

### `getProvidersBySpawnCapability`

Filter providers by a specific boolean spawn capability flag.

```typescript
(flag: keyof Omit<ProviderSpawnCapability, "spawnMechanism" | "spawnCommand">) => Provider[]
```

**Parameters:**

- `flag` — One of the four boolean flags on `ProviderSpawnCapability`              (`"supportsSubagents"`, `"supportsProgrammaticSpawn"`,               `"supportsInterAgentComms"`, `"supportsParallelSpawn"`)

**Returns:** Array of providers where the specified flag is `true`

```typescript
const parallel = getProvidersBySpawnCapability("supportsParallelSpawn");
console.log(parallel.map(p => p.id));
```

### `resetRegistry`

Reset cached registry data, forcing a reload on next access.

```typescript
() => void
```

```typescript
resetRegistry();
// Next call to getAllProviders() will re-read registry.json
```

### `getProvidersBySkillsPrecedence`

Filter providers by their skills precedence value.

```typescript
(precedence: SkillsPrecedence) => Provider[]
```

**Parameters:**

- `precedence` — Skills precedence to filter by

**Returns:** Array of providers matching the given precedence

```typescript
const vendorOnly = getProvidersBySkillsPrecedence("vendor-only");
console.log(vendorOnly.map(p => p.id));
```

### `getEffectiveSkillsPaths`

Get the effective skills paths for a provider, ordered by precedence.

```typescript
(provider: Provider, scope: PathScope, projectDir?: string) => Array<{ path: string; source: string; scope: string; }>
```

**Parameters:**

- `provider` — Provider to resolve paths for
- `scope` — Whether to resolve global or project paths
- `projectDir` — Project directory for project-scope resolution

**Returns:** Ordered array of paths with source and scope metadata

```typescript
const provider = getProvider("claude-code")!;
const paths = getEffectiveSkillsPaths(provider, "global");
for (const p of paths) {
  console.log(`${p.source} (${p.scope}): ${p.path}`);
}
```

### `buildSkillsMap`

Build a full skills map for all providers.

```typescript
() => Array<{ providerId: string; toolName: string; precedence: SkillsPrecedence; paths: { global: string | null; project: string | null; }; }>
```

**Returns:** Array of skills map entries with provider ID, tool name, precedence, and paths

```typescript
const skillsMap = buildSkillsMap();
for (const entry of skillsMap) {
  console.log(`${entry.providerId}: ${entry.precedence}`);
}
```

### `getProviderCapabilities`

Get capabilities for a provider by ID or alias.

```typescript
(idOrAlias: string) => ProviderCapabilities | undefined
```

**Parameters:**

- `idOrAlias` — Provider ID or alias

**Returns:** The provider's capabilities, or undefined if not found

```typescript
const caps = getProviderCapabilities("claude-code");
if (caps?.spawn.supportsSubagents) {
  console.log("Supports subagent spawning");
}
```

### `providerSupportsById`

Check if a provider supports a capability using ID/alias lookup.  Convenience wrapper that resolves the provider first, then delegates to the provider-level `providerSupports`.

```typescript
(idOrAlias: string, capabilityPath: string) => boolean
```

**Parameters:**

- `idOrAlias` — Provider ID or alias
- `capabilityPath` — Dot-path into capabilities (e.g. "spawn.supportsSubagents")

**Returns:** true if the provider supports the capability, false otherwise

```typescript
if (providerSupportsById("claude-code", "spawn.supportsSubagents")) {
  console.log("Claude Code supports subagent spawning");
}
```

### `buildInjectionContent`

Build injection content from a structured template.  Produces a string suitable for injection between CAAMP markers. References are output as `@` lines, content blocks are appended as-is.

```typescript
(template: InjectionTemplate) => string
```

**Parameters:**

- `template` — Template defining references and content

**Returns:** Formatted injection content string

```typescript
const content = buildInjectionContent({
  references: ["\@AGENTS.md"],
});
```

### `parseInjectionContent`

Parse injection content back into template form.  Lines starting with `@` are treated as references. All other non-empty lines are treated as content blocks.

```typescript
(content: string) => InjectionTemplate
```

**Parameters:**

- `content` — Raw injection content string

**Returns:** Parsed InjectionTemplate

```typescript
const template = parseInjectionContent("\@AGENTS.md\n\@.cleo/config.json");
```

### `generateInjectionContent`

Generate a standard CAAMP injection block for instruction files.  Produces markdown content suitable for injection between CAAMP markers. Optionally includes MCP server and custom content sections.

```typescript
(options?: { mcpServerName?: string; customContent?: string; }) => string
```

**Parameters:**

- `options` — Optional configuration for the generated content

**Returns:** Generated markdown string

```typescript
const content = generateInjectionContent({ mcpServerName: "filesystem" });
```

### `generateSkillsSection`

Generate a skills discovery section for instruction files.

```typescript
(skillNames: string[]) => string
```

**Parameters:**

- `skillNames` — Array of skill names to list

**Returns:** Markdown string listing installed skills

```typescript
const section = generateSkillsSection(["code-review", "testing"]);
```

### `getInstructFile`

Get the correct instruction file name for a provider.

```typescript
(provider: Provider) => string
```

**Parameters:**

- `provider` — Provider registry entry

**Returns:** Instruction file name

```typescript
const fileName = getInstructFile(provider);
// "CLAUDE.md"
```

### `groupByInstructFile`

Group providers by their instruction file name.  Useful for determining which providers share the same instruction file (e.g. multiple providers using `AGENTS.md`).

```typescript
(providers: Provider[]) => Map<string, Provider[]>
```

**Parameters:**

- `providers` — Array of providers to group

**Returns:** Map from instruction file name to array of providers using that file

```typescript
const groups = groupByInstructFile(getAllProviders());
for (const [file, providers] of groups) {
  console.log(`${file}: ${providers.map(p => p.id).join(", ")}`);
}
```

### `checkInjection`

Check the status of a CAAMP injection block in an instruction file.  Returns the injection status: - `"missing"` - File does not exist - `"none"` - File exists but has no CAAMP markers - `"current"` - CAAMP block exists and matches expected content (or no expected content given) - `"outdated"` - CAAMP block exists but differs from expected content

```typescript
(filePath: string, expectedContent?: string) => Promise<InjectionStatus>
```

**Parameters:**

- `filePath` — Absolute path to the instruction file
- `expectedContent` — Optional expected content to compare against

**Returns:** The injection status

```typescript
const status = await checkInjection("/project/CLAUDE.md", expectedContent);
if (status === "outdated") {
  console.log("CAAMP injection needs updating");
}
```

### `inject`

Inject content into an instruction file between CAAMP markers.  Behavior depends on the file state: - File does not exist: creates the file with the injection block → `"created"` - File exists without markers: prepends the injection block → `"added"` - File exists with multiple markers (duplicates): consolidates into single block → `"consolidated"` - File exists with markers, content differs: replaces the block → `"updated"` - File exists with markers, content matches: no-op → `"intact"`  This function is **idempotent** — calling it multiple times with the same content will not modify the file after the first write.

```typescript
(filePath: string, content: string) => Promise<"created" | "added" | "consolidated" | "updated" | "intact">
```

**Parameters:**

- `filePath` — Absolute path to the instruction file
- `content` — Content to inject between CAAMP markers

**Returns:** Action taken: `"created"`, `"added"`, `"consolidated"`, `"updated"`, or `"intact"`

```typescript
const action = await inject("/project/CLAUDE.md", "## My Config\nSome content");
console.log(`File ${action}`); // "created" on first call, "intact" on subsequent
```

### `removeInjection`

Remove the CAAMP injection block from an instruction file.  If removing the block would leave the file empty, the file is deleted entirely.

```typescript
(filePath: string) => Promise<boolean>
```

**Parameters:**

- `filePath` — Absolute path to the instruction file

**Returns:** `true` if a CAAMP block was found and removed, `false` otherwise

```typescript
const removed = await removeInjection("/project/CLAUDE.md");
```

### `checkAllInjections`

Check injection status across all providers' instruction files.  Deduplicates by file path since multiple providers may share the same instruction file (e.g. many providers use `AGENTS.md`).

```typescript
(providers: Provider[], projectDir: string, scope: "project" | "global", expectedContent?: string) => Promise<InjectionCheckResult[]>
```

**Parameters:**

- `providers` — Array of providers to check
- `projectDir` — Absolute path to the project directory
- `scope` — Whether to check project or global instruction files
- `expectedContent` — Optional expected content to compare against

**Returns:** Array of injection check results, one per unique instruction file

```typescript
const results = await checkAllInjections(providers, "/project", "project", expected);
const outdated = results.filter(r => r.status === "outdated");
```

### `injectAll`

Inject content into all providers' instruction files.  Deduplicates by file path to avoid injecting the same file multiple times.

```typescript
(providers: Provider[], projectDir: string, scope: "project" | "global", content: string) => Promise<Map<string, "created" | "added" | "consolidated" | "updated" | "intact">>
```

**Parameters:**

- `providers` — Array of providers to inject into
- `projectDir` — Absolute path to the project directory
- `scope` — Whether to target project or global instruction files
- `content` — Content to inject between CAAMP markers

**Returns:** Map of file path to action taken (`"created"`, `"added"`, `"consolidated"`, `"updated"`, or `"intact"`)

```typescript
const results = await injectAll(providers, "/project", "project", content);
for (const [file, action] of results) {
  console.log(`${file}: ${action}`);
}
```

### `ensureProviderInstructionFile`

Ensure a provider's instruction file exists with the correct CAAMP block.  This is the canonical API for adapters and external packages to manage provider instruction files. Instead of directly creating/modifying CLAUDE.md, GEMINI.md, etc., callers should use this function to delegate instruction file management to CAAMP.  The instruction file name is resolved from CAAMP's provider registry (single source of truth), not hardcoded by the caller.

```typescript
(providerId: string, projectDir: string, options: EnsureProviderInstructionFileOptions) => Promise<EnsureProviderInstructionFileResult>
```

**Parameters:**

- `providerId` — Provider ID from the registry (e.g. `"claude-code"`, `"gemini-cli"`)
- `projectDir` — Absolute path to the project directory
- `options` — References, content, and scope configuration

**Returns:** Result with file path, action taken, and provider metadata

```typescript
const result = await ensureProviderInstructionFile("claude-code", "/project", {
  references: ["\@AGENTS.md"],
});
```

### `ensureAllProviderInstructionFiles`

Ensure instruction files for multiple providers at once.  Deduplicates by file path — providers sharing the same instruction file (e.g. many providers use AGENTS.md) are only written once.

```typescript
(providerIds: string[], projectDir: string, options: EnsureProviderInstructionFileOptions) => Promise<EnsureProviderInstructionFileResult[]>
```

**Parameters:**

- `providerIds` — Array of provider IDs from the registry
- `projectDir` — Absolute path to the project directory
- `options` — References, content, and scope configuration

**Returns:** Array of results, one per unique instruction file

```typescript
const results = await ensureAllProviderInstructionFiles(
  ["claude-code", "cursor", "gemini-cli"],
  "/project",
  { references: ["\@AGENTS.md"] },
);
```

### `setVerbose`

Enable or disable verbose (debug) logging mode.  When enabled, debug messages are written to stderr.

```typescript
(v: boolean) => void
```

**Parameters:**

- `v` — `true` to enable verbose mode, `false` to disable

```typescript
setVerbose(true);
```

### `setQuiet`

Enable or disable quiet mode.  When enabled, info and warning messages are suppressed. Errors are always shown.

```typescript
(q: boolean) => void
```

**Parameters:**

- `q` — `true` to enable quiet mode, `false` to disable

```typescript
setQuiet(true);
```

### `debug`

Log a debug message to stderr when verbose mode is enabled.

```typescript
(...args: unknown[]) => void
```

**Parameters:**

- `args` — Values to log (forwarded to `console.error`)

```typescript
debug("Loading config from", filePath);
```

### `info`

Log an informational message to stdout.

```typescript
(...args: unknown[]) => void
```

**Parameters:**

- `args` — Values to log (forwarded to `console.log`)

```typescript
info("Installed 3 skills");
```

### `warn`

Log a warning message to stderr.

```typescript
(...args: unknown[]) => void
```

**Parameters:**

- `args` — Values to log (forwarded to `console.warn`)

```typescript
warn("Deprecated option used");
```

### `error`

Log an error message to stderr.

```typescript
(...args: unknown[]) => void
```

**Parameters:**

- `args` — Values to log (forwarded to `console.error`)

```typescript
error("Failed to install skill:", err.message);
```

### `isVerbose`

Check if verbose (debug) logging is currently enabled.

```typescript
() => boolean
```

**Returns:** `true` if verbose mode is active

```typescript
if (isVerbose()) {
  console.error("Extra debug info");
}
```

### `isQuiet`

Check if quiet mode is currently enabled.

```typescript
() => boolean
```

**Returns:** `true` if quiet mode is active

```typescript
if (!isQuiet()) {
  console.log("Status message");
}
```

### `setHuman`

Enable or disable human-readable output mode.  When enabled, commands output human-readable format instead of JSON.

```typescript
(h: boolean) => void
```

**Parameters:**

- `h` — `true` to enable human mode, `false` to disable

```typescript
setHuman(true);
```

### `isHuman`

Check if human-readable output mode is currently enabled.

```typescript
() => boolean
```

**Returns:** `true` if human mode is active

```typescript
if (isHuman()) {
  console.log("Human readable output");
} else {
  console.log(JSON.stringify(data));
}
```

### `detectProvider`

Detect if a single provider is installed on the system.  Checks each detection method configured for the provider (binary, directory, appBundle, flatpak) and returns which methods matched.

```typescript
(provider: Provider) => DetectionResult
```

**Parameters:**

- `provider` — The provider to detect

**Returns:** Detection result with installation status and matched methods

```typescript
const provider = getProvider("claude-code")!;
const result = detectProvider(provider);
if (result.installed) {
  console.log(`Claude Code found via: ${result.methods.join(", ")}`);
}
```

### `detectProjectProvider`

Detect if a provider has project-level config in the given directory.

```typescript
(provider: Provider, projectDir: string) => boolean
```

**Parameters:**

- `provider` — Provider to check for project-level config
- `projectDir` — Absolute path to the project directory

**Returns:** `true` if the provider has a config file in the project directory

```typescript
const provider = getProvider("claude-code")!;
const hasProjectConfig = detectProjectProvider(provider, "/home/user/my-project");
```

### `detectAllProviders`

Detect all registered providers and return their installation status.  Runs detection for every provider in the registry.

```typescript
(options?: DetectionCacheOptions) => DetectionResult[]
```

**Parameters:**

- `options` — Cache control options

**Returns:** Array of detection results for all providers

```typescript
const results = detectAllProviders({ forceRefresh: true });
const installed = results.filter(r => r.installed);
console.log(`${installed.length} agents detected`);
```

### `getInstalledProviders`

Get only providers that are currently installed on the system.  Convenience wrapper that filters `detectAllProviders` results to only those with `installed === true`.

```typescript
(options?: DetectionCacheOptions) => Provider[]
```

**Parameters:**

- `options` — Cache control options passed through to detection

**Returns:** Array of installed provider definitions

```typescript
const installed = getInstalledProviders({ forceRefresh: true });
console.log(installed.map(p => p.toolName).join(", "));
```

### `detectProjectProviders`

Detect all providers and enrich results with project-level presence.  Extends `detectAllProviders` by also checking whether each provider has a project-level config file in the given directory.

```typescript
(projectDir: string, options?: DetectionCacheOptions) => DetectionResult[]
```

**Parameters:**

- `projectDir` — Absolute path to the project directory to check
- `options` — Cache control options passed through to detection

**Returns:** Array of detection results with `projectDetected` populated

```typescript
const results = detectProjectProviders("/home/user/my-project", { forceRefresh: true });
for (const r of results) {
  if (r.projectDetected) {
    console.log(`${r.provider.toolName} has project config`);
  }
}
```

### `resetDetectionCache`

Reset the detection result cache, forcing fresh detection on next call.

```typescript
() => void
```

```typescript
resetDetectionCache();
// Next detectAllProviders() call will bypass cache
const fresh = detectAllProviders();
```

### `installToCanonical`

Copy skill files to the canonical location.

```typescript
(sourcePath: string, skillName: string) => Promise<string>
```

**Parameters:**

- `sourcePath` — Absolute path to the source skill directory to copy
- `skillName` — Name for the skill (used as the subdirectory name)

**Returns:** Absolute path to the canonical installation directory

```typescript
const canonicalPath = await installToCanonical("/tmp/my-skill", "my-skill");
console.log(`Installed to: ${canonicalPath}`);
```

### `installSkill`

Install a skill from a local path to the canonical location and link to agents.

```typescript
(sourcePath: string, skillName: string, providers: Provider[], isGlobal: boolean, projectDir?: string) => Promise<SkillInstallResult>
```

**Parameters:**

- `sourcePath` — Local path to the skill directory to install
- `skillName` — Name for the installed skill
- `providers` — Target providers to link the skill to
- `isGlobal` — Whether to link to global or project skill directories
- `projectDir` — Project directory (defaults to `process.cwd()`)

**Returns:** Install result with linked agents and any errors

```typescript
const result = await installSkill("/tmp/my-skill", "my-skill", providers, true, "/my/project");
if (result.success) {
  console.log(`Linked to: ${result.linkedAgents.join(", ")}`);
}
```

### `removeSkill`

Remove a skill from the canonical location and all agent symlinks.

```typescript
(skillName: string, providers: Provider[], isGlobal: boolean, projectDir?: string) => Promise<{ removed: string[]; errors: string[]; }>
```

**Parameters:**

- `skillName` — Name of the skill to remove
- `providers` — Providers to unlink the skill from
- `isGlobal` — Whether to target global or project skill directories
- `projectDir` — Project directory (defaults to `process.cwd()`)

**Returns:** Object with arrays of successfully removed provider IDs and error messages

```typescript
const { removed, errors } = await removeSkill("my-skill", providers, true, "/my/project");
console.log(`Removed from: ${removed.join(", ")}`);
```

### `listCanonicalSkills`

List all skills installed in the canonical skills directory.

```typescript
() => Promise<string[]>
```

**Returns:** Array of skill names

```typescript
const skills = await listCanonicalSkills();
// ["my-skill", "another-skill"]
```

### `selectProvidersByMinimumPriority`

Filters providers by minimum priority and returns them in deterministic tier order.

```typescript
(providers: Provider[], minimumPriority?: ProviderPriority) => Provider[]
```

**Parameters:**

- `providers` — The full list of providers to filter
- `minimumPriority` — The minimum priority threshold, defaults to `"low"` (include all)

**Returns:** A filtered and sorted array of providers meeting the priority threshold

```typescript
const highPriority = selectProvidersByMinimumPriority(allProviders, "high");
// returns only providers with priority "high"
```

### `installBatchWithRollback`

Installs multiple skills across filtered providers with rollback.

```typescript
(options: BatchInstallOptions) => Promise<BatchInstallResult>
```

**Parameters:**

- `options` — The batch installation options including providers, operations, and scope

**Returns:** A result object indicating success, applied counts, and any rollback information

```typescript
const result = await installBatchWithRollback({
  minimumPriority: "high",
  skills: [{ sourcePath: "/path/to/skill", skillName: "my-skill" }],
});
if (!result.success) {
  console.error("Failed:", result.error);
}
```

### `updateInstructionsSingleOperation`

Updates instruction files across providers as a single operation.

```typescript
(providers: Provider[], content: string, scope?: Scope, projectDir?: string) => Promise<InstructionUpdateSummary>
```

**Parameters:**

- `providers` — The providers whose instruction files to update
- `content` — The instruction content to inject
- `scope` — The scope for instruction updates, defaults to `"project"`
- `projectDir` — The project root directory, defaults to `process.cwd()`

**Returns:** A summary of updated files and actions taken per file

```typescript
const summary = await updateInstructionsSingleOperation(
  providers,
  "## CAAMP Config\nUse these MCP servers...",
  "project",
);
console.log(`Updated ${summary.updatedFiles} files`);
```

### `resolveTierDir`

Resolve the on-disk directory for an asset at a given tier.

```typescript
(opts: ResolveTierDirOptions) => string
```

**Parameters:**

- `opts` — Resolution options (see `ResolveTierDirOptions`)

**Returns:** Absolute directory path for the asset at the requested tier

```typescript
import { resolveTierDir } from "./scope.js";

const projectExt = resolveTierDir({
  tier: "project",
  kind: "extensions",
  projectDir: "/home/alice/repos/cleo",
});
// → "/home/alice/repos/cleo/.pi/extensions"

const userExt = resolveTierDir({ tier: "user", kind: "extensions" });
// → "/home/alice/.pi/agent/extensions"

const globalExt = resolveTierDir({ tier: "global", kind: "extensions" });
// → "/home/alice/.local/share/cleo/pi-extensions"
```

### `resolveAllTiers`

Resolve every tier directory for a given asset kind, in precedence order.

```typescript
(kind: HarnessAssetKind, projectDir?: string) => Array<{ tier: HarnessTier; dir: string; }>
```

**Parameters:**

- `kind` — Asset kind to resolve
- `projectDir` — Project directory for the `project` tier. When   omitted the `project` tier entry is skipped rather than failing.

**Returns:** Array of `{ tier, dir }` pairs in precedence order

```typescript
const tiers = resolveAllTiers("extensions", "/home/alice/repo");
for (const { tier, dir } of tiers) {
  for (const entry of await safeReaddir(dir)) {
    // higher-precedence tier wins on name collision
  }
}
```

### `hasPiAbsentAutoWarned`

Read whether the `auto` + Pi-absent boot warning has already fired for this process.

```typescript
() => boolean
```

**Returns:** `true` once the warning has been emitted; `false` until then or   after `resetExclusivityWarningState` runs.

### `hasExplicitNonPiAutoWarned`

Read whether the `auto` + explicit-non-Pi deprecation warning has already fired for this process.

```typescript
() => boolean
```

**Returns:** `true` once the warning has been emitted; `false` until then or   after `resetExclusivityWarningState` runs.

### `markPiAbsentAutoWarned`

Mark the `auto` + Pi-absent warning as already emitted for this process.

```typescript
() => void
```

### `markExplicitNonPiAutoWarned`

Mark the `auto` + explicit-non-Pi deprecation warning as already emitted for this process.

```typescript
() => void
```

### `resetExclusivityWarningState`

Reset both per-process exclusivity warning latches.

```typescript
() => void
```

### `isExclusivityMode`

Type guard that narrows an arbitrary string to `ExclusivityMode`.

```typescript
(value: string) => value is ExclusivityMode
```

**Parameters:**

- `value` — Candidate value to validate.

**Returns:** `true` when `value` is one of `'auto'`, `'force-pi'`, `'legacy'`.

```typescript
if (isExclusivityMode(userInput)) {
  setExclusivityMode(userInput);
}
```

### `getExclusivityMode`

Resolve the active CAAMP exclusivity mode using the layered precedence documented in `DEFAULT_EXCLUSIVITY_MODE`.

```typescript
() => ExclusivityMode
```

**Returns:** The currently effective exclusivity mode.

```typescript
const mode = getExclusivityMode();
if (mode === 'force-pi') {
  // ...
}
```

### `setExclusivityMode`

Install a programmatic override for the exclusivity mode.

```typescript
(mode: ExclusivityMode) => void
```

**Parameters:**

- `mode` — Mode to install.

```typescript
setExclusivityMode('force-pi');
try {
  await runCommand();
} finally {
  resetExclusivityModeOverride();
}
```

### `resetExclusivityModeOverride`

Clear any programmatic override installed by `setExclusivityMode`.

```typescript
() => void
```

```typescript
setExclusivityMode("force-pi");
// ...run test...
resetExclusivityModeOverride();
// getExclusivityMode() now reads CAAMP_EXCLUSIVITY_MODE again
```

### `getHarnessFor`

Return the harness implementation for a provider, or `null` if the provider has no first-class harness.

```typescript
(provider: Provider) => Harness | null
```

**Parameters:**

- `provider` — Resolved provider to look up.

**Returns:** A harness instance, or `null` if the provider is a pure spawn target with no native harness.

```typescript
const pi = getProvider("pi");
if (pi) {
  const harness = getHarnessFor(pi);
  await harness?.installSkill("/path/to/skill", "my-skill", { kind: "global" });
}
```

### `getPrimaryHarness`

Return the primary harness declared in the registry, if any.

```typescript
() => Harness | null
```

**Returns:** The primary harness, or `null` if no primary provider exists or the primary provider has no harness implementation.

```typescript
const primary = getPrimaryHarness();
if (primary) {
  console.log(`Primary harness: ${primary.provider.toolName}`);
}
```

### `getAllHarnesses`

Return every provider that has a harness implementation.

```typescript
() => Harness[]
```

**Returns:** Array of harness instances, one per provider that implements the `Harness` contract.

```typescript
for (const harness of getAllHarnesses()) {
  console.log(harness.provider.id); // "pi", ...
}
```

### `resolveDefaultTargetProviders`

Resolve the default set of target providers when the user has not passed `--agent`, honouring the active `ExclusivityMode`.

```typescript
(options?: ResolveDefaultTargetProvidersOptions) => Provider[]
```

**Parameters:**

- `options` — Optional explicit provider selection (e.g. from   `--agent`) used by `auto`-mode deprecation warning detection. Omit to   request the implicit default resolution.

**Returns:** Ordered list of providers to target by default.

```typescript
// Implicit default — used by `caamp skills list` and friends.
const targets = resolveDefaultTargetProviders();

// Explicit user selection — emits a deprecation warning in `auto` mode
// when the selection excludes Pi and Pi is installed.
const explicit = resolveDefaultTargetProviders({
  explicit: [getProvider('claude-code')!],
});
```

### `dispatchInstallSkillAcrossProviders`

Install a skill across a mixed set of providers, dispatching each provider to its `Harness` implementation when one exists and falling through to the legacy canonical+symlink installer for generic providers.

```typescript
(sourcePath: string, skillName: string, providers: Provider[], isGlobal: boolean, projectDir?: string) => Promise<SkillInstallResult>
```

**Parameters:**

- `sourcePath` — Absolute path to the source skill directory.
- `skillName` — Target skill name.
- `providers` — Ordered list of target providers.
- `isGlobal` — Whether to target global or project scope.
- `projectDir` — Project directory used by the harness project scope   and forwarded to the generic installer when provided. When omitted,   harness project scope falls back to `process.cwd()` and the generic   installer is invoked without a `projectDir` argument so it retains its   legacy default-handling behavior.

**Returns:** Merged install result across the harness and generic paths.

```typescript
const result = await dispatchInstallSkillAcrossProviders(
  "/abs/path/to/skill",
  "my-skill",
  [getProvider("pi")!, getProvider("claude-code")!],
  true,
);
console.log(result.linkedAgents); // e.g. ["pi", "claude-code"]
```

### `dispatchRemoveSkillAcrossProviders`

Remove a skill across a mixed set of providers, dispatching each provider to its `Harness` implementation when one exists and falling through to the legacy canonical+symlink uninstaller for generic providers.

```typescript
(skillName: string, providers: Provider[], isGlobal: boolean, projectDir?: string) => Promise<{ removed: string[]; errors: string[]; }>
```

**Parameters:**

- `skillName` — Skill name to remove.
- `providers` — Ordered list of target providers.
- `isGlobal` — Whether to target global or project scope.
- `projectDir` — Project directory used by the harness project scope   and forwarded to the generic uninstaller when provided. When omitted,   harness project scope falls back to `process.cwd()` and the generic   uninstaller is invoked without a `projectDir` argument.

**Returns:** Merged `{ removed, errors }` result across both dispatch paths.

```typescript
const result = await dispatchRemoveSkillAcrossProviders(
  "my-skill",
  [getProvider("pi")!, getProvider("claude-code")!],
  true,
);
console.log(result.removed); // providers the skill was removed from
```

### `resolveFormat`

Resolves output format based on flags and defaults.

```typescript
(options: FormatOptions) => "json" | "human"
```

**Parameters:**

- `options` — Format resolution options

**Returns:** `"json"` or `"human"`

```typescript
const format = resolveFormat({ jsonFlag: true });
```

### `buildEnvelope`

Builds a standard LAFS envelope.

```typescript
<T>(operation: string, mvi: MVILevel, result: T | null, error: LAFSErrorShape | null, page?: LAFSPage | null, sessionId?: string, warnings?: LAFSWarning[]) => LAFSEnvelope<T>
```

**Parameters:**

- `operation` — Operation identifier (e.g., `"skills.list"`, `"doctor.check"`)
- `mvi` — Machine-Verified Instruction disclosure level
- `result` — Operation result data (`null` if error)
- `error` — Error details (`null` if success)
- `page` — Pagination info (`null` if not applicable)
- `sessionId` — Optional session identifier
- `warnings` — Optional array of warnings to attach

**Returns:** LAFS-compliant envelope

```typescript
const envelope = buildEnvelope(
  "skills.list",
  "full",
  { skills: [], count: 0 },
  null,
);
```

### `emitError`

Emits a JSON error envelope to stderr and exits the process.

```typescript
(operation: string, mvi: MVILevel, code: string, message: string, category: LAFSErrorCategory, details?: Record<string, unknown>, exitCode?: number) => never
```

**Parameters:**

- `operation` — Operation identifier
- `mvi` — Machine-Verified Instruction disclosure level
- `code` — Error code
- `message` — Error message
- `category` — Error category from LAFS protocol
- `details` — Additional error details
- `exitCode` — Process exit code (default: 1)

```typescript
emitError(
  "skills.install",
  "full",
  "E_SKILL_NOT_FOUND",
  "Skill not found",
  "NOT_FOUND",
  { skillName: "my-skill" },
  1,
);
```

### `emitJsonError`

Emits a JSON error envelope without exiting (for catch blocks).

```typescript
(operation: string, mvi: MVILevel, code: string, message: string, category: LAFSErrorCategory, details?: Record<string, unknown>) => void
```

**Parameters:**

- `operation` — Operation identifier
- `mvi` — Machine-Verified Instruction disclosure level
- `code` — Error code
- `message` — Error message
- `category` — Error category from LAFS protocol
- `details` — Additional error details

```typescript
try {
  await riskyOperation();
} catch (err) {
  emitJsonError("operation", "full", "E_FAILED", "Operation failed", "INTERNAL", {});
  process.exit(1);
}
```

### `outputSuccess`

Outputs a successful LAFS envelope to stdout.

```typescript
<T>(operation: string, mvi: MVILevel, result: T, page?: LAFSPage, sessionId?: string, warnings?: LAFSWarning[]) => void
```

**Parameters:**

- `operation` — Operation identifier
- `mvi` — Machine-Verified Instruction disclosure level
- `result` — Operation result data
- `page` — Optional pagination info
- `sessionId` — Optional session identifier
- `warnings` — Optional warnings to attach

```typescript
outputSuccess("skills.list", "full", { skills: [], count: 0 });
```

### `handleFormatError`

Handles format resolution errors consistently.

```typescript
(error: unknown, operation: string, mvi: MVILevel, jsonFlag: boolean | undefined) => never
```

**Parameters:**

- `error` — The error that occurred during format resolution
- `operation` — Operation identifier
- `mvi` — Machine-Verified Instruction disclosure level
- `jsonFlag` — Whether `--json` flag was explicitly set

**Returns:** never (exits process)

```typescript
try {
  format = resolveFormat({ jsonFlag: opts.json, humanFlag: opts.human });
} catch (error) {
  handleFormatError(error, "skills.list", "full", opts.json);
}
```

### `emitSuccess`

Emits a successful LAFS result envelope to stdout.

```typescript
<T>(operation: string, result: T, mvi?: MVILevel) => void
```

**Parameters:**

- `operation` — The LAFS operation identifier
- `result` — The result payload to include in the envelope
- `mvi` — The minimum viable information level, defaults to "standard"

```typescript
emitSuccess("advanced.providers", { providers: [...] });
```

### `emitError`

Emits a failed LAFS error envelope to stderr.

```typescript
(operation: string, error: unknown, mvi?: MVILevel) => void
```

**Parameters:**

- `operation` — The LAFS operation identifier
- `error` — The error to serialize, either a LAFSCommandError or generic Error/unknown
- `mvi` — The minimum viable information level, defaults to "standard"

```typescript
emitError("advanced.apply", new LAFSCommandError("E_VALIDATION", "bad input", "fix it"));
```

### `runLafsCommand`

Runs an async action and emits the result as a LAFS success or error envelope.

```typescript
<T>(command: string, mvi: MVILevel, action: () => Promise<T>) => Promise<void>
```

**Parameters:**

- `command` — The LAFS operation identifier
- `mvi` — The minimum viable information level
- `action` — The async function to execute

```typescript
await runLafsCommand("advanced.batch", "standard", async () => {
  return { installed: 3 };
});
```

### `parsePriority`

Parses and validates a provider priority tier string.

```typescript
(value: string) => ProviderPriority
```

**Parameters:**

- `value` — The priority string to parse

**Returns:** The validated ProviderPriority value

```typescript
const tier = parsePriority("high"); // "high"
```

### `resolveProviders`

Resolves the set of target providers from CLI targeting options.

```typescript
(options: ProviderTargetOptions) => Provider[]
```

**Parameters:**

- `options` — The provider targeting options from the CLI

**Returns:** An array of resolved Provider objects

```typescript
const providers = resolveProviders({ all: true });
```

### `readJsonFile`

Reads and parses a JSON file from disk.

```typescript
(path: string) => Promise<unknown>
```

**Parameters:**

- `path` — Absolute or relative path to the JSON file

**Returns:** The parsed JSON value

```typescript
const data = await readJsonFile("./operations.json");
```

### `readSkillOperations`

Reads and validates a JSON file containing skill batch operations.

```typescript
(path: string) => Promise<SkillBatchOperation[]>
```

**Parameters:**

- `path` — Path to the JSON file containing an array of skill operations

**Returns:** An array of validated SkillBatchOperation objects

```typescript
const ops = await readSkillOperations("./skill-ops.json");
```

### `readTextInput`

Reads text input from either inline content or a file path, enforcing mutual exclusivity.

```typescript
(inlineContent: string | undefined, filePath: string | undefined) => Promise<string | undefined>
```

**Parameters:**

- `inlineContent` — Inline text content from the --content flag, or undefined
- `filePath` — Path to a content file from the --content-file flag, or undefined

**Returns:** The text content string, or undefined if no input was provided

```typescript
const content = await readTextInput(undefined, "./content.txt");
```

### `registerAdvancedBatch`

Registers the `advanced batch` subcommand for rollback-capable batch install of skills.

```typescript
(parent: Command) => void
```

**Parameters:**

- `parent` — The parent `advanced` Command to attach the batch subcommand to

```bash
caamp advanced batch --skills-file skills.json
caamp advanced batch --skills-file skills.json --min-tier medium
```

### `registerAdvancedInstructions`

Registers the `advanced instructions` subcommand for single-operation instruction updates.

```typescript
(parent: Command) => void
```

**Parameters:**

- `parent` — The parent `advanced` Command to attach the instructions subcommand to

```bash
caamp advanced instructions --content "Custom block" --all
caamp advanced instructions --content-file block.md --min-tier high
```

### `registerAdvancedProviders`

Registers the `advanced providers` subcommand for selecting providers by priority tier.

```typescript
(parent: Command) => void
```

**Parameters:**

- `parent` — The parent `advanced` Command to attach the providers subcommand to

```bash
caamp advanced providers --min-tier high
caamp advanced providers --all --details
```

### `registerAdvancedCommands`

Registers the `advanced` command group with providers, batch, and instructions subcommands.

```typescript
(program: Command) => void
```

**Parameters:**

- `program` — The root Commander program to attach the advanced command group to

```bash
caamp advanced batch --skills-file skills.json
caamp advanced instructions --content "## Setup" --all
```

### `deepMerge`

Deep merge two objects, with `source` values winning on conflict.  Recursively merges nested plain objects. Arrays and non-object values from `source` overwrite `target` values.

```typescript
(target: Record<string, unknown>, source: Record<string, unknown>) => Record<string, unknown>
```

**Parameters:**

- `target` — Base object to merge into
- `source` — Object with values that take precedence

**Returns:** A new merged object (does not mutate inputs)

```typescript
const merged = deepMerge({ a: 1, b: { c: 2 } }, { b: { d: 3 } });
// { a: 1, b: { c: 2, d: 3 } }
```

### `setNestedValue`

Set a nested value using a dot-notation key path.

```typescript
(obj: Record<string, unknown>, keyPath: string, key: string, value: unknown) => Record<string, unknown>
```

**Parameters:**

- `obj` — Root object to modify
- `keyPath` — Dot-separated path to the parent key (e.g. `"mcpServers"`)
- `key` — Final key name for the value
- `value` — Value to set at the nested location

**Returns:** A new object with the value set at the specified path

```typescript
const result = setNestedValue({}, "a.b", "c", 42);
// { a: { b: { c: 42 } } }
```

### `getNestedValue`

Get a nested value from an object using a dot-notation key path.

```typescript
(obj: Record<string, unknown>, keyPath: string) => unknown
```

**Parameters:**

- `obj` — Object to traverse
- `keyPath` — Dot-separated key path (e.g. `"mcpServers"` or `"a.b.c"`)

**Returns:** The value at the key path, or `undefined` if not found

```typescript
getNestedValue({ a: { b: { c: 42 } } }, "a.b.c"); // 42
getNestedValue({ a: 1 }, "a.b"); // undefined
```

### `ensureDir`

Ensure that the parent directories of a file path exist.  Creates directories recursively if they do not exist.

```typescript
(filePath: string) => Promise<void>
```

**Parameters:**

- `filePath` — Absolute path to a file (parent directories will be created)

```typescript
await ensureDir("/path/to/new/dir/file.json");
// /path/to/new/dir/ now exists
```

### `readJsonConfig`

Read and parse a JSON or JSONC config file.

```typescript
(filePath: string) => Promise<Record<string, unknown>>
```

**Parameters:**

- `filePath` — Absolute path to the JSON/JSONC file

**Returns:** Parsed config object

```typescript
const config = await readJsonConfig("/home/user/.config/claude/settings.json");
```

### `writeJsonConfig`

Write a server config entry to a JSON/JSONC file, preserving comments.

```typescript
(filePath: string, configKey: string, serverName: string, serverConfig: unknown) => Promise<void>
```

**Parameters:**

- `filePath` — Absolute path to the JSON/JSONC file
- `configKey` — Dot-notation key path to the servers section (e.g. `"mcpServers"`)
- `serverName` — Name/key for the server entry
- `serverConfig` — Server configuration object to write

```typescript
await writeJsonConfig("/path/to/config.json", "mcpServers", "my-server", { command: "node" });
```

### `removeJsonConfig`

Remove a server entry from a JSON/JSONC config file.

```typescript
(filePath: string, configKey: string, serverName: string) => Promise<boolean>
```

**Parameters:**

- `filePath` — Absolute path to the JSON/JSONC file
- `configKey` — Dot-notation key path to the servers section
- `serverName` — Name/key of the server entry to remove

**Returns:** `true` if the entry was removed, `false` if the file or entry was not found

```typescript
const removed = await removeJsonConfig("/path/to/config.json", "mcpServers", "old-server");
```

### `readTomlConfig`

Read and parse a TOML config file.

```typescript
(filePath: string) => Promise<Record<string, unknown>>
```

**Parameters:**

- `filePath` — Absolute path to the TOML file

**Returns:** Parsed config object

```typescript
const config = await readTomlConfig("/path/to/config.toml");
```

### `writeTomlConfig`

Write a server config entry to a TOML file.

```typescript
(filePath: string, configKey: string, serverName: string, serverConfig: unknown) => Promise<void>
```

**Parameters:**

- `filePath` — Absolute path to the TOML file
- `configKey` — Dot-notation key path to the servers section
- `serverName` — Name/key for the server entry
- `serverConfig` — Server configuration object to write

```typescript
await writeTomlConfig("/path/to/config.toml", "mcpServers", "my-server", { command: "node" });
```

### `removeTomlConfig`

Remove a server entry from a TOML config file.

```typescript
(filePath: string, configKey: string, serverName: string) => Promise<boolean>
```

**Parameters:**

- `filePath` — Absolute path to the TOML file
- `configKey` — Dot-notation key path to the servers section
- `serverName` — Name/key of the server entry to remove

**Returns:** `true` if the entry was removed, `false` if the file or entry was not found

```typescript
const removed = await removeTomlConfig("/path/to/config.toml", "mcpServers", "old-server");
```

### `readYamlConfig`

Read and parse a YAML config file.

```typescript
(filePath: string) => Promise<Record<string, unknown>>
```

**Parameters:**

- `filePath` — Absolute path to the YAML file

**Returns:** Parsed config object

```typescript
const config = await readYamlConfig("/path/to/config.yaml");
```

### `writeYamlConfig`

Write a server config entry to a YAML file.

```typescript
(filePath: string, configKey: string, serverName: string, serverConfig: unknown) => Promise<void>
```

**Parameters:**

- `filePath` — Absolute path to the YAML file
- `configKey` — Dot-notation key path to the servers section
- `serverName` — Name/key for the server entry
- `serverConfig` — Server configuration object to write

```typescript
await writeYamlConfig("/path/to/config.yaml", "mcpServers", "my-server", { command: "node" });
```

### `removeYamlConfig`

Remove a server entry from a YAML config file.

```typescript
(filePath: string, configKey: string, serverName: string) => Promise<boolean>
```

**Parameters:**

- `filePath` — Absolute path to the YAML file
- `configKey` — Dot-notation key path to the servers section
- `serverName` — Name/key of the server entry to remove

**Returns:** `true` if the entry was removed, `false` if the file or entry was not found

```typescript
const removed = await removeYamlConfig("/path/to/config.yaml", "mcpServers", "old-server");
```

### `readConfig`

Read and parse a config file in the specified format.  Dispatches to the appropriate format handler (JSON/JSONC, YAML, or TOML).

```typescript
(filePath: string, format: ConfigFormat) => Promise<Record<string, unknown>>
```

**Parameters:**

- `filePath` — Absolute path to the config file
- `format` — Config file format

**Returns:** Parsed config object

```typescript
const config = await readConfig("/path/to/config.json", "jsonc");
```

### `writeConfig`

Write a server entry to a config file, preserving existing content.  Dispatches to the appropriate format handler. For JSONC files, comments are preserved using `jsonc-parser`.

```typescript
(filePath: string, format: ConfigFormat, key: string, serverName: string, serverConfig: unknown) => Promise<void>
```

**Parameters:**

- `filePath` — Absolute path to the config file
- `format` — Config file format
- `key` — Dot-notation key path to the servers section (e.g. `"mcpServers"`)
- `serverName` — Name/key for the server entry
- `serverConfig` — Server configuration object to write

```typescript
await writeConfig("/path/to/config.json", "jsonc", "mcpServers", "my-server", config);
```

### `removeConfig`

Remove a server entry from a config file in the specified format.

```typescript
(filePath: string, format: ConfigFormat, key: string, serverName: string) => Promise<boolean>
```

**Parameters:**

- `filePath` — Absolute path to the config file
- `format` — Config file format
- `key` — Dot-notation key path to the servers section
- `serverName` — Name/key of the server entry to remove

**Returns:** `true` if the entry was removed, `false` otherwise

```typescript
const removed = await removeConfig("/path/to/config.json", "jsonc", "mcpServers", "my-server");
```

### `registerConfigCommand`

Registers the `config` command group with show and path subcommands for viewing provider configurations.

```typescript
(program: Command) => void
```

**Parameters:**

- `program` — The root Commander program to attach the config command group to

```bash
caamp config show claude-code --global
caamp config path cursor project
```

### `readLockFile`

Read and parse the CAAMP lock file from disk.

```typescript
() => Promise<CaampLockFile>
```

**Returns:** Parsed lock file contents

```typescript
const lock = await readLockFile();
console.log(Object.keys(lock.mcpServers));
```

### `writeLockFile`

Write the lock file atomically under a process lock guard.

```typescript
(lock: CaampLockFile) => Promise<void>
```

**Parameters:**

- `lock` — Lock file data to persist

```typescript
const lock = await readLockFile();
lock.mcpServers["my-server"] = entry;
await writeLockFile(lock);
```

### `updateLockFile`

Safely read-modify-write the lock file under a process lock guard.

```typescript
(updater: (lock: CaampLockFile) => void | Promise<void>) => Promise<CaampLockFile>
```

**Parameters:**

- `updater` — Callback that modifies the lock object (may be async)

**Returns:** The updated lock file contents after the write

```typescript
const updated = await updateLockFile((lock) => {
  lock.mcpServers["new-server"] = entry;
});
```

### `getCaampVersion`

Retrieve the current CAAMP package version from the nearest `package.json`.

```typescript
() => string
```

**Returns:** The semver version string (e.g. `"1.8.1"`)

```typescript
const version = getCaampVersion();
console.log(`CAAMP v${version}`);
```

### `registerDoctorCommand`

Registers the `doctor` command for diagnosing configuration issues and overall system health.

```typescript
(program: Command) => void
```

**Parameters:**

- `program` — The root Commander program to attach the doctor command to

```bash
caamp doctor --human
caamp doctor --json
```

### `registerInstructionsCheck`

Registers the `instructions check` subcommand for verifying injection status across providers.

```typescript
(parent: Command) => void
```

**Parameters:**

- `parent` — The parent `instructions` Command to attach the check subcommand to

```bash
caamp instructions check --human
caamp instructions check --agent claude-code
```

### `registerInstructionsInject`

Registers the `instructions inject` subcommand for injecting instruction blocks into provider files.

```typescript
(parent: Command) => void
```

**Parameters:**

- `parent` — The parent `instructions` Command to attach the inject subcommand to

```bash
caamp instructions inject --all --global
caamp instructions inject --agent claude-code --dry-run
```

### `registerInstructionsUpdate`

Registers the `instructions update` subcommand for refreshing all instruction file injections.

```typescript
(parent: Command) => void
```

**Parameters:**

- `parent` — The parent `instructions` Command to attach the update subcommand to

```bash
caamp instructions update --yes
caamp instructions update --global --json
```

### `registerInstructionsCommands`

Registers the `instructions` command group with inject, check, and update subcommands.

```typescript
(program: Command) => void
```

**Parameters:**

- `program` — The root Commander program to attach the instructions command group to

```bash
caamp instructions inject --all
caamp instructions check --human
caamp instructions update --yes
```

### `resolveMcpConfigPath`

Resolve a provider's MCP config file path for the given scope, or `null` if the provider does not declare an MCP capability or the scope is unsupported.

```typescript
(provider: Provider, scope: McpScope, projectDir?: string) => string | null
```

**Parameters:**

- `provider` — Provider to resolve a config path for.
- `scope` — Scope to resolve.
- `projectDir` — Project directory used for the `project` scope.

**Returns:** The absolute config file path, or `null` when unavailable.

```typescript
const claudeCode = getProvider("claude-code")!;
const path = resolveMcpConfigPath(claudeCode, "project", "/tmp/app");
// e.g. "/tmp/app/.mcp.json"
```

### `listMcpServers`

List MCP server entries declared in a single provider's config file.

```typescript
(provider: Provider, scope: McpScope, projectDir?: string) => Promise<McpServerEntry[]>
```

**Parameters:**

- `provider` — Provider whose config file to read.
- `scope` — Scope to resolve (project|global).
- `projectDir` — Project directory used for the `project` scope   (defaults to `process.cwd()`).

**Returns:** Array of MCP server entries, or `[]` when nothing was found.

```typescript
const provider = getProvider("claude-code")!;
const entries = await listMcpServers(provider, "project");
for (const entry of entries) {
  console.log(entry.name, entry.configPath);
}
```

### `listAllMcpServers`

List MCP server entries for every MCP-capable provider in the registry at the given scope.

```typescript
(scope: McpScope, projectDir?: string) => Promise<McpServerEntriesByProvider>
```

**Parameters:**

- `scope` — Scope to resolve for every provider.
- `projectDir` — Project directory used for the `project` scope.

**Returns:** Map of provider id → server entries.

```typescript
const byProvider = await listAllMcpServers("global");
for (const [providerId, entries] of byProvider) {
  console.log(`${providerId}: ${entries.length} server(s)`);
}
```

### `detectMcpInstallations`

Probe every MCP-capable provider in the registry to determine which ones have a config file on disk and how many servers are configured.

```typescript
(scope: McpScope, projectDir?: string) => Promise<McpDetectionEntry[]>
```

**Parameters:**

- `scope` — Scope to probe.
- `projectDir` — Project directory used for the `project` scope.

**Returns:** Array of detection entries, one per MCP-capable provider.

```typescript
const hits = await detectMcpInstallations("project");
const installed = hits.filter((h) => h.exists);
console.log(`MCP found on ${installed.length} providers`);
```

### `installMcpServer`

Install an MCP server entry into a single provider's config file.

```typescript
(provider: Provider, serverName: string, config: McpServerConfig, opts: InstallMcpServerOptions) => Promise<InstallMcpServerResult>
```

**Parameters:**

- `provider` — Target provider.
- `serverName` — Name/key for the new server entry.
- `config` — Canonical `McpServerConfig` payload to write.
- `opts` — Install options (scope, force, projectDir).

**Returns:** Structured install result describing what happened.

```typescript
const provider = getProvider("claude-code")!;
const result = await installMcpServer(
  provider,
  "github",
  { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
  { scope: "project", force: false },
);
console.log(result.installed, result.conflicted);
```

### `removeMcpServer`

Remove an MCP server entry from a single provider's config file.

```typescript
(provider: Provider, serverName: string, opts: RemoveMcpServerOptions) => Promise<RemoveMcpServerResult>
```

**Parameters:**

- `provider` — Provider whose config file to modify.
- `serverName` — Server name/key to remove.
- `opts` — Removal options.

**Returns:** Structured result describing whether the entry was removed.

```typescript
const provider = getProvider("claude-code")!;
const result = await removeMcpServer(provider, "my-server", { scope: "project" });
console.log(result.removed); // true | false
```

### `removeMcpServerFromAll`

Remove an MCP server entry from every MCP-capable provider in the registry that currently has it configured.

```typescript
(serverName: string, opts: RemoveMcpServerOptions) => Promise<RemoveMcpServerResult[]>
```

**Parameters:**

- `serverName` — Server name/key to remove from every provider.
- `opts` — Removal options applied uniformly to every provider.

**Returns:** Array of per-provider removal results.

```typescript
const results = await removeMcpServerFromAll("my-server", { scope: "global" });
const removed = results.filter((r) => r.removed);
console.log(`Removed from ${removed.length} providers`);
```

### `requireMcpProvider`

Look up an MCP-capable provider in the registry by id, throwing a typed `LAFSCommandError` when the id is unknown or the provider does not declare an MCP capability.

```typescript
(providerId: string) => Provider
```

**Parameters:**

- `providerId` — Raw provider id supplied via `--provider <id>`.

**Returns:** The resolved `Provider` entry.

```typescript
const provider = requireMcpProvider("claude-code");
console.log(provider.toolName); // "Claude Code"
```

### `parseScope`

Parse and validate a `--scope` option value into a typed `McpScope`.

```typescript
(raw: string | undefined, defaultScope: McpScope) => McpScope
```

**Parameters:**

- `raw` — The raw option value from Commander (may be undefined).
- `defaultScope` — Scope to use when `raw` is undefined.

**Returns:** A resolved `McpScope`.

```typescript
parseScope(undefined, "project"); // "project"
parseScope("global", "project");  // "global"
parseScope("weird", "project");   // throws LAFSCommandError(E_VALIDATION_SCHEMA)
```

### `resolveProjectDir`

Resolve the project directory used for the `project` scope.

```typescript
(scope: McpScope, explicit: string | undefined) => string | undefined
```

**Parameters:**

- `scope` — Resolved scope.
- `explicit` — The raw `--project-dir` option value.

**Returns:** Absolute project dir for `project`, else `undefined`.

```typescript
resolveProjectDir("project", undefined);  // process.cwd()
resolveProjectDir("project", "/tmp/app"); // "/tmp/app"
resolveProjectDir("global", "/tmp/app");  // undefined
```

### `parseEnvAssignment`

Parse a single `--env KEY=VALUE` option value into a `[key, value]` pair, throwing a typed validation error when the shape is wrong.

```typescript
(raw: string) => [string, string]
```

**Parameters:**

- `raw` — Single `KEY=VALUE` token from Commander.

**Returns:** Tuple of `[key, value]`.

```typescript
parseEnvAssignment("GITHUB_TOKEN=ghp_abc"); // ["GITHUB_TOKEN", "ghp_abc"]
parseEnvAssignment("NO_EQUALS");            // throws LAFSCommandError
```

### `registerMcpDetectCommand`

Registers the `caamp mcp detect` subcommand.

```typescript
(parent: Command) => void
```

**Parameters:**

- `parent` — Parent `mcp` Command to attach the subcommand to.

```bash
caamp mcp detect
caamp mcp detect --scope global
caamp mcp detect --only-existing
```

### `registerMcpInstallCommand`

Registers the `caamp mcp install` subcommand.

```typescript
(parent: Command) => void
```

**Parameters:**

- `parent` — Parent `mcp` Command to attach the subcommand to.

```bash
# Inline form
caamp mcp install github --provider claude-desktop -- \
  npx -y @modelcontextprotocol/server-github

# From file
caamp mcp install github --provider cursor --from ./github.json

# With env vars
caamp mcp install github --provider claude-code \
  --env GITHUB_TOKEN=ghp_xxx -- \
  npx -y @modelcontextprotocol/server-github
```

### `registerMcpListCommand`

Registers the `caamp mcp list` subcommand.

```typescript
(parent: Command) => void
```

**Parameters:**

- `parent` — Parent `mcp` Command to attach the subcommand to.

```bash
caamp mcp list
caamp mcp list --provider claude-code
caamp mcp list --provider cursor --scope global
```

### `registerMcpRemoveCommand`

Registers the `caamp mcp remove` subcommand.

```typescript
(parent: Command) => void
```

**Parameters:**

- `parent` — Parent `mcp` Command to attach the subcommand to.

```bash
caamp mcp remove github --provider claude-desktop
caamp mcp remove github --provider cursor --scope global
caamp mcp remove github --all-providers
```

### `registerMcpCommands`

Register the `mcp` command group and all sub-verbs on the root program.

```typescript
(program: Command) => void
```

**Parameters:**

- `program` — The root Commander program to attach the `mcp`   group to.

```bash
caamp mcp detect
caamp mcp list --provider claude-code
caamp mcp install github --provider claude-desktop -- npx -y @modelcontextprotocol/server-github
caamp mcp remove github --provider claude-desktop
```

### `fetchWithTimeout`

Fetch a URL with an automatic timeout via `AbortSignal.timeout`.

```typescript
(url: string, init?: RequestInit, timeoutMs?: number) => Promise<Response>
```

**Parameters:**

- `url` — URL to fetch
- `init` — Optional `RequestInit` options forwarded to `fetch`
- `timeoutMs` — Timeout in milliseconds (defaults to `DEFAULT_FETCH_TIMEOUT_MS`)

**Returns:** The `Response` object from the fetch call

```typescript
const response = await fetchWithTimeout("https://api.example.com/data", undefined, 5000);
```

### `ensureOkResponse`

Assert that a `Response` has an OK status, throwing on failure.

```typescript
(response: Response, url: string) => Response
```

**Parameters:**

- `response` — Fetch `Response` to validate
- `url` — Original request URL (included in the error)

**Returns:** The same `Response` if status is OK

```typescript
const res = await fetchWithTimeout(url);
ensureOkResponse(res, url);
```

### `formatNetworkError`

Format a network error into a user-friendly message string.

```typescript
(error: unknown) => string
```

**Parameters:**

- `error` — The caught error value

**Returns:** Human-readable error description

```typescript
try {
  await fetchWithTimeout(url);
} catch (err) {
  console.error(formatNetworkError(err));
}
```

### `cloneRepo`

Clone a GitHub repo to a temp directory.

```typescript
(owner: string, repo: string, ref?: string, subPath?: string) => Promise<GitFetchResult>
```

**Parameters:**

- `owner` — GitHub repository owner (user or organization)
- `repo` — GitHub repository name
- `ref` — Branch or tag to clone (defaults to the repo's default branch)
- `subPath` — Subdirectory within the repo to target

**Returns:** Object with local path and cleanup function

```typescript
const { localPath, cleanup } = await cloneRepo("anthropics", "courses", "main", "skills");
try {
  console.log(`Cloned to: ${localPath}`);
} finally {
  await cleanup();
}
```

### `fetchRawFile`

Fetch a specific file from GitHub using the raw API.

```typescript
(owner: string, repo: string, path: string, ref?: string) => Promise<string | null>
```

**Parameters:**

- `owner` — GitHub repository owner
- `repo` — GitHub repository name
- `path` — File path within the repository
- `ref` — Branch or tag to fetch from (defaults to `"main"`)

**Returns:** File content as a string, or `null` if the file cannot be fetched

```typescript
const content = await fetchRawFile("owner", "repo", "skills/my-skill/SKILL.md");
if (content) {
  console.log(content);
}
```

### `repoExists`

Check if a GitHub repo exists.

```typescript
(owner: string, repo: string) => Promise<boolean>
```

**Parameters:**

- `owner` — GitHub repository owner
- `repo` — GitHub repository name

**Returns:** `true` if the repository exists and is accessible

```typescript
const exists = await repoExists("anthropics", "courses");
console.log(exists ? "Repo found" : "Repo not found");
```

### `cloneGitLabRepo`

Clone a GitLab repo to a temp directory.

```typescript
(owner: string, repo: string, ref?: string, subPath?: string) => Promise<GitFetchResult>
```

**Parameters:**

- `owner` — GitLab repository owner (user or group)
- `repo` — GitLab repository name
- `ref` — Branch or tag to clone (defaults to the repo's default branch)
- `subPath` — Subdirectory within the repo to target

**Returns:** Object with local path and cleanup function

```typescript
const { localPath, cleanup } = await cloneGitLabRepo("mygroup", "skills-repo");
try {
  console.log(`Cloned to: ${localPath}`);
} finally {
  await cleanup();
}
```

### `fetchGitLabRawFile`

Fetch a specific file from GitLab using the raw API.

```typescript
(owner: string, repo: string, path: string, ref?: string) => Promise<string | null>
```

**Parameters:**

- `owner` — GitLab repository owner (user or group)
- `repo` — GitLab repository name
- `path` — File path within the repository
- `ref` — Branch or tag to fetch from (defaults to `"main"`)

**Returns:** File content as a string, or `null` if the file cannot be fetched

```typescript
const content = await fetchGitLabRawFile("mygroup", "skills", "my-skill/SKILL.md");
if (content) {
  console.log(content);
}
```

### `parseSource`

Parse and classify a source string into a typed `ParsedSource`.

```typescript
(input: string) => ParsedSource
```

**Parameters:**

- `input` — Raw source string to classify

**Returns:** Parsed source with type, value, and inferred name

```typescript
parseSource("owner/repo");
// { type: "github", value: "https://github.com/owner/repo", inferredName: "repo", ... }

parseSource("https://mcp.example.com/sse");
// { type: "remote", value: "https://mcp.example.com/sse", inferredName: "example" }

parseSource("@modelcontextprotocol/server-filesystem");
// { type: "package", value: "@modelcontextprotocol/server-filesystem", inferredName: "filesystem" }
```

### `isMarketplaceScoped`

Check if a source string looks like a marketplace scoped name (`@author/name`).

```typescript
(input: string) => boolean
```

**Parameters:**

- `input` — Source string to check

**Returns:** `true` if the input matches the `@scope/name` pattern

```typescript
isMarketplaceScoped("@anthropic/my-skill"); // true
isMarketplaceScoped("my-skill");             // false
isMarketplaceScoped("owner/repo");           // false
```

### `requirePiHarness`

Resolve and validate Pi's installation, returning a ready-to-use `PiHarness`.

```typescript
() => PiHarness
```

**Returns:** A PiHarness bound to the resolved Pi provider entry.

```typescript
// Inside a `caamp pi <verb>` command action:
const harness = requirePiHarness();
const skills = await harness.listSkills({ kind: "global" });
```

### `parseScope`

Parse and validate a `--scope` option value into a typed tier.

```typescript
(raw: string | undefined, defaultTier: HarnessTier) => HarnessTier
```

**Parameters:**

- `raw` — The raw option value from Commander (may be undefined).
- `defaultTier` — Tier to use when `raw` is undefined.

**Returns:** A resolved `HarnessTier`.

```typescript
parseScope(undefined, "project"); // "project"
parseScope("user", "project");    // "user"
parseScope("weird", "project");   // throws LAFSCommandError(E_VALIDATION_SCHEMA)
```

### `resolveProjectDir`

Resolve the project directory to use for the `project` tier, honouring an explicit `--project-dir` flag and falling back to cwd.

```typescript
(tier: HarnessTier, explicit: string | undefined) => string | undefined
```

**Parameters:**

- `tier` — Resolved tier the verb is targeting.
- `explicit` — The raw `--project-dir` option value.

**Returns:** Absolute project dir when `tier === 'project'`, else `undefined`.

```typescript
resolveProjectDir("project", undefined);  // process.cwd()
resolveProjectDir("project", "/tmp/app"); // "/tmp/app"
resolveProjectDir("user", "/tmp/app");    // undefined
```

### `registerPiCantCommands`

Registers the `caamp pi cant` command group.

```typescript
(parent: Command) => void
```

**Parameters:**

- `parent` — The parent `pi` Command to attach the cant group to.

```bash
caamp pi cant list
caamp pi cant install ./my-profile.cant --scope user
caamp pi cant install owner/repo/path/profile.cant --scope global
caamp pi cant remove my-profile --scope user
caamp pi cant validate ./my-profile.cant
```

### `registerPiExtensionsCommands`

Registers the `caamp pi extensions` command group.

```typescript
(parent: Command) => void
```

**Parameters:**

- `parent` — The parent `pi` Command to attach the extensions group to.

```bash
caamp pi extensions list
caamp pi extensions install ./my-ext.ts --scope user
caamp pi extensions install owner/repo/path/ext.ts --scope global
caamp pi extensions remove my-ext --scope user
```

### `registerPiModelsCommands`

Registers the `caamp pi models` command group.

```typescript
(parent: Command) => void
```

**Parameters:**

- `parent` — The parent `pi` Command to attach the models group to.

```bash
caamp pi models list
caamp pi models add custom-provider:my-model --display-name "My Model"
caamp pi models enable anthropic:claude-opus-4-20250514
caamp pi models default anthropic:claude-sonnet-4-20250514
```

### `registerPiPromptsCommands`

Registers the `caamp pi prompts` command group.

```typescript
(parent: Command) => void
```

**Parameters:**

- `parent` — The parent `pi` Command to attach the prompts group to.

```bash
caamp pi prompts install ./prompts/my-prompt --scope user
caamp pi prompts list
caamp pi prompts remove my-prompt --scope user
```

### `registerPiSessionsCommands`

Registers the `caamp pi sessions` command group.

```typescript
(parent: Command) => void
```

**Parameters:**

- `parent` — The parent `pi` Command to attach the sessions group to.

```bash
caamp pi sessions list
caamp pi sessions show sess-abc123
caamp pi sessions export sess-abc123 --md --output session.md
caamp pi sessions resume sess-abc123
```

### `registerPiThemesCommands`

Registers the `caamp pi themes` command group.

```typescript
(parent: Command) => void
```

**Parameters:**

- `parent` — The parent `pi` Command to attach the themes group to.

```bash
caamp pi themes install ./themes/my-theme.json --scope user
caamp pi themes list
caamp pi themes remove my-theme --scope user
```

### `registerPiCommands`

Register the `pi` command group and all Wave-1 sub-verbs on the root program.

```typescript
(program: Command) => void
```

**Parameters:**

- `program` — The root Commander program to attach the `pi` group to.

```bash
caamp pi extensions list
caamp pi sessions list
caamp pi models list
caamp pi prompts list
caamp pi themes list
caamp pi cant list
```

### `resetHookMappings`

Reset the cached hook mappings data.

```typescript
() => void
```

```typescript
import { resetHookMappings, getHookMappingsVersion } from "./normalizer.js";

// Force a fresh load from disk
resetHookMappings();
const version = getHookMappingsVersion();
```

### `getCanonicalEvent`

Get the canonical event definition (category, description, canBlock).

```typescript
(event: CanonicalHookEvent) => CanonicalEventDefinition
```

**Parameters:**

- `event` — The canonical event name to look up.

**Returns:** The event definition containing category, description, and canBlock flag.

```typescript
import { getCanonicalEvent } from "./normalizer.js";

const def = getCanonicalEvent("PreToolUse");
console.log(def.category);  // "tool"
console.log(def.canBlock);  // true
```

### `getAllCanonicalEvents`

Get all canonical event definitions.

```typescript
() => Record<CanonicalHookEvent, CanonicalEventDefinition>
```

**Returns:** A record mapping every canonical event name to its definition.

```typescript
import { getAllCanonicalEvents } from "./normalizer.js";

const events = getAllCanonicalEvents();
for (const [name, def] of Object.entries(events)) {
  console.log(`${name}: ${def.description}`);
}
```

### `getCanonicalEventsByCategory`

Get canonical events filtered by category.

```typescript
(category: HookCategory) => CanonicalHookEvent[]
```

**Parameters:**

- `category` — The hook category to filter by (e.g. `"session"`, `"tool"`).

**Returns:** Array of canonical event names that belong to the specified category.

```typescript
import { getCanonicalEventsByCategory } from "./normalizer.js";

const toolEvents = getCanonicalEventsByCategory("tool");
// ["PreToolUse", "PostToolUse", "PostToolUseFailure"]
```

### `getProviderHookProfile`

Get the full hook profile for a provider.

```typescript
(providerId: string) => ProviderHookProfile | undefined
```

**Parameters:**

- `providerId` — The provider identifier (e.g. `"claude-code"`, `"gemini-cli"`).

**Returns:** The provider's hook profile, or `undefined` if not found.

```typescript
import { getProviderHookProfile } from "./normalizer.js";

const profile = getProviderHookProfile("claude-code");
if (profile) {
  console.log(profile.hookSystem); // "config"
  console.log(profile.experimental); // false
}
```

### `getMappedProviderIds`

Get all provider IDs that have hook mappings.

```typescript
() => string[]
```

**Returns:** Array of provider ID strings.

```typescript
import { getMappedProviderIds } from "./normalizer.js";

const ids = getMappedProviderIds();
// ["claude-code", "gemini-cli", "cursor", "kimi", ...]
```

### `toNative`

Translate a CAAMP canonical event name to the provider's native name.

```typescript
(canonical: CanonicalHookEvent, providerId: string) => string | null
```

**Parameters:**

- `canonical` — The CAAMP canonical event name to translate.
- `providerId` — The target provider identifier.

**Returns:** The native event name, or `null` if unsupported.

```typescript
import { toNative } from "./normalizer.js";

toNative("PreToolUse", "claude-code");   // "PreToolUse"
toNative("PreToolUse", "gemini-cli");    // "BeforeTool"
toNative("PreToolUse", "cursor");        // "preToolUse"
toNative("PreToolUse", "kimi");          // null
```

### `toCanonical`

Translate a provider-native event name to the CAAMP canonical name.

```typescript
(nativeName: string, providerId: string) => CanonicalHookEvent | null
```

**Parameters:**

- `nativeName` — The provider-native event name to look up.
- `providerId` — The provider identifier to search within.

**Returns:** The canonical event name, or `null` if no mapping exists.

```typescript
import { toCanonical } from "./normalizer.js";

toCanonical("BeforeTool", "gemini-cli");     // "PreToolUse"
toCanonical("stop", "cursor");               // "ResponseComplete"
toCanonical("UserPromptSubmit", "claude-code"); // "PromptSubmit"
```

### `toNativeBatch`

Batch-translate multiple canonical events to native names for a provider.

```typescript
(canonicals: CanonicalHookEvent[], providerId: string) => NormalizedHookEvent[]
```

**Parameters:**

- `canonicals` — Array of canonical event names to translate.
- `providerId` — The target provider identifier.

**Returns:** Array of normalized events (only supported ones included).

```typescript
import { toNativeBatch } from "./normalizer.js";

const events = toNativeBatch(
  ["PreToolUse", "PostToolUse", "ConfigChange"],
  "claude-code",
);
// Returns NormalizedHookEvent[] for supported events only
```

### `supportsHook`

Check if a provider supports a specific canonical hook event.

```typescript
(canonical: CanonicalHookEvent, providerId: string) => boolean
```

**Parameters:**

- `canonical` — The canonical event name to check.
- `providerId` — The provider identifier to check against.

**Returns:** `true` if the provider supports this canonical event, `false` otherwise.

```typescript
import { supportsHook } from "./normalizer.js";

supportsHook("PreToolUse", "claude-code"); // true
supportsHook("PreToolUse", "kimi");        // false
```

### `getHookSupport`

Get full hook support details for a canonical event on a provider.

```typescript
(canonical: CanonicalHookEvent, providerId: string) => HookSupportResult
```

**Parameters:**

- `canonical` — The canonical event name to query.
- `providerId` — The provider identifier to query against.

**Returns:** Support result including native name and optional notes.

```typescript
import { getHookSupport } from "./normalizer.js";

const result = getHookSupport("PreToolUse", "claude-code");
console.log(result.supported); // true
console.log(result.native);    // "PreToolUse"
```

### `getSupportedEvents`

Get all supported canonical events for a provider.

```typescript
(providerId: string) => CanonicalHookEvent[]
```

**Parameters:**

- `providerId` — The provider identifier to query.

**Returns:** Array of canonical event names the provider supports.

```typescript
import { getSupportedEvents } from "./normalizer.js";

const events = getSupportedEvents("claude-code");
// ["SessionStart", "SessionEnd", "PreToolUse", ...]
```

### `getUnsupportedEvents`

Get all unsupported canonical events for a provider.

```typescript
(providerId: string) => CanonicalHookEvent[]
```

**Parameters:**

- `providerId` — The provider identifier to query.

**Returns:** Array of canonical event names the provider does not support.

```typescript
import { getUnsupportedEvents } from "./normalizer.js";

const missing = getUnsupportedEvents("kimi");
// Returns all canonical events (kimi has no hook support)
```

### `getProvidersForEvent`

Get providers that support a specific canonical event.

```typescript
(canonical: CanonicalHookEvent) => string[]
```

**Parameters:**

- `canonical` — The canonical event name to search for.

**Returns:** Array of provider IDs that support this event.

```typescript
import { getProvidersForEvent } from "./normalizer.js";

const providers = getProvidersForEvent("PreToolUse");
// ["claude-code", "gemini-cli", "cursor"]
```

### `getCommonEvents`

Get canonical events common to all specified providers.

```typescript
(providerIds: string[]) => CanonicalHookEvent[]
```

**Parameters:**

- `providerIds` — Array of provider IDs to intersect.

**Returns:** Array of canonical events supported by all specified providers.

```typescript
import { getCommonEvents } from "./normalizer.js";

const common = getCommonEvents(["claude-code", "gemini-cli"]);
// Returns only events both providers support
```

### `getProviderSummary`

Get a summary of hook support for a provider.

```typescript
(providerId: string) => ProviderHookSummary | undefined
```

**Parameters:**

- `providerId` — The provider identifier to summarize.

**Returns:** The hook support summary, or `undefined` if the provider is not found.

```typescript
import { getProviderSummary } from "./normalizer.js";

const summary = getProviderSummary("claude-code");
if (summary) {
  console.log(`${summary.coverage}% coverage`);
  console.log(`${summary.supportedCount}/${summary.totalCanonical} events`);
}
```

### `buildHookMatrix`

Build a cross-provider hook support matrix.

```typescript
(providerIds?: string[]) => CrossProviderMatrix
```

**Parameters:**

- `providerIds` — Optional array of provider IDs to include. Defaults to all mapped providers.

**Returns:** The cross-provider matrix with events, providers, and mapping data.

```typescript
import { buildHookMatrix } from "./normalizer.js";

const matrix = buildHookMatrix(["claude-code", "gemini-cli"]);
for (const event of matrix.events) {
  for (const provider of matrix.providers) {
    console.log(`${event} @ ${provider}: ${matrix.matrix[event][provider].supported}`);
  }
}
```

### `getHookSystemType`

Get the hook system type for a provider.

```typescript
(providerId: string) => HookSystemType
```

**Parameters:**

- `providerId` — The provider identifier to query.

**Returns:** The hook system type (`"config"`, `"plugin"`, or `"none"`).

```typescript
import { getHookSystemType } from "./normalizer.js";

getHookSystemType("claude-code"); // "config"
getHookSystemType("unknown");     // "none"
```

### `getHookConfigPath`

Get the resolved hook config path for a provider.

```typescript
(providerId: string) => string | null
```

**Parameters:**

- `providerId` — The provider identifier to query.

**Returns:** The resolved filesystem path, or `null` if not available.

```typescript
import { getHookConfigPath } from "./normalizer.js";

const path = getHookConfigPath("claude-code");
// "/home/user/.claude/settings.json" (resolved from template)
```

### `getProviderOnlyEvents`

Get provider-only events (native events with no canonical mapping).

```typescript
(providerId: string) => string[]
```

**Parameters:**

- `providerId` — The provider identifier to query.

**Returns:** Array of native event names unique to this provider.

```typescript
import { getProviderOnlyEvents } from "./normalizer.js";

const extras = getProviderOnlyEvents("claude-code");
// Returns any events specific to Claude Code with no canonical equivalent
```

### `translateToAll`

Translate a canonical event to native names across multiple providers.

```typescript
(canonical: CanonicalHookEvent, providerIds: string[]) => Record<string, string>
```

**Parameters:**

- `canonical` — The canonical event name to translate.
- `providerIds` — Array of provider IDs to translate for.

**Returns:** Record mapping provider IDs to their native event names (supported only).

```typescript
import { translateToAll } from "./normalizer.js";

const result = translateToAll("PreToolUse", ["claude-code", "gemini-cli", "kimi"]);
// { "claude-code": "PreToolUse", "gemini-cli": "BeforeTool" }
// (kimi excluded — unsupported)
```

### `resolveNativeEvent`

Find the best canonical match for a native event name across all providers.

```typescript
(nativeName: string) => Array<{ providerId: string; canonical: CanonicalHookEvent; }>
```

**Parameters:**

- `nativeName` — The provider-native event name to resolve.

**Returns:** Array of matches, each containing the provider ID and canonical event name.

```typescript
import { resolveNativeEvent } from "./normalizer.js";

const matches = resolveNativeEvent("BeforeTool");
// [{ providerId: "gemini-cli", canonical: "PreToolUse" }]
```

### `getHookMappingsVersion`

Get the version of the hook mappings data.

```typescript
() => string
```

**Returns:** The semver version string of the loaded hook mappings data.

```typescript
import { getHookMappingsVersion } from "./normalizer.js";

const version = getHookMappingsVersion();
console.log(`Hook mappings v${version}`);
```

### `registerProvidersCommand`

Registers the `providers` command group with list, detect, show, skills-map, hooks, and capabilities subcommands.

```typescript
(program: Command) => void
```

**Parameters:**

- `program` — The root Commander program to attach the providers command group to

```bash
caamp providers list --tier high
caamp providers detect --project
caamp providers show claude-code
```

### `getRulesByCategory`

Get audit rules filtered by category.

```typescript
(category: string) => AuditRule[]
```

**Parameters:**

- `category` — Category name to filter by

**Returns:** Array of rules matching the given category

```typescript
const piRules = getRulesByCategory("prompt-injection");
console.log(`${piRules.length} prompt injection rules`);
```

### `getRulesBySeverity`

Get audit rules filtered by severity level.

```typescript
(severity: AuditSeverity) => AuditRule[]
```

**Parameters:**

- `severity` — Severity level to filter by

**Returns:** Array of rules matching the given severity

```typescript
const criticalRules = getRulesBySeverity("critical");
console.log(`${criticalRules.length} critical rules`);
```

### `getCategories`

Get all unique rule categories.

```typescript
() => string[]
```

**Returns:** Array of unique category name strings

```typescript
const categories = getCategories();
// ["prompt-injection", "command-injection", "data-exfiltration", ...]
```

### `scanFile`

Scan a single file against security audit rules.

```typescript
(filePath: string, rules?: AuditRule[]) => Promise<AuditResult>
```

**Parameters:**

- `filePath` — Absolute path to the file to scan
- `rules` — Custom rules to scan against (defaults to the built-in 46+ rules)

**Returns:** Audit result with findings, score, and pass/fail status

```typescript
const result = await scanFile("/path/to/SKILL.md");
console.log(`Score: ${result.score}/100, Passed: ${result.passed}`);
```

### `scanDirectory`

Scan a directory of skills for security issues.

```typescript
(dirPath: string) => Promise<AuditResult[]>
```

**Parameters:**

- `dirPath` — Absolute path to the skills directory to scan

**Returns:** Array of audit results, one per scanned SKILL.md

```typescript
import { getCanonicalSkillsDir } from "../../paths/standard.js";

const results = await scanDirectory(getCanonicalSkillsDir());
const failing = results.filter(r => !r.passed);
```

### `toSarif`

Convert audit results to SARIF 2.1.0 format (Static Analysis Results Interchange Format).

```typescript
(results: AuditResult[]) => object
```

**Parameters:**

- `results` — Array of audit results to convert

**Returns:** SARIF 2.1.0 JSON object

```typescript
const results = await scanDirectory("/path/to/skills");
const sarif = toSarif(results);
writeFileSync("audit.sarif", JSON.stringify(sarif, null, 2));
```

### `registerSkillsAudit`

Registers the `skills audit` subcommand for security scanning skill files.

```typescript
(parent: Command) => void
```

**Parameters:**

- `parent` — The parent `skills` Command to attach the audit subcommand to

```bash
caamp skills audit ./my-skill/SKILL.md
caamp skills audit ./skills-dir --sarif
```

### `recordSkillInstall`

Record a skill installation in the lock file.

```typescript
(skillName: string, scopedName: string, source: string, sourceType: SourceType, agents: string[], canonicalPath: string, isGlobal: boolean, projectDir?: string, version?: string) => Promise<void>
```

**Parameters:**

- `skillName` — Skill name
- `scopedName` — Scoped name (may include marketplace scope)
- `source` — Original source string
- `sourceType` — Classified source type
- `agents` — Provider IDs the skill was linked to
- `canonicalPath` — Absolute path to the canonical installation
- `isGlobal` — Whether this is a global installation
- `projectDir` — Project directory (for project-scoped installs)
- `version` — Version string or commit SHA

```typescript
import { getCanonicalSkillsDir } from "../paths/standard.js";
import { join } from "node:path";

await recordSkillInstall(
  "my-skill", "my-skill", "owner/repo", "github",
  ["claude-code"], join(getCanonicalSkillsDir(), "my-skill"), true,
);
```

### `removeSkillFromLock`

Remove a skill entry from the lock file.

```typescript
(skillName: string) => Promise<boolean>
```

**Parameters:**

- `skillName` — Name of the skill to remove

**Returns:** `true` if the entry was found and removed, `false` if not found

```typescript
const removed = await removeSkillFromLock("my-skill");
console.log(removed ? "Removed" : "Not found");
```

### `getTrackedSkills`

Get all skills tracked in the lock file.

```typescript
() => Promise<Record<string, LockEntry>>
```

**Returns:** Record of skill name to lock entry

```typescript
const skills = await getTrackedSkills();
for (const [name, entry] of Object.entries(skills)) {
  console.log(`${name}: ${entry.source}`);
}
```

### `checkSkillUpdate`

Check if a skill has updates available by comparing the installed version against the latest remote commit SHA.

```typescript
(skillName: string) => Promise<{ hasUpdate: boolean; currentVersion?: string; latestVersion?: string; status: "up-to-date" | "update-available" | "unknown"; }>
```

**Parameters:**

- `skillName` — Name of the installed skill to check

**Returns:** Object with update status, current version, and latest version

```typescript
const update = await checkSkillUpdate("my-skill");
if (update.hasUpdate) {
  console.log(`Update available: ${update.currentVersion} -> ${update.latestVersion}`);
}
```

### `checkAllSkillUpdates`

Check for updates across all tracked skills.

```typescript
() => Promise<Record<string, { hasUpdate: boolean; currentVersion?: string; latestVersion?: string; status: "up-to-date" | "update-available" | "unknown"; }>>
```

**Returns:** Object mapping skill names to their update status

```typescript
const updates = await checkAllSkillUpdates();
for (const [name, status] of Object.entries(updates)) {
  if (status.hasUpdate) {
    console.log(`${name}: ${status.currentVersion} -> ${status.latestVersion}`);
  }
}
```

### `registerSkillsCheck`

Registers the `skills check` subcommand for checking available skill updates.

```typescript
(parent: Command) => void
```

**Parameters:**

- `parent` — The parent `skills` Command to attach the check subcommand to

```bash
caamp skills check --human
caamp skills check --json
```

### `tokenizeCriteriaValue`

Splits a comma-separated criteria string into normalized tokens.

```typescript
(value: string) => string[]
```

**Parameters:**

- `value` — The comma-separated string to tokenize

**Returns:** An array of trimmed, lowercased, non-empty tokens

```typescript
const tokens = tokenizeCriteriaValue("React, TypeScript, svelte");
// returns ["react", "typescript", "svelte"]
```

### `validateRecommendationCriteria`

Validates recommendation criteria input for correctness and consistency.

```typescript
(input: RecommendationCriteriaInput) => RecommendationValidationResult
```

**Parameters:**

- `input` — The raw recommendation criteria to validate

**Returns:** A validation result indicating success or listing all issues

```typescript
const result = validateRecommendationCriteria({
  query: "gitbook",
  mustHave: "api",
  exclude: "legacy",
});
if (!result.valid) {
  console.error(result.issues);
}
```

### `normalizeRecommendationCriteria`

Normalizes raw recommendation criteria into a consistent tokenized form.

```typescript
(input: RecommendationCriteriaInput) => NormalizedRecommendationCriteria
```

**Parameters:**

- `input` — The raw recommendation criteria to normalize

**Returns:** Normalized criteria with tokenized, sorted, deduplicated terms

```typescript
const criteria = normalizeRecommendationCriteria({
  query: "GitBook API",
  mustHave: "sync, api",
  prefer: ["modern"],
});
// criteria.queryTokens => ["api", "gitbook"]
// criteria.mustHave => ["api", "sync"]
```

### `scoreSkillRecommendation`

Computes a recommendation score for a single skill against normalized criteria.

```typescript
(skill: MarketplaceResult, criteria: NormalizedRecommendationCriteria, options?: RecommendationOptions) => RankedSkillRecommendation
```

**Parameters:**

- `skill` — The marketplace skill result to score
- `criteria` — The normalized recommendation criteria to score against
- `options` — Optional scoring configuration including weights and markers

**Returns:** A ranked recommendation with score, reasons, and tradeoffs

```typescript
const criteria = normalizeRecommendationCriteria({ query: "gitbook" });
const ranked = scoreSkillRecommendation(marketplaceSkill, criteria, {
  includeDetails: true,
});
console.log(ranked.score, ranked.reasons);
```

### `recommendSkills`

Validates, normalizes, scores, and ranks a list of skills against criteria.

```typescript
(skills: MarketplaceResult[], criteriaInput: RecommendationCriteriaInput, options?: RecommendationOptions) => RecommendSkillsResult
```

**Parameters:**

- `skills` — The array of marketplace skill results to rank
- `criteriaInput` — The raw recommendation criteria from the user
- `options` — Optional configuration for scoring and result limiting

**Returns:** The normalized criteria and ranked skill recommendations

```typescript
const result = recommendSkills(
  marketplaceResults,
  { query: "gitbook", mustHave: "api", exclude: "legacy" },
  { top: 5, includeDetails: true },
);
for (const rec of result.ranking) {
  console.log(rec.skill.name, rec.score);
}
```

### `formatSkillRecommendations`

Format skill recommendation results for display or serialization.

```typescript
(result: RecommendSkillsResult, opts: { mode: "human" | "json"; details?: boolean; }) => string | Record<string, unknown>
```

**Parameters:**

- `result` — The recommendation result to format
- `opts` — Formatting options including output mode and detail level

**Returns:** Formatted string for human mode, or a structured object for JSON mode

```typescript
const result = await recommendSkills("testing", { taskType: "test-writing" });
const output = formatSkillRecommendations(result, { mode: "human" });
console.log(output);
```

### `searchSkills`

Search for skills via marketplace APIs.

```typescript
(query: string, options?: SearchSkillsOptions) => Promise<import("/mnt/projects/cleocode/.claude/worktrees/agent-aea50da0/packages/caamp/src/index").MarketplaceResult[]>
```

**Parameters:**

- `query` — Search query string (must be non-empty)
- `options` — Search options including result limit

**Returns:** Array of marketplace skill entries matching the query

```typescript
const results = await searchSkills("test runner", { limit: 10 });
console.log(`Found ${results.length} skills`);
```

### `recommendSkills`

Search and rank skills based on query and recommendation criteria.

```typescript
(query: string, criteria: Omit<RecommendationCriteriaInput, "query">, options?: RecommendSkillsQueryOptions) => Promise<RecommendSkillsResult>
```

**Parameters:**

- `query` — Search query string
- `criteria` — Recommendation criteria (task type, context, preferences)
- `options` — Options for limiting and tuning results

**Returns:** Ranked recommendation results with scores and reasons

```typescript
const result = await recommendSkills("testing", { taskType: "test-writing" });
const best = result.ranking[0];
console.log(`Top pick: ${best.skill.scopedName} (score: ${best.score})`);
```

### `registerSkillsFind`

Registers the `skills find` subcommand for searching marketplaces and recommending skills.

```typescript
(parent: Command) => void
```

**Parameters:**

- `parent` — The parent `skills` Command to attach the find subcommand to

```bash
caamp skills find "testing framework"
caamp skills find --recommend --must-have typescript --prefer vitest
```

### `registerSkillsInit`

Registers the `skills init` subcommand for scaffolding new SKILL.md templates.

```typescript
(parent: Command) => void
```

**Parameters:**

- `parent` — The parent `skills` Command to attach the init subcommand to

```bash
caamp skills init my-skill
caamp skills init --dir ./skills/new-skill
```

### `loadLibraryFromModule`

Load a SkillLibrary from a module (index.js) at the given root directory.

```typescript
(root: string) => SkillLibrary
```

**Parameters:**

- `root` — Absolute path to the library root (must contain index.js or package.json with main)

**Returns:** A validated SkillLibrary instance

```typescript
const library = loadLibraryFromModule("/home/user/.agents/libraries/cleocode-skills");
console.log(`Loaded v${library.version} with ${library.listSkills().length} skills`);
```

### `buildLibraryFromFiles`

Build a SkillLibrary from raw files in a directory.

```typescript
(root: string) => SkillLibrary
```

**Parameters:**

- `root` — Absolute path to the library root directory

**Returns:** A SkillLibrary instance backed by filesystem reads

```typescript
const library = buildLibraryFromFiles("/home/user/.agents/libraries/cleocode-skills");
const coreSkills = library.getCoreSkills();
console.log(`Core skills: ${coreSkills.map(s => s.name).join(", ")}`);
```

### `registerSkillLibrary`

Registers a SkillLibrary instance directly as the active catalog.

```typescript
(library: SkillLibrary) => void
```

**Parameters:**

- `library` — A SkillLibrary implementation to use as the catalog

```typescript
const library = buildLibraryFromFiles("/path/to/skills");
registerSkillLibrary(library);
```

### `registerSkillLibraryFromPath`

Registers a skill library by loading it from a directory path.

```typescript
(root: string) => void
```

**Parameters:**

- `root` — Absolute path to the skill library root directory

```typescript
registerSkillLibraryFromPath("/home/user/.agents/skill-library");
const skills = listSkills();
```

### `clearRegisteredLibrary`

Clears the registered skill library instance.

```typescript
() => void
```

```typescript
clearRegisteredLibrary();
// isCatalogAvailable() will now return false unless auto-discovery succeeds
```

### `isCatalogAvailable`

Checks whether a skill library is available for use.

```typescript
() => boolean
```

**Returns:** True if a skill library is registered or discoverable, false otherwise

```typescript
if (isCatalogAvailable()) {
  const skills = listSkills();
}
```

### `getSkills`

Returns all skill entries from the catalog.

```typescript
() => SkillLibraryEntry[]
```

**Returns:** An array of all skill library entries

```typescript
const allSkills = getSkills();
console.log(`Found ${allSkills.length} skills`);
```

### `getManifest`

Returns the parsed skill library manifest.

```typescript
() => SkillLibraryManifest
```

**Returns:** The skill library manifest object

```typescript
const manifest = getManifest();
console.log(manifest.version);
```

### `listSkills`

Lists all available skill names in the catalog.

```typescript
() => string[]
```

**Returns:** An array of skill name strings

```typescript
const names = listSkills();
// e.g., ["ct-orchestrator", "ct-dev-workflow", "ct-validator"]
```

### `getSkill`

Gets skill metadata by name from the catalog.

```typescript
(name: string) => SkillLibraryEntry | undefined
```

**Parameters:**

- `name` — The unique skill name to look up

**Returns:** The skill entry if found, or undefined

```typescript
const skill = getSkill("ct-orchestrator");
if (skill) {
  console.log(skill.category);
}
```

### `getSkillPath`

Resolves the absolute path to a skill's SKILL.md file.

```typescript
(name: string) => string
```

**Parameters:**

- `name` — The unique skill name to resolve

**Returns:** The absolute path to the skill's SKILL.md file

```typescript
const path = getSkillPath("ct-orchestrator");
// e.g., "/home/user/.agents/skill-library/skills/ct-orchestrator/SKILL.md"
```

### `getSkillDir`

Resolves the absolute path to a skill's directory.

```typescript
(name: string) => string
```

**Parameters:**

- `name` — The unique skill name to resolve

**Returns:** The absolute path to the skill's directory

```typescript
const dir = getSkillDir("ct-orchestrator");
// e.g., "/home/user/.agents/skill-library/skills/ct-orchestrator"
```

### `readSkillContent`

Reads a skill's SKILL.md content as a string.

```typescript
(name: string) => string
```

**Parameters:**

- `name` — The unique skill name to read

**Returns:** The full text content of the skill's SKILL.md file

```typescript
const content = readSkillContent("ct-orchestrator");
console.log(content.substring(0, 100));
```

### `getCoreSkills`

Returns all skills marked as core in the catalog.

```typescript
() => SkillLibraryEntry[]
```

**Returns:** An array of core skill entries

```typescript
const coreSkills = getCoreSkills();
console.log(`${coreSkills.length} core skills available`);
```

### `getSkillsByCategory`

Returns skills filtered by category.

```typescript
(category: SkillLibraryEntry["category"]) => SkillLibraryEntry[]
```

**Parameters:**

- `category` — The category to filter by

**Returns:** An array of skill entries in the specified category

```typescript
const planningSkills = getSkillsByCategory("planning");
```

### `getSkillDependencies`

Gets the direct dependency names for a skill.

```typescript
(name: string) => string[]
```

**Parameters:**

- `name` — The unique skill name to query dependencies for

**Returns:** An array of direct dependency skill names

```typescript
const deps = getSkillDependencies("ct-task-executor");
// e.g., ["ct-orchestrator"]
```

### `resolveDependencyTree`

Resolves the full dependency tree for a set of skill names.

```typescript
(names: string[]) => string[]
```

**Parameters:**

- `names` — The skill names to resolve dependencies for

**Returns:** A deduplicated array of all required skill names including transitive dependencies

```typescript
const allDeps = resolveDependencyTree(["ct-task-executor", "ct-validator"]);
// includes all transitive dependencies
```

### `listProfiles`

Lists all available profile names in the catalog.

```typescript
() => string[]
```

**Returns:** An array of profile name strings

```typescript
const profiles = listProfiles();
// e.g., ["default", "minimal", "full"]
```

### `getProfile`

Gets a profile definition by name from the catalog.

```typescript
(name: string) => SkillLibraryProfile | undefined
```

**Parameters:**

- `name` — The unique profile name to look up

**Returns:** The profile definition if found, or undefined

```typescript
const profile = getProfile("default");
if (profile) {
  console.log(profile.skills);
}
```

### `resolveProfile`

Resolves a profile to its full skill list including inherited skills.

```typescript
(name: string) => string[]
```

**Parameters:**

- `name` — The profile name to resolve

**Returns:** A deduplicated array of all skill names required by the profile

```typescript
const skills = resolveProfile("default");
// includes all skills from extended profiles and their dependencies
```

### `listSharedResources`

Lists all available shared resource names in the catalog.

```typescript
() => string[]
```

**Returns:** An array of shared resource name strings

```typescript
const resources = listSharedResources();
// e.g., ["testing-framework-config.md", "error-handling.md"]
```

### `getSharedResourcePath`

Gets the absolute path to a shared resource file.

```typescript
(name: string) => string | undefined
```

**Parameters:**

- `name` — The shared resource name to resolve

**Returns:** The absolute path to the resource file, or undefined if not found

```typescript
const path = getSharedResourcePath("testing-framework-config.md");
```

### `readSharedResource`

Reads a shared resource file's content as a string.

```typescript
(name: string) => string | undefined
```

**Parameters:**

- `name` — The shared resource name to read

**Returns:** The text content of the resource, or undefined if not found

```typescript
const content = readSharedResource("testing-framework-config.md");
if (content) {
  console.log(content);
}
```

### `listProtocols`

Lists all available protocol names in the catalog.

```typescript
() => string[]
```

**Returns:** An array of protocol name strings

```typescript
const protocols = listProtocols();
// e.g., ["research", "implementation", "contribution"]
```

### `getProtocolPath`

Gets the absolute path to a protocol file.

```typescript
(name: string) => string | undefined
```

**Parameters:**

- `name` — The protocol name to resolve

**Returns:** The absolute path to the protocol file, or undefined if not found

```typescript
const path = getProtocolPath("research");
```

### `readProtocol`

Reads a protocol file's content as a string.

```typescript
(name: string) => string | undefined
```

**Parameters:**

- `name` — The protocol name to read

**Returns:** The text content of the protocol, or undefined if not found

```typescript
const content = readProtocol("research");
if (content) {
  console.log(content);
}
```

### `validateSkillFrontmatter`

Validates a single skill's frontmatter against the schema.

```typescript
(name: string) => SkillLibraryValidationResult
```

**Parameters:**

- `name` — The skill name to validate

**Returns:** A validation result indicating success or listing errors

```typescript
const result = validateSkillFrontmatter("ct-orchestrator");
if (!result.valid) {
  console.error(result.errors);
}
```

### `validateAll`

Validates all skills in the catalog and returns results per skill.

```typescript
() => Map<string, SkillLibraryValidationResult>
```

**Returns:** A map of skill names to their validation results

```typescript
const results = validateAll();
for (const [name, result] of results) {
  if (!result.valid) console.error(`${name}: invalid`);
}
```

### `getDispatchMatrix`

Gets the dispatch matrix from the skill library manifest.

```typescript
() => SkillLibraryDispatchMatrix
```

**Returns:** The dispatch matrix object from the manifest

```typescript
const matrix = getDispatchMatrix();
console.log(matrix);
```

### `getVersion`

Returns the skill library version string.

```typescript
() => string
```

**Returns:** The library version string

```typescript
const version = getVersion();
// e.g., "1.0.0"
```

### `getLibraryRoot`

Returns the absolute path to the skill library root directory.

```typescript
() => string
```

**Returns:** The absolute path to the library root

```typescript
const root = getLibraryRoot();
// e.g., "/home/user/.agents/skill-library"
```

### `parseSkillFile`

Parse a SKILL.md file and extract its frontmatter metadata.

```typescript
(filePath: string) => Promise<SkillMetadata | null>
```

**Parameters:**

- `filePath` — Absolute path to the SKILL.md file

**Returns:** Parsed metadata, or `null` if invalid

```typescript
const meta = await parseSkillFile("/path/to/SKILL.md");
if (meta) {
  console.log(`${meta.name}: ${meta.description}`);
}
```

### `discoverSkill`

Discover a single skill at a given directory path.

```typescript
(skillDir: string) => Promise<SkillEntry | null>
```

**Parameters:**

- `skillDir` — Absolute path to a skill directory (containing SKILL.md)

**Returns:** Skill entry with metadata, or `null` if no valid SKILL.md exists

```typescript
import { getCanonicalSkillsDir } from "../paths/standard.js";
import { join } from "node:path";

const skill = await discoverSkill(join(getCanonicalSkillsDir(), "my-skill"));
if (skill) {
  console.log(`Found: ${skill.name}`);
}
```

### `discoverSkills`

Scan a directory for skill subdirectories, each containing a SKILL.md file.

```typescript
(rootDir: string) => Promise<SkillEntry[]>
```

**Parameters:**

- `rootDir` — Absolute path to a skills root directory to scan

**Returns:** Array of discovered skill entries

```typescript
import { getCanonicalSkillsDir } from "../paths/standard.js";

const skills = await discoverSkills(getCanonicalSkillsDir());
console.log(`Found ${skills.length} skills`);
```

### `discoverSkillsMulti`

Discover skills across multiple directories.

```typescript
(dirs: string[]) => Promise<SkillEntry[]>
```

**Parameters:**

- `dirs` — Array of absolute paths to skills directories to scan

**Returns:** Deduplicated array of discovered skill entries

```typescript
const skills = await discoverSkillsMulti(["/home/user/.agents/skills", "./project-skills"]);
console.log(`Found ${skills.length} unique skills`);
```

### `registerSkillsInstall`

Registers the `skills install` subcommand for installing skills from various sources.

```typescript
(parent: Command) => void
```

**Parameters:**

- `parent` — The parent `skills` Command to attach the install subcommand to

```bash
caamp skills install owner/repo
caamp skills install @author/skill-name --agent claude-code
caamp skills install --profile recommended --all
```

### `registerSkillsList`

Registers the `skills list` subcommand for listing installed skills.

```typescript
(parent: Command) => void
```

**Parameters:**

- `parent` — The parent `skills` Command to attach the list subcommand to

```bash
caamp skills list --human
caamp skills list --agent claude-code --global
```

### `registerSkillsRemove`

Registers the `skills remove` subcommand for removing installed skills.

```typescript
(parent: Command) => void
```

**Parameters:**

- `parent` — The parent `skills` Command to attach the remove subcommand to

```bash
caamp skills remove my-skill
caamp skills remove --yes
```

### `registerSkillsUpdate`

Registers the `skills update` subcommand for updating all outdated skills.

```typescript
(parent: Command) => void
```

**Parameters:**

- `parent` — The parent `skills` Command to attach the update subcommand to

```bash
caamp skills update --yes
caamp skills update --json
```

### `validateSkill`

Validate a SKILL.md file against the Agent Skills standard.

```typescript
(filePath: string) => Promise<ValidationResult>
```

**Parameters:**

- `filePath` — Absolute path to the SKILL.md file to validate

**Returns:** Validation result with issues and parsed metadata

```typescript
const result = await validateSkill("/path/to/SKILL.md");
console.log(result.valid ? "Valid" : `${result.issues.length} issues found`);
```

### `registerSkillsValidate`

Registers the `skills validate` subcommand for validating SKILL.md file format.

```typescript
(parent: Command) => void
```

**Parameters:**

- `parent` — The parent `skills` Command to attach the validate subcommand to

```bash
caamp skills validate ./my-skill/SKILL.md
caamp skills validate --json
```

### `registerSkillsCommands`

Registers the `skills` command group with all skill management subcommands.

```typescript
(program: Command) => void
```

**Parameters:**

- `program` — The root Commander program to attach the skills command group to

```bash
caamp skills install owner/repo
caamp skills list --human
caamp skills find "testing"
```

### `isCaampOwnedSkill`

Check whether a skill name is reserved by CAAMP (ct-* prefix).

```typescript
(skillName: string) => boolean
```

**Parameters:**

- `skillName` — Skill name to check

**Returns:** `true` if the skill name starts with `ct-`

```typescript
isCaampOwnedSkill("ct-research-agent"); // true
isCaampOwnedSkill("my-custom-skill");   // false
```

### `checkSkillIntegrity`

Check the integrity of a single installed skill.

```typescript
(skillName: string, providers: Provider[], scope?: "global" | "project", projectDir?: string) => Promise<SkillIntegrityResult>
```

**Parameters:**

- `skillName` — Name of the skill to check
- `providers` — Providers to check symlinks for
- `scope` — Whether to check global or project links
- `projectDir` — Project directory (for project scope)

**Returns:** Integrity check result

```typescript
const result = await checkSkillIntegrity("ct-research-agent", providers, "global");
if (result.status !== "intact") {
  console.log(`Issue: ${result.issue}`);
}
```

### `checkAllSkillIntegrity`

Check integrity of all tracked skills.

```typescript
(providers: Provider[], scope?: "global" | "project", projectDir?: string) => Promise<Map<string, SkillIntegrityResult>>
```

**Parameters:**

- `providers` — Providers to check symlinks for
- `scope` — Whether to check global or project links
- `projectDir` — Project directory (for project scope)

**Returns:** Map of skill name to integrity result

```typescript
const results = await checkAllSkillIntegrity(providers);
for (const [name, result] of results) {
  console.log(`${name}: ${result.status}`);
}
```

### `shouldOverrideSkill`

Resolve a skill name conflict where a user-installed skill collides with a CAAMP-owned (ct-*) skill.

```typescript
(skillName: string, incomingSource: string, existingEntry: LockEntry | undefined) => boolean
```

**Parameters:**

- `skillName` — Skill name to check
- `incomingSource` — Source of the incoming skill installation
- `existingEntry` — Existing lock entry, if any

**Returns:** `true` if the incoming installation should proceed

```typescript
const proceed = shouldOverrideSkill("ct-research-agent", "library", existingEntry);
if (proceed) {
  // Safe to install/override
}
```

### `validateInstructionIntegrity`

Validate instruction file injection status across all providers.

```typescript
(providers: Provider[], projectDir: string, scope: "project" | "global", expectedContent?: string) => Promise<Array<{ file: string; providerId: string; issue: string; }>>
```

**Parameters:**

- `providers` — Providers to check
- `projectDir` — Project directory
- `scope` — Whether to check global or project files
- `expectedContent` — Expected CAAMP block content

**Returns:** Array of file paths with issues

```typescript
const issues = await validateInstructionIntegrity(providers, process.cwd(), "project");
for (const issue of issues) {
  console.log(`${issue.providerId}: ${issue.issue} (${issue.file})`);
}
```

### `resolveCantImports`

Resolve `@import *.cant` references in instruction file content.

```typescript
(content: string, projectRoot: string) => ResolvedImports
```

**Parameters:**

- `content` — Raw instruction file content
- `projectRoot` — Absolute path to the project root directory

**Returns:** Resolved content, imported file list, and any errors

```typescript
const result = resolveCantImports(
  '@import .cleo/agents/core-agent.cant',
  '/home/user/project',
);
console.log(result.resolvedContent);
// ## Agent: core-agent
// - **Model**: opus
// ...
```

### `cantToMarkdown`

Convert a `.cant` file's content to markdown equivalent.

```typescript
(cantContent: string) => string
```

**Parameters:**

- `cantContent` — Raw `.cant` file content

**Returns:** Markdown representation of the `.cant` definitions

```typescript
const md = cantToMarkdown(`---
kind: agent
version: 1
---

agent ops-lead:
  model: opus
  prompt: "Coordinate operations"
`);
// Returns markdown with ## Agent: ops-lead heading
```

### `discoverWellKnown`

Discover skills from a well-known URL.

```typescript
(domain: string) => Promise<WellKnownSkill[]>
```

**Parameters:**

- `domain` — Domain name to query (e.g. `"example.com"`)

**Returns:** Array of discovered skill entries

```typescript
const skills = await discoverWellKnown("example.com");
for (const skill of skills) {
  console.log(`${skill.name}: ${skill.url}`);
}
```

## Types

### `SkillLibraryEntry`

A single skill entry in a library catalog.

```typescript
SkillLibraryEntry
```

**Members:**

- `name` — Skill name (e.g. `"ct-research-agent"`).
- `description` — Human-readable description.
- `version` — Semantic version string.
- `path` — Relative path within the skills library.
- `references` — File references used by the skill.
- `core` — Whether this is a core skill.
- `category` — Skill category tier.
- `tier` — Numeric tier (0-3).
- `protocol` — Associated protocol name, or `null`.
- `dependencies` — Direct dependency skill names.
- `sharedResources` — Shared resource names this skill uses.
- `compatibility` — Compatible agent/context types.
- `license` — SPDX license identifier.
- `metadata` — Arbitrary metadata.

### `SkillLibraryValidationResult`

Validation result from skill frontmatter validation.

```typescript
SkillLibraryValidationResult
```

**Members:**

- `valid` — Whether the skill passed validation (no error-level issues).
- `issues` — Individual validation issues.

### `SkillLibraryValidationIssue`

A single validation issue.

```typescript
SkillLibraryValidationIssue
```

**Members:**

- `level` — Severity level.
- `field` — Field that triggered the issue.
- `message` — Human-readable message.

### `SkillLibraryProfile`

Profile definition for grouped skill installation.

```typescript
SkillLibraryProfile
```

**Members:**

- `name` — Profile name (e.g. `"minimal"`, `"core"`, `"recommended"`, `"full"`).
- `description` — Human-readable description.
- `extends` — Name of parent profile to extend.
- `skills` — Skill names included in this profile.
- `includeShared` — Whether to include _shared resources.
- `includeProtocols` — Protocol names to include.

### `SkillLibraryDispatchMatrix`

Dispatch matrix for task routing to skills.

```typescript
SkillLibraryDispatchMatrix
```

**Members:**

- `by_task_type` — Task type to skill mapping.
- `by_keyword` — Keyword to skill mapping.
- `by_protocol` — Protocol to skill mapping.

### `SkillLibraryManifestSkill`

Skill entry within the library manifest.

```typescript
SkillLibraryManifestSkill
```

**Members:**

- `name` — Skill name.
- `version` — Version.
- `description` — Description.
- `path` — Path within library.
- `tags` — Tags.
- `status` — Status.
- `tier` — Tier.
- `token_budget` — Token budget.
- `references` — References.
- `capabilities` — Capabilities.
- `constraints` — Constraints.

### `SkillLibraryManifest`

Full manifest structure for a skill library.

```typescript
SkillLibraryManifest
```

**Members:**

- `$schema` — JSON schema reference.
- `_meta` — Metadata.
- `dispatch_matrix` — Dispatch matrix for skill routing.
- `skills` — Manifest skill entries.

### `SkillLibrary`

Standard interface for a skill library.  Any directory or module providing skills must implement this contract. CAAMP uses it to discover, resolve, and install skills from any source.

```typescript
SkillLibrary
```

**Members:**

- `version` — Library version string.
- `libraryRoot` — Absolute path to the library root directory.
- `skills` — All skill entries in the catalog.
- `manifest` — The parsed manifest.
- `listSkills` — List all skill names.
- `getSkill` — Get skill metadata by name.
- `getSkillPath` — Resolve absolute path to a skill's SKILL.md file.
- `getSkillDir` — Resolve absolute path to a skill's directory.
- `readSkillContent` — Read a skill's SKILL.md content as a string.
- `getCoreSkills` — Get all skills where `core === true`.
- `getSkillsByCategory` — Get skills filtered by category.
- `getSkillDependencies` — Get direct dependency names for a skill.
- `resolveDependencyTree` — Resolve full dependency tree for a set of skill names (includes transitive deps).
- `listProfiles` — List available profile names.
- `getProfile` — Get a profile definition by name.
- `resolveProfile` — Resolve a profile to its full skill list (follows extends, resolves deps).
- `listSharedResources` — List available shared resource names.
- `getSharedResourcePath` — Get absolute path to a shared resource file.
- `readSharedResource` — Read a shared resource file content.
- `listProtocols` — List available protocol names.
- `getProtocolPath` — Get absolute path to a protocol file.
- `readProtocol` — Read a protocol file content.
- `validateSkillFrontmatter` — Validate a single skill's frontmatter.
- `validateAll` — Validate all skills.
- `getDispatchMatrix` — Get the dispatch matrix from the manifest.

### `RegistryDetection`

Raw detection configuration as stored in registry.json.

```typescript
RegistryDetection
```

**Members:**

- `methods` — Detection methods to try, in order (e.g. `["binary", "directory"]`).
- `binary` — Binary name to look up on PATH (for the `"binary"` method).
- `directories` — Directories to check for existence (for the `"directory"` method).
- `appBundle` — macOS .app bundle name (for the `"appBundle"` method).
- `flatpakId` — Flatpak application ID (for the `"flatpak"` method).

### `ProviderPriority`

Priority tier identifier stored in registry.json.

```typescript
ProviderPriority
```

### `ProviderStatus`

Lifecycle status identifier stored in registry.json.

```typescript
ProviderStatus
```

### `RegistryProvider`

Raw provider definition as stored in registry.json before path resolution.

```typescript
RegistryProvider
```

**Members:**

- `id` — Unique provider identifier (e.g. `"claude-code"`).
- `toolName` — Human-readable tool name (e.g. `"Claude Code"`).
- `vendor` — Vendor/company name (e.g. `"Anthropic"`).
- `agentFlag` — CLI flag name for `--agent` selection.
- `aliases` — Alternative names that resolve to this provider.
- `pathGlobal` — Global instruction file directory path (may contain platform variables).
- `pathProject` — Project-relative instruction file directory path.
- `instructFile` — Instruction file name (e.g. `"CLAUDE.md"`, `"AGENTS.md"`).
- `pathSkills` — Global skills directory path (may contain platform variables).
- `pathProjectSkills` — Project-relative skills directory path.
- `detection` — Detection configuration for auto-discovering this provider.
- `priority` — Priority tier identifier. Exactly zero or one provider should be `"primary"`.
- `status` — Lifecycle status identifier.
- `agentSkillsCompatible` — Whether the provider is compatible with the Agent Skills standard.
- `capabilities` — Optional provider capabilities for MCP, harness role, skills, hooks, and spawn.

### `McpConfigFormat`

Supported MCP config file formats.

```typescript
McpConfigFormat
```

### `McpTransportType`

MCP transport protocols a provider may advertise.

```typescript
McpTransportType
```

### `RegistryMcpIntegration`

MCP server integration metadata for providers that consume MCP servers via a per-agent config file.

```typescript
RegistryMcpIntegration
```

**Members:**

- `configKey` — Dot-notation key path for MCP server config (e.g. `"mcpServers"`).
- `configFormat` — Config file format identifier.
- `configPathGlobal` — Global config file path (may contain platform variables).
- `configPathProject` — Project-relative config file path, or `null` if unsupported.
- `supportedTransports` — MCP transport protocol identifiers this provider supports.
- `supportsHeaders` — Whether the provider supports custom HTTP headers for remote MCP servers.

### `RegistryHarnessKind`

Harness role category for a primary or standalone harness.

```typescript
RegistryHarnessKind
```

### `RegistryHarnessCapability`

First-class harness role declaration.

```typescript
RegistryHarnessCapability
```

**Members:**

- `kind` — The harness kind (`"orchestrator"` or `"standalone"`).
- `spawnTargets` — Provider ids this harness can spawn as subagents. Empty for standalone.
- `supportsConductorLoop` — Whether the harness drives a CleoOS conductor loop.
- `supportsStageGuidance` — Whether the harness accepts stage guidance injection.
- `supportsCantBridge` — Whether the harness bridges CANT events.
- `extensionsPath` — Path to the harness's runtime extensions directory (file paths, not a config file).
- `globalExtensionsHub` — Optional CLEO-managed shared extensions hub.

### `SkillsPrecedence`

How a provider resolves skill file precedence between vendor and agents directories.

```typescript
SkillsPrecedence
```

### `RegistrySkillsCapability`

Raw skills capability definition as stored in registry.json.

```typescript
RegistrySkillsCapability
```

**Members:**

- `agentsGlobalPath` — Resolved global `.agents/skills` path, or `null` if unsupported.
- `agentsProjectPath` — Project-relative `.agents/skills` path, or `null` if unsupported.
- `precedence` — How this provider resolves skill file precedence.

### `HookEvent`

Hook lifecycle event identifier from registry.json.

```typescript
string
```

### `RegistryHookFormat`

The on-disk layout of a provider's hook configuration.

```typescript
RegistryHookFormat
```

### `RegistryHookCatalog`

Which native event catalog a provider's hook system uses.

```typescript
RegistryHookCatalog
```

### `RegistryHooksCapability`

Raw hooks capability definition as stored in registry.json.

```typescript
RegistryHooksCapability
```

**Members:**

- `supported` — Hook lifecycle event identifiers this provider supports.
- `hookConfigPath` — Path to the hook configuration file or directory, or `null` if not applicable.
- `hookConfigPathProject` — Project-relative path to the hook configuration file or directory.
- `hookFormat` — Format of the hook config, or `null` when the provider has no hook system.
- `nativeEventCatalog` — Which native event catalog this provider's hooks are drawn from. Defaults to `"canonical"` when omitted.
- `canInjectSystemPrompt` — Whether hooks may inject or modify the system prompt.
- `canBlockTools` — Whether hooks may block tool calls.

### `SpawnMechanism`

Mechanism a provider uses to spawn subagents.

```typescript
SpawnMechanism
```

### `RegistrySpawnCapability`

Raw spawn capability definition as stored in registry.json.

```typescript
RegistrySpawnCapability
```

**Members:**

- `supportsSubagents` — Whether the provider supports spawning subagents.
- `supportsProgrammaticSpawn` — Whether subagents can be spawned programmatically.
- `supportsInterAgentComms` — Whether spawned agents can communicate with each other.
- `supportsParallelSpawn` — Whether multiple agents can be spawned in parallel.
- `spawnMechanism` — Mechanism used for spawning, or `null` if spawning is unsupported.
- `spawnCommand` — Literal command-line invocation used by the harness to spawn a child worker (e.g. Pi's `["pi", "--mode", "json", "-p", "--no-session"]`). Only meaningful when `spawnMechanism === "native-child-process"`.

### `RegistryCapabilities`

Aggregate capability block for a provider in registry.json.

```typescript
RegistryCapabilities
```

**Members:**

- `mcp` — MCP server integration metadata. Omitted for providers (like Pi) that do not consume MCP servers via a config file.
- `harness` — First-class harness role. Present only for orchestrators or standalone harnesses, not for pure spawn targets.
- `skills` — Skills path resolution and precedence capabilities.
- `hooks` — Hook/lifecycle event capabilities.
- `spawn` — Subagent spawn capabilities.

### `ProviderRegistry`

Top-level structure of the provider registry JSON file.

```typescript
ProviderRegistry
```

**Members:**

- `version` — Schema version of the registry file.
- `lastUpdated` — ISO 8601 timestamp of the last registry update.
- `providers` — Provider definitions keyed by provider ID.

### `CtSkillEntry`

Backward-compatible alias for `SkillLibraryEntry`.

```typescript
SkillLibraryEntry
```

### `CtValidationResult`

Backward-compatible alias for `SkillLibraryValidationResult`.

```typescript
SkillLibraryValidationResult
```

### `CtValidationIssue`

Backward-compatible alias for `SkillLibraryValidationIssue`.

```typescript
SkillLibraryValidationIssue
```

### `CtProfileDefinition`

Backward-compatible alias for `SkillLibraryProfile`.

```typescript
SkillLibraryProfile
```

### `CtDispatchMatrix`

Backward-compatible alias for `SkillLibraryDispatchMatrix`.

```typescript
SkillLibraryDispatchMatrix
```

### `CtManifest`

Backward-compatible alias for `SkillLibraryManifest`.

```typescript
SkillLibraryManifest
```

### `CtManifestSkill`

Backward-compatible alias for `SkillLibraryManifestSkill`.

```typescript
SkillLibraryManifestSkill
```

### `ConfigFormat`

Supported configuration file formats.  - `"json"` - Standard JSON - `"jsonc"` - JSON with comments (comment-preserving via jsonc-parser) - `"yaml"` - YAML (via js-yaml) - `"toml"` - TOML (via iarna/toml)

```typescript
ConfigFormat
```

```typescript
const format: ConfigFormat = "jsonc";
```

### `TransportType`

MCP server transport protocol type.  - `"stdio"` - Standard input/output (local process) - `"sse"` - Server-Sent Events (remote) - `"http"` - HTTP/Streamable HTTP (remote) - `"websocket"` - WebSocket full-duplex (remote)

```typescript
TransportType
```

```typescript
const transport: TransportType = "stdio";
```

### `DetectionMethod`

Method used to detect whether an AI agent is installed on the system.  - `"binary"` - Check if a CLI binary exists on PATH - `"directory"` - Check if known config/data directories exist - `"appBundle"` - Check for macOS .app bundle in standard app directories - `"flatpak"` - Check for Flatpak installation on Linux

```typescript
DetectionMethod
```

### `DetectionConfig`

Configuration for detecting whether a provider is installed.

```typescript
DetectionConfig
```

**Members:**

- `methods` — Detection methods to try, in order.
- `binary` — Binary name to look up on PATH (for `"binary"` method).
- `directories` — Directories to check for existence (for `"directory"` method).
- `appBundle` — macOS .app bundle name (for `"appBundle"` method).
- `flatpakId` — Flatpak application ID (for `"flatpak"` method).

```typescript
const config: DetectionConfig = {
  methods: ["binary", "directory"],
  binary: "claude",
  directories: ["~/.config/claude"],
};
```

### `ProviderMcpCapability`

Resolved MCP server integration metadata for a provider.

```typescript
ProviderMcpCapability
```

**Members:**

- `configKey` — Dot-notation key path for MCP server config (e.g. `"mcpServers"`).
- `configFormat` — Resolved config file format.
- `configPathGlobal` — Resolved global config file path.
- `configPathProject` — Project-relative config file path, or `null` if unsupported.
- `supportedTransports` — MCP transport protocols this provider supports.
- `supportsHeaders` — Whether the provider supports custom HTTP headers for remote MCP servers.

### `ProviderHarnessCapability`

Resolved first-class harness capability for a provider.

```typescript
ProviderHarnessCapability
```

**Members:**

- `kind` — Harness kind (`"orchestrator"` or `"standalone"`).
- `spawnTargets` — Provider ids this harness can spawn as subagents. Empty for standalone.
- `supportsConductorLoop` — Whether the harness drives a CleoOS conductor loop.
- `supportsStageGuidance` — Whether the harness accepts stage guidance injection.
- `supportsCantBridge` — Whether the harness bridges CANT events.
- `extensionsPath` — Resolved path to the harness's runtime extensions directory.
- `globalExtensionsHub` — Resolved CLEO-managed shared extensions hub path, if configured.

### `ProviderSkillsCapability`

Resolved skills capability for a provider at runtime.

```typescript
ProviderSkillsCapability
```

**Members:**

- `agentsGlobalPath` — Resolved global `.agents/skills` path, or `null` if unsupported.
- `agentsProjectPath` — Project-relative `.agents/skills` path, or `null` if unsupported.
- `precedence` — How this provider resolves skill file precedence.

### `ProviderHooksCapability`

Resolved hooks capability for a provider at runtime.

```typescript
ProviderHooksCapability
```

**Members:**

- `supported` — Hook lifecycle events this provider supports.
- `hookConfigPath` — Resolved path to the hook configuration file or directory, or `null`.
- `hookConfigPathProject` — Resolved project-relative hook configuration path, or `null`.
- `hookFormat` — Format of the hook config.
- `nativeEventCatalog` — Which native event catalog this provider's hooks are drawn from.
- `canInjectSystemPrompt` — Whether hooks may inject or modify the system prompt.
- `canBlockTools` — Whether hooks may block tool calls.

### `ProviderSpawnCapability`

Resolved spawn capability for a provider at runtime.

```typescript
ProviderSpawnCapability
```

**Members:**

- `supportsSubagents` — Whether the provider supports spawning subagents.
- `supportsProgrammaticSpawn` — Whether subagents can be spawned programmatically.
- `supportsInterAgentComms` — Whether spawned agents can communicate with each other.
- `supportsParallelSpawn` — Whether multiple agents can be spawned in parallel.
- `spawnMechanism` — Mechanism used for spawning.
- `spawnCommand` — Literal command-line invocation used by the harness to spawn a child worker. Only meaningful when `spawnMechanism === "native-child-process"`.

### `ProviderCapabilities`

Aggregate provider capabilities for MCP, harness role, skills, hooks, and spawn.

```typescript
ProviderCapabilities
```

**Members:**

- `mcp` — MCP server integration, when the provider consumes MCP via a config file.
- `harness` — Harness role, present only for orchestrators and standalone harnesses.
- `skills` — Skills path resolution and precedence.
- `hooks` — Hook/lifecycle event support.
- `spawn` — Subagent spawn capabilities.

### `Provider`

A resolved AI agent provider definition with platform-specific paths.

```typescript
Provider
```

**Members:**

- `id` — Unique provider identifier (e.g. `"claude-code"`).
- `toolName` — Human-readable tool name (e.g. `"Claude Code"`).
- `vendor` — Vendor/company name (e.g. `"Anthropic"`).
- `agentFlag` — CLI flag name for `--agent` selection.
- `aliases` — Alternative names that resolve to this provider.
- `pathGlobal` — Resolved global instruction file directory path.
- `pathProject` — Project-relative instruction file directory path.
- `instructFile` — Instruction file name (e.g. `"CLAUDE.md"`, `"AGENTS.md"`).
- `pathSkills` — Resolved global skills directory path.
- `pathProjectSkills` — Project-relative skills directory path.
- `detection` — Detection configuration for auto-discovering this provider.
- `priority` — Priority tier for sorting and default selection.
- `status` — Lifecycle status in the registry.
- `agentSkillsCompatible` — Whether the provider is compatible with the Agent Skills standard.
- `capabilities` — Provider capabilities (MCP, harness, skills, hooks, spawn). Always populated at runtime.

```typescript
const provider = getProvider("claude-code");
if (provider?.capabilities.mcp) {
  console.log(provider.capabilities.mcp.configPathGlobal);
}
```

### `McpServerConfig`

Canonical MCP server configuration.

```typescript
McpServerConfig
```

**Members:**

- `type` — Transport type (`"stdio"`, `"sse"`, or `"http"`).
- `url` — URL for remote MCP servers.
- `headers` — HTTP headers for remote MCP servers.
- `command` — Command to run for stdio MCP servers.
- `args` — Arguments for the stdio command.
- `env` — Environment variables for the stdio process.

```typescript
// Remote server
const remote: McpServerConfig = {
  type: "http",
  url: "https://mcp.example.com/sse",
};

// Local stdio server
const local: McpServerConfig = {
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem"],
};
```

### `SourceType`

Classified type of an MCP server or skill source.  - `"remote"` - HTTP/HTTPS URL to a remote MCP server - `"package"` - npm package name - `"command"` - Shell command string - `"github"` - GitHub repository (URL or shorthand) - `"gitlab"` - GitLab repository URL - `"local"` - Local filesystem path - `"library"` - Built-in skill library reference

```typescript
SourceType
```

### `ParsedSource`

Result of parsing a source string into its typed components.

```typescript
ParsedSource
```

**Members:**

- `type` — Classified source type.
- `value` — Original or normalized source value.
- `inferredName` — Display name inferred from the source.
- `owner` — Repository owner (for GitHub/GitLab sources).
- `repo` — Repository name (for GitHub/GitLab sources).
- `path` — Path within the repository (for GitHub/GitLab sources).
- `ref` — Git ref / branch / tag (for GitHub/GitLab sources).

```typescript
const parsed: ParsedSource = {
  type: "github",
  value: "https://github.com/owner/repo",
  inferredName: "repo",
  owner: "owner",
  repo: "repo",
};
```

### `SkillMetadata`

Metadata extracted from a SKILL.md frontmatter.

```typescript
SkillMetadata
```

**Members:**

- `name` — Skill name (lowercase, hyphens only).
- `description` — Human-readable description.
- `license` — SPDX license identifier.
- `compatibility` — Compatibility notes (e.g. agent versions).
- `metadata` — Arbitrary key-value metadata.
- `allowedTools` — List of tools the skill is allowed to use.
- `version` — Semantic version string.

```typescript
const meta: SkillMetadata = {
  name: "my-skill",
  description: "A useful skill for code generation",
  version: "1.0.0",
};
```

### `SkillEntry`

A discovered skill entry with its location and metadata.

```typescript
SkillEntry
```

**Members:**

- `name` — Skill name.
- `scopedName` — Scoped name (may include marketplace scope).
- `path` — Absolute path to the skill directory.
- `metadata` — Parsed SKILL.md frontmatter metadata.
- `source` — Original source from which the skill was installed.

```typescript
import { getCanonicalSkillsDir } from "./core/paths/standard.js";
import { join } from "node:path";

const entry: SkillEntry = {
  name: "my-skill",
  scopedName: "my-skill",
  path: join(getCanonicalSkillsDir(), "my-skill"),
  metadata: { name: "my-skill", description: "A skill" },
};
```

### `LockEntry`

A single entry in the CAAMP lock file tracking an installed skill or MCP server.

```typescript
LockEntry
```

**Members:**

- `name` — Skill or server name.
- `scopedName` — Scoped name (may include marketplace scope).
- `source` — Original source string.
- `sourceType` — Classified source type.
- `version` — Version string or commit SHA.
- `installedAt` — ISO 8601 timestamp of first installation.
- `updatedAt` — ISO 8601 timestamp of last update.
- `agents` — Provider IDs this entry is linked to.
- `canonicalPath` — Absolute path to canonical installation.
- `isGlobal` — Whether this was installed globally.
- `projectDir` — Project directory (for project-scoped installs).

```typescript
import { getCanonicalSkillsDir } from "./core/paths/standard.js";
import { join } from "node:path";

const entry: LockEntry = {
  name: "my-skill",
  scopedName: "my-skill",
  source: "https://github.com/owner/repo",
  sourceType: "github",
  installedAt: "2025-01-15T10:30:00.000Z",
  agents: ["claude-code", "cursor"],
  canonicalPath: join(getCanonicalSkillsDir(), "my-skill"),
  isGlobal: true,
};
```

### `CaampLockFile`

The CAAMP lock file structure, stored at the resolved canonical lock path.

```typescript
CaampLockFile
```

**Members:**

- `version` — Lock file schema version.
- `skills` — Installed skills keyed by name.
- `mcpServers` — Installed MCP servers keyed by name.
- `lastSelectedAgents` — Last selected agent IDs for UX persistence.

```typescript
const lock: CaampLockFile = {
  version: 1,
  skills: {},
  mcpServers: {},
  lastSelectedAgents: ["claude-code"],
};
```

### `MarketplaceSkill`

A skill listing from a marketplace search result.

```typescript
MarketplaceSkill
```

**Members:**

- `id` — Unique marketplace identifier.
- `name` — Skill name.
- `scopedName` — Scoped name (e.g. `"@author/my-skill"`).
- `description` — Short description.
- `author` — Author / publisher name.
- `stars` — GitHub star count.
- `forks` — GitHub fork count.
- `githubUrl` — GitHub repository URL.
- `repoFullName` — Full `owner/repo` name.
- `path` — Path within the repository.
- `category` — Optional category tag.
- `hasContent` — Whether SKILL.md content was fetched.

```typescript
const skill: MarketplaceSkill = {
  id: "abc123",
  name: "my-skill",
  scopedName: "@author/my-skill",
  description: "A useful skill",
  author: "author",
  stars: 42,
  forks: 5,
  githubUrl: "https://github.com/author/my-skill",
  repoFullName: "author/my-skill",
  path: "/",
  hasContent: true,
};
```

### `MarketplaceSearchResult`

Paginated search results from a marketplace API.

```typescript
MarketplaceSearchResult
```

**Members:**

- `skills` — Array of matching skills.
- `total` — Total number of matching results.
- `limit` — Maximum results per page.
- `offset` — Offset into the result set.

```typescript
const result: MarketplaceSearchResult = {
  skills: [],
  total: 0,
  limit: 20,
  offset: 0,
};
```

### `AuditSeverity`

Severity level for a security audit finding.  Ordered from most to least severe: `"critical"`  `"high"`  `"medium"`  `"low"`  `"info"`.

```typescript
AuditSeverity
```

### `AuditRule`

A security audit rule definition with a regex pattern to match against skill content.

```typescript
AuditRule
```

**Members:**

- `id` — Unique rule identifier (e.g. `"SEC001"`).
- `name` — Rule name.
- `description` — Human-readable description of what the rule detects.
- `severity` — Severity level of findings from this rule.
- `category` — Category grouping (e.g. `"injection"`, `"exfiltration"`).
- `pattern` — Regex pattern to match against each line of content.

```typescript
const rule: AuditRule = {
  id: "SEC001",
  name: "shell-injection",
  description: "Potential shell injection vector",
  severity: "critical",
  category: "injection",
  pattern: /rm\s+-rf\s+\//,
};
```

### `AuditFinding`

A single finding from a security audit scan, with line-level location.

```typescript
AuditFinding
```

**Members:**

- `rule` — The rule that triggered this finding.
- `line` — Line number (1-based).
- `column` — Column number (1-based).
- `match` — The matched text.
- `context` — The full line of text for context.

```typescript
const finding: AuditFinding = {
  rule: myRule,
  line: 42,
  column: 10,
  match: "rm -rf /",
  context: "Execute: rm -rf / to clean up",
};
```

### `AuditResult`

Aggregate audit result for a single file.

```typescript
AuditResult
```

**Members:**

- `file` — Path to the scanned file.
- `findings` — All findings for this file.
- `score` — Security score from 0 (dangerous) to 100 (clean).
- `passed` — Whether the file passed the audit (no critical/high findings).

```typescript
const result: AuditResult = {
  file: "/path/to/SKILL.md",
  findings: [],
  score: 100,
  passed: true,
};
```

### `InjectionStatus`

Status of a CAAMP injection block in an instruction file.  - `"current"` - Injection block exists and matches expected content - `"outdated"` - Injection block exists but content differs - `"missing"` - Instruction file does not exist - `"none"` - File exists but has no CAAMP injection block

```typescript
InjectionStatus
```

### `InjectionCheckResult`

Result of checking a single instruction file for CAAMP injection status.

```typescript
InjectionCheckResult
```

**Members:**

- `file` — Absolute path to the instruction file.
- `provider` — Provider ID that owns this instruction file.
- `status` — Current injection status.
- `fileExists` — Whether the instruction file exists on disk.

```typescript
const check: InjectionCheckResult = {
  file: "/project/CLAUDE.md",
  provider: "claude-code",
  status: "current",
  fileExists: true,
};
```

### `McpServerEntry`

An MCP server entry read from a provider's config file.

```typescript
McpServerEntry
```

**Members:**

- `name` — Server name (the key in the config file).
- `providerId` — Provider ID that owns this config file.
- `providerName` — Human-readable provider name.
- `scope` — Whether from project or global config.
- `configPath` — Absolute path to the config file.
- `config` — Raw server configuration object.

```typescript
const entry: McpServerEntry = {
  name: "filesystem",
  providerId: "claude-code",
  providerName: "Claude Code",
  scope: "project",
  configPath: "/project/.claude.json",
  config: { command: "npx", args: ["-y", "@mcp/server-filesystem"] },
};
```

### `GlobalOptions`

Global CLI options shared across all CAAMP commands.

```typescript
GlobalOptions
```

**Members:**

- `agent` — Target agent IDs (repeatable).
- `global` — Operate on global config instead of project.
- `yes` — Skip confirmation prompts.
- `all` — Target all detected agents.
- `json` — Output as JSON.
- `dryRun` — Preview changes without writing.
- `verbose` — Enable debug logging.
- `quiet` — Suppress non-error output.

```typescript
const opts: GlobalOptions = {
  agent: ["claude-code", "cursor"],
  global: true,
  json: true,
};
```

### `PlatformPaths`

OS-appropriate directory paths for CAAMP's global storage.

```typescript
PlatformPaths
```

**Members:**

- `data` — User data dir. Override with AGENTS_HOME env var.
- `config` — OS config dir (XDG_CONFIG_HOME / Library/Preferences / %APPDATA%).
- `cache` — OS cache dir.
- `log` — OS log dir.
- `temp` — OS temp dir.

### `SystemInfo`

Snapshot of the current system environment and resolved platform paths.

```typescript
SystemInfo
```

**Members:**

- `platform` — Operating system platform identifier.
- `arch` — CPU architecture (e.g. `"x64"`, `"arm64"`).
- `release` — OS kernel release version string.
- `hostname` — Machine hostname.
- `nodeVersion` — Node.js version string (e.g. `"v20.11.0"`).
- `paths` — Resolved platform directory paths.

### `PathScope`

Scope for path resolution, either global (user home) or project-local.

```typescript
PathScope
```

### `PlatformLocations`

Platform-specific directory locations for agent configuration.

```typescript
PlatformLocations
```

**Members:**

- `home` — The user's home directory path.
- `config` — The platform-specific configuration directory.
- `vscodeConfig` — The VS Code user settings directory.
- `zedConfig` — The Zed editor configuration directory.
- `claudeDesktopConfig` — The Claude Desktop application configuration directory.
- `applications` — List of application directories (macOS only).

### `InjectionTemplate`

Structured template for injection content.

```typescript
InjectionTemplate
```

**Members:**

- `references` — References to include (e.g. `"\@AGENTS.md"`, `"\@.cleo/project-context.json"`).
- `content` — Inline content blocks (raw markdown/text).

### `EnsureProviderInstructionFileOptions`

Options for ensuring a provider instruction file.

```typescript
EnsureProviderInstructionFileOptions
```

**Members:**

- `references` — `\@` references to inject (e.g. `["\@AGENTS.md"]`).
- `content` — Optional inline content blocks.
- `scope` — Whether this is a global or project-level file.

### `EnsureProviderInstructionFileResult`

Result of ensuring a provider instruction file.

```typescript
EnsureProviderInstructionFileResult
```

**Members:**

- `filePath` — Absolute path to the instruction file.
- `instructFile` — Instruction file name from the provider registry.
- `action` — Action taken.
- `providerId` — Provider ID.

### `DetectionResult`

Result of detecting whether a provider is installed on the system.

```typescript
DetectionResult
```

**Members:**

- `provider` — The provider that was checked.
- `installed` — Whether the provider was detected as installed.
- `methods` — Detection methods that matched (e.g. `["binary", "directory"]`).
- `projectDetected` — Whether the provider has project-level config in the current directory.

```typescript
const provider = getProvider("claude-code")!;
const result = detectProvider(provider);
if (result.installed) {
  console.log(`Found via: ${result.methods.join(", ")}`);
}
```

### `DetectionCacheOptions`

Options for controlling the detection result cache.

```typescript
DetectionCacheOptions
```

**Members:**

- `forceRefresh` — Whether to bypass the cache and force a fresh detection scan.
- `ttlMs` — Time-to-live for cached results in milliseconds.

### `SkillInstallResult`

Result of installing a skill to the canonical location and linking to agents.

```typescript
SkillInstallResult
```

**Members:**

- `name` — Skill name.
- `canonicalPath` — Absolute path to the canonical installation directory.
- `linkedAgents` — Provider IDs that were successfully linked.
- `errors` — Error messages from failed link operations.
- `success` — Whether at least one agent was successfully linked.

```typescript
const result = await installSkill(sourcePath, "my-skill", providers, true);
if (result.success) {
  console.log(`Installed to ${result.canonicalPath}`);
  console.log(`Linked to: ${result.linkedAgents.join(", ")}`);
}
```

### `SkillBatchOperation`

Single skill operation entry used by batch orchestration.

```typescript
SkillBatchOperation
```

**Members:**

- `sourcePath` — The filesystem path to the skill source files.
- `skillName` — The unique name for the skill being installed.
- `isGlobal` — Whether to install globally or project-scoped, defaults to true.

### `BatchInstallOptions`

Options for rollback-capable batch installation.

```typescript
BatchInstallOptions
```

**Members:**

- `providers` — Explicit list of providers to target, auto-detected if omitted.
- `minimumPriority` — Minimum provider priority threshold for filtering.
- `skills` — Skill operations to apply in the batch.
- `projectDir` — Project root directory, defaults to `process.cwd()`.

### `BatchInstallResult`

Result of rollback-capable batch installation.

```typescript
BatchInstallResult
```

**Members:**

- `success` — Whether all operations completed successfully.
- `providerIds` — IDs of providers that were targeted.
- `skillsApplied` — Number of skill installations that were applied.
- `rollbackPerformed` — Whether rollback was performed due to a failure.
- `rollbackErrors` — Error messages from any failures during rollback.
- `error` — Error message from the operation that triggered rollback.

### `InstructionUpdateSummary`

Result of a single-operation instruction update across providers.

```typescript
InstructionUpdateSummary
```

**Members:**

- `scope` — The scope at which instructions were updated.
- `updatedFiles` — The total number of instruction files that were modified.
- `actions` — Detailed action log per instruction file.

### `HarnessTier`

Three-tier scope identifier for Pi harness operations.

```typescript
HarnessTier
```

### `HarnessAssetKind`

Asset kinds managed by the three-tier scope model.

```typescript
HarnessAssetKind
```

### `ResolveTierDirOptions`

Options accepted by `resolveTierDir`.

```typescript
ResolveTierDirOptions
```

**Members:**

- `tier` — Tier to resolve.
- `kind` — Asset kind (extensions, prompts, themes, sessions, cant).
- `projectDir` — Project directory used when `tier` is `project`. Ignored for other tiers. When omitted with `tier='project'` the caller MUST substitute `process.cwd()` before invoking the resolver, so the harness never silently resolves to an unexpected working directory.

### `HarnessScope`

Scope at which a harness operation should be performed.

```typescript
HarnessScope
```

### `ResolveDefaultTargetProvidersOptions`

Options accepted by `resolveDefaultTargetProviders` (defined in `./index.ts`).

```typescript
ResolveDefaultTargetProvidersOptions
```

**Members:**

- `explicit` — Explicit list of providers requested by the user (e.g. via `--agent`).

### `ExclusivityMode`

Controls how `resolveDefaultTargetProviders` (defined in `./index.ts`) selects target providers at runtime invocation time.

```typescript
ExclusivityMode
```

### `ExtensionEntry`

Metadata describing a Pi extension discovered on disk.

```typescript
ExtensionEntry
```

**Members:**

- `name` — Extension name (file basename without the `.ts` extension).
- `tier` — Tier at which this entry lives.
- `path` — Absolute on-disk path to the extension file.
- `shadowed` — When `true`, this entry is shadowed by a higher-precedence entry with the same name. Exposed so list output can warn about cross-tier name collisions per ADR-035 §D1.

### `PromptEntry`

Metadata describing a Pi prompt directory discovered on disk.

```typescript
PromptEntry
```

**Members:**

- `name` — Prompt name (directory basename).
- `tier` — Tier at which this entry lives.
- `path` — Absolute on-disk path to the prompt directory.
- `shadowed` — See `ExtensionEntry.shadowed`.

### `ThemeEntry`

Metadata describing a Pi theme discovered on disk.

```typescript
ThemeEntry
```

**Members:**

- `name` — Theme name (file basename without the extension).
- `tier` — Tier at which this entry lives.
- `path` — Absolute on-disk path to the theme file.
- `fileExt` — File extension of the theme file (e.g. `".ts"`, `".json"`).
- `shadowed` — See `ExtensionEntry.shadowed`.

### `HarnessInstallOptions`

Options accepted by the Pi install verbs (extensions, prompts, themes).

```typescript
HarnessInstallOptions
```

**Members:**

- `force` — When `true`, overwrite an existing file at the target tier. When `false` (the default) the install verb throws if the target exists.

### `CantProfileCounts`

Counts of top-level CANT sections discovered in a `.cant` file.

```typescript
CantProfileCounts
```

**Members:**

- `agentCount` — Number of `agent { ... }` sections in the document.
- `workflowCount` — Number of `workflow { ... }` sections in the document.
- `pipelineCount` — Number of `pipeline { ... }` sections in the document.
- `hookCount` — Number of hook bodies discovered. Top-level `Hook` sections plus the `hooks` array nested inside every Agent section are summed.
- `skillCount` — Number of distinct skill names referenced via an Agent section's `skills:` property (e.g. `skills: ["ct-cleo", "ct-task-executor"]`). The count is de-duplicated across agents within a single document.

### `CantProfileEntry`

Metadata describing a `.cant` profile installed at one of the three Pi harness tiers.

```typescript
CantProfileEntry
```

**Members:**

- `name` — Profile name (basename of the `.cant` file without the extension).
- `tier` — Tier at which this entry lives.
- `sourcePath` — Absolute on-disk path to the `.cant` file.
- `counts` — Parsed section counts for the profile.
- `shadowedByHigherTier` — When `true`, this entry is shadowed by a higher-precedence entry with the same name. Mirrors the shadow flag emitted by `Harness.listExtensions` so the same UI logic applies.

### `CantValidationDiagnostic`

Diagnostic emitted by the cant-core 42-rule validator, normalised to the harness layer's vocabulary.

```typescript
CantValidationDiagnostic
```

**Members:**

- `ruleId` — Cant-core rule id (`PARSE`, `S01`, `P06`, ...).
- `message` — Human-readable diagnostic message.
- `line` — 1-based line number where the diagnostic was emitted.
- `col` — 1-based column number where the diagnostic was emitted.
- `severity` — Severity bucket from cant-core (`error`, `warning`, `info`, `hint`).

### `ValidateCantProfileResult`

Result of validating a `.cant` profile via the cant-core 42-rule engine.

```typescript
ValidateCantProfileResult
```

**Members:**

- `valid` — Whether validation passed (no error-severity diagnostics).
- `errors` — All diagnostics emitted by the 42-rule engine, in source order.
- `counts` — Section counts for the profile (zero when parsing failed).

### `SessionSummary`

Summary header extracted from the first line of a Pi session JSONL file.

```typescript
SessionSummary
```

**Members:**

- `id` — Session identifier as recorded in the line-1 header.
- `version` — Session version as recorded in the line-1 header (e.g. `3`).
- `timestamp` — ISO-8601 timestamp from the line-1 header, or `null` when absent.
- `cwd` — Working directory recorded when the session was created.
- `parentSession` — Parent session id, if this session was forked from another.
- `filePath` — Absolute path to the session JSONL file on disk.
- `mtimeMs` — File modification time in milliseconds since the epoch.

### `SessionDocument`

Raw content of a Pi session JSONL file, preserved line-by-line.

```typescript
SessionDocument
```

**Members:**

- `summary` — Header summary (same shape as `SessionSummary`).
- `entries` — Raw JSONL lines in file order, excluding the line-1 header.

### `PiModelDefinition`

Pi model definition as recorded under `models.json:providers[].models`.

```typescript
PiModelDefinition
```

**Members:**

- `id` — Model id within the provider (e.g. `"claude-opus-4-20250514"`).
- `name` — Human-readable model name.
- `reasoning` — Whether the model supports reasoning/thinking tokens.
- `input` — Allowed input modalities (e.g. `["text"]`, `["text", "image"]`).
- `contextWindow` — Context window size in tokens.
- `maxTokens` — Maximum output tokens.

### `PiModelProvider`

Pi provider block as recorded under `models.json:providers[id]`.

```typescript
PiModelProvider
```

**Members:**

- `baseUrl` — Custom base URL for the provider (overrides default).
- `apiKey` — API key or `$ENV_VAR` reference.
- `models` — Custom model definitions declared by the user.

### `PiModelsConfig`

Entire `models.json` document shape used by Pi.

```typescript
PiModelsConfig
```

**Members:**

- `providers` — Map of provider id → provider block.

### `ModelListEntry`

A model entry as surfaced by `Harness.listModels`.

```typescript
ModelListEntry
```

**Members:**

- `provider` — Provider id (e.g. `"anthropic"`).
- `id` — Model id within the provider.
- `name` — Human-readable name, from `models.json` when available.
- `enabled` — `true` when the model is present in `settings.json:enabledModels`.
- `isDefault` — `true` when the model is the configured default.
- `custom` — `true` when this model is defined in `models.json` (custom). When `false`, the entry originates from `settings.json:enabledModels` only and is assumed to resolve against Pi's built-in registry.

### `SubagentTask`

Description of a subagent task to be spawned under a harness.

```typescript
SubagentTask
```

**Members:**

- `targetProviderId` — Provider id of the agent to spawn (e.g. `"claude-code"`).
- `prompt` — The prompt / instruction to give the spawned agent.
- `taskId` — Stable task identifier used to derive the child session filename and to correlate streamed events with their originating task.
- `parentSessionId` — Identifier of the parent session that owns this subagent.
- `parentSessionPath` — Absolute path to the parent session JSONL file.
- `cwd` — Working directory for the spawned agent.
- `env` — Environment variable overrides layered atop the parent environment.
- `signal` — Abort signal. When it aborts, the harness will terminate the subagent via the configured SIGTERM-then-SIGKILL cleanup sequence.

### `SubagentSpawnOptions`

Per-call options that override harness-wide spawn defaults.

```typescript
SubagentSpawnOptions
```

**Members:**

- `onStream` — Streaming callback invoked once per parsed event from the child.
- `terminateGraceMs` — Override the SIGTERM grace window before SIGKILL fires.
- `env` — Environment variable overrides layered atop the task-level env.
- `cwd` — Working directory override that wins over `SubagentTask.cwd`.

### `SubagentStreamEvent`

One streaming event surfaced through `SubagentSpawnOptions.onStream`.

```typescript
SubagentStreamEvent
```

**Members:**

- `kind` — Event kind discriminator.
- `subagentId` — Subagent identifier (matches `SubagentHandle.subagentId`).
- `lineNumber` — 1-based line number within the child's stdout stream. Only set for `"message"` events that originated from a parsed stdout line.
- `payload` — Event payload, shaped according to `kind`.

### `SubagentExitResult`

Resolution value of `SubagentHandle.exitPromise`.

```typescript
SubagentExitResult
```

**Members:**

- `code` — Process exit code, or `null` when the child was terminated by a signal before exiting normally.
- `signal` — Terminating signal, or `null` when the child exited normally.
- `childSessionPath` — Absolute path to the child session JSONL file on disk.
- `durationMs` — Wall-clock duration from spawn to exit, in milliseconds.

### `SubagentLinkEntry`

`subagent_link` custom entry written into the parent session JSONL.

```typescript
SubagentLinkEntry
```

**Members:**

- `type` — Entry type discriminator (always `"subagent_link"`).
- `subagentId` — Subagent identifier matching `SubagentHandle.subagentId`.
- `taskId` — Task identifier from `SubagentTask.taskId`.
- `childSessionPath` — Absolute path to the child session JSONL file.
- `startedAt` — ISO-8601 timestamp captured when the child was spawned.

### `SubagentResult`

Final result of a subagent's execution (legacy v1 shape).

```typescript
SubagentResult
```

**Members:**

- `exitCode` — Process exit code, or `null` if the process was killed by a signal.
- `stdout` — Full stdout captured from the subagent.
- `stderr` — Full stderr captured from the subagent.
- `parsed` — Parsed JSON output, when the target supports a JSON output mode and emitted well-formed JSON on stdout.

### `SubagentHandle`

Live handle to a running subagent.

```typescript
SubagentHandle
```

**Members:**

- `subagentId` — Stable subagent identifier generated at spawn time.
- `taskId` — Task identifier from `SubagentTask.taskId` (or generated default).
- `childSessionPath` — Absolute path to the child session JSONL file on disk.
- `pid` — PID of the spawned process, or `null` if spawning did not yield one.
- `startedAt` — Wall-clock timestamp captured immediately after spawn.
- `exitPromise` — Promise resolving to the rich exit result once the child process has fully terminated. NEVER rejects — failures are encoded in the resolved value (non-zero code, non-null signal, partial output in the session file).
- `result` — Promise resolving to the legacy `SubagentResult` shape.
- `terminate` — Terminate the subagent gracefully.
- `abort` — Synchronously trigger the cleanup sequence (legacy v1 alias for `terminate`).
- `recentStderr` — Snapshot of the most recent stderr lines captured for this child.

### `Harness`

Contract every first-class harness must implement.

```typescript
Harness
```

**Members:**

- `id` — Short id matching the provider id (e.g. `"pi"`).
- `provider` — The underlying resolved provider entry.
- `installSkill` — Install a skill using the harness's native mechanism.
- `removeSkill` — Remove a skill previously installed via this harness.
- `listSkills` — List skills installed in this harness's skill directory for a scope.
- `injectInstructions` — Inject content into the harness's instruction file using a marker-based idempotent block.
- `removeInstructions` — Remove the CAAMP injection block from the harness's instruction file.
- `spawnSubagent` — Spawn a subagent under this harness's control.
- `configureModels` — Configure which models are available in the harness's model picker.
- `readSettings` — Read the harness's current settings as an opaque object.
- `writeSettings` — Deep-merge a patch into the harness's settings and persist the result.
- `installExtension` — Install a Pi extension TypeScript file from a local source path into the given tier.
- `removeExtension` — Remove a Pi extension by name from the given tier.
- `listExtensions` — List Pi extensions across all tiers, precedence-ordered.
- `listSessions` — List Pi sessions from the user-tier sessions directory.
- `showSession` — Load a Pi session's full body by id.
- `listModels` — List every model known to Pi — both custom (`models.json`) and enabled selections (`settings.json:enabledModels`).
- `readModelsConfig` — Read `models.json` for the given scope.
- `writeModelsConfig` — Write `models.json` for the given scope atomically.
- `installPrompt` — Install a Pi prompt from a source directory into the given tier.
- `listPrompts` — List Pi prompts across all tiers.
- `removePrompt` — Remove a Pi prompt by name from the given tier.
- `installTheme` — Install a Pi theme from a source file into the given tier.
- `listThemes` — List Pi themes across all tiers.
- `removeTheme` — Remove a Pi theme by name from the given tier.
- `installCantProfile` — Install a CANT profile (`.cant` file) into the given tier.
- `removeCantProfile` — Remove a CANT profile by name from the given tier.
- `listCantProfiles` — List CANT profiles across all tiers, precedence-ordered.
- `validateCantProfile` — Validate a `.cant` file via cant-core's 42-rule engine without installing anything.

### `MVILevel`

LAFS MVI disclosure level - defined locally to avoid CI module resolution issues with re-exported types.

```typescript
MVILevel
```

### `LAFSErrorShape`

LAFS Error structure - re-exported from protocol as LAFSErrorShape for CAAMP compatibility.

```typescript
LAFSError
```

### `LAFSWarning`

LAFS Warning structure - re-exported from protocol.

```typescript
Warning
```

### `LAFSEnvelope`

Generic LAFS Envelope structure for type-safe command results.

```typescript
LAFSEnvelope<T>
```

**Members:**

- `$schema` — JSON Schema URI for envelope validation.
- `_meta` — Envelope metadata (timestamps, request IDs, MVI level).
- `success` — Whether the operation succeeded.
- `result` — Operation result payload, or `null` on error.
- `error` — Error details, or `null` on success.
- `page` — Pagination metadata, or `null` when not applicable.

### `FormatOptions`

Format resolution options.

```typescript
FormatOptions
```

**Members:**

- `jsonFlag` — Whether `--json` was explicitly passed.
- `humanFlag` — Whether `--human` was explicitly passed.
- `projectDefault` — Project-level default format when no flag is given.

### `LAFSCommandOptions`

Standard command options interface for LAFS-compliant commands.

```typescript
LAFSCommandOptions
```

**Members:**

- `json` — Whether to force JSON output.
- `human` — Whether to force human-readable output.

### `ProviderTargetOptions`

Options for resolving which providers to target in advanced commands.

```typescript
ProviderTargetOptions
```

**Members:**

- `all` — When true, target all registry providers including undetected ones.
- `agent` — Specific provider IDs or aliases to target.

### `McpScope`

Scope identifier for MCP config file resolution.

```typescript
McpScope
```

### `McpDetectionEntry`

Result of a single provider's MCP installation probe.

```typescript
McpDetectionEntry
```

**Members:**

- `providerId` — Provider id (e.g. `"claude-code"`).
- `providerName` — Human-readable provider name.
- `scope` — Resolved scope of the probed config file.
- `configPath` — Absolute path to the provider's MCP config file.
- `exists` — Whether the config file exists on disk.
- `serverCount` — Number of server entries found, or `null` when the file is missing/unparseable.
- `lastModified` — ISO 8601 timestamp of the file's last modification, or `null` when the file is missing.

### `McpServerEntriesByProvider`

Map of provider id → MCP server entries for that provider.

```typescript
McpServerEntriesByProvider
```

### `InstallMcpServerOptions`

Options accepted by `installMcpServer`.

```typescript
InstallMcpServerOptions
```

**Members:**

- `scope` — Scope to write to (project|global).
- `force` — When `true`, overwrite an existing server entry instead of failing.
- `projectDir` — Project directory used for the `project` scope.

### `InstallMcpServerResult`

Result of an `installMcpServer` call.

```typescript
InstallMcpServerResult
```

**Members:**

- `installed` — Whether the entry was written to the config file.
- `conflicted` — Whether the target server name already existed before the call.
- `sourcePath` — Absolute path to the config file that was (or would have been) written.
- `providerId` — Provider id the entry was written for.
- `serverName` — Server name that was written.

### `RemoveMcpServerOptions`

Options accepted by `removeMcpServer` and `removeMcpServerFromAll`.

```typescript
RemoveMcpServerOptions
```

**Members:**

- `scope` — Scope to target (project|global).
- `projectDir` — Project directory used for the `project` scope.

### `RemoveMcpServerResult`

Result of a single-provider `removeMcpServer` call.

```typescript
RemoveMcpServerResult
```

**Members:**

- `providerId` — Provider id the call targeted.
- `serverName` — Server name the call targeted.
- `sourcePath` — Resolved config file path, or `null` when the provider had no MCP capability.
- `removed` — Whether an entry was actually deleted.
- `reason` — Diagnostic discriminator when `removed` is `false`.  - `"no-mcp-capability"` — provider does not consume MCP servers - `"no-config-path"` — provider has no config path for the scope - `"file-missing"` — config file does not exist on disk - `"entry-missing"` — config file exists but had no matching entry  Set to `null` when `removed` is `true`.

### `McpCommandBaseOptions`

Standard option shape accepted by every `caamp mcp <verb>` command.

```typescript
McpCommandBaseOptions
```

**Members:**

- `scope` — `--scope project|global` (default: project).
- `projectDir` — `--project-dir <path>` — override cwd for the `project` scope.

### `McpDetectOptions`

Options accepted by `caamp mcp detect`.

```typescript
McpDetectOptions
```

**Members:**

- `onlyExisting` — Show only providers that actually have a config file on disk.

### `McpInstallOptions`

Options accepted by `caamp mcp install`.

```typescript
McpInstallOptions
```

**Members:**

- `provider` — Provider id to install into (required).
- `from` — Optional path to a JSON file containing an `McpServerConfig`.
- `env` — Repeatable `KEY=VALUE` env assignments.
- `force` — Overwrite an existing entry instead of failing.

### `McpListOptions`

Options accepted by `caamp mcp list`.

```typescript
McpListOptions
```

**Members:**

- `provider` — Restrict the listing to a single provider id.

### `McpRemoveOptions`

Options accepted by `caamp mcp remove`.

```typescript
McpRemoveOptions
```

**Members:**

- `provider` — Provider id to remove from (mutually exclusive with --all-providers).
- `allProviders` — Remove from every MCP-capable provider in the registry.

### `GitFetchResult`

Result of fetching a Git repository to a local temporary directory.

```typescript
GitFetchResult
```

**Members:**

- `localPath` — Absolute path to the fetched content on disk.
- `cleanup` — Cleanup function that removes the temporary directory.

### `PiCommandBaseOptions`

Standard option shape accepted by every `caamp pi <verb>` command.

```typescript
PiCommandBaseOptions
```

**Members:**

- `scope` — `--scope project|user|global`.
- `force` — `--force` — overwrite existing targets on install verbs.
- `projectDir` — `--project-dir <path>` — override cwd for the `project` tier.

### `PiCantListOptions`

Options accepted by `caamp pi cant list`.

```typescript
PiCantListOptions
```

**Members:**

- `projectDir` — Project directory used for the `project` tier.

### `PiCantInstallOptions`

Options accepted by `caamp pi cant install`.

```typescript
PiCantInstallOptions
```

**Members:**

- `name` — Profile name override. Defaults to the inferred source name.

### `PiCantRemoveOptions`

Options accepted by `caamp pi cant remove`.

```typescript
PiCommandBaseOptions
```

### `PiExtensionsListOptions`

Options accepted by `caamp pi extensions list`.

```typescript
PiExtensionsListOptions
```

**Members:**

- `projectDir` — Project directory used for the `project` tier.

### `PiExtensionsInstallOptions`

Options accepted by `caamp pi extensions install`.

```typescript
PiExtensionsInstallOptions
```

**Members:**

- `name` — Extension name override. Defaults to the inferred source name.

### `PiExtensionsRemoveOptions`

Options accepted by `caamp pi extensions remove`.

```typescript
PiCommandBaseOptions
```

### `PiModelsCommandOptions`

Options accepted by every `caamp pi models` verb.

```typescript
PiModelsCommandOptions
```

**Members:**

- `global` — `--global` targets the Pi global state root instead of the project.

### `PiModelsAddOptions`

Options accepted by `caamp pi models add`.

```typescript
PiModelsAddOptions
```

**Members:**

- `displayName` — Human-readable model name.
- `baseUrl` — Override the provider base URL.
- `reasoning` — Reasoning-capable flag.
- `contextWindow` — Context window size in tokens.
- `maxTokens` — Maximum output tokens.

### `PiPromptsInstallOptions`

Options accepted by `caamp pi prompts install`.

```typescript
PiPromptsInstallOptions
```

**Members:**

- `name` — Override the inferred prompt directory name.

### `PiPromptsListOptions`

Options accepted by `caamp pi prompts list`.

```typescript
PiCommandBaseOptions
```

### `PiPromptsRemoveOptions`

Options accepted by `caamp pi prompts remove`.

```typescript
PiCommandBaseOptions
```

### `PiSessionsListOptions`

Options accepted by `caamp pi sessions list`.

```typescript
PiSessionsListOptions
```

**Members:**

- `includeSubagents` — Include sessions under the `subagents/` subdirectory (default: true).

### `PiSessionsExportOptions`

Options accepted by `caamp pi sessions export`.

```typescript
PiSessionsExportOptions
```

**Members:**

- `jsonl` — Emit raw JSONL. Mutually exclusive with `md`.
- `md` — Emit Markdown (filtered to message/custom_message entries).
- `output` — Write to this file path instead of stdout.

### `PiThemesInstallOptions`

Options accepted by `caamp pi themes install`.

```typescript
PiThemesInstallOptions
```

**Members:**

- `name` — Override the inferred theme name.

### `PiThemesListOptions`

Options accepted by `caamp pi themes list`.

```typescript
PiCommandBaseOptions
```

### `PiThemesRemoveOptions`

Options accepted by `caamp pi themes remove`.

```typescript
PiCommandBaseOptions
```

### `HookCategory`

Union type of valid hook category strings.

```typescript
"agent" | "context" | "memory" | "pipeline" | "prompt" | "session" | "task" | "tool"
```

### `EventSource`

Union type of valid event source types.

```typescript
"domain" | "provider"
```

### `CanonicalHookEvent`

Union type of all canonical hook event names.

```typescript
"ConfigChange" | "Notification" | "PermissionRequest" | "PostCompact" | "PostModel" | "PostToolUse" | "PostToolUseFailure" | "PreCompact" | "PreModel" | "PreToolUse" | "PromptSubmit" | "ResponseComplete" | "SessionEnd" | "SessionStart" | "SubagentStart" | "SubagentStop" | "ApprovalExpired" | "ApprovalGranted" | "ApprovalRequested" | "MemoryDecisionStored" | "MemoryLearningStored" | "MemoryObserved" | "MemoryPatternStored" | "PipelineManifestAppended" | "PipelineStageCompleted" | "SessionEnded" | "SessionStarted" | "TaskBlocked" | "TaskCompleted" | "TaskCreated" | "TaskStarted"
```

### `CanonicalEventDefinition`

Definition of a canonical hook event including its category and behavior.

```typescript
CanonicalEventDefinition
```

**Members:**

- `category` — The lifecycle category this event belongs to (e.g. `"session"`, `"tool"`).
- `description` — Human-readable description of when this event fires.
- `canBlock` — Whether a hook handler can block or cancel the associated action.

### `HookSystemType`

The type of hook system a provider uses.

```typescript
HookSystemType
```

### `HookHandlerType`

The mechanism a provider uses to execute hook handlers.

```typescript
HookHandlerType
```

### `HookMapping`

Mapping of a single canonical event to a provider's native representation.

```typescript
HookMapping
```

**Members:**

- `nativeName` — The provider-native event name, or `null` if the event has no native equivalent.
- `supported` — Whether this canonical event is supported by the provider.
- `notes` — Optional notes about support limitations or behavioral differences.

### `ProviderHookProfile`

Complete hook profile for a single provider.

```typescript
ProviderHookProfile
```

**Members:**

- `hookSystem` — The type of hook system the provider uses (`"config"`, `"plugin"`, or `"none"`).
- `hookConfigPath` — Filesystem path template to the provider's hook configuration file, or `null`.
- `hookFormat` — The configuration format used for hooks (e.g. `"json"`, `"yaml"`), or `null`.
- `handlerTypes` — The handler execution mechanisms this provider supports.
- `experimental` — Whether the provider's hook system is considered experimental or unstable.
- `mappings` — Mapping of every canonical event to this provider's native representation.
- `providerOnlyEvents` — Native event names that exist only in this provider with no canonical equivalent.

### `NormalizedHookEvent`

A fully resolved hook event with both canonical and native names.

```typescript
NormalizedHookEvent
```

**Members:**

- `canonical` — The CAAMP canonical event name.
- `native` — The provider-native event name.
- `providerId` — The provider this event was resolved for.
- `category` — The lifecycle category of this event.
- `canBlock` — Whether a handler for this event can block the associated action.

### `HookSupportResult`

Result of querying whether a provider supports a specific canonical event.

```typescript
HookSupportResult
```

**Members:**

- `canonical` — The canonical event that was queried.
- `supported` — Whether the provider supports this event.
- `native` — The provider-native event name, or `null` if unsupported.
- `notes` — Optional notes about support caveats.

### `ProviderHookSummary`

Aggregated hook support summary for a single provider.

```typescript
ProviderHookSummary
```

**Members:**

- `providerId` — The provider identifier.
- `hookSystem` — The type of hook system the provider uses.
- `experimental` — Whether the provider's hook system is experimental.
- `supportedCount` — Number of canonical events this provider supports.
- `totalCanonical` — Total number of canonical events in the taxonomy.
- `supported` — List of canonical events this provider supports.
- `unsupported` — List of canonical events this provider does not support.
- `providerOnly` — Native events unique to this provider with no canonical mapping.
- `coverage` — Percentage of canonical events supported (0-100).

### `CrossProviderMatrix`

Cross-provider hook support matrix comparing multiple providers.

```typescript
CrossProviderMatrix
```

**Members:**

- `events` — The canonical events included in this matrix (rows).
- `providers` — The provider IDs included in this matrix (columns).
- `matrix` — Nested record mapping each canonical event to each provider's hook mapping.

### `HookMappingsFile`

Schema for the `providers/hook-mappings.json` data file.

```typescript
HookMappingsFile
```

**Members:**

- `version` — Semver version string of the hook mappings schema.
- `lastUpdated` — ISO 8601 date string of the last update to mappings data.
- `description` — Human-readable description of the mappings file purpose.
- `canonicalEvents` — Definitions for every canonical event in the taxonomy.
- `providerMappings` — Hook profiles keyed by provider ID.

### `MarketplaceAdapter`

Contract that each marketplace backend adapter must implement.

```typescript
MarketplaceAdapter
```

**Members:**

- `name` — Human-readable adapter name (e.g. `"agentskills.in"`).
- `search` — Search the marketplace for skills matching a query.
- `getSkill` — Retrieve a single skill by its scoped name.

### `MarketplaceResult`

Normalized marketplace record returned by all adapters.

```typescript
MarketplaceResult
```

**Members:**

- `name` — Short skill name (e.g. `"memory"`).
- `scopedName` — Scoped name including author prefix (e.g. `"\@anthropic/memory"`).
- `description` — Short description of what the skill does.
- `author` — Author or organization name.
- `stars` — GitHub star count.
- `githubUrl` — Full GitHub repository URL.
- `repoFullName` — GitHub `owner/repo` path.
- `path` — Path within the repository to the skill file.
- `source` — Name of the marketplace source this result came from.

### `SearchOptions`

Options for marketplace search requests.

```typescript
SearchOptions
```

**Members:**

- `query` — Free-text search query.
- `limit` — Maximum number of results.
- `offset` — Pagination offset.
- `sortBy` — Sort order for results.
- `category` — Filter by skill category.
- `author` — Filter by author name.

### `RecommendationErrorCode`

Union type of all recommendation error code string literals.

```typescript
RecommendationErrorCode
```

### `RecommendationValidationIssue`

Describes a single validation issue found in recommendation criteria.

```typescript
RecommendationValidationIssue
```

**Members:**

- `code` — The error code identifying the type of validation failure.
- `field` — The criteria field that caused the validation issue.
- `message` — A human-readable description of the validation issue.

### `RecommendationValidationResult`

Result of validating recommendation criteria input.

```typescript
RecommendationValidationResult
```

**Members:**

- `valid` — Whether the criteria passed all validation checks.
- `issues` — List of validation issues found, empty when valid.

### `RecommendationCriteriaInput`

Raw user-provided criteria for skill recommendations.

```typescript
RecommendationCriteriaInput
```

**Members:**

- `query` — Free-text search query to match against skill metadata.
- `mustHave` — Terms that a skill must match to be considered relevant.
- `prefer` — Terms that boost a skill's score when matched.
- `exclude` — Terms that penalize a skill's score when matched.

### `NormalizedRecommendationCriteria`

Normalized and tokenized form of recommendation criteria.

```typescript
NormalizedRecommendationCriteria
```

**Members:**

- `query` — The lowercased, trimmed query string.
- `queryTokens` — Individual tokens extracted from the query string.
- `mustHave` — Sorted, deduplicated list of required match terms.
- `prefer` — Sorted, deduplicated list of preferred match terms.
- `exclude` — Sorted, deduplicated list of exclusion terms.

### `RecommendationReasonCode`

String literal union of all reason codes emitted during skill scoring.

```typescript
RecommendationReasonCode
```

### `RecommendationReason`

A single reason contributing to a skill's recommendation score.

```typescript
RecommendationReason
```

**Members:**

- `code` — The reason code identifying the scoring signal.
- `detail` — Optional detail providing additional context, such as match count.

### `RecommendationScoreBreakdown`

Detailed breakdown of a skill's recommendation score by category.

```typescript
RecommendationScoreBreakdown
```

**Members:**

- `mustHave` — Score contribution from must-have term matches.
- `prefer` — Score contribution from preferred term matches.
- `query` — Score contribution from query token matches.
- `stars` — Score contribution from repository star count signal.
- `metadata` — Score contribution from metadata quality and source confidence.
- `modernity` — Score contribution from modern vs legacy marker detection.
- `exclusionPenalty` — Penalty applied for matching excluded terms.
- `total` — The final aggregated recommendation score.

### `RankedSkillRecommendation`

A single skill recommendation with its computed score and explanations.

```typescript
RankedSkillRecommendation
```

**Members:**

- `skill` — The marketplace skill result being scored.
- `score` — The computed recommendation score, higher is better.
- `reasons` — List of reasons explaining the score contributions.
- `tradeoffs` — Human-readable tradeoff warnings for the skill.
- `excluded` — Whether the skill matched one or more exclusion terms.
- `breakdown` — Optional detailed score breakdown by category.

### `RecommendationOptions`

Configuration options for the skill recommendation engine.

```typescript
RecommendationOptions
```

**Members:**

- `top` — Maximum number of results to return from the ranked list.
- `includeDetails` — Whether to include detailed score breakdown in each result.
- `weights` — Partial weight overrides for individual scoring factors.
- `modernMarkers` — Custom modern technology marker strings for modernity scoring.
- `legacyMarkers` — Custom legacy technology marker strings for modernity scoring.

### `RecommendationWeights`

Numeric weights controlling the recommendation scoring algorithm.

```typescript
RecommendationWeights
```

**Members:**

- `mustHaveMatch` — Weight applied per must-have term match.
- `preferMatch` — Weight applied per preferred term match.
- `queryTokenMatch` — Weight applied per query token match.
- `starsFactor` — Multiplier for the logarithmic star count signal.
- `metadataBoost` — Boost for metadata quality and source confidence.
- `modernMarkerBoost` — Boost applied per modern technology marker match.
- `legacyMarkerPenalty` — Penalty applied per legacy technology marker match.
- `excludePenalty` — Penalty applied per excluded term match.
- `missingMustHavePenalty` — Penalty applied per missing must-have term.

### `RecommendSkillsResult`

The complete result of a skill recommendation operation.

```typescript
RecommendSkillsResult
```

**Members:**

- `criteria` — The normalized criteria used for scoring.
- `ranking` — Skills ranked by recommendation score, highest first.

### `SearchSkillsOptions`

Options for searching skills via marketplace APIs.

```typescript
SearchSkillsOptions
```

**Members:**

- `limit` — Maximum number of results to return.

### `RecommendSkillsQueryOptions`

Options for the recommendation query combining ranking options with a result limit.

```typescript
RecommendSkillsQueryOptions
```

**Members:**

- `limit` — Maximum number of results to return.

### `ValidationIssue`

A single validation issue found during SKILL.md validation.

```typescript
ValidationIssue
```

**Members:**

- `level` — Severity: `"error"` causes validation failure, `"warning"` does not.
- `field` — The field or section that triggered the issue.
- `message` — Human-readable description of the issue.

```typescript
const issue: ValidationIssue = {
  level: "error",
  field: "name",
  message: "Missing required field: name",
};
```

### `ValidationResult`

Result of validating a SKILL.md file against the Agent Skills standard.

```typescript
ValidationResult
```

**Members:**

- `valid` — Whether the skill passed validation (no error-level issues).
- `issues` — All issues found during validation.
- `metadata` — Parsed frontmatter metadata, or `null` if parsing failed.

```typescript
const result = await validateSkill("/path/to/SKILL.md");
if (!result.valid) {
  for (const issue of result.issues) {
    console.log(`[${issue.level}] ${issue.field}: ${issue.message}`);
  }
}
```

### `SpawnOptions`

Options for spawning a subagent.

```typescript
SpawnOptions
```

**Members:**

- `prompt` — The prompt or instruction to give the spawned agent.
- `model` — Model to use for the spawned agent.
- `tools` — Tools to make available to the spawned agent.
- `timeout` — Timeout in milliseconds for the spawned agent.
- `isolate` — Whether to isolate the spawned agent (e.g. in a worktree).

### `SpawnResult`

Result from a spawn operation.

```typescript
SpawnResult
```

**Members:**

- `instanceId` — Unique identifier for the spawned agent instance.
- `status` — Current status of the spawned agent.
- `output` — Output produced by the spawned agent.

### `SpawnAdapter`

Provider-neutral interface for spawning and managing subagents.  Concrete implementations will be provider-specific (e.g. ClaudeCodeSpawnAdapter, CodexSpawnAdapter) and registered by CLEO's orchestration layer.

```typescript
SpawnAdapter
```

**Members:**

- `canSpawn` — Check if a provider supports spawning via this adapter.
- `spawn` — Spawn a new subagent for the given provider.
- `listRunning` — List currently running subagent instances.
- `terminate` — Terminate a running subagent instance.

### `SkillIntegrityStatus`

Status of a single skill's integrity check.

```typescript
SkillIntegrityStatus
```

### `SkillIntegrityResult`

Result of checking a single skill's integrity.

```typescript
SkillIntegrityResult
```

**Members:**

- `name` — Skill name.
- `status` — Overall integrity status.
- `canonicalExists` — Whether the canonical directory exists.
- `canonicalPath` — Expected canonical path from lock file.
- `linkStatuses` — Provider link statuses — which agents have valid symlinks.
- `isCaampOwned` — Whether this is a CAAMP-reserved (ct-*) skill.
- `issue` — Human-readable issue description, if any.

### `ResolvedImports`

Result of resolving `@import` lines in content.

```typescript
ResolvedImports
```

**Members:**

- `resolvedContent` — Content with `@import` lines replaced by their resolved markdown.
- `importedFiles` — Absolute paths of successfully resolved .cant files.
- `errors` — Error messages for failed resolutions.

### `WellKnownSkill`

A skill entry discovered via the RFC 8615 well-known endpoint.

```typescript
WellKnownSkill
```

**Members:**

- `name` — Skill name.
- `description` — Human-readable description of the skill.
- `url` — URL where the skill content can be fetched.

## Classes

### `PiRequiredError`

Error raised when `getExclusivityMode` resolves to `'force-pi'` but Pi is not installed at the moment a runtime dispatch is requested.

```typescript
typeof PiRequiredError
```

**Members:**

- `code` — LAFS-stable error code identifying this failure mode.

```typescript
try {
  const targets = resolveDefaultTargetProviders();
} catch (err) {
  if (err instanceof PiRequiredError) {
    process.exit(4);
  }
  throw err;
}
```

### `PiHarness`

Pi coding agent harness — CAAMP's first-class primary harness.

```typescript
typeof PiHarness
```

**Members:**

- `id` — Provider id, always `"pi"`.
- `skillsDir` — Resolve the skills directory for a given scope.
- `settingsPath` — Resolve the settings.json path for a given scope.
- `agentsMdPath` — Resolve the AGENTS.md instruction file path for a given scope.
- `installSkill` — Install a skill directory into the resolved Pi skills location.
- `removeSkill` — Remove a skill directory from the resolved Pi skills location.
- `listSkills` — List the installed skill directories at the given scope.
- `injectInstructions` — Inject or replace a CAAMP-managed instruction block inside the Pi `AGENTS.md` file for the resolved scope.
- `removeInstructions` — Remove the CAAMP-managed instruction block from the Pi `AGENTS.md` file at the resolved scope.
- `spawnSubagent` — Spawn a subagent through Pi's configured `spawnCommand` and return a live handle bound to the canonical streaming, attribution, and cleanup contract.
- `raceSubagents` — Race a set of subagent handles, returning the first one that exits.
- `settleAllSubagents` — Settle a set of subagent handles, returning a parallel array of results.
- `handleStdoutLine` — Per-line stdout dispatcher used by the streaming buffer flusher.
- `readSettings` — Read the Pi `settings.json` file for the resolved scope.
- `writeSettings` — Merge a partial patch into the Pi `settings.json` file for the resolved scope using an atomic write.
- `configureModels` — Persist the supplied model-name patterns into `settings.enabledModels` at the resolved scope.
- `modelsConfigPath` — Resolve the `models.json` path for a given legacy two-tier scope.
- `sessionsDir` — Resolve the sessions directory — always user-tier because Pi owns session storage and the three-tier model folds session listings to the single authoritative location per ADR-035 §D2.
- `installExtension` — Install a Pi extension `.ts` source file into the resolved tier's extensions directory, validating that it has a default export.
- `removeExtension` — Remove a Pi extension `.ts` source file from the resolved tier.
- `listExtensions` — List Pi extension files across every tier in precedence order, flagging shadowed entries from lower tiers.
- `listSessions` — List Pi session JSONL files (including subagent children when requested), summarising only the header line per file.
- `showSession` — Show the full entries of a single Pi session by id.
- `readModelsConfig` — Read the Pi `models.json` file for the resolved scope, tolerating missing or malformed files by returning an empty provider map.
- `writeModelsConfig` — Write the Pi `models.json` file for the resolved scope via an atomic tmp-then-rename sequence.
- `listModels` — Compose a flat `ModelListEntry` list from `models.json` plus the `enabledModels` and default-model hints in `settings.json`.
- `installPrompt` — Install a Pi prompt directory (containing `prompt.md`) into the resolved tier's prompts directory.
- `listPrompts` — List Pi prompt directories across every tier in precedence order, flagging shadowed entries from lower tiers.
- `removePrompt` — Remove a Pi prompt directory from the resolved tier.
- `installTheme` — Install a Pi theme file (`.ts`/`.tsx`/`.mts`/`.json`) into the resolved tier's themes directory, blocking same-stem conflicts unless `--force` is supplied.
- `listThemes` — List Pi theme files across every tier in precedence order, flagging shadowed entries from lower tiers.
- `removeTheme` — Remove a Pi theme from the resolved tier, matching any of the supported theme extensions for the given name stem.
- `installCantProfile` — Install a `.cant` profile into the resolved tier after passing it through the cant-core validator.  Validates the source via `PiHarness.validateCantProfile` before copying so we never persist a `.cant` file the runtime bridge cannot load. The target layout is `<tier-root>/cant/<name>.cant`, resolved through `resolveTierDir` so the project/user/global hierarchy stays consistent with the other Wave-1 verbs.
- `removeCantProfile` — Remove a `.cant` profile from the resolved tier.
- `listCantProfiles` — List installed `.cant` profiles across every tier in precedence order, parsing each file to extract section counts.  Walks every tier in `TIER_PRECEDENCE` order, parsing each discovered `.cant` file via cant-core to extract a `CantProfileCounts` bag. Higher-precedence tiers shadow lower-precedence entries with the same name; shadowed entries still appear in the result but carry the `shadowedByHigherTier` flag so callers can render the precedence story without losing visibility of the duplicate.
- `validateCantProfile` — Validate a `.cant` source file against cant-core's parser and 42-rule linter, returning section counts and per-diagnostic detail.  Pure validator. Reads the file, runs `parseDocument` to derive counts (when parsing succeeds) and `validateDocument` to collect the 42-rule diagnostic feed. The two calls are kept independent so we can still report counts for files that pass parsing but fail a lint rule.

### `LAFSCommandError`

Structured error class for LAFS-compliant command failures with error codes and recovery hints.

```typescript
typeof LAFSCommandError
```

**Members:**

- `code` — LAFS error code identifying the failure type.
- `category` — LAFS error category inferred from the error code.
- `recoverable` — Whether the operation can be retried after fixing the root cause.
- `suggestion` — Human-readable suggestion for resolving the error.
- `retryAfterMs` — Optional delay in milliseconds before retrying, or null.
- `details` — Optional additional error details payload.

### `NetworkError`

Structured error for network failures with categorized kind.

```typescript
typeof NetworkError
```

**Members:**

- `kind` — Classification of the failure.
- `url` — URL that was being fetched.
- `status` — HTTP status code (only present for `"http"` kind).

### `SkillsMPAdapter`

Marketplace adapter for the agentskills.in API.

```typescript
typeof SkillsMPAdapter
```

**Members:**

- `name` — The marketplace identifier used in search results.
- `search` — Search for skills by query string.
- `getSkill` — Look up a specific skill by its scoped name.

### `SkillsShAdapter`

Marketplace adapter for the skills.sh API.

```typescript
typeof SkillsShAdapter
```

**Members:**

- `name` — The marketplace identifier used in search results.
- `search` — Search for skills by query string.
- `getSkill` — Look up a specific skill by its scoped name.

### `MarketplaceUnavailableError`

Error thrown when all marketplace sources fail to respond.

```typescript
typeof MarketplaceUnavailableError
```

**Members:**

- `details` — Per-adapter failure messages.

### `MarketplaceClient`

Unified marketplace client that aggregates results from multiple marketplace adapters.  Queries all configured marketplaces in parallel, deduplicates results by scoped name, and sorts by star count.

```typescript
typeof MarketplaceClient
```

**Members:**

- `adapters` — Configured marketplace adapters.
- `search` — Search all marketplaces and return deduplicated, sorted results.  Queries all adapters in parallel and deduplicates by `scopedName`, keeping the entry with the highest star count. Results are sorted by stars descending.
- `getSkill` — Get a specific skill by its scoped name from any marketplace.  Tries each adapter in order and returns the first match.

```typescript
const client = new MarketplaceClient();
const results = await client.search("filesystem");
for (const r of results) {
  console.log(`${r.scopedName} (${r.stars} stars)`);
}
```

## Constants

### `AGENTS_HOME`

Global `.agents/` home directory (`~/.agents/` or `$AGENTS_HOME`).

```typescript
string
```

### `LOCK_FILE_PATH`

CAAMP lock file path (`~/.agents/.caamp-lock.json`).

```typescript
string
```

### `CANONICAL_SKILLS_DIR`

Canonical skills directory (`~/.agents/skills/`).

```typescript
string
```

### `AGENTS_MCP_DIR`

Global MCP directory (`~/.agents/mcp/`).

```typescript
string
```

### `AGENTS_MCP_SERVERS_PATH`

Global MCP servers.json path (`~/.agents/mcp/servers.json`).

```typescript
string
```

### `AGENTS_CONFIG_PATH`

Global agents config.toml path (`~/.agents/config.toml`).

```typescript
string
```

### `TIER_PRECEDENCE`

Precedence-ordered iteration of tiers for read operations.

```typescript
readonly HarnessTier[]
```

### `DEFAULT_EXCLUSIVITY_MODE`

Default exclusivity mode used when no override is configured.

```typescript
ExclusivityMode
```

### `EXCLUSIVITY_MODE_ENV_VAR`

Environment variable name read by `getExclusivityMode` when no programmatic override is active.

```typescript
"CAAMP_EXCLUSIVITY_MODE"
```

### `ErrorCategories`

Common error categories mapping for convenience.

```typescript
{ readonly VALIDATION: LAFSErrorCategory; readonly AUTH: LAFSErrorCategory; readonly PERMISSION: LAFSErrorCategory; readonly NOT_FOUND: LAFSErrorCategory; readonly CONFLICT: LAFSErrorCategory; readonly RATE_LIMIT: LAFSErrorCategory; readonly TRANSIENT: LAFSErrorCategory; readonly INTERNAL: LAFSErrorCategory; readonly CONTRACT: LAFSErrorCategory; readonly MIGRATION: LAFSErrorCategory; }
```

### `ErrorCodes`

Common error codes for consistency.

```typescript
{ readonly FORMAT_CONFLICT: "E_FORMAT_CONFLICT"; readonly INVALID_JSON: "E_INVALID_JSON"; readonly SKILL_NOT_FOUND: "E_SKILL_NOT_FOUND"; readonly PROVIDER_NOT_FOUND: "E_PROVIDER_NOT_FOUND"; readonly MCP_SERVER_NOT_FOUND: "E_MCP_SERVER_NOT_FOUND"; readonly FILE_NOT_FOUND: "E_FILE_NOT_FOUND"; readonly INVALID_INPUT: "E_INVALID_INPUT"; readonly INVALID_CONSTRAINT: "E_INVALID_CONSTRAINT"; readonly INVALID_FORMAT: "E_INVALID_FORMAT"; readonly INSTALL_FAILED: "E_INSTALL_FAILED"; readonly REMOVE_FAILED: "E_REMOVE_FAILED"; readonly UPDATE_FAILED: "E_UPDATE_FAILED"; readonly VALIDATION_FAILED: "E_VALIDATION_FAILED"; readonly AUDIT_FAILED: "E_AUDIT_FAILED"; readonly NETWORK_ERROR: "E_NETWORK_ERROR"; readonly FILE_SYSTEM_ERROR: "E_FILE_SYSTEM_ERROR"; readonly PERMISSION_DENIED: "E_PERMISSION_DENIED"; readonly INTERNAL_ERROR: "E_INTERNAL_ERROR"; }
```

### `MCP_ERROR_CODES`

Canonical LAFS error codes used by the `caamp mcp` command group.

```typescript
{ readonly VALIDATION: "E_VALIDATION_SCHEMA"; readonly NOT_FOUND: "E_NOT_FOUND_RESOURCE"; readonly CONFLICT: "E_CONFLICT_VERSION"; readonly TRANSIENT: "E_TRANSIENT_UPSTREAM"; }
```

### `DEFAULT_FETCH_TIMEOUT_MS`

Default timeout in milliseconds for outbound HTTP requests.

```typescript
10000
```

### `PI_ERROR_CODES`

Canonical LAFS error codes used by the `caamp pi` command group.

```typescript
{ readonly VALIDATION: "E_VALIDATION_SCHEMA"; readonly NOT_FOUND: "E_NOT_FOUND_RESOURCE"; readonly CONFLICT: "E_CONFLICT_VERSION"; readonly TRANSIENT: "E_TRANSIENT_UPSTREAM"; }
```

### `HOOK_CATEGORIES`

All hook event categories (8 total).

```typescript
readonly ["agent", "context", "memory", "pipeline", "prompt", "session", "task", "tool"]
```

### `EVENT_SOURCES`

Event source types: domain, provider.

```typescript
readonly ["domain", "provider"]
```

### `CANONICAL_HOOK_EVENTS`

All canonical hook events (31 total: 16 provider, 15 domain).  This replaces the previously hardcoded tuple in types.ts. Single source of truth: providers/hook-mappings.json

```typescript
readonly ["ConfigChange", "Notification", "PermissionRequest", "PostCompact", "PostModel", "PostToolUse", "PostToolUseFailure", "PreCompact", "PreModel", "PreToolUse", "PromptSubmit", "ResponseComplete", "SessionEnd", "SessionStart", "SubagentStart", "SubagentStop", "ApprovalExpired", "ApprovalGranted", "ApprovalRequested", "MemoryDecisionStored", "MemoryLearningStored", "MemoryObserved", "MemoryPatternStored", "PipelineManifestAppended", "PipelineStageCompleted", "SessionEnded", "SessionStarted", "TaskBlocked", "TaskCompleted", "TaskCreated", "TaskStarted"]
```

### `PROVIDER_HOOK_EVENTS`

Provider-sourced events only (original 16 CAAMP events).

```typescript
readonly ["ConfigChange", "Notification", "PermissionRequest", "PostCompact", "PostModel", "PostToolUse", "PostToolUseFailure", "PreCompact", "PreModel", "PreToolUse", "PromptSubmit", "ResponseComplete", "SessionEnd", "SessionStart", "SubagentStart", "SubagentStop"]
```

### `DOMAIN_HOOK_EVENTS`

Domain-sourced events only (CLEO business events).

```typescript
readonly ["ApprovalExpired", "ApprovalGranted", "ApprovalRequested", "MemoryDecisionStored", "MemoryLearningStored", "MemoryObserved", "MemoryPatternStored", "PipelineManifestAppended", "PipelineStageCompleted", "SessionEnded", "SessionStarted", "TaskBlocked", "TaskCompleted", "TaskCreated", "TaskStarted"]
```

### `EVENT_METADATA`

Metadata for each canonical event, derived from hook-mappings.json.

```typescript
Record<"ConfigChange" | "Notification" | "PermissionRequest" | "PostCompact" | "PostModel" | "PostToolUse" | "PostToolUseFailure" | "PreCompact" | "PreModel" | "PreToolUse" | "PromptSubmit" | "ResponseComplete" | "SessionEnd" | "SessionStart" | "SubagentStart" | "SubagentStop" | "ApprovalExpired" | "ApprovalGranted" | "ApprovalRequested" | "MemoryDecisionStored" | "MemoryLearningStored" | "MemoryObserved" | "MemoryPatternStored" | "PipelineManifestAppended" | "PipelineStageCompleted" | "SessionEnded" | "SessionStarted" | "TaskBlocked" | "TaskCompleted" | "TaskCreated" | "TaskStarted", { category: HookCategory; source: EventSource; canBlock: boolean; description: string; }>
```

### `AUDIT_RULES`

Complete set of security audit rules for SKILL.md scanning.

```typescript
AuditRule[]
```

### `RECOMMENDATION_ERROR_CODES`

Error codes used in skill recommendation validation.

```typescript
{ readonly QUERY_INVALID: "E_SKILLS_QUERY_INVALID"; readonly NO_MATCHES: "E_SKILLS_NO_MATCHES"; readonly SOURCE_UNAVAILABLE: "E_SKILLS_SOURCE_UNAVAILABLE"; readonly CRITERIA_CONFLICT: "E_SKILLS_CRITERIA_CONFLICT"; }
```

### `rankSkills`

Alias for `recommendSkills` providing a shorter function name.

```typescript
(skills: MarketplaceResult[], criteriaInput: RecommendationCriteriaInput, options?: RecommendationOptions) => RecommendSkillsResult
```
