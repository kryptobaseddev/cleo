# CLEO-CAAMP Integration Interface

> Migration specification for CLEO's V2 TypeScript conversion using @cleocode/caamp

## Overview

CAAMP (Common Agent/AI Management Protocol) provides CLEO with a TypeScript foundation for provider management, MCP configuration, skills lifecycle, and instruction injection. As CLEO transitions from a pure Bash architecture to a V2 TypeScript core, CAAMP replaces the lower-level plumbing (registry lookups, config file I/O, skill installation, MCP server management) while CLEO retains its higher-level orchestration, dispatch, token injection, and protocol systems.

**Why migrate**: Bash functions for JSON manipulation, multi-format config I/O, and HTTP API calls are fragile and hard to test. CAAMP provides typed, tested equivalents with proper error handling, format-aware serialization (JSON, JSONC, YAML, TOML), and a unified lock file for installation tracking.

**Boundary principle**: CAAMP handles "what agents exist, how to configure them, how to install things to them." CLEO handles "what work to do, how to dispatch it, how to inject protocols into subagent prompts."

## Current State

- **Package**: @cleocode/caamp@^0.3.0
- **GitHub**: https://github.com/kryptobaseddev/caamp
- **npm**: https://www.npmjs.com/package/@cleocode/caamp
- **Integration status**: Not yet started (0/102 functions migrated)
- **CAAMP exported symbols**: 88 (22+ types + 61 functions + 1 class + 3 class methods)
- **CLEO functions cataloged**: 150 total (102 CAAMP-replaceable + 48 CLEO-only)
- **Node engine**: >=20 (required by CAAMP v0.3.0)

---

## Complete Import Surface

All symbols CLEO will import from `@cleocode/caamp`:

```typescript
import {
  // --- Types ---
  type ConfigFormat,           // "json" | "jsonc" | "yaml" | "toml"
  type TransportType,          // "stdio" | "sse" | "http"
  type SourceType,             // "remote" | "package" | "command" | "github" | "gitlab" | "local"
  type Provider,               // Full provider definition interface
  type McpServerConfig,        // Canonical MCP server configuration
  type McpServerEntry,         // MCP server list entry
  type ParsedSource,           // Source classification result
  type SkillMetadata,          // SKILL.md frontmatter metadata
  type SkillEntry,             // Discovered skill with path + metadata
  type LockEntry,              // Lock file installation entry
  type CaampLockFile,          // Top-level lock file structure
  type MarketplaceSkill,       // Marketplace skill listing
  type MarketplaceSearchResult, // Paginated marketplace response
  type AuditSeverity,          // "critical" | "high" | "medium" | "low" | "info"
  type AuditRule,              // Security scanning rule
  type AuditFinding,           // Single security finding
  type AuditResult,            // Aggregated audit result
  type InjectionStatus,        // "current" | "outdated" | "missing" | "none"
  type InjectionCheckResult,   // Injection check result per file
  type GlobalOptions,          // CLI-level global options
  type DetectionResult,        // Provider detection result
  type SkillInstallResult,     // Skill installation result
  type InstallResult,          // MCP install result
  type ValidationIssue,        // Skill validation issue
  type ValidationResult,       // Skill validation result

  // --- Provider Registry ---
  getAllProviders,              // () => Provider[]
  getProvider,                 // (idOrAlias: string) => Provider | undefined
  resolveAlias,                // (idOrAlias: string) => string
  getProvidersByPriority,      // (priority: ProviderPriority) => Provider[]
  getProvidersByStatus,        // (status: ProviderStatus) => Provider[]
  getProvidersByInstructFile,  // (file: string) => Provider[]
  getInstructionFiles,         // () => string[]
  getProviderCount,            // () => number
  getRegistryVersion,          // () => string

  // --- Provider Detection ---
  detectProvider,              // (provider: Provider) => DetectionResult
  detectAllProviders,          // () => DetectionResult[]
  getInstalledProviders,       // () => Provider[]
  detectProjectProviders,      // (projectDir: string) => DetectionResult[]

  // --- Source Parsing ---
  parseSource,                 // (input: string) => ParsedSource
  isMarketplaceScoped,         // (input: string) => boolean

  // --- Skills Installation ---
  installSkill,                // (sourcePath, skillName, providers, isGlobal, projectDir?) => Promise<SkillInstallResult>
  removeSkill,                 // (skillName, providers, isGlobal, projectDir?) => Promise<{ removed, errors }>
  listCanonicalSkills,         // () => Promise<string[]>

  // --- Skills Discovery ---
  parseSkillFile,              // (filePath: string) => Promise<SkillMetadata | null>
  discoverSkill,               // (skillDir: string) => Promise<SkillEntry | null>
  discoverSkills,              // (rootDir: string) => Promise<SkillEntry[]>

  // --- Skills Validation ---
  validateSkill,               // (filePath: string) => Promise<ValidationResult>

  // --- Skills Audit ---
  scanFile,                    // (filePath, rules?) => Promise<AuditResult>
  scanDirectory,               // (dirPath: string) => Promise<AuditResult[]>
  toSarif,                     // (results: AuditResult[]) => object

  // --- Skills Lock ---
  recordSkillInstall,          // (skillName, scopedName, source, sourceType, agents, canonicalPath, isGlobal, projectDir?, version?) => Promise<void>
  removeSkillFromLock,         // (skillName: string) => Promise<boolean>
  getTrackedSkills,            // () => Promise<Record<string, LockEntry>>
  checkSkillUpdate,            // (skillName: string) => Promise<{ hasUpdate, currentVersion?, latestVersion? }>

  // --- MCP Installation ---
  installMcpServer,            // (provider, serverName, config, scope?, projectDir?) => Promise<InstallResult>
  installMcpServerToAll,       // (providers, serverName, config, scope?, projectDir?) => Promise<InstallResult[]>
  buildServerConfig,           // (source, transport?, headers?) => McpServerConfig

  // --- MCP Transforms ---
  getTransform,                // (providerId: string) => ((name, config) => unknown) | undefined

  // --- MCP Reader ---
  resolveConfigPath,           // (provider, scope, projectDir?) => string | null
  listMcpServers,              // (provider, scope, projectDir?) => Promise<McpServerEntry[]>
  listAllMcpServers,           // (providers, scope, projectDir?) => Promise<McpServerEntry[]>
  removeMcpServer,             // (provider, serverName, scope, projectDir?) => Promise<boolean>

  // --- MCP Lock ---
  readLockFile,                // () => Promise<CaampLockFile>
  recordMcpInstall,            // (serverName, source, sourceType, agents, isGlobal) => Promise<void>
  removeMcpFromLock,           // (serverName: string) => Promise<boolean>
  getTrackedMcpServers,        // () => Promise<Record<string, LockEntry>>
  saveLastSelectedAgents,      // (agents: string[]) => Promise<void>
  getLastSelectedAgents,       // () => Promise<string[] | undefined>

  // --- Config Format I/O ---
  readConfig,                  // (filePath, format) => Promise<Record<string, unknown>>
  writeConfig,                 // (filePath, format, key, serverName, serverConfig) => Promise<void>
  removeConfig,                // (filePath, format, key, serverName) => Promise<boolean>
  getNestedValue,              // (obj, keyPath) => unknown
  deepMerge,                   // (target, source) => Record<string, unknown>
  ensureDir,                   // (filePath: string) => Promise<void>

  // --- Instructions / Injection ---
  inject,                      // (filePath, content) => Promise<"created" | "added" | "updated">
  checkInjection,              // (filePath, expectedContent?) => Promise<InjectionStatus>
  removeInjection,             // (filePath: string) => Promise<boolean>
  checkAllInjections,          // (providers, projectDir, scope, expectedContent?) => Promise<InjectionCheckResult[]>
  injectAll,                   // (providers, projectDir, scope, content) => Promise<Map<string, action>>
  generateInjectionContent,    // (options?) => string
  groupByInstructFile,         // (providers: Provider[]) => Map<string, Provider[]>

  // --- Marketplace ---
  MarketplaceClient,           // Class: search(query, limit?) and getSkill(scopedName)
} from "@cleocode/caamp";
```

---

