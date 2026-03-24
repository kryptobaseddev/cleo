# CAAMP Technical Specification

## Document Information

| Field | Value |
|-------|-------|
| Version | 1.0.0 |
| Status | Draft |
| Date | 2026-02-11 |
| Package | `@cleocode/caamp` v0.1.0 |
| License | MIT |
| Node Engine | `>=18` |

---

## 1. Introduction

### 1.1 Purpose

This document specifies the technical requirements, data structures, algorithms, and APIs of CAAMP (Central AI Agent Managed Packages). CAAMP is a unified provider registry and package manager for AI coding agents, providing a single source of truth for Skills, MCP (Model Context Protocol) servers, instruction files, and configuration management across 28 AI agent providers.

### 1.2 Scope

This specification covers:

- The provider registry file format and runtime resolution
- Provider auto-detection algorithms
- Config file format handling (JSON, JSONC, YAML, TOML)
- MCP server installation, transformation, listing, and removal
- Skills management via the canonical+symlink installation model
- Security audit scanning with SARIF output
- Marketplace integration via the adapter pattern
- Source URL/path classification
- Instruction file marker-based injection
- LAFS adoption profile and compliance mapping
- Lock file schema and operations
- Library API surface (57 exports)
- CLI command structure

### 1.3 Conformance Levels

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://www.ietf.org/rfc/rfc2119.txt).

**Implementation conformance levels:**

- **Level 1 (Core)**: Provider registry, detection, config formats, MCP install/remove
- **Level 2 (Skills)**: Skills install, discovery, validation, audit
- **Level 3 (Full)**: Marketplace integration, instruction injection, lock file tracking

A conforming implementation MUST support Level 1. It SHOULD support Level 2. It MAY support Level 3.

### 1.4 LAFS Baseline Requirement

CAAMP adopts the LLM-Agent-First Specification (LAFS) as a normative default for agent-facing outputs.

- Canonical protocol source: `https://github.com/kryptobaseddev/lafs/blob/main/lafs.md`.
- Package source: `@cleocode/lafs`.
- CAAMP adoption and evidence mapping: `docs/LAFS-COMPLIANCE.md`.

---

## 2. Terminology

| Term | Definition |
|------|-----------|
| **Provider** | An AI coding agent tool (e.g., Claude Code, Cursor, Windsurf) with a defined configuration schema and detection method |
| **Skill** | A directory containing a `SKILL.md` file with YAML frontmatter that provides instructions to an AI agent |
| **MCP Server** | A Model Context Protocol server that extends agent capabilities via stdio, SSE, or HTTP transport |
| **Instruction File** | A markdown file (`CLAUDE.md`, `AGENTS.md`, or `GEMINI.md`) containing per-project or global instructions for AI agents |
| **Config Key** | The JSON/YAML/TOML key under which MCP server entries are stored in a provider's config (e.g., `mcpServers`, `extensions`, `context_servers`) |
| **Lock File** | A JSON file at `~/.agents/.caamp-lock.json` tracking installed skills and MCP servers with provenance metadata |
| **Canonical Copy** | The single authoritative copy of a skill stored at `~/.agents/skills/<name>/` |
| **Symlink** | A filesystem symbolic link from an agent's skills directory to the canonical copy |
| **Source** | A string input that resolves to a skill or MCP server location (URL, npm package, GitHub shorthand, local path, or command) |
| **Transport** | The communication protocol between an agent and an MCP server: `stdio`, `sse`, or `http` |
| **Detection Method** | A technique for determining if a provider is installed: `binary`, `directory`, `appBundle`, or `flatpak` |
| **Audit Rule** | A pattern-matching security rule applied to skill content, producing findings with severity levels |
| **Marketplace** | An external API for discovering and searching published skills (agentskills.in, skills.sh) |
| **Transform** | A function that converts canonical `McpServerConfig` to a provider-specific config shape |
| **Config Format** | One of `json`, `jsonc`, `yaml`, or `toml` |
| **LAFS** | External protocol reference. Canonical source: `https://github.com/kryptobaseddev/lafs/blob/main/lafs.md` |
| **MVI** | Defined by LAFS. CAAMP adopts it through the LAFS compliance profile |

---

## 3. Provider Registry Specification

### 3.1 Registry File Format

The provider registry MUST be stored as a single JSON file at `providers/registry.json` relative to the package root.

**Schema:**

```typescript
interface ProviderRegistry {
  version: string;       // Semantic version of the registry
  lastUpdated: string;   // ISO 8601 date string
  providers: Record<string, RegistryProvider>;
}
```

The file MUST be valid JSON (not JSONC). The `version` field MUST follow semantic versioning. The `lastUpdated` field MUST be an ISO 8601 date string.

### 3.2 Provider Record Schema

Each provider entry in the registry MUST conform to:

```typescript
interface RegistryProvider {
  id: string;                        // Unique identifier (kebab-case)
  toolName: string;                  // Human-readable display name
  vendor: string;                    // Company or organization name
  agentFlag: string;                 // CLI --agent flag value
  aliases: string[];                 // Alternative identifiers for lookup

  pathGlobal: string;                // Global config directory template
  pathProject: string;               // Project-relative config directory

  instructFile: string;              // Instruction file name (CLAUDE.md, AGENTS.md, or GEMINI.md)

  configKey: string;                 // JSON path for MCP server entries
  configFormat: string;              // One of: "json", "jsonc", "yaml", "toml"
  configPathGlobal: string;          // Global config file path template
  configPathProject: string | null;  // Project config file path (null if unsupported)

  pathSkills: string;                // Global skills directory template
  pathProjectSkills: string;         // Project skills directory

  detection: RegistryDetection;      // Detection configuration

  supportedTransports: string[];     // Array of: "stdio", "sse", "http"
  supportsHeaders: boolean;          // Whether HTTP headers are supported

  priority: string;                  // One of: "high", "medium", "low"
  status: string;                    // One of: "active", "beta", "deprecated", "planned"
  agentSkillsCompatible: boolean;    // Whether provider supports SKILL.md format
}

interface RegistryDetection {
  methods: string[];         // Detection methods to attempt, in order
  binary?: string;           // Binary name for PATH lookup
  directories?: string[];    // Directories to check for existence
  appBundle?: string;        // macOS app bundle name (e.g., "Zed.app")
  flatpakId?: string;        // Flatpak application ID
}
```

### 3.3 Required Fields

All fields in `RegistryProvider` are REQUIRED except:

- `configPathProject`: MAY be `null` for providers without project-level config (e.g., Claude Desktop, Goose)
- `detection.binary`: REQUIRED only if `detection.methods` includes `"binary"`
- `detection.directories`: REQUIRED only if `detection.methods` includes `"directory"`
- `detection.appBundle`: REQUIRED only if `detection.methods` includes `"appBundle"`
- `detection.flatpakId`: REQUIRED only if `detection.methods` includes `"flatpak"`

### 3.4 Path Template Variables

Registry path values MAY contain template variables that MUST be resolved at runtime:

| Variable | Resolution |
|----------|------------|
| `$HOME` | `os.homedir()` |
| `$CONFIG` | `XDG_CONFIG_HOME` or `$HOME/.config` (Linux/macOS), `APPDATA` (Windows) |
| `$VSCODE_CONFIG` | Platform-specific VS Code user config directory |
| `$ZED_CONFIG` | Platform-specific Zed config directory |
| `$CLAUDE_DESKTOP_CONFIG` | Platform-specific Claude Desktop config directory |

**Platform resolution:**

| Variable | macOS | Linux | Windows |
|----------|-------|-------|---------|
| `$CONFIG` | `$XDG_CONFIG_HOME` or `$HOME/.config` | `$XDG_CONFIG_HOME` or `$HOME/.config` | `%APPDATA%` |
| `$VSCODE_CONFIG` | `$HOME/Library/Application Support/Code/User` | `$CONFIG/Code/User` | `%APPDATA%/Code/User` |
| `$ZED_CONFIG` | `$HOME/Library/Application Support/Zed` | `$CONFIG/zed` | `%APPDATA%/Zed` |
| `$CLAUDE_DESKTOP_CONFIG` | `$HOME/Library/Application Support/Claude` | `$CONFIG/Claude` | `%APPDATA%/Claude` |

