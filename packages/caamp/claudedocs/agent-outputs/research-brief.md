# CAAMP Research Brief

**Project**: CAAMP (Central AI Agent Managed Packages)
**Version**: 0.1.0
**Date**: 2026-02-11
**Status**: Complete

---

## 1. Codebase Architecture Summary

### Layer Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                     CLI Layer (cli.ts)                        │
│  Commander.js entry point - 5 command groups, 21 subcommands │
├──────────────────────────────────────────────────────────────┤
│                  Command Handlers (commands/)                 │
│  providers (3) | skills (9) | mcp (4) | instructions (3)     │
│  config (2)                                                  │
├──────────────────────────────────────────────────────────────┤
│                    Core Logic (core/)                         │
│  ┌───────────┐ ┌───────────┐ ┌──────────┐ ┌──────────────┐  │
│  │ registry/  │ │ formats/  │ │  mcp/    │ │   skills/    │  │
│  │ providers  │ │ json/yaml │ │ install  │ │  installer   │  │
│  │ detection  │ │ toml/util │ │ transform│ │  discovery   │  │
│  │ types      │ │ index     │ │ lock     │ │  lock        │  │
│  │            │ │           │ │ reader   │ │  validator   │  │
│  │            │ │           │ │          │ │  audit/      │  │
│  └───────────┘ └───────────┘ └──────────┘ └──────────────┘  │
│  ┌───────────────┐ ┌──────────────┐ ┌────────────────────┐  │
│  │ marketplace/   │ │  sources/    │ │  instructions/     │  │
│  │ client         │ │  parser      │ │  injector          │  │
│  │ skillsmp       │ │  github      │ │  templates         │  │
│  │ skillssh       │ │  gitlab      │ │                    │  │
│  │                │ │  wellknown   │ │                    │  │
│  └───────────────┘ └──────────────┘ └────────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│                    Data Layer                                 │
│  providers/registry.json (28 providers, single source)       │
│  types.ts (15 interfaces, 6 type aliases)                    │
│  index.ts (57 library exports)                               │
└──────────────────────────────────────────────────────────────┘
```

### Codebase Metrics

| Metric | Value |
|--------|-------|
| Total TypeScript files | 52 |
| Total source lines | 4,521 |
| Test files | 6 |
| Test lines | 801 |
| Library exports | 57 |
| CLI commands | 21 |
| Dependencies (runtime) | 7 |
| Dependencies (dev) | 6 |
| Node.js minimum | 18 |
| Module system | ESM-only |
| Build tool | tsup |
| Test runner | vitest |

### Module Map

| Module | Files | Purpose |
|--------|-------|---------|
| `core/registry/` | 3 | Provider registry loading, path resolution, alias mapping |
| `core/formats/` | 5 | JSON/JSONC (comment-preserving), YAML, TOML config R/W |
| `core/mcp/` | 4 | MCP server install, read/list/remove, transforms, lock |
| `core/skills/` | 5 | Canonical+symlink install, discovery, validation, lock |
| `core/skills/audit/` | 2 | 46-rule security scanner with SARIF output |
| `core/marketplace/` | 3 | Adapter pattern client for agentskills.in + skills.sh |
| `core/sources/` | 4 | URL/path classifier, GitHub/GitLab fetcher, RFC 8615 |
| `core/instructions/` | 2 | Marker-based injection into CLAUDE.md/AGENTS.md/GEMINI.md |
| `commands/` | 21 | CLI handlers for all user-facing commands |

### Data Flow: MCP Install

```
User input (URL/package/command)
  → parseSource() classifies SourceType
  → buildServerConfig() creates canonical McpServerConfig
  → getTransform(providerId) applies per-agent config shape
  → writeConfig() writes JSON/JSONC/YAML/TOML preserving comments
  → recordMcpInstall() updates lock file
