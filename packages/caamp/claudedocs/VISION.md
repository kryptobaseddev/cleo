# CAAMP - Vision and Architecture

## Document Information

| Field | Value |
|-------|-------|
| **Version** | 1.0.0 |
| **Date** | 2026-02-11 |
| **Status** | Published |
| **Package** | @cleocode/caamp v0.1.0 |
| **License** | MIT |

---

## 1. The Problem

### 1.1 The Fragmented AI Agent Landscape

The AI coding assistant market has gone from a handful of tools to an explosion of 28+ competing agents in under two years. Claude Code, Cursor, Windsurf, Codex CLI, Gemini CLI, GitHub Copilot, Cline, Kimi, VS Code Copilot, Zed, Roo Code, Continue, Goose, Amp, Trae, OpenHands, and a dozen more -- each built by a different vendor (Anthropic, Anysphere, Codeium, OpenAI, Google, GitHub, Microsoft, Block, ByteDance, Amazon, Alibaba, Sourcegraph, and others), each with its own opinions about how configuration should work.

The result is a configuration landscape that is fractured along every axis:

**Config file formats.** Some agents use JSON. Others use JSONC (JSON with comments). Codex uses TOML. Goose uses YAML. A tool that writes MCP server configs has to handle all four formats correctly, which means four parsers, four writers, and four sets of edge cases.

**Config file locations.** Every agent puts its config in a different place. Claude Code uses `~/.claude.json` globally and `.mcp.json` per-project. Cursor uses `~/.cursor/mcp.json`. Windsurf uses `~/.codeium/windsurf/mcp_config.json`. Gemini uses `~/.gemini/settings.json`. VS Code uses `$VSCODE_CONFIG/mcp.json`. Zed uses `$ZED_CONFIG/settings.json`. Codex uses `~/.codex/config.toml`. There is no standard, and these paths differ across operating systems.

**Config key names.** The JSON key under which MCP servers are registered varies by agent:

| Config Key | Agents |
|------------|--------|
| `mcpServers` | Claude Code, Cursor, Windsurf, Gemini CLI, GitHub Copilot, Cline, Kimi, and 12 others |
| `mcp_servers` | Codex |
| `extensions` | Goose |
| `mcp` | OpenCode |
| `servers` | VS Code |
| `context_servers` | Zed |

Six different key names for the same concept. A human managing MCP servers across three agents has to remember three different keys, three different file paths, and potentially three different file formats.

**Config shape differences.** Even among agents that share the same key name, the shape of the config object varies. Goose wraps server definitions in an `extensions` array with `name`, `type`, `cmd`, `args`, `envs`, and `enabled` fields. Zed uses `source`, `command`, and wraps remote servers differently from stdio servers. OpenCode distinguishes `local` from `remote` with different field names. Cursor strips the `type` field for remote servers. These are not superficial differences; they require per-agent transform logic.

**Instruction file names.** AI agents read project-level instructions from markdown files, but they cannot agree on the filename:

- `CLAUDE.md` -- Claude Code and Claude Desktop
- `GEMINI.md` -- Gemini CLI
- `AGENTS.md` -- Everything else (Cursor, Windsurf, Codex, Cline, Kimi, VS Code, Zed, GitHub Copilot, Kiro, Amp, Trae, Roo, Continue, Goose, OpenCode, and all others)

A team that uses Claude Code and Cursor must maintain both `CLAUDE.md` and `AGENTS.md` with overlapping content. Add Gemini CLI and it becomes three files. The content drifts. The instructions diverge. Nobody notices until something breaks.

**Skills directory structure.** Skills (reusable agent prompt files) get installed to per-agent directories. Claude Code uses `~/.claude/skills/`. Cursor uses `~/.cursor/skills/`. Every agent has its own location. Installing a skill to three agents means copying it to three places and keeping them in sync.

### 1.2 The Skills Ecosystem Problem

Skills are emerging as the primary extensibility mechanism for AI coding agents. A skill is a markdown file (typically `SKILL.md`) containing structured instructions, metadata, allowed tools, and behavioral directives that an agent loads to gain new capabilities.

The ecosystem is already fragmented:

- **agentskills.in** indexes 175,000+ skills from GitHub repositories. It is the largest directory, but it is one marketplace with one API.
- **skills.sh** is another marketplace with a different API, different schema, and different search behavior.
- **prompts.chat** offers skills through an MCP server interface.
- **GitHub repositories** are the actual storage for all of them. The marketplaces are indexes, not hosts.
- **No unified install path.** There is no `npm install` equivalent for skills. Each marketplace has its own CLI or none at all. Installing a skill from agentskills.in to three different agents requires manual copying.

The security dimension is also unaddressed. Skills are executable instructions -- they tell an AI agent what tools to call, what files to read, what commands to run. A malicious skill could instruct an agent to exfiltrate credentials, install backdoors, or destroy files. There is no standard security scanning, no audit trail, no trust model.

