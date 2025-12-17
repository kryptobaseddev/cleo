# Claude-TODO LLM-Agent Optimization Report

> Comprehensive analysis of CLI output formats, flags, and recommendations for LLM-agent-first design

**Generated**: 2025-12-17
**Analysis Scope**: 28 commands, 100+ flags, 12 parallel review agents
**Current State**: Human-readable default outputs
**Target State**: LLM-agent-first with HITL flags for human interaction

---

## Executive Summary

The claude-todo CLI system is **well-architected** with comprehensive JSON support in most commands, but defaults to **human-readable output** across the board. This report provides a complete inventory of current state and actionable optimizations to make the system **LLM-agent-first** while preserving human interaction capabilities.

### Key Findings

| Metric | Current | Target |
|--------|---------|--------|
| Commands with JSON support | 22/28 (79%) | 28/28 (100%) |
| Default output format | `text` (human) | `json` (machine) |
| Commands with `--quiet` flag | 8/28 (29%) | 28/28 (100%) |
| Standardized error JSON | 0% | 100% |
| Exit code documentation | 50% | 100% |

### Critical Gaps

1. **6 commands lack JSON output**: `add`, `update`, `complete`, `init`, `migrate`, `restore`
2. **No unified error JSON format** across commands
3. **Default format is `text`** requiring explicit `--format json` flags
4. **Inconsistent metadata envelopes** in JSON outputs

---

## Part 1: Command LLM-Optimization Scores

### Tier 1: Production-Ready for Agents (8-10/10)

| Command | Score | JSON | Quiet | Notes |
|---------|-------|------|-------|-------|
| `list` | 9/10 | Full envelope | Yes | Best-in-class, all formats supported |
| `exists` | 9/10 | Clean structure | Yes | Perfect exit codes, scriptable |
| `blockers` | 9/10 | Full envelope | Yes | Critical path analysis included |
| `labels` | 9/10 | Full envelope | No | Co-occurrence analysis excellent |
| `analyze` | 8/10 | Full (`--json`) | No | Leverage scoring, recommendations |
| `export` | 8/10 | Multiple formats | Yes | TodoWrite, CSV, TSV, JSON |
| `validate` | 8/10 | Envelope | Yes | Auto-fix capability |
| `deps` | 8/10 | Graph structure | No | Adjacency list format |

### Tier 2: Usable with Limitations (5-7/10)

| Command | Score | JSON | Quiet | Issues |
|---------|-------|------|-------|--------|
| `show` | 7/10 | Yes | No | No quiet mode |
| `next` | 8/10 | Yes | No | Missing quiet mode |
| `history` | 8/10 | Yes | No | Missing per-task details |
| `log` | 7/10 | Yes | No | Raw array, no envelope |
| `stats` | 9/10 | Yes | No | Cleanest JSON structure |
| `dash` | 6/10 | Yes | No | Complex nested output |
| `session` | 5/10 | Partial | No | Only status/info support JSON |
| `phases` | 4/10 | Yes | No | Heavy human formatting |

### Tier 3: Requires Enhancement (1-4/10)

| Command | Score | JSON | Quiet | Critical Issues |
|---------|-------|------|-------|-----------------|
| `focus` | 4/10 | Partial | No | Only `show` has JSON |
| `backup` | 4/10 | Metadata only | No | No JSON output mode |
| `add` | 2/10 | **No** | Yes | Cannot get created task as JSON |
| `update` | 1/10 | **No** | No | No output control whatsoever |
| `complete` | 2/10 | **No** | No | No confirmation JSON |
| `restore` | 3/10 | **No** | No | Interactive only |
| `migrate` | 2/10 | **No** | No | Text-only status |
| `init` | 2/10 | **No** | No | Procedural, no output |
| `phase` | 2/10 | **No** | No | Text-only lifecycle |
| `archive` | 2/10 | **No** | No | Statistics as text only |
| `sync` | 4/10 | Partial | Yes | Status not JSON |

---

## Part 2: Flag Inventory by Category

### Output Format Flags (HIGH LLM RELEVANCE)