```

### Data Flow: Skill Install

```
User input (@scope/name or github shorthand)
  → MarketplaceClient.search() queries agentskills.in + skills.sh
  → cloneRepo() shallow-clones GitHub source
  → parseSkillFile() extracts YAML frontmatter
  → validateSkill() validates against Agent Skills spec
  → scanFile() runs 46-rule security audit
  → installToCanonical() copies to ~/.agents/skills/<name>/
  → linkToAgent() creates symlinks for each target provider
  → recordSkillInstall() updates lock file
```

---

## 2. Provider Registry Analysis

### All 28 Providers Cataloged

| # | ID | Tool Name | Vendor | Config Key | Config Format | Instruct File | Priority | Status |
|---|-----|-----------|--------|------------|---------------|---------------|----------|--------|
| 1 | claude-code | Claude Code | Anthropic | mcpServers | json | CLAUDE.md | high | active |
| 2 | cursor | Cursor | Anysphere | mcpServers | json | AGENTS.md | high | active |
| 3 | windsurf | Windsurf | Codeium | mcpServers | json | AGENTS.md | high | active |
| 4 | codex | Codex CLI | OpenAI | mcp_servers | toml | AGENTS.md | medium | active |
| 5 | gemini-cli | Gemini CLI | Google | mcpServers | json | GEMINI.md | medium | active |
| 6 | github-copilot | GitHub Copilot | GitHub | mcpServers | json | AGENTS.md | medium | active |
| 7 | opencode | OpenCode | OpenCode | mcp | json | AGENTS.md | medium | active |
| 8 | cline | Cline | Cline | mcpServers | json | AGENTS.md | medium | active |
| 9 | kimi | Kimi Coding | Moonshot AI | mcpServers | json | AGENTS.md | medium | active |
| 10 | vscode | VS Code | Microsoft | servers | json | AGENTS.md | medium | active |
| 11 | zed | Zed | Zed Industries | context_servers | jsonc | AGENTS.md | medium | active |
| 12 | claude-desktop | Claude Desktop | Anthropic | mcpServers | json | CLAUDE.md | medium | active |
| 13 | roo | Roo Code | Roo Code | mcpServers | json | AGENTS.md | low | active |
| 14 | continue | Continue | Continue | mcpServers | json | AGENTS.md | low | active |
| 15 | goose | Goose | Block | extensions | yaml | AGENTS.md | low | active |
| 16 | antigravity | Antigravity | Antigravity | mcpServers | json | AGENTS.md | low | active |
| 17 | kiro-cli | Kiro | Amazon | mcpServers | json | AGENTS.md | low | active |
| 18 | amp | Amp | Sourcegraph | mcpServers | json | AGENTS.md | low | active |
| 19 | trae | Trae | ByteDance | mcpServers | json | AGENTS.md | low | active |
| 20 | aide | Aide | Aide | mcpServers | json | AGENTS.md | low | beta |
| 21 | pear-ai | Pear AI | Pear AI | mcpServers | json | AGENTS.md | low | beta |
| 22 | void-ai | Void AI | Void | mcpServers | json | AGENTS.md | low | beta |
| 23 | cody | Sourcegraph Cody | Sourcegraph | mcpServers | json | AGENTS.md | low | active |
| 24 | kilo-code | Kilo Code | Kilo Code | mcpServers | json | AGENTS.md | low | active |
| 25 | qwen-code | Qwen Code | Alibaba | mcpServers | json | AGENTS.md | low | beta |
| 26 | openhands | OpenHands | All Hands AI | mcpServers | json | AGENTS.md | low | active |
| 27 | codebuddy | CodeBuddy | CodeBuddy | mcpServers | json | AGENTS.md | low | beta |
| 28 | codestory | CodeStory | CodeStory | mcpServers | json | AGENTS.md | low | beta |

### Schema Analysis

**Provider interface** has 20 fields per provider definition:
- Identity: `id`, `toolName`, `vendor`, `agentFlag`, `aliases`
- Paths: `pathGlobal`, `pathProject`, `pathSkills`, `pathProjectSkills`
- Config: `configKey`, `configFormat`, `configPathGlobal`, `configPathProject`
- Instruction: `instructFile`
- Detection: `detection` (nested: `methods[]`, `binary?`, `directories?`, `appBundle?`, `flatpakId?`)
- Transport: `supportedTransports[]`, `supportsHeaders`
- Metadata: `priority`, `status`, `agentSkillsCompatible`

**Config Key Distribution**:
| Key | Count | Providers |
|-----|-------|-----------|
| `mcpServers` | 22 | Most providers (default) |
| `mcp_servers` | 1 | Codex (TOML format) |
| `extensions` | 1 | Goose (YAML format) |
| `mcp` | 1 | OpenCode |
| `servers` | 1 | VS Code |
| `context_servers` | 1 | Zed (JSONC format) |

**Config Format Distribution**:
| Format | Count |
|--------|-------|
| JSON | 26 |
| JSONC | 1 (Zed) |
| YAML | 1 (Goose) |
| TOML | 1 (Codex) |

**Instruction File Distribution**:
| File | Count | Providers |
|------|-------|-----------|
| AGENTS.md | 24 | Most non-Anthropic/Google providers |
| CLAUDE.md | 2 | claude-code, claude-desktop |
| GEMINI.md | 1 | gemini-cli |

**Status Breakdown**: 21 active, 7 beta, 0 deprecated, 0 planned
**Priority Breakdown**: 3 high, 9 medium, 16 low
**Agent Skills Compatible**: 27 yes, 1 no (claude-desktop)

### 5 Providers Requiring Config Transforms

| Provider | Transform | Reason |
|----------|-----------|--------|
| Goose | `transformGoose` | YAML extensions format with `name`, `type`, `cmd`, `envs` |
| Zed | `transformZed` | context_servers with `source: "custom"` wrapper |
| OpenCode | `transformOpenCode` | `type: "remote"/"local"`, `environment` instead of `env` |
| Codex | `transformCodex` | TOML format, no type field for stdio |
| Cursor | `transformCursor` | Strips `type` field for remote servers |

### 4 Detection Methods

| Method | How | Providers Using |
|--------|-----|-----------------|
| `binary` | `which <name>` | 18 providers |
| `directory` | `existsSync(dir)` | 24 providers |
| `appBundle` | `/Applications/<name>.app` (macOS) | 2 (Zed, Claude Desktop) |
| `flatpak` | `flatpak info <id>` (Linux) | 0 currently defined |

### Gap List: Missing Providers

Based on web research, these AI coding tools are NOT in CAAMP's registry:

| Tool | Vendor | Type | MCP Support | Notes |
|------|--------|------|-------------|-------|
| JetBrains Junie | JetBrains | IDE-integrated agent | ACP (not MCP) | Uses ACP protocol, co-created ACP Registry with Zed |
| Tabnine | Tabnine | IDE plugin | Unknown | Privacy-focused, IDE extension only |
| Amazon Q Developer | Amazon | IDE plugin | Unknown | AWS-integrated, JetBrains + VS Code plugin |
| Replit Agent | Replit | Cloud IDE | No | Platform-bound, no local config |
| Devin | Cognition AI | SaaS agent | No | Commercial SaaS, no local config |
| Aider | Open source | CLI | Limited | Python CLI, pip install, uses own config |
| Mentat | Open source | CLI | Limited | Python CLI, less active in 2026 |
| SWE-Agent | Princeton NLP | CLI | No | Research tool, GitHub issue resolver |
| AutoCodeRover | Open source | CLI | No | Academic research tool |
| Supermaven | Supermaven | IDE plugin | Unknown | VS Code/JetBrains extension, fast completion |

**Assessment**: Of these, JetBrains/Junie is the most significant gap due to its market share and ACP protocol standardization. Aider has an active user base but uses its own config format. The SaaS-bound tools (Devin, Replit) and IDE-only plugins (Tabnine, Amazon Q, Supermaven) lack local MCP config files, making them structurally incompatible with CAAMP's registry model.

---

## 3. Feature Matrix: CAAMP vs Reference Projects

| Feature | CAAMP | Vercel Skills CLI | Neon add-mcp | Agent Skills CLI (Karanjot) |
|---------|-------|-------------------|--------------|----------------------------|
| **Version** | 0.1.0 | Active (npx) | Active (npx) | 1.0.8 |
| **Language** | TypeScript | TypeScript | TypeScript | TypeScript |
| **Runtime** | Node.js | Node.js | Bun | Node.js |
| **Primary Focus** | Unified package manager | Skill installer | MCP installer | Skill installer |
| **Supported Agents** | 28 | 35+ | 9 | 42 |
| **Skills Management** | Yes (install/remove/list/find/check/update/init/audit/validate) | Yes (add/list/find/remove/init) | No | Yes (install/update/remove/list) |
| **MCP Management** | Yes (install/remove/list/detect) | No | Yes (install only) | No |
| **Instruction Injection** | Yes (inject/check/update) | No | No | No |
| **Provider Registry** | JSON data file (28 providers) | Hardcoded | Hardcoded (9) | Hardcoded (42) |
| **Security Audit** | 46 rules, SARIF output | No | No | No |
| **Skill Validation** | Full spec validation | Basic | N/A | No |
| **Config Formats** | JSON, JSONC, YAML, TOML | JSON | JSON, TOML, YAML | JSON |
| **Comment Preservation** | Yes (jsonc-parser) | No | No | No |
| **Marketplace Integration** | agentskills.in + skills.sh | skills.sh (own) | N/A | agentskills.in |
| **Source Types** | 6 (remote, package, command, github, gitlab, local) | GitHub, GitLab, local | URL, npm package | GitHub, marketplace |
| **RFC 8615 Discovery** | Yes (well-known) | No | No | No |
| **Lock Files** | Yes (skills + MCP) | No | No | Yes |
| **Per-Agent Transforms** | 5 (Goose, Zed, OpenCode, Codex, Cursor) | No | Yes (Goose, Zed, Codex, OpenCode) | No |
| **Library API** | 57 exports | No | No | No |
| **Auto-Detection** | 4 methods (binary, directory, appBundle, flatpak) | Binary/directory | Binary/directory | Directory |
| **Canonical+Symlink** | Yes | Yes | N/A | No (copy) |
| **Platform Support** | Linux, macOS, Windows | Linux, macOS, Windows | Linux, macOS, Windows | Linux, macOS, Windows |
| **Interactive UI** | @clack/prompts | Prompts | Prompts | FZF-style search |

---

## 4. Competitive Analysis

### What Each Reference Project Does Well

#### Vercel Skills CLI (skills.sh)
- **Ecosystem creation**: Built the skills.sh marketplace (54,090+ installs tracked, 200+ skills in leaderboard)
- **Community adoption**: 300+ skill sources from Anthropic, Supabase, Expo, and community
- **Simplicity**: Single `npx skills add` command, zero configuration needed
- **Standard definition**: Co-established the SKILL.md frontmatter specification
- **Agent support breadth**: 35+ agents supported

#### Neon add-mcp
- **Single-purpose excellence**: Does one thing (MCP install) very well
- **Low friction**: `npx add-mcp <url>` just works
- **Transport handling**: Clean support for stdio, SSE, HTTP with header auth
- **Agent transforms**: Handles 4 non-standard agent config shapes
- **Bun runtime**: Modern, fast runtime choice

#### Agent Skills CLI (Karanjot786)
- **Scale**: Claims 100,000+ skills, 42 agent support
- **Interactive discovery**: FZF-style fuzzy search for skill browsing
- **Marketplace integration**: Built the agentskills.in marketplace
- **Git source flexibility**: Direct repo sourcing with `owner/repo@skill-name` syntax
- **Telemetry**: Anonymous usage tracking for ecosystem health

### What CAAMP Combines Uniquely

CAAMP is the only tool that unifies all three domains -- skills, MCP servers, and instruction files -- into a single CLI with a shared provider registry. Specific unique capabilities:

1. **Unified provider registry** (registry.json): Single, human-editable JSON file vs. hardcoded constants in all three competitors. Enables runtime resolution, platform-specific paths, and easy community contribution.

2. **Security audit engine**: 46 rules across 8 categories (prompt injection, command injection, data exfiltration, privilege escalation, filesystem abuse, network abuse, obfuscation, supply chain). No competitor has anything comparable. SARIF output enables CI/CD integration.

3. **Instruction file management**: Marker-based injection (`<!-- CAAMP:START -->...<!-- CAAMP:END -->`) into CLAUDE.md, AGENTS.md, GEMINI.md. No competitor manages instruction files.

4. **Comment-preserving config writes**: Uses `jsonc-parser` for surgical edits that preserve comments, formatting, and trailing commas. Competitors overwrite and reformat.

5. **Library API**: 57 programmatic exports enable embedding CAAMP's capabilities in other tools. Competitors are CLI-only.

6. **Multi-format config support**: JSON, JSONC, YAML, TOML handled natively. add-mcp supports 3 formats; others support JSON only.

7. **RFC 8615 well-known discovery**: Enables skill discovery from any website via `/.well-known/skills/index.json`. No competitor implements this.

8. **Full skill lifecycle**: install, remove, list, find, check, update, init, audit, validate -- 9 subcommands vs. 5 (Vercel) or 4 (Agent Skills CLI).

9. **Dual marketplace aggregation**: Queries both agentskills.in AND skills.sh simultaneously, deduplicating by scoped name. Competitors use one or the other.

---

## 5. Marketplace Ecosystem

### agentskills.in (SkillsMP)

| Attribute | Value |
|-----------|-------|
| URL | https://www.agentskills.in |
| Maintainer | Karanjot Singh (Karanjot786) |
| API Base | `https://www.agentskills.in/api/skills` |
| Query Params | `search`, `limit`, `sortBy`, `offset` |
| Response Shape | `{ skills: ApiSkill[], total, limit, offset }` |
| Skill Fields | id, name, description, author, scopedName, stars, forks, githubUrl, repoFullName, path, category, hasContent |
| Categories | Development, Testing, DevOps, AI & ML, Security, Data & Analytics, Infrastructure |
| Contributors | 29 active |
| Status | Active, open-source |

