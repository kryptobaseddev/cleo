# Schema Migration Guide

## Overview

The cleo system uses semantic versioning for schemas to ensure data compatibility across updates. When schemas change, the migration system automatically handles data transformations while preserving your task history.

## Version Compatibility

### Semantic Versioning

Schema versions follow semantic versioning (MAJOR.MINOR.PATCH):

- **MAJOR**: Breaking changes requiring migration
- **MINOR**: Backward-compatible new features
- **PATCH**: Backward-compatible bug fixes

### Current Schema Versions

- **todo.json**: 2.4.0 (hierarchy fields: type, parentId, size)
- **config.json**: 2.1.0
- **todo-archive.json**: 2.1.0
- **todo-log.json**: 2.1.0

### Change Type Classification

Not all schema changes require migration functions:

| Change Type | Version Bump | Migration Required? |
|-------------|--------------|---------------------|
| Constraint relaxation (maxLength increase) | PATCH | NO - version bump only |
| Optional field addition | PATCH | NO - version bump only |
| Required field addition | MINOR | YES - add defaults |
| Field rename | MINOR | YES - rename in data |
| Structural change | MAJOR | YES - transform data |

**Example:** Increasing notes maxLength from 500 to 5000 is a PATCH change.
No migration function needed - the system just bumps the version field.

The migration system automatically detects when only a version bump is needed
versus when data transformation is required. For PATCH-level changes:

1. Schema version is updated in the schema file
2. `SCHEMA_VERSION_TODO` constant is updated in `lib/migrate.sh`
3. No migration function is written
4. The system bumps the version field in user data files automatically

### Compatibility Rules

1. **Same Major Version**: Compatible (may need migration for new features)
2. **Different Major Version**: Incompatible (manual intervention required)
3. **Newer Minor/Patch**: Forward compatible

## Checking Migration Status

### View Current Versions

```bash
cleo migrate status
```

Output:
```
Schema Version Status
====================

✓ todo: v2.4.0 (compatible)
✓ config: v2.1.0 (compatible)
✓ archive: v2.1.0 (compatible)
✓ log: v2.1.0 (compatible)
```

### Check If Migration Needed

```bash
cleo migrate check
```

Exit codes:
- `0`: All files up to date
- `1`: Migration needed
- `2`: Incompatible version found

## Running Migrations

### Automatic Migration

Migrate all files to latest schema versions:

```bash
cleo migrate run
```

Interactive workflow:
1. Shows current and target versions
2. Requests confirmation
3. Creates backup
4. Performs migration
5. Validates results

### Auto-Migration (No Confirmation)

```bash
cleo migrate run --auto
```

### Skip Backup Creation

```bash
cleo migrate run --no-backup
```

**Warning**: Only use `--no-backup` if you have external backups.

### Migrate Specific File

```bash
cleo migrate file .cleo/todo.json todo
```

Arguments:
- File path
- File type (todo, config, archive, log)

## Migration Process

### What Happens During Migration

1. **Pre-Migration Backup**: Complete backup created in `.cleo/backups/migration/`
2. **Version Detection**: Current and target versions identified
3. **Migration Path**: Intermediate versions calculated if needed
4. **Data Transformation**: Fields added, removed, or renamed as needed
5. **Version Update**: Schema version field updated
6. **Validation**: Migrated file validated against new schema
7. **Logging**: Migration recorded in `.migration.log`

### Migration Safety

- **Atomic Operations**: File replaced only after successful migration
- **Automatic Backup**: Original file preserved before changes
- **Rollback Capability**: Failed migrations automatically restore backup
- **Validation Gates**: Migrated data must pass schema validation

## Common Migration Scenarios

### Scenario 1: Minor Version Update (2.0.0 → 2.1.0)

**What's Added**:
- New optional fields
- Enhanced metadata
- Additional configuration options

**Migration Process**:
- New fields added with default values
- Existing data preserved unchanged
- Version number updated

