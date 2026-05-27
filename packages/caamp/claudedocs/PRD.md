# CAAMP - Product Requirements Document

## Document Information

| Field | Value |
|-------|-------|
| Version | 1.0.0 |
| Date | 2026-02-11 |
| Author | CAAMP Product Team |
| Status | Approved (v0.1.0 shipped) |
| Package | `@cleocode/caamp` |
| Repository | `github.com/kryptobaseddev/caamp` |

---

## 1. Executive Summary

CAAMP (Central AI Agent Managed Packages) is a TypeScript CLI and library that provides a unified provider registry and package manager for AI coding agents. It is the first tool to combine Skills management, MCP server configuration, instruction file injection, and config format handling into a single CLI -- bridging the gap between 28 AI coding agents that each use different configuration formats, directory structures, and conventions.

The AI coding agent ecosystem in early 2026 is fragmented. Each agent -- Claude Code, Cursor, Windsurf, Codex CLI, Gemini CLI, GitHub Copilot, and 22 others -- stores MCP server configurations in different files, different formats (JSON, JSONC, YAML, TOML), under different keys (`mcpServers`, `mcp_servers`, `extensions`, `mcp`, `servers`, `context_servers`), and reads instruction files from different filenames (`CLAUDE.md`, `GEMINI.md`, `AGENTS.md`). CAAMP eliminates this fragmentation with a single source of truth.

CAAMP ships as both a CLI (`npm install -g @cleocode/caamp` or `npx @cleocode/caamp <command>`) and a library (`import { ... } from "@cleocode/caamp"`) with 57 programmatic exports. It targets individual developers running multiple AI agents, teams standardizing agent configurations, and skill/MCP server authors distributing their work across the ecosystem.

---

## 2. Problem Statement

### 2.1 Fragmented Configuration Landscape

The AI coding agent space has exploded from 3-4 tools in 2025 to 28+ distinct agents in early 2026. Each agent has independently invented its own configuration scheme:

- **28 different providers**, each with unique paths, config formats, and directory structures
- **6 different config key names** for the same concept (MCP server registration):
  - `mcpServers` (Claude Code, Cursor, Gemini CLI, Cline, and 16 others)
  - `mcp_servers` (Codex CLI)
  - `extensions` (Goose)
  - `mcp` (OpenCode)
  - `servers` (VS Code)
  - `context_servers` (Zed)
- **4 different config file formats**: JSON, JSONC (with comments), YAML, TOML
- **3 different instruction file conventions**: `CLAUDE.md`, `GEMINI.md`, `AGENTS.md`

### 2.2 Skills Ecosystem Fragmentation

The emerging "Skills" ecosystem (reusable AI agent prompts/instructions packaged as SKILL.md files) has no unified distribution mechanism:

- Multiple competing marketplaces (agentskills.in, skills.sh) with no interoperability
- No standard installation model across agents
- No security scanning for malicious prompt injection in community skills
- No version tracking or update mechanism

### 2.3 MCP Server Configuration Burden

MCP (Model Context Protocol) servers must be manually configured in each agent's config file:

- 5 agents require non-standard config transformations (Goose, Zed, OpenCode, Codex, Cursor)
- Remote vs. stdio transports need different config shapes per agent
- No lock file tracking what was installed where
- Installing one MCP server to 5 agents requires editing 5 different files in 5 different formats

### 2.4 Instruction File Management

Teams using multiple agents must maintain parallel instruction files:

- Claude Code reads `CLAUDE.md`, Gemini CLI reads `GEMINI.md`, 25 other agents read `AGENTS.md`
- Keeping shared configuration blocks synchronized across these files is manual and error-prone
- No injection/update mechanism for shared content blocks

### 2.5 Real-World Origin

CAAMP was born from a concrete pain point: the CLEO project maintained 3 diverging registries (`agent-registry.json`, `mcp-config.sh`, `injection-registry.sh`) that each tracked overlapping but inconsistent subsets of the same provider data. CAAMP consolidates all provider knowledge into a single `registry.json`.

---

## 3. Vision Statement

**"One CLI to manage them all."**

CAAMP is the npm/apt/brew of AI agent configuration. Just as npm unified JavaScript package management and homebrew unified macOS software installation, CAAMP unifies the configuration and package management of AI coding agents.

A developer should be able to:
1. Install an MCP server to all their agents with a single command
2. Install a skill to all their agents with a single command
3. Keep instruction files synchronized across agents automatically
4. Discover which agents are installed on their system
5. Search for and audit community skills before installing them
6. Track everything in a lock file for reproducibility
7. Rely on LAFS-compliant default outputs for deterministic agent automation

---

## 4. Target Users

### 4.1 AI Tool Power Users

Developers who run 2-5+ AI coding agents simultaneously (e.g., Claude Code for complex tasks, Cursor for quick edits, Gemini CLI for Google ecosystem work). They waste significant time configuring the same MCP servers and skills across multiple tools.

