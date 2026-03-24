# CAAMP LAFS Compliance Guide

> **Version:** CAAMP v1.0.4+ | **LAFS Protocol:** v1.2.0

## Overview

CAAMP (Central AI Agent Managed Packages) is fully compliant with the **LAFS (LLM-Agent-First Specification)** protocol. This guide documents how CAAMP implements LAFS and how to use it effectively.

---

## What is LAFS?

LAFS is a **response envelope contract specification** designed for software systems whose primary consumer is an LLM agent. It standardizes:

- Response envelope structure
- Error handling and retry semantics
- Context preservation across workflows
- Progressive disclosure (MVI - Minimum Viable Information)

**Key Principles:**
1. **MVI (Minimum Viable Information)** - Default responses are lean
2. **Progressive Disclosure** - Request more detail when needed
3. **Transport Agnosticism** - Same envelope over HTTP, gRPC, CLI
4. **Schema-First Design** - Machine-verifiable contracts

---

## Output Formats

CAAMP supports exactly two LAFS-compliant formats:

### 1. JSON (Default)

Machine-readable LAFS envelopes for programmatic consumption.

```bash
# Default - outputs LAFS envelope JSON
caamp skills list --global

# Explicit JSON flag
caamp skills list --global --json
```

**Example Output:**
```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "2026-02-18T12:00:00Z",
    "operation": "skills.list",
    "requestId": "req_abc123",
    "transport": "cli",
    "strict": true,
    "mvi": "standard",
    "contextVersion": 0,
    "sessionId": "sess_xyz789"
  },
  "success": true,
  "result": {
    "skills": [...],
    "count": 42
  },
  "error": null,
  "page": null
}
```

### 2. Human (Explicit Opt-In)

Human-readable formatted output for terminal display.

```bash
# Global human flag
caamp --human skills list --global

# Command-level human flag
caamp skills list --global --human
```

**Note:** Human-readable mode requires **explicit opt-in** (`--human` flag). This is a LAFS requirement.

---

## LAFS Envelope Structure

### Core Fields

| Field | Type | Description |
|-------|------|-------------|
| `$schema` | string | Schema URL for validation |
| `_meta` | object | Metadata about the response |
| `success` | boolean | true = success, false = error |
| `result` | object/array/null | Success data |
| `error` | object/null | Error details if success=false |
| `page` | object/null | Pagination metadata |
| `_extensions` | object | Vendor-specific extensions |

### _meta Fields

| Field | Type | Description |
|-------|------|-------------|
| `specVersion` | string | LAFS spec version (e.g., "1.0.0") |
| `schemaVersion` | string | Schema version |
| `timestamp` | string | ISO 8601 timestamp |
| `operation` | string | Operation identifier (e.g., "skills.list") |
| `requestId` | string | Unique request ID |
| `transport` | string | "cli", "http", "grpc", or "sdk" |
| `strict` | boolean | Schema validation mode |
| `mvi` | string | "minimal", "standard", "full", or "custom" |
| `contextVersion` | number | Ledger version for state tracking |
| `sessionId` | string | **(CAAMP v1.0.4+)** Session identifier for workflows |
| `warnings` | array | **(CAAMP v1.0.4+)** Non-fatal warnings |

---

## Session Management (v1.0.4+)

CAAMP supports LAFS session IDs for correlating multi-step workflows:

```bash
# Commands automatically include sessionId in _meta
# Use for tracking related operations
caamp skills install my-skill
caamp skills list

# Both responses will have the same sessionId if part of the same workflow
```

**In JSON output:**
```json
{
  "_meta": {
    "sessionId": "sess_abc123xyz",
    "contextVersion": 5
  }
}
```

---

## Warnings (v1.0.4+)

CAAMP uses LAFS warnings for soft errors that don't fail the operation:

```json
{
  "_meta": {
    "warnings": [
      {
        "code": "W_DEPRECATED",
        "message": "Field 'legacyId' is deprecated, use 'id'",
        "deprecated": "legacyId",
        "replacement": "id",
        "removeBy": "2026-06-01"
      }
    ]
  }
}
```

**Use Cases:**
- Deprecated field usage
- Partial success scenarios
- Non-fatal configuration issues
- Rate limit approaching (soft warning)

---

## Quiet Mode (v1.0.4+)

Suppress non-essential output for scripting:

```bash
# Quiet mode - reduces verbosity
caamp skills list --global --json --quiet

# Or use global flag
caamp --quiet skills list --global
```

**Behavior:**
- Suppresses informational/progress messages
- Still outputs LAFS envelope (if `--json`)
- Still outputs errors
- Useful for CI/CD pipelines

---

## Error Handling

### Error Structure

```json
{
  "success": false,
  "error": {
    "code": "E_SKILL_NOT_FOUND",
    "message": "Skill 'my-skill' not found",
    "category": "NOT_FOUND",
    "retryable": false,
    "retryAfterMs": null,
    "details": {
      "skillName": "my-skill"
    }
  }
}
```

### Error Categories

| Category | Meaning | Retryable? |
|----------|---------|------------|
| VALIDATION | Input invalid | No |
| AUTH | Not authenticated | No |
| PERMISSION | Not authorized | No |
| NOT_FOUND | Resource missing | No |
| CONFLICT | State conflict | No |
| RATE_LIMIT | Too many requests | Yes (after delay) |
| TRANSIENT | Temporary failure | Yes |
| INTERNAL | Server error | Maybe |
| CONTRACT | Protocol violation | No |
| MIGRATION | Version mismatch | No |