### 3.5 Provider Status Lifecycle

```typescript
type ProviderStatus = "active" | "beta" | "deprecated" | "planned";
```

- **`planned`**: Provider definition exists but is not yet supported
- **`beta`**: Provider is supported but MAY have incomplete functionality
- **`active`**: Provider is fully supported and tested
- **`deprecated`**: Provider is scheduled for removal; implementations SHOULD emit a warning when used

### 3.6 Priority Tiers

```typescript
type ProviderPriority = "high" | "medium" | "low";
```

Priority tiers affect display ordering and default selection behavior:

- **`high`**: Major widely-adopted agents. Current: `claude-code`, `cursor`, `windsurf`
- **`medium`**: Well-known agents with significant adoption. Current: `codex`, `gemini-cli`, `github-copilot`, `opencode`, `cline`, `kimi`, `vscode`, `zed`, `claude-desktop`
- **`low`**: Smaller or newer agents

### 3.7 Config Key Mapping

Implementations MUST write MCP server entries under the correct config key for each provider:

| Config Key | Providers |
|------------|-----------|
| `mcpServers` | claude-code, claude-desktop, cursor, gemini-cli, github-copilot, cline, kimi, windsurf, roo, continue, antigravity, kiro-cli, amp, trae, aide, pear-ai, void-ai, cody, kilo-code, qwen-code, openhands, codebuddy, codestory |
| `mcp_servers` | codex |
| `extensions` | goose |
| `mcp` | opencode |
| `servers` | vscode |
| `context_servers` | zed |

### 3.8 Instruction File Mapping

Three instruction files cover all 28 providers:

| Instruction File | Providers |
|-----------------|-----------|
| `CLAUDE.md` | claude-code, claude-desktop |
| `GEMINI.md` | gemini-cli |
| `AGENTS.md` | All other providers (26 providers) |

Implementations MUST NOT generate instruction files other than these three.

### 3.9 Runtime Provider Resolution

The runtime `Provider` interface is resolved from `RegistryProvider` by expanding all path template variables:

```typescript
interface Provider {
  id: string;
  toolName: string;
  vendor: string;
  agentFlag: string;
  aliases: string[];
  pathGlobal: string;                  // Resolved absolute path
  pathProject: string;                 // Relative path (no expansion)
  instructFile: string;
  configKey: string;
  configFormat: ConfigFormat;          // Typed enum
  configPathGlobal: string;            // Resolved absolute path
  configPathProject: string | null;    // Relative path or null
  pathSkills: string;                  // Resolved absolute path
  pathProjectSkills: string;           // Relative path
  detection: DetectionConfig;          // Typed detection config
  supportedTransports: TransportType[];// Typed array
  supportsHeaders: boolean;
  priority: ProviderPriority;          // Typed enum
  status: ProviderStatus;             // Typed enum
  agentSkillsCompatible: boolean;
}
```

The registry MUST be loaded lazily (on first access) and cached for the lifetime of the process. An alias map MUST be built during loading for O(1) alias resolution.

### 3.10 Registry Discovery

The implementation MUST search for `providers/registry.json` in the following order:

1. Development path: `<module-dir>/../../../providers/registry.json` (3 levels up from `src/core/registry/`)
2. Bundled path: `<module-dir>/../providers/registry.json` (1 level up from `dist/`)
3. Fallback: Traverse up to 5 parent directories from the module location

If not found, the implementation MUST throw an `Error` with a descriptive message including the search start path.

---

## 4. Detection Engine Specification

### 4.1 Detection Methods

```typescript
type DetectionMethod = "binary" | "directory" | "appBundle" | "flatpak";
```

For each provider, the detection engine MUST iterate through `detection.methods` in declared order and attempt each method:

**binary**: Check if `detection.binary` exists in the system PATH.
- Implementation MUST use `which` on Unix-like systems
- A provider is detected if `which <binary>` returns exit code 0

**directory**: Check if any path in `detection.directories` exists on the filesystem.
- Implementation MUST use `fs.existsSync()` on resolved paths
- A provider is detected if at least one directory exists

**appBundle**: Check if `detection.appBundle` exists in `/Applications/` (macOS only).
- Implementation MUST return `false` on non-macOS platforms
- Checks `existsSync(join("/Applications", appName))`

**flatpak**: Check if `detection.flatpakId` is installed via Flatpak (Linux only).
- Implementation MUST return `false` on non-Linux platforms
- Uses `flatpak info <flatpakId>` with exit code check

### 4.2 Detection Result Schema

```typescript
interface DetectionResult {
  provider: Provider;          // The full provider record
  installed: boolean;          // true if ANY detection method matched
  methods: string[];           // List of methods that matched
  projectDetected: boolean;    // true if pathProject exists in cwd
}
```

A provider is considered **installed** if `methods.length > 0`.

### 4.3 Project Detection

Project-level detection checks if `provider.pathProject` exists as a directory within a given project directory:

```typescript
function detectProjectProvider(provider: Provider, projectDir: string): boolean
```

Returns `false` if `provider.pathProject` is empty.

### 4.4 API Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `detectProvider` | `(provider: Provider) => DetectionResult` | Detect a single provider |
| `detectAllProviders` | `() => DetectionResult[]` | Detect all registered providers |
| `getInstalledProviders` | `() => Provider[]` | Return only installed providers |
| `detectProjectProviders` | `(projectDir: string) => DetectionResult[]` | Detect with project-level info |

---

## 5. Config Format Specification

### 5.1 Supported Formats

```typescript
type ConfigFormat = "json" | "jsonc" | "yaml" | "toml";
```

The format router (`core/formats/index.ts`) dispatches all operations to format-specific handlers based on the provider's `configFormat` field.

### 5.2 Read Operations

```typescript
async function readConfig(filePath: string, format: ConfigFormat): Promise<Record<string, unknown>>
```

- MUST return an empty object `{}` if the file does not exist
- MUST return an empty object `{}` if the file exists but is empty
- MUST parse content according to the specified format
- For `json` and `jsonc` formats, the implementation MUST use `jsonc-parser` which handles both standard JSON and JSONC (with comments, trailing commas)

### 5.3 Write Operations

```typescript
async function writeConfig(
  filePath: string,
  format: ConfigFormat,
  key: string,
  serverName: string,
  serverConfig: unknown,
): Promise<void>
```

- MUST create parent directories if they do not exist (`ensureDir`)
- MUST create the file with `{}` as initial content if it does not exist
- MUST merge the new server entry at the JSON path `[...key.split("."), serverName]`
- MUST ensure a trailing newline in the output

### 5.4 Remove Operations

```typescript
async function removeConfig(
  filePath: string,
  format: ConfigFormat,
  key: string,
  serverName: string,
): Promise<boolean>
```

- MUST return `false` if the file does not exist or is empty
- MUST return `false` if the server entry does not exist at the specified path
- MUST return `true` if the entry was successfully removed
- MUST write the modified content back to disk

### 5.5 Comment Preservation (JSONC)

For `json` and `jsonc` formats, the implementation MUST preserve existing comments and formatting using the `jsonc-parser` library:

- Reads MUST use `jsonc.parse()` with error collection
- Writes MUST use `jsonc.modify()` to generate minimal text edits
- Edits MUST be applied with `jsonc.applyEdits()`
- Indentation MUST be auto-detected from existing file content

The implementation MUST detect indentation by scanning lines for leading whitespace:
- Tab characters indicate `tabSize: 1, insertSpaces: false`
- Space characters use the detected width (default: 2 spaces)

### 5.6 Deep Merge Semantics

```typescript
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown>
```

The deep merge algorithm follows these rules:

1. For each key in `source`:
   - If both `source[key]` and `target[key]` are non-null, non-array objects: recursively merge
   - Otherwise: `source[key]` wins (overwrites `target[key]`)
2. Arrays are NOT recursively merged; source arrays replace target arrays entirely
3. `null` values in source overwrite target values
4. The merge MUST NOT mutate either input; it MUST return a new object