### 4.2 Development Teams

Teams that need standardized agent configurations across all team members. CAAMP's instruction injection and project-level config support enables consistent agent behavior.

### 4.3 Skill and MCP Server Authors

Developers building reusable skills (SKILL.md) or MCP servers who want their work to be installable across all 28 agents without writing per-agent installation instructions.

### 4.4 Framework and Tool Maintainers

Maintainers of AI coding tools who want to understand the provider landscape and ensure compatibility with emerging standards.

### 4.5 DevOps and Platform Engineers

Engineers managing AI agent infrastructure at scale who need programmatic access to provider detection, configuration management, and security auditing.

---

## 5. User Stories

### Provider Management

1. **US-P01**: As a developer, I want to list all supported AI coding agents so that I can see which tools CAAMP knows about.
2. **US-P02**: As a developer, I want to auto-detect which agents are installed on my system so that I can target them for configuration.
3. **US-P03**: As a developer, I want to view detailed information about a specific provider (paths, config format, supported transports) so that I understand its configuration requirements.

### Skills Management

4. **US-S01**: As a developer, I want to install a skill from a GitHub repository so that my agents can use community-authored prompts.
5. **US-S02**: As a developer, I want to install a skill to specific agents (not all) so that I can control which agents receive which skills.
6. **US-S03**: As a developer, I want to remove a skill and have it cleaned up from all agents so that uninstallation is complete.
7. **US-S04**: As a developer, I want to list all installed skills (globally and per-project) so that I can inventory my skill set.
8. **US-S05**: As a developer, I want to search marketplaces for skills by keyword so that I can discover useful community skills.
9. **US-S06**: As a developer, I want to create a new skill template with `caamp skills init` so that I can author and distribute my own skills.
10. **US-S07**: As a developer, I want to validate a SKILL.md file against the standard so that I can ensure my skill is well-formed before publishing.
11. **US-S08**: As a security-conscious developer, I want to audit a skill for prompt injection, command injection, data exfiltration, and other threats so that I can assess risk before installation.
12. **US-S09**: As a CI/CD engineer, I want SARIF-formatted audit output so that I can integrate skill security scanning into my pipeline.
13. **US-S10**: As a developer, I want to check for skill updates so that I can keep my installed skills current.

### MCP Server Management

14. **US-M01**: As a developer, I want to install an MCP server to all my detected agents with a single command so that I do not have to edit each config file manually.
15. **US-M02**: As a developer, I want CAAMP to handle per-agent config transformations automatically (Goose YAML extensions, Zed context_servers, etc.) so that I do not need to know each agent's config schema.
16. **US-M03**: As a developer, I want to remove an MCP server from all agents with a single command so that cleanup is comprehensive.
17. **US-M04**: As a developer, I want to list all configured MCP servers across all my agents so that I have a unified view.
18. **US-M05**: As a developer, I want to auto-detect MCP configurations in my project and global config files so that I can inventory what is already configured.
19. **US-M06**: As a developer, I want a lock file tracking all MCP installs so that I can reproduce my configuration on another machine.

### Instructions Management

20. **US-I01**: As a team lead, I want to inject a shared configuration block into all instruction files (CLAUDE.md, AGENTS.md, GEMINI.md) so that all agents receive the same project context.
21. **US-I02**: As a developer, I want to check whether instruction injections are current, outdated, or missing so that I can identify drift.
22. **US-I03**: As a developer, I want to update all instruction injections in a single command so that I can keep them synchronized.
23. **US-I04**: As an automation engineer, I want agent-facing outputs to default to LAFS so that orchestration workflows are consistent, token-efficient, and context-safe across languages.

### Config Management

24. **US-C01**: As a developer, I want to view the config file for any provider so that I can inspect its current state.
25. **US-C02**: As a developer, I want to get the config file path for any provider so that I can open it in my editor.

### Library API

26. **US-L01**: As a tool author, I want to use CAAMP as a library (not just a CLI) so that I can build custom tooling on top of its provider registry and config management.

---

## 6. Feature Requirements

### 6.1 P0 - Core (Shipped in v0.1.0)

#### 6.1.1 Provider Registry

- **Single `registry.json`** file containing all 28 provider definitions
- Each provider specifies: `id`, `toolName`, `vendor`, `agentFlag`, `aliases`, `pathGlobal`, `pathProject`, `instructFile`, `configKey`, `configFormat`, `configPathGlobal`, `configPathProject`, `pathSkills`, `pathProjectSkills`, `detection`, `supportedTransports`, `supportsHeaders`, `priority`, `status`, `agentSkillsCompatible`
- Registry version tracking (`1.0.0`)
- Query functions: `getAllProviders()`, `getProvider(id)`, `resolveAlias(alias)`, `getProvidersByPriority(tier)`, `getProvidersByStatus(status)`, `getProvidersByInstructFile(file)`, `getInstructionFiles()`, `getProviderCount()`, `getRegistryVersion()`
- Provider type: `Provider` (defined in `src/types.ts:31-59`)

