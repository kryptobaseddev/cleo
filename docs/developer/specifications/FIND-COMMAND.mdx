# Find Command Specification

> **Version**: 1.0 | **Status**: DRAFT | **Date**: 2025-12-18
> **Task**: T376 - Research: Fuzzy task search command for LLM agents
> **Category**: Read command (LLM-Agent-First)

---

## Executive Summary

The `find` command provides efficient task discovery for LLM agents, enabling fuzzy search with minimal context output. This directly addresses the context bloat problem: a full `list --format json` returns **355KB** for 352 tasks, while `find` returns only matching tasks with minimal fields (**500 bytes - 2KB typical**).

### Problem Statement

| Scenario | Current Approach | Context Cost |
|----------|------------------|--------------|
| Find task by partial title | `list --format json \| jq` | 355KB + parsing |
| Find task by ID prefix | `list --format json \| grep` | 355KB + parsing |
| Fuzzy search for related tasks | `list` then manual scan | 355KB + LLM reasoning |
| Check if task name exists | `list` + full scan | 355KB |

### Solution: `find` Command

| Scenario | New Approach | Context Cost | Reduction |
|----------|--------------|--------------|-----------|
| Find task by partial title | `find "auth"` | ~1KB | **99.7%** |
| Find task by ID prefix | `find --id 37` | ~500B | **99.9%** |
| Fuzzy search for related tasks | `find "user registration"` | ~2KB | **99.4%** |
| Check if task name exists | `find --exact "Task title"` | ~300B | **99.9%** |

---

## RFC 2119 Conformance

This specification uses RFC 2119 keywords:
- **MUST**: Absolute requirement
- **SHOULD**: Recommended but not mandatory
- **MAY**: Optional

---

## Part 1: Command Definition

### Basic Syntax

```bash
ct find <query> [OPTIONS]
ct find --id <id-pattern> [OPTIONS]
```

### Arguments

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `<query>` | string | Yes* | Search query for title/description |

*Either `<query>` or `--id` is required

### Options

| Option | Short | Type | Default | Description |
|--------|-------|------|---------|-------------|
| `--id` | `-i` | string | - | Search by task ID pattern (prefix match) |
| `--field` | | string | `title,description` | Fields to search: `title`, `description`, `labels`, `notes`, `all` |
| `--status` | `-s` | string | - | Filter by status |
| `--limit` | `-n` | int | 10 | Maximum results to return |
| `--threshold` | `-t` | float | 0.3 | Minimum match score (0-1) |
| `--exact` | `-e` | bool | false | Exact match instead of fuzzy |
| `--include-archive` | | bool | false | Search archived tasks too |
| `--format` | `-f` | string | auto | Output format: `text`, `json`, `jsonl` |
| `--quiet` | `-q` | bool | false | Suppress non-essential output |
| `--verbose` | `-v` | bool | false | Include full task objects in output |

### Exit Codes

| Code | Constant | Description |
|------|----------|-------------|
| 0 | `EXIT_SUCCESS` | Matches found |
| 2 | `EXIT_INVALID_INPUT` | Invalid query or options |
| 100 | `EXIT_NO_DATA` | No matches found (not an error) |

---

## Part 2: Search Modes

### 2.1 Fuzzy Title/Description Search (Default)

Searches task titles and descriptions using substring matching with relevance scoring.

```bash
# Find tasks mentioning "auth" anywhere in title or description
ct find "auth"

# Find tasks related to user registration
ct find "user registration" --field title

# Search only in labels
ct find "bug" --field labels
```

**Matching Algorithm**:
1. Case-insensitive substring match
2. Word boundary bonus (matching whole word scores higher)
3. Title match scores higher than description match
4. Multiple query terms use AND logic

### 2.2 ID Pattern Search

Searches task IDs by prefix, suffix, or contains.

```bash
# Find tasks with IDs starting with T37
ct find --id 37

# Find specific ID range
ct find --id "T37[0-9]"  # T370-T379

# Partial ID lookup
ct find --id 001  # Returns T001
```

### 2.3 Exact Match Search

Returns only exact title matches (useful for duplicate checking).

```bash
# Check if exact task title exists
ct find "Implement authentication middleware" --exact
```

### 2.4 Multi-Field Search

```bash
# Search all text fields
ct find "security" --field all

# Search specific fields
ct find "bug" --field labels,notes
```

---

## Part 3: Output Format (LLM-Agent-First)

### 3.1 JSON Output (Default for Non-TTY)

