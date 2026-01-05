# Git Hooks

Pre-commit hooks for CLEO development.

## Available Hooks

### pre-commit-schema-check

**Auto-generates migration functions** for schema changes with smart diff analysis.

**What it does:**
1. Detects changes to `schemas/*.json` files
2. Analyzes schema diff (old vs new)
3. Classifies change type:
   - **PATCH**: Constraint relaxation (maxLength increase) → Auto-generates complete migration
   - **MINOR**: New optional field → Auto-generates template with TODO
   - **MAJOR**: Breaking change → Auto-generates template with warning
4. Inserts migration function into `lib/migrate.sh`
5. Shows preview and asks to stage
6. Blocks commit if generation fails

**Installation:**
```bash
# From project root
ln -s ../../dev/hooks/pre-commit-schema-check .git/hooks/pre-commit
```

**Usage:**
```bash
# Normal commit - hook runs automatically
git commit -m "feat: increase maxLength"

# Bypass hook (emergency only)
git commit --no-verify -m "feat: emergency fix"
```

**Example: PATCH (constraint relaxation)**
```
⚙️  Checking schema migrations...
  📝 schemas/todo.schema.json: 2.6.0 → 2.6.1
  ⚠ Missing migration function: migrate_todo_to_2_6_1()

  🤖 Auto-generating migration function...
  ✓ Migration function added to lib/migrate.sh
  Preview:
    # Auto-generated migration: 2026-01-05 03:45:00 UTC
    # Change: Constraint relaxation (backward compatible)
    # Details: [{"path":["properties","tasks","items","properties","notes","maxLength"],"old":1000,"new":2500}]
    migrate_todo_to_2_6_1() {
        local file="$1"
        local target_version="2.6.1"

        echo "  Migrating to v2.6.1: Constraint relaxation (backward compatible)"
        echo "  No data transformation needed"

        # Version-only migration (relaxed constraint, existing data remains valid)
        bump_version_only "$file" "$target_version"
    }

  Stage lib/migrate.sh with generated migration? (Y/n) y
  ✓ lib/migrate.sh staged
  ✓ Migration auto-generated successfully
✓ Schema migration validation passed
```

**Example: MINOR (new field)**
```
⚙️  Checking schema migrations...
  📝 schemas/config.schema.json: 2.4.0 → 2.5.0
  ⚠ Missing migration function: migrate_config_to_2_5_0()

  🤖 Auto-generating migration function...
  ✓ Migration function added to lib/migrate.sh
  Preview:
    # Auto-generated migration: 2026-01-05 03:46:00 UTC
    # Change: New optional field added
    # Details: ["newFeatureFlag"]
    migrate_config_to_2_5_0() {
        local file="$1"
        local target_version="2.5.0"

        echo "  Migrating to v2.5.0: Adding optional field(s)"

        # TODO: Add field with appropriate default value
        # Example for new optional field:
        # add_field_if_missing "$file" ".tasks[].newFieldName" '"default_value"'

        bump_version_only "$file" "$target_version"
    }

  Stage lib/migrate.sh with generated migration? (Y/n) y
  ✓ lib/migrate.sh staged
  ✓ Migration auto-generated successfully
✓ Schema migration validation passed
```

**Manual edit required:**
For MINOR/MAJOR changes, edit the TODO sections in the generated function before committing.

## Maintenance

These hooks are part of the CLEO development workflow. Updates should be:
1. Tested locally before committing
2. Documented in this README
3. Announced to other developers
