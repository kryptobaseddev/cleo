# list Command

**Alias**: `ls`

Display tasks with filtering and multiple output formats.

## Usage

```bash
cleo list [OPTIONS]
```

## Description

The `list` command displays tasks from `todo.json` with support for filtering by status, priority, label, and phase. It supports multiple output formats including text, JSON, Markdown, and table views.

By default, completed tasks are hidden. Use `--status done` or `--all` to include them.

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--status STATUS` | `-s` | Filter by status: `pending`, `active`, `blocked`, `done` | Active tasks only |
| `--priority PRIORITY` | `-p` | Filter by priority: `critical`, `high`, `medium`, `low` | |
| `--label LABEL` | `-l` | Filter by label | |
| `--phase PHASE` | | Filter by phase slug | |
| `--since DATE` | | Tasks created after date (ISO 8601) | |
| `--until DATE` | | Tasks created before date (ISO 8601) | |
| `--all` | | Show all tasks including archived | `false` |
| `--archived` | | Show only archived tasks | `false` |
| `--format FORMAT` | `-f` | Output format: `text`, `json`, `jsonl`, `markdown`, `table` | `text` |
| `--sort FIELD` | | Sort by: `status`, `priority`, `createdAt`, `title` | `priority` |
| `--reverse` | | Reverse sort order | `false` |
| `--limit N` | | Limit number of results | No limit |
| `--offset N` | | Skip first N tasks (pagination) | 0 |
| `--compact` | `-c` | Compact one-line per task view | `false` |
| `--flat` | | Disable priority grouping, show flat list | `false` |
| `--notes` | | Show task notes inline in output | `false` |
| `--files` | | Show associated file references | `false` |
| `--acceptance` | | Show acceptance criteria | `false` |
| `--verbose` | `-v` | Show all task details (enables notes, files, acceptance) | `false` |
| `--quiet` | `-q` | Suppress informational messages | `false` |
| `--help` | `-h` | Show help message | |

### Hierarchy Filters (v0.17.0)

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--type TYPE` | `-t` | Filter by type: `epic`, `task`, `subtask` | |
| `--parent ID` | | Filter tasks with specified parent ID | |
| `--children ID` | | Show direct children of task ID | |
| `--tree` | | Display tasks in hierarchical tree view | `false` |
| `--wide` | | Show full titles in tree view (implied by `--human`) | `false` |

## Examples

### Basic Listing

```bash
# List all active (non-done) tasks
cleo list

# Short alias
cleo ls
```

Output:
```
TASKS (4 pending, 1 active, 0 blocked)
======================================

→ T005 [HIGH] Implement authentication
  Phase: core | Labels: backend, security

  T003 [MEDIUM] Add form validation
  Phase: setup | Labels: frontend

  T008 [LOW] Write documentation
  Phase: polish | Labels: docs

  T012 [MEDIUM] Set up CI/CD
  Phase: setup | Labels: devops
```

### Filtering

```bash
# By status
cleo list -s pending
cleo list --status blocked

# By priority
cleo list -p critical
cleo list --priority high

# By label
cleo list -l security
cleo list --label backend

# By phase
cleo list --phase setup
cleo list --phase core

# By date range
cleo list --since 2025-12-01
cleo list --until 2025-12-31

# Combined filters
cleo list -s pending -p high --phase core
```

### Hierarchy Filtering (v0.17.0)

```bash
# List only epics
cleo list --type epic

# List only subtasks
cleo list --type subtask

# List children of a specific task
cleo list --children T001

# Filter by parent
cleo list --parent T001

# Tree view (hierarchical display)
cleo list --tree
```

**Tree View Example** (v0.30.0):
```
T001 ○ 🔴 Auth System Epic
├── T002 ○ 🟡 Login endpoint
│   ├── T003 ○ 🔵 Validate email format
│   └── T004 ○ 🔵 Hash password
└── T005 ○ 🔵 Logout endpoint
```

Tree features:
- **Status icons**: ✓ done, ◉ active, ⊗ blocked, ○ pending
- **Priority icons**: 🔴 critical, 🟡 high, 🔵 medium, ⚪ low
- **Tree connectors**: ├── (middle child), └── (last child), │ (continuation)
- **Full titles**: `--human` shows full titles without truncation

### Display Customization

```bash
# Show task notes inline
cleo list --notes

# Show file references
cleo list --files

# Show acceptance criteria
cleo list --acceptance

# Combine display options
cleo list --notes --files --acceptance

# Verbose mode (all details)
cleo list --verbose

# Flat list (no priority grouping)
cleo list --flat

# Compact view (one line per task)
cleo list --compact
```

### Output Formats

**LLM-Agent-First**: JSON is automatic when output is piped (non-TTY). No `--format` flag needed:
```bash
# Auto-detected JSON when piped
cleo list | jq '.tasks[0]'

# Explicit format override
cleo list --format json     # Force JSON
cleo list --format jsonl    # JSON Lines (one task per line)
cleo list --format markdown # Markdown (for documentation)
cleo list --format table    # Table view
cleo list --human           # Force human-readable text
```

