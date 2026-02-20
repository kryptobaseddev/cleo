# Fix Report: T142 and T143 High Priority Issues

**Date**: 2025-12-12
**Issues Fixed**: T142 (format validation), T143 (unicode config)
**Test Results**: 24/24 tests passing

## Issue T142: Invalid format silently falls back

### Problem
The `list` command accepted invalid `--format` values and silently fell back to `text` format instead of reporting an error to the user.

```bash
# Before fix:
claude-todo list --format invalid   # Silently used 'text' format
claude-todo list --format xml       # Silently used 'text' format
```

### Impact
- User confusion when invalid formats accepted without feedback
- Difficult to debug format-related issues
- Inconsistent with other validation patterns in the system

### Root Cause
Missing format validation in `scripts/list-tasks.sh` after argument parsing.

### Fix Applied

**File**: `scripts/list-tasks.sh`

1. Added valid format constant:
```bash
VALID_FORMATS="text json jsonl markdown table"
```

2. Added validation after argument parsing (after line 169):
```bash
# Validate format (Issue T142: reject invalid formats instead of silent fallback)
if ! echo "$VALID_FORMATS" | grep -qw "$FORMAT"; then
  log_error "Invalid format: $FORMAT"
  echo "Valid formats: $VALID_FORMATS" >&2
  exit 1
fi
```

### Test Coverage

Created `tests/test-format-validation.sh` with 12 tests:

1. Valid format 'text' succeeds ✓
2. Valid format 'json' succeeds ✓
3. Valid format 'jsonl' succeeds ✓
4. Valid format 'markdown' succeeds ✓
5. Valid format 'table' succeeds ✓
6. Invalid format 'invalid' errors ✓
7. Invalid format 'xml' errors ✓
8. Invalid format 'yaml' errors ✓
9. Error message shows valid formats ✓
10. Invalid format exits with non-zero status ✓
11. Short flag `-f json` succeeds ✓
12. Short flag `-f invalid` errors ✓

**Result**: 12/12 PASS

### Verification

```bash
# After fix:
$ claude-todo list --format invalid
[ERROR] Invalid format: invalid
Valid formats: text json jsonl markdown table
$ echo $?
1

$ claude-todo list --format json
{"tasks":[...]}   # Works correctly
```

---

## Issue T143: unicodeEnabled config ignored

### Problem
The `output.unicodeEnabled` configuration setting in `todo-config.json` was being ignored. Unicode box-drawing characters and symbols were shown even when `unicodeEnabled` was set to `false`.

```bash
# Before fix:
$ jq '.output.unicodeEnabled = false' .claude/todo-config.json
$ claude-todo list
╭─────────────────────────────────────╮
│  📋 TASKS  ○ ◉ ⊗ ✓ 🔴 🟡           │  # Unicode still shown!
╰─────────────────────────────────────╯
```

### Impact
- Configuration setting had no effect
- Users unable to disable Unicode for accessibility needs
- ASCII environments (LANG=C, plain terminals) showed broken characters
- NO_COLOR compliance was working but config-based control was broken

### Root Cause
Bug in `lib/output-format.sh` config loading logic. The jq alternative operator (`//`) treats boolean `false` as a falsy value, causing:

```bash
# The problem:
$ jq -r '.output.unicodeEnabled // null' config.json
null   # When value is false, returns null instead of "false"!

# This is jq behavior: false // null evaluates to null
```

The config loader was using:
```bash
config_unicode=$(jq -r '.output.unicodeEnabled // null' "$OUTPUT_CONFIG_FILE")
```

When `unicodeEnabled` was `false`, jq returned `null` due to the alternative operator treating `false` as falsy, so the default value of `true` was used instead.

### Fix Applied

**File**: `lib/output-format.sh`

Replaced the jq query pattern from `// null` to explicit null checking:

```bash
# Before (broken):
config_unicode=$(jq -r '.output.unicodeEnabled // null' "$OUTPUT_CONFIG_FILE")
[[ "$config_unicode" != "null" ]] && _OUTPUT_CONFIG_UNICODE="$config_unicode"

# After (fixed):
config_unicode=$(jq -r 'if .output.unicodeEnabled != null then .output.unicodeEnabled else "undefined" end' "$OUTPUT_CONFIG_FILE")
[[ "$config_unicode" != "undefined" ]] && _OUTPUT_CONFIG_UNICODE="$config_unicode"
```

This pattern correctly handles:
- `true` → returns "true" → sets config
- `false` → returns "false" → sets config
- missing/null → returns "undefined" → keeps default