#### 6.1.2 Provider Detection Engine

- Four detection methods: `binary` (via `which`), `directory` (via `existsSync`), `appBundle` (macOS `/Applications`), `flatpak` (Linux `flatpak info`)
- System-wide detection: `detectAllProviders()`, `getInstalledProviders()`
- Project-level detection: `detectProjectProviders(projectDir)` checks for provider project directories
- Result type: `DetectionResult` with `provider`, `installed`, `methods[]`, `projectDetected`

#### 6.1.3 MCP Server Configuration

- **Installer** (`src/core/mcp/installer.ts`): Writes MCP server configs to agent config files
- **Config transforms** for 5 non-standard agents:
  - Goose: `extensions` array with `name`, `type`, `cmd`/`uri`, `enabled`, `timeout`
  - Zed: `context_servers` with `source: "custom"`, `command`/`url`
  - OpenCode: `mcp` with `type: "local"/"remote"`, `enabled`
  - Codex: `mcp_servers` in TOML format
  - Cursor: Strips `type` field for remote servers
- **Reader** (`src/core/mcp/reader.ts`): `resolveConfigPath()`, `listMcpServers()`, `listAllMcpServers()`, `removeMcpServer()`
- **Lock file** (`src/core/mcp/lock.ts`): Tracks installs at `~/.agents/.caamp-lock.json` with `readLockFile()`, `recordMcpInstall()`, `removeMcpFromLock()`, `getTrackedMcpServers()`, `saveLastSelectedAgents()`, `getLastSelectedAgents()`
- Lock file schema: `CaampLockFile` with `version: 1`, `skills`, `mcpServers`, `lastSelectedAgents`

#### 6.1.4 Skills Management

- **Installer** (`src/core/skills/installer.ts`): Canonical + symlink model
  - Skills stored once at `~/.agents/skills/<name>/`
  - Symlinked to each target agent's skills directory
  - Windows fallback: junction or copy if symlinks unsupported
- **Discovery** (`src/core/skills/discovery.ts`): `discoverSkills()`, `discoverSkill()`, `parseSkillFile()`
- **Validator** (`src/core/skills/validator.ts`): Validates SKILL.md against Agent Skills standard
  - Required fields: `name`, `description` (in YAML frontmatter)
  - Name constraints: lowercase alphanumeric + hyphens, max 64 chars, no reserved names
  - Description constraints: max 1024 chars, no HTML/XML tags
  - Body warnings: >500 lines, empty body
  - Reserved names: anthropic, claude, google, openai, microsoft, cursor, windsurf, codex, gemini, copilot
- **Lock file** (`src/core/skills/lock.ts`): `recordSkillInstall()`, `removeSkillFromLock()`, `getTrackedSkills()`, `checkSkillUpdate()`

#### 6.1.5 Config Format Handling

- **JSON** (`src/core/formats/json.ts`): Standard JSON read/write
- **JSONC** (`src/core/formats/json.ts`): Comment-preserving read/write via `jsonc-parser`
- **YAML** (`src/core/formats/yaml.ts`): Via `js-yaml`
- **TOML** (`src/core/formats/toml.ts`): Via `@iarna/toml`
- **Format router** (`src/core/formats/index.ts`): `readConfig()`, `writeConfig()`, `removeConfig()`
- **Utilities** (`src/core/formats/utils.ts`): `deepMerge()`, `getNestedValue()`, `ensureDir()`

#### 6.1.6 LAFS Protocol Baseline

- **Canonical protocol**: `https://github.com/kryptobaseddev/lafs/blob/main/lafs.md`
- **Package dependency**: `@cleocode/lafs`
- **CAAMP profile mapping**: `docs/LAFS-COMPLIANCE.md`

### 6.2 P1 - Essential (Shipped in v0.1.0)

#### 6.2.1 Marketplace Search

- **Unified client** (`src/core/marketplace/client.ts`): Adapter pattern aggregating multiple backends
- **agentskills.in adapter** (`src/core/marketplace/skillsmp.ts`): API adapter for agentskills.in marketplace
- **skills.sh adapter** (`src/core/marketplace/skillssh.ts`): API adapter for skills.sh marketplace
- Deduplication by `scopedName`, keeping higher star count
- Sort by stars descending
- Parallel search across all adapters with error isolation (individual adapter failures do not block results)

#### 6.2.2 Security Audit

