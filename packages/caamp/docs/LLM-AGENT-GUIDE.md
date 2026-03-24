# CAAMP LLM Agent Guide

> **Quick Reference Guide for AI Agents**  
> What you need to know to interact with CAAMP effectively

---

## Overview

CAAMP (Central AI Agent Managed Packages) is a unified provider registry and package manager for AI coding agents. As an LLM agent, you use CAAMP to:

1. **Install skills** - Reusable capabilities across 44+ AI coding agents
2. **Manage MCP servers** - Model Context Protocol servers for tool access
3. **Configure providers** - Set up Claude Code, Cursor, GitHub Copilot, and 41 others
4. **Inject instructions** - Standardize AGENTS.md across all tools

**Key Point:** CAAMP outputs **LAFS-compliant envelopes** (JSON-first). All responses follow the LAFS specification.

---

## Quick Start

### 1. Install CAAMP

```bash
npm install -g @cleocode/caamp
```

### 2. Parse CAAMP Responses

All CAAMP responses are LAFS envelopes:

```typescript
// CAAMP response structure (LAFS-compliant)
interface CAAMPResponse {
  $schema: "https://lafs.dev/schemas/v1/envelope.schema.json";
  _meta: {
    specVersion: "1.0.0";
    schemaVersion: "1.0.0";
    timestamp: string;           // ISO 8601
    operation: string;           // e.g., "skills.list"
    requestId: string;           // Unique ID
    transport: "cli";
    strict: boolean;
    mvi: "minimal" | "standard" | "full" | "custom";
    contextVersion: number;
    sessionId?: string;          // For workflow tracking
    warnings?: Warning[];        // Soft errors
  };
  success: boolean;
  result: object | array | null;
  error?: Error | null;
  page?: Page | null;
  _extensions?: object;          // CAAMP-specific metadata
}
```

### 3. Always Use JSON Format

```bash
# JSON output (default - for agents)
caamp skills list --global --json

# NEVER use --human for programmatic access
# caamp skills list --global --human  ❌ Wrong for agents
```

### 4. Handle the Envelope

```typescript
// Parse CAAMP output
const envelope = JSON.parse(caampOutput);

// Check success
if (!envelope.success) {
  const error = envelope.error;
  console.error(`CAAMP Error ${error.code}: ${error.message}`);
  
  // Retry if applicable
  if (error.retryable) {
    await sleep(error.retryAfterMs || 1000);
    // Retry...
  }
  return;
}

// Access result
const skills = envelope.result.skills;
const count = envelope.result.count;

// Check warnings (non-fatal issues)
if (envelope._meta.warnings) {
  for (const warning of envelope._meta.warnings) {
    console.warn(`Warning: ${warning.message}`);
    if (warning.deprecated) {
      console.warn(`  ${warning.deprecated} → ${warning.replacement}`);
    }
  }
}
```

---

## Core CAAMP Operations

### Install a Skill

```bash
caamp skills install <source> --json --yes
```

**Sources:**
- GitHub repo: `owner/repo`
- GitHub URL: `https://github.com/owner/repo/tree/main/path/to/skill`
- Marketplace: `@scope/skill-name`
- File path: `./local/skill`

**Example:**
```bash
caamp skills install ct-gitbook --json --yes
```

**Response:**
```json
{
  "success": true,
  "result": {
    "installed": [{
      "name": "ct-gitbook",
      "scopedName": "ct-gitbook",
      "canonicalPath": "/home/user/.agents/skills/ct-gitbook",
      "providers": ["claude-code", "cursor"]
    }],
    "failed": [],
    "count": { "installed": 1, "failed": 0, "total": 1 }
  }
}
```

### List Installed Skills

```bash
caamp skills list --global --json
```

**Response:**
```json
{
  "success": true,
  "result": {
    "skills": [
      {
        "name": "ct-gitbook",
        "scopedName": "ct-gitbook",
        "path": "/home/user/.agents/skills/ct-gitbook",
        "metadata": {
          "description": "GitBook platform skill...",
          "version": "1.0.0"
        }
      }
    ],
    "count": 1,
    "scope": "global"
  }
}
```

### Find Skills in Marketplace

```bash
caamp skills find <query> --json
```

**Example:**
```bash
caamp skills find gitbook --json
```

**Response:**
```json
{
  "success": true,
  "result": {
    "query": "gitbook",
    "results": [
      {
        "name": "ct-gitbook",
        "scopedName": "ct-gitbook",
        "description": "GitBook platform integration",
        "source": "catalog"
      }
    ],
    "count": 1,
    "limit": 10
  }
}
```

### Install MCP Server

```bash
caamp mcp install <name> --json --yes
```

**Example:**
```bash
caamp mcp install @anthropic/mcp-server-fetch --json --yes
```

**Response:**
```json
{
  "success": true,
  "result": {
    "installed": [{
      "name": "@anthropic/mcp-server-fetch",
      "providers": ["claude-code"],
      "config": {
        "command": "npx",
        "args": ["-y", "@anthropic/mcp-server-fetch"]
      }
    }]
  }
}
```