### Retry Logic

```typescript
// Check if error is retryable
if (envelope.error?.retryable) {
  const delay = envelope.error.retryAfterMs ?? 1000;
  await sleep(delay);
  // Retry request
}
```

---

## Command Reference

### All Commands Support

| Flag | Description |
|------|-------------|
| `--json` | Output LAFS envelope JSON (default) |
| `--human` | Output human-readable format |
| `--quiet` | Suppress non-essential output |
| `-v, --verbose` | Show debug output |
| `-q, --quiet` | Suppress non-error output |

### Skills Commands

```bash
# List skills (JSON)
caamp skills list --global

# List skills (human-readable)
caamp skills list --global --human

# Find skills
caamp skills find gitbook

# Install skill
caamp skills install <source>

# Remove skill
caamp skills remove <name>

# Check for updates
caamp skills check

# Update skills
caamp skills update

# Audit skill
caamp skills audit <path>

# Validate skill
caamp skills validate <path>

# Initialize new skill
caamp skills init <name>
```

### Provider Commands

```bash
# List providers
caamp providers list

# Detect installed providers
caamp providers detect

# Show provider details
caamp providers show <id>
```

### MCP Commands

```bash
# List MCP servers
caamp mcp list

# Install MCP server
caamp mcp install <name>

# Remove MCP server
caamp mcp remove <name>

# Detect MCP servers
caamp mcp detect
```

### Other Commands

```bash
# Doctor (health check)
caamp doctor

# Config management
caamp config show <provider>
caamp config path <provider>

# Instructions
caamp instructions check
caamp instructions inject
caamp instructions update
```

---

## Best Practices

### 1. Always Check Success First

```typescript
// ❌ Don't assume success
const data = envelope.result.items;

// ✅ Check success flag
if (!envelope.success) {
  handleError(envelope.error);
  return;
}
const data = envelope.result;
```

### 2. Handle Warnings Gracefully

```typescript
if (envelope._meta.warnings) {
  for (const warning of envelope._meta.warnings) {
    if (warning.deprecated) {
      console.warn(`Deprecation: ${warning.deprecated} will be removed by ${warning.removeBy}`);
      console.warn(`Use ${warning.replacement} instead`);
    }
  }
}
```

### 3. Use Session IDs for Workflows

```bash
# Related operations automatically share session context
caamp skills install skill-a
caamp skills install skill-b
caamp skills list
```

### 4. Respect Pagination

```typescript
// Check for more results
if (envelope.page?.hasMore) {
  // Fetch next page
  const nextPage = await fetchNext(envelope.page);
}
```

### 5. Prefer JSON for Scripting

```bash
# Parse with jq
caamp skills list --global | jq '.result.skills[0].name'

# Extract specific fields
caamp providers list --json | jq -r '.result.providers[] | "\(.id): \(.toolName)"'
```

---

## Migration from CAAMP v1.0.3 and Earlier

### Breaking Changes

**Default output changed from human-readable to JSON.**

**Before (v1.0.3):**
```bash
caamp skills list
# Output: Human-readable table
```

**After (v1.0.4+):**
```bash
caamp skills list
# Output: LAFS envelope JSON

caamp skills list --human
# Output: Human-readable table
```

### Migration Guide

1. **Interactive use:** Add `--human` to your commands
   ```bash
   # Add to ~/.bashrc or ~/.zshrc
   alias caamp='caamp --human'
   ```

2. **Scripting:** No changes needed (JSON is better for scripts)

3. **CI/CD:** Use `--quiet` for cleaner output
   ```bash
   caamp skills list --json --quiet
   ```

---

## Extensions (_extensions)

CAAMP uses `_extensions` for vendor-specific metadata:

```json
{
  "_extensions": {
    "x-caamp-timing": {
      "executionMs": 42
    },
    "x-caamp-source": {
      "gitRef": "abc123"
    }
  }
}
```

**Note:** Extension fields are optional. Don't rely on them for core logic.

---

## Resources

- **LAFS Protocol:** https://codluv.gitbook.io/lafs/
- **LAFS LLM Agent Guide:** https://codluv.gitbook.io/lafs/guides/llm-agent-guide
- **CAAMP Repository:** https://github.com/kryptobaseddev/caamp
- **npm Package:** https://www.npmjs.com/package/@cleocode/caamp

---

## Design Principles

CAAMP follows LAFS design principles:

1. **Machine-First:** JSON envelopes are default
2. **Explicit Human Mode:** `--human` flag required for human-readable output
3. **Transport Agnostic:** Same envelope structure regardless of transport
4. **Schema Validated:** All responses conform to LAFS schema
5. **Context Preservation:** Session IDs track multi-step workflows
6. **Progressive Disclosure:** MVI levels control verbosity

---

## Support

For issues or questions:
- **CAAMP Issues:** https://github.com/kryptobaseddev/caamp/issues
- **LAFS Protocol:** https://github.com/kryptobaseddev/lafs/issues

---

*Last Updated: 2026-02-18 | CAAMP v1.0.4 | LAFS v1.2.0*
