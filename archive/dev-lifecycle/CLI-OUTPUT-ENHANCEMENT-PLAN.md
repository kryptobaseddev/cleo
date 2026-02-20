# CLI Output Enhancement Plan

## Executive Summary

This document synthesizes research from 20 specialized agents investigating best practices for enhancing claude-todo CLI output. The goal is to optimize output for both LLM agents (structured, token-efficient, anti-hallucination) and human users (clean, readable, visually informative).

**Version**: 1.0.0
**Date**: 2025-12-12
**Status**: Planning Document - Ready for Implementation

---

## Table of Contents

1. [Research Synthesis](#1-research-synthesis)
2. [Consensus Recommendations](#2-consensus-recommendations)
3. [New Commands](#3-new-commands)
4. [Output Format Specifications](#4-output-format-specifications)
5. [Implementation Phases](#5-implementation-phases)
6. [Technical Specifications](#6-technical-specifications)
7. [Testing Strategy](#7-testing-strategy)
8. [Migration Plan](#8-migration-plan)

---

## 1. Research Synthesis

### 1.1 Key Findings by Category

#### Current State Analysis
- **Strengths**: Consistent [ERROR]/[WARN]/[INFO] prefixes, TTY color detection, JSON/text/markdown formats
- **Gaps**: No short flags (-s, -p), inconsistent emoji handling, no NO_COLOR support, limited filtering
- **Performance**: Targets met for small datasets, optimization needed for 1000+ tasks

#### LLM-Optimized Output
- JSON costs 2x more tokens than CSV/TSV for same data
- TOON (Token-Oriented Object Notation) achieves 30-60% token reduction
- Explicit task IDs and delimiters prevent hallucination
- Structured output with `_meta` sections enables validation

#### Human-Readable Output
- Progressive disclosure: summary → verbose → raw data
- Unicode box-drawing (U+2500-U+257F) for tables
- Color semantics: green=success, red=error, yellow=warning, cyan=active
- Progress bars: `[████████░░] 80%` with ETA

#### Anti-Hallucination Patterns
- Never assume implicit information - state everything explicitly
- Confirm what operation actually happened (echo IDs, states, counts)
- Make "nothing" explicit - empty states need structure
- Enumerate what exists - prevent invented entities

#### Performance Targets
| Operation | Target | Current |
|-----------|--------|---------|
| list | <50ms | ~50ms |
| add | <100ms | ~100ms |
| complete | <200ms | ~200ms |
| stats | <1s | ~500ms |
| archive (100 tasks) | <500ms | ~500ms |

---

## 2. Consensus Recommendations

### 2.1 Output Modes (Unanimous Agreement)

| Mode | Flag | Use Case | Details |
|------|------|----------|---------|
| Text | default | Human terminal | Colors, symbols, grouping |
| Compact | `-c`, `--compact` | Quick scan | One-line per task |
| Verbose | `-v`, `--verbose` | Full details | All fields expanded |
| JSON | `--format json` | Machine parsing | Envelope with metadata |
| JSONL | `--format jsonl` | Streaming | One JSON object per line |
| CSV | `--format csv` | Spreadsheet import | RFC 4180 compliant |
| TSV | `--format tsv` | Tab-separated | Paste-friendly |
| Markdown | `--format markdown` | Documentation | Checklist format |
| Table | `--format table` | Structured display | Box-drawing borders |

### 2.2 Flag Conventions (Strong Consensus)

**Short flags to add:**
```
-s STATUS    --status STATUS
-p PRIORITY  --priority PRIORITY
-l LABEL     --label LABEL
-f FORMAT    --format FORMAT
-v           --verbose
-c           --compact
-h           --help
-q           --quiet
```

**Environment variables:**
```
NO_COLOR=1           # Disable all colors (standard)
CLAUDE_TODO_FORMAT   # Default output format
CLAUDE_TODO_DEBUG    # Enable debug output
COLUMNS              # Terminal width hint
```

### 2.3 Anti-Hallucination Output Requirements

1. **Explicit task counts**: Always show `(3 pending, 1 active, 0 blocked)`
2. **Echo back operations**: `Completed T001: "Implement auth" -> done`
3. **Checksum display**: `Checksum: abc123 (valid)`
4. **Timestamp freshness**: `Last updated: 5 minutes ago`
5. **Empty state handling**: `No tasks match filter. Available: 12 total tasks.`

### 2.4 Color/Symbol Mapping

| Status | Color | Symbol | ASCII Fallback |
|--------|-------|--------|----------------|
| pending | dim white | ○ | - |
| active | cyan (bright) | ◉ | * |
| blocked | yellow | ⊗ | x |
| done | green | ✓ | + |

| Priority | Color | Symbol | ASCII |
|----------|-------|--------|-------|
| critical | red (bright) | 🔴 | ! |
| high | yellow | 🟡 | H |
| medium | blue | 🔵 | M |
| low | dim gray | ⚪ | L |

---

## 3. New Commands

### 3.1 Command Overview

| Command | Alias | Purpose | Priority |
|---------|-------|---------|----------|
| `dash` | `overview` | Full dashboard summary | P1 |
| `next` | - | Suggest next task | P1 |
| `labels` | `tags` | List/filter by labels | P1 |
| `phases` | - | Phase summary and filtering | P2 |
| `blockers` | - | Blocker analysis | P2 |
| `deps` | `tree` | Dependency visualization | P3 |
| `plan` | - | Project plan view | P3 |

### 3.2 Command Specifications

#### `dash` - Dashboard Command
```bash
claude-todo dash [OPTIONS]

OPTIONS:
  --compact         Condensed single-section view
  --period DAYS     Stats period (default: 7)
  --no-chart        Disable ASCII charts

OUTPUT:
╭─────────────────────────────────────────────────────────────╮
│  📊 PROJECT DASHBOARD                                       │
├─────────────────────────────────────────────────────────────┤
│  Status Overview                                            │
│    ○ 5 pending   ◉ 2 active   ⊗ 1 blocked   ✓ 12 done     │
│                                                             │
│  Focus: T003 - Implement authentication                     │
│  Session: 2h 15m active                                     │
├─────────────────────────────────────────────────────────────┤
│  Phase Progress                                             │
│    setup   [████████████] 100%  4/4                         │
│    core    [████████░░░░]  67%  4/6                         │
│    polish  [░░░░░░░░░░░░]   0%  0/3                         │
├─────────────────────────────────────────────────────────────┤
│  This Week: +8 created, +6 completed, 75% rate              │
╰─────────────────────────────────────────────────────────────╯
```

#### `next` - Next Task Suggestion
```bash
claude-todo next [OPTIONS]

OPTIONS:
  --explain         Show reasoning for suggestion
  --count N         Show top N suggestions (default: 1)

ALGORITHM:
1. Filter: status=pending AND not blocked by incomplete tasks
2. Sort by: priority (desc), dependencies cleared (asc), created (asc)
3. Bonus: Same phase as current focus

OUTPUT:
📌 Next suggested task:

[T007] Add user dashboard
  Priority: high
  Phase: core
  Ready: All dependencies complete
  Reason: Highest priority unblocked task

Run: claude-todo focus set T007
```

#### `labels` - Label Management
```bash
claude-todo labels [SUBCOMMAND] [OPTIONS]

SUBCOMMANDS:
  (none)            List all labels with counts
  show LABEL        Show tasks with specific label

OPTIONS:
  --format FORMAT   Output format

OUTPUT (default):
📏 Labels (8 unique)

  backend      ████████████  12 tasks
  frontend     ████████      8 tasks
  security     ██████        6 tasks  🔴 2 critical
  api          ████          4 tasks
  bug          ███           3 tasks  🟡 1 high
  docs         ██            2 tasks
  testing      ██            2 tasks
  ui           █             1 task
```

#### `phases` - Phase Management
```bash
claude-todo phases [SUBCOMMAND] [OPTIONS]

SUBCOMMANDS:
  (none)            List all phases with summary
  show PHASE        Show tasks in specific phase
  stats             Detailed phase statistics

OUTPUT:
╭──────────────────────────────────────────────────────────────╮
│  📊 PROJECT PHASES                                           │
├──────────────────────────────────────────────────────────────┤
│  Phase        │ Tasks │ Progress          │ Status           │
├───────────────┼───────┼───────────────────┼──────────────────┤
│  1. setup     │  4    │ ████████████ 100% │ ✓ Completed      │
│  2. core      │  6    │ ████████░░░░  67% │ ◉ In Progress    │
│  3. testing   │  3    │ ░░░░░░░░░░░░   0% │ ○ Pending        │
│  4. polish    │  2    │ ░░░░░░░░░░░░   0% │ ○ Pending        │
╰──────────────────────────────────────────────────────────────╯
```

#### `deps` - Dependency Visualization
```bash
claude-todo deps [SUBCOMMAND] [OPTIONS]

SUBCOMMANDS:
  (none)            Show full dependency tree
  show TASK_ID      Show dependencies for specific task
  check             Validate all dependencies (detect cycles)
  blocked           Show tasks blocked by incomplete deps

OPTIONS:
  --depth N         Max tree depth (default: unlimited)
  --reverse         Show what depends on each task

OUTPUT:
📐 Dependency Tree

T001 Setup database schema ✓
├─► T002 Create user model [active]
│   ├─► T005 Add authentication [pending]
│   └─► T006 User profile API [pending]
└─► T003 Create product model [pending]
    └─► T007 Product search API [blocked] ⊗

T004 Design system setup ✓
└─► T008 Implement UI components [pending]

Legend: ✓ done  ◉ active  ○ pending  ⊗ blocked
        ─► depends on (child requires parent)
```

#### `blockers` - Blocker Analysis
```bash
claude-todo blockers [SUBCOMMAND] [OPTIONS]

SUBCOMMANDS:
  (none)            List all blocked tasks and blockers
  analyze           Deep analysis of blocking patterns

OUTPUT:
⚠️  Blockers Analysis

Blocked Tasks (3):
  [T007] Product search API
    Blocked by: T003 (Create product model)
    Impact: Blocks 2 downstream tasks

  [T009] Deploy to staging
    Blocked by: T005, T006 (auth tasks)
    Reason: "Waiting for security review"

  [T010] User acceptance testing
    Blocked by: T009 (Deploy to staging)
    Impact: Final blocker for release

Critical Path:
  T003 → T007 → T009 → T010 (4 tasks in chain)

Recommendation: Prioritize T003 to unblock 4 dependent tasks
```

---

## 4. Output Format Specifications

### 4.1 JSON Output Envelope

```json
{
  "$schema": "https://claude-todo.dev/schemas/output-v2.json",
  "_meta": {
    "version": "2.1.0",
    "command": "list",
    "timestamp": "2025-12-12T10:30:00Z",
    "checksum": "abc123def456",
    "execution_ms": 45
  },
  "filters": {
    "status": ["pending", "active"],
    "priority": null,
    "label": null
  },
  "summary": {
    "total": 25,
    "filtered": 12,
    "pending": 8,
    "active": 3,
    "blocked": 1,
    "done": 13
  },
  "tasks": [
    {
      "id": "T003",
      "title": "Implement authentication",
      "status": "active",
      "priority": "high",
      "phase": "core",
      "createdAt": "2025-12-10T09:00:00Z"
    }
  ]
}
```

### 4.2 JSONL Output (Streaming)

```jsonl
{"_type":"meta","version":"2.1.0","command":"list","timestamp":"2025-12-12T10:30:00Z"}
{"_type":"task","id":"T001","title":"Setup database","status":"done","priority":"high"}
{"_type":"task","id":"T002","title":"Create user model","status":"active","priority":"high"}
{"_type":"task","id":"T003","title":"Implement auth","status":"pending","priority":"high"}
{"_type":"summary","total":3,"filtered":3,"pending":1,"active":1,"done":1}
```

### 4.3 Compact Output Format (Token-Efficient)

```
# Header line defines fields
TASKS id,title,status,priority,phase
T001,Setup database,done,high,setup
T002,Create user model,active,high,core
T003,Implement auth,pending,high,core
# Summary
TOTAL 25 | FILTERED 12 | PENDING 8 | ACTIVE 3 | BLOCKED 1 | DONE 13
```

### 4.4 CSV/TSV Output

```csv
id,status,priority,phase,title,createdAt,completedAt
T001,done,high,setup,"Setup database",2025-12-08T10:00:00Z,2025-12-09T15:30:00Z
T002,active,high,core,"Create user model",2025-12-09T11:00:00Z,
T003,pending,high,core,"Implement auth",2025-12-10T09:00:00Z,
```

---

## 5. Implementation Phases

### Phase 1: Foundation (v0.7.0)

**Priority**: Critical
**Scope**: Core output improvements

| Task | Description | Complexity |
|------|-------------|------------|
| Add short flags | `-s`, `-p`, `-l`, `-f`, `-v`, `-c`, `-q` | Medium |
| NO_COLOR support | Respect environment variable | Low |
| `--quiet` flag | Suppress info messages | Low |
| Enhanced JSON output | Add `_meta` envelope | Medium |
| JSONL format | Streaming output option | Medium |
| CSV/TSV export | Add formats to export.sh | Medium |
| Output library | Create lib/output-format.sh | Medium |

**Deliverables**:
- All list commands support short flags
- JSON output includes metadata envelope
- New export formats: JSONL, CSV, TSV
- NO_COLOR and --quiet work across all commands

### Phase 2: New Commands (v0.8.0)

**Priority**: High
**Scope**: Dashboard, next, labels commands

| Task | Description | Complexity |
|------|-------------|------------|
| `dash` command | Dashboard summary view | High |
| `next` command | Task suggestion algorithm | Medium |
| `labels` command | Label listing and filtering | Medium |
| Progress bars | ASCII progress visualization | Low |
| Box-drawing tables | Unicode table borders | Medium |
| Config integration | output.* settings in config | Medium |

**Deliverables**:
- Three new commands: dash, next, labels
- Visual progress indicators
- Box-drawing table support
- Configuration for output preferences

### Phase 3: Advanced Features (v0.9.0)

**Priority**: Medium
**Scope**: Phases, blockers, dependencies

| Task | Description | Complexity |
|------|-------------|------------|
| `phases` command | Phase summary and filtering | Medium |
| `blockers` command | Blocker analysis | Medium |
| `deps` command | Dependency tree visualization | High |
| Topological sort | Dependency ordering | Medium |
| Cycle detection | Detect circular dependencies | Medium |
| Critical path | Identify blocking chains | Medium |

**Deliverables**:
- Phase management commands
- Dependency visualization (ASCII tree)
- Blocker analysis with recommendations
- Cycle detection and warnings

### Phase 4: Performance & Polish (v1.0.0)

**Priority**: Medium
**Scope**: Caching, optimization, testing

| Task | Description | Complexity |
|------|-------------|------------|
| Index caching | Label/phase indices | High |
| Staleness detection | Checksum-based cache invalidation | Medium |
| Large dataset optimization | Streaming for 1000+ tasks | High |
| BATS test suite | Output format testing | Medium |
| Golden file tests | Snapshot testing for output | Medium |
| CI/CD integration docs | GitHub Actions examples | Low |

**Deliverables**:
- Cached indices for fast filtering
- Performance targets met for large datasets
- Comprehensive test suite
- CI/CD integration documentation

---

## 6. Technical Specifications

### 6.1 Output Library (lib/output-format.sh)

```bash
#!/usr/bin/env bash
# lib/output-format.sh - Shared output formatting functions

# Color support detection
detect_color_support() {
  [[ -n "${NO_COLOR:-}" ]] && return 1
  [[ -n "${FORCE_COLOR:-}" ]] && return 0
  [[ -t 1 ]] && command -v tput &>/dev/null && [[ $(tput colors 2>/dev/null) -ge 8 ]]
}

# Unicode support detection
detect_unicode_support() {
  [[ "${LANG:-}" =~ UTF-8 ]] || [[ "${LC_ALL:-}" =~ UTF-8 ]]
}

# Get terminal width
get_terminal_width() {
  local width="${COLUMNS:-}"
  [[ -z "$width" ]] && width=$(tput cols 2>/dev/null)
  [[ -z "$width" ]] && width=80
  echo "$width"
}

# Format resolution (CLI > env > config > default)
resolve_format() {
  local cli_format="${1:-}"
  [[ -n "$cli_format" ]] && echo "$cli_format" && return
  [[ -n "${CLAUDE_TODO_FORMAT:-}" ]] && echo "$CLAUDE_TODO_FORMAT" && return
  jq -r '.output.defaultFormat // "text"' .claude/todo-config.json 2>/dev/null || echo "text"
}

# Status to color code
status_color() {
  local status="$1"
  case "$status" in
    pending) echo "37" ;;  # dim white
    active)  echo "96" ;;  # bright cyan
    blocked) echo "33" ;;  # yellow
    done)    echo "32" ;;  # green
  esac
}

# Status to symbol
status_symbol() {
  local status="$1"
  local unicode="${2:-true}"
  if [[ "$unicode" == "true" ]]; then
    case "$status" in
      pending) echo "○" ;;
      active)  echo "◉" ;;
      blocked) echo "⊗" ;;
      done)    echo "✓" ;;
    esac
  else
    case "$status" in
      pending) echo "-" ;;
      active)  echo "*" ;;
      blocked) echo "x" ;;
      done)    echo "+" ;;
    esac
  fi
}

# Progress bar generator
progress_bar() {
  local current="$1"
  local total="$2"
  local width="${3:-20}"

  local percent=$((current * 100 / total))
  local filled=$((current * width / total))
  local empty=$((width - filled))

  printf "[%s%s] %3d%%" \
    "$(printf '█%.0s' $(seq 1 $filled))" \
    "$(printf '░%.0s' $(seq 1 $empty))" \
    "$percent"
}

# Box drawing helper
draw_box() {
  local width="${1:-60}"
  local unicode="${2:-true}"

  if [[ "$unicode" == "true" ]]; then
    local TL="╭" TR="╮" BL="╰" BR="╯" H="─" V="│"
  else
    local TL="+" TR="+" BL="+" BR="+" H="-" V="|"
  fi

  # Export for use in caller
  echo "$TL$TR$BL$BR$H$V"
}
```

### 6.2 Index Caching Structure

```json
{
  "_meta": {
    "version": "1.0.0",
    "created": "2025-12-12T10:00:00Z",
    "source_checksum": "abc123def456"
  },
  "statusCounts": {
    "pending": 8,
    "active": 3,
    "blocked": 1,
    "done": 13
  },
  "labelIndex": {
    "backend": ["T001", "T003", "T007"],
    "frontend": ["T002", "T005"]
  },
  "phaseIndex": {
    "setup": ["T001"],
    "core": ["T002", "T003", "T004", "T005", "T006"],
    "testing": ["T007", "T008"]
  },
  "dependencyGraph": {
    "T002": {"depends": ["T001"], "dependents": ["T005", "T006"]},
    "T005": {"depends": ["T002"], "dependents": []}
  }
}
```

### 6.3 Configuration Schema Extensions

Add to `schemas/config.schema.json`:

```json
"output": {
  "type": "object",
  "properties": {
    "defaultFormat": {
      "type": "string",
      "enum": ["text", "json", "jsonl", "csv", "tsv", "markdown", "table"],
      "default": "text"
    },
    "colorEnabled": {"type": "boolean", "default": true},
    "unicodeEnabled": {"type": "boolean", "default": true},
    "progressBars": {"type": "boolean", "default": true},
    "csvDelimiter": {"type": "string", "default": ","},
    "dateFormat": {
      "type": "string",
      "enum": ["iso8601", "relative", "unix", "locale"],
      "default": "iso8601"
    }
  }
}
```

---

## 7. Testing Strategy

### 7.1 Test Categories

| Category | Tool | Coverage |
|----------|------|----------|
| Unit tests | BATS | Individual functions |
| Output snapshots | Golden files | Format regression |
| JSON validation | ajv-cli | Schema compliance |
| Color tests | ANSI comparison | Color code presence/absence |
| Width tests | COLUMNS override | Responsive layout |
| Performance | Timing | Response time targets |

### 7.2 Test File Structure

```
tests/
├── test-output-format.bats    # lib/output-format.sh tests
├── test-list-formats.bats     # list --format variations
├── test-export-formats.bats   # export format tests
├── test-dash.bats             # Dashboard command
├── test-next.bats             # Next suggestion
├── test-deps.bats             # Dependency visualization
├── golden/
│   ├── list-text.txt
│   ├── list-table.txt
│   ├── dash-compact.txt
│   └── deps-tree.txt
├── fixtures/
│   ├── tasks-small.json       # 10 tasks
│   ├── tasks-medium.json      # 100 tasks
│   └── tasks-large.json       # 1000 tasks
└── schemas/
    └── output-envelope.schema.json
```

### 7.3 Example Test Cases

```bash
# tests/test-list-formats.bats

@test "list --format json includes _meta envelope" {
  run claude-todo list --format json
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '._meta.version'
  echo "$output" | jq -e '._meta.timestamp'
}

@test "NO_COLOR disables ANSI codes" {
  NO_COLOR=1 run claude-todo list
  ! [[ "$output" =~ $'\x1b\[' ]]
}

@test "list respects COLUMNS width" {
  COLUMNS=60 run claude-todo list --format table
  local max_width=$(echo "$output" | awk '{print length}' | sort -n | tail -1)
  [ "$max_width" -le 60 ]
}

@test "CSV output is RFC 4180 compliant" {
  run claude-todo export --format csv
  # Check quoting of fields with commas
  echo "$output" | csvlint
}
```

---

## 8. Migration Plan

### 8.1 Backward Compatibility

- All existing flags continue to work
- Default output format remains `text`
- JSON output adds `_meta` but keeps `tasks` array at root
- No breaking changes to exit codes

### 8.2 Deprecation Timeline

| Removed | Deprecated | Replacement | Version |
|---------|------------|-------------|---------|
| - | Direct emoji in tables | Configurable symbols | v0.8.0 |
| - | status "in_progress" | status "active" | v1.0.0 |

### 8.3 Documentation Updates

1. Update README.md with new commands
2. Update docs/usage.md with output format examples
3. Add docs/CLI-OUTPUT-REFERENCE.md
4. Add docs/ci-cd-integration.md
5. Update CLAUDE.md with new command reference

---

## Appendix A: Research Sources

### Agent Research Summary

| Agent ID | Topic | Key Findings |
|----------|-------|--------------|
| aa753f3 | Current CLI Analysis | 4 output formats, color gaps, no short flags |
| a11454e | LLM Optimization | JSON 2x tokens vs TSV, explicit IDs critical |
| a18255d | Human Readable | Progressive disclosure, Unicode tables, color semantics |
| acb4e9c | CLI Tool Comparison | Taskwarrior, gh, jira-cli patterns |
| a6adb9c | Dependency Viz | ASCII trees, topological sort, cycle detection |
| a485db2 | Phase Tracking | Progress bars, completion %, status calculation |
| a37fd0f | JSON Standards | JSONL, envelopes, RFC 9457 errors |
| ac25623 | Bash Tables | printf, column, box-drawing characters |
| a187383 | Anti-Hallucination | Explicit state, validation output, enumeration |
| a74adff | Query Patterns | AND/OR/NOT, date filters, fuzzy search |
| a463b4a | Aggregation | Dashboards, sparklines, velocity metrics |
| a352b02 | Status Indicators | ANSI colors, Unicode symbols, NO_COLOR |
| ab66632 | Progressive Disclosure | Verbosity levels, output formats, field selection |
| abaaf4f | Flag Conventions | POSIX/GNU, config precedence |
| a7e796c | Performance | Pagination, lazy loading, <100ms targets |
| a9888b6 | Caching | Label indices, staleness detection, lazy vs eager |
| aaad6ce | New Commands | 7 commands: dash, next, labels, phases, deps, blockers, plan |
| a68dfbc | Error Handling | Exit codes, error formats, empty states |
| ab1a1be | Testing | BATS, golden files, snapshot testing |
| af8d386 | Integration | CI/CD, piping, plugin formatters |

---

## Appendix B: User Examples

### Example: User's Original Request

```
I want to look at adding some enhanced features for how we retrieve and present data from the todo system

Phases Summary:
╭─────────────────────────────────────────────────────────────────────────────────╮
│  📊 Phase Summary                                                               │
├─────┬────────────┬─────────────────────────────────────────────┬────────────────┤
│  #  │ Phase      │ Tasks                                       │ Completion %   │
├─────┼────────────┼─────────────────────────────────────────────┼────────────────┤
│  1  │ setup      │ 5 pending | 2 active | 8 done              │ 53% Complete   │
│  2  │ core       │ 10 pending | 3 active | 2 done             │ 13% Complete   │
│  3  │ polish     │ 3 pending | 0 active | 0 done              │ 0% Complete    │
╰─────┴────────────┴─────────────────────────────────────────────┴────────────────╯

Task Dependencies:
T001 (Implement authentication)
├─┬ T002 (Add JWT middleware) [active]
│ └── T003 (Write auth tests) [pending]
└─┬ T004 (Add login endpoint) [pending]
  └── T005 (Add logout endpoint) [pending]

Labels Index:
╭────────────────────────────────────────────────────────────╮
│ Label         │ Count │ Critical                           │
├───────────────┼───────┼────────────────────────────────────┤
│ backend       │ 12    │                                    │
│ frontend      │ 8     │ 🔴 2 critical                       │
│ security      │ 5     │                                    │
╰───────────────┴───────┴────────────────────────────────────╯

Next Action:
Current Focus: T002 - Add JWT middleware
```

This plan addresses all requested features with implementation phases.

---

**Document End**
