# Manifest Operations Reference

**Provenance**: T3154 (Epic: T3147) - Single-source reference for all manifest operations
**Status**: ACTIVE
**Version**: 1.0.0

This reference defines all CLI operations for managing the agent outputs manifest (`MANIFEST.jsonl`). Skills and protocols SHOULD reference this file instead of duplicating JSONL instructions.

---

## Overview

The manifest system provides O(1) append operations and race-condition-free concurrent writes through JSONL format. Each line is a complete JSON object representing one research/output entry.

**Default Paths**:
- Output directory: `claudedocs/agent-outputs/` (configurable via `agentOutputs.directory`)
- Manifest file: `MANIFEST.jsonl` (configurable via `agentOutputs.manifestFile`)
- Full path: `{{OUTPUT_DIR}}/MANIFEST.jsonl` (i.e., `claudedocs/agent-outputs/MANIFEST.jsonl`)

**Design Principles**:
- Append-only writes preserve audit trail
- Single-line corruption doesn't corrupt entire file
- Concurrent writes are safe (atomic line appends)
- Orchestrators read manifest summaries, NOT full files

---

## CLI Commands

### cleo research add

Create a new manifest entry for agent output.

**Usage**:
```bash
cleo research add \
  --task T#### \
  --topic "topic-slug" \
  [--findings "Finding 1,Finding 2,Finding 3"] \
  [--sources "source1,source2"]
```

**Required Flags**:
| Flag | Description | Example |
|------|-------------|---------|
| `--task` | Task ID to attach research to | `T3154` |
| `--topic` | Research topic (slug) | `"jwt-authentication"` |

**Optional Flags**:
| Flag | Description | Example |
|------|-------------|---------|
| `--findings` | Comma-separated key findings | `"JWT tokens expire in 1h,OAuth2 preferred"` |
| `--sources` | Comma-separated source references | `"https://example.com,RFC 7519"` |

**Agent Type Values** (RCASD-IVTR+C protocol + workflow types):
- **Protocol types**: `research`, `consensus`, `specification`, `decomposition`, `implementation`, `contribution`, `release`
- **Workflow types**: `validation`, `documentation`, `analysis`, `testing`, `cleanup`, `design`, `architecture`, `report`
- **Extended types**: `synthesis`, `orchestrator`, `handoff`, `verification`, `review`
- **Skill types**: Any `ct-*` prefix (e.g., `ct-orchestrator`)

**Example**:
```bash
cleo research add \
  --task T3154 \
  --topic "jwt-authentication" \
  --findings "Use RS256 for asymmetric signing,Tokens expire in 1h,Refresh tokens stored securely" \
  --sources "RFC 7519,OWASP JWT Cheat Sheet"
```

**Output**: JSON with created entry ID
```json
{
  "success": true,
  "entryId": "jwt-authentication-2026-02-07",
  "manifestPath": "claudedocs/agent-outputs/MANIFEST.jsonl"
}
```

---

### cleo research update

Update an existing manifest entry.

**Usage**:
```bash
cleo research update <entry-id> \
  [--findings "F1,F2,F3"] \
  [--sources "S1,S2"] \
  [--status STATUS]
```

**Parameters**:
- `<entry-id>`: Entry ID from manifest (e.g., `jwt-authentication-2026-02-07`)

**Flags**:
| Flag | Description |
|------|-------------|
| `--findings` | Updated comma-separated findings |
| `--sources` | Updated comma-separated sources |
| `--status` | Updated status (`complete`, `partial`, `blocked`) |

**Example**:
```bash
cleo research update jwt-authentication-2026-02-07 \
  --status partial \
  --findings "Finding 1,Finding 2 (revised)"
```

---

### cleo research list

Query and filter manifest entries.

**Usage**:
```bash
cleo research list \
  [--status STATUS] \
  [--task T####] \
  [--limit N]
```

**Filter Options**:
| Flag | Description | Example |
|------|-------------|---------|
| `--status` | Filter by status | `complete`, `partial`, `blocked`, `pending` |
| `--task` | Filter by task ID | `T3154` |
| `--limit` | Max results | `20` |