### 5.7 Nested Key Paths

Config keys support dot-notation for nested structures (e.g., `configKey: "mcp_servers"` creates the path `["mcp_servers", serverName]`).

```typescript
function getNestedValue(obj: Record<string, unknown>, keyPath: string): unknown
```

- Splits `keyPath` on `.` and traverses the object
- Returns `undefined` if any intermediate value is not an object

```typescript
function setNestedValue(
  obj: Record<string, unknown>,
  keyPath: string,
  key: string,
  value: unknown,
): Record<string, unknown>
```

- Creates intermediate objects as needed
- MUST NOT mutate the input object

### 5.8 YAML Handling

YAML operations use `js-yaml` with the following dump options:

```typescript
{
  indent: 2,
  lineWidth: -1,    // No line wrapping
  noRefs: true,     // No YAML anchors/aliases
  sortKeys: false,  // Preserve key order
}
```

YAML writes use full read-merge-write: read existing, deep merge, dump entire object.

### 5.9 TOML Handling

TOML operations use `@iarna/toml`. TOML writes follow the same read-merge-write pattern as YAML.

---

## 6. MCP Server Management Specification

### 6.1 Installation Flow

MCP server installation follows this pipeline:

```
source string
    |
    v
parseSource() --> ParsedSource
    |
    v
buildServerConfig() --> McpServerConfig (canonical)
    |
    v
getTransform(providerId) --> transform function or undefined
    |
    v
transform(serverName, config) --> provider-specific config
    |
    v
writeConfig(path, format, key, name, transformedConfig) --> file write
    |
    v
recordMcpInstall() --> lock file update
```

### 6.2 Server Config Schema (Canonical)

The canonical MCP server configuration is the intermediate representation before per-agent transformation:

```typescript
interface McpServerConfig {
  type?: TransportType;               // "stdio" | "sse" | "http"
  url?: string;                       // Remote server URL (for sse/http)
  headers?: Record<string, string>;   // HTTP headers (for sse/http)
  command?: string;                    // Binary to execute (for stdio)
  args?: string[];                     // Command arguments (for stdio)
  env?: Record<string, string>;        // Environment variables (for stdio)
}
```

**Invariants:**
- A remote server MUST have `url` set and SHOULD have `type` set
- A stdio server MUST have `command` set
- `headers` SHOULD only be set when `url` is present
- `env` SHOULD only be set when `command` is present

### 6.3 Transport Types

```typescript
type TransportType = "stdio" | "sse" | "http";
```

| Transport | Protocol | Default For |
|-----------|----------|-------------|
| `stdio` | Standard I/O (stdin/stdout) | Local commands, npm packages |
| `sse` | Server-Sent Events over HTTP | Legacy remote servers |
| `http` | Streamable HTTP | Modern remote servers (default) |

The `buildServerConfig()` function determines transport from source type:
- `remote` source: defaults to `http` transport
- `package` source: generates `npx -y <package>` stdio config
- `command` source: splits on whitespace into command + args

### 6.4 Per-Agent Transforms

Five providers require non-standard config shapes. The `getTransform(providerId)` function returns a transform function or `undefined` for passthrough.

**Goose** (`extensions` key, YAML format):

```typescript
// Remote:
{ name: serverName, type: "streamable_http"|"sse", uri: url, headers?, enabled: true, timeout: 300 }
// Stdio:
{ name: serverName, type: "stdio", cmd: command, args: [], envs?, enabled: true, timeout: 300 }
```

Key differences: `uri` instead of `url`, `cmd` instead of `command`, `envs` instead of `env`, adds `enabled` and `timeout` fields.

**Zed** (`context_servers` key, JSONC format):

```typescript
// Remote:
{ source: "custom", type: "http"|type, url, headers? }
// Stdio:
{ source: "custom", command, args: [], env? }
```

Key differences: adds `source: "custom"` field, no `type` field for stdio.

**OpenCode** (`mcp` key, JSON format):

```typescript
// Remote:
{ type: "remote", url, enabled: true, headers? }
// Stdio:
{ type: "local", command, args: [], enabled: true, environment? }
```

Key differences: `type` is `"remote"`/`"local"`, `environment` instead of `env`, adds `enabled` field.

**Codex** (`mcp_servers` key, TOML format):

```typescript
// Remote:
{ type: "http"|type, url, headers? }
// Stdio:
{ command, args: [], env? }
```

Key differences: no `type` field for stdio.

**Cursor** (`mcpServers` key, JSON format):

```typescript
// Remote:
{ url, headers? }
// Stdio:
config  // passthrough (no changes)
```

Key differences: strips the `type` field from remote configs.

All other providers (23 providers) use the canonical `McpServerConfig` as-is (passthrough).

### 6.5 Config Path Resolution

```typescript
function resolveConfigPath(
  provider: Provider,
  scope: "project" | "global",
  projectDir?: string,
): string | null
```

- For `scope: "project"`: Returns `join(projectDir ?? cwd, provider.configPathProject)`, or `null` if `configPathProject` is null
- For `scope: "global"`: Returns `provider.configPathGlobal` (already resolved)

### 6.6 List and Remove Operations

**Listing** (`listMcpServers`):

1. Resolve config path for provider and scope
2. Read the config file using the provider's format
3. Extract the nested value at `provider.configKey`
4. Map each entry to `McpServerEntry`:

```typescript
interface McpServerEntry {
  name: string;                        // Server entry name
  providerId: string;                  // Provider ID
  providerName: string;                // Provider display name
  scope: "project" | "global";        // Config scope
  configPath: string;                  // Absolute config file path
  config: Record<string, unknown>;     // Raw config entry
}
```

**Listing all** (`listAllMcpServers`): Iterates providers, deduplicating by config path (since multiple providers may share config files).

**Removal** (`removeMcpServer`): Delegates to `removeConfig()` with the provider's format, key, and server name.

### 6.7 Lock File Operations for MCP

See Section 11 for the shared lock file schema. MCP-specific operations:

| Function | Description |
|----------|-------------|
| `recordMcpInstall(name, source, sourceType, agents, isGlobal)` | Record installation; merges agent list if entry exists |
| `removeMcpFromLock(name)` | Remove entry from lock file |
| `getTrackedMcpServers()` | Return all MCP entries from lock file |
| `saveLastSelectedAgents(agents)` | Persist last agent selection for UX |
| `getLastSelectedAgents()` | Retrieve last selected agents |

---

## 7. Skills Management Specification

### 7.1 Installation Model (Canonical + Symlink)

Skills use a store-once, link-many architecture:

```
~/.agents/skills/<name>/         <-- Canonical copy (single source of truth)
    SKILL.md
    ...other files...

~/.claude/skills/<name> -> ~/.agents/skills/<name>/   <-- Symlink
~/.cursor/skills/<name> -> ~/.agents/skills/<name>/   <-- Symlink
.claude/skills/<name>   -> ~/.agents/skills/<name>/   <-- Symlink (project)
```

The canonical directory MUST be `$HOME/.agents/skills/`.

**Installation steps:**

1. `installToCanonical(sourcePath, skillName)`: Copy source to `~/.agents/skills/<name>/`, removing any existing directory
2. `linkToAgent(canonicalPath, provider, skillName, isGlobal, projectDir)`: Create a symlink from each target agent's skills directory to the canonical path

**Symlink creation:**
- On Windows, use `"junction"` type for directory symlinks
- On other platforms, use `"dir"` type
- If symlink creation fails, fall back to recursive copy

**Removal steps:**

1. Remove symlinks from each agent's skills directory
2. Remove the canonical copy at `~/.agents/skills/<name>/`

### 7.2 Source Types and Parsing

```typescript
type SourceType = "remote" | "package" | "command" | "github" | "gitlab" | "local";
```

The `parseSource(input)` function classifies source strings using this priority order:

