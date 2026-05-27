# Provider Configuration Guide

This guide explains how CAAMP maps provider-specific MCP formats, config keys, and file locations.

## Core Concepts

- CAAMP writes MCP settings to each provider's expected config key.
- CAAMP transforms canonical MCP config for providers with custom schemas.
- Skills are installed once in a canonical location and linked to provider skill directories.

## Common Config Keys

- `mcpServers` - most providers
- `mcp_servers` - Codex
- `extensions` - Goose
- `mcp` - OpenCode
- `servers` - VS Code
- `context_servers` - Zed

## Format Mapping

- JSON: most providers
- JSONC: Zed
- YAML: Goose, SWE-Agent
- TOML: Codex

## Scope Behavior

- Project scope writes to provider project config path.
- Global scope writes to provider home/global config path.
- Some providers support only one scope.

## Skills Model

- Canonical path: `getCanonicalSkillsDir()/\<name\>` (default `~/.agents/skills/<name>/`, override via `AGENTS_HOME`)
- Provider installs use symlinks (or fallback copy on Windows).
- Install records are tracked in `getLockFilePath()` (default `~/.agents/.caamp-lock.json`).

## Provider Capabilities

Each provider in the registry has a `capabilities` object with three domains:

### Skills Precedence

Controls how skill files are resolved when both vendor-specific and `.agents/` paths exist:

| Precedence | Behavior |
|-----------|----------|
| `vendor-only` | Uses only the provider's native skills directory |
| `agents-canonical` | Uses only `.agents/skills` (ignores vendor path) |
| `agents-first` | Checks `.agents/skills` first, falls back to vendor |
| `agents-supported` | Checks vendor first, `.agents/skills` as secondary |
| `vendor-global-agents-project` | Global uses vendor; project uses `.agents/skills` + vendor |

Query precedence:

```bash
caamp providers skills-map --human
```

### Hook Events

Providers may support lifecycle hook events:

`onSessionStart`, `onSessionEnd`, `onToolStart`, `onToolComplete`, `onFileChange`, `onError`, `onPromptSubmit`, `onResponseComplete`

Query hook support:

```bash
caamp providers hooks --event onToolComplete --json
```

### Spawn Capabilities

Tracks whether a provider can spawn subagents:

- `supportsSubagents` — Can spawn child agents
- `supportsProgrammaticSpawn` — Spawning available via API
- `supportsInterAgentComms` — Agents can communicate
- `supportsParallelSpawn` — Multiple agents simultaneously
- `spawnMechanism` — `native`, `cli`, `mcp`, or `api`

Query spawn support:

```bash
caamp providers capabilities --filter spawn.supportsSubagents --json
```

## Programmatic API

All capabilities can be queried programmatically:

```typescript
import {
  getProviderCapabilities,
  getProvidersBySkillsPrecedence,
  getProvidersByHookEvent,
  getSpawnCapableProviders,
  providerSupportsById,
} from "@cleocode/caamp";

// Get full capabilities for a provider
const caps = getProviderCapabilities("claude-code");
console.log(caps?.skills.precedence);     // "vendor-only"
console.log(caps?.hooks.supported);       // ["onSessionStart", ...]
console.log(caps?.spawn.spawnMechanism);  // "native"

// Filter providers by capability
const agentsFirst = getProvidersBySkillsPrecedence("agents-first");
const hookProviders = getProvidersByHookEvent("onToolComplete");
const spawnCapable = getSpawnCapableProviders();

// Check specific capability
const supportsSpawn = providerSupportsById("codex", "spawn.supportsSubagents");
```

## Per-Provider Details

Use `caamp providers show <id>` for exact paths, key names, and transport capabilities.

Examples:

```bash
caamp providers show claude-code
caamp providers show codex
caamp providers show zed
```

## Validation

Run the built-in diagnostics after configuration changes:

```bash
caamp doctor
```
