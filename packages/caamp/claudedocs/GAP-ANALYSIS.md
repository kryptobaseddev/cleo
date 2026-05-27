# CAAMP Gap Analysis and Roadmap

## Document Information

| Field | Value |
|-------|-------|
| Version | 4.0.1 |
| Date | 2026-02-15 |
| Project | CAAMP (Central AI Agent Managed Packages) |
| Package | @cleocode/caamp v1.0.1 |
| Status | Shipped |
| Updated | v1.0.1 released with coverage remediation complete (79.04% threshold 79%) |

---

## 1. v0.1.0 Shipped Inventory

### 1.1 Provider Registry (28 providers)

| # | ID | Tool Name | Vendor | Priority | Status | Config Format | Config Key |
|---|-----|-----------|--------|----------|--------|---------------|------------|
| 1 | claude-code | Claude Code | Anthropic | high | active | json | mcpServers |
| 2 | cursor | Cursor | Anysphere | high | active | json | mcpServers |
| 3 | windsurf | Windsurf | Codeium | high | active | json | mcpServers |
| 4 | codex | Codex CLI | OpenAI | medium | active | toml | mcp_servers |
| 5 | gemini-cli | Gemini CLI | Google | medium | active | json | mcpServers |
| 6 | github-copilot | GitHub Copilot | GitHub | medium | active | json | mcpServers |
| 7 | opencode | OpenCode | OpenCode | medium | active | json | mcp |
| 8 | cline | Cline | Cline | medium | active | json | mcpServers |
| 9 | kimi | Kimi Coding | Moonshot AI | medium | active | json | mcpServers |
| 10 | vscode | VS Code | Microsoft | medium | active | json | servers |
| 11 | zed | Zed | Zed Industries | medium | active | jsonc | context_servers |
| 12 | claude-desktop | Claude Desktop | Anthropic | medium | active | json | mcpServers |
| 13 | roo | Roo Code | Roo Code | low | active | json | mcpServers |
| 14 | continue | Continue | Continue | low | active | json | mcpServers |
| 15 | goose | Goose | Block | low | active | yaml | extensions |
| 16 | antigravity | Antigravity | Antigravity | low | active | json | mcpServers |
| 17 | kiro-cli | Kiro | Amazon | low | active | json | mcpServers |
| 18 | amp | Amp | Sourcegraph | low | active | json | mcpServers |
| 19 | trae | Trae | ByteDance | low | active | json | mcpServers |
| 20 | aide | Aide | Aide | low | beta | json | mcpServers |
| 21 | pear-ai | Pear AI | Pear AI | low | beta | json | mcpServers |
| 22 | void-ai | Void AI | Void | low | beta | json | mcpServers |
| 23 | cody | Sourcegraph Cody | Sourcegraph | low | active | json | mcpServers |
| 24 | kilo-code | Kilo Code | Kilo Code | low | active | json | mcpServers |
| 25 | qwen-code | Qwen Code | Alibaba | low | beta | json | mcpServers |
| 26 | openhands | OpenHands | All Hands AI | low | active | json | mcpServers |
| 27 | codebuddy | CodeBuddy | CodeBuddy | low | beta | json | mcpServers |
| 28 | codestory | CodeStory | CodeStory | low | beta | json | mcpServers |

**Priority Distribution:** 3 high, 9 medium, 16 low
**Status Distribution:** 22 active, 6 beta, 0 deprecated
**Config Format Distribution:** 24 JSON, 1 JSONC, 1 YAML, 1 TOML (1 shares JSONC as JSON variant)
**Unique Config Keys:** mcpServers (21), mcp_servers (1), extensions (1), mcp (1), servers (1), context_servers (1)

### 1.2 CLI Commands (22 commands across 6 groups)

| Group | Command | Status | Lines | Notes |
|-------|---------|--------|-------|-------|
| **providers** | `list` | Full | 143 | Tier filtering, JSON output, color-coded display |
| **providers** | `detect` | Full | (shared) | Binary/directory/appBundle/flatpak detection (Windows-compatible in v0.3.0) |
| **providers** | `show` | Full | (shared) | Detailed provider info with all fields |
| **skills** | `install` | Full | 139 | GitHub, GitLab, local, marketplace sources (sourceType fix in v0.3.0) |
| **skills** | `remove` | Full | 51 | Canonical + symlink cleanup |
| **skills** | `list` | Full | 64 | Multi-directory discovery |
| **skills** | `find` | Full | 54 | Marketplace search with star counts |
| **skills** | `check` | Full | 47 | Network SHA comparison via git ls-remote (fixed in v0.2.0) |
| **skills** | `update` | Full | 30 | Git remote HEAD comparison + reinstall (fixed in v0.2.0) |
| **skills** | `init` | Full | 60 | Scaffolds SKILL.md template |
| **skills** | `audit` | Full | 80 | 46 rules, SARIF output, severity scoring |
| **skills** | `validate` | Full | 38 | Frontmatter validation with reserved names |
| **mcp** | `install` | Full | 110 | Multi-agent, dry-run, header support |
| **mcp** | `remove` | Full | 56 | Lock file cleanup |
| **mcp** | `list` | Full | 60 | Per-agent or cross-agent listing |
| **mcp** | `detect` | Full | 62 | Auto-detect MCP configs across providers |
| **instructions** | `inject` | Full | 73 | Marker-based injection, dry-run |
| **instructions** | `check` | Full | 76 | Status: current/outdated/missing/none |
| **instructions** | `update` | Full | 50 | Diff-based selective update |
| **config** | `show` | Full | 81 | Read and display provider config |
| **config** | `path` | Full | (shared) | Show config file paths |
| **doctor** | `doctor` | Full | 357 | Config health checks, broken symlink detection, registry integrity (NEW in v0.3.0) |