| Priority | Pattern | Source Type | Example |
|----------|---------|-------------|---------|
| 1 | `https://github.com/<owner>/<repo>...` | `github` | `https://github.com/user/repo` |
| 2 | `https://gitlab.com/<owner>/<repo>...` | `gitlab` | `https://gitlab.com/user/repo` |
| 3 | `https://...` (other HTTP URLs) | `remote` | `https://mcp.neon.tech/sse` |
| 4 | Starts with `/`, `./`, `../`, or `~` | `local` | `./my-skill` |
| 5 | `<owner>/<repo>[/path]` (not npm scoped) | `github` | `user/repo` |
| 6 | `@scope/name` | `package` | `@modelcontextprotocol/server-postgres` |
| 7 | `[a-zA-Z0-9_.-]+` (no spaces) | `package` | `mcp-server-fetch` |
| 8 | Everything else | `command` | `python3 -m mcp_server` |

**Parsed source schema:**

```typescript
interface ParsedSource {
  type: SourceType;
  value: string;            // Original or normalized value
  inferredName: string;     // Display name inferred from source
  owner?: string;           // GitHub/GitLab owner
  repo?: string;            // GitHub/GitLab repo name
  path?: string;            // Sub-path within repo
  ref?: string;             // Git ref (branch/tag)
}
```

**Name inference rules:**
- `remote`: Extract brand from hostname (e.g., `mcp.neon.tech` -> `neon`)
- `package`: Strip common MCP prefixes/suffixes (`mcp-server-`, `server-`, `-mcp`, `-server`, and scope)
- `github`/`gitlab`: Use repo name
- `command`: First meaningful word (skipping `npx`, `node`, `python`, `python3`, and flags)

**Marketplace scope detection:**

```typescript
function isMarketplaceScoped(input: string): boolean
```

Returns `true` for strings matching `@[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+`.

### 7.3 SKILL.md Format

A valid SKILL.md file MUST start with YAML frontmatter delimited by `---`:

```yaml
---
name: my-skill-name
description: A description of what this skill does
license: MIT                           # Optional
compatibility: claude-code, cursor     # Optional
version: 1.0.0                         # Optional
allowed-tools:                         # Optional (also accepts allowedTools)
  - Read
  - Write
  - Bash
metadata:                              # Optional key-value pairs
  category: development
---

# Skill body content here (markdown instructions for the AI agent)
```

**Required frontmatter fields:**

| Field | Type | Requirements |
|-------|------|--------------|
| `name` | string | REQUIRED. Lowercase letters, numbers, hyphens only. 1-64 characters. Pattern: `/^[a-z0-9][a-z0-9-]*[a-z0-9]$\|^[a-z0-9]$/` |
| `description` | string | REQUIRED. Maximum 1024 characters. |

**Parsed metadata:**

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

The `allowedTools` field accepts both `allowed-tools` (YAML convention) and `allowedTools` (camelCase). If provided as a string, it MUST be split on whitespace.

### 7.4 Validation Rules

The validator (`validateSkill`) checks:

**Errors (cause validation failure):**

| Check | Rule |
|-------|------|
| File existence | File MUST exist |
| Frontmatter presence | File MUST start with `---` |
| Frontmatter parsing | YAML MUST be parseable |
| Name required | `name` MUST be present |
| Name length | `name` MUST NOT exceed 64 characters |
| Name pattern | `name` MUST match `/^[a-z0-9][a-z0-9-]*[a-z0-9]$\|^[a-z0-9]$/` |
| Name reserved | `name` MUST NOT be one of: `anthropic`, `claude`, `google`, `openai`, `microsoft`, `cursor`, `windsurf`, `codex`, `gemini`, `copilot` |
| Name XSS | `name` MUST NOT contain XML/HTML tags |
| Description required | `description` MUST be present |
| Description length | `description` MUST NOT exceed 1024 characters |
| Description XSS | `description` MUST NOT contain XML/HTML tags |

**Warnings (do not cause failure):**

| Check | Rule |
|-------|------|
| Description length | Warning if `description` < 50 characters |
| Body length | Warning if body exceeds 500 lines |
| Body empty | Warning if body is empty |

**Validation result schema:**

```typescript
interface ValidationResult {
  valid: boolean;                           // true if no errors
  issues: ValidationIssue[];               // All errors and warnings
  metadata: Record<string, unknown> | null; // Parsed frontmatter or null
}

interface ValidationIssue {
  level: "error" | "warning";
  field: string;
  message: string;
}
```

### 7.5 Discovery Algorithm

**Single skill discovery** (`discoverSkill(skillDir)`):

1. Check if `SKILL.md` exists in `skillDir`
2. Parse the file with `gray-matter`
3. Return `SkillEntry` if `name` and `description` are present, else `null`

**Directory discovery** (`discoverSkills(rootDir)`):

1. List entries in `rootDir`
2. For each directory or symlink entry, attempt `discoverSkill`
3. Return array of all discovered `SkillEntry` objects

**Multi-directory discovery** (`discoverSkillsMulti(dirs)`):

1. Iterate directories
2. Call `discoverSkills` on each
3. Deduplicate by skill name (first occurrence wins)

**Skill entry schema:**

```typescript
interface SkillEntry {
  name: string;                  // Skill name from frontmatter
  scopedName: string;            // Scoped name (same as name for local)
  path: string;                  // Absolute path to skill directory
  metadata: SkillMetadata;       // Parsed frontmatter
  source?: string;               // Source URL if known
}
```

### 7.6 Lock File Schema for Skills

See Section 11 for shared lock file schema. Skills-specific operations:

| Function | Description |
|----------|-------------|
| `recordSkillInstall(name, scopedName, source, sourceType, agents, canonicalPath, isGlobal, projectDir?, version?)` | Record with full provenance |
| `removeSkillFromLock(name)` | Remove entry |
| `getTrackedSkills()` | Return all skill entries |
| `checkSkillUpdate(name)` | Check for available updates (stub: returns `hasUpdate: false`) |

### 7.7 Install Result Schema

```typescript
interface SkillInstallResult {
  name: string;
  canonicalPath: string;
  linkedAgents: string[];     // Provider IDs that were successfully linked
  errors: string[];           // Error messages for failed links
  success: boolean;           // true if linkedAgents.length > 0
}
```

---

## 8. Security Audit Specification

### 8.1 Audit Rule Schema

```typescript
interface AuditRule {
  id: string;                  // Unique rule identifier (e.g., "PI001")
  name: string;                // Human-readable rule name
  description: string;         // What the rule detects
  severity: AuditSeverity;     // Severity level
  category: string;            // Rule category
  pattern: RegExp;             // Regex pattern to match
}
```

### 8.2 Rule Categories

The scanner defines 46 rules across 8 categories:

| Category | ID Prefix | Rule Count | Description |
|----------|-----------|------------|-------------|
| `prompt-injection` | PI | 8 | System prompt overrides, role manipulation, jailbreaks, hidden instructions, encoding bypasses, context manipulation, token smuggling |
| `command-injection` | CI | 8 | Destructive commands, remote code execution, eval usage, shell spawn, sudo escalation, environment manipulation, cron jobs, network listeners |
| `data-exfiltration` | DE | 6 | Credential access, API key extraction, data upload, browser data theft, git credential theft, keychain access |
| `privilege-escalation` | PE | 4 | Dangerous chmod, SUID/SGID bits, Docker escape, kernel modules |
| `filesystem` | FS | 4 | System directory writes, hidden files, symlink attacks, mass file operations |
| `network` | NA | 4 | DNS exfiltration, reverse shells, port scanning, proxy/tunnels |
| `obfuscation` | OB | 3 | Hex encoding, string concatenation, Unicode escapes |
| `supply-chain` | SC | 4 | Runtime package install, typosquatting, postinstall scripts, registry overrides |
| `info-disclosure` | ID | 3 | Process listing, system information, network enumeration |

### 8.3 Severity Levels

```typescript
type AuditSeverity = "critical" | "high" | "medium" | "low" | "info";
```

**Severity weights for scoring:**

| Severity | Weight | Meaning |
|----------|--------|---------|
| `critical` | 25 | Immediate security threat; MUST be addressed before use |
| `high` | 15 | Significant security risk; SHOULD be addressed |
| `medium` | 8 | Moderate risk; review RECOMMENDED |
| `low` | 3 | Minor concern; informational review |
| `info` | 0 | Informational only; does not affect score |