| Flag | Short | Commands | Values | Default |
|------|-------|----------|--------|---------|
| `--format` | `-f` | list, show, export, log, dash, history, phases, labels, blockers, deps, next, stats | text, json, jsonl, csv, tsv, markdown, table | text |
| `--json` | `-j` | analyze, validate, focus, session | boolean | false |
| `--quiet` | `-q` | add, validate, list, export, complete, sync, history | boolean | false |
| `--verbose` | `-v` | list, restore, backup, complete | boolean | false |

### Filtering Flags (HIGH LLM RELEVANCE)

| Flag | Short | Commands | Values |
|------|-------|----------|--------|
| `--status` | `-s` | list, export | pending, active, blocked, done |
| `--priority` | `-p` | list, export | critical, high, medium, low |
| `--phase` | | list, inject | phase slug |
| `--label` | `-l` | list, export | label name |
| `--since` | | list, history, log | ISO 8601 date |
| `--until` | | list, history | ISO 8601 date |

### Execution Control Flags (MEDIUM LLM RELEVANCE)

| Flag | Commands | Purpose |
|------|----------|---------|
| `--dry-run` | sync, archive, migrate | Preview without changes |
| `--force` | init, archive, restore, migrate | Skip confirmations |
| `--auto-focus` | analyze | Auto-set focus to top task |
| `--skip-notes` | complete | Skip notes requirement |
| `--fix` | validate | Auto-fix issues |

### Environment Variables

| Variable | Purpose | LLM Relevance |
|----------|---------|---------------|
| `CLAUDE_TODO_FORMAT` | Default output format | **HIGH** |
| `CLAUDE_TODO_HOME` | Installation directory | Medium |
| `CLAUDE_TODO_DEBUG` | Debug mode | Low |
| `NO_COLOR` | Disable ANSI colors | **HIGH** |
| `FORCE_COLOR` | Force colors | Low |

---

## Part 3: JSON Output Quality Assessment

### Commands with Excellent JSON (A Grade)

```
list, analyze, stats, labels, blockers, deps, next
```

**Characteristics**:
- `_meta` envelope with version, command, timestamp
- `$schema` reference included
- Summary counts pre-calculated
- jq-parseable with `.tasks[]` pattern

### Commands with Good JSON (B Grade)

```
show, dash, history, phases, export
```

**Issues**:
- Missing `_meta` in some cases
- Inconsistent field naming
- Some missing execution_ms timing

### Commands with Problematic JSON (C-D Grade)

```
log, focus, session, validate
```

**Issues**:
- Raw arrays without envelope
- Mixed text/JSON output
- Partial subcommand support only

### Commands with No JSON (F Grade)

```
add, update, complete, init, migrate, restore, archive, phase
```

**Critical**: These write operations provide no machine-readable confirmation.

---

## Part 4: Recommended Changes

### Priority 1: Add JSON to Write Operations (CRITICAL)

**Impact**: Enables closed-loop automation without re-querying

#### `add --format json`
```json
{
  "_meta": {"command": "add", "timestamp": "...", "version": "..."},
  "success": true,
  "task": {
    "id": "T042",
    "title": "...",
    "status": "pending",
    "priority": "medium",
    "createdAt": "..."
  }
}
```

#### `update --format json`
```json
{
  "_meta": {"command": "update", "timestamp": "..."},
  "success": true,
  "taskId": "T042",
  "changes": {
    "priority": {"before": "medium", "after": "high"},
    "labels": {"before": ["bug"], "after": ["bug", "urgent"]}
  },
  "task": { /* full updated task */ }
}
```

#### `complete --format json`
```json
{
  "_meta": {"command": "complete", "timestamp": "..."},
  "success": true,
  "taskId": "T042",
  "completedAt": "2025-12-17T10:00:00Z",
  "cycleTimeDays": 3.5,
  "archived": false
}
```

### Priority 2: Change Default Format

**Option A**: Environment-based default (Recommended)
```bash
# In ~/.bashrc or ~/.zshrc for agent environments
export CLAUDE_TODO_FORMAT=json
```

**Option B**: Config-based default
```json
// .claude/todo-config.json
{
  "output": {
    "defaultFormat": "json",
    "agentMode": true
  }
}
```

