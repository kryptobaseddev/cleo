<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->

# CAAMP - Central AI Agent Managed Packages

## Project Overview

TypeScript CLI that provides a unified provider registry and package manager for AI coding agents. Single source of truth for all AI agent provider configurations - Skills, MCP, Instructions, and Config management in one tool.

## LAFS Mandate (Required)

CAAMP follows LAFS for agent-facing behavior.

- Canonical protocol source: `https://github.com/kryptobaseddev/lafs/blob/main/lafs.md`
- Package: `@cleocode/lafs`
- CAAMP implementation profile: `docs/LAFS-COMPLIANCE.md`

## Build & Test

```bash
npm run build       # tsup build (ESM + declarations)
npm test            # vitest test suite
npm run typecheck   # TypeScript type checking
npm run dev -- <cmd> # Run CLI via tsx (development)
```

## Project Structure

```
src/
  cli.ts                    # Commander CLI entry point
  index.ts                  # Library barrel export
  types.ts                  # Core type definitions
  commands/                 # CLI command handlers
    providers.ts            # providers list|detect|show
    skills/                 # skills install|remove|list|find|check|update|init|audit|validate
    mcp/                    # mcp install|remove|list|detect
    instructions/           # instructions inject|check|update
    config.ts               # config show|path
  core/
    registry/               # Provider registry (28+ providers)
      providers.ts          # Registry loader + query functions
      detection.ts          # Auto-detection engine
      types.ts              # Registry JSON types
    formats/                # Config file format handlers
      json.ts               # JSON/JSONC (comment-preserving via jsonc-parser)
      yaml.ts               # YAML (js-yaml)
      toml.ts               # TOML (@iarna/toml)
      utils.ts              # deepMerge, nested value helpers
    mcp/                    # MCP server management
      installer.ts          # Config writer + transforms
      transforms.ts         # Per-agent config transforms (Goose, Zed, OpenCode, Codex, Cursor)
      lock.ts               # Lock file management
    skills/                 # Skills management
      installer.ts          # Canonical+symlink install engine
      discovery.ts          # Local SKILL.md discovery
      lock.ts               # Skills lock file
      validator.ts          # SKILL.md validation
      audit/                # Security scanning (46+ rules)
    marketplace/            # Marketplace adapters
      client.ts             # Unified client (adapter pattern)
      skillsmp.ts           # agentskills.in adapter
      skillssh.ts           # skills.sh adapter
    sources/                # Source URL/path handlers
      parser.ts             # Source classifier
      github.ts             # GitHub fetcher
      gitlab.ts             # GitLab fetcher
      wellknown.ts          # RFC 8615 discovery
    instructions/           # Instruction file injection
      injector.ts           # CAAMP marker-based injection
      templates.ts          # Template generation
providers/
  registry.json             # Provider data (single source of truth)
tests/
  unit/                     # Unit tests (vitest)
```

## Coding Conventions

- **TypeScript strict mode** with `noUncheckedIndexedAccess`
- **ESM-only** (`"type": "module"`, `.js` extensions in imports)
- **NodeNext** module resolution
- Provider data lives in `providers/registry.json` (human-editable JSON)
- Comment-preserving config writes via `jsonc-parser`
- Canonical+symlink model for skill installation

## Key Architectural Decisions

1. **Single registry.json** - All 28+ provider definitions in one file
2. **Adapter pattern** for marketplaces - both APIs are optional search backends
3. **Canonical+symlink** - Skills stored once, symlinked to each agent
4. **Per-agent transforms** - 5 agents need custom MCP config shapes
5. **3 instruction files only** - CLAUDE.md, AGENTS.md, GEMINI.md (no CODEX.md/KIMI.md)

## Provider Config Key Mapping

| Key | Providers |
|-----|-----------|
| `mcpServers` | claude-code, claude-desktop, cursor, gemini-cli, most others |
| `mcp_servers` | codex |
| `extensions` | goose |
| `mcp` | opencode |
| `servers` | vscode |
| `context_servers` | zed |

## Release Workflow

- Release workflow triggers on GitHub Release `published` events, **not** tag pushes.
- After tagging (`git tag -a vX.Y.Z`), you **must** create a GitHub Release (`gh release create vX.Y.Z ...`) to trigger npm publish.
- Uses OIDC trusted publishing (no NPM_TOKEN needed).