**Example**:
```bash
# Entries for a specific task
cleo research list --task T3154 --limit 10

# Partial entries
cleo research list --status partial
```

**Output**: JSON array with manifest entries
```json
{
  "success": true,
  "count": 3,
  "entries": [
    {
      "id": "jwt-auth-2026-02-07",
      "title": "JWT Authentication Best Practices",
      "status": "complete",
      "topics": ["authentication", "jwt", "security"],
      "key_findings": ["Use RS256...", "Tokens expire...", "Refresh tokens..."]
    }
  ]
}
```

---

### cleo research show

Display details of a specific manifest entry.

**Usage**:
```bash
cleo research show <entry-id> [--full | --findings-only]
```

**Parameters**:
- `<entry-id>`: Entry ID from manifest

**Options**:
| Flag | Description | Default |
|------|-------------|---------|
| `--findings-only` | Only show key_findings array | ✓ |
| `--full` | Include full file content (WARNING: large context) | |

**Example**:
```bash
# Minimal output (just key findings)
cleo research show jwt-auth-2026-02-07

# Full entry metadata
cleo research show jwt-auth-2026-02-07 --full
```

**Output**: JSON with entry details
```json
{
  "success": true,
  "entry": {
    "id": "jwt-auth-2026-02-07",
    "file": "2026-02-07_jwt-auth.md",
    "title": "JWT Authentication Best Practices",
    "date": "2026-02-07",
    "status": "complete",
    "topics": ["authentication", "jwt", "security"],
    "key_findings": [
      "Use RS256 for asymmetric signing",
      "Tokens expire in 1h",
      "Refresh tokens stored securely"
    ],
    "actionable": true,
    "needs_followup": [],
    "linked_tasks": ["T3154"]
  }
}
```

---

### cleo research link

Link a research entry to a task (bidirectional association).

**Usage**:
```bash
cleo research link <research-id> <task-id>
```

**Parameters**:
- `<research-id>`: Entry ID from manifest
- `<task-id>`: Task ID (e.g., `T3154`)

**Example**:
```bash
cleo research link jwt-auth-2026-02-07 T3154
```

**Effects**:
- Adds research ID to task's `.linkedResearch` array
- Adds task ID to manifest entry's `linked_tasks` array
- Creates bidirectional reference for discovery

**Verify Link**:
```bash
cleo show T3154  # Check .linkedResearch array
cleo research show jwt-auth-2026-02-07  # Check linked_tasks
```

---

### cleo research unlink

> **Note**: Not currently implemented in the CLI. To disassociate research from a task, use
> `cleo research update <id>` to change status, or remove the link manually from the task record.

---

### cleo research links

Show all research linked to a specific task.

**Usage**:
```bash
cleo research links <task-id>
```

**Example**:
```bash
cleo research links T3154
```

**Output**: JSON array of linked research entries

---

### cleo research pending

Show entries with `status: pending` (orchestrator handoffs).

**Usage**:
```bash
cleo research pending
```

**Example**:
```bash
cleo research pending
```

**Output**: JSON array of entries requiring followup
```json
{
  "success": true,
  "count": 2,
  "entries": [
    {
      "id": "partial-research-2026-02-06",
      "title": "Incomplete Analysis",
      "status": "partial",
      "needs_followup": ["T3155", "T3156"]
    }
  ]
}
```

---

### cleo research archive

Archive old manifest entries to maintain context efficiency.

**Usage**:
```bash
cleo research archive [--before-date YYYY-MM-DD]
```

**Options**:
| Flag | Description |
|------|-------------|
| `--before-date` | Archive entries created before this date (ISO 8601) |

**Example**:
```bash
# Archive entries older than a cutoff date
cleo research archive --before-date 2026-01-01
```

**Effects**:
- Moves matching entries to archive storage
- Reduces active manifest size for context efficiency

---

### cleo research archive-list