## Migration by Domain

### 1. Provider Registry

**Bash source**: `lib/agent-registry.sh` (27 functions)

#### Current Bash Functions

| Bash Function | CAAMP Replacement | Signature | Status |
|---------------|-------------------|-----------|--------|
| `ar_load_registry` | `getAllProviders` | `() => Provider[]` | pending |
| `_ar_ensure_loaded` | Internal (CAAMP loads eagerly) | N/A | pending |
| `ar_list_agents` | `getAllProviders` | `() => Provider[]` (map to IDs) | pending |
| `ar_list_by_tier` | `getProvidersByPriority` | `(priority: ProviderPriority) => Provider[]` | pending |
| `ar_list_by_instruction_file` | `getProvidersByInstructFile` | `(file: string) => Provider[]` | pending |
| `ar_get_agent` | `getProvider` | `(idOrAlias: string) => Provider \| undefined` | pending |
| `ar_get_field` | `getProvider` + property access | `(idOrAlias: string) => Provider \| undefined` | pending |
| `ar_agent_exists` | `getProvider` + truthiness check | `(idOrAlias: string) => Provider \| undefined` | pending |
| `ar_get_global_dir` | `getProvider(id).pathGlobal` | Property access on `Provider` | pending |
| `ar_get_project_dir` | `getProvider(id).pathProject` | Property access on `Provider` | pending |
| `ar_get_instruction_file` | `getProvider(id).instructFile` | Property access on `Provider` | pending |
| `ar_get_global_instruction_path` | `getProvider(id).pathGlobal + instructFile` | Computed from `Provider` fields | pending |
| `ar_get_project_instruction_path` | `getProvider(id).pathProject + instructFile` | Computed from `Provider` fields | pending |
| `ar_get_global_skills_dir` | `getProvider(id).pathSkills` | Property access on `Provider` | pending |
| `ar_get_project_skills_dir` | `getProvider(id).pathProjectSkills` | Property access on `Provider` | pending |
| `ar_is_installed` | `detectProvider` | `(provider: Provider) => DetectionResult` | pending |
| `ar_list_installed` | `getInstalledProviders` | `() => Provider[]` | pending |
| `ar_list_installed_by_tier` | `getInstalledProviders` + filter | `() => Provider[]` then filter by `priority` | pending |
| `ar_get_display_name` | `getProvider(id).toolName` | Property access on `Provider` | pending |
| `ar_get_vendor` | `getProvider(id).vendor` | Property access on `Provider` | pending |
| `ar_get_priority` | `getProvider(id).priority` | Property access on `Provider` | pending |
| `ar_get_status` | `getProvider(id).status` | Property access on `Provider` | pending |
| `ar_is_agent_skills_compatible` | `getProvider(id).agentSkillsCompatible` | Property access on `Provider` | pending |
| `ar_get_instruction_files` | `getInstructionFiles` | `() => string[]` | pending |
| `ar_get_registry_json` | `getAllProviders` (serialize) | `() => Provider[]` | pending |
| `ar_get_agent_summary` | `getProvider` + select fields | `(idOrAlias: string) => Provider \| undefined` | pending |
| `ar_list_agents_json` | `getAllProviders` | `() => Provider[]` | pending |

#### Migration Notes

- CAAMP consolidates the bash "get specific field" pattern (`ar_get_field`, `ar_get_vendor`, etc.) into a single `getProvider()` call that returns a typed `Provider` object. Callers access fields directly via property access.
- `ar_is_installed` maps to `detectProvider()` which returns richer information (detection methods, project detection) than the bash boolean check.
- `_ar_ensure_loaded` is eliminated because CAAMP's registry module loads from `providers/registry.json` synchronously on import.
- Path expansion (`$HOME`) is handled internally by CAAMP; `pathGlobal`, `pathSkills`, and `configPathGlobal` are already resolved.

---

### 2. Provider Configuration

**Bash source**: `lib/agent-config.sh` (27 functions)

#### Current Bash Functions

| Bash Function | CAAMP Replacement | Signature | Status |
|---------------|-------------------|-----------|--------|
| `load_agent_registry` | `getAllProviders` | `() => Provider[]` | pending |
| `normalize_agent_id` | `resolveAlias` | `(idOrAlias: string) => string` | pending |
| `get_agent_dir` | `getProvider(id).pathGlobal` | Property access on `Provider` | pending |
| `get_agent_config_file` | `getProvider(id).instructFile` | Property access on `Provider` | pending |
| `get_all_agents` | `getAllProviders` | `() => Provider[]` (map to IDs) | pending |
| `get_agents_by_tier` | `getProvidersByPriority` | `(priority: ProviderPriority) => Provider[]` | pending |
| `get_agent_skills_dir` | `getProvider(id).pathProjectSkills` | Property access on `Provider` | pending |
| `get_agent_project_skills_dir` | `getProvider(id).pathProjectSkills` | Property access on `Provider` | pending |
| `get_agent_global_skills_dir` | `getProvider(id).pathSkills` | Property access on `Provider` | pending |
| `get_skill_install_path` | Computed from `Provider.pathSkills` | `provider.pathSkills + "/" + skillName` | pending |
| `install_skill_to_agent` | `installSkill` | `(sourcePath, skillName, providers, isGlobal, projectDir?) => Promise<SkillInstallResult>` | pending |
| `list_agent_skills` | `listCanonicalSkills` + per-provider check | `() => Promise<string[]>` | pending |
| `is_skill_installed` | `listCanonicalSkills` + includes check | `() => Promise<string[]>` then filter | pending |
| `uninstall_skill_from_agent` | `removeSkill` | `(skillName, providers, isGlobal, projectDir?) => Promise<{ removed, errors }>` | pending |
| `get_agent_config_json` | `getProvider` | `(idOrAlias: string) => Provider \| undefined` | pending |
| `get_agent_display_name` | `getProvider(id).toolName` | Property access on `Provider` | pending |
| `update_agent_config_registry` | No direct equivalent (CAAMP registry is read-only from JSON) | N/A -- see notes | pending |
| `get_agent_config_version` | `getRegistryVersion` | `() => string` | pending |
| `validate_agent_config_registry` | Implicit (CAAMP validates on load) | N/A | pending |
| `is_agent_registered` | `getProvider` + truthiness check | `(idOrAlias: string) => Provider \| undefined` | pending |
| `get_agent_config_data` | `getProvider` | `(idOrAlias: string) => Provider \| undefined` | pending |
| `list_agent_configs` | `getAllProviders` | `() => Provider[]` | pending |
| `get_agent_name_from_path` | No direct equivalent -- custom logic needed | N/A -- see notes | pending |
| `is_agent_cli_installed` | `detectProvider` | `(provider: Provider) => DetectionResult` | pending |
| `get_agent_config_path` | `resolveConfigPath` | `(provider, scope, projectDir?) => string \| null` | pending |
| `create_empty_agent_registry` | No direct equivalent (CAAMP ships with registry.json) | N/A -- see notes | pending |
| `init_agent_config_registry` | No direct equivalent (CAAMP ships with registry.json) | N/A -- see notes | pending |

#### Migration Notes

- **Significant overlap with agent-registry.sh**: CAAMP unifies both files into a single Provider registry model. Many functions in both files map to the same CAAMP call (`getProvider`, `getAllProviders`).
- `normalize_agent_id` maps to `resolveAlias()` which handles legacy aliases like "claude" -> "claude-code".
- `update_agent_config_registry`, `create_empty_agent_registry`, and `init_agent_config_registry` have no CAAMP equivalent because CAAMP's registry is defined in `providers/registry.json` and is immutable at runtime. CLEO V2 will not need runtime registry mutation -- new providers are added by updating the CAAMP package.
- `get_agent_name_from_path` requires reverse-lookup from a file path to a provider ID. CLEO V2 should implement this as a utility that iterates `getAllProviders()` and matches paths.

---

### 3. MCP Configuration

**Bash source**: `lib/mcp-config.sh` (28 functions)

#### Current Bash Functions

