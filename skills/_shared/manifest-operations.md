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
- Full path: `{{OUTPUT_DIR}}/{{MANIFEST_PATH}}`

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
  --title "Entry Title" \
  --file "path/to/output.md" \
  --topics "topic1,topic2,topic3" \
  --findings "Finding 1,Finding 2,Finding 3" \
  [--status STATUS] \
  [--task T####] \
  [--epic T####] \
  [--actionable | --not-actionable] \
  [--needs-followup T001,T002] \
  [--agent-type TYPE]
```

**Required Flags**:
| Flag | Description | Example |
|------|-------------|---------|
| `--title` | Human-readable title | `"Authentication Research"` |
| `--file` | Relative path to output file | `"2026-02-07_auth-research.md"` |
| `--topics` | Comma-separated topic tags | `"authentication,security,jwt"` |
| `--findings` | Comma-separated key findings (1-7 items) | `"JWT tokens expire after 1h,OAuth2 preferred,PKCE required"` |

**Optional Flags**:
| Flag | Default | Valid Values |
|------|---------|--------------|
| `--status` | `complete` | `complete`, `partial`, `blocked` |
| `--task` | none | Task ID (e.g., `T1234`) |
| `--epic` | none | Epic ID (e.g., `T1200`) |
| `--actionable` | `true` | Boolean flag |
| `--not-actionable` | - | Negates actionable |
| `--needs-followup` | `[]` | Comma-separated task IDs |
| `--agent-type` | `research` | See Agent Type Values below |

**Agent Type Values** (RCSD-IVTR protocol + workflow types):
- **Protocol types**: `research`, `consensus`, `specification`, `decomposition`, `implementation`, `contribution`, `release`
- **Workflow types**: `validation`, `documentation`, `analysis`, `testing`, `cleanup`, `design`, `architecture`, `report`
- **Extended types**: `synthesis`, `orchestrator`, `handoff`, `verification`, `review`
- **Skill types**: Any `ct-*` prefix (e.g., `ct-orchestrator`)

**Example**:
```bash
cleo research add \
  --title "JWT Authentication Best Practices" \
  --file "2026-02-07_jwt-auth.md" \
  --topics "authentication,jwt,security" \
  --findings "Use RS256 for asymmetric signing,Tokens expire in 1h,Refresh tokens stored securely" \
  --status complete \
  --task T3154 \
  --actionable \
  --agent-type research
```

**Output**: JSON with created entry ID
```json
{
  "success": true,
  "entryId": "jwt-auth-2026-02-07",
  "manifestPath": "claudedocs/agent-outputs/MANIFEST.jsonl"
}
```

---

### cleo research update

Update an existing manifest entry.

**Usage**:
```bash
cleo research update <entry-id> \
  [--title "New Title"] \
  [--status STATUS] \
  [--findings "F1,F2,F3"] \
  [--topics "T1,T2"] \
  [--actionable | --not-actionable] \
  [--needs-followup T001,T002]
```

**Parameters**:
- `<entry-id>`: Entry ID from manifest (e.g., `jwt-auth-2026-02-07`)

**Flags**: Same as `add` command (all optional for update)

**Example**:
```bash
cleo research update jwt-auth-2026-02-07 \
  --status partial \
  --needs-followup T3155,T3156
```

---

### cleo research list

Query and filter manifest entries.

**Usage**:
```bash
cleo research list \
  [--status STATUS] \
  [--type TYPE] \
  [--topic TOPIC] \
  [--since DATE] \
  [--limit N] \
  [--actionable]
```

**Filter Options**:
| Flag | Description | Example |
|------|-------------|---------|
| `--status` | Filter by status | `complete`, `partial`, `blocked`, `archived` |
| `--type` | Filter by agent type | `research`, `implementation`, `validation` |
| `--topic` | Filter by topic tag | `authentication` |
| `--since` | Entries since date | `2026-02-01` (ISO 8601: YYYY-MM-DD) |
| `--limit` | Max results | `20` (default: 20) |
| `--actionable` | Only actionable entries | Boolean flag |

**Example**:
```bash
# Recent research entries
cleo research list --type research --since 2026-02-01 --limit 10

# Actionable partial entries
cleo research list --status partial --actionable
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
cleo research link <task-id> <research-id> [--notes "Custom note"]
```

**Parameters**:
- `<task-id>`: Task ID (e.g., `T3154`)
- `<research-id>`: Entry ID from manifest

**Options**:
| Flag | Description |
|------|-------------|
| `--notes` | Custom note text instead of default |

**Example**:
```bash
cleo research link T3154 jwt-auth-2026-02-07
cleo research link T3154 jwt-auth-2026-02-07 --notes "Primary research source"
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

Remove link between research and task.

**Usage**:
```bash
cleo research unlink <task-id> <research-id>
```

**Example**:
```bash
cleo research unlink T3154 jwt-auth-2026-02-07
```

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

Show entries with `needs_followup` (orchestrator handoffs).

**Usage**:
```bash
cleo research pending [--brief]
```

**Options**:
| Flag | Description |
|------|-------------|
| `--brief` | Minimal output (just IDs and followup tasks) |

**Example**:
```bash
cleo research pending
cleo research pending --brief
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
cleo research archive \
  [--threshold BYTES] \
  [--percent N] \
  [--dry-run]
```

**Options**:
| Flag | Default | Description |
|------|---------|-------------|
| `--threshold` | `200000` | Archive threshold in bytes (~50K tokens) |
| `--percent` | `50` | Percentage of oldest entries to archive |
| `--dry-run` | - | Show what would be archived without changes |

**Example**:
```bash
# Preview archival
cleo research archive --dry-run

# Archive oldest 50% when manifest exceeds 200KB
cleo research archive --threshold 200000 --percent 50
```

**Effects**:
- Moves entries to `{{OUTPUT_DIR}}/archive/MANIFEST-archive.jsonl`
- Updates status to `archived` in archive file
- Removes from main manifest to reduce context size

---

### cleo research archive-list

List entries from the archive file.

**Usage**:
```bash
cleo research archive-list \
  [--limit N] \
  [--since DATE]
```

**Options**:
| Flag | Default | Description |
|------|---------|-------------|
| `--limit` | `50` | Max entries to return |
| `--since` | none | Filter archived since date (ISO 8601) |

**Example**:
```bash
cleo research archive-list --limit 100 --since 2026-01-01
```

---

### cleo research status

Show manifest size and archival status.

**Usage**:
```bash
cleo research status
```

**Output**: JSON with size metrics
```json
{
  "success": true,
  "manifest": {
    "path": "claudedocs/agent-outputs/MANIFEST.jsonl",
    "size": 153420,
    "entryCount": 42,
    "threshold": 200000,
    "needsArchival": false
  }
}
```

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

Validate manifest file integrity and entry format.

**Usage**:
```bash
cleo research validate [--fix] [--protocol] [--task T####]
```

**Options**:
| Flag | Description |
|------|-------------|
| `--fix` | Remove invalid entries (destructive) |
| `--protocol` | Validate against protocol requirements |
| `--task` | Validate entries linked to specific task |

**Example**:
```bash
# Check integrity
cleo research validate

# Fix invalid entries
cleo research validate --fix

# Validate protocol compliance for task outputs
cleo research validate --protocol --task T3154
```

**Validation Checks**:
- Valid JSON syntax per line
- Required fields present: `id`, `file`, `title`, `date`, `status`, `topics`, `key_findings`, `actionable`
- Status enum: `complete`, `partial`, `blocked`, `archived`
- Date format: ISO 8601 (YYYY-MM-DD)
- Field types: `topics` array, `key_findings` array, `actionable` boolean
- Agent type validity (protocol + workflow types)

**Exit Codes**:
- `0`: Validation passed
- `6`: Validation errors found (`EXIT_VALIDATION_ERROR`)

---

### cleo research compact

Remove duplicate/obsolete entries from manifest.

**Usage**:
```bash
cleo research compact
```

**Effects**:
- Removes duplicate entries (same ID)
- Keeps most recent version of duplicates
- Atomic operation with backup

---

### cleo research get

Get single entry by ID (raw JSON object).

**Usage**:
```bash
cleo research get <entry-id>
```

**Example**:
```bash
cleo research get jwt-auth-2026-02-07
```

**Output**: Raw JSON object (no wrapper)

---

### cleo research inject

Output the subagent injection template for prompts.

**Usage**:
```bash
cleo research inject [--raw] [--clipboard]
```

**Options**:
| Flag | Description |
|------|-------------|
| `--raw` | Output template without variable substitution |
| `--clipboard` | Copy to clipboard (pbcopy/xclip) |

**Example**:
```bash
# Output with current values
cleo research inject

# Raw template with {{TOKENS}}
cleo research inject --raw

# Copy to clipboard
cleo research inject --clipboard
```

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
| `{{TASK_FOCUS_CMD}}` | `cleo focus set` |
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
  --title "{{TITLE}}" \
  --file "{{DATE}}_{{TOPIC_SLUG}}.md" \
  --topics "{{TOPICS_CSV}}" \
  --findings "{{FINDINGS_CSV}}" \
  --status complete \
  --task {{TASK_ID}} \
  --agent-type research
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
  --title "{{TASK_TITLE}} Implementation" \
  --file "{{OUTPUT_FILE}}" \
  --topics "{{TASK_LABELS}}" \
  --findings "Implemented X,Added Y,Modified Z" \
  --status complete \
  --task {{TASK_ID}} \
  --agent-type implementation

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
cleo research add --title "..." --file "..." --topics "..." --findings "..."
```

---

### ❌ Missing Key Findings

```bash
# WRONG - Empty findings array
cleo research add --findings ""
```

**Problem**: Manifest is for discovery - empty findings defeat purpose

**Solution**: Always provide 1-7 concise findings
```bash
cleo research add --findings "Finding 1,Finding 2,Finding 3"
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
Research complete. See MANIFEST.jsonl for summary.
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

### ❌ Skipping Task Link

```bash
# WRONG - No bidirectional association
cleo research add --title "..." --file "..." --topics "..." --findings "..."
# (missing --task flag)
```

**Problem**: Research orphaned, cannot be discovered from task

**Solution**: Always link to task
```bash
cleo research add \
  --title "..." \
  --file "..." \
  --topics "..." \
  --findings "..." \
  --task {{TASK_ID}}

# Or link after creation
cleo research link {{TASK_ID}} {{ENTRY_ID}}
```

---

## References

- **Task System Integration**: `@skills/_shared/task-system-integration.md`
- **Subagent Protocol Base**: `@skills/_shared/subagent-protocol-base.md`
- **Research Manifest Library**: `lib/research-manifest.sh`
- **Research CLI**: `scripts/research.sh`
- **Exit Codes**: `lib/exit-codes.sh` (EXIT_VALIDATION_ERROR = 6)
- **RCSD-IVTR Protocol**: `docs/specs/PROJECT-LIFECYCLE-SPEC.md`
