# CAAMP: Central AI Agent Managed Packages

> **Version:** 1.0.5 | **Status:** Production Ready  
> **Protocol:** LAFS v1.2.3 Compliant  
> **Repository:** https://github.com/kryptobaseddev/caamp

---

## 1. Scope

CAAMP is a unified provider registry and package manager for AI coding agents. It manages:

- **Skills** - Reusable capabilities (SKILL.md files) across 44+ AI coding agents
- **MCP Servers** - Model Context Protocol server configurations
- **Provider Configurations** - Agent-specific config file management
- **Instruction Files** - Standardized AGENTS.md injection across tools

CAAMP adopts **LAFS (LLM-Agent-First Specification)** for all agent-facing output contracts. Protocol authority lives in the standalone LAFS repository and package.

---

## 2. Non-Goals

CAAMP does NOT:

1. **Replace agent-specific CLIs** - Claude Code, Cursor, etc. remain separate tools
2. **Define AI models or capabilities** - CAAMP manages configuration, not AI logic
3. **Provide cloud hosting** - CAAMP is a local CLI tool
4. **Lock users into specific agents** - CAAMP supports 44+ providers with easy migration
5. **Manage secrets** - API keys and tokens are user-managed (referenced via env vars)

---

## 3. Core Concepts

### 3.1 Skills Model

Skills are reusable capabilities distributed as SKILL.md files with metadata.

**Installation Pattern:**
- **Canonical copy** stored at `~/.agents/skills/<skill-name>/`
- **Symlinks** created in each provider's skills directory
- **Lock file** tracks installations at `~/.agents/.caamp-lock.json`

### 3.2 MCP Server Model

MCP (Model Context Protocol) servers provide tool capabilities to agents.

**Configuration Pattern:**
- CAAMP writes MCP configs to each provider's config file
- Transforms config shape per provider (Goose, Zed, OpenCode, etc.)
- Supports environment variable injection

### 3.3 Provider Registry

Single source of truth for 44+ AI coding agents in `providers/registry.json`.

**Provider Definition Includes:**
- ID, name, vendor, priority tier
- Config format (JSON, JSONC, YAML, TOML)
- Config key mapping (`mcpServers`, `mcp_servers`, `extensions`, etc.)
- File paths (global and project scopes)
- Supported transports and capabilities

---

## 4. CLI Interface

### 4.1 Command Groups

| Group | Purpose |
|-------|---------|
| `providers` | List, detect, and show provider details |
| `skills` | Install, remove, list, find, validate, audit skills |
| `mcp` | Install, remove, list, detect MCP servers |
| `instructions` | Inject, check, update instruction files |
| `config` | Show and manage provider configurations |
| `doctor` | Health checks and diagnostics |
| `advanced` | LAFS-compliant batch operations |

### 4.2 Global Flags

| Flag | Description |
|------|-------------|
| `-a, --agent <name>` | Target specific agent (repeatable) |
| `-g, --global` | Use global scope (default: project) |
| `-y, --yes` | Skip confirmation prompts |
| `--all` | Target all detected agents |
| `--json` | Output LAFS envelope JSON (default) |
| `--human` | Output human-readable format |
| `--quiet` | Suppress non-essential output |
| `-v, --verbose` | Show debug output |
| `-q, --quiet` | Suppress non-error output |

### 4.3 Output Format

**Default: LAFS-compliant JSON**

```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "2026-02-18T00:00:00Z",
    "operation": "skills.list",
    "requestId": "req_abc123",
    "transport": "cli",
    "strict": true,
    "mvi": "standard",
    "contextVersion": 0,
    "sessionId": "sess_xyz789"
  },
  "success": true,
  "result": { ... },
  "error": null,
  "page": null
}
```

**Explicit Opt-In: Human-Readable**

```bash
caamp --human skills list --global
```

---

## 5. Skills Specification

### 5.1 Skill Structure

```
~/.agents/skills/<skill-name>/
├── SKILL.md           # Required: Skill documentation
├── metadata.json      # Optional: Version, author, tags
├── assets/            # Optional: Images, examples
└── references/        # Optional: External docs
```

### 5.2 SKILL.md Format

Frontmatter + Markdown content:

```markdown
---
name: skill-name
description: What this skill does
version: 1.0.0
author: @owner
tags: [tag1, tag2]
---

# Skill Title

## Usage

When to use this skill...

## Examples

Example usage...
```

### 5.3 Installation Sources

| Source Type | Format | Example |
|-------------|--------|---------|
| GitHub shorthand | `owner/repo` | `kryptobaseddev/caamp` |
| GitHub URL | Full URL | `https://github.com/owner/repo/tree/main/skill` |
| Marketplace | `@scope/name` | `@cleocode/ct-gitbook` |
| File path | Local path | `./local/skill` |

---

## 6. MCP Server Specification

### 6.1 MCP Config Structure

Per-provider config with automatic shape transformation:

**Claude Code (JSON):**
```json
{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-fetch"]
    }
  }
}
```

**Goose (YAML):**
```yaml
extensions:
  server-name:
    cmd: npx
    args: ["-y", "@anthropic/mcp-server-fetch"]
```

### 6.2 Environment Variables

CAAMP supports env var injection via repeatable `--env KEY=VALUE`
flags. The provider id is required so the install knows which
config file to write to:

```bash
caamp mcp install github --provider claude-desktop \
  --env GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx -- \
  npx -y @modelcontextprotocol/server-github
```

---

## 7. Provider Registry Schema

### 7.1 Provider Entry