| Bash Function | CAAMP Replacement | Signature | Status |
|---------------|-------------------|-----------|--------|
| `_mcp_display_name` | `getProvider(id).toolName` | Property access on `Provider` | pending |
| `_mcp_format` | `getProvider(id).configFormat` | Property access on `Provider` | pending |
| `_mcp_config_key` | `getProvider(id).configKey` | Property access on `Provider` | pending |
| `_mcp_binary` | `getProvider(id).detection.binary` | Property access via `Provider.detection` | pending |
| `_mcp_config_dir` | `getProvider(id).detection.directories` | Property access via `Provider.detection` | pending |
| `_mcp_app_bundle` | `getProvider(id).detection.appBundle` | Property access via `Provider.detection` | pending |
| `_mcp_flatpak_id` | `getProvider(id).detection.flatpak` | Property access via `Provider.detection` | pending |
| `_mcp_get_config_path` | `resolveConfigPath` | `(provider, scope, projectDir?) => string \| null` | pending |
| `_mcp_has_dual_scope` | `provider.configPathProject !== null` | Check if `configPathProject` is non-null | pending |
| `mcp_detect_tool` | `detectProvider` | `(provider: Provider) => DetectionResult` | pending |
| `mcp_detect_all_tools` | `detectAllProviders` | `() => DetectionResult[]` | pending |
| `mcp_generate_entry` | `buildServerConfig` | `(source, transport?, headers?) => McpServerConfig` | pending |
| `_mcp_merge_standard` | `installMcpServer` (handles format internally) | `(provider, serverName, config, scope?, projectDir?) => Promise<InstallResult>` | pending |
| `_mcp_merge_opencode` | `installMcpServer` (handles format internally) | Same as above | pending |
| `_mcp_merge_vscode` | `installMcpServer` (handles format internally) | Same as above | pending |
| `_mcp_merge_zed` | `installMcpServer` (handles format internally) | Same as above | pending |
| `_mcp_generate_codex_toml_block` | `getTransform("codex")` | `(providerId: string) => ((name, config) => unknown) \| undefined` | pending |
| `_mcp_merge_codex_toml` | `installMcpServer` (handles format internally) | Same as above | pending |
| `_mcp_generate_goose_yaml_block` | `getTransform("goose")` | `(providerId: string) => ((name, config) => unknown) \| undefined` | pending |
| `_mcp_merge_goose_yaml` | `installMcpServer` (handles format internally) | Same as above | pending |
| `mcp_backup_external_file` | Handled internally by CAAMP's write operations | N/A | pending |
| `mcp_write_config` | `installMcpServer` | `(provider, serverName, config, scope?, projectDir?) => Promise<InstallResult>` | pending |
| `mcp_get_tool_keys` | `getAllProviders().map(p => p.id)` | Derived from `getAllProviders()` | pending |
| `mcp_get_tool_display_name` | `getProvider(id).toolName` | Property access on `Provider` | pending |
| `mcp_get_tool_format` | `getProvider(id).configFormat` | Property access on `Provider` | pending |
| `mcp_get_tool_config_key` | `getProvider(id).configKey` | Property access on `Provider` | pending |
| `mcp_get_config_path` | `resolveConfigPath` | `(provider, scope, projectDir?) => string \| null` | pending |
| `mcp_has_dual_scope` | `provider.configPathProject !== null` | Check if `configPathProject` is non-null | pending |

#### Migration Notes

- The 6 format-specific merge functions (`_mcp_merge_standard`, `_mcp_merge_opencode`, `_mcp_merge_vscode`, `_mcp_merge_zed`, `_mcp_merge_codex_toml`, `_mcp_merge_goose_yaml`) are all absorbed by `installMcpServer()`, which determines the format from `provider.configFormat` and applies the correct transform via `getTransform()`.
- Property accessor functions (`_mcp_display_name`, `_mcp_format`, `_mcp_config_key`, etc.) collapse into direct property access on the `Provider` object.
- CAAMP handles JSONC parsing (comment stripping) internally via its `readConfig()` format support.
- Backup before write is handled internally by CAAMP's file operations. If explicit backup is needed, CLEO can use `readConfig()` to snapshot before `writeConfig()`.
- The `MCP_TOOL_KEYS` bash array maps to `getAllProviders().map(p => p.id)`.

---

### 4. Skills Installation

**Bash source**: `lib/skills-install.sh` (7 functions)

#### Current Bash Functions

| Bash Function | CAAMP Replacement | Signature | Status |
|---------------|-------------------|-----------|--------|
| `_init_skills_paths` | Internal to CAAMP (paths from Provider) | N/A | pending |
| `get_skills_from_manifest` | `discoverSkills` | `(rootDir: string) => Promise<SkillEntry[]>` | pending |
| `get_skill_path` | `discoverSkill` | `(skillDir: string) => Promise<SkillEntry \| null>` | pending |
| `install_skill` | `installSkill` | `(sourcePath, skillName, providers, isGlobal, projectDir?) => Promise<SkillInstallResult>` | pending |
| `install_skills` | `installSkill` in a loop or batch | Same, called per skill | pending |
| `uninstall_skills` | `removeSkill` | `(skillName, providers, isGlobal, projectDir?) => Promise<{ removed, errors }>` | pending |
| `list_installed_skills` | `listCanonicalSkills` | `() => Promise<string[]>` | pending |

#### Migration Notes

- CLEO's `skills/manifest.json` serves as the skill registry. CAAMP's `discoverSkills()` scans directories for `SKILL.md` files and returns `SkillEntry[]`, replacing the manifest-based lookup.
- CAAMP introduces canonical storage at `~/.agents/skills/<name>/` with symlinks to provider skill directories, replacing CLEO's direct-to-provider copy approach.
- `_init_skills_paths` is eliminated because CAAMP resolves paths from the Provider object.
- `install_skills` (batch) becomes a loop over `installSkill()` since CAAMP does not have a dedicated batch install function.

---

### 5. Skills Discovery

**Bash source**: `lib/skill-discovery.sh` (7 functions)

#### Current Bash Functions

| Bash Function | CAAMP Replacement | Signature | Status |
|---------------|-------------------|-----------|--------|
| `extract_skill_metadata` | `parseSkillFile` | `(filePath: string) => Promise<SkillMetadata \| null>` | pending |
| `parse_skill_header` | `parseSkillFile` | `(filePath: string) => Promise<SkillMetadata \| null>` | pending |
| `discover_skills` | `discoverSkills` | `(rootDir: string) => Promise<SkillEntry[]>` | pending |
| `validate_skill` | `validateSkill` | `(filePath: string) => Promise<ValidationResult>` | pending |
| `register_skill` | `recordSkillInstall` | `(skillName, scopedName, source, ...) => Promise<void>` | pending |
| `sync_manifest` | `discoverSkills` + reconcile | Discovery-based; no direct manifest sync | pending |
| `update_dispatch_matrix` | No CAAMP equivalent | CLEO-specific dispatch concern | pending |

#### Migration Notes

- CAAMP's `parseSkillFile()` handles YAML frontmatter parsing, replacing both `extract_skill_metadata()` and `parse_skill_header()`. The bash implementation supported two header formats (YAML frontmatter and structured header); CAAMP supports YAML frontmatter.
- `sync_manifest` has no direct CAAMP equivalent. In V2, CLEO can use `discoverSkills()` to scan and reconcile against its own manifest, marking missing skills as deprecated.
- `update_dispatch_matrix` stays in CLEO as it is dispatch/orchestration logic. However, the underlying skill data comes from CAAMP's `SkillEntry` and `SkillMetadata` types.

---

### 6. Skills Validation

**Bash source**: `lib/skill-validate.sh` (10 functions)

#### Current Bash Functions