### List MCP Servers

```bash
caamp mcp list --json
```

### Detect Installed Providers

```bash
caamp providers detect --json
```

**Response:**
```json
{
  "success": true,
  "result": {
    "installed": [
      {
        "id": "claude-code",
        "toolName": "Claude Code",
        "methods": ["binary", "directory"],
        "projectDetected": false
      }
    ],
    "notInstalled": ["cursor", "codex"],
    "count": { "installed": 1, "total": 44 }
  }
}
```

### Get Provider Details

```bash
caamp providers show <id> --json
```

**Example:**
```bash
caamp providers show claude-code --json
```

---

## Error Handling

### CAAMP Error Categories

| Code Pattern | Meaning | Retryable? |
|--------------|---------|------------|
| `E_VALIDATION_*` | Input invalid | No |
| `E_NOT_FOUND_*` | Resource missing | No |
| `E_INSTALL_FAILED` | Installation failed | Maybe |
| `E_NETWORK_*` | Network error | Yes |
| `E_RATE_LIMIT` | Too many requests | Yes (with delay) |
| `E_FORMAT_*` | Format conflict | No |

### Standard Error Response

```json
{
  "success": false,
  "error": {
    "code": "E_SKILL_NOT_FOUND",
    "message": "Skill 'unknown-skill' not found in marketplace",
    "category": "NOT_FOUND",
    "retryable": false,
    "retryAfterMs": null,
    "details": {
      "skillName": "unknown-skill"
    }
  }
}
```

### Retry Logic

```typescript
async function callCaampWithRetry(command: string[]): Promise<CAAMPResponse> {
  const maxRetries = 3;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await execCaamp(command);
    const envelope = JSON.parse(result);
    
    if (envelope.success) {
      return envelope;
    }
    
    const error = envelope.error;
    
    // Don't retry non-retryable errors
    if (!error.retryable) {
      throw new Error(`${error.code}: ${error.message}`);
    }
    
    // Last attempt failed
    if (attempt === maxRetries) {
      throw new Error(`Max retries exceeded: ${error.code}`);
    }
    
    // Wait before retry
    const delay = error.retryAfterMs ?? (attempt * 1000);
    await sleep(delay);
  }
}
```

---

## Session Management

CAAMP uses LAFS session IDs to track multi-step workflows:

```bash
# Commands in a workflow share session context automatically
caamp skills install skill-a --json
caamp skills install skill-b --json
caamp skills list --json
```

**In responses:**
```json
{
  "_meta": {
    "sessionId": "sess_abc123xyz",
    "contextVersion": 5
  }
}
```

**Use sessions to:**
- Correlate related operations
- Debug multi-step workflows
- Track agent tool usage

---

## Best Practices

### 1. Always Use `--json` Flag

```bash
# ✅ Correct for agents
caamp skills list --global --json

# ❌ Never use --human for programmatic access
caamp skills list --global --human
```

### 2. Use `--yes` to Skip Prompts

```bash
# Non-interactive mode
caamp skills install <skill> --json --yes
caamp mcp install <server> --json --yes
```

### 3. Check Warnings for Deprecations

```typescript
if (envelope._meta.warnings) {
  for (const warning of envelope._meta.warnings) {
    if (warning.deprecated) {
      console.warn(`Deprecation: ${warning.deprecated}`);
      console.warn(`  Replace with: ${warning.replacement}`);
      console.warn(`  Removal date: ${warning.removeBy}`);
    }
  }
}
```

### 4. Use `--quiet` for Minimal Output

```bash
# Suppress non-essential messages
caamp skills list --global --json --quiet
```

### 5. Parse with jq for Shell Scripts

```bash
# Extract specific fields
caamp skills list --global --json | jq -r '.result.skills[].name'

# Filter results
caamp providers detect --json | jq '.result.installed[] | select(.id == "claude-code")'
```

### 6. Handle Partial Success

```typescript
// Installation may partially succeed
const result = envelope.result;

if (result.failed.length > 0) {
  console.warn(`Partial success: ${result.count.installed} installed, ${result.count.failed} failed`);
  for (const failure of result.failed) {
    console.error(`  - ${failure.name}: ${failure.error}`);
  }
}
```

---

## Working with Skills

### Skill Installation Patterns

```bash
# Install from GitHub
caamp skills install owner/repo --json --yes

# Install from marketplace
caamp skills install @scope/skill-name --json --yes

# Install with profile (multiple skills)
caamp skills install --profile core --json --yes
```

### Skill Validation

```bash
# Validate SKILL.md format
caamp skills validate ./path/to/SKILL.md --json
```

### Skill Audit

```bash
# Security scan
caamp skills audit ./path/to/SKILL.md --json

# SARIF output for CI/CD
caamp skills audit ./path/to/SKILL.md --sarif
```

---

## Working with MCP Servers

### MCP Server Installation