**Option C**: Auto-detect TTY
```bash
# In lib/output-format.sh resolve_format()
if [[ ! -t 1 ]]; then
  # Not a terminal, default to JSON
  DEFAULT_FORMAT="json"
fi
```

### Priority 3: Standardize Error JSON

**Universal Error Format**:
```json
{
  "_meta": {"command": "...", "timestamp": "...", "version": "..."},
  "success": false,
  "error": {
    "code": "TASK_NOT_FOUND",
    "message": "Task T999 does not exist",
    "exitCode": 1,
    "recoverable": false,
    "suggestion": "Use 'ct exists T999' to verify task ID"
  }
}
```

**Implementation**: Add to `lib/output-format.sh`:
```bash
output_error_json() {
  local code="$1" message="$2" exit_code="$3" recoverable="$4" suggestion="$5"
  jq -n --arg code "$code" --arg msg "$message" --arg exit "$exit_code" \
    --arg rec "$recoverable" --arg sug "$suggestion" \
    '{_meta: {command: env.COMMAND, timestamp: now | todate},
      success: false,
      error: {code: $code, message: $msg, exitCode: ($exit|tonumber),
              recoverable: ($rec=="true"), suggestion: $sug}}'
}
```

### Priority 4: Add `--quiet` to All Commands

**Commands needing `--quiet`**:
- `show`, `next`, `stats`, `dash`, `deps`, `blockers`, `labels`, `phases`
- `focus`, `session`, `backup`, `restore`, `migrate`, `archive`, `phase`

**Behavior**:
- Suppress informational messages
- Output only data (JSON if `--format json`)
- Preserve error output to stderr

### Priority 5: Add HITL Flags for Human Mode

For LLM-first defaults, add explicit human flags:

| Flag | Purpose |
|------|---------|
| `--human` | Force human-readable output |
| `--interactive` | Enable confirmation prompts |
| `--colors` | Force color output |
| `--progress` | Show progress indicators |

**Example**:
```bash
# Agent mode (default after changes)
ct list  # Returns JSON

# Human mode (explicit)
ct list --human  # Returns formatted text with colors
ct complete T001 --interactive  # Prompts for notes
```

---

## Part 5: Implementation Roadmap

### Phase 1: Foundation (Week 1)

1. **Add JSON output to write commands**
   - `scripts/add-task.sh`: Add `--format json` flag
   - `scripts/update-task.sh`: Add `--format json` flag
   - `scripts/complete-task.sh`: Add `--format json` flag

2. **Standardize error JSON format**
   - Create `lib/error-format.sh` with `output_error_json()`
   - Integrate into all commands

3. **Add `--quiet` to remaining commands**
   - Audit all 28 commands
   - Add flag parsing and message suppression

### Phase 2: Default Behavior (Week 2)

4. **Implement TTY auto-detection**
   - Modify `resolve_format()` to default to JSON when not TTY
   - Add `CLAUDE_TODO_AGENT_MODE=1` env var

5. **Add `--human` flag**
   - Explicit override for human-readable output
   - Document as primary HITL mechanism

6. **Update documentation**
   - Add "Agent Integration" section to each command doc
   - Document JSON structures for all commands

### Phase 3: Polish (Week 3)

7. **Standardize JSON envelopes**
   - Ensure all JSON outputs include `_meta`
   - Add `$schema` references

8. **Add exit code constants**
   - Create `lib/exit-codes.sh` with documented codes
   - Use consistently across all commands

9. **Create agent workflow examples**
   - Document common agent patterns
   - Provide shell script templates

---

## Part 6: Quick Reference for Agents

### Recommended Command Patterns

```bash
# Task Creation (after Priority 1 implementation)
ct add "Task title" --format json | jq '.task.id'

# Task Query
ct list --format json --status pending | jq '.tasks[].id'

# Single Task Details
ct show T001 --format json | jq '.status'

# Analysis for Next Action
ct analyze --json | jq '.recommendations.topTask'

# Dependency Check
ct deps T001 --format json | jq '.upstream_dependencies'

# Validation
ct validate --json --quiet && echo "Valid"

# Focus Management
ct focus show --json | jq '.currentTask'
```