**Summary:** 22 fully functional commands across 6 groups. All commands support `--verbose` and `--quiet` global flags (added in v0.3.0).

### 1.3 Core Modules

| Module | Files | Total Lines | Test Coverage |
|--------|-------|-------------|---------------|
| registry/ | 3 (providers, detection, types) | 379 | 14 tests (registry.test.ts) |
| formats/ | 5 (json, yaml, toml, utils, index) | 443 | 18 tests (formats.test.ts) |
| mcp/ | 4 (installer, reader, transforms, lock) | 415 | 18 tests (mcp-reader.test.ts) |
| skills/ | 6 (installer, discovery, validator, lock, audit/scanner, audit/rules) | 851 | 8 tests (installer.test.ts) |
| marketplace/ | 4 (client, types, skillsmp, skillssh) | 238 | 21 tests (marketplace.test.ts) |
| sources/ | 4 (parser, github, gitlab, wellknown) | 320 | 13 tests (source-parser.test.ts) |
| instructions/ | 2 (injector, templates) | 232 | 25 tests (instructions.test.ts) |
| logger.ts | 1 | 41 | 0 tests (new in v0.3.0) |
| lock-utils.ts | 1 | 34 | 0 tests (new in v0.3.0) |
| **Total** | **30 files** | **2,953 lines** | **120 tests across 8 files** |

Note: 3 tests in lock.test.ts cover data structure validation (not I/O). Logger and lock-utils are new shared modules added in v0.3.0.

### 1.4 Library API (88 exports)

| Category | Export Count | Key Exports |
|----------|-------------|-------------|
| Types | 20 | Provider, McpServerConfig, McpServerEntry, ConfigFormat, TransportType, SourceType, ParsedSource, SkillMetadata, SkillEntry, LockEntry, CaampLockFile, MarketplaceSkill, MarketplaceSearchResult, AuditRule, AuditFinding, AuditResult, AuditSeverity, InjectionStatus, InjectionCheckResult, GlobalOptions |
| Result Types | 5 | DetectionResult, InstallResult, SkillInstallResult, ValidationResult, ValidationIssue |
| Registry | 9 | getAllProviders, getProvider, resolveAlias, getProvidersByPriority, getProvidersByStatus, getProvidersByInstructFile, getInstructionFiles, getProviderCount, getRegistryVersion |
| Detection | 4 | detectProvider, detectAllProviders, getInstalledProviders, detectProjectProviders |
| Sources | 2 | parseSource, isMarketplaceScoped |
| Skills | 10 | installSkill, removeSkill, listCanonicalSkills, discoverSkills, discoverSkill, parseSkillFile, validateSkill, scanFile, scanDirectory, toSarif |
| MCP | 10 | installMcpServer, installMcpServerToAll, buildServerConfig, getTransform, resolveConfigPath, listMcpServers, listAllMcpServers, removeMcpServer, readLockFile, recordMcpInstall, removeMcpFromLock, getTrackedMcpServers, saveLastSelectedAgents, getLastSelectedAgents |
| Skills Lock | 4 | recordSkillInstall, removeSkillFromLock, getTrackedSkills, checkSkillUpdate |
| Marketplace | 1 class (+1 type) | MarketplaceClient, MarketplaceResult |
| Instructions | 7 | inject, checkInjection, removeInjection, checkAllInjections, injectAll, generateInjectionContent, groupByInstructFile |
| Formats | 6 | readConfig, writeConfig, removeConfig, getNestedValue, deepMerge, ensureDir |
| Logger | 4 | setVerbose, setQuiet, isVerbose, isQuiet (NEW in v0.3.0) |

### 1.5 Test Suite (120 tests across 8 files)

| Test File | Tests | Coverage Area |
|-----------|-------|---------------|
| registry.test.ts | 14 | Provider loading, aliases, filtering, path resolution |
| source-parser.test.ts | 13 | URL parsing, GitHub/GitLab/npm/local/command classification |
| formats.test.ts | 18 | JSON read/write/remove, JSONC comment preservation, YAML, deepMerge, nested values |
| installer.test.ts | 8 | Skill validator (7 cases), canonical install (1 case) |
| lock.test.ts | 3 | Lock file data structure validation |
| mcp-reader.test.ts | 18 | Config path resolution, server listing, deduplication, removal, edge cases |
| marketplace.test.ts | 21 | Client adapter pattern, search merging, getSkill, skillsmp/skillssh adapters (NEW in v0.2.0) |
| instructions.test.ts | 25 | Inject, check, remove, injectAll, templates, groupByInstructFile (NEW in v0.2.0) |
| **Total** | **120** | **Unit tests only -- no integration or e2e tests** |

