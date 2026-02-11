# CLEO MCP Server

**2-gateway CQRS interface for CLEO task management protocol**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://badge.fury.io/js/%40cleocode%2Fmcp-server.svg)](https://badge.fury.io/js/%40cleocode%2Fmcp-server)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-listed-green)](https://registry.modelcontextprotocol.io)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![MCP Protocol](https://img.shields.io/badge/MCP-1.0.0-blue)](https://modelcontextprotocol.io/)

📚 **[Quick Start](docs/QUICK-START.md)** | **[Usage Guide](docs/USAGE-GUIDE.md)** | **[Workflows](docs/WORKFLOWS.md)** | **[API Docs](docs/INDEX.md)**

## Overview

CLEO MCP Server exposes CLEO's CLI and library capabilities through two gateway tools using a CQRS (Command Query Responsibility Segregation) pattern:

- **`cleo_query`** - query operations (read-only)
- **`cleo_mutate`** - mutate operations (state-changing)

Current implementation operation matrix is maintained in:

- `src/gateways/query.ts` (`EXPECTED_QUERY_COUNT=56`)
- `src/gateways/mutate.ts` (`EXPECTED_MUTATE_COUNT=51`)

Total implemented operations: **107** (core contract plus parity extensions).

**Token efficiency**: 2 tools (~1,800 tokens) vs 65 tools (~32,500 tokens) = **94% reduction**

## Features

- **Full CLEO Access**: 107 implemented operations across 8 domains
- **Protocol Enforcement**: RCSD-IVTR lifecycle with exit codes 60-70
- **Anti-Hallucination**: 4-layer validation (schema → semantic → referential → protocol)
- **Safety by Design**: Read operations cannot mutate state
- **Minimal Token Footprint**: 0.9% of 200K context window

## Installation

```bash
npm install @cleocode/mcp-server
```

## Quick Start

### Option A: Auto-Configure (Recommended)

CLEO's CLI auto-detects your installed AI tools and writes configs:

```bash
cleo mcp-install              # Interactive: detect and configure
cleo mcp-install --all        # Non-interactive: configure all detected tools
cleo mcp-install --dry-run    # Preview changes without writing
```

**Supported tools** (12): Claude Code, Claude Desktop, Cursor, Gemini CLI, Kimi, Antigravity, Windsurf, Goose, OpenCode, VS Code, Zed, Codex

See `cleo mcp-install --help` for all options.

### Option B: Manual Configuration

Add to your tool's MCP config:

```json
{
  "mcpServers": {
    "cleo": {
      "command": "npx",
      "args": ["-y", "@cleocode/mcp-server"]
    }
  }
}
```

| Tool | Config Location |
|------|----------------|
| Claude Code | `.mcp.json` (project root) |
| Claude Desktop | `claude_desktop_config.json` (OS-specific) |
| Cursor | `~/.cursor/mcp.json` |
| Gemini CLI | `~/.gemini/settings.json` |
| VS Code | `.vscode/mcp.json` (key: `servers`) |
| Zed | `~/.config/zed/settings.json` (key: `context_servers`, JSONC) |
| OpenCode | `~/.config/opencode/.opencode.json` (key: `mcp`, array command, JSONC) |
| Goose | `.goose/config.yaml` (YAML format) |
| Codex | `~/.codex/config.toml` (TOML format) |

**Goose YAML config example:**

```yaml
# .goose/config.yaml
extensions:
  cleo:
    args:
    - -y
    - '@cleocode/mcp-server'
    cmd: npx
    enabled: true
    name: cleo
    type: stdio
```

For local development installs:

```json
{
  "mcpServers": {
    "cleo": {
      "command": "node",
      "args": ["/path/to/cleo-todo/mcp-server/dist/index.js"]
    }
  }
}
```

## Usage Examples

### Task Management

```typescript
// Find tasks
await cleo_query({
  domain: "tasks",
  operation: "find",
  params: { query: "authentication" }
});

// Create task
await cleo_mutate({
  domain: "tasks",
  operation: "create",
  params: {
    title: "Implement authentication",
    description: "Add JWT-based auth system",
    priority: 1
  }
});

// Complete task
await cleo_mutate({
  domain: "tasks",
  operation: "complete",
  params: {
    taskId: "T2405",
    notes: "Completed successfully"
  }
});
```

### Session Management

```typescript
// Start session
await cleo_mutate({
  domain: "session",
  operation: "start",
  params: {
    scope: "epic:T2400",
    name: "Feature Development",
    autoFocus: true
  }
});

// Set focus
await cleo_mutate({
  domain: "session",
  operation: "focus.set",
  params: { taskId: "T2405" }
});
```

### Orchestration

