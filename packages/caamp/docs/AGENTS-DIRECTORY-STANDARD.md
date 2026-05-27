# The `.agents/` Standard

**Version 1.1.0**
**Status: Draft**

---

## Abstract

This document defines the `.agents/` directory standard — a unified, provider-agnostic convention for organizing agent instructions, skills, knowledge, tool configuration, and project context for AI coding agents. The standard operates at two levels: project-level (`.agents/` at the repository root) and user-level (`~/.agents/` in the user's home directory).

---

## 1. Motivation

AI coding agents require more than a single instruction file. They need structured access to project knowledge, reusable skills, tool integrations, design specifications, and domain context. As the ecosystem matures, the single-file approach cannot scale to meet these needs.

The `.agents/` standard provides a canonical location where any compliant agent — regardless of provider — can discover and consume the full scope of information needed to operate effectively within a codebase.

---

## 2. Directory Locations

### 2.1 Project-Level

```
<project-root>/.agents/
```

Contains agent instructions, skills, knowledge, and configuration scoped to a single project or repository. This directory SHOULD be committed to version control.

### 2.2 User-Level (Global)

```
~/.agents/
```

Contains personal defaults, global skills, and user-specific agent preferences that apply across all projects. This directory SHOULD NOT be committed to version control and MAY be synced between machines at the user's discretion.

Tooling SHOULD allow this location to be overridden via `AGENTS_HOME`.

**Platform paths:**

| Platform | Path |
|----------|------|
| Linux | `$HOME/.agents/` |
| macOS | `$HOME/.agents/` |
| Windows | `%USERPROFILE%\.agents\` |

If `AGENTS_HOME` is set, tools MUST treat it as the canonical global `.agents/` directory.

### 2.3 Standard Platform Discovery Paths

When tools perform platform-aware discovery, they SHOULD use standard system roots instead of a single hardcoded path.

- macOS app bundles: `/Applications` and `~/Applications`
- Linux config root: `$XDG_CONFIG_HOME` or `$HOME/.config`
- Windows config root: `%APPDATA%`

### 2.4 Subdirectory-Level (Optional)

```
<project-root>/packages/api/.agents/
```

For monorepos or large projects, an `.agents/` directory MAY be placed in any subdirectory to provide context-specific instructions. The nearest `.agents/` directory to the file being operated on takes precedence for that scope.

---

## 3. Directory Structure

### 3.1 Complete Reference

```
.agents/
├── AGENTS.md              # Primary agent instructions
├── skills/                # Reusable agent capabilities
│   ├── <skill-name>.md
│   └── ...
├── spec/                  # Requirements, design documents, task definitions
│   ├── <spec-name>.md
│   └── ...
├── wiki/                  # Architecture, domain knowledge, conventions
│   ├── <topic-name>.md
│   └── ...
├── links/                 # External resource references
│   ├── <resource-name>.md
│   └── ...
├── mcp/                   # Model Context Protocol server definitions
│   ├── servers.json       # MCP server registry
│   └── ...
└── config.toml            # Agent tooling settings (optional)
```

All subdirectories are OPTIONAL. A valid `.agents/` directory requires only the `AGENTS.md` file.

### 3.2 Minimal Valid Structure

```
.agents/
└── AGENTS.md
```

---

## 4. `AGENTS.md` — Primary Instructions

### 4.1 Purpose

`AGENTS.md` is the primary entry point for agent instructions. It is a Markdown file containing project context, conventions, build commands, and behavioral directives that agents read before performing any work.

### 4.2 Format

Standard Markdown. No proprietary syntax. Headings provide semantic structure but no specific heading hierarchy is required.

### 4.3 Recommended Sections

```markdown
# Project Name

Brief description of the project.

## Core Commands

Build, test, lint, and deploy commands.

## Architecture Overview

High-level description of major modules and their relationships.

## Conventions & Patterns

Naming, folder layout, code style, and framework-specific patterns.

## Security

Auth flows, API key handling, sensitive data policies.

## Git Workflow

Branching model, commit conventions, PR requirements.
```

### 4.4 Size Guidance

`AGENTS.md` SHOULD remain under 200 lines. If the file grows beyond this, extract content into `wiki/` or `spec/` and reference those files from `AGENTS.md`.

```markdown
## Architecture

See [.agents/wiki/architecture.md](wiki/architecture.md) for full details.
```

---

## 5. `skills/` — Reusable Agent Capabilities

### 5.1 Purpose

The `skills/` directory contains reusable instruction sets that teach agents how to perform specific tasks. Skills are provider-agnostic and can be referenced by any compliant agent.

### 5.2 Structure

Each skill is a single Markdown file named descriptively in kebab-case.

```
skills/
├── code-review.md
├── testing-strategy.md
├── database-migrations.md
├── deployment.md
├── documentation.md
└── performance-audit.md
```

### 5.3 Skill File Format

```markdown
# Skill: Code Review

## Description

Brief description of what this skill enables.

## Instructions

Step-by-step directives the agent should follow when this skill is invoked.

## Constraints

Boundaries, limitations, or things the agent must avoid.

## Examples

Concrete examples of correct application of this skill.
```

### 5.4 Skill Resolution

When an agent requires a skill:

1. Check `<project>/.agents/skills/`
2. Check `~/.agents/skills/`

Project skills override global skills of the same filename.

### 5.5 Global Skills

User-level skills in `~/.agents/skills/` define personal capabilities that apply across all projects. Common use cases:

- Personal code style preferences
- Preferred testing methodologies
- Commit message conventions
- Language-specific patterns

---

## 6. `spec/` — Specifications and Task Definitions

### 6.1 Purpose

The `spec/` directory holds requirements documents, design specifications, feature briefs, and task definitions that agents reference when implementing features or making architectural decisions.

### 6.2 Structure

```
spec/
├── requirements.md
├── data-model.md
├── api-design.md
├── feature-auth-flow.md
└── task-migrate-database.md
```

### 6.3 Conventions

- Prefix task-specific documents with `task-` to distinguish them from standing specifications.
- Specifications SHOULD be written in a structured format that agents can parse unambiguously: clear acceptance criteria, explicit constraints, and concrete examples.
- Large specifications MAY use subdirectories.

```
spec/
├── auth/
│   ├── overview.md
│   ├── oauth-flow.md
│   └── rbac-model.md
└── billing/
    ├── overview.md
    └── stripe-integration.md
```

---

## 7. `wiki/` — Domain Knowledge

### 7.1 Purpose

The `wiki/` directory contains persistent project knowledge: architecture documentation, domain concepts, decision records, onboarding context, and any information that helps an agent understand the *why* behind the codebase.

### 7.2 Structure

```
wiki/
├── architecture.md
├── data-model.md
├── auth-flow.md
├── error-handling.md
├── glossary.md
└── decisions/
    ├── 001-chose-postgres.md
    ├── 002-monorepo-structure.md
    └── 003-event-driven-auth.md
```

### 7.3 Distinction from `spec/`

| | `spec/` | `wiki/` |
|---|---------|---------|
| **Contains** | What to build | How things work |
| **Lifespan** | May be completed/archived | Evolves with the project |
| **Audience** | Agent executing a task | Agent understanding context |
| **Example** | "Implement OAuth with PKCE" | "Our auth system uses OAuth with PKCE because..." |

---

## 8. `links/` — External Resource References

### 8.1 Purpose

The `links/` directory provides agents with references to external resources that are relevant to the project but live outside the repository: design tools, project management boards, dashboards, documentation portals, and third-party services.

### 8.2 Format

Each file is a Markdown document containing structured references.

```
links/
├── design.md
├── project-management.md
├── monitoring.md
└── documentation.md
```

### 8.3 Link File Format

```markdown
# Design Resources

## Figma

- **Main Design System:** https://figma.com/file/xxx
- **Component Library:** https://figma.com/file/yyy

## Brand Guidelines

- **Brand Kit:** https://example.com/brand
```

### 8.4 Usage

Agents SHOULD NOT attempt to fetch or crawl linked resources unless explicitly instructed. Links serve as references the agent can surface to the user or use to understand where authoritative information lives.

---

## 9. `mcp/` — Model Context Protocol Configuration

### 9.1 Purpose

The `mcp/` directory centralizes Model Context Protocol server definitions for the project. This replaces provider-specific MCP configuration files (`.mcp.json`, `mcp_servers` blocks in tool configs, etc.) with a single, provider-agnostic registry.

### 9.2 Structure

```
mcp/
├── servers.json           # Server registry
└── README.md              # Documentation for MCP setup (optional)
```

### 9.3 `servers.json` Schema

```json
{
  "$schema": "https://agents.md/schemas/mcp-servers/v1.json",
  "servers": {
    "<server-name>": {
      "type": "<transport-type>",
      ...transport-specific fields
    }
  }
}
```

#### 9.3.1 Transport Types

**stdio**

```json
{
  "servers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./src"],
      "env": {
        "NODE_ENV": "development"
      }
    }
  }
}
```

**sse**

```json
{
  "servers": {
    "asana": {
      "type": "sse",
      "url": "https://mcp.asana.com/sse"
    }
  }
}
```

**streamable-http**

```json
{
  "servers": {
    "internal-api": {
      "type": "streamable-http",
      "url": "https://mcp.internal.example.com/stream"
    }
  }
}
```

#### 9.3.2 Environment Variable References

Server definitions MAY reference environment variables using `${VAR_NAME}` syntax. Agents MUST resolve these at runtime.

```json
{
  "servers": {
    "database": {
      "type": "stdio",
      "command": "mcp-server-postgres",
      "args": ["${DATABASE_URL}"]
    }
  }
}
```

#### 9.3.3 Scoping

Servers defined in `<project>/.agents/mcp/servers.json` apply to that project only. Servers defined in `~/.agents/mcp/servers.json` are available globally.

Project-level servers override global servers with the same name.

### 9.4 Migration from Legacy Formats

Tools that currently read `.mcp.json`, `mcp_config.json`, or embedded MCP blocks SHOULD:

1. Check `.agents/mcp/servers.json` first
2. Fall back to their legacy location
3. Log a deprecation notice encouraging migration

---

## 10. `config.toml` — Tooling Settings (Optional)

### 10.1 Purpose

`config.toml` holds settings that govern how agent tooling behaves — not what the agent knows, but how the agent infrastructure operates. This is the one file in `.agents/` that is true configuration.

### 10.2 Format

TOML.

### 10.3 Schema

```toml
[agents]
# Maximum combined size of instruction files loaded into context
max_context_bytes = 32768