**Prefer native filters over jq post-processing**:
```bash
# ✅ Native (recommended - fewer tokens, no shell quoting issues)
cleo list --status pending --label bug

# ⚠️ jq (only when native filters insufficient)
# Use SINGLE quotes to prevent shell interpretation
cleo list | jq '.tasks[] | select(.type != "epic")'
```

### JSON Output Example

```json
{
  "_meta": {
    "format": "json",
    "version": "0.17.0",
    "command": "list",
    "timestamp": "2025-12-13T10:00:00Z"
  },
  "summary": {
    "total": 4,
    "pending": 3,
    "active": 1,
    "blocked": 0
  },
  "tasks": [
    {
      "id": "T005",
      "title": "Implement authentication",
      "status": "active",
      "priority": "high",
      "type": "task",
      "parentId": "T001",
      "size": "medium",
      "phase": "core",
      "labels": ["backend", "security"]
    }
  ]
}
```

### Sorting

```bash
# Sort by priority (critical first)
cleo list --sort priority

# Sort by creation date (newest first)
cleo list --sort createdAt --reverse

# Limit results
cleo list --limit 5
```

### Display Options

#### Flat List (`--flat`)

By default, tasks are grouped by priority level with section headers. Use `--flat` to disable grouping and show a flat list.

```bash
# Default: grouped by priority with headers
cleo list

# Output:
# 🔴 CRITICAL (2)
# ─────────────────
#   T001 ○ Fix security vulnerability
#   T003 ◉ Patch authentication bug
#
# 🟡 HIGH (1)
# ─────────────────
#   T005 ○ Implement JWT middleware

# Flat list: no grouping
cleo list --flat

# Output:
#   T001 ○ Fix security vulnerability
#   T003 ◉ Patch authentication bug
#   T005 ○ Implement JWT middleware
```

**Note**: Using `--sort` automatically enables flat list mode.

#### Task Notes (`--notes`)

Show timestamped notes added to tasks via `update --notes`.

```bash
cleo list --notes

# Output:
#   T005 ◉ Implement authentication
#       Implement JWT middleware
#       📝 Notes:
#         • Started investigating passport.js options
#         • Decided to use jsonwebtoken library instead
```

Notes are displayed with:
- Icon: `📝` (Unicode) or `N` (ASCII fallback)
- Bullet points for each note entry
- Chronological order (oldest first)

#### File References (`--files`)

Show file paths associated with tasks.

```bash
cleo list --files

# Output:
#   T012 ○ Refactor authentication module
#       Refactor auth system to use middleware pattern
#       📁 src/auth/middleware.js, src/auth/passport.js, tests/auth.test.js
```

Files are displayed with:
- Icon: `📁` (Unicode) or `F` (ASCII fallback)
- Comma-separated list of file paths

#### Acceptance Criteria (`--acceptance`)

Show acceptance criteria checklist for tasks.

```bash
cleo list --acceptance

# Output:
#   T008 ○ Add user registration
#       Implement user registration with email verification
#       ✓ Acceptance:
#         • Email validation works
#         • Password strength requirements enforced
#         • Confirmation email sent
#         • User can verify email via link
```

Acceptance criteria are displayed with:
- Icon: `✓` (Unicode) or `+` (ASCII fallback)
- Bullet points for each criterion
- List order preserved from task definition

#### Verbose Mode (`--verbose`)

Enables all display options automatically: `--notes`, `--files`, `--acceptance`, plus description and timestamps.

```bash
# Equivalent to: --notes --files --acceptance
cleo list --verbose

# Output:
#   T005 ◉ Implement authentication
#       Implement JWT middleware for API endpoints
#       Add authentication middleware using JWT tokens
#       📁 src/auth/middleware.js, src/routes/api.js
#       ✓ Acceptance:
#         • Token validation works
#         • Refresh tokens implemented
#       📝 Notes:
#         • Using jsonwebtoken library
#       Created: 2025-12-10T14:30:00Z
```

Verbose mode shows:
- Task description (full text)
- File references (if present)
- Acceptance criteria (if present)
- Notes (if present)
- Created timestamp
- Completed timestamp (if status is `done`)

## Status Icons

| Icon | Status | Color |
|------|--------|-------|
| `→` | Active | Yellow |
| ` ` | Pending | Default |
| `⊗` | Blocked | Red |
| `✓` | Done | Green |

## Priority Badges

| Badge | Priority |
|-------|----------|
| `[CRITICAL]` | critical |
| `[HIGH]` | high |
| `[MEDIUM]` | medium |
| `[LOW]` | low |

## JSON Output Parsing

```bash
# Get task IDs (JSON auto-detected when piped)
cleo list | jq -r '.tasks[].id'

# BETTER: Use native filters instead of jq
cleo list --status pending   # No jq needed

# When jq IS needed, use single quotes
cleo list | jq '.tasks[] | select(.type != "epic")'
```

## See Also

- [show](show.md) - View single task details
- [dash](dash.md) - Project dashboard overview
- [labels](labels.md) - View labels with counts
- [phases](phases.md) - View phases with progress
