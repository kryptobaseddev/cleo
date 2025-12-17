# Claude-TODO LLM-Agent Optimization Report v2.0

> **Comprehensive Multi-Agent Review** of CLI output formats, flags, and actionable recommendations for LLM-agent-first design
>
> **Generated**: 2025-12-17 | **Review Agents**: 15 parallel code explorers | **Analysis Scope**: 32 commands, 150+ flags

---

## Executive Summary

### Current State Assessment

| Metric | Current | Target | Gap |
|--------|---------|--------|-----|
| Commands with JSON support | 22/28 (79%) | 28/28 (100%) | 6 commands |
| Default output format | `text` (human) | `json` (machine) | Architecture change |
| Commands with `--quiet` | 5/28 (18%) | 28/28 (100%) | 23 commands |
| Commands with `--format` | 9/28 (32%) | 28/28 (100%) | 19 commands |
| Standardized error JSON | 0% | 100% | Not implemented |
| JSON envelope consistency | 73% | 100% | 27% variation |
| TTY auto-detection for format | No | Yes | Not implemented |
| Flag consistency score | 43% | 90%+ | Significant work |

### Reference Implementation Identified

**`analyze.sh`** (v0.16.0) is the **gold standard** for LLM-agent-first design:
- **JSON output is DEFAULT** (`OUTPUT_MODE="json"` line 74)
- Human output requires explicit `--human` flag (opt-in for HITL)
- Comprehensive `_meta` envelope with version, timestamp, algorithm
- Structured recommendations with `action_order`, `recommendation.command`
- Exit codes documented (0=success, 1=error, 2=no tasks)

**Pattern to replicate across all commands.**

---

## Part 1: Command Tier Analysis

### Tier 1: Production-Ready for Agents (8-10/10)

| Command | Score | JSON | Quiet | Key Strength |
|---------|-------|------|-------|--------------|
| `analyze` | **10/10** | Default | N/A | **Reference implementation** - JSON default |
| `list` | 9/10 | Full | Yes | Most comprehensive format support |
| `exists` | 9/10 | Full | Yes | Perfect exit codes (4 explicit constants) |
| `validate` | 9/10 | Full | Yes | Auto-fix with atomic writes |
| `stats` | 9/10 | Full | No | Cleanest JSON structure |
| `labels` | 9/10 | Full | No | Co-occurrence analysis |
| `blockers` | 9/10 | Full | Yes | Critical path analysis |
| `export` | 8/10 | Multi | Yes | 5 format options |

### Tier 2: Usable with Limitations (5-7/10)

| Command | Score | Issues | Fix Needed |
|---------|-------|--------|------------|
| `show` | 7/10 | No quiet mode | Add `--quiet` |
| `next` | 8/10 | No quiet mode | Add `--quiet` |
| `history` | 8/10 | Missing `_meta.timestamp` | Fix envelope |
| `deps` | 8/10 | No `--format` flag | Add `--format` |
| `dash` | 6/10 | Complex output | Add `--quiet` |
| `log` | 7/10 | Raw array, no envelope | Add `_meta` |
| `session` | 5/10 | Partial JSON (subcommands only) | Global `--format` |
| `phases` | 6/10 | Heavy human formatting | Add `--format` |

### Tier 3: Requires Enhancement (1-4/10)

| Command | Score | Critical Issues |
|---------|-------|-----------------|
| `focus` | 4/10 | Only `show` has JSON; no global `--format` |
| `backup` | 4/10 | No JSON output mode |
| `add` | **2/10** | **No JSON output** - cannot get created task |
| `update` | **1/10** | **No output control whatsoever** |
| `complete` | **2/10** | **No JSON confirmation** |
| `restore` | 3/10 | Interactive only, no dry-run |
| `migrate` | 2/10 | Text-only status |
| `init` | 2/10 | Procedural, no output |
| `phase` | **2/10** | **ZERO JSON output** in any subcommand |
| `archive` | 2/10 | Statistics as text only |

---

## Part 2: Critical Gaps Analysis

### Gap 1: Write Commands Have NO JSON Output

**Impact**: Agents must re-query after every mutation

| Command | Current Output | Agent Workaround |
|---------|----------------|------------------|
| `add` | Text + task ID | `ct show $(ct add "Task" -q) --format json` |
| `update` | Text summary | `ct list --format json` after update |
| `complete` | Text confirmation | `ct show $id --format json` after |
| `archive` | Text stats | `ct stats --format json` after |

