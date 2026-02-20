# T140 Implementation Summary: Fix _meta.format null in JSON outputs

## Issue
All JSON outputs were missing the `format: "json"` field in the `_meta` envelope, resulting in inconsistent JSON output structure.

## Root Cause
Scripts that generate JSON output were creating `_meta` objects without the `format` field.

## Solution
Added `"format": "json"` as the **first field** in all `_meta` objects across all scripts that generate JSON output.

## Files Modified

### Core Commands (5 files)
1. **scripts/list-tasks.sh**
   - Added `format: "json"` to `_meta` in JSON output mode

2. **scripts/dash.sh**
   - Added `"format": "json"` to `_meta` in JSON output

3. **scripts/stats.sh**
   - Added `"format": "json"` to `_meta` in JSON output

4. **scripts/next.sh**
   - Added `"format": "json"` to `_meta` in JSON output

5. **scripts/labels.sh**
   - Added `"format": "json"` to `_meta` in all three JSON outputs:
     - `labels list`
     - `labels show`
     - `labels stats`

### Analysis Commands (2 files)
6. **scripts/blockers-command.sh**
   - Added `format: "json"` to `_meta` in both JSON outputs:
     - `blockers list`
     - `blockers analyze`

7. **scripts/deps-command.sh**
   - Added complete `_meta` envelope with `format: "json"` to all three JSON outputs:
     - `deps overview`
     - `deps task`
     - `deps tree`
   - **Note**: This script previously had NO `_meta` envelope at all

## Implementation Details

### Before (Example from list-tasks.sh)
```json
{
  "_meta": {
    "version": "0.8.2",
    "command": "list",
    "timestamp": "2025-12-13T05:55:38Z"
  }
}
```

### After
```json
{
  "_meta": {
    "format": "json",
    "version": "0.8.2",
    "command": "list",
    "timestamp": "2025-12-13T05:55:38Z"
  }
}
```

## Validation Results

All 12 JSON output modes tested and verified:

### Core Commands (4/4 passed)
- ✓ list-tasks (json)
- ✓ dash (json)
- ✓ stats (json)
- ✓ next (json)

### Labels Commands (3/3 passed)
- ✓ labels list (json)
- ✓ labels show (json)
- ✓ labels stats (json)

### Blockers Commands (2/2 passed)
- ✓ blockers list (json)
- ✓ blockers analyze (json)

### Deps Commands (3/3 passed)
- ✓ deps overview (json)
- ✓ deps tree (json)
- ✓ deps task (json)

## Consistency Checks

1. **Field presence**: All outputs now have `_meta.format = "json"`
2. **Field order**: `format` is consistently the **first field** in all `_meta` objects
3. **Value consistency**: All use the value `"json"` (not "JSON" or other variants)

## Testing Commands

```bash
# Test all commands have format field
./scripts/list-tasks.sh -f json | jq '._meta.format'
./scripts/dash.sh -f json | jq '._meta.format'
./scripts/stats.sh -f json | jq '._meta.format'
./scripts/next.sh -f json | jq '._meta.format'
./scripts/labels.sh list -f json | jq '._meta.format'
./scripts/blockers-command.sh list -f json | jq '._meta.format'
./scripts/deps-command.sh --format json | jq '._meta.format'

# All should output: "json"
```

## Impact
- **Breaking change**: No (added field, didn't remove or change existing fields)
- **Backward compatibility**: Yes (existing parsers will ignore the new field)
- **Anti-hallucination improvement**: Yes (more explicit format indication for LLMs)

## Related Tasks
- Closes T140: "_meta.format null in all JSON outputs"
- Part of HIGH PRIORITY issues resolution

## Notes
- The `deps-command.sh` script required more extensive changes as it had no `_meta` envelope at all
- All changes maintain existing field order (except for adding `format` as first field)
- No changes to non-JSON output formats (text, markdown, etc.)
