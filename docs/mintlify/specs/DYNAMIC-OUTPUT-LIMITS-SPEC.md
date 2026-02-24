# Dynamic Output Limits Specification

**Version**: 1.0.0
**Status**: ACTIVE (Bash implementation references — concepts valid, code paths will be ported to TypeScript during V2 conversion)
**Created**: 2026-02-10
**Last Updated**: 2026-02-14
**Epic**: T1432 (JSON Output System with Smart Pagination)

---

## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all capitals.

[RFC 2119]: https://www.rfc-editor.org/rfc/rfc2119
[RFC 8174]: https://www.rfc-editor.org/rfc/rfc8174.html

---

## Executive Summary

CLEO's dynamic output limits system provides smart pagination for JSON output, reducing context window consumption for LLM agents while ensuring no data loss. The system is implemented in `lib/json-output.sh` and provides centralized envelope construction, pagination helpers, and compact output transforms.

---

## Part 1: Smart Default Limits

### 1.1 Per-Command Defaults

Each command type has a context-optimized default page size returned by `get_default_limit()`:

| Command Type | Default Limit | Rationale |
|-------------|:------------:|-----------|
| `list` / `tasks` | 50 | Balances overview breadth with token cost |
| `session` / `sessions` | 10 | Sessions are infrequent; 10 covers typical active range |
| `search` / `find` | 10 | Search results are ranked by relevance; top 10 is sufficient |
| `log` / `logs` | 20 | Recent audit entries; deeper history via `--offset` |
| `archive` | 25 | Archived tasks are reference-only; moderate page size |
| All others | 50 | General-purpose fallback |

### 1.2 Override Behavior

| Flag | Effect |
|------|--------|
| `--limit N` | Sets page size to N |
| `--limit 0` | Disables pagination (returns all items) |
| `--offset N` | Skips first N items before applying limit |

When `--limit` is not specified, the smart default from `get_default_limit()` applies. When `--limit 0` is specified, all items are returned from the given offset onward with no pagination metadata.

---

## Part 2: Pagination Metadata Schema

### 2.1 Envelope Structure

Paginated responses use the standard CLEO JSON envelope with an additional `pagination` object:

```json
{
  "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
  "_meta": {
    "format": "json",
    "command": "list",
    "timestamp": "2026-02-10T12:00:00Z",
    "version": "0.88.0"
  },
  "success": true,
  "pagination": {
    "total": 150,
    "limit": 50,
    "offset": 0,
    "hasMore": true
  },
  "tasks": [ ... ]
}
```

### 2.2 Pagination Object Fields

All fields are **REQUIRED** when the `pagination` key is present:

| Field | Type | Description |
|-------|------|-------------|
| `total` | integer (>= 0) | Total number of items before pagination |
| `limit` | integer (>= 1) | Maximum items returned in this page |
| `offset` | integer (>= 0) | Number of items skipped |
| `hasMore` | boolean | `true` if `offset + limit < total` |

### 2.3 Schema Reference

The pagination object conforms to `mcp-server/schemas/common/pagination.schema.json`:

```json
{
  "required": ["limit", "offset", "total", "hasMore"],
  "additionalProperties": false
}
```

### 2.4 hasMore Calculation

```
hasMore = (offset + limit) < total
```

When `hasMore` is `true`, agents SHOULD issue a follow-up request with `--offset <offset + limit>` to retrieve the next page.

---

## Part 3: Compact Output Conventions

### 3.1 Purpose

List views strip verbose fields to reduce per-item token cost. The `compact_task()` and `compact_session()` functions produce minimal representations suitable for scanning and selection.

### 3.2 compact_task Fields

| Kept | Removed |
|------|---------|
| `id`, `title`, `status`, `priority` | `notes`, `description`, `acceptance` |
| `type`, `parentId`, `phase` | `files`, `verification`, `_archive` |
| `labels`, `depends`, `blockedBy` | |
| `createdAt`, `completedAt` | |

Null fields are omitted from output. Output is compact JSON (single line per task).

### 3.3 compact_session Fields