| Bash Function | CAAMP Replacement | Signature | Status |
|---------------|-------------------|-----------|--------|
| `skill_exists` | `discoverSkill` truthiness check | `(skillDir: string) => Promise<SkillEntry \| null>` | pending |
| `skill_is_active` | No direct equivalent (CAAMP has no status concept) | CLEO tracks active/deprecated in manifest | pending |
| `skill_has_required_tokens` | No direct equivalent | CLEO token system is not in CAAMP | pending |
| `skill_is_compatible_with_subagent` | No direct equivalent | CLEO model compatibility check | pending |
| `skill_get_info` | `parseSkillFile` | `(filePath: string) => Promise<SkillMetadata \| null>` | pending |
| `skill_list_all` | `discoverSkills` | `(rootDir: string) => Promise<SkillEntry[]>` | pending |
| `skill_validate_for_spawn` | `validateSkill` + CLEO checks | `(filePath: string) => Promise<ValidationResult>` | pending |
| `skill_get_path` | `discoverSkill(dir).path` | Property access on `SkillEntry` | pending |
| `skill_get_tags` | `parseSkillFile(path).metadata` | Property access on `SkillMetadata` | pending |
| `skill_find_by_tag` | `discoverSkills` + filter by metadata | Iterate and filter `SkillEntry[]` | pending |

#### Migration Notes

- CAAMP's `validateSkill()` checks frontmatter requirements (name, description), name format, XSS patterns, and body content. CLEO's `skill_validate_for_spawn()` adds orchestrator-specific checks (token requirements, model compatibility) on top.
- `skill_is_active` and `skill_has_required_tokens` are CLEO manifest/token concerns that CAAMP does not model. In V2, these remain as thin CLEO wrappers around CAAMP data.
- `skill_find_by_tag` in V2 becomes: `discoverSkills(dir).then(skills => skills.filter(s => s.metadata?.metadata?.tags?.includes(tag)))`.
- `skill_is_compatible_with_subagent` (sonnet skills can run on opus) is CLEO's model hierarchy concern and stays as a CLEO utility.

---

### 7. Skills Versioning

**Bash source**: `lib/skills-version.sh` (8 functions)

#### Current Bash Functions

| Bash Function | CAAMP Replacement | Signature | Status |
|---------------|-------------------|-----------|--------|
| `init_installed_skills` | Lock file auto-created by CAAMP | `readLockFile()` creates default if missing | pending |
| `record_skill_version` | `recordSkillInstall` | `(skillName, scopedName, source, sourceType, agents, canonicalPath, isGlobal, projectDir?, version?) => Promise<void>` | pending |
| `get_installed_version` | `getTrackedSkills` + lookup | `() => Promise<Record<string, LockEntry>>` then access `.version` | pending |
| `check_skill_updates` | `checkSkillUpdate` | `(skillName: string) => Promise<{ hasUpdate, currentVersion?, latestVersion? }>` | pending |
| `apply_skill_updates` | `installSkill` per update | Re-install from source | pending |
| `get_skill_update_count` | `getTrackedSkills` + `checkSkillUpdate` loop | Compose from existing functions | pending |
| `format_skill_updates` | No CAAMP equivalent (display concern) | CLEO formats for CLI output | pending |
| `record_all_manifest_skills` | `recordSkillInstall` in a loop | Called per skill from manifest | pending |

#### Migration Notes

- CAAMP replaces CLEO's `~/.cleo/installed-skills.json` with a unified lock file at `~/.agents/.caamp-lock.json` that tracks both skills and MCP servers.
- `checkSkillUpdate()` currently returns `hasUpdate: false` (network check not implemented). CLEO V2 should plan for this to be populated in a future CAAMP release.
- `format_skill_updates` is a display/presentation concern that stays in CLEO's CLI layer.
- `apply_skill_updates` becomes a re-install workflow: fetch new source, call `installSkill()`.

---

### 8. Skills Marketplace

**Bash source**: `lib/skillsmp.sh` (5 functions)

#### Current Bash Functions

| Bash Function | CAAMP Replacement | Signature | Status |
|---------------|-------------------|-----------|--------|
| `smp_load_config` | `new MarketplaceClient()` | Constructor (adapters default to SkillsMPAdapter + SkillsShAdapter) | pending |
| `smp_search_skills` | `MarketplaceClient.search` | `(query: string, limit?: number) => Promise<MarketplaceSkill[]>` | pending |
| `smp_get_skill_details` | `MarketplaceClient.getSkill` | `(scopedName: string) => Promise<MarketplaceSkill \| null>` | pending |
| `smp_download_skill` | No direct equivalent | CAAMP marketplace returns metadata; download is separate | pending |
| `smp_install_skill` | `MarketplaceClient.getSkill` + `installSkill` | Compose: get details, download, install | pending |

#### Migration Notes

- CAAMP's `MarketplaceClient` aggregates from multiple marketplace sources (SkillsMP at agentskills.in, SkillsSh), deduplicates by scoped name, and sorts by star count. This replaces CLEO's single-source bash `curl`-based client.
- `smp_download_skill` (raw GitHub URL download via curl) has no direct CAAMP equivalent. In V2, CLEO will use `parseSource()` to classify the source, then use Node's `fetch` or filesystem operations to retrieve content before calling `installSkill()`.
- `smp_install_skill` becomes a composed workflow: `MarketplaceClient.getSkill()` -> download -> `installSkill()` -> `recordSkillInstall()`.
- CLEO's bash caching (5min for search, 1hr for content) is not replicated in CAAMP. V2 should implement caching at the CLEO layer if needed.

---

### 9. Instructions / Injection

**Bash sources**: `lib/injection-registry.sh` (8 constants), `lib/injection-config.sh` (6 functions), `lib/injection.sh` (6 functions)

#### Constants (lib/injection-registry.sh)

| Constant | CAAMP Equivalent | Notes | Status |
|----------|-----------------|-------|--------|
| `INJECTION_TARGETS` | `getAllProviders().map(p => p.instructFile)` | Derived from provider registry | pending |
| `INJECTION_MARKER_START` | `"<!-- CAAMP:START -->"` | Note: CAAMP uses `CAAMP:START`, CLEO uses `CLEO:START` | pending |
| `INJECTION_MARKER_END` | `"<!-- CAAMP:END -->"` | Note: CAAMP uses `CAAMP:END`, CLEO uses `CLEO:END` | pending |
| `INJECTION_VERSION_PATTERN` | Not needed (CAAMP checks content equality) | CAAMP compares full block content | pending |
| `INJECTION_TEMPLATE_MAIN` | `generateInjectionContent()` | Generated programmatically | pending |
| `INJECTION_TEMPLATE_DIR` | Not needed (CAAMP generates content) | Templates replaced by code generation | pending |
| `INJECTION_HEADERS` | `groupByInstructFile()` | Groups providers by instruction file | pending |
| `INJECTION_VALIDATION_KEYS` | Not needed (CAAMP returns typed results) | TypeScript types replace validation keys | pending |

#### Functions (lib/injection-config.sh)

| Bash Function | CAAMP Replacement | Signature | Status |
|---------------|-------------------|-----------|--------|
| `injection_is_valid_target` | `getProvider` truthiness check | `(idOrAlias: string) => Provider \| undefined` | pending |
| `injection_get_targets` | `getAllProviders` | `() => Provider[]` | pending |
| `injection_get_header_path` | `groupByInstructFile` | `(providers: Provider[]) => Map<string, Provider[]>` | pending |
| `injection_get_template_path` | `generateInjectionContent` | `(options?) => string` | pending |
| `injection_get_validation_key` | Not needed (TypeScript types) | N/A | pending |
| `injection_has_block` | `checkInjection` | `(filePath, expectedContent?) => Promise<InjectionStatus>` | pending |

#### Functions (lib/injection.sh)

| Bash Function | CAAMP Replacement | Signature | Status |
|---------------|-------------------|-----------|--------|
| `injection_update` | `inject` | `(filePath, content) => Promise<"created" \| "added" \| "updated">` | pending |
| `injection_check` | `checkInjection` | `(filePath, expectedContent?) => Promise<InjectionStatus>` | pending |
| `injection_check_all` | `checkAllInjections` | `(providers, projectDir, scope, expectedContent?) => Promise<InjectionCheckResult[]>` | pending |
| `injection_apply` | `inject` (internal detail) | Same as `inject` | pending |
| `injection_update_all` | `injectAll` | `(providers, projectDir, scope, content) => Promise<Map<string, action>>` | pending |
| `injection_get_summary` | `checkAllInjections` + format | Compose from check results | pending |

#### Migration Notes