### skills.sh (Vercel Skills)

| Attribute | Value |
|-----------|-------|
| URL | https://skills.sh |
| Maintainer | Vercel Labs |
| API Base | `https://skills.sh/api` |
| Search Endpoint | `/api/search?q=<query>&limit=<n>` |
| Response Shape | `{ results: SkillsShResult[], total }` |
| Skill Fields | name, author, description, repo, stars, url |
| Scale | 54,090+ total installs, 200+ listed skills, top skill 190K installs |
| Sources | 300+ GitHub repositories from Anthropic, Supabase, Expo, community |
| Status | Active, well-established |

### prompts.chat

| Attribute | Value |
|-----------|-------|
| URL | https://prompts.chat/skills |
| Type | Community hub for AI prompts and agent skills |
| Focus | Discovering, collecting, and sharing skills for ChatGPT, Claude, Gemini |
| Integration | Browse and discover agent skills; links to SKILL.md-based skills |
| API | Not used by CAAMP; community discovery only |
| Status | Active, growing |

### Other Marketplaces (Not Yet Integrated)

| Marketplace | URL | Notes |
|-------------|-----|-------|
| Smithery Skills | smithery.ai/skills | Skills for Claude Code, document creation, prompt optimization |
| Skly | skly.ai | Paid marketplace for AI skills, prompts, and workflows |
| Manus Agent Skills | manus.im | Team skill libraries with organizational sharing |
| OpenAI Codex Skills | developers.openai.com/codex/skills | Official Codex skill directory |
| VS Code Agent Skills | code.visualstudio.com/docs/copilot/customization/agent-skills | GitHub Copilot skill integration |