| Kept | Removed |
|------|---------|
| `id`, `name`, `status`, `scope` | `focusHistory`, `stats`, `taskSnapshots` |
| `focus.currentTask` | `notes` (full array), `events` |
| `startedAt`, `endedAt` | |

The `focus` object is simplified to contain only `currentTask`.

### 3.4 Token Savings

Compact representations reduce per-item size:

| Data Type | Full Size (approx) | Compact Size (approx) | Reduction |
|-----------|:------------------:|:--------------------:|:---------:|
| Task | 800-2000 bytes | 150-300 bytes | ~80% |
| Session | 1500-5000 bytes | 100-200 bytes | ~90% |

---

## Part 4: Token Budget Rationale

### 4.1 Design Constraints

LLM agents operate within a finite context window. Every byte of CLI output competes with code, instructions, and conversation history. The pagination system is designed to keep default output within predictable token budgets:

| Command | Default Items | Max Tokens (est.) | Target |
|---------|:------------:|:-----------------:|:------:|
| `list` (compact) | 50 | ~2,500 | < 3K |
| `session list` (compact) | 10 | ~500 | < 1K |
| `find` (compact) | 10 | ~500 | < 1K |
| `log` | 20 | ~1,500 | < 2K |

### 4.2 Comparison with Unbounded Output

Without pagination, a project with 200 tasks produces ~50K-100K tokens of raw JSON on `ct list`. With smart defaults (50 compact tasks), output is ~2.5K tokens -- a **95-97% reduction**.

### 4.3 Progressive Disclosure

Agents follow a discover-then-inspect pattern:

1. `ct find "query"` -- returns up to 10 compact matches (~500 tokens)
2. `ct show T1234` -- returns full task details for one item (~800 tokens)
3. `ct list --parent T001` -- returns direct children with compact fields

This pattern minimizes context consumption while maintaining full access to all data.

---

## Part 5: Integration Requirements

### 5.1 Adding Pagination to a Command

Commands that return arrays **SHOULD** integrate pagination using this pattern:

```bash
source "$LIB_DIR/json-output.sh"

# Get items
all_items=$(get_all_items)
total=$(echo "$all_items" | jq 'length')

# Apply pagination
limit="${LIMIT:-$(get_default_limit "$COMMAND_NAME")}"
offset="${OFFSET:-0}"
page=$(apply_pagination "$all_items" "$limit" "$offset")

# Output
output_paginated "$COMMAND_NAME" "items" "$page" "$total" "$limit" "$offset"
```

### 5.2 Compact Output Integration

Commands listing tasks or sessions **SHOULD** apply compact transforms before pagination:

```bash
# Compact each task in the array
compact_items=$(echo "$all_tasks" | jq '[.[] | {id, title, status, priority, type, parentId, phase, labels, depends, blockedBy, createdAt, completedAt} | with_entries(select(.value != null))]')
```

Or use the provided helper functions `compact_task` and `compact_session` for individual items.

### 5.3 Non-Paginated Success Output

For commands returning single objects (e.g., `show`, `add`), use `output_success`:

```bash
output_success "$COMMAND_NAME" "task" "$task_json"
```

### 5.4 Error Output

For errors, use `output_error_envelope` for lightweight error envelopes, or the full `output_error` from `lib/error-json.sh` for rich error output with recovery suggestions.

---

## Part 6: Backward Compatibility

| Change | Impact | Mitigation |
|--------|--------|------------|
| Default limits on list commands | Agents that relied on full listings now get paginated results | Use `--limit 0` for full listing |
| New `pagination` field in envelope | Additive field; does not break existing parsers | Agents MAY ignore `pagination` if not needed |
| Compact fields in list output | List responses contain fewer fields per item | Use `ct show <id>` for full task details |

---

## References

- **Implementation**: `lib/json-output.sh`
- **MCP Pagination Schema**: `mcp-server/schemas/common/pagination.schema.json`
- **LLM-Agent-First Spec**: `docs/developer/specifications/LLM-AGENT-FIRST.mdx`
- **CLI Output Reference**: `docs/reference/cli-output-formats.md`
- **Epic**: T1432 (JSON Output System with Smart Pagination)

---

*Specification v1.0.0 -- Dynamic Output Limits for LLM-Agent-First CLI Design*
