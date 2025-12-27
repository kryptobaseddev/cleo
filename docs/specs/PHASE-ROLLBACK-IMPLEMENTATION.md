# Phase Rollback Implementation

**Status**: Implemented
**Version**: v0.14.0
**Date**: 2025-12-17

## Overview

Implements phase rollback detection with `--rollback` flag requirement for backwards phase movement in the `cleo phase set` command.

## Implementation

### Files Modified

1. **scripts/phase.sh** - `cmd_set()` function
   - Added flag parsing for `--rollback` and `--force`
   - Phase order comparison logic
   - Rollback detection and blocking
   - Interactive confirmation prompt
   - JSON mode handling
   - Updated usage documentation

### Behavior

#### Forward Movement (No Restrictions)
```bash
# Moving to a higher order phase works normally
cleo phase set polish
# → Phase set to: polish
```

#### Backward Movement (Rollback Detection)

**Without --rollback flag** (blocked):
```bash
cleo phase set setup
# ERROR: Rolling back from 'Core Development' (order 2) to 'Setup & Foundation' (order 1) requires --rollback flag
# Exit code: 6 (EXIT_VALIDATION_ERROR)
```

**With --rollback flag** (requires confirmation):
```bash
cleo phase set setup --rollback
# WARNING: This will rollback from 'Core Development' (order 2) to 'Setup & Foundation' (order 1).
# Continue? [y/N]
```

**With --rollback --force** (no prompt):
```bash
cleo phase set setup --rollback --force
# Phase set to: setup
```

### JSON Mode

JSON mode requires `--force` for non-interactive rollback:

```bash
# Without --force (blocked)
cleo phase --json set setup --rollback
# {"success": false, "error": {"code": "E_PHASE_ROLLBACK_REQUIRES_FORCE", ...}}

# With --force (succeeds)
cleo phase --json set setup --rollback --force
# {"success": true, "currentPhase": "setup", ...}
```

### Error Codes

| Code | Constant | Meaning |
|------|----------|---------|
| `E_PHASE_ROLLBACK_FORBIDDEN` | EXIT_VALIDATION_ERROR (6) | Rollback attempted without --rollback flag |
| `E_PHASE_ROLLBACK_REQUIRES_FORCE` | EXIT_VALIDATION_ERROR (6) | Rollback in JSON mode without --force |

## Test Coverage

Comprehensive test suite in `dev/test-rollback.sh`:

1. Forward movement works without --rollback
2. Rollback blocked without --rollback flag
3. Rollback cancelled at interactive prompt
4. Rollback succeeds with prompt confirmation
5. Rollback succeeds with --force (no prompt)
6. JSON mode requires --force for rollback
7. JSON mode rollback succeeds with --force

All tests passing.

## Usage Examples

### Text Mode
```bash
# Attempt rollback (blocked)
$ cleo phase set setup
ERROR: Rolling back from 'Core Development' (order 2) to 'Setup & Foundation' (order 1) requires --rollback flag

# Rollback with confirmation
$ cleo phase set setup --rollback
WARNING: This will rollback from 'Core Development' (order 2) to 'Setup & Foundation' (order 1).
Continue? [y/N] y
Phase set to: setup

# Rollback without confirmation
$ cleo phase set setup --rollback --force
Phase set to: setup
```

### JSON Mode
```bash
# Attempt rollback without --force (blocked)
$ cleo phase --json set setup --rollback
{
  "_meta": {
    "command": "phase set",
    "timestamp": "2025-12-17T10:30:00Z"
  },
  "success": false,
  "error": {
    "code": "E_PHASE_ROLLBACK_REQUIRES_FORCE",
    "message": "Rollback requires --force flag in JSON mode (non-interactive)"
  }
}

# Rollback with --force (succeeds)
$ cleo phase --json set setup --rollback --force
{
  "_meta": {
    "command": "phase set",
    "timestamp": "2025-12-17T10:31:00Z"
  },
  "success": true,
  "previousPhase": "core",
  "currentPhase": "setup"
}
```

## Design Decisions

1. **Explicit flag requirement**: Forces users to acknowledge rollback action
2. **Interactive prompt**: Provides safeguard for accidental rollbacks
3. **--force override**: Supports automation and scripting scenarios
4. **JSON mode requires --force**: Non-interactive mode prevents hanging on prompts
5. **Order-based detection**: Uses `phases[].order` field for rollback detection
6. **Phase names in messages**: Shows human-readable names for clarity

## Future Enhancements

Potential improvements (not yet implemented):

1. **Phase history logging**: Record rollback reason in `project.phaseHistory`
2. **Incomplete task handling**: Option to mark current phase tasks as incomplete
3. **Rollback reason field**: `--reason "explanation"` for audit trail
4. **Batch rollback**: Support rolling back multiple phases at once
5. **Dry-run mode**: `--dry-run` to preview rollback effects

## Related Specifications

- **PHASE-ENHANCEMENT-RISK-ANALYSIS.md** - Original rollback design discussion
- **TASK-HIERARCHY-SPEC.md** - Phase tracking system architecture
- **LLM-AGENT-FIRST-SPEC.md** - JSON output format standards

## Verification

Run the test suite to verify implementation:
```bash
./dev/test-rollback.sh
```

Expected output: All 7 tests passing.