```typescript
interface Provider {
  id: string;                    // Unique identifier
  agentFlag: string;             // CLI flag name
  toolName: string;              // Display name
  vendor: string;                // Company/organization
  priority: "high" | "medium" | "low";
  status: "active" | "beta" | "deprecated";
  
  // Config
  configFormat: "json" | "jsonc" | "yaml" | "toml";
  configKey: string;             // mcpServers, mcp, extensions, etc.
  
  // Paths
  pathGlobal: string;
  pathProject?: string;
  configPathGlobal: string;
  configPathProject?: string;
  pathSkills: string;
  pathProjectSkills?: string;
  
  // Capabilities
  supportedTransports: string[];
  supportsHeaders: boolean;
  
  // Aliases
  aliases: string[];
}
```

### 7.2 Priority Tiers

| Tier | Providers | Description |
|------|-----------|-------------|
| **High** | Claude Code, Cursor, Windsurf | Primary commercial tools |
| **Medium** | Codex, Gemini, Copilot, OpenCode, etc. | Major alternatives |
| **Low** | Roo, Continue, Goose, etc. | Community/emerging tools |

---

## 8. Lock File Specification

Location: `~/.agents/.caamp-lock.json`

```json
{
  "version": "1.0.0",
  "skills": {
    "skill-name": {
      "version": "1.0.0",
      "source": "github:owner/repo",
      "installedAt": "2026-02-18T00:00:00Z",
      "providers": ["claude-code", "cursor"]
    }
  },
  "mcpServers": {
    "server-name": {
      "version": "1.0.0",
      "source": "npm:@anthropic/mcp-server-fetch",
      "installedAt": "2026-02-18T00:00:00Z",
      "providers": ["claude-code"]
    }
  }
}
```

---

## 9. Error Codes

CAAMP uses LAFS error codes with `E_CAAMP_*` prefix:

| Code | Category | Description |
|------|----------|-------------|
| `E_CAAMP_SKILL_NOT_FOUND` | NOT_FOUND | Skill not in marketplace/registry |
| `E_CAAMP_SKILL_INSTALL_FAILED` | INTERNAL | Installation error |
| `E_CAAMP_MCP_NOT_FOUND` | NOT_FOUND | MCP server not found |
| `E_CAAMP_PROVIDER_NOT_FOUND` | NOT_FOUND | Provider ID invalid |
| `E_CAAMP_CONFIG_PARSE_ERROR` | VALIDATION | Config file unreadable |
| `E_CAAMP_NETWORK_ERROR` | TRANSIENT | Fetch/download failed |
| `E_CAAMP_FORMAT_CONFLICT` | VALIDATION | --json and --human both provided |

---

## 10. LAFS Compliance

CAAMP is fully LAFS-compliant:

### 10.1 Format Compliance

- ✅ Default format: JSON (LAFS envelope)
- ✅ Explicit human mode: `--human` flag
- ✅ Format conflict rejection: Error if both flags

### 10.2 Envelope Compliance

- ✅ `$schema`: LAFS schema URL
- ✅ `_meta`: All required fields
- ✅ `success`/`result`/`error`: Proper semantics
- ✅ `sessionId`: Workflow correlation
- ✅ `warnings`: Soft error support

### 10.3 Error Compliance

- ✅ Structured error codes
- ✅ Retryable flag
- ✅ Error categories
- ✅ Detailed error messages

---

## 11. Session Management

CAAMP uses LAFS session IDs for workflow tracking:

```typescript
// Multi-step workflows share session context
caamp skills install skill-a --json  // sessionId: sess_abc
caamp skills install skill-b --json  // sessionId: sess_abc (same)
caamp skills list --json             // sessionId: sess_abc (same)
```

**Use Cases:**
- Debug multi-step operations
- Track agent tool usage
- Correlate related commands

---

## 12. Extensions

CAAMP-specific extensions in `_extensions`:

```json
{
  "_extensions": {
    "x-caamp-timing": {
      "executionMs": 42,
      "queryMs": 15
    },
    "x-caamp-source": {
      "gitRef": "abc123",
      "version": "1.0.5"
    }
  }
}
```

**Note:** Extensions are optional. Don't rely on them for core functionality.

---

## 13. Best Practices

### For AI Agents

1. **Always use `--json`** for programmatic access
2. **Use `--yes`** to skip interactive prompts
3. **Check `success` flag** before accessing `result`
4. **Handle `warnings`** for deprecations
5. **Respect `sessionId`** for workflow tracking

### For Users

1. **Use `--human`** for interactive terminal use
2. **Use `--quiet`** for scripting
3. **Check lock file** for installation tracking
4. **Run `doctor`** to diagnose issues

---

## 14. Resources

- **Full Documentation:** https://codluv.gitbook.io/caamp/
- **LLM Agent Guide:** https://codluv.gitbook.io/caamp/guides/llm-agent-guide
- **npm Package:** https://www.npmjs.com/package/@cleocode/caamp
- **GitHub:** https://github.com/kryptobaseddev/caamp
- **LAFS Protocol:** https://codluv.gitbook.io/lafs/

---

## 15. Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.5 | 2026-02-18 | LAFS v1.2.3, sessionId, warnings, quiet mode |
| 1.0.4 | 2026-02-18 | LAFS v1.2.0 compliance, MVILevel types |
| 1.0.3 | 2026-02-17 | JSON-first output, --human flag |
| 1.0.2 | 2026-02-17 | GitHub URL parsing fixes, npm metadata |
| 1.0.1 | 2026-02-15 | Coverage fixes, defensive guards |
| 1.0.0 | 2026-02-14 | Production release |

---

## 16. License

MIT License - See LICENSE file

---

*CAAMP: One CLI to manage Skills, MCP servers, and instruction files across 44+ AI coding agents.*
