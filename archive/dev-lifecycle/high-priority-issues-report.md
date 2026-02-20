# High Priority Issues Report
**Date**: 2025-12-12
**Scope**: Remaining HIGH PRIORITY issues from Phase 1 testing

## Executive Summary
Of the 5 reported HIGH PRIORITY issues, **ALL 5 REMAIN UNFIXED**. These are critical user experience problems that need immediate attention.

---

## Issue 1: Invalid Format Silent Fallback ❌ UNFIXED
**Severity**: HIGH
**Category**: Error Handling / Validation

### Current Behavior
```bash
$ claude-todo list --format invalid 2>&1
# Outputs default text format - NO ERROR
```

### Expected Behavior
```bash
$ claude-todo list --format invalid 2>&1
[ERROR] Invalid format 'invalid'. Must be one of: text, json, jsonl, markdown, csv, tsv
```

### Root Cause
The `list-tasks.sh` script has a `case` statement with a wildcard default that silently falls back to text format instead of erroring on invalid input.

### Impact
- Users don't know when they've mistyped a format option
- Silent failures hide typos and configuration errors
- Violates principle of least surprise

### Fix Location
`/home/keatonhoskins/.claude-todo/scripts/list-tasks.sh` - Add validation before case statement or add error in wildcard case.

---

## Issue 2: Labels Invalid Subcommand ❌ UNFIXED
**Severity**: HIGH
**Category**: Error Handling / Validation

### Current Behavior
```bash
$ claude-todo labels invalid 2>&1
No tasks found with label: invalid
```

### Expected Behavior
```bash
$ claude-todo labels invalid 2>&1
[ERROR] Unknown subcommand 'invalid'
Valid subcommands: show LABEL, stats
Usage: claude-todo labels [SUBCOMMAND] [OPTIONS]
```

### Root Cause
The `labels.sh` script treats unknown subcommands as implicit labels for the `show` command. Line 506-511:
```bash
*)
  # Could be a label for implicit 'show'
  if [[ ! "$1" =~ ^- ]]; then
    SUBCOMMAND="show"
    LABEL_ARG="$1"
    shift
```

This is too permissive - it treats everything non-option as a label, even clear typos like "stats" → "stat".

### Impact
- Typos in subcommands (`stat` instead of `stats`) are silently interpreted as label searches
- Users get confusing "No tasks found" instead of helpful error messages
- Makes debugging user mistakes harder

### Fix Location
`/home/keatonhoskins/.claude-todo/scripts/labels.sh` lines 506-512 - Add explicit subcommand validation before treating as label.

---

## Issue 3: Error Messages Show Script Names ❌ UNFIXED
**Severity**: HIGH
**Category**: User Experience / Professionalism

### Current Behavior
```bash
$ claude-todo dash --invalid-option 2>&1
[ERROR] Unknown option: --invalid-option
Run 'dash.sh --help' for usage
```

### Expected Behavior
```bash
$ claude-todo dash --invalid-option 2>&1
[ERROR] Unknown option: --invalid-option
Run 'claude-todo dash --help' for usage
```

### Root Cause
Scripts expose internal implementation detail (`.sh` filenames) in user-facing error messages.

**Confirmed Locations**:
- `/home/keatonhoskins/.claude-todo/scripts/dash.sh:759` - `echo "Run 'dash.sh --help' for usage"`
- `/home/keatonhoskins/.claude-todo/scripts/labels.sh:533` - `echo "Run 'labels.sh --help' for usage"`
- Usage functions in `dash.sh:93` and `labels.sh:77` - `Usage: dash.sh [OPTIONS]`

### Impact
- Exposes internal implementation to users
- Breaks abstraction of CLI wrapper
- Confuses users about how to actually invoke commands
- Unprofessional appearance

### Fix Pattern
Replace all instances:
- `dash.sh` → `claude-todo dash`
- `labels.sh` → `claude-todo labels`
- `list-tasks.sh` → `claude-todo list`
- etc.

### Fix Scope
**Project-Wide Search Needed**: All scripts in `scripts/` directory should be audited for this pattern.

---

## Issue 4: Empty Label Name ❌ UNFIXED
**Severity**: HIGH
**Category**: Input Validation

### Current Behavior
```bash
$ claude-todo labels show "" 2>&1
Tasks with label:  (17 tasks)
# Shows all tasks without labels (or matches empty string)
```

### Expected Behavior
```bash
$ claude-todo labels show "" 2>&1
[ERROR] Label name cannot be empty
Usage: claude-todo labels show LABEL
```

### Root Cause
The `labels.sh` script's `show` subcommand doesn't validate that the label argument is non-empty. It accepts empty string and treats it as a valid label filter.

### Impact
- Confusing output when user accidentally provides empty string
- May expose edge case in label filtering logic
- Unclear what "Tasks with label:  (17 tasks)" means to users

### Fix Location
`/home/keatonhoskins/.claude-todo/scripts/labels.sh` - Add validation after capturing `LABEL_ARG` to ensure it's not empty.

---

## Issue 5: Timestamp Consistency ❌ UNFIXED
**Severity**: HIGH
**Category**: Data Consistency / API Design

### Current Behavior
```bash
$ claude-todo dash -f json | jq -r '._meta.timestamp'
2025-12-12T20:12:53-08:00  # Local time with timezone offset

$ claude-todo list -f json | jq -r '._meta.timestamp'
2025-12-13T04:12:54Z  # UTC time with Z suffix
```

### Expected Behavior
Both commands should use the **same timestamp format**, preferably UTC for consistency:
```bash
2025-12-13T04:12:53Z  # ISO 8601 UTC format
```