### GitHub as Source

All marketplaces use GitHub as the actual source of truth for skill installation. The marketplaces are discovery/indexing layers; `git clone --depth 1` is the universal install mechanism. CAAMP's `cloneRepo()` function handles this with optional ref and subpath support.

---

## 6. Missing Providers

### Structurally Compatible (Could Be Added)

These tools have local config files and could potentially be added to CAAMP's registry:

| Tool | Vendor | Config Location | Config Format | Why Add |
|------|--------|-----------------|---------------|---------|
| **Aider** | Open source | `~/.aider.conf.yml` or `.aider.conf.yml` | YAML | Active CLI tool, pip-installable, growing user base |
| **JetBrains (ACP)** | JetBrains | `acp.json` | JSON | Massive IDE market share, new ACP protocol launched Jan 2026 |
| **Neovim (avante.nvim)** | Community | Various plugin configs | Lua/JSON | Large developer audience uses Neovim for AI coding |

### Structurally Incompatible (Cannot Be Added)

These tools do not use local configuration files that CAAMP could write to:

| Tool | Reason |
|------|--------|
| Devin | SaaS platform, no local config |
| Replit Agent | Cloud IDE, no local config |
| Tabnine | IDE extension only, managed via plugin settings |
| Amazon Q Developer | IDE plugin, managed via plugin settings |
| Supermaven | IDE extension, no MCP config |
| SWE-Agent | Research CLI, no MCP/skills config format |
| Mentat | Python CLI, no standardized config |
| AutoCodeRover | Research tool, no config format |