### 1.3 The MCP Server Problem

The Model Context Protocol (MCP) is becoming the standard plugin system for AI agents. MCP servers expose tools, resources, and prompts that agents can use. The protocol itself is well-specified. The installation experience is not.

Installing an MCP server to a single agent requires:

1. Identifying the agent's config file path
2. Knowing the correct config key name for that agent
3. Knowing the correct file format (JSON, JSONC, YAML, or TOML)
4. Knowing whether the agent needs a config transform (5 agents do)
5. Writing the config entry without corrupting comments or formatting
6. Having no way to track what was installed or roll it back

Installing the same MCP server to three agents requires doing this three times with three different paths, potentially three different formats, and three different config shapes. There is no lock file. There is no `--dry-run`. There is no audit log.

### 1.4 The Configuration Management Problem

Teams that use multiple AI agents face a combinatorial configuration problem:

- **N instruction files** to maintain with overlapping content across CLAUDE.md, AGENTS.md, and GEMINI.md
- **N MCP configs** to keep synchronized across agents with different formats and locations
- **N skills directories** to keep in sync, one per agent
- **No lock file** for reproducibility -- onboarding a new team member means manually replicating the setup
- **No audit capability** -- no way to answer "what MCP servers are installed across all my agents?"
- **No update mechanism** -- checking if a skill has a new version requires manual inspection

This is the configuration management equivalent of the dependency management problem that npm, pip, and cargo solved for their respective ecosystems. But for AI agents, there is nothing.

### 1.5 The Origin Story

CAAMP was born from direct, painful experience with this problem.

CLEO, a task management system for AI agents, needed to manage provider configurations for skills installation, MCP server setup, and instruction file injection. Over time, it accumulated three separate registries:

1. **templates/agent-registry.json** -- 16 providers with skills paths and instruction file names
2. **lib/mcp-config.sh** -- 12 MCP tool keys with config paths and formats, implemented as Bash `case` statements
3. **lib/injection-registry.sh** -- 5 injection targets including instruction file mappings

These registries diverged. The agent registry knew about 16 providers. The MCP config knew about 12, but a different 12. The injection registry was the worst: it was creating `CODEX.md` and `KIMI.md` files that should not exist -- those agents read `AGENTS.md`, not custom files. Nobody caught the error because no single source of truth existed.

The fix was not to reconcile three registries. The fix was to replace all three with one: a single, typed, queryable registry that every operation routes through. That registry became CAAMP.

---

## 2. The Vision

### 2.1 CAAMP = "npm for AI agents"

One command to install a skill or MCP server across every AI coding agent on your machine. One registry that knows every agent's config format, file path, key name, and transform requirements. One lock file that tracks everything you have installed and where.

```bash
# Install an MCP server to all detected agents
caamp mcp install https://mcp.example.com/api --all

# Install a skill from GitHub to Claude Code and Cursor
caamp skills install owner/repo --agent claude-code --agent cursor

# Check what's installed across all agents
caamp mcp list --all

# Inject project instructions into all instruction files
caamp instructions inject
```

CAAMP is not another AI agent. It is the infrastructure layer underneath all of them. It does not compete with Claude Code or Cursor or Gemini CLI. It makes all of them easier to configure, maintain, and keep in sync.

### 2.2 Core Tenets

**Universal.** CAAMP ships with 28 provider definitions from 26 vendors on day one. The registry is a data file, not code. Adding provider #29 means adding a JSON object, not writing a new module. The architecture is designed to scale to 50+ providers without architectural changes.

**Unified.** One `registry.json` file is the single source of truth. Every provider query, every detection scan, every config write, every instruction injection routes through this registry. There are no parallel data structures that can diverge.

**Safe.** Config writes preserve JSONC comments using `jsonc-parser`'s surgical edit operations. Lock files track every installation for auditability and rollback. Security scanning with 44 rules across 8 categories catches malicious skills before they execute. `--dry-run` previews every mutation. Nothing is silently overwritten.

**Agent-First by Default (LAFS).** CAAMP adopts the external LAFS protocol and keeps implementation mapping in `docs/LAFS-COMPLIANCE.md`.

**Portable.** TypeScript, compiled with `tsup`, distributed via npm as `@cleocode/caamp`. Works on macOS, Linux, and Windows. Zero native dependencies. 57 library exports for programmatic integration.

**Simple.** The common case should be one command. `caamp skills install owner/repo` handles source parsing, GitHub fetching, SKILL.md discovery, validation, canonical storage, symlink creation across agents, and lock file update -- all in one invocation.

### 2.3 The "Install Once, Link Everywhere" Model

CAAMP uses a canonical + symlink architecture for skills:

