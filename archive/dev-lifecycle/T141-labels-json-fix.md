# T141: Labels Command JSON Output Fix

## Issue Summary
The labels command had several critical issues:
1. Duplicate task IDs in label aggregation (T099 appeared 3 times)
2. Invalid subcommands treated as label names instead of showing errors
3. Missing `format: "json"` field in `_meta` envelope
4. No format validation - invalid formats silently fell back to text

## Root Cause Analysis

### 1. Duplicate Task IDs
**Location**: `get_label_data()` function, line 185

**Problem**: When tasks had duplicate labels in their label array (e.g., T099 had `["bug", "bug", "bug"]`), the aggregation counted each occurrence separately, creating duplicate task IDs.

**Fix**: Applied `unique` filter to task IDs:
```jq
taskIds: ([.[].id] | unique)
```

### 2. Invalid Subcommand Handling
**Location**: `parse_arguments()` function, lines 515-521

**Problem**: Any invalid subcommand was treated as an implicit 'show' command with the invalid text as a label name. This resulted in confusing behavior where `claude-todo labels invalidcommand` would show zero tasks instead of an error.

**Fix**: Changed default case to show error and exit:
```bash
*)
  # Invalid subcommand - show error
  echo "[ERROR] Invalid subcommand: $1" >&2
  echo "Valid subcommands: $VALID_SUBCOMMANDS" >&2
  echo "Run 'claude-todo labels --help' for usage" >&2
  exit 1
  ;;
```

### 3. Missing Format Field
**Location**: All JSON output functions (lines 313-327, 379-397, 453-473)

**Problem**: The `_meta` envelope was missing the `format` field, making it inconsistent with other commands' JSON output.

**Fix**: Added `"format": "json"` to all three JSON output functions:
- `output_list_json()`
- `output_show_json()`
- `output_stats_json()`

### 4. Format Validation
**Location**: `parse_arguments()` function, lines 528-542

**Problem**: The script used `validate_format()` from output-format.sh, but didn't check if the value was actually valid - it just fell back silently.

**Fix**: Replaced with explicit validation:
```bash
# Validate format
local VALID_FORMATS="text json"
if [[ -z "$OUTPUT_FORMAT" ]]; then
  echo "[ERROR] --format requires a value" >&2
  echo "Valid formats: $VALID_FORMATS" >&2
  exit 1
fi
if [[ ! " $VALID_FORMATS " =~ " $OUTPUT_FORMAT " ]]; then
  echo "[ERROR] Invalid format: $OUTPUT_FORMAT" >&2
  echo "Valid formats: $VALID_FORMATS" >&2
  exit 1
fi
```

## Test Results

All fixes verified with comprehensive test suite:

### Test Coverage
1. **JSON output is valid** - ✅ PASS
2. **JSON has _meta.format field** - ✅ PASS
3. **show subcommand JSON is valid** - ✅ PASS
4. **show subcommand has format field** - ✅ PASS
5. **stats subcommand JSON is valid** - ✅ PASS
6. **stats subcommand has format field** - ✅ PASS
7. **Invalid subcommand fails** - ✅ PASS
8. **Invalid format fails** - ✅ PASS
9. **Duplicate task IDs are removed** - ✅ PASS
10. **Text output still works** - ✅ PASS

### Example Output

**Before Fix**:
```json
{
  "label": "bug",
  "taskIds": ["T095", "T099", "T099", "T099"]  // Duplicates!
}
```

**After Fix**:
```json
{
  "_meta": {
    "format": "json",  // Added
    "version": "0.8.0",
    "command": "labels",
    "timestamp": "2025-12-13T05:56:43Z"
  },
  "totalLabels": 30,
  "labels": [
    {
      "label": "bug",
      "count": 4,
      "taskIds": ["T095", "T099"],  // Unique IDs only
      "byStatus": { "pending": 4 },
      "byPriority": { "medium": 4 }
    }
  ]
}
```

## Files Modified
- `/mnt/projects/claude-todo/scripts/labels.sh`
  - Line 185: Added `unique` filter to task IDs
  - Lines 515-521: Fixed invalid subcommand handling
  - Lines 320, 389, 465: Added `format` field to JSON output
  - Lines 528-542: Added explicit format validation

## Impact
- **JSON consumers**: Can now rely on valid, properly formatted JSON output
- **API stability**: Consistent `_meta` envelope across all commands
- **Error handling**: Clear error messages for invalid inputs
- **Data accuracy**: No duplicate task IDs in aggregations

## Related Issues
- T140: Add `_meta.format` field to all JSON outputs (partially addresses)
- T142: Add format validation to list command (same pattern)