> **Note**: Not currently implemented in the CLI. To list archived entries, use
> `cleo research list --status archived` or query the archive file directly.

---

### cleo research status

> **Note**: Not currently implemented as a separate CLI command. Use `cleo research stats`
> for manifest statistics.

---

### cleo research stats

Show comprehensive manifest statistics.

**Usage**:
```bash
cleo research stats
```

**Output**: JSON with detailed statistics
```json
{
  "success": true,
  "stats": {
    "totalEntries": 42,
    "byStatus": {
      "complete": 35,
      "partial": 5,
      "blocked": 2
    },
    "byAgentType": {
      "research": 20,
      "implementation": 15,
      "validation": 7
    },
    "actionableCount": 38,
    "needsFollowupCount": 7
  }
}
```

---

### cleo research validate

> **Note**: Not currently implemented in the CLI. Manifest validation occurs automatically
> when entries are created via `cleo research add`.

---

### cleo research compact

> **Note**: Not currently implemented in the CLI. Use `cleo research archive` to manage
> manifest size.

---

### cleo research get

> **Note**: Not currently implemented as a separate CLI command. Use `cleo research show <id>`
> for entry details.

---

### cleo research inject

> **Note**: Not currently implemented in the CLI. The orchestrator generates fully-resolved
> subagent prompts via `cleo orchestrator spawn <taskId>` or
> `mutate({ domain: "orchestrate", operation: "spawn", params: { taskId } })`.

---

## Manifest Entry Schema

### Required Fields

| Field | Type | Description | Constraints |
|-------|------|-------------|-------------|
| `id` | string | Unique identifier | Format: `{topic-slug}-{date}` or `T####-{slug}` |
| `file` | string | Output file path | Relative to manifest directory |
| `title` | string | Human-readable title | Non-empty |
| `date` | string | Entry creation date | ISO 8601: YYYY-MM-DD |
| `status` | enum | Entry status | `complete`, `partial`, `blocked`, `archived` |
| `topics` | array | Categorization tags | Array of strings |
| `key_findings` | array | Key findings (1-7 items) | Array of strings, 1-7 items, one sentence each |
| `actionable` | boolean | Requires action | `true` or `false` |

### Optional Fields

| Field | Type | Description | Default |
|-------|------|-------------|---------|
| `agent_type` | string | Agent/protocol type | `research` |
| `needs_followup` | array | Task IDs requiring attention | `[]` |
| `linked_tasks` | array | Associated task IDs | `[]` |
| `audit` | object | Audit metadata (T2578) | See audit schema |

### Audit Object Schema (v2.10.0+)

When present, the `audit` field provides operational metadata:

```json
{
  "audit": {
    "created": {
      "timestamp": "2026-02-07T05:00:00Z",
      "agent": "cleo-subagent",
      "taskId": "T3154"
    },
    "updated": {
      "timestamp": "2026-02-07T06:00:00Z",
      "agent": "ct-orchestrator",
      "reason": "Status change to partial"
    }
  }
}
```

---

## Token Placeholders

### Standard Tokens (Pre-Resolved)

| Token | Description | Example |
|-------|-------------|---------|
| `{{TASK_ID}}` | Current task identifier | `T3154` |
| `{{EPIC_ID}}` | Parent epic identifier | `T3147` |
| `{{DATE}}` | Current date | `2026-02-07` |
| `{{TOPIC_SLUG}}` | URL-safe topic name | `jwt-authentication` |
| `{{OUTPUT_DIR}}` | Output directory | `claudedocs/agent-outputs` |
| `{{MANIFEST_PATH}}` | Manifest filename | `MANIFEST.jsonl` |

### Command Tokens (CLEO Defaults)

| Token | Default Value |
|-------|---------------|
| `{{TASK_LINK_CMD}}` | `cleo research link` |
| `{{TASK_COMPLETE_CMD}}` | `cleo complete` |
| `{{TASK_START_CMD}}` | `cleo start` |
| `{{TASK_SHOW_CMD}}` | `cleo show` |