```
~/.agents/skills/my-skill/         <-- Canonical copy (one source of truth)
    SKILL.md
    resources/

~/.claude/skills/my-skill -> ~/.agents/skills/my-skill   (symlink)
~/.cursor/skills/my-skill -> ~/.agents/skills/my-skill    (symlink)
~/.gemini/skills/my-skill -> ~/.agents/skills/my-skill    (symlink)
```

Skills are fetched once and stored in a canonical location (`~/.agents/skills/`). Each target agent gets a symlink. Update the canonical copy and every agent sees the change immediately. Remove a skill and all symlinks are cleaned up atomically.

On Windows, where symlinks require elevated privileges, CAAMP falls back to junction points. If junctions are unavailable, it falls back to full copies with a warning.

This model eliminates duplication, prevents drift, and makes updates trivial.

---

## 3. Design Philosophy

### 3.1 Single Source of Truth

Everything CAAMP knows about AI agents lives in one file: `providers/registry.json`. It is 720 lines of human-readable JSON containing 28 provider definitions. Each definition includes the provider's ID, tool name, vendor, aliases, config format, config key, global and project paths, instruction file name, detection methods, supported transports, and status.

Every CAAMP operation reads from this registry:

- `caamp providers list` -- iterates the registry
- `caamp providers detect` -- uses `detection` fields from the registry
- `caamp mcp install` -- reads `configKey`, `configFormat`, `configPathGlobal`, `configPathProject` from the registry
- `caamp skills install` -- reads `pathSkills`, `pathProjectSkills` from the registry
- `caamp instructions inject` -- reads `instructFile` from the registry

There is no second source. There is no Bash case statement. There is no hardcoded path. If the registry says Claude Code uses `mcpServers` as its config key and `.mcp.json` as its project config path, that is what CAAMP uses. Change the registry and the behavior changes.

### 3.2 Convention over Configuration

CAAMP detects installed agents automatically. It resolves config paths by expanding environment variables. It infers skill names from GitHub URLs. It selects the right config format based on the provider definition. Zero setup is required for the common case.

```bash
# Auto-detect which agents are installed, install to all of them
caamp mcp install @anthropic/mcp-server-filesystem --all

# CAAMP figures out:
# - Which agents are installed (binary check, directory check, app bundle check)
# - Where each agent's config file lives
# - What format each config file uses
# - What config key each agent expects
# - Whether a transform is needed
```

### 3.3 Progressive Disclosure

Simple commands for simple tasks. Advanced flags for power users.

```bash
# Simple: install to all detected agents
caamp mcp install https://mcp.example.com --all

# Targeted: install to specific agents
caamp mcp install https://mcp.example.com -a claude-code -a cursor

# Controlled: preview without writing
caamp mcp install https://mcp.example.com --all --dry-run

# Scriptable: JSON output for automation
caamp providers detect --json
```

### 3.4 Non-Destructive Operations

CAAMP treats user config files as sacred. They may contain hand-written comments, custom formatting, and careful organization that must be preserved.

- **JSONC comment preservation.** Config writes use `jsonc-parser.modify()` for surgical edits. If a user's `.mcp.json` has comments explaining each MCP server, those comments survive CAAMP's writes intact.
- **Indentation detection.** Before writing, CAAMP detects the existing file's indentation style (tabs vs. spaces, indentation width) and matches it.
- **Lock files.** Every installation is recorded in `~/.agents/.caamp-lock.json` with the source, installed date, target agents, and canonical path. This enables auditing, rollback, and reproducibility.
- **Dry-run support.** The `--dry-run` flag previews every mutation without writing to disk.

### 3.5 Extensible by Design

The provider registry is data, not code. Adding a new AI agent to CAAMP requires adding a JSON object to `registry.json` -- no TypeScript, no compilation, no new module.

The marketplace client uses the adapter pattern. Two adapters ship today (`SkillsMPAdapter` for agentskills.in, `SkillsShAdapter` for skills.sh). Adding a third marketplace means implementing the `MarketplaceAdapter` interface: `search()` and `getSkill()`.

The source parser classifies inputs into six types (GitHub URL, GitLab URL, remote URL, npm package, local path, shell command) and routes each to the appropriate handler. Adding a new source type means adding a regex and a handler.

The transform system handles agents with non-standard config shapes. Five transforms ship today (Goose, Zed, OpenCode, Codex, Cursor). Adding a transform for a new agent means writing a function that maps `McpServerConfig` to the agent's expected shape and registering it in a switch statement.

---

## 4. Architecture Overview