```bash
# Install from npm
caamp mcp install @anthropic/mcp-server-fetch --json --yes

# Install from GitHub
caamp mcp install owner/repo --json --yes

# Install with environment variables
caamp mcp install @modelcontextprotocol/server-github --json --yes -- \
  -e GITHUB_PERSONAL_ACCESS_TOKEN=token
```

### MCP Server Detection

```bash
# Auto-detect installed MCP servers
caamp mcp detect --json
```

---

## Provider Management

### List All Providers

```bash
caamp providers list --json
```

### Filter by Priority

```bash
caamp providers list --tier high --json    # Claude, Cursor, Windsurf
caamp providers list --tier medium --json  # Codex, Gemini, Copilot
caamp providers list --tier low --json     # Others
```

### Show Provider Details

```bash
caamp providers show claude-code --json
```

**Response includes:**
- Config keys and formats
- File paths (global and project)
- Supported transports
- Capabilities

---

## Common Workflows

### Setup New Project

```bash
# 1. Detect installed agents
caamp providers detect --json

# 2. Install core skills
caamp skills install --profile core --json --yes

# 3. Install essential MCP servers
caamp mcp install @anthropic/mcp-server-fetch --json --yes
caamp mcp install @modelcontextprotocol/server-github --json --yes

# 4. Verify installation
caamp skills list --json
caamp mcp list --json
```

### Update All Skills

```bash
# Check for updates
caamp skills check --json

# Update all outdated skills
caamp skills update --json --yes
```

### Sync Across Agents

```bash
# Install to all detected agents
caamp skills install <skill> --json --yes --all

# Or specific agents
caamp skills install <skill> --json --yes -a claude-code -a cursor
```

---

## Integration Examples

### TypeScript Integration

```typescript
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface CAAMPResponse {
  success: boolean;
  result: any;
  error?: {
    code: string;
    message: string;
    category: string;
    retryable: boolean;
  };
}

async function callCaamp(args: string[]): Promise<CAAMPResponse> {
  const { stdout } = await execAsync(`caamp ${args.join(' ')} --json`);
  return JSON.parse(stdout);
}

// Usage
const skills = await callCaamp(['skills', 'list', '--global']);
if (skills.success) {
  console.log(`Found ${skills.result.count} skills`);
}
```

### Python Integration

```python
import subprocess
import json

def call_caamp(*args):
    result = subprocess.run(
        ['caamp', *args, '--json'],
        capture_output=True,
        text=True
    )
    return json.loads(result.stdout)

# Usage
response = call_caamp('skills', 'list', '--global')
if response['success']:
    print(f"Found {response['result']['count']} skills")
```

### Shell Integration

```bash
#!/bin/bash

# Install skill and verify
install_skill() {
  local skill_name=$1
  local result=$(caamp skills install "$skill_name" --json --yes)
  
  if echo "$result" | jq -e '.success' > /dev/null; then
    echo "✓ Installed $skill_name"
    return 0
  else
    echo "✗ Failed to install $skill_name"
    echo "$result" | jq '.error.message'
    return 1
  fi
}

# Usage
install_skill "ct-gitbook"
```

---

## CAAMP Extensions

CAAMP uses LAFS `_extensions` for vendor-specific metadata:

```json
{
  "_extensions": {
    "x-caamp-timing": {
      "executionMs": 42,
      "queryMs": 15
    },
    "x-caamp-source": {
      "gitRef": "abc123",
      "apiVersion": "1.0.5"
    }
  }
}
```

**Note:** Extensions are optional. Don't rely on them for core logic.

---

## Resources

- **CAAMP Repository:** https://github.com/kryptobaseddev/caamp
- **npm Package:** https://www.npmjs.com/package/@cleocode/caamp
- **Full Documentation:** https://codluv.gitbook.io/caamp/
- **LAFS Protocol:** https://codluv.gitbook.io/lafs/
- **LAFS LLM Agent Guide:** https://codluv.gitbook.io/lafs/guides/llm-agent-guide

---

## Summary Checklist

When using CAAMP as an LLM agent:

- [ ] Always use `--json` flag for programmatic access
- [ ] Use `--yes` to skip interactive prompts
- [ ] Check `success` flag before accessing `result`
- [ ] Handle `error` objects with retry logic
- [ ] Respect `warnings` for deprecations
- [ ] Use `sessionId` for multi-step workflows
- [ ] Use `--quiet` for minimal output in scripts
- [ ] Handle partial success (some operations may partially fail)
- [ ] Parse with `jq` for shell scripts
- [ ] Don't rely on `_extensions` for core logic

---

## Design Principles

CAAMP follows these principles:

1. **JSON-First** - Machine-readable LAFS envelopes by default
2. **Explicit Human Mode** - `--human` flag required for readable output
3. **Provider Agnostic** - Works across 44+ AI coding agents
4. **Schema-Validated** - All responses conform to LAFS specification
5. **Session Tracking** - Session IDs for workflow correlation
6. **Progressive Disclosure** - Use `--quiet` for MVI (Minimal Viable Information)

---

*Last Updated: 2026-02-18 | CAAMP v1.0.5 | LAFS v1.2.3*
