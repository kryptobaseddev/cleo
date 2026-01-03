# Context Alert Triggers Research

**Version**: 1.0.0
**Date**: 2026-01-03
**Task**: T1321
**Author**: Claude (Opus 4.5)

## Executive Summary

This document identifies all commands that should trigger context window alerts and documents their output patterns. Context alerts should trigger after **write operations that indicate meaningful work progress** to help LLM agents manage context window usage effectively.

## Session-Aware Commands Analysis

All write commands implement session enforcement via `lib/session-enforcement.sh`:

| Command | Session Check | Function Used | Line Location |
|---------|---------------|---------------|---------------|
| `add-task.sh` | ✅ Yes | `require_active_session "add" "$FORMAT"` | Line 738-741 |
| `complete-task.sh` | ✅ Yes | `require_active_session "complete" "$FORMAT"` | Line 259-262 |
| `update-task.sh` | ✅ Yes | `require_active_session "update" "$FORMAT"` | Line 627-630 |
| `focus.sh` | ❌ No | N/A | Not checked |
| `session.sh` | ❌ No | N/A | Session management itself |

**Session Enforcement Logic** (`lib/session-enforcement.sh`):
- `require_active_session()`: Lines 217-288
- `validate_task_in_scope()`: Lines 301-391
- Enforcement modes: `strict` (block), `warn` (allow with warning), `none` (disabled)
- Enabled when `multiSession.enabled=true` in config

## Output Function Patterns

### Standard Output Streams

All commands follow this pattern:

| Stream | Purpose | When Used |
|--------|---------|-----------|
| `stdout` | Structured JSON output (default) | Success responses, data output |
| `stderr` | Error messages (JSON or text) | Validation errors, operation failures |

### Output Functions Used

Analysis of `lib/output-format.sh` reveals NO specialized output functions like `output_success`, `output_json`, or `emit_json`. Instead, commands use:

1. **Direct `jq -nc` for JSON output** (lines 735-764 in session.sh)
2. **Direct `echo` for text output** (lines 38-47 in add-task.sh tail)
3. **Error library functions** from `lib/error-json.sh`:
   - `output_error()` for structured errors
   - `output_error_actionable()` for errors with fix commands

### Format Resolution

From `lib/output-format.sh`:
- `resolve_format()` (lines 232-266): Determines output format
- Priority: CLI arg > `CLEO_FORMAT` env var > config > **JSON default**
- **LLM-Agent-First**: JSON is the default output format
- Use `--human` flag for text output

### Output Pattern by Command

| Command | Success Output Location | Format | Stream |
|---------|------------------------|--------|--------|
| `add-task.sh` | Lines 993-1027 (tail -50) | JSON or text | stdout |
| `complete-task.sh` | Lines 605-655 (tail -50) | JSON or text | stdout |
| `update-task.sh` | Lines 843-893 (tail -50) | JSON or text | stdout |
| `focus.sh` | Throughout command handlers | JSON or text | stdout |
| `session.sh` | Lines 732-764 (start), others for list/end | JSON or text | stdout |

## Recommended Context Alert Triggers

### HIGH PRIORITY (Always Trigger)

These commands indicate significant work progress and should ALWAYS trigger context alerts:

| Command | Trigger Condition | Rationale |
|---------|------------------|-----------|
| `complete` | After successful task completion | Major progress milestone, may auto-complete parents |
| `add` | After adding task with `--parent` (subtask creation) | Indicates decomposition/planning work |
| `session end` | After ending active session | Natural checkpoint for context review |

### MEDIUM PRIORITY (Conditional Trigger)

These commands should trigger alerts based on frequency or cumulative count:

| Command | Trigger Condition | Rationale |
|---------|------------------|-----------|
| `add` | After 3+ tasks added in session | Bulk planning indicates progress |
| `update` | After 5+ updates in session | Multiple updates indicate active work |
| `focus set` | After 3+ focus changes in session | Frequent switching may indicate context load |

### LOW PRIORITY (No Trigger)

These commands don't indicate work progress:

| Command | Rationale |
|---------|-----------|
| `list`, `show`, `dash`, `analyze` | Read-only, no state change |
| `session start`, `session status` | Session setup, not work |
| `focus show`, `focus note` | Query or annotation only |

## Output Detection Strategy

### Success Detection

Commands output JSON to stdout with this envelope:

```json
{
  "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
  "_meta": {
    "format": "json",
    "command": "complete",
    "timestamp": "2026-01-03T21:35:20Z",
    "version": "0.48.4"
  },
  "success": true,
  ...
}
```

**Detection Logic**:
1. Parse JSON from stdout
2. Check `success` field
3. Extract `_meta.command` to identify operation type
4. Check trigger conditions (see table above)

### Error Detection

Errors output to stderr with this format:

```json
{
  "$schema": "https://cleo-dev.com/schemas/v1/error.schema.json",
  "_meta": { "format": "json", "version": "0.48.4", "command": "complete", "timestamp": "..." },
  "success": false,
  "error": {
    "code": "E_NOT_FOUND",
    "message": "Task not found",
    "exitCode": 4,
    "recoverable": true
  }
}
```

**No alert on errors** - Failed operations don't represent progress.

## Implementation Notes

### Stdout vs Stderr Routing

From script analysis:
- **Success responses**: Always stdout (JSON or text)
- **Error responses**: Always stderr (JSON or text)
- **Warnings**: stderr (text only, not JSON structured)

### Session State Tracking

Session stats are already tracked in `sessions.json`:

```json
{
  "stats": {
    "tasksCompleted": 0,
    "focusChanges": 2,
    "suspendCount": 0,
    "resumeCount": 0
  }
}
```

These counters can be used for **cumulative trigger thresholds**:
- Alert after `tasksCompleted >= 3`
- Alert after `focusChanges >= 5`

### Hook Integration Points

Best location for context alert logic:

1. **PostToolUse hook** in plugin (if available)
2. **Session stats update** in `lib/sessions.sh` (centralized)
3. **Command-specific** in each script's success output section

**Recommended**: Use session stats update as trigger point, avoiding duplication across 5+ scripts.

## Files Analyzed

| File | Purpose | Lines |
|------|---------|-------|
| `lib/output-format.sh` | Output formatting utilities | 842 |
| `lib/session-enforcement.sh` | Session scope enforcement | 408 |
| `scripts/add-task.sh` | Task creation | ~1000 |
| `scripts/complete-task.sh` | Task completion | ~650 |
| `scripts/update-task.sh` | Task updates | ~900 |
| `scripts/focus.sh` | Focus management | ~600 |
| `scripts/session.sh` | Session lifecycle | 1751 |

## Acceptance Criteria Checklist

- ✅ All write commands analyzed (add, complete, update, focus, session)
- ✅ Output function patterns documented (direct jq/echo, no helper functions)
- ✅ Recommended trigger points identified (3 tiers: high/medium/low priority)
- ✅ Stdout/stderr routing documented
- ✅ Session enforcement mechanism documented
- ✅ Implementation strategy provided (session stats integration)

## Next Steps

1. **T1322**: Design context alert message format
2. **T1323**: Implement alert triggering logic in session stats update
3. **T1324**: Add context alert suppression mechanism (--no-alert flag)
4. **T1325**: Test alert triggers across all write commands
