# Context Alert Library API Design

**Version**: 1.0.0
**Date**: 2026-01-03
**Task**: T1322
**Author**: Claude (Opus 4.5)

## Executive Summary

This document defines the API and behavior for `lib/context-alert.sh`, the shared library for context window usage alerts. The library provides session-aware, threshold-crossing detection to alert LLM agents when they should consider gracefully stopping work.

## Dependencies

**Research Findings**: T1321 (`docs/research/context-alert-triggers.md`)

**Key Finding**: High-priority triggers are:
- `complete` - After task completion (major progress milestone)
- `add --parent` - After subtask creation (decomposition work)
- `session end` - After session end (natural checkpoint)

## API Design

### Function Signature

```bash
# Check context usage and emit alert if threshold crossed
# Args:
#   --force         Optional. Emit alert regardless of threshold (for debugging)
# Returns:
#   0 - No alert needed or session not active
#   1 - Alert was emitted to stderr
check_and_alert_context() {
    # Implementation
}
```

### Usage Pattern

```bash
# In scripts/complete.sh after successful completion
source "$LIB_DIR/context-alert.sh"
# ... task completion logic ...
check_and_alert_context  # Silently returns if no alert needed
```

## Session Detection

### Active Session Check

**File**: `.cleo/.current-session`

**Logic**:
1. If file doesn't exist → no active session → return 0 (silent)
2. If file exists but empty → no active session → return 0 (silent)
3. If file contains session ID → check context state file

**Rationale**: Alerts are only relevant during active work sessions. Without a session, there's no agent loop to interrupt.

### Context State File Resolution

**Session-Specific**: `.cleo/.context-state-<session-id>.json`
**Global Fallback**: `.cleo/.context-state.json`

**Logic**:
1. Read session ID from `.current-session`
2. Check for session-specific state file first
3. Fall back to global state file if session file missing
4. If no state file exists → return 0 (silent, no data to alert on)

**Rationale**: Multi-session support requires isolated context tracking per agent.

## Threshold Crossing Detection

### Current Status Retrieval

Read from context state file (using logic from `scripts/context.sh`):

```json
{
  "timestamp": "2026-01-03T21:35:20Z",
  "contextWindow": {
    "percentage": 87,
    "currentTokens": 174000,
    "maxTokens": 200000
  },
  "status": "caution"
}
```

**Status Enum**: `ok` | `warning` | `caution` | `critical` | `emergency` | `stale`

### Threshold Mapping

From `lib/exit-codes.sh`:

| Status | Range | Exit Code |
|--------|-------|-----------|
| `ok` | <70% | 0 |
| `warning` | 70-84% | 50 |
| `caution` | 85-89% | 51 |
| `critical` | 90-94% | 52 |
| `emergency` | 95%+ | 53 |
| `stale` | No data | 54 |

### Last-Alerted Tracking

**File**: `.cleo/.context-last-alert-<session-id>`

**Format**: Plain text containing last alerted status (`ok`, `warning`, `caution`, etc.)

**Logic**:
1. Read current status from `.context-state-<session-id>.json`
2. Read last-alerted status from `.context-last-alert-<session-id>`
3. If last-alerted file missing → treat as `ok` (never alerted before)
4. Compare statuses using ordinal ranking:
   - `ok` (0) < `warning` (1) < `caution` (2) < `critical` (3) < `emergency` (4)
5. Only emit alert if current status > last-alerted status
6. After emitting alert, update `.context-last-alert-<session-id>` with current status

**Rationale**:
- Prevents alert spam on repeated calls at same threshold
- Only alerts on upward transitions (70% → 85% triggers alert, 85% → 85% does not)
- Each session has isolated alert state for multi-agent workflows

### Status Ordinal Mapping

```bash
status_to_ordinal() {
    local status="$1"
    case "$status" in
        ok)        echo 0 ;;
        warning)   echo 1 ;;
        caution)   echo 2 ;;
        critical)  echo 3 ;;
        emergency) echo 4 ;;
        stale)     echo 5 ;;  # Highest severity
        *)         echo -1 ;; # Unknown
    esac
}
```

