# find Command

> Fuzzy search tasks by title, description, or ID pattern with minimal output for efficient LLM context usage.

## Usage

```bash
cleo find <query> [OPTIONS]
cleo find --id <id-pattern> [OPTIONS]
```

## Description

The `find` command provides efficient task discovery for LLM agents, enabling fuzzy search with minimal context output. This directly addresses the context bloat problem: a full `list --format json` returns hundreds of KB for large task lists, while `find` returns only matching tasks with minimal fields (typically 500 bytes - 2KB).

This command is particularly useful for:
- Task discovery before update operations
- Dependency resolution when adding new tasks
- Duplicate checking before creating tasks
- ID lookup with partial memory
- Label-based task discovery
- Reducing LLM context consumption by 99%+

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `<query>` | Yes* | Search query for title/description |

*Either `<query>` or `--id` is required.

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--id` | `-i` | Search by task ID pattern (prefix match) | - |
| `--exact` | `-e` | Exact title match only (no fuzzy matching) | `false` |
| `--field` | | Fields to search: `title`, `description`, `labels`, `notes`, `all` | `title,description` |
| `--status` | `-s` | Filter by status: `pending`, `active`, `blocked`, `done` | - |
| `--format` | `-f` | Output format: `text`, `json` | `auto` |
| `--limit` | `-n` | Maximum results to return | `10` |
| `--threshold` | `-t` | Minimum match score 0-1 | `0.3` |
| `--verbose` | `-v` | Include full task objects in output | `false` |
| `--quiet` | `-q` | Suppress non-essential output | `false` |
| `--include-archive` | | Search archived tasks too | `false` |
| `--help` | `-h` | Show help message | |

## Exit Codes

| Code | Meaning | Description |
|------|---------|-------------|
| `0` | Matches found | Search completed successfully with results |
| `2` | Invalid input | Invalid query or options provided |
| `100` | No matches | No matching tasks found (not an error) |

The exit code 100 for "no matches" is distinct from errors, allowing scripts to differentiate between "search worked but found nothing" and "search failed due to invalid input."

## Examples

### Fuzzy Title/Description Search (Default)

```bash
# Find tasks mentioning "auth" anywhere in title or description
ct find "auth"
```

Output (text mode):
```
FIND: "auth" (3 matches)

  T042  [pending]  Implement auth middleware           (0.95)
        high - auth, backend

  T123  [done]     Add authentication tests            (0.80)
        medium

  T201  [pending]  Security review                     (0.45)
        high - matched in description

Use 'ct show T042' to view full details
```

```bash
# Find tasks related to user registration (search titles only)
ct find "user registration" --field title

# Search only in labels
ct find "bug" --field labels

# Search all text fields
ct find "security" --field all
```

### ID Pattern Search

```bash
# Find tasks with IDs starting with T37
ct find --id 37
```

Output:
```
FIND: ID pattern "37" (4 matches)

  T370  [pending]  Database migration setup            (1.00)
  T371  [active]   API endpoint refactor               (1.00)
  T372  [done]     Unit test coverage                  (1.00)
  T376  [pending]  Fuzzy search command                (1.00)
```

```bash
# Find specific ID
ct find --id T001

# Partial ID lookup
ct find --id 001
```

### Exact Match Search

```bash
# Check if exact task title exists (useful for duplicate checking)
ct find "Implement authentication middleware" --exact
```

Output (if found):
```
FIND: exact match (1 match)

  T042  [pending]  Implement authentication middleware  (1.00)
```

Output (if not found - exit code 100):
```
FIND: exact match (0 matches)
No tasks match "Implement authentication middleware"
```

### Filtered Search

```bash
# Top 5 pending matches for "test"
ct find "test" --limit 5 --status pending

# High-threshold matches only (very relevant results)
ct find "database" --threshold 0.7

# Search including archived tasks
ct find "old feature" --include-archive
```

### JSON Output

**LLM-Agent-First**: JSON is auto-detected when output is piped (non-TTY):
```bash
# Auto-JSON when piped (no --format needed)
ct find "auth" | jq '.matches[0]'

# Explicit format override
ct find "auth" --format json
```

Output:
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

### Verbose Output

```bash
# Include full task objects
ct find "auth" --verbose --format json
```

The `--verbose` flag includes complete task data in each match:

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

### Quiet Mode for Scripting

```bash
# Check if any matching tasks exist (exit code only)
if ct find "user login" --exact --quiet; then
  echo "Task already exists"