### Exit Code Reference

| Code | Meaning | Recovery |
|------|---------|----------|
| 0 | Success | N/A |
| 1 | Validation/argument error | Check input |
| 2 | File operation error | Check permissions |
| 3 | Data integrity error | Run validate --fix |
| 4 | Lock timeout | Retry after delay |

### Environment Setup for Agents

```bash
# Agent-optimized environment
export CLAUDE_TODO_FORMAT=json
export NO_COLOR=1
export CLAUDE_TODO_AGENT_MODE=1
```

---

## Part 7: Metrics for Success

### Before Optimization

- Default output: Human-readable text
- Agent must: Add `--format json` to every command
- Error handling: Parse colored text messages
- Write confirmation: Re-query after every mutation

### After Optimization

- Default output: JSON (when not TTY)
- Agent receives: Structured data automatically
- Error handling: Parse `error.code` field
- Write confirmation: Response includes result

### Measurable Goals

| Metric | Current | Target |
|--------|---------|--------|
| Commands with JSON | 79% | 100% |
| Commands with `--quiet` | 29% | 100% |
| Agent workflow steps | 2x (command + verify) | 1x (command with result) |
| Error parsing complexity | Regex required | JSON field access |

---

## Appendix A: Complete Command Matrix

| Command | JSON | Quiet | HITL Needed | Priority |
|---------|------|-------|-------------|----------|
| add | No → Yes | Yes | --interactive | P1 |
| update | No → Yes | No → Yes | --interactive | P1 |
| complete | No → Yes | No → Yes | --interactive | P1 |
| list | Yes | Yes | --human | Done |
| show | Yes | No → Yes | --human | P3 |
| analyze | Yes | No → Yes | --human | P3 |
| dash | Yes | No → Yes | --human | P3 |
| next | Yes | No → Yes | --human | P3 |
| stats | Yes | No → Yes | --human | P3 |
| focus | Partial | No → Yes | --human | P2 |
| session | Partial | No → Yes | --interactive | P2 |
| phases | Yes | No → Yes | --human | P3 |
| phase | No → Yes | No → Yes | --interactive | P2 |
| labels | Yes | No → Yes | --human | P3 |
| deps | Yes | No → Yes | --human | P3 |
| blockers | Yes | Yes | --human | Done |
| export | Yes | Yes | --human | Done |
| exists | Yes | Yes | N/A | Done |
| validate | Yes | Yes | --interactive | Done |
| archive | No → Yes | No → Yes | --interactive | P2 |
| backup | No → Yes | No → Yes | --interactive | P2 |
| restore | No → Yes | No → Yes | --interactive | P2 |
| migrate | No → Yes | No → Yes | --interactive | P2 |
| init | No → Yes | No → Yes | --interactive | P2 |
| sync | Partial | Yes | --interactive | P2 |
| history | Yes | No → Yes | --human | P3 |
| log | Yes | No → Yes | --human | P3 |

---

## Appendix B: JSON Schema Reference

### Standard Envelope

```json
{
  "$schema": "https://claude-todo.dev/schemas/output-v2.json",
  "_meta": {
    "format": "json",
    "version": "0.15.0",
    "command": "list",
    "timestamp": "2025-12-17T10:00:00Z",
    "checksum": "abc123...",
    "execution_ms": 45
  },
  "success": true,
  "summary": {},
  "data": []
}
```

### Error Envelope

```json
{
  "$schema": "https://claude-todo.dev/schemas/error-v1.json",
  "_meta": {
    "format": "json",
    "version": "0.15.0",
    "command": "update",
    "timestamp": "2025-12-17T10:00:00Z"
  },
  "success": false,
  "error": {
    "code": "TASK_NOT_FOUND",
    "message": "Task T999 does not exist",
    "exitCode": 1,
    "recoverable": false,
    "details": {},
    "suggestion": "Verify task ID with 'ct exists T999'"
  }
}
```

---

*Report generated by 12 parallel analysis agents examining all aspects of the claude-todo CLI system.*