- **Marker change**: CAAMP uses `<!-- CAAMP:START -->` / `<!-- CAAMP:END -->` markers instead of CLEO's `<!-- CLEO:START -->` / `<!-- CLEO:END -->`. The migration must either:
  1. Update all existing instruction files to use CAAMP markers, OR
  2. Configure CAAMP to recognize CLEO markers (requires CAAMP enhancement), OR
  3. Have CLEO V2 handle the marker transition during its first `init --update-docs` run
- CLEO's `@`-reference pattern (`@.cleo/templates/AGENT-INJECTION.md`) is a CLEO template mechanism. CAAMP injects literal content via `generateInjectionContent()`. In V2, CLEO will call `generateInjectionContent()` to produce the block content, which may include `@`-references that CLEO's own template system resolves.
- `injection_get_summary` becomes a presentation wrapper around `checkAllInjections()` results.

---

## CLEO-Only Functions (No Migration)

These 48 functions remain in CLEO's bash codebase because they implement orchestration, dispatch, token injection, and protocol systems that are specific to CLEO's 2-tier subagent architecture. CAAMP provides data access; these functions provide behavior.

### lib/skill-dispatch.sh -- 24 functions

The dispatch system selects which skill/protocol to inject into a subagent prompt based on task metadata (labels, type, keywords). This is CLEO's core orchestration logic.

| Function | Description |
|----------|-------------|
| `skill_select_for_task` | Select skill based on task metadata |
| `skill_dispatch_validate` | Validate dispatch configuration |
| `skill_inject` | Inject skill content into prompt |
| `skill_inject_for_task` | Inject skill for specific task |
| `skill_get_dispatch_triggers` | Get dispatch triggers for skill |
| `skill_matches_labels` | Check if skill matches task labels |
| `skill_matches_keywords` | Check if skill matches keywords |
| `skill_matches_type` | Check if skill matches task type |
| `skill_list_with_triggers` | List skills with dispatch triggers |
| `skill_find_by_trigger` | Find skill by trigger keyword |
| `get_skills_by_category` | Get skills grouped by category |
| `skill_dispatch_by_category` | Dispatch by category |
| `skill_get_tier` | Get skill tier level |
| `skill_is_tier` | Check if skill is specific tier |
| `skill_dispatch_by_keywords` | Dispatch using keyword matching |
| `skill_dispatch_by_type` | Dispatch using task type matching |
| `skill_dispatch_by_protocol` | Dispatch using protocol matching |
| `skill_get_metadata` | Get full skill metadata for dispatch |
| `skill_get_references` | Get skill reference files |
| `skill_check_compatibility` | Check skill compatibility |
| `skill_list_by_tier` | List skills filtered by tier |
| `skill_auto_dispatch` | Auto-select skill for task |
| `skill_prepare_spawn` | Prepare full spawn prompt JSON |
| `skill_prepare_spawn_multi` | Prepare multi-task spawn |

**Rationale**: These functions operate on CLEO's task system (task labels, types, RCSD lifecycle) and produce prompt content for CLEO's subagent spawning workflow. They have no counterpart in CAAMP because CAAMP is agent-agnostic and does not model task dispatch.

### lib/token-inject.sh -- 19 functions

The token injection system resolves `{{TOKEN}}` placeholders in subagent prompts with task-specific values before spawning.

| Function | Description |
|----------|-------------|
| `ti_set_defaults` | Set default token values |
| `ti_validate_required` | Validate required tokens are set |
| `ti_inject_tokens` | Replace `{{TOKEN}}` in template |
| `ti_load_template` | Load template file with injection |
| `ti_list_tokens` | List all known tokens |
| `ti_get_default` | Get default value for token |
| `ti_clear_all` | Clear all token values |
| `ti_set_context` | Set context for token resolution |
| `ti_set_task_context` | Set task-specific context |
| `ti_extract_manifest_summaries` | Extract manifest summaries |
| `ti_extract_next_task_ids` | Extract next task IDs |
| `ti_reload_tokens` | Reload tokens from placeholders.json |
| `ti_populate_skill_specific_tokens` | Populate skill-specific tokens |
| `validate_token_value` | Validate individual token value |
| `ti_validate_all_tokens` | Validate all tokens |
| `ti_verify_all_resolved` | Verify no unresolved tokens |
| `ti_inject_and_verify` | Inject and verify all resolved |
| `ti_get_session_id` | Get current session ID |
| `ti_set_full_context` | Set full context for spawning |

**Rationale**: Token injection is a CLEO prompt-construction concern. Tokens reference CLEO-specific concepts (`{{TASK_ID}}`, `{{EPIC_ID}}`, `{{MANIFEST_PATH}}`). CAAMP does not model tasks or prompts.

### lib/subagent-inject.sh -- 8 functions

Protocol injection prepares the full prompt context for a subagent spawn, combining base protocol, conditional protocol, and task context.

| Function | Description |
|----------|-------------|
| `subagent_prepare` | Prepare subagent context |
| `subagent_get_task_context` | Get task context for subagent |
| `subagent_inject_protocol` | Inject RFC 2119 protocol into prompt |
| `orchestrator_spawn_skill` | Full orchestrator skill spawn workflow |
| `orchestrator_spawn_minimal` | Minimal spawn without full protocol |
| `orchestrator_validate_spawn` | Validate spawn prompt completeness |
| `subagent_list_required_tokens` | List required tokens for subagent |
| `subagent_get_protocol_path` | Get protocol base path |

**Rationale**: These functions implement CLEO's 2-tier subagent architecture protocol stack. They compose prompts from base and conditional protocols, validate token resolution, and produce the final spawn JSON.

### lib/orchestrator-spawn.sh -- 1 function

| Function | Description |
|----------|-------------|
| `orchestrator_spawn_for_task` | Single-function orchestrator spawning entry point |

**Rationale**: Top-level orchestrator entry point that combines dispatch, token injection, and protocol injection. Purely CLEO orchestration logic.

---

## V2 TypeScript Conversion Plan

### Phase 1: Foundation (Provider + Detection)

**Scope**: Replace `lib/agent-registry.sh` and `lib/agent-config.sh`

**What gets converted first**: Provider registry lookup and detection. These are the most-called functions (54 combined across both files) and have the cleanest 1:1 mapping to CAAMP. Every other domain depends on provider data.

**Steps**:
1. Add `@cleocode/caamp` as a dependency to `mcp-server/package.json`
2. Create a thin TypeScript adapter layer (`src/providers.ts`) that wraps CAAMP's registry functions with any CLEO-specific logic (path resolution, legacy alias handling)
3. Create a Node CLI entrypoint (`bin/cleo-providers`) that bash scripts can call during transition
4. Update `lib/agent-registry.sh` and `lib/agent-config.sh` to delegate to the Node entrypoint via `node -e` or the CLI wrapper
5. Verify all existing tests pass with the delegated implementation

**Functions migrated**: 54 (27 from agent-registry.sh + 27 from agent-config.sh)

### Phase 2: MCP Configuration

**Scope**: Replace `lib/mcp-config.sh`

**What gets converted**: All MCP config reading, writing, format-specific merging, and detection. This is the most complex single bash file (28 functions, 6 config formats) and benefits most from CAAMP's typed format handling.

**Steps**:
1. Create `src/mcp.ts` adapter wrapping CAAMP's MCP installer, reader, and transform functions
2. Map CLEO's `mcp_write_config` workflow to `installMcpServer` + `recordMcpInstall`
3. Handle the lock file transition: migrate any state from CLEO's existing tracking to CAAMP's `~/.agents/.caamp-lock.json`
4. Replace bash MCP commands (`scripts/mcp-*.sh`) with Node entrypoints
5. Test all 12 supported tool formats (claude-code, claude-desktop, cursor, gemini-cli, kimi, antigravity, windsurf, goose, opencode, vscode, zed, codex)

**Functions migrated**: 28 (from mcp-config.sh)

### Phase 3: Skills Lifecycle

**Scope**: Replace `lib/skills-install.sh`, `lib/skill-discovery.sh`, `lib/skill-validate.sh`, `lib/skills-version.sh`

**What gets converted**: Skills installation, discovery, validation, and version tracking. These 4 files share the manifest as a common data source and benefit from CAAMP's unified `SkillEntry` model.