### 8.4 Scanning Algorithm

```typescript
async function scanFile(filePath: string, rules?: AuditRule[]): Promise<AuditResult>
```

1. Read file content as UTF-8
2. Split into lines
3. For each rule, for each line:
   - Test `line.match(rule.pattern)`
   - If matched, record finding with line number, column, matched text, and line context
4. Calculate score: `max(0, 100 - sum(severity_weights))`
5. Determine pass/fail: `passed = true` if no `critical` or `high` findings

**Finding schema:**

```typescript
interface AuditFinding {
  rule: AuditRule;
  line: number;         // 1-indexed line number
  column: number;       // 1-indexed column number
  match: string;        // Matched text
  context: string;      // Trimmed line content
}
```

**Result schema:**

```typescript
interface AuditResult {
  file: string;
  findings: AuditFinding[];
  score: number;          // 0-100, where 100 = clean
  passed: boolean;        // true if no critical/high findings
}
```

**Directory scanning** (`scanDirectory`):

1. List directory entries
2. For each directory/symlink, check for `SKILL.md`
3. Scan each found `SKILL.md`
4. Return array of `AuditResult`

### 8.5 SARIF Output Format

The `toSarif(results)` function produces a SARIF 2.1.0 document:

```typescript
{
  $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
  version: "2.1.0",
  runs: [{
    tool: {
      driver: {
        name: "caamp-audit",
        version: "0.1.0",
        rules: [/* all 46 rules as SARIF rule descriptors */],
      }
    },
    results: [/* findings mapped to SARIF result objects */]
  }]
}
```

Each finding is mapped to a SARIF result with:
- `ruleId`: The rule's ID
- `level`: `"error"` for critical/high, `"warning"` for others
- `message.text`: `"{description}: {match}"`
- Physical location with file URI, start line, and start column

### 8.6 Scoring

The audit score is calculated as:

```
score = max(0, 100 - total_penalty)
total_penalty = sum(severity_weights[finding.rule.severity] for finding in findings)
```

A score of 100 indicates a clean scan. A skill with a single critical finding scores 75 maximum.

---

## 9. Marketplace Integration Specification

### 9.1 Adapter Pattern

The marketplace uses the Strategy/Adapter pattern with a unified interface:

```typescript
interface MarketplaceAdapter {
  name: string;
  search(query: string, limit?: number): Promise<MarketplaceResult[]>;
  getSkill(scopedName: string): Promise<MarketplaceResult | null>;
}

interface MarketplaceResult {
  name: string;
  scopedName: string;        // @author/name format
  description: string;
  author: string;
  stars: number;
  githubUrl: string;
  repoFullName: string;
  path: string;
  source: string;            // Marketplace name that provided this result
}
```

The `MarketplaceClient` class MUST:
- Accept an optional array of adapters (default: both built-in adapters)
- Query all adapters in parallel during search
- Catch and swallow errors from individual adapters (graceful degradation)
- Deduplicate results by `scopedName`, keeping the entry with the higher `stars` count
- Sort final results by stars descending
- Apply the `limit` parameter after deduplication and sorting

### 9.2 agentskills.in API

**Adapter**: `SkillsMPAdapter`
**Base URL**: `https://www.agentskills.in/api/skills`

**Search endpoint**: `GET /api/skills?search=<query>&limit=<n>&sortBy=stars`

Response schema:
```typescript
interface ApiResponse {
  skills: ApiSkill[];
  total: number;
  limit: number;
  offset: number;
}

interface ApiSkill {
  id: string;
  name: string;
  description: string;
  author: string;
  scopedName: string;
  stars: number;
  forks: number;
  githubUrl: string;
  repoFullName: string;
  path: string;
  category?: string;
  hasContent: boolean;
}
```

**Get skill**: Searches with `search=<scopedName>&limit=1` and matches by `scopedName` or `@author/name`.

### 9.3 skills.sh API

**Adapter**: `SkillsShAdapter`
**Base URL**: `https://skills.sh/api`

**Search endpoint**: `GET /api/search?q=<query>&limit=<n>`

Response schema:
```typescript
interface SkillsShResponse {
  results: SkillsShResult[];
  total: number;
}

interface SkillsShResult {
  name: string;
  author: string;
  description: string;
  repo: string;
  stars?: number;
  url: string;
}
```

The `scopedName` is constructed as `@${author}/${name}`. Missing `stars` default to `0`.

**Get skill**: Performs a search with `q=<scopedName>&limit=5` and filters by exact `scopedName` match.

### 9.4 Search and Discovery Flow

1. User provides a search query
2. `MarketplaceClient.search(query, limit)` queries all adapters in parallel
3. Results are collected, flattened, deduplicated by `scopedName`
4. Sorted by stars descending, truncated to `limit`
5. Each result includes `githubUrl` for actual installation source

### 9.5 Deduplication

When the same skill appears in multiple marketplaces:
- Key: `scopedName`
- Keep: entry with highest `stars` count
- This ensures the most popular/authoritative entry is shown

---

## 10. Instruction File Specification

### 10.1 Injection Markers

CAAMP uses HTML comments as delimiters for injected content:

```
<!-- CAAMP:START -->
... managed content ...
<!-- CAAMP:END -->
```

The marker pattern for detection is: `/<!-- CAAMP:START -->[\s\S]*?<!-- CAAMP:END -->/`

### 10.2 Injection Operations

**inject(filePath, content)**:

| Scenario | Behavior | Return |
|----------|----------|--------|
| File does not exist | Create file with block + newline | `"created"` |
| File exists, no markers | Prepend block + `\n\n` + existing content | `"added"` |
| File exists, has markers | Replace existing block | `"updated"` |

**checkInjection(filePath, expectedContent?)**:

| Scenario | Return |
|----------|--------|
| File does not exist | `"missing"` |
| File exists, no markers | `"none"` |
| File exists, markers present, no expectedContent provided | `"current"` |
| File exists, markers present, content matches expected | `"current"` |
| File exists, markers present, content differs from expected | `"outdated"` |

**removeInjection(filePath)**:

1. Read file content
2. Remove the marker block via regex
3. Clean up leading double newlines
4. If file would be empty after removal, delete the file entirely
5. Otherwise, write cleaned content with trailing newline
6. Return `true` if a block was removed, `false` otherwise

```typescript
type InjectionStatus = "current" | "outdated" | "missing" | "none";
```

### 10.3 File Mapping Rules

Instruction injection targets the correct file for each provider based on `provider.instructFile`:

- Project scope: `join(projectDir, provider.instructFile)` (e.g., `./CLAUDE.md`, `./AGENTS.md`)
- Global scope: `join(provider.pathGlobal, provider.instructFile)` (e.g., `~/.claude/CLAUDE.md`)

When injecting to multiple providers, the implementation MUST deduplicate by file path to avoid writing the same file multiple times (since many providers share `AGENTS.md`).

### 10.4 Template Generation

```typescript
function generateInjectionContent(options?: {
  mcpServerName?: string;
  customContent?: string;
}): string
```

Produces a markdown block:

```markdown
## CAAMP Managed Configuration

This section is managed by [CAAMP](https://github.com/caamp/caamp).
Do not edit between the CAAMP markers manually.

### MCP Server: <name>          <!-- if mcpServerName provided -->
Configured via `caamp mcp install`.

<customContent>                 <!-- if customContent provided -->
```

### 10.5 Multi-Provider Grouping

```typescript
function groupByInstructFile(providers: Provider[]): Map<string, Provider[]>
```

Groups providers by their `instructFile` field. This enables batch operations that write once per instruction file rather than once per provider.

**Check result schema:**

```typescript
interface InjectionCheckResult {
  file: string;
  provider: string;
  status: InjectionStatus;
  fileExists: boolean;
}
```

---

## 11. Lock File Specification

### 11.1 Lock File Location

The lock file MUST be stored at: `$HOME/.agents/.caamp-lock.json`

The parent directory (`$HOME/.agents/`) MUST be created with `recursive: true` if it does not exist.

