# json-output.sh API Reference

**Library**: `lib/json-output.sh`
**Layer**: 1 (Core Infrastructure)
**Dependencies**: `version.sh`, `platform-compat.sh`
**Since**: v0.88.0

---

## Overview

Centralized JSON output formatting with built-in pagination support. Provides the canonical envelope builders, pagination helpers, and compact output transforms used by all CLEO commands.

---

## Core Envelope Builders

### output_success

Build a standard JSON success envelope.

**Signature**:
```bash
output_success <command> <data_key> <data_value>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `command` | string | Command name (e.g., `"show"`, `"add"`) |
| `data_key` | string | Key name for the data payload (e.g., `"task"`, `"tasks"`) |
| `data_value` | JSON | JSON value (string, object, or array) |

**Output**: JSON envelope to stdout.

**Example**:
```bash
output_success "show" "task" "$task_json"
# {
#   "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
#   "_meta": { "format": "json", "command": "show", "timestamp": "...", "version": "..." },
#   "success": true,
#   "task": { ... }
# }
```

---

### output_error_envelope

Build a lightweight JSON error envelope.

**Signature**:
```bash
output_error_envelope <command> <code> <message>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `command` | string | Command name |
| `code` | string | Error code (e.g., `"E_TASK_NOT_FOUND"`) |
| `message` | string | Human-readable error message |

**Output**: JSON error envelope to stdout.

**Example**:
```bash
output_error_envelope "show" "E_TASK_NOT_FOUND" "Task T999 not found"
# {
#   "$schema": "https://cleo-dev.com/schemas/v1/error.schema.json",
#   "_meta": { "format": "json", "command": "show", ... },
#   "success": false,
#   "error": { "code": "E_TASK_NOT_FOUND", "message": "Task T999 not found" }
# }
```

**Note**: For richer errors with `suggestion`, `recoverable`, and `context` fields, use `output_error()` from `lib/error-json.sh`.

---

### output_paginated

Build a paginated JSON success envelope.

**Signature**:
```bash
output_paginated <command> <data_key> <items_json> <total> <limit> <offset>
```

**Parameters**:

| Name | Type | Description |
|------|------|-------------|
| `command` | string | Command name |
| `data_key` | string | Key for the data array (e.g., `"tasks"`, `"sessions"`) |
| `items_json` | JSON array | Items for the current page (already sliced) |
| `total` | integer | Total item count before pagination |
| `limit` | integer | Page size |
| `offset` | integer | Current page offset |

**Output**: JSON envelope with `pagination` metadata to stdout.

**Example**:
```bash
output_paginated "list" "tasks" "$page_items" 150 50 0
# {
#   "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
#   "_meta": { ... },
#   "success": true,
#   "pagination": { "total": 150, "limit": 50, "offset": 0, "hasMore": true },
#   "tasks": [ ... ]
# }
```

---

## Pagination Helpers

### apply_pagination

Slice a JSON array with limit and offset.

**Signature**:
```bash
apply_pagination <items_json> <limit> <offset>
```

**Parameters**:

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `items_json` | JSON array | (required) | Full array to paginate |
| `limit` | integer | 0 | Max items (0 = unlimited) |
| `offset` | integer | 0 | Items to skip |

**Output**: Sliced JSON array to stdout.

**Example**:
```bash
page=$(apply_pagination "$all_tasks" 50 0)   # First 50
page=$(apply_pagination "$all_tasks" 50 50)  # Next 50
page=$(apply_pagination "$all_tasks" 0 0)    # All items
```

---

### get_pagination_meta

Generate a pagination metadata JSON object.

**Signature**:
```bash
get_pagination_meta <total> <limit> <offset>
```

**Output**: JSON object `{"total":N,"limit":N,"offset":N,"hasMore":bool}` to stdout.

**Example**:
```bash
meta=$(get_pagination_meta 150 50 0)
# {"total":150,"limit":50,"offset":0,"hasMore":true}
```

---

### get_default_limit

Get the smart default page size for a command type.

**Signature**:
```bash
get_default_limit <command_name>
```

**Returns**: Integer to stdout.

**Default Limits**:

| Input | Returns |
|-------|:-------:|
| `list`, `tasks` | 50 |
| `session`, `sessions` | 10 |
| `search`, `find` | 10 |
| `log`, `logs` | 20 |
| `archive` | 25 |
| anything else | 50 |

**Example**:
```bash
limit=$(get_default_limit "sessions")  # 10
limit=$(get_default_limit "find")      # 10
```

---

## Compact Output Helpers

### compact_task

Strip verbose fields from a task for list views.

**Signature**:
```bash
compact_task <task_json>
```

**Kept fields**: `id`, `title`, `status`, `priority`, `type`, `parentId`, `phase`, `labels`, `depends`, `blockedBy`, `createdAt`, `completedAt`

**Removed fields**: `notes`, `description`, `acceptance`, `files`, `verification`, `_archive`

Null fields are omitted from output.

**Example**:
```bash
compact=$(compact_task "$full_task")
```

---

### compact_session

Strip verbose fields from a session for list views.

**Signature**:
```bash
compact_session <session_json>
```

**Kept fields**: `id`, `name`, `status`, `scope`, `focus.currentTask`, `startedAt`, `endedAt`

**Removed fields**: `focusHistory`, `stats`, `taskSnapshots`, `notes`, `events`

**Example**:
```bash
compact=$(compact_session "$full_session")
```

---

## Integration Guide

### Adding Pagination to a New Command

```bash
#!/usr/bin/env bash
source "$LIB_DIR/json-output.sh"

# 1. Collect all items
all_items=$(jq '.tasks' "$TODO_FILE")
total=$(echo "$all_items" | jq 'length')

# 2. Resolve limit (user flag or smart default)
limit="${USER_LIMIT:-$(get_default_limit "$COMMAND_NAME")}"
offset="${USER_OFFSET:-0}"

# 3. Apply compact transform (optional, for list views)
compact_items=$(echo "$all_items" | jq -c '[.[] | {id, title, status, priority, type, parentId, phase, labels, depends, blockedBy, createdAt, completedAt} | with_entries(select(.value != null))]')

# 4. Slice to current page
page=$(apply_pagination "$compact_items" "$limit" "$offset")

# 5. Output with pagination envelope
output_paginated "$COMMAND_NAME" "tasks" "$page" "$total" "$limit" "$offset"
```

### Non-Paginated Commands

For commands returning single objects:

```bash
source "$LIB_DIR/json-output.sh"
output_success "show" "task" "$task_json"
```

### Error Responses

```bash
source "$LIB_DIR/json-output.sh"
output_error_envelope "show" "E_TASK_NOT_FOUND" "Task T999 not found"
```

---

## Related Documentation

- **Specification**: `docs/specs/DYNAMIC-OUTPUT-LIMITS-SPEC.md`
- **CLI Design Standard**: `docs/developer/specifications/LLM-AGENT-FIRST.mdx` (Part 14)
- **MCP Pagination Schema**: `schemas/common/pagination.schema.json`
- **Error JSON Library**: `lib/error-json.sh`