- **46 security rules** across 8 categories (`src/core/skills/audit/rules.ts`):
  - **Prompt Injection** (8 rules): PI001-PI008 -- system prompt override, role manipulation, jailbreak, instruction override, hidden instructions, encoding bypass, context manipulation, token smuggling
  - **Command Injection** (8 rules): CI001-CI008 -- destructive commands, remote code execution, eval, shell spawn, sudo escalation, environment manipulation, cron, network listeners
  - **Data Exfiltration** (6 rules): DE001-DE006 -- credential access, API key extraction, data upload, browser data theft, git credential theft, keychain access
  - **Privilege Escalation** (4 rules): PE001-PE004 -- dangerous chmod, SUID/SGID, Docker escape, kernel modules
  - **Filesystem Abuse** (4 rules): FS001-FS004 -- system directory write, hidden files, symlink attacks, mass operations
  - **Network Abuse** (4 rules): NA001-NA004 -- DNS exfiltration, reverse shells, port scanning, tunnels
  - **Obfuscation** (3 rules): OB001-OB003 -- hex encoding, string concatenation, Unicode escape
  - **Supply Chain** (4 rules): SC001-SC004 -- runtime package install, typosquatting, postinstall scripts, registry override
  - **Information Disclosure** (3 rules): ID001-ID003 -- process listing, system info, network enumeration
  - **Note**: 2 additional rules are unaccounted above but exist in the source
- **Scoring**: 100 (clean) to 0 (dangerous), weighted by severity (critical=25, high=15, medium=8, low=3, info=0)
- **SARIF output** (`toSarif()`): OASIS SARIF 2.1.0 compliant output for CI/CD integration
- **Scanner** (`src/core/skills/audit/scanner.ts`): `scanFile()`, `scanDirectory()`, `toSarif()`

#### 6.2.3 Instructions Injection

- **Marker-based injection** (`src/core/instructions/injector.ts`):
  - Markers: `<!-- CAAMP:START -->` and `<!-- CAAMP:END -->`
  - Operations: `inject()`, `checkInjection()`, `removeInjection()`, `checkAllInjections()`, `injectAll()`
  - Injection modes: create new file, prepend to existing file, replace existing block
  - Clean removal: removes block, collapses extra newlines, removes empty files entirely
- **Template generation** (`src/core/instructions/templates.ts`): `generateInjectionContent()`, `groupByInstructFile()`
- **3 instruction files only**: `CLAUDE.md` (Claude Code), `GEMINI.md` (Gemini CLI), `AGENTS.md` (all 26 other providers)

#### 6.2.4 Source Parsing

- **Source classifier** (`src/core/sources/parser.ts`): `parseSource(input)` classifies arbitrary input strings into typed sources
- **6 source types**: `remote` (HTTP URLs), `package` (npm packages), `command` (shell commands), `github` (GitHub URLs or owner/repo shorthand), `gitlab` (GitLab URLs), `local` (filesystem paths)
- **Name inference**: Automatically extracts display names from URLs, package names, repo names
- **GitHub fetcher** (`src/core/sources/github.ts`)
- **GitLab fetcher** (`src/core/sources/gitlab.ts`)
- **Well-known discovery** (`src/core/sources/wellknown.ts`): RFC 8615 `/.well-known/skills/index.json` endpoint discovery

#### 6.2.5 Per-Agent Config Transforms

Five agents require non-standard MCP config shapes. CAAMP transparently transforms the canonical `McpServerConfig` to each agent's format:

| Agent | Config Key | Format | Transform |
|-------|-----------|--------|-----------|
| Goose | `extensions` | YAML | `name`, `type`, `cmd`/`uri`, `enabled`, `timeout` |
| Zed | `context_servers` | JSONC | `source: "custom"`, `command`/`url` |
| OpenCode | `mcp` | JSON | `type: "local"/"remote"`, `enabled` |
| Codex | `mcp_servers` | TOML | Standard keys, TOML format |
| Cursor | `mcpServers` | JSON | Strips `type` for remote servers |

### 6.3 P2 - Important (Partially Shipped)

#### 6.3.1 Skills Update/Check (Shipped)

- `caamp skills check`: Checks for available updates to installed skills
- `caamp skills update`: Updates installed skills to latest versions
- Lock file comparison for version tracking via `checkSkillUpdate()`

#### 6.3.2 Config Commands (Shipped)

- `caamp config show <provider>`: Display current config for a provider
- `caamp config path <provider>`: Show the config file path for a provider

#### 6.3.3 Well-Known Discovery (Shipped)

- RFC 8615 discovery at `https://<domain>/.well-known/skills/index.json`
- Returns skill name, description, and URL for each discovered skill

#### 6.3.4 Library API (Shipped)

- 57 named exports from `src/index.ts` covering all core functionality:
  - 18 type exports (Provider, McpServerConfig, ConfigFormat, etc.)
  - 9 registry functions
  - 4 detection functions
  - 2 source parsing functions
  - 6 skills functions (install, remove, list, discover, validate, audit)
  - 4 MCP install functions
  - 4 MCP read/list/remove functions
  - 6 MCP lock functions
  - 4 skills lock functions
  - 1 marketplace client class
  - 5 instruction functions
  - 4 format functions

### 6.4 P3 - Future (Not Started)

#### 6.4.1 `caamp doctor`