**Steps**:
1. Create `src/skills.ts` adapter wrapping CAAMP's skills installer, discovery, validator, and lock functions
2. Migrate from CLEO's `skills/manifest.json` to CAAMP's discovery-based approach for skill enumeration
3. Migrate version tracking from `~/.cleo/installed-skills.json` to CAAMP's lock file
4. Add CAAMP's security audit (`scanFile`, `scanDirectory`, `toSarif`) as a new capability for CI integration
5. Update skill-related CLI commands to use Node entrypoints

**Functions migrated**: 32 (7 + 7 + 10 + 8)

### Phase 4: Instructions + Marketplace

**Scope**: Replace `lib/injection-registry.sh`, `lib/injection-config.sh`, `lib/injection.sh`, `lib/skillsmp.sh`

**What gets converted**: Instruction file injection (marker-based block management) and marketplace integration.

**Steps**:
1. Create `src/instructions.ts` adapter wrapping CAAMP's inject/check functions
2. Handle marker migration: `<!-- CLEO:START -->` -> `<!-- CAAMP:START -->` (or configure CAAMP to support CLEO markers)
3. Create `src/marketplace.ts` adapter wrapping `MarketplaceClient`
4. Implement download workflow using Node `fetch` to replace bash `curl`
5. Add caching layer for marketplace queries at the CLEO adapter level
6. Update `scripts/init.sh` and related commands to use the new injection system

**Functions migrated**: 25 (8 constants + 6 + 6 + 5)

---

## Appendix: Full Migration Matrix

### Summary

| Category | Done | Pending | N/A | Total |
|----------|------|---------|-----|-------|
| Provider Registry (agent-registry.sh) | 0 | 27 | 0 | 27 |
| Provider Config (agent-config.sh) | 0 | 23 | 4 | 27 |
| MCP Configuration (mcp-config.sh) | 0 | 28 | 0 | 28 |
| Skills Install (skills-install.sh) | 0 | 7 | 0 | 7 |
| Skills Discovery (skill-discovery.sh) | 0 | 7 | 0 | 7 |
| Skills Validation (skill-validate.sh) | 0 | 10 | 0 | 10 |
| Skills Versioning (skills-version.sh) | 0 | 8 | 0 | 8 |
| Skills Marketplace (skillsmp.sh) | 0 | 5 | 0 | 5 |
| Injection Constants (injection-registry.sh) | 0 | 5 | 3 | 8 |
| Injection Config (injection-config.sh) | 0 | 5 | 1 | 6 |
| Injection Core (injection.sh) | 0 | 6 | 0 | 6 |
| Skill Dispatch (skill-dispatch.sh) | 0 | 0 | 24 | 24 |
| Token Injection (token-inject.sh) | 0 | 0 | 19 | 19 |
| Subagent Injection (subagent-inject.sh) | 0 | 0 | 8 | 8 |
| Orchestrator Spawn (orchestrator-spawn.sh) | 0 | 0 | 1 | 1 |
| **TOTAL** | **0** | **131** | **60** | **191** |

**Note on counts**: The original research cataloged 150 items (102 CAAMP-replaceable functions + 48 CLEO-only). This matrix counts 191 because it includes the 8 injection constants from `injection-registry.sh` separately, and the research noted 24 functions in `skill-dispatch.sh` (vs 23 in one section) and 19 in `token-inject.sh` (vs 17 in another section) based on the detailed listings. The final tally from the detailed function-by-function listing is:

- **CAAMP-replaceable**: 131 items (functions + constants) marked `pending`
- **CLEO-only (n/a)**: 56 items staying in bash (includes 4 agent-config.sh functions with no CAAMP equivalent that stay as CLEO utilities + the 48 orchestration functions + 3 injection constants replaced by TypeScript types + 1 injection-config.sh validation key function)
- **Already migrated (done)**: 0

Simplified breakdown:
- **0 done** -- No functions have been migrated yet
- **131 pending** -- Functions and constants with identified CAAMP replacements
- **60 n/a** -- Functions staying in CLEO bash (52 orchestration) or having no CAAMP equivalent (8 registry/config functions that become unnecessary or stay as CLEO utilities)

### Complete Function List