# File discovery behavior
walk_parents = true

[agents.fallback_filenames]
# Legacy filenames to check if AGENTS.md is not found
filenames = ["CLAUDE.md", "COPILOT.md"]

[skills]
# Whether to load global skills when project skills exist
merge_global = true

[mcp]
# Whether to merge global MCP servers with project servers
merge_global = true
```

### 10.4 Scope

`config.toml` at the project level affects that project. `config.toml` at `~/.agents/` sets user defaults. Project settings override global settings.

---

## 11. Precedence and Resolution

### 11.1 Instruction Precedence

When an agent begins work, it resolves instructions in this order (highest priority first):

1. **User chat prompt** — Explicit instructions in the current conversation
2. **Nearest `.agents/AGENTS.md`** — Closest to the file being edited (subdirectory level)
3. **Project root `.agents/AGENTS.md`** — Repository-level instructions
4. **Project root `AGENTS.md`** — Legacy flat file at project root (backward compatibility)
5. **`~/.agents/AGENTS.md`** — User-level global defaults

### 11.2 Merge Behavior

Instructions at each level are concatenated, with more specific levels appearing later in the combined context. When instructions conflict, the more specific level wins.

Tools MAY implement more sophisticated merge strategies (deep merge, section-level override) at their discretion.

### 11.3 Skill Resolution

1. `<project>/.agents/skills/<name>.md`
2. `~/.agents/skills/<name>.md`

Project skills with the same filename fully replace global skills. If `config.toml` sets `merge_global = false` under `[skills]`, global skills are not loaded when any project skills exist.

### 11.4 MCP Server Resolution

1. `<project>/.agents/mcp/servers.json`
2. `~/.agents/mcp/servers.json`

Servers are merged by name. Project servers override global servers with the same name. If `config.toml` sets `merge_global = false` under `[mcp]`, global servers are excluded when a project `servers.json` exists.

### 11.5 Upward Traversal Guidance

Tools MAY walk parent directories to discover project `.agents/` context. Traversal MUST stop at filesystem root and SHOULD cap traversal depth to avoid unbounded scans.

---

## 12. Backward Compatibility

### 12.1 Legacy `AGENTS.md` at Project Root

Tools MUST support `AGENTS.md` at the project root as a fallback when `.agents/AGENTS.md` does not exist. When both exist, `.agents/AGENTS.md` takes precedence.

### 12.2 Legacy Provider-Specific Files

Tools MAY continue to read their provider-specific files (`CLAUDE.md`, `.cursor/rules`, `.codex/AGENTS.md`, etc.) as a secondary fallback. These SHOULD be treated as deprecated, and tools SHOULD log a notice recommending migration to `.agents/`.

### 12.3 Legacy MCP Configuration

Tools that currently read `.mcp.json` or equivalent files SHOULD check `.agents/mcp/servers.json` first, then fall back to the legacy path.

### 12.4 Migration Path

A project can adopt `.agents/` incrementally:

1. **Phase 1:** Move `AGENTS.md` from project root into `.agents/AGENTS.md`
2. **Phase 2:** Extract sections into `wiki/` and `spec/`
3. **Phase 3:** Consolidate provider-specific rules into `skills/`
4. **Phase 4:** Migrate MCP configuration into `mcp/servers.json`

At each phase, the project remains fully functional with compliant tools.

---

## 13. Version Control

### 13.1 What to Commit

The `.agents/` directory at the project level SHOULD be committed to version control in its entirety, with the following exceptions:

- Files containing secrets or credentials (these MUST NOT be committed)
- Machine-local overrides (use `.agents/.gitignore` for these)

### 13.2 `.gitignore` Guidance

```gitignore
# .agents/.gitignore