fi
```

## JSON Output Structure

### Match Object Fields

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
| `task` | object | If `--verbose` | Complete task object |

### Parsing JSON Output

```bash
# JSON auto-detected when piped - no --format needed
ct find "auth" | jq -r '.matches[].id'        # Extract task IDs
ct find "auth" | jq -r '.matches[0]'          # Get highest-scoring match
ct find "test" | jq '.matches[] | select(.score > 0.8)'  # Filter by score
ct find "auth" | jq '.summary.matches'        # Check match count
```

## Scoring Algorithm

The `find` command uses a weighted scoring algorithm:

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

## Use Cases for LLM Agents

### Task Discovery Before Update

```bash
# OLD WAY: ct list --format json | jq '.tasks[] | select(.title | contains("auth"))'
# Context cost: ~355KB

# NEW WAY:
ct find "auth" --limit 5
# Context cost: ~1KB (99.7% reduction)
```

### Dependency Resolution

```bash
# Find related tasks before adding dependency
ct find "database schema" --status pending --limit 3
```

### Duplicate Checking Before Add

```bash
# Check if similar task already exists
if ct find "Implement user login" --exact --quiet; then
  echo "Task already exists, skipping creation"
else
  ct add "Implement user login" --description "..."
fi
```

### ID Lookup with Partial Memory

```bash
# Agent remembers "something around T370"
ct find --id 37 --limit 5
```

### Label-Based Discovery

```bash
# Find all bug-related tasks
ct find "bug" --field labels --status pending
```

## Error Handling

### Invalid Query

```bash
ct find
# Exit code: 2
```

Output:
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

### No Matches

```bash
ct find "zzzznonexistent"
# Exit code: 100
```

Output:
```json
{
  "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
  "_meta": {"command": "find", "timestamp": "...", "version": "..."},
  "success": true,
  "query": {"text": "zzzznonexistent", "mode": "fuzzy"},
  "summary": {"total_searched": 352, "matches": 0, "truncated": false},
  "matches": []
}
```

Note: Exit code 100 indicates no matches but is not an error condition.

## Performance

| Metric | Requirement |
|--------|-------------|
| Search time (1000 tasks) | < 100ms |
| Memory usage | O(n) where n = result count |
| JSON output size (10 matches) | < 5KB |

Performance tips:
1. Use `--limit` to reduce output size
2. Use `--field` to narrow search scope
3. Use `--quiet` for scripting (skips output formatting)
4. Prefer `--id` for ID lookups (fastest mode)

## Context Savings Analysis

Based on a project with 352 tasks (357KB todo.json):

| Operation | `list` Context | `find` Context | Savings |
|-----------|----------------|----------------|---------|
| Find 1 task | 355KB | ~0.5KB | 99.9% |
| Find 5 tasks | 355KB | ~1.5KB | 99.6% |
| Find 10 tasks | 355KB | ~3KB | 99.1% |
| ID lookup | 355KB | ~0.3KB | 99.9% |

## Comparison with Other Commands

| Feature | `list` | `exists` | `show` | `find` |
|---------|--------|----------|--------|--------|
| Returns all tasks | Yes | No | No | No |
| Fuzzy search | No | No | No | **Yes** |
| ID prefix search | No | Exact only | Exact only | **Yes** |
| Minimal output | No | Binary | Full task | **Yes** |
| Match scoring | No | No | No | **Yes** |
| Context efficient | No | Yes | Moderate | **Yes** |

### Decision Tree

```
Need task info?
+-- Know exact ID? --> ct show T042
+-- Check if ID exists? --> ct exists T042
+-- Need all tasks? --> ct list
+-- Need filtered list? --> ct list --status pending
+-- Need to search/discover? --> ct find "query"
```

## Related Commands

- `list` - List all tasks with filtering options
- `show` - Display full details for a single task by exact ID
- `labels` - List all labels and search tasks by label
- `exists` - Check if exact task ID exists (boolean result)

## Tips

1. **Start Broad, Then Narrow**: Use low threshold first, increase if too many results
2. **Use Field Filters**: Specify `--field title` for faster, more focused searches
3. **Combine Filters**: Mix `--status` with search query for precise results
4. **Leverage Scores**: Higher scores indicate more relevant matches
5. **JSON for Automation**: Use `--format json` in scripts for reliable parsing
6. **Quiet for Conditionals**: Use `--quiet` when only exit code matters
7. **Verbose for Details**: Add `--verbose` when full task data is needed

## Command Aliases

```bash
ct search "query"    # Alias for ct find
ct f "query"         # Short alias for ct find
```

## Version History

- **v0.19.x**: Initial implementation
  - Fuzzy search with scoring algorithm
  - ID pattern matching
  - Multi-field search support
  - LLM-Agent-First JSON output format