### 4.1 System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          CLI Layer                              │
│                                                                 │
│   providers        skills         mcp        instructions       │
│   list|detect      install|remove install    inject|check       │
│   show             list|find      remove     update             │
│                    check|init     list                          │
│                    validate|audit detect                        │
│                                                                 │
│   config                                                        │
│   show|path                                                     │
├─────────────────────────────────────────────────────────────────┤
│                         Core Layer                              │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │ registry │  │  skills   │  │   mcp    │  │ instructions │   │
│  │          │  │          │  │          │  │              │   │
│  │providers │  │installer │  │installer │  │  injector    │   │
│  │detection │  │discovery │  │transforms│  │  templates   │   │
│  │  types   │  │validator │  │  reader  │  │              │   │
│  │          │  │  lock    │  │   lock   │  │              │   │
│  │          │  │audit/    │  │          │  │              │   │
│  │          │  │ scanner  │  │          │  │              │   │
│  │          │  │ rules    │  │          │  │              │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────┘   │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                     │
│  │ formats  │  │ sources  │  │market-   │                     │
│  │          │  │          │  │place     │                     │
│  │  json    │  │ parser   │  │          │                     │
│  │  yaml    │  │ github   │  │ client   │                     │
│  │  toml    │  │ gitlab   │  │ skillsmp │                     │
│  │  utils   │  │ wellknown│  │ skillssh │                     │
│  │  index   │  │          │  │          │                     │
│  └──────────┘  └──────────┘  └──────────┘                     │
├─────────────────────────────────────────────────────────────────┤
│                         Data Layer                              │
│                                                                 │
│  providers/registry.json        ~/.agents/.caamp-lock.json      │
│  (28 provider definitions)      (installation tracking)         │
│                                                                 │
│  Agent config files             Agent skills directories        │
│  (JSON/JSONC/YAML/TOML)         (symlinks to canonical)         │
│                                                                 │
│  Instruction files              Canonical skills store          │
│  (CLAUDE.md/AGENTS.md/          (~/.agents/skills/)             │
│   GEMINI.md)                                                    │
└─────────────────────────────────────────────────────────────────┘
```

The architecture follows a strict three-layer separation:

- **CLI Layer**: Commander.js command definitions. Parses arguments, calls core functions, formats output. No business logic.
- **Core Layer**: 7 modules implementing all business logic. Each module owns its domain and exposes typed functions.
- **Data Layer**: Registry file, lock files, agent config files, skill files. All state lives here.

### 4.2 Data Flow: Skill Installation

```
User input                 Source Parser            GitHub Fetcher
"owner/repo"  ──────────>  parseSource()  ────────> fetchFromGitHub()
                           type: "github"           Downloads repo contents
                           owner: "owner"           to temp directory
                           repo: "repo"

                           Discovery                Validator
Temp directory  ────────>  discoverSkill()  ──────> validateSkill()
                           Finds SKILL.md           Checks frontmatter,
                           Parses metadata           required fields,
                                                    structure

                           Audit Scanner            Canonical Installer
SKILL.md        ────────>  scanFile()     ────────> installToCanonical()
                           44 security rules        ~/.agents/skills/<name>/
                           SARIF output
                           Score 0-100

                           Symlink Creator          Lock File
Canonical path  ────────>  linkToAgent()  ────────> recordSkillInstall()
                           For each target agent:   Appends to
                           Create symlink from       .caamp-lock.json
                           agent skills dir to
                           canonical path
```

Key properties of this flow:

- **Source-agnostic.** The source parser normalizes GitHub URLs, GitHub shorthand (`owner/repo`), npm packages, GitLab URLs, local paths, and raw commands into a unified `ParsedSource` type. Downstream code does not care where the skill came from.
- **Security-first.** The audit scanner runs 44 rules across 8 categories (prompt injection, command injection, data exfiltration, privilege escalation, filesystem abuse, network abuse, obfuscation, supply chain) before installation proceeds.
- **Atomic linking.** If symlink creation fails (e.g., permissions), CAAMP falls back to junction points, then to full copies. The canonical source remains intact regardless.

### 4.3 Data Flow: MCP Server Installation

```
User input                    Source Parser
"https://mcp.ex.com/api" --> parseSource()
                              type: "remote"
                              inferredName: "ex"

                              Config Builder
Server name + config -------> buildServerConfig()
                              Canonical McpServerConfig:
                              { type: "sse", url: "..." }

For each target agent:

Provider lookup               Transform Check
getProvider("cursor") ------> getTransform("cursor")
configKey: "mcpServers"       Returns transformCursor()
configFormat: "json"
configPath: ".cursor/mcp.json"

                              Config Writer
Transformed config ---------> writeConfig()
                              Routes to format handler:
                              json.ts / yaml.ts / toml.ts

                              Format Handler
writeJsonConfig() ----------> jsonc.modify()
                              Surgical edit preserving
                              comments and formatting

                              Lock File
Success ------------------->  recordMcpInstall()
                              Tracks: name, source,
                              agents, date, scope