**Example**:
```bash
# Before migration (v2.0.0)
{
  "version": "2.0.0",
  "_meta": {
    "checksum": "abc123..."
  }
}

# After migration (v2.1.0)
{
  "version": "2.1.0",
  "_meta": {
    "checksum": "abc123...",
    "activeSession": null,  # NEW
    "configVersion": "2.1.0"  # NEW
  }
}
```

### Scenario 2: Config Schema Update

**Common Changes**:
- New configuration sections
- Renamed settings
- Default value updates

**Migration Handles**:
```bash
# Auto-adds new config sections
.session: {
  "requireSessionNote": true,
  "autoStartSession": true
}

# Renames old fields if applicable
archive_after_days → daysUntilArchive
```

### Scenario 3: Archive Format Update

**Data Preserved**:
- All archived tasks
- Completion timestamps
- Task metadata

**Enhancements Added**:
- Cycle time calculations
- Statistics aggregations
- Archive metadata

## Validation Integration

### Automatic Version Checks

The validation system automatically checks versions:

```bash
cleo validate
```

Output includes version check:
```
[0/7] Checking schema version...
✓ PASSED: Version 2.4.0 compatible

[1/7] Checking JSON syntax...
✓ PASSED: JSON syntax valid
...
```

### Version Mismatch Warnings

If version mismatch detected:
```
⚠ Schema version mismatch detected
  File: .cleo/todo.json
  Current: v2.3.0
  Expected: v2.4.0

Automatic migration available.
Run: cleo migrate
```

## Backward Compatibility

### Reading Older Versions

The system can **read** files from older minor versions:
- v2.3.x files work with v2.4.x system
- Missing fields use default values
- No migration required for read-only operations

### Writing Requires Migration

**Writing** to files requires version match:
- Prevents data loss from missing new required fields
- Ensures proper validation
- Migration recommended before modifications

## Error Handling

### Incompatible Major Version

```
ERROR: Incompatible schema version
  File: .cleo/todo.json
  Current: v1.0.0
  Expected: v2.4.0
  Major version mismatch - manual intervention required
```

**Resolution**:
1. Review changelog for breaking changes
2. Export data from old version
3. Re-initialize with `cleo init`
4. Manually migrate critical data

### Migration Failure

```
ERROR: Migration failed
Backups available in: .cleo/backups/migration/
```

**Recovery Steps**:
```bash
# List available migration backups
ls -la .cleo/backups/migration/

# Restore from backup
cp .cleo/backups/migration/pre-migration-*/todo.json .cleo/

# Validate restoration
cleo validate
```

### Corrupted File Detection

If file corrupted during migration:
1. Automatic rollback triggered
2. Original file restored
3. Error logged with details
4. Manual review recommended

## Manual Migration

### When Manual Migration Needed

- Major version changes (e.g., 1.x → 2.x)
- Custom field modifications
- Complex data transformations
- Breaking schema changes

### Manual Migration Steps

1. **Backup Current Data**:
   ```bash
   cp -r .claude .claude.backup
   ```

2. **Export Critical Data**:
   ```bash
   jq '.tasks' .cleo/todo.json > tasks-export.json
   ```

3. **Re-Initialize**:
   ```bash
   cleo init --force
   ```

4. **Import Data**:
   Manually edit new todo.json and import tasks

5. **Validate**:
   ```bash
   cleo validate
   ```

## Migration History

### View Migration Log

```bash
cat .cleo/.migration.log
```

Format:
```
2025-12-05T10:00:00Z MIGRATION todo: v2.0.0 → v2.1.0
2025-12-05T10:00:01Z MIGRATION config: v2.0.0 → v2.1.0
```

### Archive Old Versions

After successful migration and validation:

```bash
# Archive old backups
tar -czf backups-$(date +%Y%m%d).tar.gz .cleo/backups/

# Remove old backups (optional)
find .cleo/backups -type d -mtime +30 -exec rm -rf {} \;
```

## Best Practices

### Before Migration