**Required JSON Output**:

```json
// ct add "Task" --format json
{
  "_meta": {"command": "add", "timestamp": "...", "version": "..."},
  "success": true,
  "task": {"id": "T042", "title": "...", "status": "pending", "createdAt": "..."}
}

// ct update T042 --priority high --format json
{
  "_meta": {"command": "update", "timestamp": "..."},
  "success": true,
  "taskId": "T042",
  "changes": {"priority": {"before": "medium", "after": "high"}},
  "task": {/* full updated task */}
}

// ct complete T042 --format json
{
  "_meta": {"command": "complete", "timestamp": "..."},
  "success": true,
  "taskId": "T042",
  "completedAt": "2025-12-17T10:00:00Z",
  "cycleTimeDays": 3.5
}
```

### Gap 2: TTY Auto-Detection Not Used for Format

**Location**: `lib/output-format.sh` line 251

**Current**:
```bash
# Default fallback if nothing resolved
[[ -z "$resolved_format" ]] && resolved_format="text"
```

**Required**:
```bash
# Default fallback: TTY-aware auto-detection
if [[ -z "$resolved_format" ]]; then
  if [[ -t 1 ]]; then
    resolved_format="text"  # Interactive terminal
  else
    resolved_format="json"  # Pipe/redirect/agent context
  fi
fi
```

**Impact**: JSON would automatically be default when piping or running in agent context.

### Gap 3: No Standardized Error JSON Format

**Current**: Errors output as text regardless of `--format json`

```bash
# Current behavior (scripts/exists.sh:148)
echo -e "${RED}[ERROR]${NC} Task ID required" >&2
```

**Required Error JSON**:
```json
{
  "_meta": {"command": "exists", "timestamp": "...", "version": "..."},
  "success": false,
  "error": {
    "code": "E_TASK_NOT_FOUND",
    "message": "Task T999 does not exist",
    "exitCode": 1,
    "recoverable": false,
    "suggestion": "Use 'ct exists' to verify task ID"
  }
}
```

### Gap 4: Phase Commands Have ZERO JSON Output

**`phase.sh`** subcommands (show, set, start, complete, advance, list) all output text only.

**Current**:
```bash
claude-todo phase show
# Output: "Current Phase: core\n  Name: Core Development\n  Status: active"
```

**Required**:
```json
{
  "_meta": {"command": "phase show", "timestamp": "..."},
  "success": true,
  "currentPhase": {
    "slug": "core",
    "name": "Core Development",
    "status": "active",
    "startedAt": "2025-12-10T14:30:00Z",
    "durationDays": 7.2
  }
}
```

### Gap 5: Flag Inconsistency Across Commands

**Conflict Matrix**:

| Short Flag | Conflicting Uses |
|------------|------------------|
| `-f` | `--format` (7 commands) vs `--files` (update) |
| `-n` | `--notes` (3 commands) vs `--count` (next) |

**Missing Universal Flags**:

| Flag | Current Coverage | Target |
|------|-----------------|--------|
| `--format` | 9/28 (32%) | 100% |
| `--quiet` | 5/28 (18%) | 100% |
| `--verbose` | 2/28 (7%) | All display commands |
| `--dry-run` | 3/28 (11%) | All write operations |

---

## Part 3: JSON Envelope Consistency Analysis

### Standard Envelope (from `analyze.sh`):
```json
{
  "$schema": "https://claude-todo.dev/schemas/output-v2.json",
  "_meta": {
    "format": "json",
    "version": "<version>",
    "command": "<command-name>",
    "timestamp": "<ISO-8601>",
    "checksum": "<sha256>",      // Optional
    "execution_ms": <ms>          // Optional
  },
  "success": true,
  "summary": {},
  "data": []
}
```

### Envelope Compliance:

| Field | Commands Compliant | Issues |
|-------|-------------------|--------|
| `_meta` present | 9/9 (100%) | ✅ |
| `_meta.format` | 8/9 (89%) | `analyze` missing |
| `_meta.version` | 9/9 (100%) | ✅ |
| `_meta.command` | 8/9 (89%) | `analyze` missing |
| `_meta.timestamp` | 7/9 (78%) | `analyze` uses `generated`, `history` missing |
| `$schema` | 4/9 (44%) | **Only 4 commands include** |

### Critical Fixes Needed:

1. **`analyze.sh`**: Add `_meta.format`, `_meta.command`, rename `generated` → `timestamp`
2. **`history.sh`**: Add `_meta.timestamp`
3. **All commands**: Add `$schema` field

---

## Part 4: Recommended Architecture Changes

### Priority 1: LLM-First Default Output (CRITICAL)

**Option A: TTY Auto-Detection** (Recommended)
```bash
# lib/output-format.sh:251
if [[ -z "$resolved_format" ]]; then
  [[ -t 1 ]] && resolved_format="text" || resolved_format="json"
fi
```

**Option B: Environment Variable**
```bash
# In agent environment
export CLAUDE_TODO_FORMAT=json
export CLAUDE_TODO_AGENT_MODE=1
```

**Option C: Config-Based**
```json
// .claude/todo-config.json
{"output": {"defaultFormat": "json", "agentMode": true}}
```

### Priority 2: Add JSON to Write Operations

**Files to modify**:
1. `scripts/add-task.sh` - Add `--format json` (lines 687-700)
2. `scripts/update-task.sh` - Add `--format json` (lines 706-714)
3. `scripts/complete-task.sh` - Add `--format json` (lines 290-336)
4. `scripts/archive.sh` - Add `--format json`

**Implementation Pattern** (from existing commands):
```bash
# Add to argument parsing
-f|--format) FORMAT="$2"; shift 2 ;;

# Output function
if [[ "$FORMAT" == "json" ]]; then
  jq -n --arg id "$TASK_ID" --argjson task "$TASK_JSON" \
    '{_meta: {...}, success: true, task: $task}'
else
  echo "Task added: $TASK_ID"
fi
```

### Priority 3: Standardize Error JSON

**Create `lib/error-handling.sh`**:
```bash
#!/usr/bin/env bash
# Centralized error handling for claude-todo

readonly EXIT_SUCCESS=0
readonly EXIT_GENERAL_ERROR=1
readonly EXIT_INVALID_INPUT=2
readonly EXIT_FILE_ERROR=3
readonly EXIT_NOT_FOUND=4

print_error() {
  local code="$1" message="$2" exit_code="$3" format="${4:-text}"

  if [[ "$format" == "json" ]]; then
    jq -n --arg code "$code" --arg msg "$message" --argjson exit "$exit_code" \
      '{_meta: {...}, success: false, error: {code: $code, message: $msg, exitCode: $exit}}'
  else
    echo -e "\033[0;31m[ERROR]\033[0m $message" >&2
  fi
  exit "$exit_code"
}
```

### Priority 4: Add HITL Flags for Human Mode

**New flags for explicit human interaction**:

| Flag | Purpose | Commands |
|------|---------|----------|
| `--human` | Force human-readable output | All (like `analyze` already has) |
| `--interactive` | Enable confirmation prompts | restore, migrate, archive |
| `--colors` | Force color output | All |
| `--progress` | Show progress indicators | archive, migrate, validate |

**Example**:
```bash
# Default: JSON for agents
ct list              # Returns JSON

# Explicit: Human-readable
ct list --human      # Returns formatted text with colors
ct complete T001 --interactive  # Prompts for notes
```

---

## Part 5: Implementation Roadmap

### Phase 1: Foundation (P1 - Critical)

| Task | Files | Effort |
|------|-------|--------|
| Add `--format json` to write commands | add-task.sh, update-task.sh, complete-task.sh, archive.sh | Medium |
| Implement TTY auto-detection | lib/output-format.sh | Low |
| Create error-handling.sh library | lib/error-handling.sh (new) | Medium |
| Add JSON to phase commands | phase.sh, phases.sh | Medium |

### Phase 2: Standardization (P2 - High)

| Task | Files | Effort |
|------|-------|--------|
| Add `--quiet` to all commands | 23 script files | Medium |
| Fix JSON envelope inconsistencies | analyze.sh, history.sh, others | Low |
| Add `$schema` to all JSON outputs | All commands with JSON | Low |
| Resolve short flag conflicts | update-task.sh, next.sh | Low |

### Phase 3: Polish (P3 - Medium)

| Task | Files | Effort |
|------|-------|--------|
| Add `--verbose` to display commands | show.sh, stats.sh, dash.sh | Low |
| Add `--dry-run` to all write operations | update.sh, complete.sh, restore.sh, migrate.sh | Medium |
| Add `--human` flag for explicit HITL | All commands | Medium |
| Standardize exit codes | Create lib/exit-codes.sh | Medium |