```

Key properties:

- **Transform pipeline.** Five agents need custom config shapes. The transform system maps the canonical `McpServerConfig` to each agent's expected format. The remaining 23 agents use the canonical format directly.
- **Comment preservation.** JSONC files are edited with `jsonc-parser.modify()`, which produces surgical text edits rather than parse-serialize round-trips. User comments, trailing commas, and formatting are preserved.
- **Format routing.** The format router dispatches to `json.ts`, `yaml.ts`, or `toml.ts` based on the provider's `configFormat` field. Each handler knows how to read, write, and remove entries in its format.

### 4.4 Provider Model

The provider model is the foundation of CAAMP. Each provider definition in `registry.json` encodes everything CAAMP needs to interact with that agent:

```json
{
  "id": "cursor",
  "toolName": "Cursor",
  "vendor": "Anysphere",
  "agentFlag": "cursor",
  "aliases": [],
  "pathGlobal": "$HOME/.cursor",
  "pathProject": ".cursor",
  "instructFile": "AGENTS.md",
  "configKey": "mcpServers",
  "configFormat": "json",
  "configPathGlobal": "$HOME/.cursor/mcp.json",
  "configPathProject": ".cursor/mcp.json",
  "pathSkills": "$HOME/.cursor/skills",
  "pathProjectSkills": ".cursor/skills",
  "detection": {
    "methods": ["binary", "directory"],
    "binary": "cursor",
    "directories": ["$HOME/.cursor"]
  },
  "supportedTransports": ["stdio", "sse", "http"],
  "supportsHeaders": true,
  "priority": "high",
  "status": "active",
  "agentSkillsCompatible": true
}
```

The `Provider` type in TypeScript provides compile-time guarantees. Registry queries (`getProvider`, `resolveAlias`, `getProvidersByPriority`, `getProvidersByStatus`, `getProvidersByInstructFile`, `getInstructionFiles`) return typed results. The detection engine uses the `detection` field to check for installed binaries, directories, app bundles, and Flatpak packages.

Provider status tracks lifecycle: `active` (fully supported), `beta` (experimental), `deprecated` (being phased out), `planned` (not yet supported). Priority (`high`, `medium`, `low`) determines default ordering when multiple agents are detected.

### 4.5 Format Handling

CAAMP handles four config file formats through a unified format router:

```
readConfig(path, format)  ──────>  json.ts / yaml.ts / toml.ts
writeConfig(path, key, name, val) -> json.ts / yaml.ts / toml.ts
removeConfig(path, key, name)    -> json.ts / yaml.ts / toml.ts
```

Each format handler implements three operations:

| Operation | JSON/JSONC | YAML | TOML |
|-----------|-----------|------|------|
| **Read** | `jsonc-parser.parse()` | `js-yaml.load()` | `@iarna/toml.parse()` |
| **Write** | `jsonc-parser.modify()` (surgical) | `js-yaml.dump()` | `@iarna/toml.stringify()` |
| **Remove** | `jsonc-parser.modify(undefined)` | Delete key + dump | Delete key + stringify |

The JSON handler deserves special attention. Unlike YAML and TOML, JSON config files frequently contain comments (JSONC). The `jsonc-parser` library provides `modify()`, which computes text edits rather than round-tripping through parse and serialize. This means:

- Comments are preserved verbatim
- Formatting matches the existing file
- Trailing commas are maintained
- Indentation style is detected and matched

### 4.6 Canonical + Symlink Model (Detailed)

```
                    CANONICAL STORE
                    ~/.agents/skills/
                    ├── my-skill/
                    │   ├── SKILL.md
                    │   └── resources/
                    └── other-skill/
                        └── SKILL.md

        ┌───────────────────┼───────────────────┐
        │ SYMLINK           │ SYMLINK            │ SYMLINK
        ▼                   ▼                    ▼

~/.claude/skills/       ~/.cursor/skills/    ~/.gemini/skills/
├── my-skill -> ...     ├── my-skill -> ...  ├── my-skill -> ...
└── other-skill -> ...  └── other-skill ->.. └── other-skill ->..