# Never commit secrets
*.secret
*.key

# Machine-local overrides
local.toml
```

### 13.3 User-Level Directory

`~/.agents/` is a personal directory and is NOT part of any repository. Users MAY manage it in a separate dotfiles repository at their discretion.

---

## 14. Provider Compliance

### 14.1 Minimum Compliance

A tool is compliant with the `.agents/` standard if it:

1. Reads `.agents/AGENTS.md` at the project root
2. Reads `~/.agents/AGENTS.md` as a global fallback
3. Applies the precedence order defined in Section 11
4. Falls back to legacy `AGENTS.md` at project root when `.agents/` does not exist

### 14.2 Full Compliance

A tool achieves full compliance if it additionally:

1. Reads and resolves `skills/` at both project and global levels
2. Reads `mcp/servers.json` and connects to defined servers
3. Loads `wiki/` and `spec/` content into context when relevant to the current task
4. Respects `config.toml` settings
5. Supports subdirectory-level `.agents/` directories in monorepos

### 14.3 Provider-Specific Extensions

Tools MAY add provider-specific files inside `.agents/` using a namespaced subdirectory:

```
.agents/
├── AGENTS.md
├── skills/
├── _claude/              # Claude-specific extensions
│   └── settings.json
├── _cursor/              # Cursor-specific extensions
│   └── rules.json
└── _codex/               # Codex-specific extensions
    └── overrides.md