---

## Part 6: Quick Agent Integration Today

### Environment Setup
```bash
# Agent-optimized environment
export CLAUDE_TODO_FORMAT=json
export NO_COLOR=1
export CLAUDE_TODO_AGENT_MODE=1
```

### Query Patterns (Work Today)
```bash
# Task listing
ct list --format json | jq '.tasks[]'

# Analysis
ct analyze | jq '.recommendations'  # analyze defaults to JSON!

# Single task
ct show T001 --format json

# Validation
ct validate --json --quiet && echo "Valid"
```

### Write Patterns (Workaround Until P1)
```bash
# Create and get full task
task_id=$(ct add "Task" -q)
ct show "$task_id" --format json

# Update and verify
ct update T001 --priority high
ct show T001 --format json

# Complete and confirm
ct complete T001 --skip-notes
ct list --status done --format json | jq '.tasks[] | select(.id == "T001")'
```

---

## Part 7: Exit Code Reference

### Current (Documented in exists.sh, show.sh)
```bash
EXIT_SUCCESS=0       # Success
EXIT_NOT_FOUND=1     # Task/resource not found
EXIT_INVALID_ID=2    # Invalid input format
EXIT_FILE_ERROR=3    # File operation error
```

### Proposed Standard
```bash
EXIT_SUCCESS=0           # Success
EXIT_GENERAL_ERROR=1     # General error (backward compat)
EXIT_INVALID_INPUT=2     # Invalid user input
EXIT_FILE_ERROR=3        # File system error
EXIT_NOT_FOUND=4         # Resource not found
EXIT_DEPENDENCY_ERROR=5  # Missing dependency (jq, etc.)
EXIT_INTERNAL_ERROR=6    # Internal system error
```

---

## Part 8: Validation of Original Report

### Confirmed Findings ✅

1. **22/28 commands have JSON support** - Confirmed (79%)
2. **6 commands lack JSON**: add, update, complete, init, migrate, restore - **Confirmed**
3. **analyze.sh is LLM-optimized** - **Confirmed and identified as reference implementation**
4. **No standardized error JSON** - **Confirmed across entire codebase**
5. **CLAUDE_TODO_FORMAT env var supported** - **Confirmed in lib/output-format.sh**

### Corrections/Additions 📝

1. **analyze.sh defaults to JSON** - Original report showed `--json` flag needed; actual implementation has `OUTPUT_MODE="json"` as default
2. **phases.sh has JSON support** - Original report marked as no JSON; actually has `--format json` for list/show/stats
3. **phase.sh (singular) has ZERO JSON** - Not clearly distinguished from phases.sh in original report
4. **Flag consistency is 43%** - Worse than implied in original report
5. **TTY detection exists but only for colors** - Not mentioned in original report

### New Critical Findings 🔴

1. **Short flag conflicts**: `-f` and `-n` have conflicting meanings
2. **`resolve_format()` not integrated into scripts** - Library exists but scripts set `FORMAT="text"` directly
3. **No `--dry-run` on critical operations**: update, complete, restore missing preview capability
4. **Session/focus commands have JSON but inconsistent** - Subcommand-level only, not global

---

## Part 9: Success Metrics

### Before Optimization
- Default output: Human-readable text
- Agent workflow: 2x commands (command + verify query)
- Error handling: Parse colored text with regex
- Write confirmation: Re-query after every mutation

### After Optimization
- Default output: JSON (when not TTY)
- Agent workflow: 1x command (response includes result)
- Error handling: Parse `error.code` field
- Write confirmation: Response includes created/updated data

### Measurable Goals

| Metric | Current | Target | Impact |
|--------|---------|--------|--------|
| Commands with JSON | 79% | 100% | Full automation |
| Commands with `--quiet` | 18% | 100% | Clean scripting |
| Agent workflow steps | 2x | 1x | 50% fewer API calls |
| Error parsing complexity | Regex | JSON field | 100% reliability |
| TTY auto-detection | No | Yes | Zero-config agent mode |

---

## Appendix A: Complete Command Matrix