Project-level (optional):
.claude/skills/my-skill -> ~/.agents/skills/my-skill
.cursor/skills/my-skill -> ~/.agents/skills/my-skill
```

**Install flow:**
1. Fetch skill source to temp directory
2. Copy to `~/.agents/skills/<name>/` (canonical)
3. For each target agent, create symlink from agent's skills directory to canonical path
4. Record in lock file

**Update flow:**
1. Fetch new version to temp directory
2. Replace canonical copy (rm + cp)
3. All symlinks automatically point to updated content
4. Update lock file timestamp

**Remove flow:**
1. Remove symlinks from all agent skills directories
2. Remove canonical copy
3. Remove from lock file

**Fallback chain:**
1. Symbolic link (preferred -- all platforms except Windows without developer mode)
2. Junction point (Windows -- does not require admin)
3. Full copy (last resort -- with warning about drift)

---

## 5. Ecosystem Map

### 5.1 Where CAAMP Sits

```
┌─────────────────────────────────────────────────────────────────┐
│                      AI Agent Ecosystem                         │
│                                                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│  │ Claude   │ │ Cursor   │ │ Windsurf │ │ Codex    │  ...28   │
│  │ Code     │ │          │ │          │ │ CLI      │  total   │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘          │
│       │             │            │             │                │
│       └─────────────┼────────────┼─────────────┘                │
│                     │            │                              │
│                     ▼            ▼                              │
│              ┌──────────────────────────┐                       │
│              │         CAAMP            │                       │
│              │                          │                       │
│              │  Registry  Skills  MCP   │                       │
│              │  Formats   Sources Lock  │                       │
│              │  Instructions  Audit     │                       │
│              └─────────┬────────────────┘                       │
│                        │                                        │
│            ┌───────────┼───────────┐                            │
│            │           │           │                            │
│            ▼           ▼           ▼                            │
│     ┌──────────┐ ┌──────────┐ ┌──────────┐                    │
│     │agentskills│ │skills.sh │ │  GitHub  │                    │
│     │.in        │ │          │ │  Repos   │                    │
│     │175K+skills│ │          │ │          │                    │
│     └──────────┘ └──────────┘ └──────────┘                    │
└─────────────────────────────────────────────────────────────────┘
```

CAAMP occupies the infrastructure layer between AI agents (above) and the skills/MCP ecosystem (below). It is not an agent. It is not a marketplace. It is the plumbing that connects them.

### 5.2 Relationship to CLEO

CLEO is a task management system for AI agents. CAAMP replaces CLEO's fragmented provider management:

| CLEO Component | Problem | CAAMP Replacement |
|----------------|---------|-------------------|
| `templates/agent-registry.json` | 16 providers, no MCP config info | `providers/registry.json` with 28 providers and full config data |
| `lib/mcp-config.sh` | 12 providers in Bash case statements | `core/mcp/` module with typed installer and transforms |
| `lib/injection-registry.sh` | Wrong files (CODEX.md, KIMI.md) | `core/instructions/` with correct 3-file mapping |

CAAMP is published as a standalone npm package (`@cleocode/caamp`) that CLEO depends on. CLEO no longer maintains its own provider data. It imports CAAMP's registry and uses CAAMP's APIs.

### 5.3 Relationship to Marketplaces

CAAMP treats marketplaces as **optional search backends**, not dependencies. The `MarketplaceClient` queries agentskills.in and skills.sh in parallel, deduplicates results by scoped name, and sorts by relevance. If both marketplaces are down, `caamp skills install owner/repo` still works -- it goes directly to GitHub.

The adapter pattern means new marketplaces can be added without modifying existing code. The `MarketplaceAdapter` interface requires two methods: `search(query, limit)` and `getSkill(scopedName)`.

### 5.4 Relationship to Providers

CAAMP is a consumer of provider configurations, not a competitor. It does not run AI models. It does not provide coding assistance. It manages the configuration files that agents read.

The relationship is parasitic in the best sense: CAAMP adds value on top of agents without requiring any cooperation from them. It reads their publicly documented config file formats and writes valid entries. If an agent changes its config format, CAAMP's registry is updated and all users get the fix.

---

## 6. Future Vision

### 6.1 Short-term (v0.2.0)

**Expand provider coverage.** The AI agent market adds new tools monthly. Target: 40+ providers with complete definitions.

**`caamp doctor` command.** Diagnostic tool that checks:
- Which agents are installed but misconfigured
- Which config files have syntax errors
- Which skills have failed symlinks
- Which lock file entries reference missing files
- Version compatibility between CAAMP and agent configs

**Well-known skills discovery.** RFC 8615-inspired `.well-known/skills/` endpoint for repositories and organizations. Allow `caamp skills install https://example.com` to discover skills via well-known URLs.

**Enhanced error messages.** Contextual suggestions when operations fail. If a config write fails because the directory does not exist, suggest creating it. If a skill audit fails, explain which rules triggered and how to fix.

### 6.2 Medium-term (v0.3.0)

**Plugin system for custom providers.** Allow teams to define custom provider definitions without forking the registry. Load from `~/.caamp/providers.d/*.json` or `$PROJECT/.caamp/providers.json`.

**CI/CD integration.** GitHub Action that runs `caamp skills audit` on pull requests. SARIF output already works -- the Action would upload results to GitHub's code scanning.

**Team config sharing.** A `caamp.config.json` project file that declares required skills, MCP servers, and instruction injections. `caamp init` reads it and configures all detected agents. Like `package.json` but for AI agent configuration.

**Config templates.** Predefined configurations for common setups. `caamp template apply fullstack` installs a curated set of skills and MCP servers for full-stack development.

### 6.3 Long-term (v1.0.0+)