### 11.2 Lock File Schema

```typescript
interface CaampLockFile {
  version: 1;                                     // Schema version (MUST be 1)
  skills: Record<string, LockEntry>;              // Keyed by skill name
  mcpServers: Record<string, LockEntry>;          // Keyed by server name
  lastSelectedAgents?: string[];                   // Last agent selection for UX
}
```

The file MUST be formatted with 2-space indentation and a trailing newline.

### 11.3 Entry Schema

```typescript
interface LockEntry {
  name: string;              // Entry name
  scopedName: string;        // Scoped name (@author/name or server name)
  source: string;            // Original source string
  sourceType: SourceType;    // Classified source type
  version?: string;          // Version if known
  installedAt: string;       // ISO 8601 timestamp of first install
  updatedAt?: string;        // ISO 8601 timestamp of last update
  agents: string[];          // Provider IDs this is installed for
  canonicalPath: string;     // Path to canonical copy (skills only)
  isGlobal: boolean;         // Whether installed globally
  projectDir?: string;       // Project directory if project-scoped
}
```

### 11.4 Operations

**Read**: If the file does not exist or is unparseable, return default: `{ version: 1, skills: {}, mcpServers: {} }`.

**Write**: Pretty-print JSON with 2-space indent, trailing newline. Create parent directory if needed.

**Record install** (both skills and MCP):
- If entry exists: preserve `installedAt`, merge `agents` array (deduplicated via `Set`)
- If entry is new: set `installedAt` to current ISO timestamp
- Always set `updatedAt` to current ISO timestamp

**Remove**: Delete the key from the appropriate section. Return `false` if not found.

---

## 12. Library API Specification

The library is exported from `@cleocode/caamp` via `src/index.ts`. All exports are named (no default export).

### 12.1 Module Organization

| Module | Import Path | Responsibility |
|--------|------------|----------------|
| Types | `./types.js` | Core type definitions |
| Registry | `./core/registry/providers.js` | Provider data access |
| Detection | `./core/registry/detection.js` | Provider auto-detection |
| Sources | `./core/sources/parser.js` | Source string classification |
| Skills | `./core/skills/*.js` | Skill install, discovery, validation |
| Audit | `./core/skills/audit/scanner.js` | Security scanning |
| MCP Install | `./core/mcp/installer.js` | MCP config writing |
| MCP Transform | `./core/mcp/transforms.js` | Per-agent transforms |
| MCP Read | `./core/mcp/reader.js` | MCP config reading |
| MCP Lock | `./core/mcp/lock.js` | MCP lock file operations |
| Skills Lock | `./core/skills/lock.js` | Skills lock file operations |
| Marketplace | `./core/marketplace/client.js` | Skill search aggregation |
| Instructions | `./core/instructions/injector.js` | Marker-based injection |
| Templates | `./core/instructions/templates.js` | Injection content generation |
| Formats | `./core/formats/index.js` | Config file I/O |
| Format Utils | `./core/formats/utils.js` | Deep merge, nested values |

### 12.2 Registry API (9 exports)

| Export | Signature | Description |
|--------|-----------|-------------|
| `getAllProviders` | `() => Provider[]` | All registered providers with resolved paths |
| `getProvider` | `(idOrAlias: string) => Provider \| undefined` | Lookup by ID or alias |
| `resolveAlias` | `(idOrAlias: string) => string` | Resolve alias to canonical ID |
| `getProvidersByPriority` | `(priority: ProviderPriority) => Provider[]` | Filter by tier |
| `getProvidersByStatus` | `(status: ProviderStatus) => Provider[]` | Filter by status |
| `getProvidersByInstructFile` | `(file: string) => Provider[]` | Filter by instruction file |
| `getInstructionFiles` | `() => string[]` | All unique instruction file names |
| `getProviderCount` | `() => number` | Total provider count |
| `getRegistryVersion` | `() => string` | Registry version string |

### 12.3 Detection API (4 exports)

| Export | Signature | Description |
|--------|-----------|-------------|
| `detectProvider` | `(provider: Provider) => DetectionResult` | Detect single provider |
| `detectAllProviders` | `() => DetectionResult[]` | Detect all providers |
| `getInstalledProviders` | `() => Provider[]` | Only installed providers |
| `detectProjectProviders` | `(projectDir: string) => DetectionResult[]` | With project detection |

### 12.4 Skills API (10 exports)

| Export | Signature | Description |
|--------|-----------|-------------|
| `installSkill` | `(sourcePath, name, providers, isGlobal, projectDir?) => Promise<SkillInstallResult>` | Install to canonical + link |
| `removeSkill` | `(name, providers, isGlobal, projectDir?) => Promise<{removed, errors}>` | Remove skill and links |
| `listCanonicalSkills` | `() => Promise<string[]>` | List canonical skill names |
| `discoverSkills` | `(rootDir: string) => Promise<SkillEntry[]>` | Scan directory for skills |
| `discoverSkill` | `(skillDir: string) => Promise<SkillEntry \| null>` | Discover single skill |
| `parseSkillFile` | `(filePath: string) => Promise<SkillMetadata \| null>` | Parse SKILL.md frontmatter |
| `validateSkill` | `(filePath: string) => Promise<ValidationResult>` | Validate SKILL.md |
| `scanFile` | `(filePath: string, rules?) => Promise<AuditResult>` | Security scan single file |
| `scanDirectory` | `(dirPath: string) => Promise<AuditResult[]>` | Scan directory of skills |
| `toSarif` | `(results: AuditResult[]) => object` | Convert to SARIF format |

### 12.5 MCP API (11 exports)

| Export | Signature | Description |
|--------|-----------|-------------|
| `installMcpServer` | `(provider, name, config, scope?, projectDir?) => Promise<InstallResult>` | Install to one provider |
| `installMcpServerToAll` | `(providers, name, config, scope?, projectDir?) => Promise<InstallResult[]>` | Install to multiple |
| `buildServerConfig` | `(source, transport?, headers?) => McpServerConfig` | Build canonical config |
| `getTransform` | `(providerId: string) => TransformFn \| undefined` | Get per-agent transform |
| `resolveConfigPath` | `(provider, scope, projectDir?) => string \| null` | Resolve config file path |
| `listMcpServers` | `(provider, scope, projectDir?) => Promise<McpServerEntry[]>` | List servers for provider |
| `listAllMcpServers` | `(providers, scope, projectDir?) => Promise<McpServerEntry[]>` | List with dedup |
| `removeMcpServer` | `(provider, name, scope, projectDir?) => Promise<boolean>` | Remove server entry |
| `readLockFile` | `() => Promise<CaampLockFile>` | Read lock file |
| `recordMcpInstall` | `(name, source, sourceType, agents, isGlobal) => Promise<void>` | Record in lock |
| `removeMcpFromLock` | `(name: string) => Promise<boolean>` | Remove from lock |

Additional MCP lock exports (6 total lock functions):

| Export | Signature |
|--------|-----------|
| `getTrackedMcpServers` | `() => Promise<Record<string, LockEntry>>` |
| `saveLastSelectedAgents` | `(agents: string[]) => Promise<void>` |
| `getLastSelectedAgents` | `() => Promise<string[] \| undefined>` |

### 12.6 Instructions API (7 exports)

| Export | Signature | Description |
|--------|-----------|-------------|
| `inject` | `(filePath, content) => Promise<"created" \| "added" \| "updated">` | Inject into file |
| `checkInjection` | `(filePath, expected?) => Promise<InjectionStatus>` | Check injection status |
| `removeInjection` | `(filePath: string) => Promise<boolean>` | Remove injection block |
| `checkAllInjections` | `(providers, projectDir, scope, expected?) => Promise<InjectionCheckResult[]>` | Check all providers |
| `injectAll` | `(providers, projectDir, scope, content) => Promise<Map<string, string>>` | Inject to all |
| `generateInjectionContent` | `(options?) => string` | Generate markdown content |
| `groupByInstructFile` | `(providers: Provider[]) => Map<string, Provider[]>` | Group by file |

### 12.7 Marketplace API (1 export)

