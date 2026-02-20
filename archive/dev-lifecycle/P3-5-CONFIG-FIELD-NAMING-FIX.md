# P3-5: Configuration Field Naming Consistency Fix

**Status**: ✅ Complete
**Priority**: P3 (Polish)
**Version**: v0.8.4
**Date**: 2025-12-12

## Problem

Configuration fields in `output` section had inconsistent naming patterns:
- Some used `*Enabled` suffix: `colorEnabled`, `unicodeEnabled`
- Some used no prefix: `progressBars`, `compactTitles`
- No consistent pattern for boolean display options

This inconsistency made the API confusing and harder to remember.

## Solution

Standardized all boolean display options to use `show*` prefix pattern:

### Field Renames

| Old Field Name | New Field Name | Type | Description |
|----------------|----------------|------|-------------|
| `colorEnabled` | `showColor` | boolean | Enable ANSI color output |
| `unicodeEnabled` | `showUnicode` | boolean | Use Unicode symbols |
| `progressBars` | `showProgressBars` | boolean | Show progress bars |
| `compactTitles` | `showCompactTitles` | boolean | Truncate long titles |

### Files Modified

1. **schemas/config.schema.json**
   - Updated field names in `output` section
   - Updated descriptions and comments
   - Schema version remains 2.1.0 (backward compatible)

2. **templates/config.template.json**
   - Updated to use new field names
   - Reordered for consistency (defaultFormat first)

3. **.claude/todo-config.json**
   - Updated project config to use new field names

4. **lib/output-format.sh**
   - Updated `load_output_config()` to support BOTH old and new field names
   - Updated `get_output_config()` to accept both naming patterns as keys
   - Updated comments to reference new field names
   - Maintains full backward compatibility

5. **lib/migrate.sh**
   - Added `migrate_config_field_naming()` helper function
   - Added `migrate_config_to_2_1_0()` migration function
   - Automatically renames old fields to new fields during migration

## Backward Compatibility

### Reading Configuration (lib/output-format.sh)

The `load_output_config()` function now checks for BOTH old and new field names:

```bash
# Prefers new field name, falls back to old field name
config_color=$(jq -r 'if .output.showColor != null then .output.showColor
                      elif .output.colorEnabled != null then .output.colorEnabled
                      else "undefined" end' "$OUTPUT_CONFIG_FILE")
```

This means:
- ✅ Existing configs with old field names continue to work
- ✅ New configs with new field names work
- ✅ Mixed configs (some old, some new) work (new takes precedence)

### Accessing Configuration

The `get_output_config()` function accepts multiple key aliases:

```bash
get_output_config "color"          # Works
get_output_config "colorEnabled"   # Works (old name)
get_output_config "showColor"      # Works (new name)
```

All three return the same value.

### Migration Path

When users run `claude-todo migrate` or any command that triggers migration:
1. Old field names are automatically renamed to new field names
2. Original values are preserved
3. Config version is updated to 2.1.0
4. Backup is created before migration

Example:

```json
// Before migration (2.0.0)
{
  "output": {
    "colorEnabled": true,
    "progressBars": false
  }
}

// After migration (2.1.0)
{
  "output": {
    "showColor": true,
    "showProgressBars": false
  }
}
```

## Testing

### Test Cases

1. **Old field names compatibility**
   ```bash
   # Config with old field names still works
   OUTPUT_CONFIG_FILE=/tmp/test-old.json
   get_output_config "color"  # Returns correct value
   ```

2. **New field names work**
   ```bash
   # Config with new field names works
   OUTPUT_CONFIG_FILE=/tmp/test-new.json
   get_output_config "showColor"  # Returns correct value
   ```

3. **Migration transforms old to new**
   ```bash
   source lib/migrate.sh
   migrate_config_field_naming /tmp/old-config.json
   # Verify old fields renamed to new fields
   ```

4. **Schema validation passes**
   ```bash
   jq -e 'type == "object"' schemas/config.schema.json
   # Exit code 0 = valid JSON
   ```

### Test Results

All tests pass:
- ✅ Old field names read correctly
- ✅ New field names read correctly
- ✅ Migration renames fields correctly
- ✅ Schema and config files have valid JSON syntax
- ✅ No functionality broken

## Benefits

1. **Consistency**: All boolean display options now follow `show*` pattern
2. **Clarity**: `showColor` is more intuitive than `colorEnabled`
3. **Maintainability**: Easier to add new display options with consistent naming
4. **Backward Compatible**: No breaking changes for existing users
5. **Future-Proof**: Migration system handles schema evolution gracefully

## Documentation Updates Needed

- [ ] Update docs/usage.md to reference new field names
- [ ] Update docs/reference/configuration.md with new field names
- [ ] Add migration notes to CHANGELOG.md

## Related Issues

- Fixes P3-5: Configuration field naming inconsistency
- Part of v0.8.4 polish improvements
- Complements other schema standardization efforts

## Rollout Strategy

1. ✅ Schema updated with new field names
2. ✅ Templates updated
3. ✅ Backward compatibility implemented
4. ✅ Migration function added
5. ✅ Testing completed
6. Next: Documentation updates
7. Next: Release notes

## Notes

- No user action required - migration is automatic
- Old field names will continue to work indefinitely
- Schema version remains 2.1.0 (no major version bump needed)
- This is a non-breaking change thanks to backward compatibility layer