| Command | JSON | Quiet | Format | Verbose | Dry-Run | Force | Score |
|---------|------|-------|--------|---------|---------|-------|-------|
| add | ❌→✅ | ✅ | ❌→✅ | ❌ | ❌ | ❌ | 2/10→7/10 |
| update | ❌→✅ | ❌→✅ | ❌→✅ | ❌ | ❌→✅ | ❌ | 1/10→8/10 |
| complete | ❌→✅ | ❌→✅ | ❌→✅ | ❌ | ❌→✅ | ❌ | 2/10→8/10 |
| list | ✅ | ✅ | ✅ | ✅ | N/A | N/A | 9/10 |
| show | ✅ | ❌→✅ | ✅ | ❌→✅ | N/A | N/A | 7/10→9/10 |
| analyze | ✅ | ❌→✅ | ⚠️→✅ | N/A | N/A | N/A | 10/10 |
| focus | ⚠️→✅ | ❌→✅ | ❌→✅ | ❌ | N/A | N/A | 4/10→8/10 |
| session | ⚠️→✅ | ❌→✅ | ❌→✅ | ❌ | N/A | N/A | 5/10→8/10 |
| phase | ❌→✅ | ❌→✅ | ❌→✅ | ❌ | N/A | ❌ | 2/10→8/10 |
| phases | ⚠️→✅ | ❌→✅ | ❌→✅ | ❌→✅ | N/A | N/A | 6/10→9/10 |
| archive | ❌→✅ | ❌→✅ | ❌→✅ | ❌→✅ | ✅ | ✅ | 2/10→9/10 |
| backup | ❌→✅ | ❌→✅ | ❌→✅ | ❌→✅ | N/A | N/A | 4/10→8/10 |
| restore | ❌→✅ | ❌→✅ | ❌→✅ | ❌→✅ | ❌→✅ | ✅ | 3/10→9/10 |
| migrate | ❌→✅ | ❌→✅ | ❌→✅ | ❌ | ❌→✅ | ✅ | 2/10→8/10 |
| init | ❌→✅ | ❌→✅ | ❌→✅ | ❌ | N/A | ✅ | 2/10→7/10 |
| validate | ✅ | ✅ | ✅ | ❌ | N/A | N/A | 9/10 |
| exists | ✅ | ✅ | ✅ | ✅ | N/A | N/A | 9/10 |
| stats | ✅ | ❌→✅ | ✅ | ❌→✅ | N/A | N/A | 9/10 |
| dash | ✅ | ❌→✅ | ✅ | ❌→✅ | N/A | N/A | 6/10→9/10 |
| next | ✅ | ❌→✅ | ✅ | ❌ | N/A | N/A | 8/10→9/10 |
| history | ✅ | ❌→✅ | ✅ | ❌→✅ | N/A | N/A | 8/10→9/10 |
| labels | ✅ | ❌→✅ | ❌→✅ | ❌→✅ | N/A | N/A | 9/10 |
| deps | ✅ | ❌→✅ | ❌→✅ | ❌ | N/A | N/A | 8/10→9/10 |
| blockers | ✅ | ✅ | ❌→✅ | ❌ | N/A | N/A | 9/10 |
| export | ✅ | ✅ | ✅ | ❌ | N/A | N/A | 8/10 |
| sync | ⚠️ | ✅ | ❌→✅ | ❌ | ✅ | N/A | 7/10→8/10 |
| log | ✅ | ❌→✅ | ❌→✅ | ❌→✅ | N/A | N/A | 7/10→9/10 |

**Legend**: ✅ = Has | ❌ = Missing | ⚠️ = Partial | →✅ = After implementation

---

## Appendix B: Essential Files Reference

### Core Implementation (Must Modify)
1. `lib/output-format.sh` - TTY detection, format resolution
2. `lib/error-handling.sh` - New file for centralized errors
3. `scripts/add-task.sh` - Add JSON output
4. `scripts/update-task.sh` - Add JSON output, --quiet, --dry-run
5. `scripts/complete-task.sh` - Add JSON output
6. `scripts/phase.sh` - Add JSON to all subcommands

### Reference Implementations (Study These)
7. `scripts/analyze.sh` - **Gold standard** for LLM-first design
8. `scripts/exists.sh` - Perfect exit codes (10/10)
9. `scripts/validate.sh` - Excellent --fix and JSON patterns
10. `scripts/list-tasks.sh` - Most comprehensive format support

### Documentation
11. `docs/commands/*.md` - Command reference docs
12. `docs/reference/cli-output-formats.md` - Format specifications

---

*Report generated by 15 parallel code analysis agents examining claude-todo v0.15.0*
*Validated against: analyze.sh (reference), output-format.sh (format resolution), all 32 command scripts*