- System-wide diagnostic command
- Verify all detected provider configs are valid
- Check for common misconfiguration issues
- Validate lock file consistency
- Report broken symlinks

#### 6.4.2 `caamp migrate`

- Migrate configuration from one agent to another
- Copy MCP server configs between agents with automatic format conversion
- Export/import configuration bundles

#### 6.4.3 Plugin System

- Allow custom provider definitions beyond the built-in 28
- Plugin discovery and loading
- Community provider contributions without core PRs

#### 6.4.4 CI/CD Integration

- GitHub Actions for skill auditing
- Pre-commit hooks for instruction file validation
- Config drift detection in CI pipelines

#### 6.4.5 Team Config Sharing

- Shareable config bundles (`.caamp/team.json`)
- `caamp sync` to pull team configurations
- Remote config registry for organizations

#### 6.4.6 Config Templates

- Pre-built configuration templates for common setups
- `caamp template apply <name>` to bootstrap agent configurations
- Community template registry

---

## 7. Competitive Landscape

### 7.1 Vercel Skills CLI

**What it does**: Vercel's `skills` CLI provides skill authoring and marketplace publishing, primarily targeting the Vercel ecosystem. It defines the SKILL.md standard that community marketplaces have adopted.

**What CAAMP borrowed**: The SKILL.md file format and frontmatter schema, the concept of marketplace search.