## Output Format

### Stderr Box Alert

**Target Stream**: `stderr` (never stdout, as commands use stdout for JSON data)

**TTY Detection**: Use `[[ -t 2 ]]` to detect if stderr is a terminal

**Format** (TTY detected):

```
⚠️  ══════════════════════════════════════════════════════════════════
    CONTEXT [CAUTION]: 87% (174000/200000 tokens)

    Action: Consider completing current work and running:
            cleo session end --note "Progress summary"
══════════════════════════════════════════════════════════════════ ⚠️
```

**Format** (non-TTY, e.g., piped to file):

```
[CONTEXT ALERT] CAUTION: 87% (174000/200000 tokens)
Action: Consider completing current work and running: cleo session end --note "Progress summary"
```

### Unicode & Color Support

**Use existing utilities** from `lib/output-format.sh`:

- `detect_color_support()` - Check if colors available
- `detect_unicode_support()` - Check if Unicode available
- `draw_box()` - Get box-drawing characters (Unicode or ASCII fallback)
- `print_colored()` - Print with ANSI color codes

**Color Scheme** (when colors supported):

| Status | Color | ANSI Code |
|--------|-------|-----------|
| `warning` | Yellow | 33 |
| `caution` | Orange (bright yellow) | 93 |
| `critical` | Red | 31 |
| `emergency` | Bright Red | 91 |
| `stale` | Dim Gray | 90 |

### Recommended Actions by Status

| Status | Action Text |
|--------|-------------|
| `warning` | "Consider wrapping up current subtask" |
| `caution` | "Consider completing current work and running:\n        cleo session end --note \"Progress summary\"" |
| `critical` | "Strongly recommend stopping work immediately:\n        cleo session end --note \"Context limit approaching\"" |
| `emergency` | "STOP IMMEDIATELY - context limit reached:\n        cleo session end --note \"Emergency context shutdown\"" |
| `stale` | "Warning: Context data is stale. Check status line integration." |

## Staleness Check

### Stale Detection Logic

Reuse `is_stale()` function from `scripts/context.sh`:

```bash
is_stale() {
    local timestamp="$1"
    local stale_ms="${2:-5000}"  # Default 5 seconds

    local file_time=$(date -d "$timestamp" +%s 2>/dev/null || echo 0)
    local now=$(date +%s)
    local diff_ms=$(( (now - file_time) * 1000 ))

    [[ "$diff_ms" -gt "$stale_ms" ]]
}
```

**Behavior**: If state file timestamp is stale (>5s old), treat status as `stale` and emit warning.

## Error Handling

### Missing State File

**Condition**: `.context-state-<session-id>.json` doesn't exist

**Behavior**: Return 0 (silent). No alert is better than false alarm.

**Rationale**: Status line integration may not be configured. Don't spam errors.

### Invalid JSON

**Condition**: State file exists but contains malformed JSON

**Behavior**: Return 0 (silent). Log warning to `.cleo/todo-log.json` if logging library available.

**Rationale**: Corruption shouldn't break commands. Alert library is advisory, not critical.

### Permission Errors

**Condition**: Cannot write `.context-last-alert-<session-id>` file

**Behavior**: Return 1 (alert was attempted), but don't fail the calling command.

**Rationale**: Alert is informational. Failing to track last-alerted state shouldn't prevent task completion.

## Integration Points

### High-Priority Commands

From T1321 research findings, these commands MUST call `check_and_alert_context`:

1. **scripts/complete.sh** - After successful task completion (line ~650)
2. **scripts/add.sh** - After adding task with `--parent` flag (line ~1000)
3. **scripts/session.sh** - After `session end` command (line ~760)

### Medium-Priority Commands (Future)

Optional cumulative triggers (tracked in session stats):

- `scripts/add.sh` - After 3+ tasks added in session
- `scripts/update.sh` - After 5+ updates in session
- `scripts/focus.sh` - After 3+ focus changes in session