**Note**: Orchestrators MUST pre-resolve all tokens before spawning subagents. Subagents CANNOT resolve `@` references or `{{TOKEN}}` patterns.

---

## Usage in Protocols

### Research Protocol Example

```markdown
## Output Requirements

1. Write findings to `{{OUTPUT_DIR}}/{{DATE}}_{{TOPIC_SLUG}}.md`
2. Create manifest entry:

```bash
cleo research add \
  --task {{TASK_ID}} \
  --topic "{{TOPIC_SLUG}}" \
  --findings "{{FINDINGS_CSV}}" \
  --sources "{{SOURCES_CSV}}"
```

3. Link to task: `{{TASK_LINK_CMD}} {{TASK_ID}} {{ENTRY_ID}}`
```

### Implementation Protocol Example

```markdown
## Completion Sequence

```bash
# Write implementation file
# ...

# Record in manifest
cleo research add \
  --task {{TASK_ID}} \
  --topic "{{TOPIC_SLUG}}" \
  --findings "Implemented X,Added Y,Modified Z"

# Complete task
{{TASK_COMPLETE_CMD}} {{TASK_ID}}
```
```

---

## Anti-Patterns

### ❌ Pretty-Printed JSON

```bash
# WRONG - Creates multiple lines
echo '{
  "id": "test",
  "title": "Test"
}' >> MANIFEST.jsonl
```

**Problem**: Breaks JSONL format (one object per line)

**Solution**: Use `jq -c` for compact output
```bash
jq -nc '{id: "test", title: "Test"}' >> MANIFEST.jsonl
```

---

### ❌ Direct File Writes

```bash
# WRONG - Bypasses validation
echo "$json" >> claudedocs/agent-outputs/MANIFEST.jsonl
```

**Problem**: No validation, no atomic operation, no audit trail

**Solution**: Use CLI commands
```bash
cleo research add --task T#### --topic "..." --findings "..."
```

---

### ❌ Missing Key Findings

```bash
# WRONG - No findings provided
cleo research add --task T#### --topic "auth"
```

**Problem**: Manifest is for discovery — entries without findings defeat the purpose

**Solution**: Always provide concise findings
```bash
cleo research add --task T#### --topic "auth" --findings "Finding 1,Finding 2,Finding 3"
```

---

### ❌ Returning Full Content

```markdown
**Subagent response:**

Here is my research:

# JWT Authentication

[5000 words of content...]
```

**Problem**: Bloats orchestrator context window

**Solution**: Return ONLY summary message
```markdown
[Type] complete. See MANIFEST.jsonl for summary.
```

---

### ❌ Unresolved Tokens in Subagent

```bash
# WRONG - Subagent cannot resolve @file references
cleo research add --findings "@findings.txt"
```

**Problem**: Subagents cannot resolve `@` or `{{TOKEN}}` patterns

**Solution**: Orchestrator must pre-resolve
```bash
# Orchestrator resolves before spawn
findings=$(cat findings.txt | tr '\n' ',' | sed 's/,$//')
# Then passes to subagent as plain text
```

---

### ❌ Skipping Task ID

```bash
# WRONG - No association with task
cleo research add --topic "..." --findings "..."
# (missing --task flag)
```

**Problem**: Research orphaned, cannot be discovered from task

**Solution**: Always include `--task` flag
```bash
cleo research add \
  --task {{TASK_ID}} \
  --topic "..." \
  --findings "..."

# Or link an existing entry to a task
cleo research link <entry-id> {{TASK_ID}}
```

---

## References

- **Task System Integration**: `@skills/_shared/task-system-integration.md`
- **Subagent Protocol Base**: `@skills/_shared/subagent-protocol-base.md`
- **Research Manifest Library**: `lib/research-manifest.sh`
- **Research CLI**: `scripts/research.sh`
- **Exit Codes**: `lib/exit-codes.sh` (EXIT_VALIDATION_ERROR = 6)
- **RCASD-IVTR+C Protocol**: `docs/specs/PROJECT-LIFECYCLE-SPEC.md`