```typescript
// Initialize orchestration
await cleo_mutate({
  domain: "orchestrate",
  operation: "startup",
  params: { epicId: "T2400" }
});

// Generate spawn prompt
await cleo_mutate({
  domain: "orchestrate",
  operation: "spawn",
  params: {
    taskId: "T2405",
    skill: "ct-task-executor"
  }
});
```

## Domains

### cleo_query (Read-Only)

- **tasks** - get, list, find, exists, tree, blockers, deps, analyze, next, relates
- **session** - status, list, show, focus.get, history
- **orchestrate** - status, next, ready, analyze, context, waves, skill.list
- **research** - show, list, query, pending, stats, manifest.read
- **lifecycle** - check, status, history, gates, prerequisites
- **validate** - schema, protocol, task, manifest, output, compliance.*
- **system** - version, doctor, config.get, stats, context, metrics, health, config, diagnostics, help, job.*, dash, roadmap, labels, compliance, log, archive-stats, sequence

### cleo_mutate (Write Operations)

- **tasks** - create, update, complete, delete, archive, unarchive, reparent, promote, reorder, reopen, relates.add
- **session** - start, end, resume, suspend, focus.set, focus.clear, gc
- **orchestrate** - startup, spawn, validate, parallel.*
- **research** - inject, link, manifest.*
- **lifecycle** - progress, skip, reset, gate.*
- **validate** - compliance.record, test.run
- **release** - prepare, changelog, commit, tag, push, gates.run, rollback
- **system** - init, config.set, backup, restore, migrate, sync, cleanup, audit, job.cancel, safestop, uncancel

## Configuration

Create `.cleo/config.json` in your project:

```json
{
  "mcp": {
    "enabled": true,
    "transport": "stdio",
    "features": {
      "queryCache": true,
      "queryCacheTtl": 30000,
      "auditLog": true,
      "strictValidation": true
    }
  },
  "lifecycleEnforcement": {
    "mode": "strict",
    "allowSkip": ["consensus"]
  }
}
```

## Protocol Enforcement

CLEO enforces the RCSD-IVTR lifecycle pipeline:

```
Research → Consensus → Specification → Decomposition
    ↓
Implementation → Validation → Testing → Release
```

**Exit codes 60-70** indicate protocol violations:

- 60: Research protocol
- 61: Consensus protocol
- 62: Specification protocol
- 63: Decomposition protocol
- 64: Implementation protocol
- 65: Contribution protocol
- 66: Release protocol
- 68: Validation protocol
- 69/70: Testing protocol

## Error Handling

All responses include actionable error information:

```json
{
  "success": false,
  "error": {
    "code": "E_VALIDATION_FAILED",
    "exitCode": 6,
    "message": "Title and description must be different",
    "fix": "Provide a unique description",
    "alternatives": [
      {
        "action": "Use generated description",
        "command": "..."
      }
    ]
  }
}
```

## Requirements

- **Node.js**: >=18.0.0
- **CLEO**: v0.70.0+ installed and initialized
- **Project**: `.cleo/` directory must exist

## Documentation

### Getting Started

- **[Quick Start](docs/QUICK-START.md)** ⚡ - Get started in 5 minutes
- **[Usage Guide](docs/USAGE-GUIDE.md)** 📖 - Comprehensive guide with examples
- **[Workflows](docs/WORKFLOWS.md)** 🔄 - Real-world scenario examples

### Complete API Documentation

- **[Documentation Index](docs/INDEX.md)** - Complete documentation navigation
- **[API Overview](docs/api/overview.md)** - Gateway design and concepts
- **[Error Codes](docs/api/errors.md)** - Complete error reference
- **[Protocols](docs/api/protocols.md)** - RCSD-IVTR protocol enforcement
- **[Examples](docs/examples/task-management.md)** - Complete workflows

### API Reference

- **Gateways**: [cleo_query](docs/api/gateways/cleo_query.md) | [cleo_mutate](docs/api/gateways/cleo_mutate.md)
- **Domains**: [tasks](docs/api/domains/tasks.md) | [session](docs/api/domains/session.md) | [orchestrate](docs/api/domains/orchestrate.md) | [research](docs/api/domains/research.md) | [lifecycle](docs/api/domains/lifecycle.md) | [validate](docs/api/domains/validate.md) | [release](docs/api/domains/release.md) | [system](docs/api/domains/system.md)

### External Resources

- [Full Specification](https://github.com/cleo-dev/cleo-todo/blob/main/docs/specs/MCP-SERVER-SPECIFICATION.md)
- [CLEO Documentation](https://github.com/cleo-dev/cleo-todo)
- [MCP Specification](https://modelcontextprotocol.io/specification)

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run dev

# Test
npm test

# Lint
npm run lint
```

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/cleo-dev/cleo-todo/issues)
- **Documentation**: [CLEO Docs](https://github.com/cleo-dev/cleo-todo/tree/main/docs)

## Credits

Built by the CLEO Development Team for solo developers and AI coding agents.