**Deferred to future implementation**: Requires session stats counting integration.

## Testing Strategy

### Unit Tests

File: `tests/unit/context-alert.bats`

1. Test session detection (active vs. inactive)
2. Test threshold crossing detection (status transitions)
3. Test last-alerted state persistence
4. Test staleness detection
5. Test output format (TTY vs. non-TTY)
6. Test Unicode/color detection fallbacks
7. Test --force flag override

### Integration Tests

File: `tests/integration/context-alert-cli.bats`

1. Test alert triggered after `cleo complete`
2. Test no alert when status unchanged
3. Test alert suppression when session not active
4. Test multi-session isolation (two sessions, different thresholds)

## File Structure

### New Files

- `lib/context-alert.sh` - Library implementation
- `tests/unit/context-alert.bats` - Unit tests
- `tests/integration/context-alert-cli.bats` - Integration tests

### Modified Files

- `scripts/complete.sh` - Add `check_and_alert_context` call
- `scripts/add.sh` - Add `check_and_alert_context` call (parent check)
- `scripts/session.sh` - Add `check_and_alert_context` call (end command)

## Implementation Checklist

- [ ] Create `lib/context-alert.sh` with `check_and_alert_context()` function
- [ ] Implement session detection logic
- [ ] Implement threshold crossing detection with last-alerted tracking
- [ ] Implement stderr box alert output (TTY and non-TTY formats)
- [ ] Add color/Unicode support using `output-format.sh` utilities
- [ ] Implement staleness check
- [ ] Add error handling for missing/invalid state files
- [ ] Write unit tests for all logic paths
- [ ] Write integration tests for CLI workflows
- [ ] Integrate into `complete.sh`, `add.sh`, `session.sh`
- [ ] Update documentation in `docs/commands/context.md`

## Future Enhancements (Out of Scope)

1. **Cumulative triggers** - Alert after N operations (requires session stats)
2. **Configurable thresholds** - Allow users to customize alert percentages
3. **Alert suppression flag** - `--no-alert` to disable for specific commands
4. **Alert history** - Track all alerts in session for debugging

## References

- **Research**: `docs/research/context-alert-triggers.md` (T1321)
- **Exit Codes**: `lib/exit-codes.sh` (EXIT_CONTEXT_* codes)
- **Output Utilities**: `lib/output-format.sh`
- **Context Command**: `scripts/context.sh`
- **Specification**: `claudedocs/spec/CONTEXT-SAFEGUARD-SPEC.md`

## Acceptance Criteria

1. ✅ Function signature defined with --force flag
2. ✅ Session detection logic specified (checks `.current-session`)
3. ✅ Threshold crossing detection designed (ordinal comparison)
4. ✅ Last-alerted state tracking specified (per-session file)
5. ✅ Output format documented (TTY box, non-TTY plain text)
6. ✅ Color/Unicode support strategy defined (reuse output-format.sh)
7. ✅ Error handling specified (silent fallback for missing state)
8. ✅ Integration points identified (complete, add --parent, session end)
9. ✅ Testing strategy outlined (unit + integration tests)
10. ✅ Implementation checklist provided

## Design Decisions Summary

| Decision | Rationale |
|----------|-----------|
| Silent return when no session active | Alerts only relevant during agent work loops |
| Per-session last-alerted tracking | Multi-session support requires isolation |
| Ordinal status comparison | Prevents alert spam on repeated calls at same threshold |
| Stderr output, never stdout | Commands use stdout for JSON data, can't pollute |
| TTY-aware formatting | Box drawing for terminals, plain text for logs |
| Reuse `output-format.sh` utilities | Consistent color/Unicode detection across codebase |
| Silent fallback on missing state | No false alarms if status line not configured |
| High-priority triggers only (Phase 1) | Complete, add --parent, session end are major milestones |

---

**Next Task**: T1323 - Implement `lib/context-alert.sh` based on this design