**MUST** follow LLM-AGENT-FIRST-SPEC envelope:

```json
{
  "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
  "_meta": {
    "format": "json",
    "version": "0.19.0",
    "command": "find",
    "timestamp": "2025-12-18T10:00:00Z",
    "execution_ms": 15
  },
  "query": {
    "text": "auth",
    "mode": "fuzzy",
    "fields": ["title", "description"],
    "threshold": 0.3
  },
  "summary": {
    "total_searched": 352,
    "matches": 3,
    "truncated": false
  },
  "matches": [
    {
      "id": "T042",
      "title": "Implement auth middleware",
      "status": "pending",
      "priority": "high",
      "score": 0.95,
      "matched_in": ["title"]
    },
    {
      "id": "T123",
      "title": "Add authentication tests",
      "status": "done",
      "priority": "medium",
      "score": 0.80,
      "matched_in": ["title"]
    },
    {
      "id": "T201",
      "title": "Security review",
      "status": "pending",
      "priority": "high",
      "score": 0.45,
      "matched_in": ["description"]
    }
  ]
}
```

### 3.2 Minimal Match Object

For context efficiency, match objects are minimal by default:

| Field | Type | Included | Description |
|-------|------|----------|-------------|
| `id` | string | Always | Task ID |
| `title` | string | Always | Task title |
| `status` | string | Always | Task status |
| `priority` | string | Always | Task priority |
| `score` | float | Always | Match relevance (0-1) |
| `matched_in` | array | Always | Fields where match was found |
| `phase` | string | If present | Task phase |
| `labels` | array | If `--verbose` | Task labels |
| `description` | string | If `--verbose` | Full description |

### 3.3 Verbose Output

With `--verbose`, include full task objects:

```json
{
  "matches": [
    {
      "id": "T042",
      "score": 0.95,
      "matched_in": ["title"],
      "task": {
        "id": "T042",
        "title": "Implement auth middleware",
        "description": "Add JWT authentication...",
        "status": "pending",
        "priority": "high",
        "labels": ["auth", "backend"],
        "depends": ["T040"],
        "createdAt": "2025-12-01T10:00:00Z"
      }
    }
  ]
}
```

### 3.4 Text Output (Interactive TTY)

```
FIND: "auth" (3 matches)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  T042  [pending]  Implement auth middleware           (0.95)
        high • auth, backend

  T123  [done]     Add authentication tests            (0.80)
        medium

  T201  [pending]  Security review                     (0.45)
        high • matched in description

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Use 'ct show T042' to view full details
```

---

## Part 4: Use Cases for LLM Agents

### 4.1 Task Discovery Before Update

```bash
# Agent needs to update a task about authentication
# OLD WAY: ct list --format json | jq '.tasks[] | select(.title | contains("auth"))'
# NEW WAY:
ct find "auth" --limit 5
```

**Context saved**: ~354KB → ~1KB (99.7% reduction)

### 4.2 Dependency Resolution

```bash
# Agent needs to find related tasks before adding dependency
ct find "database schema" --status pending --limit 3
```

### 4.3 Duplicate Checking Before Add

```bash
# Check if similar task already exists
if ct find "Implement user login" --exact --quiet; then
  echo "Task already exists"
fi
```

### 4.4 ID Lookup with Partial Memory

```bash
# Agent remembers "something around T370"
ct find --id 37 --limit 5
```

### 4.5 Label-Based Task Discovery

```bash
# Find all bug-related tasks
ct find "bug" --field labels --status pending
```

---

## Part 5: Implementation Requirements

### 5.1 Foundation Libraries (MUST)

Per LLM-AGENT-FIRST-SPEC:

```bash
source "${LIB_DIR}/exit-codes.sh"
source "${LIB_DIR}/error-json.sh"
source "${LIB_DIR}/output-format.sh"

COMMAND_NAME="find"
```

### 5.2 TTY-Aware Format Resolution (MUST)

```bash
# After argument parsing
FORMAT=$(resolve_format "$FORMAT")
```

### 5.3 JSON Output Requirements (MUST)

- Include `$schema` field
- Include complete `_meta` envelope
- Include `success` boolean
- Use `output_error()` for errors

### 5.4 Performance Requirements

| Metric | Requirement |
|--------|-------------|
| Search time (1000 tasks) | < 100ms |
| Memory usage | O(n) where n = result count |
| JSON output size (10 matches) | < 5KB |

### 5.5 Scoring Algorithm