**Stable API with semver guarantees.** The 57 library exports become a stable contract. Breaking changes require major version bumps. Downstream tools (like CLEO) can depend on CAAMP with confidence.

**Community provider contributions.** Open the registry to pull requests with automated validation. A provider definition must include detection methods that can be tested, config paths that can be verified, and a maintainer who responds to format changes.

**Standard for AI agent configuration.** Propose a cross-vendor standard for MCP server configuration -- a single file format and location that all agents can read. CAAMP would be the reference implementation. The fragmentation described in Section 1 is an industry problem, not just a tooling problem.

**`.well-known/skills/` standard adoption.** Push for formal adoption of the well-known skills discovery endpoint. If repositories advertise their skills at a predictable URL, any tool (not just CAAMP) can discover and install them.

---

## 7. Key Differentiators

### 7.1 Feature Comparison

| Capability | CAAMP | Vercel Skills | agent-skills-cli | Neon add-mcp |
|------------|-------|---------------|-------------------|--------------|
| Skills installation | Yes (canonical + symlink) | Vercel-specific | agentskills.in only | No |
| Skills removal | Yes (atomic cleanup) | No | No | No |
| Skills security audit | Yes (44 rules, SARIF) | No | No | No |
| Skills validation | Yes (SKILL.md schema) | No | No | No |
| MCP server installation | Yes (multi-agent) | No | No | Single agent |
| MCP server removal | Yes (with lock tracking) | No | No | No |
| MCP config transforms | Yes (5 agents) | No | No | No |
| Instruction file injection | Yes (3-file mapping) | No | No | No |
| Provider auto-detection | Yes (binary, dir, appBundle, flatpak) | No | No | No |
| Multi-agent support | 28 agents | 1 (Vercel) | Claude Code only | Variable |
| Config format support | JSON, JSONC, YAML, TOML | JSON only | JSON only | JSON only |
| Comment preservation | Yes (jsonc-parser) | No | No | No |
| Lock file tracking | Yes | No | No | No |
| Marketplace search | 2 backends (agentskills.in, skills.sh) | No | 1 (agentskills.in) | No |
| Library API | 57 exports | No | No | No |
| Dry-run support | Yes | No | No | No |
| JSON output | Yes | No | No | No |

### 7.2 What Makes CAAMP Unique

CAAMP is the only tool that combines all four pillars of AI agent configuration management:

1. **Skills management** -- Install, remove, validate, audit, update, and discover skills across multiple agents with canonical storage and symlink distribution.

2. **MCP server management** -- Install, remove, list, and detect MCP servers across agents with format-aware config writes, per-agent transforms, and comment-preserving edits.

3. **Instruction file injection** -- Maintain consistent project instructions across CLAUDE.md, AGENTS.md, and GEMINI.md with marker-based injection, status checking, and atomic updates.

4. **Unified provider registry** -- 28 agents from 26 vendors with complete definitions covering config format (4 formats), config key (6 variants), detection method (4 methods), file paths (global + project), transport support, and status tracking.

No other tool addresses more than one of these pillars. No other tool supports more than a handful of agents. No other tool provides a typed library API alongside a CLI.

CAAMP exists because the AI agent ecosystem needs infrastructure. Not another agent. Not another marketplace. Infrastructure -- the boring, essential plumbing that makes everything else work.

---

## Appendices

### A. Provider Registry Summary

**28 providers** from **26 vendors**:

| Priority | Provider | Vendor | Config Format | Config Key |
|----------|----------|--------|---------------|------------|
| High | Claude Code | Anthropic | JSON | `mcpServers` |
| High | Cursor | Anysphere | JSON | `mcpServers` |
| High | Windsurf | Codeium | JSON | `mcpServers` |
| Medium | Codex CLI | OpenAI | TOML | `mcp_servers` |
| Medium | Gemini CLI | Google | JSON | `mcpServers` |
| Medium | GitHub Copilot | GitHub | JSON | `mcpServers` |
| Medium | OpenCode | OpenCode | JSON | `mcp` |
| Medium | Cline | Cline | JSON | `mcpServers` |
| Medium | Kimi | Moonshot AI | JSON | `mcpServers` |
| Medium | VS Code | Microsoft | JSON | `servers` |
| Medium | Zed | Zed Industries | JSONC | `context_servers` |
| Medium | Claude Desktop | Anthropic | JSON | `mcpServers` |
| Low | Roo Code | Roo Code | JSON | `mcpServers` |
| Low | Continue | Continue | JSON | `mcpServers` |
| Low | Goose | Block | YAML | `extensions` |
| Low | Antigravity | Antigravity | JSON | `mcpServers` |
| Low | Kiro | Amazon | JSON | `mcpServers` |
| Low | Amp | Sourcegraph | JSON | `mcpServers` |
| Low | Trae | ByteDance | JSON | `mcpServers` |
| Low | Aide | Aide | JSON | `mcpServers` |
| Low | Pear AI | Pear AI | JSON | `mcpServers` |
| Low | Void AI | Void | JSON | `mcpServers` |
| Low | Cody | Sourcegraph | JSON | `mcpServers` |
| Low | Kilo Code | Kilo Code | JSON | `mcpServers` |
| Low | Qwen Code | Alibaba | JSON | `mcpServers` |
| Low | OpenHands | All Hands AI | JSON | `mcpServers` |
| Low | CodeBuddy | CodeBuddy | JSON | `mcpServers` |
| Low | CodeStory | CodeStory | JSON | `mcpServers` |