### 1.6 Build and Publish

| Aspect | Detail |
|--------|--------|
| Package name | @cleocode/caamp |
| Version | 0.3.0 (planned) |
| Build tool | tsup (ESM + declarations) |
| Test framework | vitest v3.2.4 |
| Module system | ESM only (NodeNext resolution) |
| TypeScript | Strict mode with noUncheckedIndexedAccess |
| Node requirement | >=20 |
| Dependencies | 7 (commander, @clack/prompts, picocolors, gray-matter, simple-git, jsonc-parser, js-yaml, @iarna/toml) |
| Dev dependencies | 5 (typescript, tsup, tsx, vitest, @types/node, @types/js-yaml) |
| Binary | `caamp` via dist/cli.js |

---

## 2. Gap Analysis: Plan vs Reality

### 2.1 Provider Count

- **Planned:** 40+ providers
- **Shipped:** 28 providers
- **Gap:** 12+ providers missing

The registry covers the major players (Claude Code, Cursor, Windsurf, Codex, Gemini, Copilot) and a broad range of medium and low-priority tools. However, several significant AI coding tools from 2025-2026 are absent. See Section 3 for the detailed missing providers analysis.

### 2.2 Test Coverage

- **Planned:** Unit + Integration tests
- **Shipped:** 120 unit tests across 8 files
- **Gap:** No integration tests, no e2e tests

**What's covered well:**
- Provider registry loading, alias resolution, filtering (14 tests)
- Source URL/path parsing across all source types (13 tests)
- Config format read/write/remove for JSON/JSONC/YAML (18 tests)
- MCP config reader operations: list, remove, path resolution (18 tests)
- Skill validation rules (7 tests)
- Marketplace client adapter pattern, search merging, getSkill (21 tests, added v0.2.0)
- Instructions inject/check/remove/injectAll/templates (25 tests, added v0.2.0)

**What has no test coverage:**
- MCP installer (installer.ts) -- 0 tests (only reader.ts tested)
- MCP transforms (transforms.ts) -- 0 tests for Goose/Zed/OpenCode/Codex/Cursor transforms
- Skills lock file I/O -- only data structure tests, no actual read/write tests
- GitHub/GitLab fetcher (github.ts, gitlab.ts) -- 0 tests
- Well-known discovery (wellknown.ts) -- 0 tests
- Skills discovery (discovery.ts) -- 0 tests
- Detection engine actual binary/directory checks -- 0 tests
- Logger utility (logger.ts) -- 0 tests (new in v0.3.0)
- Lock utils (lock-utils.ts) -- 0 tests (new in v0.3.0)
- Doctor command (doctor.ts) -- 0 tests (new in v0.3.0)

**Integration tests needed:**
- Full install flow: parse source -> fetch -> install to canonical -> symlink to agents
- Full MCP install flow: parse source -> build config -> transform -> write to all agents
- Doctor command end-to-end validation
- Marketplace search -> install pipeline
- Lock file concurrency (two installs at once)
- Cross-platform path resolution (Windows junctions vs Unix symlinks)

### 2.3 Documentation

- **Planned:** PRD, Technical Spec, Architecture docs
- **Shipped:** README, CHANGELOG, CLAUDE.md only
- **Gap:** PRD and Technical Spec being created by other agents in parallel

The README covers basic usage but lacks detailed API documentation, configuration examples per provider, or contribution guidelines. No `--help` text tests ensure CLI help output stays accurate.

### 2.4 CLEO Integration

- **Planned:** Full session management, verification gates
- **Shipped:** Basic task tracking via .cleo/todo.json
- **Gap:** All verification gates show `passed: false` on completed tasks

The todo.json shows 19 child tasks under T001 (CAAMP v0.1.0), all marked "done". However, every single verification block has `"passed": false` with null gates for testsPassed, qaPassed, cleanupDone, securityPassed, and documented. This means the tasks were completed without formal verification -- the code works, but the CLEO process was bypassed.

No sessions were created or ended during development. The `activeSession` is null and `lastSessionId` is null.

### 2.5 Command Completeness Gaps