```
score = base_score * field_weight * position_bonus

base_score:
  - Exact match: 1.0
  - Word boundary match: 0.9
  - Substring match: 0.7
  - Fuzzy match: 0.5

field_weight:
  - title: 1.0
  - labels: 0.9
  - description: 0.7
  - notes: 0.5

position_bonus:
  - Match at start: +0.1
  - Match at word boundary: +0.05
```

---

## Part 6: CLI Integration

### 6.1 Command Registration

Add to `install.sh` CMD_MAP:

```bash
[find]="find.sh"
```

Add to CMD_DESC:

```bash
[find]="Fuzzy search tasks by title, ID, or labels"
```

### 6.2 Aliases

```bash
[search]="find"
[f]="find"
```

### 6.3 Help Integration

```bash
ct find --help
ct help find
```

---

## Part 7: Error Handling

### 7.1 Error Responses

```json
{
  "$schema": "https://cleo.dev/schemas/v1/error.schema.json",
  "_meta": {"command": "find", "timestamp": "...", "version": "..."},
  "success": false,
  "error": {
    "code": "E_INPUT_MISSING",
    "message": "Search query required",
    "exitCode": 2,
    "recoverable": true,
    "suggestion": "Use 'ct find <query>' or 'ct find --id <pattern>'"
  }
}
```

### 7.2 No Matches Response

```json
{
  "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
  "_meta": {"command": "find", "timestamp": "...", "version": "..."},
  "success": true,
  "query": {"text": "nonexistent", "mode": "fuzzy"},
  "summary": {"total_searched": 352, "matches": 0, "truncated": false},
  "matches": []
}
```

Exit code: 100 (EXIT_NO_DATA) - indicates no matches but not an error.

---

## Part 8: Testing Requirements

### 8.1 Unit Tests

```bash
# Test basic fuzzy search
ct find "test" | jq -e '.matches | length > 0'

# Test ID search
ct find --id T001 | jq -e '.matches[0].id == "T001"'

# Test exact match
ct find "Exact Title" --exact | jq -e '.query.mode == "exact"'

# Test no matches returns 100
ct find "zzzznonexistent" --quiet
[[ $? -eq 100 ]]

# Test JSON envelope
ct find "test" | jq -e '."$schema" and ._meta.command == "find"'
```

### 8.2 Performance Tests

```bash
# Search should complete in <100ms for 1000 tasks
time ct find "test" --quiet
```

---

## Part 9: Comparison with Existing Commands

| Feature | `list` | `exists` | `show` | `find` |
|---------|--------|----------|--------|--------|
| Returns all tasks | Yes | No | No | No |
| Fuzzy search | No | No | No | **Yes** |
| ID prefix search | No | Exact only | Exact only | **Yes** |
| Minimal output | No | Binary | Full task | **Yes** |
| Match scoring | No | No | No | **Yes** |
| Context efficient | No | Yes | Moderate | **Yes** |

### Use Case Decision Tree

```
Need task info?
├── Know exact ID? → ct show T042
├── Check if ID exists? → ct exists T042
├── Need all tasks? → ct list
├── Need filtered list? → ct list --status pending
└── Need to search/discover? → ct find "query"
```

---

## Appendix A: Alternative Names Considered

| Name | Pros | Cons | Decision |
|------|------|------|----------|
| `find` | Familiar (Unix), clear purpose | Might conflict with shell `find` | **SELECTED** |
| `search` | Clear, no conflicts | Longer to type | Alias |
| `lookup` | Clear | Less common | Rejected |
| `query` | Database-like | Too generic | Rejected |
| `match` | Describes behavior | Less intuitive | Rejected |

---

## Appendix B: Context Savings Analysis

Based on this project (352 tasks, 357KB todo.json):

| Operation | `list` Context | `find` Context | Savings |
|-----------|----------------|----------------|---------|
| Find 1 task | 355KB | ~0.5KB | 99.9% |
| Find 5 tasks | 355KB | ~1.5KB | 99.6% |
| Find 10 tasks | 355KB | ~3KB | 99.1% |
| ID lookup | 355KB | ~0.3KB | 99.9% |

**Estimated annual token savings** (assuming 100 find operations/day at $0.003/1K tokens):
- Current: 355KB * 100 = 35.5MB/day = ~$10.65/day
- With find: 3KB * 100 = 300KB/day = ~$0.09/day
- **Savings: $10.56/day = $3,850/year**

---

*Specification v1.0 - Research Complete*
*Task T376 - Research: Fuzzy task search command for LLM agents*
*Created: 2025-12-18*