### ACP Protocol Consideration

The ACP (Agent Client Protocol) launched by JetBrains and Zed in January 2026 is a significant development. It is an open standard analogous to MCP but for AI agents in editors. The ACP Registry already lists Claude Code, Codex CLI, GitHub Copilot CLI, OpenCode, and Gemini CLI. CAAMP should evaluate whether to add ACP registry support alongside MCP, as the protocols serve different but complementary purposes.

---

## 7. User Personas

### Persona 1: The Multi-Agent Developer
**Profile**: Uses 3-5 AI coding agents daily (e.g., Claude Code for terminal, Cursor for editing, Copilot in VS Code). Needs MCP servers configured consistently across all tools.
**Pain Point**: Manually editing 3+ different config files with different formats when adding a new MCP server.
**CAAMP Value**: `caamp mcp install <url> --all` configures all agents in one command.

### Persona 2: The Skill Author
**Profile**: Creates SKILL.md files to share coding best practices across their team or publicly.
**Pain Point**: Validating skill format, checking for security issues, publishing to the right marketplace.
**CAAMP Value**: `caamp skills validate` + `caamp skills audit` + `caamp skills init` for the full authoring lifecycle.

### Persona 3: The Team Lead / DevOps Engineer
**Profile**: Manages a project with multiple developers using different AI agents. Needs consistent agent configuration.
**Pain Point**: Ensuring every developer's AI agent has the same MCP servers and skills configured, regardless of which IDE they use.
**CAAMP Value**: `caamp instructions inject` + lock files for reproducible agent configuration. CI integration via SARIF audit output.