| # | Bash Function/Constant | Source File | CAAMP Replacement | Migration Phase | Status |
|---|------------------------|-------------|-------------------|-----------------|--------|
| 1 | `ar_load_registry` | agent-registry.sh | `getAllProviders` | 1 | pending |
| 2 | `_ar_ensure_loaded` | agent-registry.sh | Internal | 1 | pending |
| 3 | `ar_list_agents` | agent-registry.sh | `getAllProviders` | 1 | pending |
| 4 | `ar_list_by_tier` | agent-registry.sh | `getProvidersByPriority` | 1 | pending |
| 5 | `ar_list_by_instruction_file` | agent-registry.sh | `getProvidersByInstructFile` | 1 | pending |
| 6 | `ar_get_agent` | agent-registry.sh | `getProvider` | 1 | pending |
| 7 | `ar_get_field` | agent-registry.sh | `getProvider` + property | 1 | pending |
| 8 | `ar_agent_exists` | agent-registry.sh | `getProvider` + check | 1 | pending |
| 9 | `ar_get_global_dir` | agent-registry.sh | `Provider.pathGlobal` | 1 | pending |
| 10 | `ar_get_project_dir` | agent-registry.sh | `Provider.pathProject` | 1 | pending |
| 11 | `ar_get_instruction_file` | agent-registry.sh | `Provider.instructFile` | 1 | pending |
| 12 | `ar_get_global_instruction_path` | agent-registry.sh | Computed from Provider | 1 | pending |
| 13 | `ar_get_project_instruction_path` | agent-registry.sh | Computed from Provider | 1 | pending |
| 14 | `ar_get_global_skills_dir` | agent-registry.sh | `Provider.pathSkills` | 1 | pending |
| 15 | `ar_get_project_skills_dir` | agent-registry.sh | `Provider.pathProjectSkills` | 1 | pending |
| 16 | `ar_is_installed` | agent-registry.sh | `detectProvider` | 1 | pending |
| 17 | `ar_list_installed` | agent-registry.sh | `getInstalledProviders` | 1 | pending |
| 18 | `ar_list_installed_by_tier` | agent-registry.sh | `getInstalledProviders` + filter | 1 | pending |
| 19 | `ar_get_display_name` | agent-registry.sh | `Provider.toolName` | 1 | pending |
| 20 | `ar_get_vendor` | agent-registry.sh | `Provider.vendor` | 1 | pending |
| 21 | `ar_get_priority` | agent-registry.sh | `Provider.priority` | 1 | pending |
| 22 | `ar_get_status` | agent-registry.sh | `Provider.status` | 1 | pending |
| 23 | `ar_is_agent_skills_compatible` | agent-registry.sh | `Provider.agentSkillsCompatible` | 1 | pending |
| 24 | `ar_get_instruction_files` | agent-registry.sh | `getInstructionFiles` | 1 | pending |
| 25 | `ar_get_registry_json` | agent-registry.sh | `getAllProviders` | 1 | pending |
| 26 | `ar_get_agent_summary` | agent-registry.sh | `getProvider` + select | 1 | pending |
| 27 | `ar_list_agents_json` | agent-registry.sh | `getAllProviders` | 1 | pending |
| 28 | `load_agent_registry` | agent-config.sh | `getAllProviders` | 1 | pending |
| 29 | `normalize_agent_id` | agent-config.sh | `resolveAlias` | 1 | pending |
| 30 | `get_agent_dir` | agent-config.sh | `Provider.pathGlobal` | 1 | pending |
| 31 | `get_agent_config_file` | agent-config.sh | `Provider.instructFile` | 1 | pending |
| 32 | `get_all_agents` | agent-config.sh | `getAllProviders` | 1 | pending |
| 33 | `get_agents_by_tier` | agent-config.sh | `getProvidersByPriority` | 1 | pending |
| 34 | `get_agent_skills_dir` | agent-config.sh | `Provider.pathProjectSkills` | 1 | pending |
| 35 | `get_agent_project_skills_dir` | agent-config.sh | `Provider.pathProjectSkills` | 1 | pending |
| 36 | `get_agent_global_skills_dir` | agent-config.sh | `Provider.pathSkills` | 1 | pending |
| 37 | `get_skill_install_path` | agent-config.sh | Computed from Provider | 1 | pending |
| 38 | `install_skill_to_agent` | agent-config.sh | `installSkill` | 1 | pending |
| 39 | `list_agent_skills` | agent-config.sh | `listCanonicalSkills` | 1 | pending |
| 40 | `is_skill_installed` | agent-config.sh | `listCanonicalSkills` + check | 1 | pending |
| 41 | `uninstall_skill_from_agent` | agent-config.sh | `removeSkill` | 1 | pending |
| 42 | `get_agent_config_json` | agent-config.sh | `getProvider` | 1 | pending |
| 43 | `get_agent_display_name` | agent-config.sh | `Provider.toolName` | 1 | pending |
| 44 | `update_agent_config_registry` | agent-config.sh | No equivalent | 1 | n/a |
| 45 | `get_agent_config_version` | agent-config.sh | `getRegistryVersion` | 1 | pending |
| 46 | `validate_agent_config_registry` | agent-config.sh | Implicit on load | 1 | pending |
| 47 | `is_agent_registered` | agent-config.sh | `getProvider` + check | 1 | pending |
| 48 | `get_agent_config_data` | agent-config.sh | `getProvider` | 1 | pending |
| 49 | `list_agent_configs` | agent-config.sh | `getAllProviders` | 1 | pending |
| 50 | `get_agent_name_from_path` | agent-config.sh | No equivalent | 1 | n/a |
| 51 | `is_agent_cli_installed` | agent-config.sh | `detectProvider` | 1 | pending |
| 52 | `get_agent_config_path` | agent-config.sh | `resolveConfigPath` | 1 | pending |
| 53 | `create_empty_agent_registry` | agent-config.sh | No equivalent | 1 | n/a |
| 54 | `init_agent_config_registry` | agent-config.sh | No equivalent | 1 | n/a |
| 55 | `_mcp_display_name` | mcp-config.sh | `Provider.toolName` | 2 | pending |
| 56 | `_mcp_format` | mcp-config.sh | `Provider.configFormat` | 2 | pending |
| 57 | `_mcp_config_key` | mcp-config.sh | `Provider.configKey` | 2 | pending |
| 58 | `_mcp_binary` | mcp-config.sh | `Provider.detection` | 2 | pending |
| 59 | `_mcp_config_dir` | mcp-config.sh | `Provider.detection` | 2 | pending |
| 60 | `_mcp_app_bundle` | mcp-config.sh | `Provider.detection` | 2 | pending |
| 61 | `_mcp_flatpak_id` | mcp-config.sh | `Provider.detection` | 2 | pending |
| 62 | `_mcp_get_config_path` | mcp-config.sh | `resolveConfigPath` | 2 | pending |
| 63 | `_mcp_has_dual_scope` | mcp-config.sh | `Provider.configPathProject` | 2 | pending |
| 64 | `mcp_detect_tool` | mcp-config.sh | `detectProvider` | 2 | pending |
| 65 | `mcp_detect_all_tools` | mcp-config.sh | `detectAllProviders` | 2 | pending |
| 66 | `mcp_generate_entry` | mcp-config.sh | `buildServerConfig` | 2 | pending |
| 67 | `_mcp_merge_standard` | mcp-config.sh | `installMcpServer` | 2 | pending |
| 68 | `_mcp_merge_opencode` | mcp-config.sh | `installMcpServer` | 2 | pending |
| 69 | `_mcp_merge_vscode` | mcp-config.sh | `installMcpServer` | 2 | pending |
| 70 | `_mcp_merge_zed` | mcp-config.sh | `installMcpServer` | 2 | pending |
| 71 | `_mcp_generate_codex_toml_block` | mcp-config.sh | `getTransform("codex")` | 2 | pending |
| 72 | `_mcp_merge_codex_toml` | mcp-config.sh | `installMcpServer` | 2 | pending |
| 73 | `_mcp_generate_goose_yaml_block` | mcp-config.sh | `getTransform("goose")` | 2 | pending |
| 74 | `_mcp_merge_goose_yaml` | mcp-config.sh | `installMcpServer` | 2 | pending |
| 75 | `mcp_backup_external_file` | mcp-config.sh | Internal to CAAMP | 2 | pending |
| 76 | `mcp_write_config` | mcp-config.sh | `installMcpServer` | 2 | pending |
| 77 | `mcp_get_tool_keys` | mcp-config.sh | `getAllProviders` + map | 2 | pending |
| 78 | `mcp_get_tool_display_name` | mcp-config.sh | `Provider.toolName` | 2 | pending |
| 79 | `mcp_get_tool_format` | mcp-config.sh | `Provider.configFormat` | 2 | pending |
| 80 | `mcp_get_tool_config_key` | mcp-config.sh | `Provider.configKey` | 2 | pending |
| 81 | `mcp_get_config_path` | mcp-config.sh | `resolveConfigPath` | 2 | pending |
| 82 | `mcp_has_dual_scope` | mcp-config.sh | `Provider.configPathProject` | 2 | pending |
| 83 | `_init_skills_paths` | skills-install.sh | Internal to CAAMP | 3 | pending |
| 84 | `get_skills_from_manifest` | skills-install.sh | `discoverSkills` | 3 | pending |
| 85 | `get_skill_path` | skills-install.sh | `discoverSkill` | 3 | pending |
| 86 | `install_skill` | skills-install.sh | `installSkill` | 3 | pending |
| 87 | `install_skills` | skills-install.sh | `installSkill` (loop) | 3 | pending |
| 88 | `uninstall_skills` | skills-install.sh | `removeSkill` | 3 | pending |
| 89 | `list_installed_skills` | skills-install.sh | `listCanonicalSkills` | 3 | pending |
| 90 | `extract_skill_metadata` | skill-discovery.sh | `parseSkillFile` | 3 | pending |
| 91 | `parse_skill_header` | skill-discovery.sh | `parseSkillFile` | 3 | pending |
| 92 | `discover_skills` | skill-discovery.sh | `discoverSkills` | 3 | pending |
| 93 | `validate_skill` | skill-discovery.sh | `validateSkill` | 3 | pending |
| 94 | `register_skill` | skill-discovery.sh | `recordSkillInstall` | 3 | pending |
| 95 | `sync_manifest` | skill-discovery.sh | `discoverSkills` + reconcile | 3 | pending |
| 96 | `update_dispatch_matrix` | skill-discovery.sh | No equivalent (dispatch) | 3 | pending |
| 97 | `skill_exists` | skill-validate.sh | `discoverSkill` + check | 3 | pending |
| 98 | `skill_is_active` | skill-validate.sh | No equivalent (CLEO manifest) | 3 | pending |
| 99 | `skill_has_required_tokens` | skill-validate.sh | No equivalent (CLEO tokens) | 3 | pending |
| 100 | `skill_is_compatible_with_subagent` | skill-validate.sh | No equivalent (CLEO models) | 3 | pending |
| 101 | `skill_get_info` | skill-validate.sh | `parseSkillFile` | 3 | pending |
| 102 | `skill_list_all` | skill-validate.sh | `discoverSkills` | 3 | pending |
| 103 | `skill_validate_for_spawn` | skill-validate.sh | `validateSkill` + CLEO | 3 | pending |
| 104 | `skill_get_path` | skill-validate.sh | `SkillEntry.path` | 3 | pending |
| 105 | `skill_get_tags` | skill-validate.sh | `SkillMetadata.metadata` | 3 | pending |
| 106 | `skill_find_by_tag` | skill-validate.sh | `discoverSkills` + filter | 3 | pending |
| 107 | `init_installed_skills` | skills-version.sh | `readLockFile` | 3 | pending |
| 108 | `record_skill_version` | skills-version.sh | `recordSkillInstall` | 3 | pending |
| 109 | `get_installed_version` | skills-version.sh | `getTrackedSkills` | 3 | pending |
| 110 | `check_skill_updates` | skills-version.sh | `checkSkillUpdate` | 3 | pending |
| 111 | `apply_skill_updates` | skills-version.sh | `installSkill` per update | 3 | pending |
| 112 | `get_skill_update_count` | skills-version.sh | Composed from CAAMP | 3 | pending |
| 113 | `format_skill_updates` | skills-version.sh | No equivalent (display) | 3 | pending |
| 114 | `record_all_manifest_skills` | skills-version.sh | `recordSkillInstall` (loop) | 3 | pending |
| 115 | `INJECTION_TARGETS` | injection-registry.sh | `getAllProviders` + map | 4 | pending |
| 116 | `INJECTION_MARKER_START` | injection-registry.sh | `"<!-- CAAMP:START -->"` | 4 | pending |
| 117 | `INJECTION_MARKER_END` | injection-registry.sh | `"<!-- CAAMP:END -->"` | 4 | pending |
| 118 | `INJECTION_VERSION_PATTERN` | injection-registry.sh | Not needed | 4 | n/a |
| 119 | `INJECTION_TEMPLATE_MAIN` | injection-registry.sh | `generateInjectionContent` | 4 | pending |
| 120 | `INJECTION_TEMPLATE_DIR` | injection-registry.sh | Not needed | 4 | n/a |
| 121 | `INJECTION_HEADERS` | injection-registry.sh | `groupByInstructFile` | 4 | pending |
| 122 | `INJECTION_VALIDATION_KEYS` | injection-registry.sh | Not needed | 4 | n/a |
| 123 | `injection_is_valid_target` | injection-config.sh | `getProvider` + check | 4 | pending |
| 124 | `injection_get_targets` | injection-config.sh | `getAllProviders` | 4 | pending |
| 125 | `injection_get_header_path` | injection-config.sh | `groupByInstructFile` | 4 | pending |
| 126 | `injection_get_template_path` | injection-config.sh | `generateInjectionContent` | 4 | pending |
| 127 | `injection_get_validation_key` | injection-config.sh | Not needed | 4 | n/a |
| 128 | `injection_has_block` | injection-config.sh | `checkInjection` | 4 | pending |
| 129 | `injection_update` | injection.sh | `inject` | 4 | pending |
| 130 | `injection_check` | injection.sh | `checkInjection` | 4 | pending |
| 131 | `injection_check_all` | injection.sh | `checkAllInjections` | 4 | pending |
| 132 | `injection_apply` | injection.sh | `inject` | 4 | pending |
| 133 | `injection_update_all` | injection.sh | `injectAll` | 4 | pending |
| 134 | `injection_get_summary` | injection.sh | `checkAllInjections` + format | 4 | pending |
| 135 | `smp_load_config` | skillsmp.sh | `new MarketplaceClient()` | 4 | pending |
| 136 | `smp_search_skills` | skillsmp.sh | `MarketplaceClient.search` | 4 | pending |
| 137 | `smp_get_skill_details` | skillsmp.sh | `MarketplaceClient.getSkill` | 4 | pending |
| 138 | `smp_download_skill` | skillsmp.sh | No equivalent (Node fetch) | 4 | pending |
| 139 | `smp_install_skill` | skillsmp.sh | Composed workflow | 4 | pending |
| 140 | `skill_select_for_task` | skill-dispatch.sh | N/A | -- | n/a |
| 141 | `skill_dispatch_validate` | skill-dispatch.sh | N/A | -- | n/a |
| 142 | `skill_inject` | skill-dispatch.sh | N/A | -- | n/a |
| 143 | `skill_inject_for_task` | skill-dispatch.sh | N/A | -- | n/a |
| 144 | `skill_get_dispatch_triggers` | skill-dispatch.sh | N/A | -- | n/a |
| 145 | `skill_matches_labels` | skill-dispatch.sh | N/A | -- | n/a |
| 146 | `skill_matches_keywords` | skill-dispatch.sh | N/A | -- | n/a |
| 147 | `skill_matches_type` | skill-dispatch.sh | N/A | -- | n/a |
| 148 | `skill_list_with_triggers` | skill-dispatch.sh | N/A | -- | n/a |
| 149 | `skill_find_by_trigger` | skill-dispatch.sh | N/A | -- | n/a |
| 150 | `get_skills_by_category` | skill-dispatch.sh | N/A | -- | n/a |
| 151 | `skill_dispatch_by_category` | skill-dispatch.sh | N/A | -- | n/a |
| 152 | `skill_get_tier` | skill-dispatch.sh | N/A | -- | n/a |
| 153 | `skill_is_tier` | skill-dispatch.sh | N/A | -- | n/a |
| 154 | `skill_dispatch_by_keywords` | skill-dispatch.sh | N/A | -- | n/a |
| 155 | `skill_dispatch_by_type` | skill-dispatch.sh | N/A | -- | n/a |
| 156 | `skill_dispatch_by_protocol` | skill-dispatch.sh | N/A | -- | n/a |
| 157 | `skill_get_metadata` | skill-dispatch.sh | N/A | -- | n/a |
| 158 | `skill_get_references` | skill-dispatch.sh | N/A | -- | n/a |
| 159 | `skill_check_compatibility` | skill-dispatch.sh | N/A | -- | n/a |
| 160 | `skill_list_by_tier` | skill-dispatch.sh | N/A | -- | n/a |
| 161 | `skill_auto_dispatch` | skill-dispatch.sh | N/A | -- | n/a |
| 162 | `skill_prepare_spawn` | skill-dispatch.sh | N/A | -- | n/a |
| 163 | `skill_prepare_spawn_multi` | skill-dispatch.sh | N/A | -- | n/a |
| 164 | `ti_set_defaults` | token-inject.sh | N/A | -- | n/a |
| 165 | `ti_validate_required` | token-inject.sh | N/A | -- | n/a |
| 166 | `ti_inject_tokens` | token-inject.sh | N/A | -- | n/a |
| 167 | `ti_load_template` | token-inject.sh | N/A | -- | n/a |
| 168 | `ti_list_tokens` | token-inject.sh | N/A | -- | n/a |
| 169 | `ti_get_default` | token-inject.sh | N/A | -- | n/a |
| 170 | `ti_clear_all` | token-inject.sh | N/A | -- | n/a |
| 171 | `ti_set_context` | token-inject.sh | N/A | -- | n/a |
| 172 | `ti_set_task_context` | token-inject.sh | N/A | -- | n/a |
| 173 | `ti_extract_manifest_summaries` | token-inject.sh | N/A | -- | n/a |
| 174 | `ti_extract_next_task_ids` | token-inject.sh | N/A | -- | n/a |
| 175 | `ti_reload_tokens` | token-inject.sh | N/A | -- | n/a |
| 176 | `ti_populate_skill_specific_tokens` | token-inject.sh | N/A | -- | n/a |
| 177 | `validate_token_value` | token-inject.sh | N/A | -- | n/a |
| 178 | `ti_validate_all_tokens` | token-inject.sh | N/A | -- | n/a |
| 179 | `ti_verify_all_resolved` | token-inject.sh | N/A | -- | n/a |
| 180 | `ti_inject_and_verify` | token-inject.sh | N/A | -- | n/a |
| 181 | `ti_get_session_id` | token-inject.sh | N/A | -- | n/a |
| 182 | `ti_set_full_context` | token-inject.sh | N/A | -- | n/a |
| 183 | `subagent_prepare` | subagent-inject.sh | N/A | -- | n/a |
| 184 | `subagent_get_task_context` | subagent-inject.sh | N/A | -- | n/a |
| 185 | `subagent_inject_protocol` | subagent-inject.sh | N/A | -- | n/a |
| 186 | `orchestrator_spawn_skill` | subagent-inject.sh | N/A | -- | n/a |
| 187 | `orchestrator_spawn_minimal` | subagent-inject.sh | N/A | -- | n/a |
| 188 | `orchestrator_validate_spawn` | subagent-inject.sh | N/A | -- | n/a |
| 189 | `subagent_list_required_tokens` | subagent-inject.sh | N/A | -- | n/a |
| 190 | `subagent_get_protocol_path` | subagent-inject.sh | N/A | -- | n/a |
| 191 | `orchestrator_spawn_for_task` | orchestrator-spawn.sh | N/A | -- | n/a |