Applied to all boolean config values:
- `output.colorEnabled`
- `output.unicodeEnabled`
- `output.progressBars`
- `output.compactTitles`

And string/number values:
- `output.dateFormat`
- `output.csvDelimiter`
- `output.maxTitleLength`

### Test Coverage

Created `tests/test-unicode-config.sh` with 12 tests:

1. Unicode enabled by default ✓
2. Disable unicode via config ✓
3. ASCII fallback when disabled ✓
4. Re-enable unicode via config ✓
5. NO_COLOR env disables unicode ✓
6. Dashboard respects unicodeEnabled=false ✓
7. Dashboard ASCII boxes when disabled ✓
8. Stats respects unicodeEnabled=false ✓
9. Dashboard with unicodeEnabled=true ✓
10. Compact mode respects unicodeEnabled=false ✓
11. List compact mode respects unicodeEnabled=false ✓
12. Table format respects unicode ✓

**Result**: 12/12 PASS

### Verification

```bash
# After fix:
$ jq '.output.unicodeEnabled = false' .claude/todo-config.json
$ claude-todo list
+-------------------------------------------------------------------+
|  TASKS  - 1 pending  * 0 active  x 0 blocked  + 0 done          |
+-------------------------------------------------------------------+
# ASCII characters correctly shown!

$ jq '.output.unicodeEnabled = true' .claude/todo-config.json
$ claude-todo list
╭─────────────────────────────────────────────────────────────────╮
│  📋 TASKS  ○ 1 pending  ◉ 0 active  ⊗ 0 blocked  ✓ 0 done      │
╰─────────────────────────────────────────────────────────────────╯
# Unicode correctly shown!
```

### Priority Hierarchy Confirmed

The fix maintains the correct precedence order for unicode detection:

1. `NO_COLOR` environment variable (highest priority) → disables unicode
2. `LANG=C` or `LC_ALL=C` → disables unicode
3. `output.unicodeEnabled` config setting → respects true/false
4. Environment UTF-8 detection (`LANG` contains UTF-8) → enables unicode

### Scripts Affected

All scripts using `detect_unicode_support()` now correctly respect the config:
- `scripts/list-tasks.sh` ✓
- `scripts/dash.sh` ✓
- `scripts/stats.sh` ✓
- Any script sourcing `lib/output-format.sh` ✓

---

## Files Modified

### 1. `/mnt/projects/claude-todo/scripts/list-tasks.sh`
- Added `VALID_FORMATS` constant
- Added format validation after argument parsing
- Exit with error on invalid format

### 2. `/mnt/projects/claude-todo/lib/output-format.sh`
- Fixed `load_output_config()` function
- Changed jq query from `// null` to explicit null checking
- Prevents boolean false from being treated as undefined

### 3. `/mnt/projects/claude-todo/.claude/todo-config.json`
- Added complete `output` section with all settings
- Ensures config template has all required fields

### 4. Tests Created
- `/mnt/projects/claude-todo/tests/test-format-validation.sh` (12 tests)
- `/mnt/projects/claude-todo/tests/test-unicode-config.sh` (12 tests)

---

## Test Results Summary

```
Format Validation Tests (T142):  12/12 PASS
Unicode Config Tests (T143):     12/12 PASS
─────────────────────────────────────────────
Total:                           24/24 PASS
```

---

## Backward Compatibility

Both fixes are fully backward compatible:

1. **Format validation**: Only adds validation, doesn't change valid format behavior
2. **Unicode config**: Existing configs without `output` section use defaults (unicode enabled)

No breaking changes to:
- CLI arguments
- JSON output formats
- Configuration structure
- Script interfaces

---

## Related Configuration

The `output` section in `todo-config.json` now supports:

```json
{
  "output": {
    "defaultFormat": "text",
    "colorEnabled": true,
    "unicodeEnabled": true,
    "progressBars": true,
    "csvDelimiter": ",",
    "dateFormat": "iso8601",
    "compactTitles": false,
    "maxTitleLength": 80
  }
}
```

All boolean settings now correctly handle `true`/`false` values.

---

## Recommendations

1. **Update documentation**: Document the format validation behavior
2. **User communication**: Inform users that invalid formats now error (was silent before)
3. **Config migration**: Run `claude-todo init` in existing projects adds `output` section
4. **Accessibility**: Document `unicodeEnabled=false` for ASCII-only environments

---

## Notes

- The jq boolean handling issue is a known quirk of the `//` (alternative) operator
- Future config additions should use the same null-checking pattern
- The `NO_COLOR` standard is properly respected in addition to config settings
- ASCII fallback characters are carefully chosen for readability in plain terminals