| Command | Gap | Severity | Status |
|---------|-----|----------|--------|
| `skills update` | ~~Stub -- always returns "up to date"~~ | ~~High~~ | FIXED in v0.2.0 |
| `skills check` | ~~No git remote HEAD comparison~~ | ~~High~~ | FIXED in v0.2.0 |
| `skills install` | No `--force` flag to overwrite without prompting; no version pinning via `@ref` in marketplace installs | Medium | Open |
| `skills install` | ~~sourceType hardcoded to "github"~~ | ~~Medium~~ | FIXED in v0.3.0 |
| `skills find` | No pagination; no category/author filtering in CLI (adapters support it) | Low | Open |
| `mcp install` | No interactive agent selection via @clack/prompts (declared dependency but unused for this) | Medium | Open |
| `mcp list` | No `--all` flag to show both global and project simultaneously | Low | Open |
| `providers detect` | ~~Binary detection uses `which` -- does not work on Windows~~ | ~~Medium~~ | FIXED in v0.3.0 |
| `config show` | Does not resolve `$HOME`/`$CONFIG` in paths before checking existence | Low | Open |
| All commands | ~~No `--verbose` or `--debug` flag for troubleshooting~~ | ~~Medium~~ | FIXED in v0.3.0 |
| All commands | ~~No `--quiet` flag for scripting use~~ | ~~Low~~ | FIXED in v0.3.0 |

---

## 3. Missing Providers (Detailed)

### 3.1 Aider