### B. Instruction File Mapping

| Instruction File | Agents |
|------------------|--------|
| `CLAUDE.md` | Claude Code, Claude Desktop |
| `GEMINI.md` | Gemini CLI |
| `AGENTS.md` | All other 25 agents |

### C. Security Audit Categories

44 rules across 8 categories:

| Category | Rules | Severity Range | Examples |
|----------|-------|----------------|----------|
| Prompt Injection | 8 | Critical - Medium | System prompt override, role manipulation, jailbreak, encoding bypass |
| Command Injection | 8 | Critical - High | Destructive commands, remote code execution, eval, sudo escalation |
| Data Exfiltration | 6 | Critical - High | Credential access, API key extraction, browser data theft |
| Privilege Escalation | 4 | Critical - High | Dangerous chmod, SUID/SGID, Docker escape, kernel modules |
| Filesystem Abuse | 4 | Critical - Medium | System directory write, hidden files, symlink attacks |
| Network Abuse | 4 | Critical - Medium | DNS exfiltration, reverse shells, port scanning, tunneling |
| Obfuscation | 3 | Medium | Hex encoding, string concatenation, unicode escapes |
| Supply Chain | 4 | High - Low | Runtime package install, typosquatting, registry override |
| Info Disclosure | 3 | Low | Process listing, system info, network enumeration |

### D. Library API Surface

57 exports from `src/index.ts`:

| Module | Functions | Types |
|--------|-----------|-------|
| Registry | `getAllProviders`, `getProvider`, `resolveAlias`, `getProvidersByPriority`, `getProvidersByStatus`, `getProvidersByInstructFile`, `getInstructionFiles`, `getProviderCount`, `getRegistryVersion` | `Provider`, `ConfigFormat`, `TransportType` |
| Detection | `detectProvider`, `detectAllProviders`, `getInstalledProviders`, `detectProjectProviders` | `DetectionResult` |
| Sources | `parseSource`, `isMarketplaceScoped` | `ParsedSource`, `SourceType` |
| Skills | `installSkill`, `removeSkill`, `listCanonicalSkills`, `discoverSkills`, `discoverSkill`, `parseSkillFile`, `validateSkill`, `scanFile`, `scanDirectory`, `toSarif` | `SkillMetadata`, `SkillEntry`, `SkillInstallResult`, `ValidationResult`, `ValidationIssue`, `AuditResult`, `AuditFinding`, `AuditRule`, `AuditSeverity` |
| MCP | `installMcpServer`, `installMcpServerToAll`, `buildServerConfig`, `getTransform`, `resolveConfigPath`, `listMcpServers`, `listAllMcpServers`, `removeMcpServer` | `McpServerConfig`, `McpServerEntry`, `InstallResult` |
| Lock | `readLockFile`, `recordMcpInstall`, `removeMcpFromLock`, `getTrackedMcpServers`, `saveLastSelectedAgents`, `getLastSelectedAgents`, `recordSkillInstall`, `removeSkillFromLock`, `getTrackedSkills`, `checkSkillUpdate` | `LockEntry`, `CaampLockFile` |
| Marketplace | `MarketplaceClient` | `MarketplaceSkill`, `MarketplaceSearchResult` |
| Instructions | `inject`, `checkInjection`, `removeInjection`, `checkAllInjections`, `injectAll`, `generateInjectionContent`, `groupByInstructFile` | `InjectionStatus`, `InjectionCheckResult` |
| Formats | `readConfig`, `writeConfig`, `removeConfig`, `getNestedValue`, `deepMerge`, `ensureDir` | `GlobalOptions` |

### E. Codebase Metrics

| Metric | Value |
|--------|-------|
| Source files | 52 TypeScript files |
| Total lines | ~4,180 lines |
| Test files | 6 test files |
| Core modules | 7 (registry, skills, mcp, instructions, formats, sources, marketplace) |
| Dependencies | 7 runtime (commander, @clack/prompts, picocolors, gray-matter, simple-git, jsonc-parser, js-yaml, @iarna/toml) |
| Dev dependencies | 5 (typescript, tsup, tsx, vitest, @types/node, @types/js-yaml) |
| Build target | ESM-only with declarations |
| Minimum Node.js | 18 |