**What CAAMP adds**: Multi-agent support (Vercel's tool is single-agent focused), security auditing with 46 rules and SARIF output, canonical+symlink installation model, lock file tracking, and aggregation of multiple marketplace backends.

### 7.2 Neon `add-mcp`

**What it does**: Neon's `add-mcp` utility simplifies adding a single MCP server to a single agent. It detects your agent and writes the config file.

**What CAAMP borrowed**: The concept of auto-detecting installed agents and writing MCP configs.

**What CAAMP adds**: Multi-agent installation (one command installs to all agents), per-agent config transforms for non-standard agents, lock file tracking, config removal, and support for all 28 providers (not just the most common ones).

### 7.3 Agent Skills Marketplace (agentskills.in)

**What it does**: A web-based marketplace for discovering and browsing community skills. Provides a GitHub-backed directory of SKILL.md files.

**What CAAMP borrowed**: The marketplace API for skill search and discovery.

**What CAAMP adds**: CLI-based installation directly from marketplace search results, security auditing before install, multi-agent targeting, and aggregation with skills.sh for broader coverage.

### 7.4 CAAMP's Unique Position

CAAMP is the **only tool** that combines all four pillars:

| Capability | Vercel Skills | Neon add-mcp | agentskills.in | CAAMP |
|-----------|:---:|:---:|:---:|:---:|
| Skills install/manage | Partial | No | Browse only | Yes |
| MCP server install | No | Single-agent | No | Multi-agent |
| Instruction injection | No | No | No | Yes |
| Config format handling | No | Partial | No | JSON/JSONC/YAML/TOML |
| Provider registry | No | Limited | No | 28 providers |
| Security auditing | No | No | No | 46 rules, SARIF |
| Lock file tracking | No | No | No | Yes |
| Library API | No | No | No | 57 exports |

---

## 8. Provider Ecosystem

### 8.1 Full Provider Registry (28 Providers)

| # | ID | Tool Name | Vendor | Priority | Config Key | Config Format | Instruction File | Status |
|---|---|-----------|--------|----------|-----------|---------------|-----------------|--------|
| 1 | `claude-code` | Claude Code | Anthropic | high | `mcpServers` | json | CLAUDE.md | active |
| 2 | `cursor` | Cursor | Anysphere | high | `mcpServers` | json | AGENTS.md | active |
| 3 | `windsurf` | Windsurf | Codeium | high | `mcpServers` | json | AGENTS.md | active |
| 4 | `codex` | Codex CLI | OpenAI | medium | `mcp_servers` | toml | AGENTS.md | active |
| 5 | `gemini-cli` | Gemini CLI | Google | medium | `mcpServers` | json | GEMINI.md | active |
| 6 | `github-copilot` | GitHub Copilot | GitHub | medium | `mcpServers` | json | AGENTS.md | active |
| 7 | `opencode` | OpenCode | OpenCode | medium | `mcp` | json | AGENTS.md | active |
| 8 | `cline` | Cline | Cline | medium | `mcpServers` | json | AGENTS.md | active |
| 9 | `kimi` | Kimi Coding | Moonshot AI | medium | `mcpServers` | json | AGENTS.md | active |
| 10 | `vscode` | VS Code | Microsoft | medium | `servers` | json | AGENTS.md | active |
| 11 | `zed` | Zed | Zed Industries | medium | `context_servers` | jsonc | AGENTS.md | active |
| 12 | `claude-desktop` | Claude Desktop | Anthropic | medium | `mcpServers` | json | CLAUDE.md | active |
| 13 | `roo` | Roo Code | Roo Code | low | `mcpServers` | json | AGENTS.md | active |
| 14 | `continue` | Continue | Continue | low | `mcpServers` | json | AGENTS.md | active |
| 15 | `goose` | Goose | Block | low | `extensions` | yaml | AGENTS.md | active |
| 16 | `antigravity` | Antigravity | Antigravity | low | `mcpServers` | json | AGENTS.md | active |
| 17 | `kiro-cli` | Kiro | Amazon | low | `mcpServers` | json | AGENTS.md | active |
| 18 | `amp` | Amp | Sourcegraph | low | `mcpServers` | json | AGENTS.md | active |
| 19 | `trae` | Trae | ByteDance | low | `mcpServers` | json | AGENTS.md | active |
| 20 | `aide` | Aide | Aide | low | `mcpServers` | json | AGENTS.md | beta |
| 21 | `pear-ai` | Pear AI | Pear AI | low | `mcpServers` | json | AGENTS.md | beta |
| 22 | `void-ai` | Void AI | Void | low | `mcpServers` | json | AGENTS.md | beta |
| 23 | `cody` | Sourcegraph Cody | Sourcegraph | low | `mcpServers` | json | AGENTS.md | active |
| 24 | `kilo-code` | Kilo Code | Kilo Code | low | `mcpServers` | json | AGENTS.md | active |
| 25 | `qwen-code` | Qwen Code | Alibaba | low | `mcpServers` | json | AGENTS.md | beta |
| 26 | `openhands` | OpenHands | All Hands AI | low | `mcpServers` | json | AGENTS.md | active |
| 27 | `codebuddy` | CodeBuddy | CodeBuddy | low | `mcpServers` | json | AGENTS.md | beta |
| 28 | `codestory` | CodeStory | CodeStory | low | `mcpServers` | json | AGENTS.md | beta |

### 8.2 Priority Tiers

- **High (3)**: Claude Code, Cursor, Windsurf -- the most widely adopted AI coding agents
- **Medium (9)**: Codex CLI, Gemini CLI, GitHub Copilot, OpenCode, Cline, Kimi Coding, VS Code, Zed, Claude Desktop
- **Low (16)**: All others -- emerging, niche, or beta-status agents

### 8.3 Status Distribution

- **Active**: 22 providers
- **Beta**: 6 providers (Aide, Pear AI, Void AI, Qwen Code, CodeBuddy, CodeStory)

---

## 9. Technical Constraints

### 9.1 Language and Runtime

- **TypeScript** strict mode with `noUncheckedIndexedAccess`
- **ESM-only** (`"type": "module"`, `.js` extensions in all imports)
- **NodeNext** module resolution
- **Node.js >= 18** (required by `engines` in package.json)
- Build: `tsup` producing ESM + declaration files
- Test: `vitest` (74 passing tests in v0.1.0)
- Dev: `tsx` for development-time execution

### 9.2 Data Model

- **Single `registry.json`**: All 28 provider definitions in one human-editable JSON file at `providers/registry.json`
- **Canonical + symlink**: Skills stored once at `~/.agents/skills/<name>/`, symlinked to each agent
- **Lock file**: `~/.agents/.caamp-lock.json` tracking all MCP and skill installs
- **Comment preservation**: JSONC writes via `jsonc-parser` preserve existing comments in config files

### 9.3 Dependencies (7 Runtime)

| Package | Purpose | Version |
|---------|---------|---------|
| `commander` | CLI framework | ^13.0.0 |
| `@clack/prompts` | Interactive prompts | ^0.10.0 |
| `picocolors` | Terminal colors | ^1.1.0 |
| `gray-matter` | YAML frontmatter parsing | ^4.0.3 |
| `simple-git` | Git operations | ^3.27.0 |
| `jsonc-parser` | Comment-preserving JSON | ^3.3.1 |
| `js-yaml` | YAML read/write | ^4.1.0 |
| `@iarna/toml` | TOML read/write | ^2.2.5 |

### 9.4 Platform Support

- **Linux**: Full support including Flatpak detection
- **macOS**: Full support including app bundle detection (`/Applications/*.app`)
- **Windows**: Partial support with junction fallback for symlinks

---

## 10. Success Metrics

### 10.1 Adoption

| Metric | v0.1.0 Baseline | v0.2.0 Target | v1.0.0 Target |
|--------|----------------|---------------|---------------|
| npm weekly downloads | -- | 100+ | 1,000+ |
| GitHub stars | -- | 50+ | 500+ |
| Provider count | 28 | 32+ | 40+ |

### 10.2 Coverage

| Metric | v0.1.0 | Target |
|--------|--------|--------|
| Providers in registry | 28 | All known agents |
| Audit rules | 46 | 60+ |
| Test count | 74 | 150+ |
| Library exports | 57 | 70+ |
| CLI commands | 21 | 25+ |

### 10.3 Quality

| Metric | Standard |
|--------|----------|
| Test coverage | >80% |
| TypeScript strict | Enabled |
| Zero runtime errors | In core operations |
| Sub-second CLI response | For non-network commands |

---

## 11. Product Roadmap

### v0.1.0 -- Initial Release (Shipped 2026-02-11)

- Unified provider registry (28 providers)
- Provider auto-detection (binary, directory, appBundle, flatpak)
- MCP server install/remove/list/detect with per-agent transforms
- Skills install/remove/list/find/init/validate/audit/check/update
- Config format handling (JSON/JSONC/YAML/TOML)
- Marketplace search (agentskills.in + skills.sh)
- Security audit (46 rules, SARIF output)
- Instructions injection/check/update
- Lock file management
- Library API (57 exports)
- Published as `@cleocode/caamp` on npm

### v0.2.0 -- Stability and Polish (Planned)

- `caamp doctor` diagnostics command
- Improved error messages and edge case handling
- Integration tests for real agent config files
- Expanded test coverage (target: >80%)
- Performance optimization for large registries
- Windows symlink improvements
- Additional audit rules (target: 60+)

### v0.3.0 -- Ecosystem Integration (Future)

- `caamp migrate` between agents
- GitHub Actions for CI/CD skill auditing
- Pre-commit hooks
- Config drift detection
- Community provider contributions

### v1.0.0 -- Stable Release (Future)

- API stability guarantee
- Plugin system for custom providers
- Team config sharing and sync
- Config templates
- Comprehensive documentation site
- Semantic versioning commitment

---

## 12. Risks and Mitigations

### 12.1 API Instability

**Risk**: Provider config formats change frequently as agents evolve. A Cursor update could change its MCP config schema.

**Mitigation**: The `registry.json` is human-editable and can be updated independently of code releases. Per-agent transforms are isolated in `src/core/mcp/transforms.ts` making updates surgical.

### 12.2 Marketplace Dependency

**Risk**: agentskills.in or skills.sh could change their APIs, go offline, or become unmaintained.

**Mitigation**: The adapter pattern (`MarketplaceAdapter` interface) isolates marketplace dependencies. Each adapter catches errors independently -- one marketplace going down does not affect the other. New adapters can be added without modifying existing code.

### 12.3 Provider Churn

**Risk**: The 28-agent landscape is volatile. Agents may merge, rebrand, shut down, or new ones may appear rapidly.

**Mitigation**: The single `registry.json` data model makes it trivial to add, update, or deprecate providers. The `status` field supports `active`, `beta`, `deprecated`, and `planned` states for lifecycle management.

### 12.4 Windows Symlink Limitations

**Risk**: Windows has historically restrictive symlink support. The canonical+symlink skill installation model may fail.

**Mitigation**: The installer already includes a fallback chain: symlink -> junction -> copy. This is implemented in `src/core/skills/installer.ts:82-87`.

### 12.5 Config File Corruption

**Risk**: Writing to agent config files could corrupt them, especially JSONC files with comments.

**Mitigation**: Comment-preserving writes via `jsonc-parser` for JSONC files. All config writes use the format-appropriate library (js-yaml for YAML, @iarna/toml for TOML) rather than string manipulation.

### 12.6 Security of Community Skills

**Risk**: Malicious skills could contain prompt injection, command injection, or data exfiltration instructions.

**Mitigation**: The 46-rule audit scanner covers 8 threat categories including prompt injection (8 rules), command injection (8 rules), data exfiltration (6 rules), privilege escalation (4 rules), and more. SARIF output enables CI/CD integration. The audit command runs before installation when requested.

### 12.7 Scaling Beyond 28 Providers

**Risk**: As the provider count grows, the single `registry.json` file could become unwieldy.

**Mitigation**: At the current scale (28 providers, ~720 lines), the file is manageable. If it reaches 50+, a plugin system (P3 roadmap) would allow external provider definitions. The query functions already abstract over the data source.

---

## 13. Appendices

### Appendix A: Provider Registry Schema

The `Provider` type (`src/types.ts:31-59`) defines the schema for each registry entry:

```typescript
interface Provider {
  id: string;                          // Unique identifier (e.g., "claude-code")
  toolName: string;                    // Human-readable name (e.g., "Claude Code")
  vendor: string;                      // Company name (e.g., "Anthropic")
  agentFlag: string;                   // CLI flag value (e.g., "claude-code")
  aliases: string[];                   // Alternate names (e.g., ["claude"])

  pathGlobal: string;                  // Global config directory
  pathProject: string;                 // Project-level config directory

  instructFile: string;                // Instruction file name (CLAUDE.md, AGENTS.md, GEMINI.md)

  configKey: string;                   // MCP config key in config file
  configFormat: ConfigFormat;          // json | jsonc | yaml | toml
  configPathGlobal: string;            // Global config file path
  configPathProject: string | null;    // Project config file path (null if unsupported)

  pathSkills: string;                  // Global skills directory
  pathProjectSkills: string;           // Project skills directory

  detection: DetectionConfig;          // How to detect if installed
  supportedTransports: TransportType[];// stdio | sse | http
  supportsHeaders: boolean;            // Whether HTTP headers are supported

  priority: ProviderPriority;          // high | medium | low
  status: ProviderStatus;              // active | beta | deprecated | planned
  agentSkillsCompatible: boolean;      // Whether agent supports SKILL.md
}
```

### Appendix B: Config Key Mapping

| Config Key | Format | Providers |
|-----------|--------|-----------|
| `mcpServers` | JSON | claude-code, cursor, windsurf, gemini-cli, github-copilot, cline, kimi, claude-desktop, roo, continue, antigravity, kiro-cli, amp, trae, aide, pear-ai, void-ai, cody, kilo-code, qwen-code, openhands, codebuddy, codestory |
| `mcp_servers` | TOML | codex |
| `extensions` | YAML | goose |
| `mcp` | JSON | opencode |
| `servers` | JSON | vscode |
| `context_servers` | JSONC | zed |

### Appendix C: Instruction File Mapping

| Instruction File | Providers |
|-----------------|-----------|
| `CLAUDE.md` | claude-code, claude-desktop |
| `GEMINI.md` | gemini-cli |
| `AGENTS.md` | cursor, windsurf, codex, github-copilot, opencode, cline, kimi, vscode, zed, roo, continue, goose, antigravity, kiro-cli, amp, trae, aide, pear-ai, void-ai, cody, kilo-code, qwen-code, openhands, codebuddy, codestory |

### Appendix D: CLI Command Reference

```
caamp <command> [options]

Global Flags:
  -a, --agent <name>    Target specific agent(s), repeatable
  -g, --global          Use global scope (default: project)
  -y, --yes             Skip confirmation prompts
  --all                 Target all detected agents
  --json                JSON output
  --dry-run             Preview without writing

Commands (21):

  providers list [--tier <tier>] [--json]
  providers detect [--project] [--json]
  providers show <id> [--json]

  skills install <source> [-a <agent>...] [-g] [--all] [-y] [--dry-run]
  skills remove [name] [-a <agent>...] [-g] [--all] [-y]
  skills list [-g] [--json]
  skills find [query] [--json]
  skills init [name]
  skills validate [path]
  skills audit [path] [--sarif] [--json]
  skills check [--json]
  skills update [name] [-y]

  mcp install <source> [-a <agent>...] [-g] [--all] [-y] [--dry-run]
  mcp remove <name> [-a <agent>...] [-g] [--all] [-y]
  mcp list [-a <agent>] [-g] [--json]
  mcp detect [--json]

  instructions inject [-a <agent>...] [--all] [-g]
  instructions check [-a <agent>...] [--all] [-g] [--json]
  instructions update [-a <agent>...] [--all] [-g]

  config show <provider> [--json]
  config path <provider>
```

### Appendix E: Audit Rule Categories

| Category | Rule IDs | Count | Description |
|----------|---------|-------|-------------|
| Prompt Injection | PI001-PI008 | 8 | System override, role manipulation, jailbreak, hidden instructions |
| Command Injection | CI001-CI008 | 8 | Destructive commands, RCE, eval, shell spawn, sudo |
| Data Exfiltration | DE001-DE006 | 6 | Credential theft, API keys, data upload, browser data |
| Privilege Escalation | PE001-PE004 | 4 | Dangerous chmod, SUID, Docker escape, kernel modules |
| Filesystem Abuse | FS001-FS004 | 4 | System writes, hidden files, symlink attacks |
| Network Abuse | NA001-NA004 | 4 | DNS exfil, reverse shells, port scanning, tunnels |
| Obfuscation | OB001-OB003 | 3 | Hex encoding, string concatenation, Unicode escape |
| Supply Chain | SC001-SC004 | 4 | Runtime installs, typosquatting, postinstall, registry override |
| Info Disclosure | ID001-ID003 | 3 | Process listing, system info, network enumeration |
| **Total** | | **44** | |

### Appendix F: Source Type Classification

| Input Pattern | Classified As | Example |
|--------------|--------------|---------|
| `https://github.com/owner/repo` | `github` | `https://github.com/anthropics/claude-code-skill` |
| `owner/repo` | `github` (shorthand) | `anthropics/claude-code-skill` |
| `https://gitlab.com/owner/repo` | `gitlab` | `https://gitlab.com/org/mcp-server` |
| `https://any-other-url.com/...` | `remote` | `https://mcp.neon.tech/sse` |
| `@scope/package` | `package` | `@anthropic/mcp-server-memory` |
| `package-name` | `package` | `mcp-server-fetch` |
| `./path` or `/path` or `~/path` | `local` | `./my-skill` |
| Anything with spaces | `command` | `npx -y @anthropic/mcp-server-memory` |