### Root Cause
**Different timestamp generation functions**:

1. **dash.sh** (line 131):
   ```bash
   get_timestamp() {
     date -Iseconds
   }
   ```
   Produces: `2025-12-12T20:12:53-08:00` (local time with offset)

2. **list-tasks.sh** (line 429):
   ```bash
   CURRENT_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
   ```
   Produces: `2025-12-13T04:12:54Z` (UTC time)

### Impact
- **JSON API inconsistency**: Clients can't rely on single timestamp parser
- **Log aggregation problems**: Mixing local and UTC timestamps breaks chronological sorting
- **Data analysis issues**: Comparing timestamps across commands requires timezone conversion
- **Professional API design**: Well-designed APIs use consistent timestamp formats

### Fix Strategy
**Option 1 (Recommended)**: Standardize on UTC across all commands
- Create shared `get_utc_timestamp()` function in `lib/logging.sh` or `lib/output-format.sh`
- All commands use: `date -u +"%Y-%m-%dT%H:%M:%SZ"`
- Benefits: Log-friendly, no timezone ambiguity, sortable as strings

**Option 2**: Standardize on local time with offset
- All commands use: `date -Iseconds`
- Benefits: User-friendly for local workflows
- Drawbacks: Harder for log aggregation and cross-timezone users

### Fix Locations
- **dash.sh** line 131 - Change `get_timestamp()` to use UTC
- **Any other scripts** using timestamps in JSON output - Audit needed

### Verification Test
```bash
# After fix, both should output same format
dash_ts=$(claude-todo dash -f json | jq -r '._meta.timestamp')
list_ts=$(claude-todo list -f json | jq -r '._meta.timestamp')

# Extract format (everything after the T)
dash_fmt=$(echo "$dash_ts" | sed 's/.*T//')
list_fmt=$(echo "$list_ts" | sed 's/.*T//')

# Should match (e.g., both "HH:MM:SSZ" or both "HH:MM:SS-08:00")
echo "Dash format:  $dash_fmt"
echo "List format:  $list_fmt"
echo "Match: $([ "$dash_fmt" == *"Z" ] && [ "$list_fmt" == *"Z" ] && echo 'YES' || echo 'NO')"
```

---

## Priority Ranking

1. **Issue 5 (Timestamp Consistency)** - Affects API design, breaks tooling integration
2. **Issue 3 (Script Names in Errors)** - User-facing on every error, professional appearance
3. **Issue 1 (Invalid Format Fallback)** - Silent failures are dangerous
4. **Issue 2 (Labels Invalid Subcommand)** - Confusing UX, makes debugging harder
5. **Issue 4 (Empty Label Name)** - Edge case but poor UX

---

## Recommended Fix Order

### Quick Wins (< 30 min total)
1. Fix Issue 4: Add 2-line validation check for empty label
2. Fix Issue 1: Add format validation before case statement

### Moderate Effort (1-2 hours)
3. Fix Issue 2: Add explicit subcommand whitelist validation
4. Fix Issue 3: Project-wide find/replace for script names in error messages

### Architecture (2-3 hours)
5. Fix Issue 5: Create shared timestamp function, update all commands, add test coverage

---

## Testing Checklist

After fixes, verify with:
```bash
# Issue 1
claude-todo list --format invalid 2>&1 | grep -q "ERROR.*Invalid format" && echo "✓ FIXED" || echo "✗ STILL BROKEN"

# Issue 2
claude-todo labels invalidcmd 2>&1 | grep -q "ERROR.*Unknown subcommand" && echo "✓ FIXED" || echo "✗ STILL BROKEN"

# Issue 3
claude-todo dash --bad 2>&1 | grep -q "\.sh" && echo "✗ STILL BROKEN" || echo "✓ FIXED"

# Issue 4
claude-todo labels show "" 2>&1 | grep -q "ERROR.*cannot be empty" && echo "✓ FIXED" || echo "✗ STILL BROKEN"

# Issue 5
dash_ts=$(claude-todo dash -f json | jq -r '._meta.timestamp')
list_ts=$(claude-todo list -f json | jq -r '._meta.timestamp')
[[ "$dash_ts" == *"Z" ]] && [[ "$list_ts" == *"Z" ]] && echo "✓ FIXED" || echo "✗ STILL BROKEN"
```

---

## Additional Findings

### Pattern: Inconsistent Error Handling
Multiple scripts share the same error handling anti-patterns:
- No input validation before processing
- Silent fallbacks instead of errors
- Internal implementation leaking to user messages

**Recommendation**: Create standardized error handling functions in `lib/logging.sh`:
```bash
validate_enum() {
  local value="$1"
  local allowed="$2"  # space-separated
  local param_name="$3"

  if [[ ! " $allowed " =~ " $value " ]]; then
    echo "[ERROR] Invalid $param_name '$value'" >&2
    echo "Must be one of: ${allowed// /, }" >&2
    return 1
  fi
}

validate_not_empty() {
  local value="$1"
  local param_name="$2"

  if [[ -z "$value" ]]; then
    echo "[ERROR] $param_name cannot be empty" >&2
    return 1
  fi
}
```

### Pattern: Script Name Leakage
**Full audit needed** for all scripts to replace internal filenames with CLI commands.

**Search command**:
```bash
grep -r "\.sh" ~/.claude-todo/scripts/*.sh | grep -E "echo|printf" | grep -v "^#"
```

---

## Conclusion

All 5 HIGH PRIORITY issues remain unfixed. These are not edge cases - they represent fundamental UX and API design problems that users will encounter regularly. Recommend addressing in order listed above, starting with quick wins to show immediate progress.