| Export | Signature | Description |
|--------|-----------|-------------|
| `MarketplaceClient` | `class` | Unified search client with adapter pattern |

### 12.8 Sources API (2 exports)

| Export | Signature | Description |
|--------|-----------|-------------|
| `parseSource` | `(input: string) => ParsedSource` | Classify source string |
| `isMarketplaceScoped` | `(input: string) => boolean` | Check if @scope/name format |

### 12.9 Formats API (5 exports)

| Export | Signature | Description |
|--------|-----------|-------------|
| `readConfig` | `(filePath, format) => Promise<Record<string, unknown>>` | Read config file |
| `writeConfig` | `(filePath, format, key, name, config) => Promise<void>` | Write config entry |
| `removeConfig` | `(filePath, format, key, name) => Promise<boolean>` | Remove config entry |
| `getNestedValue` | `(obj, keyPath) => unknown` | Get nested value by dot path |
| `deepMerge` | `(target, source) => Record<string, unknown>` | Deep merge objects |

Additional utility export:

| Export | Signature |
|--------|-----------|
| `ensureDir` | `(filePath: string) => Promise<void>` |

### 12.10 Type Exports (18 types)

| Type | Kind | Module |
|------|------|--------|
| `Provider` | interface | types.ts |
| `McpServerConfig` | interface | types.ts |
| `McpServerEntry` | interface | types.ts |
| `ConfigFormat` | type alias | types.ts |
| `TransportType` | type alias | types.ts |
| `SourceType` | type alias | types.ts |
| `ParsedSource` | interface | types.ts |
| `SkillMetadata` | interface | types.ts |
| `SkillEntry` | interface | types.ts |
| `LockEntry` | interface | types.ts |
| `CaampLockFile` | interface | types.ts |
| `MarketplaceSkill` | interface | types.ts |
| `MarketplaceSearchResult` | interface | types.ts |
| `AuditRule` | interface | types.ts |
| `AuditFinding` | interface | types.ts |
| `AuditResult` | interface | types.ts |
| `AuditSeverity` | type alias | types.ts |
| `InjectionStatus` | type alias | types.ts |
| `InjectionCheckResult` | interface | types.ts |
| `GlobalOptions` | interface | types.ts |
| `DetectionResult` | interface | detection.ts |
| `InstallResult` | interface | mcp/installer.ts |
| `SkillInstallResult` | interface | skills/installer.ts |
| `ValidationResult` | interface | skills/validator.ts |
| `ValidationIssue` | interface | skills/validator.ts |

---

## 13. CLI Specification

### 13.1 Command Structure

```
caamp
  providers
    list [--json] [--tier <high|medium|low>]
    detect [--json] [--project]
    show <id> [--json]
  skills
    install <source> [-a <agent>...] [-g] [-n <name>] [-y] [--all] [--dry-run]
    remove <name> [-a <agent>...] [-g] [--all]
    list [-a <agent>] [-g] [--json]
    find <query> [--json]
    check <name> [--json]
    update <name> [--json]
    init [path] [-a <agent>]
    audit [path] [--json] [--sarif]
    validate <path> [--json]
  mcp
    install <source> [-a <agent>...] [-g] [-n <name>] [-t <type>] [--header <h>...] [-y] [--all] [--dry-run]
    remove <name> [-a <agent>...] [-g] [--all]
    list [-a <agent>] [-g] [--json]
    detect [--json]
  instructions
    inject [-a <agent>...] [-g] [--content <text>]
    check [-a <agent>...] [-g] [--json]
    update [-a <agent>...] [-g]
  config
    show <provider> [-g] [--json]
    path <provider> [scope]
```

### 13.2 Global Options

```typescript
interface GlobalOptions {
  agent?: string[];     // Target specific agents (-a, --agent)
  global?: boolean;     // Use global/user scope (-g, --global)
  yes?: boolean;        // Skip confirmation (-y, --yes)
  all?: boolean;        // Target all detected agents (--all)
  json?: boolean;       // Output as JSON (--json)
  dryRun?: boolean;     // Preview without writing (--dry-run)
}
```

The `--agent` option accepts provider IDs or aliases and MAY be repeated. When `--all` is provided, all detected/installed providers are targeted.

### 13.3 providers Commands

**`providers list`**: Lists all registered providers, grouped by priority tier. With `--tier`, filters to a single tier. With `--json`, outputs the full provider array as JSON.

**`providers detect`**: Runs the detection engine on all providers. Outputs installed providers with detection methods. With `--project`, includes project-level detection for the current working directory.

**`providers show <id>`**: Shows detailed information for a single provider. Accepts provider ID or alias. Exits with code 1 if not found.

### 13.4 skills Commands

**`skills install <source>`**: Parses source, fetches skill content, installs to canonical location, symlinks to target agents, records in lock file.

**`skills remove <name>`**: Removes symlinks and canonical copy.

**`skills list`**: Lists discovered skills from agent skills directories.

**`skills find <query>`**: Searches marketplace APIs for skills matching the query.

**`skills check <name>`**: Checks if an installed skill has updates available.

**`skills update <name>`**: Updates a skill to the latest version from its source.

**`skills init [path]`**: Initializes a new SKILL.md with frontmatter template.

**`skills audit [path]`**: Runs security audit against SKILL.md files. Supports `--sarif` for SARIF output.

**`skills validate <path>`**: Validates a SKILL.md file against the standard.

### 13.5 mcp Commands

**`mcp install <source>`**: Parses source, builds canonical config, applies transforms, writes to each target agent's config file, records in lock file. Supports `--transport` (http, sse), `--header` (repeatable), and `--name` override.

**`mcp remove <name>`**: Removes server entry from target agent config files.

**`mcp list`**: Lists configured MCP servers from agent config files, deduplicating by config path.

**`mcp detect`**: Detects MCP servers already configured across all installed providers.

### 13.6 instructions Commands

**`instructions inject`**: Injects CAAMP-managed content block into instruction files.

**`instructions check`**: Checks injection status across all providers' instruction files.

**`instructions update`**: Updates existing injection blocks with current content.

### 13.7 config Commands

**`config show <provider>`**: Reads and displays the provider's config file. With `--global`, reads global config; otherwise reads project config (falling back to global if no project config).

**`config path <provider> [scope]`**: Prints the resolved config file path for the provider. `scope` defaults to `"project"`.

### 13.8 Output Formats

All commands SHOULD support two output modes:

- **Human-readable** (default): Formatted with `picocolors` for terminal display
- **JSON** (`--json` flag): Machine-readable JSON output to stdout

The `--sarif` flag on `skills audit` produces SARIF 2.1.0 output.

### 13.9 Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (provider not found, config error, validation failure) |

---

## 14. Security Considerations

### 14.1 Skill Audit Rules

All skills SHOULD be audited before installation. The 46 built-in rules cover the OWASP-relevant categories documented in Section 8.2. A score below 75 or any `critical`/`high` finding SHOULD trigger a warning to the user.

### 14.2 Lock File Integrity

The lock file records provenance metadata (source, sourceType, installedAt, agents) to enable:
- Tracking which skills/servers are installed and from where
- Identifying stale or orphaned entries
- Reproducing installations from lock file data

The lock file SHOULD NOT contain secrets or sensitive data. Lock files MAY be committed to version control for team sharing.

### 14.3 Config File Permissions

Implementations SHOULD NOT modify file permissions on config files. Implementations MUST create parent directories as needed using `recursive: true` but SHOULD preserve existing directory permissions.

### 14.4 Source Verification

Implementations SHOULD verify skill sources before installation:
- GitHub/GitLab sources: verify repository existence
- npm packages: verify package exists in the registry
- Local paths: verify path exists and contains SKILL.md
- Remote URLs: verify URL is reachable

Implementations MUST NOT execute arbitrary code from skill files during installation. Skills are markdown content only; any code patterns found during audit are warnings about the skill's instructions, not executable code.

### 14.5 Marketplace Trust

Both marketplace adapters communicate over HTTPS. Individual adapter failures are caught and swallowed. The marketplace is a discovery mechanism only; actual skill content is always fetched from the source repository (typically GitHub).