### Persona 4: The Security-Conscious Developer
**Profile**: Evaluates third-party skills before allowing them in the organization. Concerned about prompt injection and data exfiltration.
**Pain Point**: No automated way to scan SKILL.md files for security threats.
**CAAMP Value**: 46-rule security audit engine, SARIF output for CI/CD gates, severity scoring.

### Persona 5: The Tooling Integrator
**Profile**: Building developer tools or platforms that need to programmatically manage AI agent configurations.
**Pain Point**: No library API exists for reading/writing MCP configs across agents.
**CAAMP Value**: 57 library exports covering registry queries, config R/W, skill management, audit scanning.

### Persona 6: The Agent Explorer
**Profile**: Trying new AI coding agents, wants to detect what's installed and discover skills.
**Pain Point**: Each agent has a different config location, different binary name, different setup process.
**CAAMP Value**: `caamp providers detect` finds all installed agents. `caamp skills find` searches multiple marketplaces.

---

## 8. Key Findings

### Top 10 Insights for PRD/Vision/Spec Writers

1. **CAAMP is the only unified tool**: No competitor combines skills + MCP + instructions in a single CLI. Vercel handles skills only; add-mcp handles MCP only; Agent Skills CLI handles skills only. This is CAAMP's fundamental differentiator.

2. **The provider registry is the core asset**: The 28-provider registry.json with 20 fields per provider (paths, detection, config shape, transport support) is the most comprehensive machine-readable provider database in the ecosystem. This data does not exist anywhere else in a single, structured format.