- **Vendor:** Aider AI (open source)
- **Type:** CLI terminal tool
- **Config format:** YAML (`.aider.conf.yml` or `--config` flag)
- **Config location:** Project: `.aider.conf.yml`, Global: `~/.aider.conf.yml`
- **MCP support:** No native MCP support. Active feature request (GitHub issue #4506). Community bridge via MCPM-Aider exists.
- **Skills support:** No -- uses custom prompts via `--read` files
- **Priority recommendation:** Medium -- widely used terminal AI tool with strong git integration
- **Notes:** Aider maps the entire codebase for multi-file edits. Deep git integration with automatic commits. No standard config key for MCP -- would need adapter when MCP support ships.

### 3.2 Tabnine

- **Vendor:** Tabnine
- **Type:** IDE extension (VS Code, JetBrains, Vim, Neovim)
- **Config format:** JSON (IDE-specific settings)
- **Config location:** Varies by IDE; managed through extension settings
- **MCP support:** Unknown -- focused on code completion, not agent workflows
- **Skills support:** No
- **Priority recommendation:** Medium -- strong enterprise presence, on-premise deployment option
- **Notes:** Pioneer in AI code completion. Key differentiator is on-premise/air-gapped deployment. Less relevant as agent-style tool; more autocomplete-focused. May not need MCP config.

### 3.3 Amazon Q Developer

- **Vendor:** Amazon (AWS)
- **Type:** IDE extension + CLI
- **Config format:** JSON
- **Config location:** `~/.aws/` for CLI credentials; IDE extension settings for MCP
- **MCP support:** Yes -- supports MCP servers in IDE extensions
- **Skills support:** Unknown
- **Priority recommendation:** High -- major cloud vendor, free tier, deep AWS integration
- **Notes:** Formerly CodeWhisperer. Tight AWS integration. CLI version (`q`) can generate code. MCP support via IDE plugin. Generous free tier. Should be medium or high priority given AWS market share.

### 3.4 JetBrains AI Assistant

- **Vendor:** JetBrains
- **Type:** IDE plugin (IntelliJ, PyCharm, WebStorm, etc.)
- **Config format:** JSON (MCP server configs via IDE Settings UI)
- **Config location:** IDE settings at `Settings | Tools | AI Assistant | Model Context Protocol (MCP)`
- **MCP support:** Yes -- native MCP client support and built-in MCP server (version 2025.2+)
- **Skills support:** No (uses ACP -- Agent Client Protocol)
- **Priority recommendation:** High -- massive IDE market share, native MCP support
- **Notes:** Supports both consuming and providing MCP servers. Can auto-configure external clients (Claude, Cursor, Codex, VS Code). Uses `@jetbrains/mcp-proxy` for stdio bridge. Config is managed through IDE GUI, not a static file CAAMP could easily write to. May need special handling.

### 3.5 Devin

- **Vendor:** Cognition AI
- **Type:** SaaS autonomous agent
- **Config format:** Web-based configuration
- **Config location:** Cloud-hosted, no local config files
- **MCP support:** Unknown
- **Skills support:** No
- **Priority recommendation:** Low -- SaaS-only, no local config files to manage
- **Notes:** Operates in isolated cloud environment with its own terminal, editor, and browser. Not a local tool -- CAAMP's config management model doesn't apply well. Could potentially be represented as a "planned" provider for future API-based management.

### 3.6 Augment Code

- **Vendor:** Augment Code
- **Type:** IDE extension (VS Code)
- **Config format:** JSON (extension settings)
- **Config location:** VS Code extension settings
- **MCP support:** Unknown
- **Skills support:** No
- **Priority recommendation:** Medium -- growing enterprise adoption for large codebase understanding
- **Notes:** Specializes in understanding large codebases and organizational patterns. Deep codebase analysis is its differentiator. Extension-based -- config may be manageable through VS Code settings files.

### 3.7 Supermaven

- **Vendor:** Supermaven (merged into Cursor, November 2024)
- **Type:** Defunct / merged
- **Config format:** N/A
- **Config location:** N/A
- **MCP support:** N/A
- **Skills support:** N/A
- **Priority recommendation:** None -- merged into Cursor
- **Notes:** Supermaven's technology was absorbed into Cursor IDE. No separate product exists. Do not add as a provider.

### 3.8 SWE-Agent

- **Vendor:** Princeton NLP (open source)
- **Type:** CLI autonomous agent
- **Config format:** YAML (config files)
- **Config location:** Project-level config files
- **MCP support:** No
- **Skills support:** No
- **Priority recommendation:** Low -- research tool, limited production use
- **Notes:** Designed for automated GitHub issue resolution. Runs in Docker containers. Config is per-run, not persistent. Not a good fit for CAAMP's persistent config management model.

### 3.9 AutoCodeRover

- **Vendor:** Open source (NUS research)
- **Type:** CLI autonomous agent
- **Config format:** JSON/YAML (per-run config)
- **Config location:** Per-run arguments
- **MCP support:** No
- **Skills support:** No
- **Priority recommendation:** Low -- research tool
- **Notes:** Academic research project focused on automated program repair. Not a mainstream developer tool. Skip for v0.2.0.

### 3.10 Mentat

- **Vendor:** AbanteAI (open source)
- **Type:** CLI terminal tool
- **Config format:** JSON (`.mentat/config.json`)
- **Config location:** Project: `.mentat/`, Global: `~/.mentat/`
- **MCP support:** No
- **Skills support:** No
- **Priority recommendation:** Low -- smaller user base
- **Notes:** Terminal-based coding assistant similar to Aider. Less widely adopted. Could be added in v0.3.0 as a low-priority provider.

### 3.11 Replit Agent

- **Vendor:** Replit
- **Type:** SaaS cloud IDE + agent
- **Config format:** replit.md (markdown rules), JSON for connectors
- **Config location:** Cloud-hosted via Replit IDE
- **MCP support:** Yes -- supports MCP via "Connectors" platform with 30+ pre-built integrations and custom MCP server support
- **Notes:** Agent 3 (2026) has 200-minute autonomy, self-healing code. MCP config is managed through Replit's cloud UI, not local files. Like Devin, not a great fit for local config management. Could be represented as "planned" or "cloud" status provider.
- **Priority recommendation:** Low for CAAMP -- cloud-hosted config, not file-based

### 3.12 Warp AI

- **Vendor:** Warp
- **Type:** Terminal application with AI
- **Config format:** YAML
- **Config location:** `~/.warp/`
- **MCP support:** Unknown
- **Skills support:** No
- **Priority recommendation:** Low -- terminal emulator, not a coding agent
- **Notes:** AI-powered terminal with command suggestions. Tangential to coding agents.

### Provider Gap Summary

| Provider | Priority | MCP Support | Action for v0.2.0 |
|----------|----------|-------------|-------------------|
| Amazon Q Developer | High | Yes | Add immediately |
| JetBrains AI | High | Yes (native) | Add with special handling notes |
| Aider | Medium | Pending | Add with stub MCP config |
| Tabnine | Medium | Unknown | Add as completion-focused provider |
| Augment Code | Medium | Unknown | Add as extension provider |
| Replit Agent | Low | Yes (cloud) | Add as cloud/planned status |
| Mentat | Low | No | Defer to v0.3.0 |
| SWE-Agent | Low | No | Defer to v0.3.0 |
| Devin | Low | Unknown | Defer -- SaaS only |
| AutoCodeRover | Low | No | Skip -- research tool |
| Supermaven | None | N/A | Skip -- merged into Cursor |
| Warp AI | Low | Unknown | Defer to v0.3.0 |

**Realistic v0.2.0 target:** Add 5-7 providers (Amazon Q, JetBrains AI, Aider, Tabnine, Augment Code, and possibly Replit Agent and Mentat) to reach 33-35 total. The 40+ target is achievable in v0.3.0.

---

## 4. Feature Gaps

### 4.1 Commands That Need Work

**`skills update` -- FIXED in v0.2.0**
~~The command was a complete stub.~~ Now performs network SHA comparison via git ls-remote and reinstalls when updates are detected.

**`skills check` -- FIXED in v0.2.0**
~~`checkSkillUpdate()` was a no-op.~~ Now performs git ls-remote SHA comparison for accurate update detection.

**`providers detect` -- FIXED in v0.3.0**
~~The detection engine used `which` (Unix-only).~~ Now uses `where` on Windows (win32) with `which` fallback on Unix platforms.

### 4.2 Missing Error Handling

| Location | Issue | Status |
|----------|-------|--------|
| `src/commands/skills/install.ts:56` | ~~`sourceType` hardcoded to `"github"`~~ | FIXED in v0.3.0 -- now uses `parsed.type` |
| `src/core/mcp/lock.ts:26` | Silent catch on corrupted lock file -- should warn user | Open |
| `src/core/skills/lock.ts:16-19` | ~~Duplicated `writeLockFile` function~~ | FIXED in v0.3.0 -- shared via `src/core/lock-utils.ts` |
| `src/core/formats/json.ts:24-26` | Fallback to `JSON.parse` on JSONC errors may throw unhandled exception | Open |
| `src/core/sources/github.ts:35` | `git clone` failure gives no user-friendly error about network/auth issues | Open |
| `src/core/marketplace/client.ts:27` | Network errors silently swallowed -- user sees empty results with no explanation | Open |
| All CLI commands | No global error handler -- unhandled rejections crash with stack traces | Open |

### 4.3 Edge Cases

| Edge Case | Impact | Current Behavior |
|-----------|--------|-----------------|
| Windows symlinks require admin/developer mode | Medium | Falls back to copy, but no user notification |
| Lock file concurrent writes (parallel installs) | Medium | Last write wins, data loss possible |
| Provider config path with spaces (Windows) | Low | Untested -- may break |
| Registry.json not found in monorepo layouts | Low | Traverses up 5 levels, then throws |
| `$HOME` undefined (rare containerized environments) | Low | `os.homedir()` throws |
| TOML format write for Codex | Medium | `writeTomlConfig` implemented but no tests |
| Very large SKILL.md files (>1MB) | Low | Read entirely into memory |
| GitLab repos with nested groups (owner/subgroup/repo) | Low | Regex only handles single-level groups |

### 4.4 Missing Features

| Feature | Category | Description | Status |
|---------|----------|-------------|--------|
| ~~`caamp doctor`~~ | ~~CLI~~ | ~~Diagnose config issues, check broken symlinks, validate registry integrity~~ | DONE in v0.3.0 |
| `caamp migrate` | CLI | Migrate MCP configs between providers (e.g., Cursor -> Claude) | Open |
| `caamp sync` | CLI | Sync MCP servers across all installed providers from a single source of truth | Open |
| `caamp export/import` | CLI | Export/import full config for team sharing | Open |
| CI/CD integration | DevOps | GitHub Actions / GitLab CI for automated skill auditing | Open |
| Team config sharing | Collaboration | Shared team config file (like .npmrc for npm) | Open |
| Interactive prompts | UX | @clack/prompts dependency exists but is unused in most commands | Open |
| Config backup | Safety | No backup before destructive config writes | Open |
| Rollback mechanism | Safety | No undo for failed installs | Open |
| Telemetry opt-in | Analytics | No usage analytics for understanding adoption | Open |
| Plugin system | Extensibility | No way for community to add custom providers or marketplace adapters | Open |
| Well-known discovery integration | CLI | `wellknown.ts` exists in core but no CLI command exposes it | Open |
| TOML write tests | Quality | `writeTomlConfig` and `removeTomlConfig` exist but have zero tests | Open |
| Help text quality | UX | Commands have descriptions but no examples or extended help | Open |

---

## 5. v0.2.0 Results (SHIPPED)

### 5.1 Provider Expansion -- COMPLETED (target: 33-35, actual: 46)

| Provider | Status | Notes |
|----------|--------|-------|
| Amazon Q Developer | ADDED | Active, confirmed MCP config paths |
| JetBrains AI Assistant | ADDED | Active, IDE-managed MCP via settings |
| Aider | ADDED | Active, YAML config |
| Tabnine | ADDED | Active, MCP via mcp_servers.json |
| Augment Code | ADDED | Active, confirmed config paths |
| Replit Agent | ADDED | Active, cloud-based MCP |
| Mentat | ADDED | Planned status (unconfirmed MCP) |
| Devin | ADDED | Active, cloud-based |
| Blackbox AI | ADDED | Planned status |
| Sourcery | ADDED | Planned status |
| Double | ADDED | Planned status |
| Codegen | ADDED | Planned status |
| Sweep | ADDED | Planned status |
| Supermaven | ADDED | Planned status |
| Copilot CLI | ADDED | Active |
| SWE-Agent | ADDED | Active, YAML config |
| Forge | ADDED | Active |
| Gemini Code Assist | ADDED | Active, shares GEMINI.md instruction file |

**Result: 28 -> 46 providers (exceeded 40+ target)**

### 5.2 Critical Command Gaps -- COMPLETED

| Fix | Status | Notes |
|-----|--------|-------|
| `skills update` with git remote HEAD comparison | DONE (v0.2.0) | Network SHA comparison + reinstall |
| `skills check` with actual network comparison | DONE (v0.2.0) | ls-remote SHA comparison |
| `providers detect` for Windows | DONE (v0.3.0) | Uses `where` on win32, `which` on Unix |
| Hardcoded `sourceType` in skills install | DONE (v0.3.0) | Now uses `parsed.type` |
| Deduplicate lock file write functions | DONE (v0.3.0) | Shared via `src/core/lock-utils.ts` |

### 5.3 Tests -- PARTIALLY COMPLETED

| Planned | Status | Notes |
|---------|--------|-------|
| Unit tests for marketplace/ | DONE | 21 tests (client, skillsmp, skillssh) |
| Unit tests for instructions/ | DONE | 25 tests (injector, templates) |
| Integration test suites | DEFERRED to v0.3.0 | Unit coverage was the priority |

**Test count: 74 -> 120 (+46 new unit tests)**

### 5.4 New Commands -- PARTIALLY COMPLETED

| Command | Status |
|---------|--------|
| `caamp doctor` | DONE (v0.3.0) -- 357 lines, config health checks, broken symlinks, registry integrity |
| `caamp upgrade` | DEFERRED -- still not implemented |

### 5.5 Improvements -- PARTIALLY COMPLETED

| Improvement | Status |
|-------------|--------|
| `--verbose` global flag | DONE (v0.3.0) -- via `src/core/logger.ts`, exported as library API |
| `--quiet` global flag | DONE (v0.3.0) -- via `src/core/logger.ts`, exported as library API |
| Interactive prompts | DEFERRED -- @clack/prompts still unused in most commands |
| Config backup | DEFERRED |
| Error messages | DEFERRED |
| Help examples | DEFERRED |

### 5.6 Additional v0.2.0 Deliverables (not in original plan)

| Deliverable | Notes |
|-------------|-------|
| README rewrite with banner, badges, install, architecture | 85 -> 204 lines |
| Dependency modernization (commander 14, @clack/prompts 1.0) | Node >=20 |
| Fix scoped package npx command | `npx @cleocode/caamp` |
| API Reference document | 82 exported symbols, full signatures |
| PRD (730 lines) | Product vision, user stories, requirements |
| Technical Specification (1,714 lines) | RFC 2119, full API spec |
| Vision & Architecture (719 lines) | Project manifesto |
| Gap Analysis & Roadmap (this document) | Current state analysis |
| Research Brief (457 lines) | Competitive analysis |

### 5.7 v0.3.0 Results (IN PROGRESS)

#### Bug Fixes (T033) -- COMPLETED

| Bug | Status | Notes |
|-----|--------|-------|
| Windows `providers detect` | DONE | Uses `where` on win32, `which` on Unix |
| `sourceType` hardcoded in `skills install` | DONE | Now uses `parsed.type` from source parser |
| Lock file `writeLockFile` duplication | DONE | Shared module at `src/core/lock-utils.ts` |

#### New Commands (T034) -- COMPLETED

| Command | Status | Notes |
|---------|--------|-------|
| `caamp doctor` | DONE | 357 lines. Config health checks, broken symlink detection, registry integrity validation |

#### Global Flags (T035) -- COMPLETED

| Flag | Status | Notes |
|------|--------|-------|
| `--verbose` | DONE | Logger utility at `src/core/logger.ts` (41 lines), exported via library API |
| `--quiet` | DONE | Suppresses non-essential output for scripting use |

#### API Documentation (T030, T037) -- COMPLETED

| Task | Status | Notes |
|------|--------|-------|
| API-REFERENCE.md audit (T030) | DONE | 12 findings documented in `claudedocs/agent-outputs/T030-api-audit.md` |
| API-REFERENCE.md fixes (T037) | DONE | All 12 audit findings addressed |

#### TSDoc Annotations (T031) -- IN PROGRESS

Adding TSDoc/JSDoc annotations to all public API exports for TypeDoc compatibility.

#### TypeDoc Generation (T032) -- IN PROGRESS

Setting up automated API documentation generation via TypeDoc.

#### Gap Analysis Update (T036) -- COMPLETED

This document updated to reflect v0.3.0 state.

#### v0.3.0 Summary

| Metric | v0.2.0 | v0.3.0 | Delta |
|--------|--------|--------|-------|
| Providers | 46 | 46 | -- |
| CLI Commands | 21 | 22 | +1 (doctor) |
| Core files | 28 | 30 | +2 (logger, lock-utils) |
| Core lines | 2,838 | 2,953 | +115 |
| Command files | 18 | 22 | +4 (doctor.ts + count update) |
| Command lines | 1,274 | 1,867 | +593 |
| Library exports | 82 | 88 | +6 (logger exports, result types) |
| Unit tests | 120 | 120 | -- |
| Test files | 8 | 8 | -- |
| Registry lines | 721 | 1,171 | +450 |
| Bugs fixed | -- | 3 | Windows detect, sourceType, lock dedup |

---

## 6. v0.3.0 Roadmap (Remaining Items)

### 6.1 Plugin System

Allow community-contributed providers and marketplace adapters without forking the registry.

```typescript
// ~/.caamp/plugins/my-provider.js
export default {
  id: "my-custom-agent",
  toolName: "My Custom Agent",
  // ... provider fields
};
```

Loading plugins from `~/.caamp/plugins/` and merging into the registry at runtime.

### 6.2 CI/CD Integration

- GitHub Actions for automated skill auditing on PRs
- GitLab CI template for SARIF upload
- `caamp audit --ci` with exit codes for pipeline gating
- Pre-commit hook for skill validation

### 6.3 Team Config Sharing

- `.caamprc.json` at project root defining team-wide MCP servers and skills
- `caamp sync` command to apply team config to all detected providers
- Lock file per-project for reproducible setups
- Config inheritance: global -> team -> project

### 6.4 Config Templates

- `caamp init --template web-dev` for preconfigured MCP server sets
- Community-maintained template registry
- Template composition (combine multiple templates)

### 6.5 Additional Providers

Provider count already exceeds 40+ target (46 providers shipped in v0.2.0). Future additions are opportunistic:
- New AI coding tools that emerge with MCP support
- Warp AI (if they add agent capabilities)

---

## 7. v1.0.0 Stability Criteria

### 7.1 API Stability

- All 88+ library exports must have stable interfaces (no breaking changes without major version bump)
- Provider type interface frozen
- Lock file format versioned and migration-supported
- Config format handlers must pass round-trip tests for all supported formats

### 7.2 Test Coverage Requirements

- Minimum 80% line coverage across all core modules
- 100% of public API functions have unit tests
- Integration test suite for all CLI commands
- Cross-platform CI (Linux, macOS, Windows)
- Performance benchmarks for registry loading and detection

### 7.3 Documentation Requirements

- API reference generated from TSDoc comments
- Per-provider configuration guide with examples
- Migration guide for each version
- Contributing guidelines
- Architecture decision records (ADRs)
- Troubleshooting guide

### 7.4 Community Process

- Issue templates for bug reports and feature requests
- PR review process documented
- Release cadence defined (suggested: monthly minor, patch as needed)
- Provider submission process for third parties
- Security disclosure policy

---

## 8. Risk Register

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Marketplace API changes (agentskills.in, skills.sh) | Medium | High | Adapter pattern provides isolation; add response schema validation |
| Provider config format changes (agents update their config schemas) | High | Medium | Registry version tracking; automated config format tests against real agent installs |
| Windows symlink limitations (require developer mode or admin) | Medium | Medium | Copy fallback exists; add clear user messaging about symlink requirements |
| npm maintenance burden (7 runtime deps) | Low | Low | Pin major versions; dependabot for security patches |
| Lock file corruption from concurrent writes | Medium | High | Add file locking (fs-ext or atomic writes); merge the duplicated writeLockFile functions |
| MCP protocol evolution (new transport types, auth mechanisms) | Medium | Medium | TransportType is extensible; config schema uses Record<string, unknown> for flexibility |
| Provider proliferation (keeping 40+ entries accurate) | High | Medium | Automated registry validation tests; community contribution process; deprecation lifecycle |
| Skill marketplace consolidation (APIs merge or shut down) | Medium | Medium | Adapter pattern allows adding/removing backends; fallback to GitHub-direct install |
| Large skill files causing memory issues during audit | Low | Low | Stream-based scanning for files >1MB; warning in validate command |
| Agent instruction file format changes (e.g., new file beyond CLAUDE.md/AGENTS.md/GEMINI.md) | Medium | Medium | instructFile is per-provider in registry; adding new files is a data-only change |

---

## 9. Appendix: File Inventory

### Source Files by Category

**Entry points (2 files, 143 lines):**
- `src/cli.ts` (39 lines) -- Commander CLI entry
- `src/index.ts` (104 lines) -- Library barrel export (88 symbols)

**Type definitions (1 file, 214 lines):**
- `src/types.ts` (214 lines) -- All core types

**Commands (22 files, 1,867 lines):**
- `src/commands/providers.ts` (143 lines)
- `src/commands/config.ts` (81 lines)
- `src/commands/doctor.ts` (357 lines) -- NEW in v0.3.0
- `src/commands/skills/` (10 files, 761 lines)
- `src/commands/mcp/` (5 files, 308 lines)
- `src/commands/instructions/` (4 files, 217 lines)

**Core modules (30 files, 2,953 lines):**
- `src/core/registry/` (3 files, 379 lines)
- `src/core/formats/` (5 files, 443 lines)
- `src/core/mcp/` (4 files, 415 lines)
- `src/core/skills/` (6 files, 851 lines)
- `src/core/marketplace/` (4 files, 238 lines)
- `src/core/sources/` (4 files, 320 lines)
- `src/core/instructions/` (2 files, 232 lines)
- `src/core/logger.ts` (41 lines) -- NEW in v0.3.0
- `src/core/lock-utils.ts` (34 lines) -- NEW in v0.3.0

**Tests (8 files, 1,553 lines):**
- `tests/unit/registry.test.ts` (119 lines, 14 tests)
- `tests/unit/source-parser.test.ts` (90 lines, 13 tests)
- `tests/unit/formats.test.ts` (163 lines, 18 tests)
- `tests/unit/installer.test.ts` (130 lines, 8 tests)
- `tests/unit/lock.test.ts` (60 lines, 3 tests)
- `tests/unit/mcp-reader.test.ts` (239 lines, 18 tests)
- `tests/unit/marketplace.test.ts` (425 lines, 21 tests) -- Added in v0.2.0
- `tests/unit/instructions.test.ts` (327 lines, 25 tests) -- Added in v0.2.0

**Data (1 file, 1,171 lines):**
- `providers/registry.json` (1,171 lines)

**Total: ~5,177 lines of TypeScript source + 1,553 lines of tests + 1,171 lines of registry JSON**