---

## 15. Conformance

### 15.1 Implementation Requirements

A conforming CAAMP implementation:

1. MUST load providers from `providers/registry.json` with runtime path resolution
2. MUST support all four config formats (JSON, JSONC, YAML, TOML)
3. MUST preserve comments when writing JSONC files
4. MUST apply per-agent transforms for Goose, Zed, OpenCode, Codex, and Cursor
5. MUST implement the canonical+symlink skills installation model
6. MUST write lock file entries with `installedAt`, `updatedAt`, and `agents` tracking
7. SHOULD support all 46 audit rules for skill security scanning
8. SHOULD support both marketplace adapters for skill discovery
9. MAY support additional marketplace adapters via the adapter interface
10. MUST NOT generate instruction files other than CLAUDE.md, AGENTS.md, and GEMINI.md

### 15.2 Provider Registry Conformance

A valid provider registry entry:

1. MUST include all required fields per Section 3.2
2. MUST use a unique `id` in kebab-case
3. MUST specify at least one detection method
4. MUST specify a valid `configFormat` from the supported set
5. MUST specify a valid `configKey` consistent with the provider's actual config schema
6. MUST specify a valid `instructFile` from the set {`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`}

### 15.3 Interoperability

CAAMP is designed for interoperability with the broader AI agent ecosystem:

- Config files written by CAAMP MUST be readable by the target agent
- Skills installed by CAAMP MUST be discoverable by the target agent via its skills directory
- Instruction files modified by CAAMP MUST preserve content outside the CAAMP markers
- Lock files use standard JSON format readable by any JSON parser

### 15.4 Package Distribution

The published package (`@cleocode/caamp`) MUST include:

- `dist/` directory with compiled ESM JavaScript and TypeScript declarations
- `providers/` directory with `registry.json`
- ESM-only (no CommonJS)
- `"type": "module"` in `package.json`
- `"engines": { "node": ">=18" }`

---

## Appendix A: Complete Provider Table (v1.0.0)

| ID | Tool Name | Vendor | Config Key | Format | Instruction File | Priority | Status |
|----|-----------|--------|------------|--------|------------------|----------|--------|
| claude-code | Claude Code | Anthropic | mcpServers | json | CLAUDE.md | high | active |
| cursor | Cursor | Anysphere | mcpServers | json | AGENTS.md | high | active |
| windsurf | Windsurf | Codeium | mcpServers | json | AGENTS.md | high | active |
| codex | Codex CLI | OpenAI | mcp_servers | toml | AGENTS.md | medium | active |
| gemini-cli | Gemini CLI | Google | mcpServers | json | GEMINI.md | medium | active |
| github-copilot | GitHub Copilot | GitHub | mcpServers | json | AGENTS.md | medium | active |
| opencode | OpenCode | OpenCode | mcp | json | AGENTS.md | medium | active |
| cline | Cline | Cline | mcpServers | json | AGENTS.md | medium | active |
| kimi | Kimi Coding | Moonshot AI | mcpServers | json | AGENTS.md | medium | active |
| vscode | VS Code | Microsoft | servers | json | AGENTS.md | medium | active |
| zed | Zed | Zed Industries | context_servers | jsonc | AGENTS.md | medium | active |
| claude-desktop | Claude Desktop | Anthropic | mcpServers | json | CLAUDE.md | medium | active |
| roo | Roo Code | Roo Code | mcpServers | json | AGENTS.md | low | active |
| continue | Continue | Continue | mcpServers | json | AGENTS.md | low | active |
| goose | Goose | Block | extensions | yaml | AGENTS.md | low | active |
| antigravity | Antigravity | Antigravity | mcpServers | json | AGENTS.md | low | active |
| kiro-cli | Kiro | Amazon | mcpServers | json | AGENTS.md | low | active |
| amp | Amp | Sourcegraph | mcpServers | json | AGENTS.md | low | active |
| trae | Trae | ByteDance | mcpServers | json | AGENTS.md | low | active |
| aide | Aide | Aide | mcpServers | json | AGENTS.md | low | beta |
| pear-ai | Pear AI | Pear AI | mcpServers | json | AGENTS.md | low | beta |
| void-ai | Void AI | Void | mcpServers | json | AGENTS.md | low | beta |
| cody | Sourcegraph Cody | Sourcegraph | mcpServers | json | AGENTS.md | low | active |
| kilo-code | Kilo Code | Kilo Code | mcpServers | json | AGENTS.md | low | active |
| qwen-code | Qwen Code | Alibaba | mcpServers | json | AGENTS.md | low | beta |
| openhands | OpenHands | All Hands AI | mcpServers | json | AGENTS.md | low | active |
| codebuddy | CodeBuddy | CodeBuddy | mcpServers | json | AGENTS.md | low | beta |
| codestory | CodeStory | CodeStory | mcpServers | json | AGENTS.md | low | beta |

---

## Appendix B: Audit Rule Reference

| ID | Name | Severity | Category |
|----|------|----------|----------|
| PI001 | System prompt override | critical | prompt-injection |
| PI002 | Role manipulation | critical | prompt-injection |
| PI003 | Jailbreak attempt | critical | prompt-injection |
| PI004 | Instruction override | high | prompt-injection |
| PI005 | Hidden instructions | high | prompt-injection |
| PI006 | Encoding bypass | medium | prompt-injection |
| PI007 | Context manipulation | high | prompt-injection |
| PI008 | Token smuggling | medium | prompt-injection |
| CI001 | Destructive command | critical | command-injection |
| CI002 | Remote code execution | critical | command-injection |
| CI003 | Eval usage | high | command-injection |
| CI004 | Shell spawn | high | command-injection |
| CI005 | Sudo escalation | critical | command-injection |
| CI006 | Environment manipulation | high | command-injection |
| CI007 | Cron/scheduled task | high | command-injection |
| CI008 | Network listener | high | command-injection |
| DE001 | Credential access | critical | data-exfiltration |
| DE002 | API key extraction | critical | data-exfiltration |
| DE003 | Data upload | high | data-exfiltration |
| DE004 | Browser data theft | critical | data-exfiltration |
| DE005 | Git credential theft | high | data-exfiltration |
| DE006 | Keychain access | critical | data-exfiltration |
| PE001 | Chmod dangerous | high | privilege-escalation |
| PE002 | SUID/SGID | critical | privilege-escalation |
| PE003 | Docker escape | critical | privilege-escalation |
| PE004 | Kernel module | critical | privilege-escalation |
| FS001 | System directory write | critical | filesystem |
| FS002 | Hidden file creation | medium | filesystem |
| FS003 | Symlink attack | high | filesystem |
| FS004 | Mass file operation | medium | filesystem |
| NA001 | DNS exfiltration | high | network |
| NA002 | Reverse shell | critical | network |
| NA003 | Port scanning | medium | network |
| NA004 | Proxy/tunnel | high | network |
| OB001 | Hex encoding | medium | obfuscation |
| OB002 | String concatenation | medium | obfuscation |
| OB003 | Unicode escape | medium | obfuscation |
| SC001 | Package install | medium | supply-chain |
| SC002 | Typosquatting patterns | low | supply-chain |
| SC003 | Postinstall script | medium | supply-chain |
| SC004 | Registry override | high | supply-chain |
| ID001 | Process listing | low | info-disclosure |
| ID002 | System information | low | info-disclosure |
| ID003 | Network enumeration | low | info-disclosure |

---

## Appendix C: Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `commander` | ^13.0.0 | CLI command framework |
| `@clack/prompts` | ^0.10.0 | Interactive prompts |
| `picocolors` | ^1.1.0 | Terminal color output |
| `gray-matter` | ^4.0.3 | YAML frontmatter parsing |
| `simple-git` | ^3.27.0 | Git operations |
| `jsonc-parser` | ^3.3.1 | Comment-preserving JSON/JSONC editing |
| `js-yaml` | ^4.1.0 | YAML parsing and dumping |
| `@iarna/toml` | ^2.2.5 | TOML parsing and stringifying |

---

*End of CAAMP Technical Specification v1.0.0*