3. **Security audit is a unique competitive moat**: 46 rules across 8 categories with SARIF output. Zero competitors offer skill auditing. As the SKILL.md ecosystem grows (66,541+ skills across marketplaces), security scanning becomes increasingly critical. CAAMP should emphasize this in positioning.

4. **The library API enables an ecosystem play**: 57 exports mean CAAMP can be embedded in other tools -- IDE extensions, CI pipelines, platform CLIs. No competitor exposes a library API. This is a significant strategic advantage.

5. **The marketplace landscape is fragmented**: skills.sh (Vercel, 54K+ installs), agentskills.in (Karanjot, 7 categories), prompts.chat (community hub), Smithery, Skly, Manus, plus vendor-specific directories (OpenAI Codex, VS Code Copilot). CAAMP's adapter pattern allows aggregating all of these.

6. **ACP is an emerging protocol alongside MCP**: JetBrains and Zed launched the ACP Agent Registry in January 2026. This is complementary to MCP, not competitive. CAAMP should consider ACP support as a v0.2 or v0.3 feature to remain the "universal" tool.

7. **28 providers is already best-in-class but gaps exist**: Agent Skills CLI claims 42 agents, Vercel claims 35+. However, many of those are minor forks or defunct tools. CAAMP's 28 are well-documented with full detection/config/path data. The most significant gap is JetBrains/Junie (ACP protocol).

8. **Comment-preserving config writes solve real user pain**: Developers add comments to their config files. CAAMP is the only tool that uses jsonc-parser for surgical edits. This is a subtle but important quality signal that should be highlighted in docs.

9. **The SKILL.md standard is now industry-adopted**: Anthropic published it, OpenAI Codex adopted it, and 66,541+ skills exist across marketplaces. CAAMP is well-positioned as the package manager for this ecosystem, similar to how npm serves the Node.js module ecosystem.

10. **v0.1.0 is feature-complete for core workflows**: The codebase covers the full install/remove/list/detect/audit/validate lifecycle for both skills and MCP servers, plus instruction management. What it needs most is documentation, testing depth (801 test lines vs. 4,521 source lines), and marketplace adapter expansion.

### Additional Technical Observations

- **Canonical+symlink model** prevents skill duplication across agents and enables atomic updates. Windows fallback to copy is handled.
- **Lock file format** (`CaampLockFile`) tracks both skills and MCP servers with source type, version, install time, and per-agent linking. This enables `check` and `update` commands.
- **Source parser** handles 6 input types with intelligent name inference (strips MCP prefixes/suffixes, extracts brand from URLs). This is more sophisticated than any competitor.
- **The 3-file instruction model** (CLAUDE.md, AGENTS.md, GEMINI.md) maps cleanly to the ecosystem: Anthropic tools use CLAUDE.md, Google tools use GEMINI.md, everything else uses AGENTS.md. No CODEX.md or KIMI.md is needed because those tools read AGENTS.md.
- **Runtime path resolution** handles all 3 platforms (Linux, macOS, Windows) with XDG_CONFIG_HOME, APPDATA, and Application Support paths. This is production-quality cross-platform support.

---

*Research methodology: Direct codebase analysis of all 52 source files, web research on 3 competitor repos (vercel-labs/skills, neondatabase/add-mcp, Karanjot786/agent-skills-cli), 2 marketplace APIs (agentskills.in, skills.sh), and current AI coding agent landscape research.*
