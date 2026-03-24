# CAAMP API Reference

> **@cleocode/caamp** -- Central AI Agent Managed Packages

## Overview

CAAMP is a unified library for managing AI coding agent configurations, MCP servers, and agent skills across multiple providers (Claude Code, Cursor, Windsurf, Codex, and more). It provides a single API surface for provider detection, MCP server installation, skill management, security auditing, and instruction file injection.

### Installation

```bash
npm install @cleocode/caamp
```

### Import

```typescript
import {
  getAllProviders,
  listAllMcpServers,
  installSkill,
  detectAllProviders,
} from "@cleocode/caamp";
```

## Quick Start

```typescript
import { getAllProviders, getInstalledProviders, listAllMcpServers } from "@cleocode/caamp";

// Get all registered providers
const providers = getAllProviders();

// Detect which are installed on this system
const installed = getInstalledProviders();

// List MCP servers across all installed providers
const servers = await listAllMcpServers(installed, "global");
```

---

## Table of Contents

- [Types](#types)
  - [Core Types](#core-types)
  - [Result Types](#result-types)
  - [Data Types](#data-types)
- [Provider Registry](#provider-registry)
- [Provider Capabilities](#provider-capabilities)
- [Detection](#detection)
- [Source Parsing](#source-parsing)
- [MCP -- Installation](#mcp--installation)
- [MCP -- Reading & Listing](#mcp--reading--listing)
- [MCP -- Lock File](#mcp--lock-file)
- [MCP -- Transforms](#mcp--transforms)
- [MCP -- CLEO](#mcp--cleo)
- [Skills -- Recommendation](#skills--recommendation)
- [Skills -- Installation](#skills--installation)
- [Skills -- Discovery](#skills--discovery)
- [Skills -- Validation](#skills--validation)
- [Skills -- Audit](#skills--audit)
- [Skills -- Lock File](#skills--lock-file)
- [Advanced orchestration](#advanced-orchestration)
- [Formats](#formats)
- [Instructions](#instructions)
- [Marketplace](#marketplace)
- [Logger](#logger)
- [Complete Export List](#complete-export-list)

---

## Advanced Recipes

For end-to-end orchestration patterns that combine multiple APIs, see [Advanced Recipes](ADVANCED-RECIPES.md).

---

## Types

### Core Types

#### `ConfigFormat`

Supported configuration file formats for agent config files.

```typescript
type ConfigFormat = "json" | "jsonc" | "yaml" | "toml";
```

#### `TransportType`

MCP server transport protocols.

```typescript
type TransportType = "stdio" | "sse" | "http";
```

#### `SourceType`

Classification of MCP server or skill source inputs.

```typescript
type SourceType = "remote" | "package" | "command" | "github" | "gitlab" | "local";
```

#### `ProviderPriority`

Priority tier for provider ordering.

```typescript
type ProviderPriority = "high" | "medium" | "low";
```

#### `ProviderStatus`

Lifecycle status of a provider.

```typescript
type ProviderStatus = "active" | "beta" | "deprecated" | "planned";
```

#### `Provider`

Full definition of an AI coding agent provider with paths, config, detection, and capability metadata.

```typescript
interface Provider {
  id: string;
  toolName: string;
  vendor: string;
  agentFlag: string;
  aliases: string[];
  pathGlobal: string;
  pathProject: string;
  instructFile: string;
  configKey: string;
  configFormat: ConfigFormat;
  configPathGlobal: string;
  configPathProject: string | null;
  pathSkills: string;
  pathProjectSkills: string;
  detection: DetectionConfig;
  supportedTransports: TransportType[];
  supportsHeaders: boolean;
  priority: ProviderPriority;
  status: ProviderStatus;
  agentSkillsCompatible: boolean;
  capabilities: ProviderCapabilities;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Unique provider identifier (e.g., `"claude-code"`) |
| `toolName` | `string` | Human-readable tool name |
| `vendor` | `string` | Vendor/company name |
| `agentFlag` | `string` | CLI flag name for this agent |
| `aliases` | `string[]` | Alternative names for resolution |
| `pathGlobal` | `string` | Resolved global instructions directory path |
| `pathProject` | `string` | Project-level instructions relative path |
| `instructFile` | `string` | Instruction file name (e.g., `"CLAUDE.md"`) |
| `configKey` | `string` | Dot-notation key for MCP servers in config (e.g., `"mcpServers"`) |
| `configFormat` | `ConfigFormat` | Format of the config file |
| `configPathGlobal` | `string` | Resolved global config file path |
| `configPathProject` | `string \| null` | Project config file relative path (`null` if unsupported) |
| `pathSkills` | `string` | Resolved global skills directory path |
| `pathProjectSkills` | `string` | Project skills relative path |
| `detection` | `DetectionConfig` | Auto-detection configuration |
| `supportedTransports` | `TransportType[]` | Supported MCP transport types |
| `supportsHeaders` | `boolean` | Whether provider supports HTTP headers in config |
| `priority` | `ProviderPriority` | Priority tier (`"high"` \| `"medium"` \| `"low"`) |
| `status` | `ProviderStatus` | Lifecycle status (`"active"` \| `"beta"` \| `"deprecated"` \| `"planned"`) |
| `agentSkillsCompatible` | `boolean` | Whether provider supports agent skills |
| `capabilities` | `ProviderCapabilities` | Provider capabilities for skills, hooks, and spawn (always populated at runtime) |

#### `SkillsPrecedence`

How a provider resolves skill file lookup order.

```typescript
type SkillsPrecedence =
  | "vendor-only"           // Uses only provider's native skills dir
  | "agents-canonical"      // Uses only .agents/skills
  | "agents-first"          // .agents/skills first, then vendor
  | "agents-supported"      // Vendor first, .agents/skills as fallback
  | "vendor-global-agents-project"; // Global=vendor, project=.agents+vendor
```

#### `HookEvent`

Lifecycle events a provider can trigger hooks for.

```typescript
type HookEvent =
  | "onSessionStart" | "onSessionEnd"
  | "onToolStart" | "onToolComplete"
  | "onFileChange" | "onError"
  | "onPromptSubmit" | "onResponseComplete";
```

#### `SpawnMechanism`

How a provider spawns subagents.

```typescript
type SpawnMechanism = "native" | "mcp" | "cli" | "api";
```

#### `ProviderCapabilities`

Unified capabilities object present on every resolved `Provider`.

```typescript
interface ProviderCapabilities {
  skills: ProviderSkillsCapability;
  hooks: ProviderHooksCapability;
  spawn: ProviderSpawnCapability;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `skills` | `ProviderSkillsCapability` | Skills path resolution and precedence |
| `hooks` | `ProviderHooksCapability` | Hook/lifecycle event support |
| `spawn` | `ProviderSpawnCapability` | Subagent spawn capabilities |

#### `ProviderSkillsCapability`

Skills path resolution and precedence configuration.

```typescript
interface ProviderSkillsCapability {
  agentsGlobalPath: string | null;
  agentsProjectPath: string | null;
  precedence: SkillsPrecedence;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `agentsGlobalPath` | `string \| null` | Resolved global `.agents/skills` path, or `null` if unsupported |
| `agentsProjectPath` | `string \| null` | Project-relative `.agents/skills` path, or `null` if unsupported |
| `precedence` | `SkillsPrecedence` | How this provider resolves skill file precedence |

#### `ProviderHooksCapability`

Hook/lifecycle event support configuration.

```typescript
interface ProviderHooksCapability {
  supported: HookEvent[];
  hookConfigPath: string | null;
  hookFormat: "json" | "yaml" | "toml" | "javascript" | null;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `supported` | `HookEvent[]` | Hook lifecycle events this provider supports |
| `hookConfigPath` | `string \| null` | Resolved path to hook configuration file, or `null` |
| `hookFormat` | `"json" \| "yaml" \| "toml" \| "javascript" \| null` | Format of the hook config file |

#### `ProviderSpawnCapability`

Subagent spawn capability configuration.

```typescript
interface ProviderSpawnCapability {
  supportsSubagents: boolean;
  supportsProgrammaticSpawn: boolean;
  supportsInterAgentComms: boolean;
  supportsParallelSpawn: boolean;
  spawnMechanism: SpawnMechanism | null;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `supportsSubagents` | `boolean` | Whether the provider supports spawning subagents |
| `supportsProgrammaticSpawn` | `boolean` | Whether subagents can be spawned programmatically |
| `supportsInterAgentComms` | `boolean` | Whether spawned agents can communicate with each other |
| `supportsParallelSpawn` | `boolean` | Whether multiple agents can be spawned in parallel |
| `spawnMechanism` | `SpawnMechanism \| null` | Mechanism used for spawning |

#### `SpawnAdapter`

Provider-neutral interface for subagent orchestration (interface only -- no concrete implementations).

```typescript
interface SpawnOptions {
  prompt: string;
  model?: string;
  tools?: string[];
  timeout?: number;
  isolate?: boolean;
}

interface SpawnResult {
  instanceId: string;
  status: "running" | "completed" | "failed";
  output?: string;
}

interface SpawnAdapter {
  canSpawn(provider: Provider): boolean;
  spawn(provider: Provider, options: SpawnOptions): Promise<SpawnResult>;
  listRunning(provider: Provider): Promise<SpawnResult[]>;
  terminate(provider: Provider, instanceId: string): Promise<void>;
}
```

**`SpawnOptions`**

| Property | Type | Description |
|----------|------|-------------|
| `prompt` | `string` | The prompt or instruction to give the spawned agent |
| `model` | `string` | Model to use for the spawned agent (optional) |
| `tools` | `string[]` | Tools to make available to the spawned agent (optional) |
| `timeout` | `number` | Timeout in milliseconds for the spawned agent (optional) |
| `isolate` | `boolean` | Whether to isolate the spawned agent, e.g. in a worktree (optional) |

**`SpawnResult`**

| Property | Type | Description |
|----------|------|-------------|
| `instanceId` | `string` | Unique identifier for the spawned agent instance |
| `status` | `"running" \| "completed" \| "failed"` | Current status of the spawned agent |
| `output` | `string` | Output produced by the spawned agent (optional) |

**`SpawnAdapter`**

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `canSpawn` | `provider: Provider` | `boolean` | Check if a provider supports spawning via this adapter |
| `spawn` | `provider: Provider, options: SpawnOptions` | `Promise<SpawnResult>` | Spawn a new subagent for the given provider |
| `listRunning` | `provider: Provider` | `Promise<SpawnResult[]>` | List currently running subagent instances |
| `terminate` | `provider: Provider, instanceId: string` | `Promise<void>` | Terminate a running subagent instance |

#### `McpServerConfig`

Canonical MCP server configuration (transport-agnostic).

```typescript
interface McpServerConfig {
  type?: TransportType;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `type` | `TransportType` | Transport type (optional) |
| `url` | `string` | Server URL for remote/SSE/HTTP transports |
| `headers` | `Record<string, string>` | HTTP headers |
| `command` | `string` | Command to run (for stdio transport) |
| `args` | `string[]` | Command arguments |
| `env` | `Record<string, string>` | Environment variables |

#### `McpServerEntry`

An MCP server entry as returned by list operations.

```typescript
interface McpServerEntry {
  name: string;
  providerId: string;
  providerName: string;
  scope: "project" | "global";
  configPath: string;
  config: Record<string, unknown>;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Server name/key |
| `providerId` | `string` | Provider that owns this config |
| `providerName` | `string` | Human-readable provider name |
| `scope` | `"project" \| "global"` | Installation scope |
| `configPath` | `string` | Absolute path to the config file |
| `config` | `Record<string, unknown>` | Raw config object |

#### `ParsedSource`

Result of classifying a source string (URL, package, GitHub shorthand, etc.).

```typescript
interface ParsedSource {
  type: SourceType;
  value: string;
  inferredName: string;
  owner?: string;
  repo?: string;
  path?: string;
  ref?: string;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `type` | `SourceType` | Classified source type |
| `value` | `string` | Normalized/resolved value |
| `inferredName` | `string` | Best-guess display name |
| `owner` | `string` | GitHub/GitLab repository owner (optional) |
| `repo` | `string` | GitHub/GitLab repository name (optional) |
| `path` | `string` | Sub-path within repository (optional) |
| `ref` | `string` | Git ref -- branch/tag (optional) |

#### `GlobalOptions`

CLI-level global options passed through commands.

```typescript
interface GlobalOptions {
  agent?: string[];
  global?: boolean;
  yes?: boolean;
  all?: boolean;
  json?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  quiet?: boolean;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `agent` | `string[]` | Target agent IDs |
| `global` | `boolean` | Use global scope |
| `yes` | `boolean` | Skip confirmation prompts |
| `all` | `boolean` | Target all providers |
| `json` | `boolean` | Output as JSON |
| `dryRun` | `boolean` | Preview without writing |
| `verbose` | `boolean` | Enable debug output |
| `quiet` | `boolean` | Suppress non-error output |

#### `AuditSeverity`

Severity levels for security audit findings.

```typescript
type AuditSeverity = "critical" | "high" | "medium" | "low" | "info";
```

#### `InjectionStatus`

Status of a CAAMP injection block in an instruction file.

```typescript
type InjectionStatus = "current" | "outdated" | "missing" | "none";
```

---

### Result Types

#### `DetectionResult`

Result of detecting whether a provider is installed.

```typescript
interface DetectionResult {
  provider: Provider;
  installed: boolean;
  methods: string[];
  projectDetected: boolean;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `provider` | `Provider` | The provider that was checked |
| `installed` | `boolean` | Whether the provider was detected |
| `methods` | `string[]` | Detection methods that matched (e.g., `"binary"`, `"directory"`) |
| `projectDetected` | `boolean` | Whether project-level config exists |

#### `InstallResult`

Result of installing an MCP server config to a provider.

```typescript
interface InstallResult {
  provider: Provider;
  scope: "project" | "global";
  configPath: string;
  success: boolean;
  error?: string;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `provider` | `Provider` | Target provider |
| `scope` | `"project" \| "global"` | Installation scope |
| `configPath` | `string` | Path where config was written |
| `success` | `boolean` | Whether the write succeeded |
| `error` | `string` | Error message on failure (optional) |

#### `SkillInstallResult`

Result of a skill installation operation.

```typescript
interface SkillInstallResult {
  name: string;
  canonicalPath: string;
  linkedAgents: string[];
  errors: string[];
  success: boolean;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Skill name |
| `canonicalPath` | `string` | Path to canonical copy at `getCanonicalSkillsDir()/&lt;name&gt;` (default `~/.agents/skills/<name>/`) |
| `linkedAgents` | `string[]` | Provider IDs successfully linked |
| `errors` | `string[]` | Error messages from failed links |
| `success` | `boolean` | True if at least one agent was linked |

#### `ValidationResult`

Complete validation result for a SKILL.md file.

```typescript
interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  metadata: Record<string, unknown> | null;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `valid` | `boolean` | True if no errors (warnings are OK) |
| `issues` | `ValidationIssue[]` | All found issues |
| `metadata` | `Record<string, unknown> \| null` | Parsed frontmatter (`null` on parse failure) |

#### `ValidationIssue`

A single validation issue found during SKILL.md validation.

```typescript
interface ValidationIssue {
  level: "error" | "warning";
  field: string;
  message: string;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `level` | `"error" \| "warning"` | Severity level |
| `field` | `string` | Which field has the issue (e.g., `"name"`, `"description"`, `"body"`) |
| `message` | `string` | Human-readable issue description |

#### `InjectionCheckResult`

Result of checking injection status for one file.

```typescript
interface InjectionCheckResult {
  file: string;
  provider: string;
  status: InjectionStatus;
  fileExists: boolean;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `file` | `string` | File path checked |
| `provider` | `string` | Provider ID |
| `status` | `InjectionStatus` | Current injection status |
| `fileExists` | `boolean` | Whether the file exists on disk |

---

### Data Types

#### `SkillMetadata`

Parsed SKILL.md frontmatter metadata.

```typescript
interface SkillMetadata {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
  version?: string;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Skill name |
| `description` | `string` | Skill description |
| `license` | `string` | License identifier (optional) |
| `compatibility` | `string` | Compatibility string (optional) |
| `metadata` | `Record<string, string>` | Additional key-value metadata (optional) |
| `allowedTools` | `string[]` | Allowed tool list (optional) |
| `version` | `string` | Skill version (optional) |

#### `SkillEntry`

A discovered skill with its path and parsed metadata.

```typescript
interface SkillEntry {
  name: string;
  scopedName: string;
  path: string;
  metadata: SkillMetadata;
  source?: string;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Skill name |
| `scopedName` | `string` | Scoped name for identification |
| `path` | `string` | Absolute path to skill directory |
| `metadata` | `SkillMetadata` | Parsed metadata |
| `source` | `string` | Installation source (optional) |

#### `LockEntry`

A tracked installation entry in the lock file.

```typescript
interface LockEntry {
  name: string;
  scopedName: string;
  source: string;
  sourceType: SourceType;
  version?: string;
  installedAt: string;
  updatedAt?: string;
  agents: string[];
  canonicalPath: string;
  isGlobal: boolean;
  projectDir?: string;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Entry name |
| `scopedName` | `string` | Scoped name |
| `source` | `string` | Original source string |
| `sourceType` | `SourceType` | Classified source type |
| `version` | `string` | Installed version (optional) |
| `installedAt` | `string` | ISO timestamp of first install |
| `updatedAt` | `string` | ISO timestamp of last update (optional) |
| `agents` | `string[]` | Provider IDs this is installed to |
| `canonicalPath` | `string` | Canonical storage path |
| `isGlobal` | `boolean` | Whether installed globally |
| `projectDir` | `string` | Project directory, if project-scoped (optional) |

#### `CaampLockFile`

Top-level lock file structure at `getLockFilePath()` (default `~/.agents/.caamp-lock.json`).

```typescript
interface CaampLockFile {
  version: 1;
  skills: Record<string, LockEntry>;
  mcpServers: Record<string, LockEntry>;
  lastSelectedAgents?: string[];
}
```

| Property | Type | Description |
|----------|------|-------------|
| `version` | `1` | Lock file schema version (literal `1`) |
| `skills` | `Record<string, LockEntry>` | Tracked skill installations |
| `mcpServers` | `Record<string, LockEntry>` | Tracked MCP server installations |
| `lastSelectedAgents` | `string[]` | Last selected agents for UX persistence (optional) |

#### `MarketplaceSkill`

A skill listing from a marketplace source.

```typescript
interface MarketplaceSkill {
  id: string;
  name: string;
  scopedName: string;
  description: string;
  author: string;
  stars: number;
  forks: number;
  githubUrl: string;
  repoFullName: string;
  path: string;
  category?: string;
  hasContent: boolean;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Unique identifier |
| `name` | `string` | Skill name |
| `scopedName` | `string` | Scoped name (e.g., `"@author/name"`) |
| `description` | `string` | Description text |
| `author` | `string` | Author name |
| `stars` | `number` | GitHub star count |
| `forks` | `number` | GitHub fork count |
| `githubUrl` | `string` | GitHub repository URL |
| `repoFullName` | `string` | Full `"owner/repo"` name |
| `path` | `string` | Path within repository |
| `category` | `string` | Category (optional) |
| `hasContent` | `boolean` | Whether content was fetched |

#### `MarketplaceResult`

A skill result returned by marketplace adapters (used by `MarketplaceClient.search()` and `MarketplaceClient.getSkill()`). This is distinct from `MarketplaceSkill`, which is the type used in `MarketplaceSearchResult`.

```typescript
interface MarketplaceResult {
  name: string;
  scopedName: string;
  description: string;
  author: string;
  stars: number;
  githubUrl: string;
  repoFullName: string;
  path: string;
  source: string;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Skill name |
| `scopedName` | `string` | Scoped name (e.g., `"@author/name"`) |
| `description` | `string` | Description text |
| `author` | `string` | Author name |
| `stars` | `number` | GitHub star count |
| `githubUrl` | `string` | GitHub repository URL |
| `repoFullName` | `string` | Full `"owner/repo"` name |
| `path` | `string` | Path within repository |
| `source` | `string` | Which marketplace the result came from |

#### `MarketplaceSearchResult`

Paginated marketplace search response.

```typescript
interface MarketplaceSearchResult {
  skills: MarketplaceSkill[];
  total: number;
  limit: number;
  offset: number;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `skills` | `MarketplaceSkill[]` | Array of matching skills |
| `total` | `number` | Total number of results |
| `limit` | `number` | Page size |
| `offset` | `number` | Current offset |

#### `AuditRule`

A security scanning rule definition.

```typescript
interface AuditRule {
  id: string;
  name: string;
  description: string;
  severity: AuditSeverity;
  category: string;
  pattern: RegExp;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Rule identifier |
| `name` | `string` | Rule name |
| `description` | `string` | What the rule detects |
| `severity` | `AuditSeverity` | Severity level |
| `category` | `string` | Rule category |
| `pattern` | `RegExp` | Regex pattern to match against |

#### `AuditFinding`

A single security finding within a file.

```typescript
interface AuditFinding {
  rule: AuditRule;
  line: number;
  column: number;
  match: string;
  context: string;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `rule` | `AuditRule` | The matched rule |
| `line` | `number` | Line number (1-based) |
| `column` | `number` | Column number (1-based) |
| `match` | `string` | Matched text |
| `context` | `string` | Trimmed line content for context |

#### `AuditResult`

Aggregated audit result for a single file.

```typescript
interface AuditResult {
  file: string;
  findings: AuditFinding[];
  score: number;
  passed: boolean;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `file` | `string` | File path |
| `findings` | `AuditFinding[]` | All findings |
| `score` | `number` | Security score (100 = clean, 0 = dangerous) |
| `passed` | `boolean` | True if no critical/high findings |

---

## Provider Registry

Functions for querying the provider registry. Providers represent AI coding agents (Claude Code, Cursor, Windsurf, etc.) with their configuration paths, capabilities, and detection settings.

### `getAllProviders()`

Returns all registered providers from the registry, with platform-specific paths resolved.

```typescript
function getAllProviders(): Provider[]
```

**Parameters**: None

**Returns**: `Provider[]` -- Array of all provider definitions.

```typescript
import { getAllProviders } from "@cleocode/caamp";

const providers = getAllProviders();
console.log(providers.map(p => p.id));
// ["claude-code", "cursor", "windsurf", "codex", ...]
```

---

### `getProvider()`

Looks up a provider by its ID or any of its aliases.

```typescript
function getProvider(idOrAlias: string): Provider | undefined
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `idOrAlias` | `string` | Provider ID or alias to resolve |

**Returns**: `Provider | undefined` -- The matching provider, or `undefined` if not found.

```typescript
import { getProvider } from "@cleocode/caamp";

const claude = getProvider("claude-code");
const alsoWorks = getProvider("claude"); // alias
```

---

### `resolveAlias()`

Resolves an alias to its canonical provider ID. Returns the input unchanged if it is not an alias.

```typescript
function resolveAlias(idOrAlias: string): string
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `idOrAlias` | `string` | Provider ID or alias |

**Returns**: `string` -- Canonical provider ID.

```typescript
import { resolveAlias } from "@cleocode/caamp";

resolveAlias("claude");      // "claude-code"
resolveAlias("claude-code"); // "claude-code"
```

---

### `getProvidersByPriority()`

Filters providers by priority tier.

```typescript
function getProvidersByPriority(priority: ProviderPriority): Provider[]
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `priority` | `ProviderPriority` | Priority level (`"high"` \| `"medium"` \| `"low"`) |

**Returns**: `Provider[]` -- Providers matching the priority.

```typescript
import { getProvidersByPriority } from "@cleocode/caamp";

const highPriority = getProvidersByPriority("high");
```

---

### `getProvidersByStatus()`

Filters providers by lifecycle status.

```typescript
function getProvidersByStatus(status: ProviderStatus): Provider[]
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `status` | `ProviderStatus` | Status (`"active"` \| `"beta"` \| `"deprecated"` \| `"planned"`) |

**Returns**: `Provider[]` -- Providers matching the status.

```typescript
import { getProvidersByStatus } from "@cleocode/caamp";

const active = getProvidersByStatus("active");
```

---

### `getProvidersByInstructFile()`

Gets all providers that use a specific instruction file name.

```typescript
function getProvidersByInstructFile(file: string): Provider[]
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `file` | `string` | Instruction file name (e.g., `"CLAUDE.md"`) |

**Returns**: `Provider[]` -- Providers using that instruction file.

```typescript
import { getProvidersByInstructFile } from "@cleocode/caamp";

const claudeMd = getProvidersByInstructFile("CLAUDE.md");
```

---

### `getInstructionFiles()`

Returns all unique instruction file names across all providers.

```typescript
function getInstructionFiles(): string[]
```

**Parameters**: None

**Returns**: `string[]` -- Deduplicated array of instruction file names.

```typescript
import { getInstructionFiles } from "@cleocode/caamp";

const files = getInstructionFiles();
// ["CLAUDE.md", ".cursorrules", "AGENTS.md", ...]
```

---

### `getProviderCount()`

Returns the total number of registered providers.

```typescript
function getProviderCount(): number
```

**Parameters**: None

**Returns**: `number` -- Provider count.

```typescript
import { getProviderCount } from "@cleocode/caamp";

console.log(`${getProviderCount()} providers registered`);
```

---

### `getRegistryVersion()`

Returns the version string from the provider registry.

```typescript
function getRegistryVersion(): string
```

**Parameters**: None

**Returns**: `string` -- Registry version.

```typescript
import { getRegistryVersion } from "@cleocode/caamp";

console.log(getRegistryVersion()); // "1.0.0"
```

---

## Provider Capabilities

Functions for querying provider capabilities -- skills precedence, hook events, spawn support, and cross-provider capability comparison.

### `getProviderCapabilities()`

Get the full capabilities object for a provider by ID or alias.

```typescript
function getProviderCapabilities(idOrAlias: string): ProviderCapabilities | undefined
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `idOrAlias` | `string` | Provider ID or alias |

**Returns**: `ProviderCapabilities | undefined` -- The provider's capabilities, or `undefined` if not found.

```typescript
import { getProviderCapabilities } from "@cleocode/caamp";

const caps = getProviderCapabilities("claude-code");
if (caps) {
  console.log(caps.skills.precedence); // "vendor-global-agents-project"
  console.log(caps.spawn.supportsSubagents); // true
}
```

---

### `providerSupports()`

Check if a provider supports a capability via dot-path query. For boolean fields, the provider "supports" the capability when the value is `true`. For non-boolean fields, the provider "supports" it when the value is neither `null` nor `undefined` (and, for arrays, non-empty).

```typescript
function providerSupports(provider: Provider, dotPath: string): boolean
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `provider` | `Provider` | Provider to inspect |
| `dotPath` | `string` | Dot-delimited capability path (e.g., `"spawn.supportsSubagents"`, `"hooks.supported"`) |

**Returns**: `boolean` -- `true` when the provider has the specified capability.

```typescript
import { getProvider, providerSupports } from "@cleocode/caamp";

const claude = getProvider("claude-code");
providerSupports(claude!, "spawn.supportsSubagents"); // true
providerSupports(claude!, "hooks.supported"); // true (non-empty array)
providerSupports(claude!, "spawn.spawnMechanism"); // true (non-null value)
```

---

### `providerSupportsById()`

Convenience wrapper that resolves the provider by ID/alias first, then delegates to `providerSupports`.

```typescript
function providerSupportsById(idOrAlias: string, capabilityPath: string): boolean
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `idOrAlias` | `string` | Provider ID or alias |
| `capabilityPath` | `string` | Dot-delimited capability path |

**Returns**: `boolean` -- `true` if the provider supports the capability, `false` otherwise.

```typescript
import { providerSupportsById } from "@cleocode/caamp";

providerSupportsById("claude", "spawn.supportsSubagents"); // true
providerSupportsById("unknown-provider", "spawn.supportsSubagents"); // false
```

---

### `getProvidersBySkillsPrecedence()`

Filter providers by their skills precedence setting.

```typescript
function getProvidersBySkillsPrecedence(precedence: SkillsPrecedence): Provider[]
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `precedence` | `SkillsPrecedence` | Skills precedence to filter by |

**Returns**: `Provider[]` -- Providers matching the given precedence.

```typescript
import { getProvidersBySkillsPrecedence } from "@cleocode/caamp";

const agentsFirst = getProvidersBySkillsPrecedence("agents-first");
```

---

### `getEffectiveSkillsPaths()`

Get ordered skills paths for a provider based on its precedence setting. The `scope` parameter is `"global" | "project"`.

```typescript
function getEffectiveSkillsPaths(
  provider: Provider,
  scope: "global" | "project",
  projectDir?: string
): Array<{ path: string; source: string; scope: string }>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `provider` | `Provider` | Provider to resolve paths for |
| `scope` | `"global" \| "project"` | Whether to resolve global or project paths |
| `projectDir` | `string` | Project directory for project-scope resolution (optional) |

**Returns**: `Array<{ path: string; source: string; scope: string }>` -- Ordered array of paths with source (`"vendor"` or `"agents"`) and scope metadata.

```typescript
import { getProvider, getEffectiveSkillsPaths } from "@cleocode/caamp";

const claude = getProvider("claude-code")!;
const paths = getEffectiveSkillsPaths(claude, "global");
// [{ path: "/home/user/.claude/skills", source: "vendor", scope: "global" }]
```

---

### `buildSkillsMap()`

Build a full skills precedence map for all providers.

```typescript
function buildSkillsMap(): Array<{
  providerId: string;
  toolName: string;
  precedence: SkillsPrecedence;
  paths: { global: string | null; project: string | null };
}>
```

**Parameters**: None

**Returns**: `Array<{ providerId, toolName, precedence, paths }>` -- Skills map entries for every provider.

```typescript
import { buildSkillsMap } from "@cleocode/caamp";

const map = buildSkillsMap();
for (const entry of map) {
  console.log(`${entry.toolName}: ${entry.precedence}`);
}
```

---

### `getProvidersByHookEvent()`

Filter providers that support a specific hook event.

```typescript
function getProvidersByHookEvent(event: HookEvent): Provider[]
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `event` | `HookEvent` | Hook event to filter by |

**Returns**: `Provider[]` -- Providers whose hooks capability includes the given event.

```typescript
import { getProvidersByHookEvent } from "@cleocode/caamp";

const providers = getProvidersByHookEvent("onToolComplete");
```

---

### `getCommonHookEvents()`

Get hook events common to all specified providers (intersection). If `providerIds` is undefined or empty, uses all providers.

```typescript
function getCommonHookEvents(providerIds?: string[]): HookEvent[]
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `providerIds` | `string[]` | Provider IDs to intersect (optional; defaults to all providers) |

**Returns**: `HookEvent[]` -- Hook events supported by ALL specified providers.

```typescript
import { getCommonHookEvents } from "@cleocode/caamp";

const common = getCommonHookEvents(["claude-code", "gemini-cli"]);
// Returns only events both providers support
```

---

### `getSpawnCapableProviders()`

Get providers that support spawning subagents.

```typescript
function getSpawnCapableProviders(): Provider[]
```

**Parameters**: None

**Returns**: `Provider[]` -- Providers where `capabilities.spawn.supportsSubagents === true`.

```typescript
import { getSpawnCapableProviders } from "@cleocode/caamp";

const spawnCapable = getSpawnCapableProviders();
console.log(spawnCapable.map(p => p.id));
```

---

### `getProvidersBySpawnCapability()`

Filter providers by a specific boolean spawn capability flag.

```typescript
function getProvidersBySpawnCapability(
  flag: keyof Omit<ProviderSpawnCapability, "spawnMechanism">
): Provider[]
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `flag` | `keyof Omit<ProviderSpawnCapability, "spawnMechanism">` | One of `"supportsSubagents"`, `"supportsProgrammaticSpawn"`, `"supportsInterAgentComms"`, `"supportsParallelSpawn"` |

**Returns**: `Provider[]` -- Providers where the specified flag is `true`.

```typescript
import { getProvidersBySpawnCapability } from "@cleocode/caamp";

const parallel = getProvidersBySpawnCapability("supportsParallelSpawn");
```

---

### `resolveProviderSkillsDirs()`

Get ALL target directories for skill installation based on the provider's skills precedence setting.

```typescript
function resolveProviderSkillsDirs(
  provider: Provider,
  scope: "global" | "project",
  projectDir?: string
): string[]
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `provider` | `Provider` | Provider to resolve paths for |
| `scope` | `"global" \| "project"` | Whether to resolve global or project paths |
| `projectDir` | `string` | Project directory for project-scope resolution (optional; defaults to `process.cwd()`) |

**Returns**: `string[]` -- Array of target directories for symlink creation.

```typescript
import { getProvider, resolveProviderSkillsDirs } from "@cleocode/caamp";

const claude = getProvider("claude-code")!;
const dirs = resolveProviderSkillsDirs(claude, "global");
// ["/home/user/.claude/skills"]
```

---

## Detection

Functions for detecting which AI coding agents are installed on the system.

### `detectProvider()`

Detects if a single provider is installed by checking binaries, directories, app bundles, and flatpak packages.

```typescript
function detectProvider(provider: Provider): DetectionResult
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `provider` | `Provider` | Provider to check |

**Returns**: `DetectionResult` -- Detection result with matched methods.

```typescript
import { getProvider, detectProvider } from "@cleocode/caamp";

const claude = getProvider("claude-code")!;
const result = detectProvider(claude);
console.log(result.installed); // true
console.log(result.methods);   // ["binary"]
```

---

### `detectAllProviders()`

Runs detection for all registered providers.

```typescript
function detectAllProviders(options?: { forceRefresh?: boolean; ttlMs?: number }): DetectionResult[]
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `options` | `{ forceRefresh?: boolean; ttlMs?: number }` | Optional cache controls for detection reuse |

**Returns**: `DetectionResult[]` -- Detection results for every provider.

```typescript
import { detectAllProviders } from "@cleocode/caamp";

const results = detectAllProviders();
const installed = results.filter(r => r.installed);
console.log(`${installed.length} agents detected`);
```

---

### `getInstalledProviders()`

Returns only providers detected as installed on the system.

```typescript
function getInstalledProviders(options?: { forceRefresh?: boolean; ttlMs?: number }): Provider[]
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `options` | `{ forceRefresh?: boolean; ttlMs?: number }` | Optional cache controls for detection reuse |

**Returns**: `Provider[]` -- Installed providers.

```typescript
import { getInstalledProviders } from "@cleocode/caamp";

const installed = getInstalledProviders();
// Use these for operations that target installed agents
```

---

### `detectProjectProviders()`

Detects all providers and also checks for project-level configuration in the given directory.

```typescript
function detectProjectProviders(projectDir: string, options?: { forceRefresh?: boolean; ttlMs?: number }): DetectionResult[]
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `projectDir` | `string` | Directory to check for project-level configs |
| `options` | `{ forceRefresh?: boolean; ttlMs?: number }` | Optional cache controls for detection reuse |

**Returns**: `DetectionResult[]` -- Detection results with `projectDetected` populated.

```typescript
import { detectProjectProviders } from "@cleocode/caamp";

const results = detectProjectProviders("/path/to/project");
const projectConfigured = results.filter(r => r.projectDetected);
```

---

### `resetDetectionCache()`

Clears in-memory provider detection cache.

```typescript
function resetDetectionCache(): void
```

**Parameters**: None

**Returns**: `void`

---

### `getAgentsHome()`

Resolves canonical global `.agents` directory, honoring `AGENTS_HOME` when set.

```typescript
function getAgentsHome(): string
```

---

### `getCanonicalSkillsDir()`

Returns canonical global skills directory used for install-then-symlink flow.

```typescript
function getCanonicalSkillsDir(): string
```

---

### `getLockFilePath()`

Returns canonical CAAMP lock file path.

```typescript
function getLockFilePath(): string
```

---

## Source Parsing

Functions for classifying source strings into typed representations.

### `parseSource()`

Classifies a source string into one of the supported source types: GitHub URL, GitLab URL, HTTP remote, local path, GitHub shorthand (`owner/repo`), npm package, or shell command.

```typescript
function parseSource(input: string): ParsedSource
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `input` | `string` | Raw source string (URL, package name, path, or command) |

**Returns**: `ParsedSource` -- Classified source with inferred name and optional owner/repo/ref/path.

```typescript
import { parseSource } from "@cleocode/caamp";

parseSource("https://github.com/user/mcp-server");
// { type: "github", value: "https://github.com/user/mcp-server", inferredName: "mcp-server", owner: "user", repo: "mcp-server" }

parseSource("@modelcontextprotocol/server-github");
// { type: "package", value: "@modelcontextprotocol/server-github", inferredName: "server-github" }

parseSource("npx some-server --port 3000");
// { type: "command", value: "npx some-server --port 3000", inferredName: "some-server" }
```

---

### `isMarketplaceScoped()`

Checks if a source string looks like a marketplace scoped name (e.g., `@author/name`).

```typescript
function isMarketplaceScoped(input: string): boolean
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `input` | `string` | String to test |

**Returns**: `boolean` -- True if it matches `@scope/name` pattern.

```typescript
import { isMarketplaceScoped } from "@cleocode/caamp";

isMarketplaceScoped("@anthropic/claude-skill"); // true
isMarketplaceScoped("some-package");            // false
```

---

## MCP -- Installation

Functions for installing MCP server configurations into provider config files.

### `installMcpServer()`

Installs an MCP server configuration for a single provider, applying format-specific transforms.

```typescript
async function installMcpServer(
  provider: Provider,
  serverName: string,
  config: McpServerConfig,
  scope?: "project" | "global",
  projectDir?: string
): Promise<InstallResult>
```

**Parameters**:

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `provider` | `Provider` | -- | Target provider |
| `serverName` | `string` | -- | Server name/key |
| `config` | `McpServerConfig` | -- | Canonical server configuration |
| `scope` | `"project" \| "global"` | `"project"` | Installation scope |
| `projectDir` | `string` | `process.cwd()` | Project directory |

**Returns**: `Promise<InstallResult>` -- Installation result.

```typescript
import { getProvider, installMcpServer } from "@cleocode/caamp";

const claude = getProvider("claude-code")!;
const result = await installMcpServer(claude, "my-server", {
  command: "npx",
  args: ["-y", "@example/mcp-server"],
}, "project");

console.log(result.success);    // true
console.log(result.configPath); // "/path/to/project/.mcp.json"
```

---

### `installMcpServerToAll()`

Installs an MCP server configuration across multiple providers sequentially.

```typescript
async function installMcpServerToAll(
  providers: Provider[],
  serverName: string,
  config: McpServerConfig,
  scope?: "project" | "global",
  projectDir?: string
): Promise<InstallResult[]>
```

**Parameters**:

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `providers` | `Provider[]` | -- | Target providers |
| `serverName` | `string` | -- | Server name/key |
| `config` | `McpServerConfig` | -- | Canonical server configuration |
| `scope` | `"project" \| "global"` | `"project"` | Installation scope |
| `projectDir` | `string` | `process.cwd()` | Project directory |

**Returns**: `Promise<InstallResult[]>` -- Array of installation results.

```typescript
import { getInstalledProviders, installMcpServerToAll } from "@cleocode/caamp";

const installed = getInstalledProviders();
const results = await installMcpServerToAll(installed, "my-server", {
  command: "npx",
  args: ["-y", "@example/mcp-server"],
}, "global");

const succeeded = results.filter(r => r.success);
console.log(`Installed to ${succeeded.length}/${results.length} agents`);
```

---

### `buildServerConfig()`

Builds a canonical MCP server config from a parsed source. Remote sources become HTTP/SSE configs, packages become `npx` stdio configs, and commands are split into command + args.

```typescript
function buildServerConfig(
  source: { type: string; value: string },
  transport?: string,
  headers?: Record<string, string>
): McpServerConfig
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `source` | `{ type: string; value: string }` | Parsed source with type and value |
| `transport` | `string` | Override transport type (optional) |
| `headers` | `Record<string, string>` | HTTP headers for remote servers (optional) |

**Returns**: `McpServerConfig` -- Canonical config object.

```typescript
import { parseSource, buildServerConfig } from "@cleocode/caamp";

const source = parseSource("@modelcontextprotocol/server-github");
const config = buildServerConfig(source);
// { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] }
```

---

## MCP -- Reading & Listing

Functions for reading and querying existing MCP server configurations.

### `resolveConfigPath()`

Resolves the absolute config file path for a provider and scope. Returns `null` if the provider does not support project-level config.

```typescript
function resolveConfigPath(
  provider: Provider,
  scope: "project" | "global",
  projectDir?: string
): string | null
```

**Parameters**:

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `provider` | `Provider` | -- | Provider definition |
| `scope` | `"project" \| "global"` | -- | Scope to resolve |
| `projectDir` | `string` | `process.cwd()` | Project directory |

**Returns**: `string | null` -- Absolute path or `null`.

```typescript
import { getProvider, resolveConfigPath } from "@cleocode/caamp";

const claude = getProvider("claude-code")!;
const path = resolveConfigPath(claude, "project", "/my/project");
// "/my/project/.mcp.json"
```

---

### `listMcpServers()`

Lists all MCP servers configured for a single provider by reading its config file.

```typescript
async function listMcpServers(
  provider: Provider,
  scope: "project" | "global",
  projectDir?: string
): Promise<McpServerEntry[]>
```

**Parameters**:

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `provider` | `Provider` | -- | Provider to query |
| `scope` | `"project" \| "global"` | -- | Which config to read |
| `projectDir` | `string` | `process.cwd()` | Project directory |

**Returns**: `Promise<McpServerEntry[]>` -- Array of server entries.

```typescript
import { getProvider, listMcpServers } from "@cleocode/caamp";

const claude = getProvider("claude-code")!;
const servers = await listMcpServers(claude, "global");
servers.forEach(s => console.log(s.name));
```

---

### `listAllMcpServers()`

Lists MCP servers across multiple providers, deduplicating by config path to avoid counting shared configs twice.

```typescript
async function listAllMcpServers(
  providers: Provider[],
  scope: "project" | "global",
  projectDir?: string
): Promise<McpServerEntry[]>
```

**Parameters**:

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `providers` | `Provider[]` | -- | Providers to query |
| `scope` | `"project" \| "global"` | -- | Which configs to read |
| `projectDir` | `string` | `process.cwd()` | Project directory |

**Returns**: `Promise<McpServerEntry[]>` -- Aggregated, deduplicated server entries.

```typescript
import { getInstalledProviders, listAllMcpServers } from "@cleocode/caamp";

const installed = getInstalledProviders();
const allServers = await listAllMcpServers(installed, "global");
console.log(`${allServers.length} MCP servers configured`);
```

---

### `removeMcpServer()`

Removes an MCP server entry from a provider's config file.

```typescript
async function removeMcpServer(
  provider: Provider,
  serverName: string,
  scope: "project" | "global",
  projectDir?: string
): Promise<boolean>
```

**Parameters**:

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `provider` | `Provider` | -- | Provider to modify |
| `serverName` | `string` | -- | Server name/key to remove |
| `scope` | `"project" \| "global"` | -- | Which config to modify |
| `projectDir` | `string` | `process.cwd()` | Project directory |

**Returns**: `Promise<boolean>` -- True if the entry was found and removed.

```typescript
import { getProvider, removeMcpServer } from "@cleocode/caamp";

const claude = getProvider("claude-code")!;
const removed = await removeMcpServer(claude, "old-server", "project");
```

---

## MCP -- Lock File

Functions for tracking MCP server installations in the shared lock file (`getLockFilePath()`).

### `readLockFile()`

Reads the shared lock file. Returns a default empty structure if the file does not exist or is corrupted.

```typescript
async function readLockFile(): Promise<CaampLockFile>
```

**Parameters**: None

**Returns**: `Promise<CaampLockFile>` -- Parsed lock file contents.

```typescript
import { readLockFile } from "@cleocode/caamp";

const lock = await readLockFile();
console.log(Object.keys(lock.mcpServers).length);
```

---

### `recordMcpInstall()`

Records an MCP server installation in the lock file. Merges agent lists on re-install.

```typescript
async function recordMcpInstall(
  serverName: string,
  source: string,
  sourceType: SourceType,
  agents: string[],
  isGlobal: boolean
): Promise<void>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `serverName` | `string` | Server name/key |
| `source` | `string` | Original source string |
| `sourceType` | `SourceType` | Classified source type |
| `agents` | `string[]` | Provider IDs installed to |
| `isGlobal` | `boolean` | Whether installed globally |

**Returns**: `Promise<void>`

```typescript
import { recordMcpInstall } from "@cleocode/caamp";

await recordMcpInstall("my-server", "npx my-server", "command", ["claude-code"], true);
```

---

### `removeMcpFromLock()`

Removes an MCP server entry from the lock file.

```typescript
async function removeMcpFromLock(serverName: string): Promise<boolean>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `serverName` | `string` | Server name to remove |

**Returns**: `Promise<boolean>` -- True if the entry existed and was removed.

```typescript
import { removeMcpFromLock } from "@cleocode/caamp";

const removed = await removeMcpFromLock("old-server");
```

---

### `getTrackedMcpServers()`

Returns all tracked MCP server installations from the lock file.

```typescript
async function getTrackedMcpServers(): Promise<Record<string, LockEntry>>
```

**Parameters**: None

**Returns**: `Promise<Record<string, LockEntry>>` -- Map of server name to lock entry.

```typescript
import { getTrackedMcpServers } from "@cleocode/caamp";

const tracked = await getTrackedMcpServers();
for (const [name, entry] of Object.entries(tracked)) {
  console.log(`${name}: installed ${entry.installedAt}`);
}
```

---

### `saveLastSelectedAgents()`

Persists the last selected agent list for UX continuity.

```typescript
async function saveLastSelectedAgents(agents: string[]): Promise<void>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `agents` | `string[]` | Agent IDs to save |

**Returns**: `Promise<void>`

```typescript
import { saveLastSelectedAgents } from "@cleocode/caamp";

await saveLastSelectedAgents(["claude-code", "cursor"]);
```

---

### `getLastSelectedAgents()`

Retrieves the last selected agent list.

```typescript
async function getLastSelectedAgents(): Promise<string[] | undefined>
```

**Parameters**: None

**Returns**: `Promise<string[] | undefined>` -- Saved agent IDs or `undefined` if none saved.

```typescript
import { getLastSelectedAgents } from "@cleocode/caamp";

const last = await getLastSelectedAgents();
// Use as defaults for next interactive prompt
```

---

## MCP -- Transforms

Functions for provider-specific config format transforms.

### `getTransform()`

Returns the transform function for a provider, or `undefined` for providers that use the canonical format directly. Supported transforms: goose, zed, opencode, codex, cursor.

```typescript
function getTransform(
  providerId: string
): ((name: string, config: McpServerConfig) => unknown) | undefined
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `providerId` | `string` | Provider ID to look up |

**Returns**: `((name: string, config: McpServerConfig) => unknown) | undefined` -- Transform function or `undefined`.

```typescript
import { getTransform } from "@cleocode/caamp";

const transform = getTransform("zed");
if (transform) {
  const zedConfig = transform("my-server", {
    command: "npx",
    args: ["-y", "my-mcp-server"],
  });
}
```

---

## MCP -- CLEO

CLEO (Canonical Library for Extensible Orchestration) helpers for MCP server management and version handling.

### `extractVersionTag()`

Extracts a version tag from a package specification string (e.g., `package@1.2.3`). Returns the version portion after the `@` symbol, or `undefined` if no version tag is present.

```typescript
function extractVersionTag(packageSpec?: string): string | undefined
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `packageSpec` | `string` | Package specification string (e.g., `"my-package@1.2.3"`) |

**Returns**: `string | undefined` -- Version tag (e.g., `"1.2.3"`) or `undefined` if no version found.

```typescript
import { extractVersionTag } from "@cleocode/caamp";

const version1 = extractVersionTag("my-mcp-server@1.2.3");
console.log(version1); // "1.2.3"

const version2 = extractVersionTag("my-mcp-server");
console.log(version2); // undefined

const version3 = extractVersionTag("@scope/package@2.0.0");
console.log(version3); // "2.0.0"
```

---

## Skills -- Recommendation

Functions for skill discovery, recommendation, and ranking based on criteria matching.

### `formatSkillRecommendations()`

Formats skill recommendation results for display or JSON output. Supports human-readable text mode (with numbered list and CHOOSE prompt) or structured JSON mode with optional detailed evidence fields.

```typescript
function formatSkillRecommendations(
  result: RecommendSkillsResult,
  opts: { mode: "human" | "json"; details?: boolean }
): string | Record<string, unknown>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `result` | `RecommendSkillsResult` | Recommendation result from `recommendSkills()` |
| `opts.mode` | `"human" \| "json"` | Output format mode |
| `opts.details` | `boolean` | Include detailed evidence fields in JSON mode (optional) |

**Returns**: `string | Record<string, unknown>` -- Formatted recommendations as human-readable string or JSON object.

**Human Mode Output**:
```
Recommended skills:

1) @scope/skill-name (Recommended)
   why: security, performance
   tradeoff: increases bundle size

CHOOSE: 1,2,3
```

**JSON Mode Output** (with `details: true`):
```json
{
  "options": [
    {
      "rank": 1,
      "scopedName": "@scope/skill-name",
      "score": 0.95,
      "reasons": [{"code": "security", "weight": 0.3}],
      "tradeoffs": ["increases bundle size"],
      "description": "Skill description",
      "source": "github:user/repo",
      "evidence": { ... }
    }
  ]
}
```

```typescript
import { recommendSkills, formatSkillRecommendations } from "@cleocode/caamp";

const result = await recommendSkills("auth", {
  criteria: { mustHave: ["security"] },
  limit: 5
});

// Human-readable format for CLI display
const human = formatSkillRecommendations(result, { mode: "human" });
console.log(human);

// JSON format for programmatic use
const json = formatSkillRecommendations(result, { mode: "json", details: true });
console.log(JSON.stringify(json, null, 2));
```

---

## Skills -- Installation

Functions for installing and removing agent skills.

### `installSkill()`

Installs a skill from a local path: copies to the canonical location (`getCanonicalSkillsDir()/&lt;name&gt;`) and creates symlinks in each target provider's skills directory.

```typescript
async function installSkill(
  sourcePath: string,
  skillName: string,
  providers: Provider[],
  isGlobal: boolean,
  projectDir?: string
): Promise<SkillInstallResult>
```

**Parameters**:

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `sourcePath` | `string` | -- | Local directory containing SKILL.md |
| `skillName` | `string` | -- | Name for the skill |
| `providers` | `Provider[]` | -- | Target providers to link |
| `isGlobal` | `boolean` | -- | Whether to use global or project skill paths |
| `projectDir` | `string` | `process.cwd()` | Project directory |

**Returns**: `Promise<SkillInstallResult>` -- Installation result with linked agents and errors.

```typescript
import { getInstalledProviders, installSkill } from "@cleocode/caamp";

const providers = getInstalledProviders();
const result = await installSkill(
  "/tmp/my-skill",
  "my-skill",
  providers,
  true
);

console.log(result.canonicalPath); // e.g. "<AGENTS_HOME>/skills/my-skill/"
console.log(result.linkedAgents);  // ["claude-code", "cursor"]
```

---

### `removeSkill()`

Removes a skill's symlinks from all provider skill directories and deletes the canonical copy.

```typescript
async function removeSkill(
  skillName: string,
  providers: Provider[],
  isGlobal: boolean,
  projectDir?: string
): Promise<{ removed: string[]; errors: string[] }>
```

**Parameters**:

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `skillName` | `string` | -- | Skill to remove |
| `providers` | `Provider[]` | -- | Providers to unlink from |
| `isGlobal` | `boolean` | -- | Whether to use global or project skill paths |
| `projectDir` | `string` | `process.cwd()` | Project directory |

**Returns**: `Promise<{ removed: string[]; errors: string[] }>` -- Provider IDs unlinked and any errors.

```typescript
import { getInstalledProviders, removeSkill } from "@cleocode/caamp";

const { removed, errors } = await removeSkill(
  "old-skill",
  getInstalledProviders(),
  true
);
```

---

### `listCanonicalSkills()`

Lists all skill names installed in the canonical directory (`getCanonicalSkillsDir()`).

```typescript
async function listCanonicalSkills(): Promise<string[]>
```

**Parameters**: None

**Returns**: `Promise<string[]>` -- Array of skill directory names.

```typescript
import { listCanonicalSkills } from "@cleocode/caamp";

const skills = await listCanonicalSkills();
// ["my-skill", "debug-helper", "code-review"]
```

---

## Skills -- Discovery

Functions for discovering and parsing SKILL.md files.

### `parseSkillFile()`

Reads a SKILL.md file and parses its YAML frontmatter into a `SkillMetadata` object. Returns `null` if the file lacks required `name` or `description` fields.

```typescript
async function parseSkillFile(filePath: string): Promise<SkillMetadata | null>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `filePath` | `string` | Absolute path to a SKILL.md file |

**Returns**: `Promise<SkillMetadata | null>` -- Parsed metadata or `null` on failure.

```typescript
import { parseSkillFile } from "@cleocode/caamp";

const metadata = await parseSkillFile("/path/to/skill/SKILL.md");
if (metadata) {
  console.log(metadata.name, metadata.description);
}
```

---

### `discoverSkill()`

Discovers a skill at a given directory by looking for and parsing `SKILL.md` inside it.

```typescript
async function discoverSkill(skillDir: string): Promise<SkillEntry | null>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `skillDir` | `string` | Directory that should contain SKILL.md |

**Returns**: `Promise<SkillEntry | null>` -- Discovered skill entry or `null` if no valid SKILL.md found.

```typescript
import { discoverSkill } from "@cleocode/caamp";

const skill = await discoverSkill("/path/to/skill-dir");
if (skill) {
  console.log(skill.name, skill.scopedName);
}
```

---

### `discoverSkills()`

Scans a root directory for subdirectories containing SKILL.md files and returns all discovered skills.

```typescript
async function discoverSkills(rootDir: string): Promise<SkillEntry[]>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `rootDir` | `string` | Directory to scan (each child directory is checked) |

**Returns**: `Promise<SkillEntry[]>` -- Array of discovered skills.

```typescript
import { discoverSkills, getCanonicalSkillsDir } from "@cleocode/caamp";

const skills = await discoverSkills(getCanonicalSkillsDir());
skills.forEach(s => console.log(`${s.scopedName}: ${s.metadata.description}`));
```

---

## Skills -- Validation

Functions for validating SKILL.md files against the Agent Skills standard.

### `validateSkill()`

Validates a SKILL.md file against the Agent Skills standard. Checks for required frontmatter fields (`name`, `description`), name format/length/reserved words, description length, body content, and XSS patterns.

```typescript
async function validateSkill(filePath: string): Promise<ValidationResult>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `filePath` | `string` | Path to SKILL.md file |

**Returns**: `Promise<ValidationResult>` -- Validation result with issues and parsed metadata.

```typescript
import { validateSkill } from "@cleocode/caamp";

const result = await validateSkill("/path/to/SKILL.md");
if (!result.valid) {
  result.issues
    .filter(i => i.level === "error")
    .forEach(i => console.error(`${i.field}: ${i.message}`));
}
```

---

## Skills -- Audit

Functions for security scanning of SKILL.md files.

### `scanFile()`

Scans a single file against security rules (46+ rules by default). Returns findings with line-level precision and a security score.

```typescript
async function scanFile(
  filePath: string,
  rules?: AuditRule[]
): Promise<AuditResult>
```

**Parameters**:

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `filePath` | `string` | -- | File to scan |
| `rules` | `AuditRule[]` | Built-in `AUDIT_RULES` | Custom rules (optional) |

**Returns**: `Promise<AuditResult>` -- Scan result with findings, score, and pass/fail.

```typescript
import { scanFile } from "@cleocode/caamp";

const result = await scanFile("/path/to/SKILL.md");
console.log(`Score: ${result.score}/100, Passed: ${result.passed}`);
result.findings.forEach(f =>
  console.log(`  L${f.line}: [${f.rule.severity}] ${f.rule.name}`)
);
```

---

### `scanDirectory()`

Scans a directory of skills (each subdirectory's SKILL.md) against security rules.

```typescript
async function scanDirectory(dirPath: string): Promise<AuditResult[]>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `dirPath` | `string` | Root directory containing skill subdirectories |

**Returns**: `Promise<AuditResult[]>` -- Array of audit results, one per scanned SKILL.md.

```typescript
import { scanDirectory, getCanonicalSkillsDir } from "@cleocode/caamp";

const results = await scanDirectory(getCanonicalSkillsDir());
const failed = results.filter(r => !r.passed);
console.log(`${failed.length} skills failed security audit`);
```

---

### `toSarif()`

Converts audit results into SARIF 2.1.0 format (Static Analysis Results Interchange Format) for integration with CI/CD tools.

```typescript
function toSarif(results: AuditResult[]): object
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `results` | `AuditResult[]` | Audit results to convert |

**Returns**: `object` -- SARIF-formatted object.

```typescript
import { scanDirectory, toSarif, getCanonicalSkillsDir } from "@cleocode/caamp";
import { writeFileSync } from "fs";

const results = await scanDirectory(getCanonicalSkillsDir());
const sarif = toSarif(results);
writeFileSync("audit-results.sarif", JSON.stringify(sarif, null, 2));
```

---

## Skills -- Lock File

Functions for tracking skill installations in the shared lock file.

### `recordSkillInstall()`

Records a skill installation in the shared lock file (`getLockFilePath()`). Merges agent lists on re-install and preserves the original `installedAt` timestamp.

```typescript
async function recordSkillInstall(
  skillName: string,
  scopedName: string,
  source: string,
  sourceType: SourceType,
  agents: string[],
  canonicalPath: string,
  isGlobal: boolean,
  projectDir?: string,
  version?: string
): Promise<void>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `skillName` | `string` | Skill name key |
| `scopedName` | `string` | Scoped name |
| `source` | `string` | Original source string |
| `sourceType` | `SourceType` | Classified source type |
| `agents` | `string[]` | Provider IDs linked to |
| `canonicalPath` | `string` | Canonical storage path |
| `isGlobal` | `boolean` | Whether installed globally |
| `projectDir` | `string` | Project directory, if project-scoped (optional) |
| `version` | `string` | Installed version (optional) |

**Returns**: `Promise<void>`

```typescript
import { recordSkillInstall, getCanonicalSkillsDir } from "@cleocode/caamp";
import { join } from "node:path";

await recordSkillInstall(
  "my-skill",
  "@author/my-skill",
  "github:author/my-skill",
  "github",
  ["claude-code"],
  join(getCanonicalSkillsDir(), "my-skill"),
  true
);
```

---

### `removeSkillFromLock()`

Removes a skill entry from the lock file.

```typescript
async function removeSkillFromLock(skillName: string): Promise<boolean>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `skillName` | `string` | Skill name to remove |

**Returns**: `Promise<boolean>` -- True if the entry existed and was removed.

```typescript
import { removeSkillFromLock } from "@cleocode/caamp";

const removed = await removeSkillFromLock("old-skill");
```

---

### `getTrackedSkills()`

Returns all tracked skill installations from the lock file.

```typescript
async function getTrackedSkills(): Promise<Record<string, LockEntry>>
```

**Parameters**: None

**Returns**: `Promise<Record<string, LockEntry>>` -- Map of skill name to lock entry.

```typescript
import { getTrackedSkills } from "@cleocode/caamp";

const tracked = await getTrackedSkills();
for (const [name, entry] of Object.entries(tracked)) {
  console.log(`${name} from ${entry.source} (${entry.sourceType})`);
}
```

---

### `checkSkillUpdate()`

Checks if a skill has updates available. For GitHub and GitLab sources, performs a remote SHA comparison via `simple-git` `ls-remote` to detect whether the remote HEAD has changed since install. Other source types return `status: "unknown"`.

```typescript
async function checkSkillUpdate(
  skillName: string
): Promise<{
  hasUpdate: boolean;
  currentVersion?: string;
  latestVersion?: string;
  status: "up-to-date" | "update-available" | "unknown";
}>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `skillName` | `string` | Skill name to check |

**Returns**: `Promise<{ hasUpdate: boolean; currentVersion?: string; latestVersion?: string; status: "up-to-date" | "update-available" | "unknown" }>` -- Update status.

| Property | Type | Description |
|----------|------|-------------|
| `hasUpdate` | `boolean` | Whether an update is available |
| `currentVersion` | `string` | Currently installed version/SHA (optional) |
| `latestVersion` | `string` | Latest remote version/SHA (optional) |
| `status` | `"up-to-date" \| "update-available" \| "unknown"` | Update status. `"unknown"` for non-GitHub/GitLab sources or when the skill is not tracked. |

```typescript
import { checkSkillUpdate } from "@cleocode/caamp";

const status = await checkSkillUpdate("my-skill");
if (status.hasUpdate) {
  console.log(`Update available: ${status.currentVersion} -> ${status.latestVersion}`);
}
console.log(`Status: ${status.status}`);
```

---

## Advanced orchestration

High-level orchestration helpers built on top of CAAMP's core primitives.
For command-line wrappers with LAFS output envelopes, see [Advanced CLI](ADVANCED-CLI.md).

### `selectProvidersByMinimumPriority()`

Filters providers by a minimum priority tier and returns deterministic tier ordering.

```typescript
function selectProvidersByMinimumPriority(
  providers: Provider[],
  minimumPriority?: ProviderPriority
): Provider[]
```

**Parameters**:

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `providers` | `Provider[]` | -- | Candidate providers |
| `minimumPriority` | `ProviderPriority` | `"low"` | Include providers at or above this tier (`high <= medium <= low`) |

**Returns**: `Provider[]` -- Filtered providers sorted by priority.

```typescript
import { getInstalledProviders, selectProvidersByMinimumPriority } from "@cleocode/caamp";

const installed = getInstalledProviders();
const target = selectProvidersByMinimumPriority(installed, "medium");
// includes high + medium providers
```

---

### `installBatchWithRollback()`

Implements rollback-capable batch installs for multiple MCP servers and skills across tier-filtered providers.

```typescript
async function installBatchWithRollback(
  options: BatchInstallOptions
): Promise<BatchInstallResult>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `options.providers` | `Provider[]` | Optional provider set (defaults to installed providers) |
| `options.minimumPriority` | `ProviderPriority` | Optional tier filter |
| `options.mcp` | `McpBatchOperation[]` | MCP operations to apply |
| `options.skills` | `SkillBatchOperation[]` | Skill operations to apply |
| `options.projectDir` | `string` | Project directory override |

**Returns**: `Promise<BatchInstallResult>` -- Includes success flag, applied counts, rollback status, and rollback errors.

```typescript
import { installBatchWithRollback } from "@cleocode/caamp";

const result = await installBatchWithRollback({
  minimumPriority: "high",
  mcp: [
    {
      serverName: "filesystem",
      config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
      scope: "project",
    },
  ],
  skills: [
    {
      sourcePath: "/tmp/my-skill",
      skillName: "my-skill",
      isGlobal: true,
    },
  ],
});

if (!result.success) {
  console.error("batch failed:", result.error);
  console.error("rollback errors:", result.rollbackErrors);
}
```

---

### `detectMcpConfigConflicts()`

Preflight detection for configuration conflicts (unsupported transport/headers and existing config mismatch).

```typescript
async function detectMcpConfigConflicts(
  providers: Provider[],
  operations: McpBatchOperation[],
  projectDir?: string
): Promise<McpConflict[]>
```

**Returns**: `Promise<McpConflict[]>` -- Conflicts with provider, server, scope, code, and message.

```typescript
import { detectMcpConfigConflicts, getInstalledProviders } from "@cleocode/caamp";

const conflicts = await detectMcpConfigConflicts(
  getInstalledProviders(),
  [{ serverName: "remote", config: { type: "http", url: "https://example.com" }, scope: "global" }],
);
```

---

### `applyMcpInstallWithPolicy()`

Applies MCP install plan with conflict policy (`"fail"`, `"skip"`, or `"overwrite"`).

```typescript
async function applyMcpInstallWithPolicy(
  providers: Provider[],
  operations: McpBatchOperation[],
  policy?: ConflictPolicy,
  projectDir?: string
): Promise<McpPlanApplyResult>
```

**Returns**: `Promise<McpPlanApplyResult>` -- Conflict list, applied results, and skipped operations.

```typescript
import { applyMcpInstallWithPolicy, getInstalledProviders } from "@cleocode/caamp";

const result = await applyMcpInstallWithPolicy(
  getInstalledProviders(),
  [{ serverName: "github", config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] } }],
  "skip",
);
```

---

### `updateInstructionsSingleOperation()`

Single-operation wrapper for updating instruction files across multiple providers, regardless of each provider's config format (JSON, JSONC, YAML, TOML).

```typescript
async function updateInstructionsSingleOperation(
  providers: Provider[],
  content: string,
  scope?: "project" | "global",
  projectDir?: string
): Promise<InstructionUpdateSummary>
```

**Returns**: `Promise<InstructionUpdateSummary>` -- File-level actions with provider IDs and config-format coverage.

```typescript
import { getInstalledProviders, updateInstructionsSingleOperation } from "@cleocode/caamp";

const summary = await updateInstructionsSingleOperation(
  getInstalledProviders(),
  "## Managed by CAAMP\n",
  "project",
);
console.log(summary.updatedFiles);
```

---

### `configureProviderGlobalAndProject()`

Configures both global and project-level settings for one provider in a single operation.

```typescript
async function configureProviderGlobalAndProject(
  provider: Provider,
  options: DualScopeConfigureOptions
): Promise<DualScopeConfigureResult>
```

**Returns**: `Promise<DualScopeConfigureResult>` -- Global/project config paths, MCP write results, and optional instruction update actions.

```typescript
import { configureProviderGlobalAndProject, getProvider } from "@cleocode/caamp";

const provider = getProvider("claude-code")!;
const result = await configureProviderGlobalAndProject(provider, {
  globalMcp: [{ serverName: "shared", config: { command: "npx", args: ["-y", "@example/server"] } }],
  projectMcp: [{ serverName: "repo-local", config: { command: "npx", args: ["-y", "@example/server"] } }],
  instructionContent: {
    global: "Global instructions",
    project: "Project instructions",
  },
});
```

---

## Formats

Functions for reading and writing multi-format configuration files (JSON, JSONC, YAML, TOML).

### `readConfig()`

Reads and parses a config file in the specified format.

```typescript
async function readConfig(
  filePath: string,
  format: ConfigFormat
): Promise<Record<string, unknown>>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `filePath` | `string` | Path to the config file |
| `format` | `ConfigFormat` | File format |

**Returns**: `Promise<Record<string, unknown>>` -- Parsed config object.

```typescript
import { readConfig } from "@cleocode/caamp";

const config = await readConfig("/path/to/.mcp.json", "json");
```

---

### `writeConfig()`

Writes a server entry to a config file, preserving existing content. Uses dot-notation key path to set the entry.

```typescript
async function writeConfig(
  filePath: string,
  format: ConfigFormat,
  key: string,
  serverName: string,
  serverConfig: unknown
): Promise<void>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `filePath` | `string` | Path to the config file |
| `format` | `ConfigFormat` | File format |
| `key` | `string` | Dot-notation key path (e.g., `"mcpServers"`) |
| `serverName` | `string` | Server name/key |
| `serverConfig` | `unknown` | Server config object to write |

**Returns**: `Promise<void>`

```typescript
import { writeConfig } from "@cleocode/caamp";

await writeConfig("/path/to/.mcp.json", "json", "mcpServers", "my-server", {
  command: "npx",
  args: ["-y", "my-mcp-server"],
});
```

---

### `removeConfig()`

Removes a server entry from a config file.

```typescript
async function removeConfig(
  filePath: string,
  format: ConfigFormat,
  key: string,
  serverName: string
): Promise<boolean>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `filePath` | `string` | Path to the config file |
| `format` | `ConfigFormat` | File format |
| `key` | `string` | Dot-notation key path |
| `serverName` | `string` | Server name/key to remove |

**Returns**: `Promise<boolean>` -- True if the entry was found and removed.

```typescript
import { removeConfig } from "@cleocode/caamp";

const removed = await removeConfig("/path/to/.mcp.json", "json", "mcpServers", "old-server");
```

---

### `getNestedValue()`

Gets a value from a nested object using dot-notation key path.

```typescript
function getNestedValue(obj: Record<string, unknown>, keyPath: string): unknown
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `obj` | `Record<string, unknown>` | Object to traverse |
| `keyPath` | `string` | Dot-separated path (e.g., `"a.b.c"`) |

**Returns**: `unknown` -- The value at the path, or `undefined`.

```typescript
import { getNestedValue } from "@cleocode/caamp";

const value = getNestedValue({ a: { b: { c: 42 } } }, "a.b.c");
// 42
```

---

### `deepMerge()`

Deep merges two objects. Source values win on conflict. Arrays are replaced, not merged.

```typescript
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `target` | `Record<string, unknown>` | Base object |
| `source` | `Record<string, unknown>` | Object to merge in (wins on conflict) |

**Returns**: `Record<string, unknown>` -- New merged object.

```typescript
import { deepMerge } from "@cleocode/caamp";

const merged = deepMerge(
  { a: 1, b: { c: 2, d: 3 } },
  { b: { c: 99 }, e: 4 }
);
// { a: 1, b: { c: 99, d: 3 }, e: 4 }
```

---

### `ensureDir()`

Ensures the parent directory of a file path exists, creating it recursively if needed.

```typescript
async function ensureDir(filePath: string): Promise<void>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `filePath` | `string` | File path whose parent directory should exist |

**Returns**: `Promise<void>`

```typescript
import { ensureDir } from "@cleocode/caamp";

await ensureDir("/path/to/new/dir/config.json");
// /path/to/new/dir/ now exists
```

---

## Instructions

Functions for managing CAAMP injection blocks in agent instruction files (CLAUDE.md, AGENTS.md, etc.).

### `inject()`

Injects content between CAAMP markers (`<!-- CAAMP:START -->` / `<!-- CAAMP:END -->`) in an instruction file. Creates the file if missing, prepends block if no markers exist, or replaces existing block.

```typescript
async function inject(
  filePath: string,
  content: string
): Promise<"created" | "added" | "updated">
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `filePath` | `string` | Path to the instruction file |
| `content` | `string` | Content to inject between markers |

**Returns**: `Promise<"created" | "added" | "updated">` -- Action taken.

```typescript
import { inject } from "@cleocode/caamp";

const action = await inject("/path/to/CLAUDE.md", "## MCP Servers\n...");
// "created" | "added" | "updated"
```

---

### `checkInjection()`

Checks if a file has a CAAMP injection block and whether its content is current.

```typescript
async function checkInjection(
  filePath: string,
  expectedContent?: string
): Promise<InjectionStatus>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `filePath` | `string` | File to check |
| `expectedContent` | `string` | Expected content to compare against (optional; if omitted, any block is `"current"`) |

**Returns**: `Promise<InjectionStatus>` -- Status: `"current"`, `"outdated"`, `"missing"`, or `"none"`.

```typescript
import { checkInjection } from "@cleocode/caamp";

const status = await checkInjection("/path/to/CLAUDE.md", expectedContent);
if (status === "outdated") {
  // Re-inject updated content
}
```

---

### `removeInjection()`

Removes the CAAMP injection block from a file. Deletes the file entirely if it would be empty after removal.

```typescript
async function removeInjection(filePath: string): Promise<boolean>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `filePath` | `string` | File to clean |

**Returns**: `Promise<boolean>` -- True if a block was found and removed.

```typescript
import { removeInjection } from "@cleocode/caamp";

const removed = await removeInjection("/path/to/CLAUDE.md");
```

---

### `checkAllInjections()`

Checks injection status across all providers' instruction files, deduplicating by file path.

```typescript
async function checkAllInjections(
  providers: Provider[],
  projectDir: string,
  scope: "project" | "global",
  expectedContent?: string
): Promise<InjectionCheckResult[]>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `providers` | `Provider[]` | Providers to check |
| `projectDir` | `string` | Project directory |
| `scope` | `"project" \| "global"` | Which instruction files to check |
| `expectedContent` | `string` | Expected content for comparison (optional) |

**Returns**: `Promise<InjectionCheckResult[]>` -- Array of status results.

```typescript
import { getAllProviders, checkAllInjections } from "@cleocode/caamp";

const results = await checkAllInjections(
  getAllProviders(),
  "/my/project",
  "project"
);

results.forEach(r =>
  console.log(`${r.provider}: ${r.status} (${r.file})`)
);
```

---

### `injectAll()`

Injects content into all providers' instruction files, deduplicating by file path.

```typescript
async function injectAll(
  providers: Provider[],
  projectDir: string,
  scope: "project" | "global",
  content: string
): Promise<Map<string, "created" | "added" | "updated">>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `providers` | `Provider[]` | Target providers |
| `projectDir` | `string` | Project directory |
| `scope` | `"project" \| "global"` | Which instruction files to modify |
| `content` | `string` | Content to inject |

**Returns**: `Promise<Map<string, "created" | "added" | "updated">>` -- Map of file path to action taken.

```typescript
import { getInstalledProviders, injectAll } from "@cleocode/caamp";

const actions = await injectAll(
  getInstalledProviders(),
  "/my/project",
  "project",
  "## CAAMP Managed\n..."
);

actions.forEach((action, file) => console.log(`${file}: ${action}`));
```

---

### `generateInjectionContent()`

Generates standard CAAMP injection block content with optional MCP server and custom content sections.

```typescript
function generateInjectionContent(options?: {
  mcpServerName?: string;
  customContent?: string;
}): string
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `options.mcpServerName` | `string` | MCP server name to include (optional) |
| `options.customContent` | `string` | Additional custom content (optional) |

**Returns**: `string` -- Markdown content for injection.

```typescript
import { generateInjectionContent } from "@cleocode/caamp";

const content = generateInjectionContent({
  mcpServerName: "caamp",
  customContent: "Custom instructions here",
});
```

---

### `groupByInstructFile()`

Groups providers by their instruction file name for efficient batch operations.

```typescript
function groupByInstructFile(providers: Provider[]): Map<string, Provider[]>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `providers` | `Provider[]` | Providers to group |

**Returns**: `Map<string, Provider[]>` -- Map of instruction file name to providers sharing it.

```typescript
import { getAllProviders, groupByInstructFile } from "@cleocode/caamp";

const grouped = groupByInstructFile(getAllProviders());
grouped.forEach((providers, file) => {
  console.log(`${file}: ${providers.map(p => p.id).join(", ")}`);
});
```

---

## Marketplace

Class for searching and fetching skills from marketplace sources.

### `MarketplaceClient`

Unified marketplace client that aggregates results from multiple marketplace adapters, deduplicates by scoped name, and sorts by star count.

```typescript
class MarketplaceClient {
  constructor(adapters?: MarketplaceAdapter[]);
  async search(query: string, limit?: number): Promise<MarketplaceResult[]>;
  async getSkill(scopedName: string): Promise<MarketplaceResult | null>;
}
```

#### Constructor

```typescript
constructor(adapters?: MarketplaceAdapter[])
```

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `adapters` | `MarketplaceAdapter[]` | `[new SkillsMPAdapter(), new SkillsShAdapter()]` | Custom adapters |

#### `search()`

Searches all marketplace adapters in parallel, deduplicates by `scopedName` (keeping higher star count), and returns results sorted by stars descending.

```typescript
async search(query: string, limit?: number): Promise<MarketplaceResult[]>
```

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `query` | `string` | -- | Search query |
| `limit` | `number` | `20` | Maximum results |

**Returns**: `Promise<MarketplaceResult[]>` -- Deduplicated, sorted results.

> **Note**: Returns `MarketplaceResult[]`, not `MarketplaceSkill[]`. `MarketplaceResult` is the type returned by marketplace adapters and has a different shape than `MarketplaceSkill`. See [MarketplaceResult](#marketplaceresult) for the type definition.

#### `getSkill()`

Gets a specific skill by scoped name, trying each adapter in order until one returns a result.

```typescript
async getSkill(scopedName: string): Promise<MarketplaceResult | null>
```

| Name | Type | Description |
|------|------|-------------|
| `scopedName` | `string` | Scoped skill name (e.g., `"@author/name"`) |

**Returns**: `Promise<MarketplaceResult | null>` -- Skill details or `null` if not found.

```typescript
import { MarketplaceClient } from "@cleocode/caamp";

const marketplace = new MarketplaceClient();

// Search for skills
const results = await marketplace.search("code review", 10);
results.forEach(r => console.log(`${r.scopedName} (${r.stars} stars)`));

// Get a specific skill
const skill = await marketplace.getSkill("@anthropic/code-review");
```

---

## Logger

Functions for controlling CLI output verbosity.

### `setVerbose()`

Enables or disables verbose (debug) output to stderr.

```typescript
function setVerbose(v: boolean): void
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `v` | `boolean` | Enable verbose mode |

**Returns**: `void`

```typescript
import { setVerbose } from "@cleocode/caamp";

setVerbose(true); // Enable debug output
```

---

### `setQuiet()`

Enables or disables quiet mode, which suppresses info and warn output (errors are always shown).

```typescript
function setQuiet(q: boolean): void
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `q` | `boolean` | Enable quiet mode |

**Returns**: `void`

```typescript
import { setQuiet } from "@cleocode/caamp";

setQuiet(true); // Suppress info and warn output
```

---

### `isVerbose()`

Returns whether verbose mode is currently enabled.

```typescript
function isVerbose(): boolean
```

**Parameters**: None

**Returns**: `boolean` -- True if verbose mode is enabled.

```typescript
import { isVerbose } from "@cleocode/caamp";

if (isVerbose()) {
  // Additional debug output
}
```

---

### `isQuiet()`

Returns whether quiet mode is currently enabled.

```typescript
function isQuiet(): boolean
```

**Parameters**: None

**Returns**: `boolean` -- True if quiet mode is enabled.

```typescript
import { isQuiet } from "@cleocode/caamp";

if (!isQuiet()) {
  console.log("Status: OK");
}
```

---

## Complete Export List

Alphabetical checklist of exported symbols from `src/index.ts`.

### Types

- [ ] `AuditFinding`
- [ ] `AuditResult`
- [ ] `AuditRule`
- [ ] `AuditSeverity`
- [ ] `BatchInstallOptions`
- [ ] `BatchInstallResult`
- [ ] `CaampLockFile`
- [ ] `ConfigFormat`
- [ ] `ConflictPolicy`
- [ ] `DetectionResult`
- [ ] `DualScopeConfigureOptions`
- [ ] `DualScopeConfigureResult`
- [ ] `GlobalOptions`
- [ ] `HookEvent`
- [ ] `InjectionCheckResult`
- [ ] `InjectionStatus`
- [ ] `InstructionUpdateSummary`
- [ ] `InstallResult`
- [ ] `LockEntry`
- [ ] `MarketplaceResult`
- [ ] `MarketplaceSearchResult`
- [ ] `MarketplaceSkill`
- [ ] `McpServerConfig`
- [ ] `McpServerEntry`
- [ ] `McpBatchOperation`
- [ ] `McpConflict`
- [ ] `McpConflictCode`
- [ ] `McpPlanApplyResult`
- [ ] `ParsedSource`
- [ ] `Provider`
- [ ] `ProviderCapabilities`
- [ ] `ProviderHooksCapability`
- [ ] `ProviderPriority`
- [ ] `ProviderSkillsCapability`
- [ ] `ProviderSpawnCapability`
- [ ] `ProviderStatus`
- [ ] `SkillEntry`
- [ ] `SkillInstallResult`
- [ ] `SkillMetadata`
- [ ] `SkillBatchOperation`
- [ ] `SkillsPrecedence`
- [ ] `SourceType`
- [ ] `SpawnAdapter`
- [ ] `SpawnMechanism`
- [ ] `SpawnOptions`
- [ ] `SpawnResult`
- [ ] `TransportType`
- [ ] `ValidationIssue`
- [ ] `ValidationResult`

### Functions

- [ ] `applyMcpInstallWithPolicy`
- [x] `buildSkillsMap`
- [ ] `buildServerConfig`
- [ ] `checkAllInjections`
- [ ] `checkInjection`
- [ ] `checkSkillUpdate`
- [ ] `configureProviderGlobalAndProject`
- [ ] `deepMerge`
- [ ] `detectMcpConfigConflicts`
- [ ] `detectAllProviders`
- [ ] `detectProjectProviders`
- [x] `detectProvider`
- [ ] `discoverSkill`
- [ ] `discoverSkills`
- [ ] `ensureDir`
- [ ] `generateInjectionContent`
- [x] `getCommonHookEvents`
- [x] `getEffectiveSkillsPaths`
- [x] `getAllProviders`
- [x] `getInstalledProviders`
- [ ] `getInstructionFiles`
- [ ] `getLastSelectedAgents`
- [ ] `getNestedValue`
- [x] `getProvider`
- [x] `getProviderCapabilities`
- [ ] `getProviderCount`
- [x] `getProvidersByHookEvent`
- [x] `getProvidersByInstructFile`
- [x] `getProvidersByPriority`
- [x] `getProvidersBySkillsPrecedence`
- [x] `getProvidersBySpawnCapability`
- [x] `getProvidersByStatus`
- [ ] `getRegistryVersion`
- [x] `getSpawnCapableProviders`
- [ ] `getTrackedMcpServers`
- [ ] `getTrackedSkills`
- [ ] `getTransform`
- [ ] `groupByInstructFile`
- [ ] `inject`
- [ ] `injectAll`
- [ ] `installBatchWithRollback`
- [ ] `installMcpServer`
- [ ] `installMcpServerToAll`
- [ ] `installSkill`
- [ ] `isMarketplaceScoped`
- [ ] `isQuiet`
- [ ] `isVerbose`
- [ ] `listAllMcpServers`
- [ ] `listCanonicalSkills`
- [ ] `listMcpServers`
- [ ] `parseSkillFile`
- [ ] `parseSource`
- [x] `providerSupports`
- [x] `providerSupportsById`
- [ ] `readConfig`
- [ ] `readLockFile`
- [ ] `recordMcpInstall`
- [ ] `recordSkillInstall`
- [ ] `removeConfig`
- [ ] `removeInjection`
- [ ] `removeMcpFromLock`
- [ ] `removeMcpServer`
- [ ] `removeSkill`
- [ ] `removeSkillFromLock`
- [ ] `resolveAlias`
- [ ] `resolveConfigPath`
- [ ] `resolveProviderSkillsDirs`
- [ ] `saveLastSelectedAgents`
- [ ] `scanDirectory`
- [ ] `scanFile`
- [ ] `selectProvidersByMinimumPriority`
- [ ] `setQuiet`
- [ ] `setVerbose`
- [ ] `toSarif`
- [ ] `updateInstructionsSingleOperation`
- [ ] `validateSkill`
- [ ] `writeConfig`

### Classes (1)

- [ ] `MarketplaceClient`