1. **Commit Git Changes**: Ensure working directory clean
2. **Run Validation**: Verify files valid before migration
3. **Review Changelog**: Understand what's changing
4. **Test on Copy**: Try migration on project copy first

### During Migration

1. **Use Default Settings**: Let migration auto-detect and run
2. **Keep Backups**: Don't use `--no-backup` unless necessary
3. **Monitor Output**: Watch for warnings or errors
4. **Validate Results**: Run validation after migration

### After Migration

1. **Verify Data**: Check tasks and config intact
2. **Test Operations**: Create, complete, archive tasks
3. **Update Team**: Notify team of schema version change
4. **Document Changes**: Note any manual adjustments made

## Troubleshooting

### Issue: "Migration needed" but `migrate run` does nothing

**Cause**: Files already at target version but validation detects mismatch

**Solution**:
```bash
# Force version detection
cleo migrate status --verbose

# Check file content
jq '.version' .cleo/todo.json
```

### Issue: Migration fails with "field not found"

**Cause**: Missing required field in source data

**Solution**:
```bash
# Identify missing field
cleo validate

# Add field manually or restore from backup
```

### Issue: "Incompatible version" error

**Cause**: Major version mismatch

**Solution**: See "Manual Migration" section above

## Developer Guide

### Adding New Migration

Not all schema changes require migration functions. First, determine the change type:

#### PATCH Changes (No Migration Function Needed)

For constraint relaxation or optional field additions:

1. **Update Schema Version** in `schemas/todo.schema.json`:
   ```json
   {
     "$id": "cleo-schema-v2.4.1"
   }
   ```

2. **Update Constants** in `lib/migrate.sh`:
   ```bash
   readonly SCHEMA_VERSION_TODO="2.4.1"
   ```

3. **Done** - The migration system automatically bumps version fields in user
   data files without requiring data transformation.

**Examples of PATCH changes:**
- Increasing `maxLength` from 500 to 5000
- Adding a new optional field with no default needed
- Relaxing a pattern constraint

#### MINOR/MAJOR Changes (Migration Function Required)

For required field additions, renames, or structural changes:

1. **Update Schema Version**:
   ```json
   {
     "$id": "cleo-schema-v2.5.0"
   }
   ```

2. **Add Migration Function** in `lib/migrate.sh`:
   ```bash
   migrate_todo_to_2_5_0() {
       local file="$1"

       # Add new required field with default
       add_field_if_missing "$file" ".newField" '"default_value"'

       # Update version
       update_version_field "$file" "2.5.0"
   }
   ```

3. **Update Constants**:
   ```bash
   # In lib/migrate.sh
   readonly SCHEMA_VERSION_TODO="2.5.0"
   ```

4. **Register Migration** in the migration chain:
   ```bash
   # Add to get_migration_path function
   "2.4.0") echo "2.5.0" ;;
   ```

5. **Test Migration**:
   ```bash
   # Create test file with old version
   # Run migration
   # Validate results
   ```

**Examples of changes requiring migration functions:**
- Adding a required field (needs default value injection)
- Renaming a field (needs data transformation)
- Changing data structure (needs complex transformation)

### Migration Function Helpers

Available helpers in `lib/migrate.sh`:

- `update_version_field <file> <version>`: Update version number
- `add_field_if_missing <file> <path> <default>`: Add new field
- `remove_field_if_exists <file> <path>`: Remove deprecated field
- `rename_field <file> <old> <new>`: Rename field

All helpers are idempotent and safe to run multiple times.

## Summary

**Key Points**:
1. Schema versions ensure data compatibility
2. Automatic migration handles most scenarios
3. Always creates backups before changes
4. Validation integrated with migration
5. Manual intervention needed for major version changes

**Commands**:
```bash
cleo migrate status      # Check versions
cleo migrate check       # Test if migration needed
cleo migrate run         # Perform migration
cleo migrate file <path> <type>  # Migrate specific file
```

**Safety First**:
- Automatic backups
- Validation gates
- Rollback on failure
- Migration logging