```

Provider-specific directories MUST be prefixed with an underscore (`_`) to distinguish them from standard directories. Tools MUST NOT require provider-specific directories for basic operation.

---

## 15. File Format Conventions

### 15.1 Markdown Files

All `.md` files within `.agents/` use standard GitHub-Flavored Markdown. No proprietary extensions.

### 15.2 Configuration Files

- `config.toml` — TOML format
- `servers.json` — JSON format with optional `$schema` reference

### 15.3 Filenames

- Markdown files: `kebab-case.md`
- Directories: `kebab-case/`
- Configuration files: `lowercase.ext`
- Provider-specific directories: `_provider-name/`

### 15.4 Encoding

All text files MUST be UTF-8 encoded.

---

## 16. Security Considerations

### 16.1 Secrets

The `.agents/` directory MUST NOT contain API keys, tokens, passwords, or any other secrets. Environment variable references (`${VAR_NAME}`) SHOULD be used in MCP server definitions and anywhere credentials are needed.

### 16.2 Command Execution

Skills and instructions MAY reference commands for agents to execute. Agents MUST apply their existing permission and sandboxing models when executing commands found in `.agents/` files. The presence of a command in an `.agents/` file does not grant automatic execution permission.

### 16.3 External Resources

Links in `links/` are references only. Agents MUST NOT automatically fetch, crawl, or execute content from external URLs unless the user explicitly requests it in conversation.

---

## 17. Complete Examples

### 17.1 Small Project

```
my-app/
├── .agents/
│   └── AGENTS.md
├── src/
├── package.json
└── README.md
```

### 17.2 Mid-Size Project

```
my-app/
├── .agents/
│   ├── AGENTS.md
│   ├── skills/
│   │   ├── testing.md
│   │   └── code-review.md
│   ├── wiki/
│   │   ├── architecture.md
│   │   └── glossary.md
│   └── mcp/
│       └── servers.json
├── src/
├── tests/
├── package.json
└── README.md
```

### 17.3 Monorepo

```
platform/
├── .agents/
│   ├── AGENTS.md
│   ├── skills/
│   │   ├── shared-testing.md
│   │   └── deployment.md
│   ├── wiki/
│   │   ├── architecture.md
│   │   ├── data-model.md
│   │   └── decisions/
│   │       ├── 001-monorepo.md
│   │       └── 002-event-sourcing.md
│   ├── spec/
│   │   └── api-v2-migration.md
│   ├── links/
│   │   ├── design.md
│   │   └── project-management.md
│   └── mcp/
│       └── servers.json
├── packages/
│   ├── api/
│   │   ├── .agents/
│   │   │   ├── AGENTS.md
│   │   │   └── skills/
│   │   │       └── api-testing.md
│   │   └── src/
│   ├── web/
│   │   ├── .agents/
│   │   │   └── AGENTS.md
│   │   └── src/
│   └── shared/
│       └── src/
└── package.json
```

### 17.4 User Global Directory

```
~/.agents/
├── AGENTS.md
├── skills/
│   ├── my-code-style.md
│   ├── commit-conventions.md
│   └── pr-review-checklist.md
├── mcp/
│   └── servers.json
└── config.toml
```

---

## Appendix A: MIME Types

No custom MIME types are defined. All files use standard types:

| Extension | MIME Type |
|-----------|----------|
| `.md` | `text/markdown` |
| `.json` | `application/json` |
| `.toml` | `application/toml` |

---

## Appendix B: Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `AGENTS_HOME` | Override user-level `.agents/` location | `$HOME/.agents` |
| `AGENTS_DISABLED` | Disable `.agents/` discovery entirely when set to `1` | unset |

---

## Appendix C: JSON Schema Locations

| Schema | URI |
|--------|-----|
| MCP Servers | `https://agents.md/schemas/mcp-servers/v1.json` |
| Config | `https://agents.md/schemas/config/v1.json` |
