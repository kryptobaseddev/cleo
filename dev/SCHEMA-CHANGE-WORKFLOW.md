# Schema Change Workflow (AUTOMATED)

**For CLEO developers only** - Not for end users.

## TL;DR

```bash
# 1. Edit schema file (version + constraints)
vim schemas/todo.schema.json

# 2. Commit - hook auto-generates migration
git add schemas/todo.schema.json
git commit -m "feat(schema): increase sessionNote maxLength"

# Hook detects change → auto-generates migration → asks to stage → done!
```

---

## The Problem (Before Automation)

**Manual workflow was error-prone:**
1. Edit `schemas/todo.schema.json` (change maxLength, bump version)
2. Run `cleo migrate create "description"` (creates empty template)
3. Edit `lib/migrate.sh` (implement jq logic manually)
4. Test with `cleo upgrade`
5. Easy to forget steps 2-3 → broken migrations

**Agent confusion:**
- Agents used `cleo migrate run` instead of `cleo upgrade`
- Manual schema edits bypassed version management
- No validation that migrations existed

---

## The Solution (3-Layer Defense)

### Layer 1: Documentation
**Changed:** `docs/TODO_Task_Management.md`

- Removed all `cleo migrate` commands
- Only shows `cleo upgrade` (user-facing command)
- Agents only learn the correct workflow

### Layer 2: Runtime Protection
**Changed:** `scripts/migrate.sh` + `check_developer_mode()`

```bash
$ cleo migrate run
⚠️  WARNING: 'cleo migrate' is a low-level developer tool

   Most users and LLM agents should use:
   → cleo upgrade

Continue with low-level migrate? (y/N) n

Redirecting to: cleo upgrade
```

**Bypass:** `CLEO_DEVELOPER_MODE=1 cleo migrate run`

### Layer 3: Auto-Generation
**New:** `dev/hooks/pre-commit-schema-check` + `dev/schema-diff-analyzer.sh`

Pre-commit hook:
1. Detects schema file changes
2. Extracts old vs new versions
3. Calls analyzer to classify change
4. Auto-generates migration function
5. Inserts into `lib/migrate.sh`
6. Shows preview and stages file

---

## Automated Workflow

### Step 1: Edit Schema
```bash
vim schemas/todo.schema.json
```

**Make TWO changes:**
1. Bump `"schemaVersion": "2.6.0"` → `"2.6.1"`
2. Make schema change (e.g., `"maxLength": 1000` → `2500`)

### Step 2: Commit
```bash
git add schemas/todo.schema.json
git commit -m "feat(schema): increase sessionNote maxLength to 2500"
```

### Step 3: Hook Auto-Generates
```
⚙️  Checking schema migrations...
  📝 schemas/todo.schema.json: 2.6.0 → 2.6.1
  ⚠ Missing migration function: migrate_todo_to_2_6_1()

  🤖 Auto-generating migration function...
  ✓ Migration function added to lib/migrate.sh
  Preview:
    # Auto-generated migration: 2026-01-05 03:45:00 UTC
    # Change: Constraint relaxation (backward compatible)
    migrate_todo_to_2_6_1() {
        local file="$1"
        local target_version="2.6.1"

        echo "  Migrating to v2.6.1: Constraint relaxation"
        echo "  No data transformation needed"

        bump_version_only "$file" "$target_version"
    }

  Stage lib/migrate.sh with generated migration? (Y/n) y
  ✓ lib/migrate.sh staged
  ✓ Migration auto-generated successfully
✓ Schema migration validation passed
```

### Step 4: Commit Proceeds
Both files are now staged:
- `schemas/todo.schema.json` (your edit)
- `lib/migrate.sh` (auto-generated migration)

---

## Change Classification

The analyzer automatically classifies changes:

| Type | Detection | Generated Code |
|------|-----------|----------------|
| **PATCH** | maxLength increase, minLength decrease, required → optional | **Complete** bump_version_only() implementation |
| **MINOR** | New optional field added | **Template** with TODO for default value |
| **MAJOR** | Removed field, type change, new required field | **Template** with warning and TODO |

**PATCH changes are fully automated** - no manual work needed.
**MINOR/MAJOR changes** get smart templates - developer adds jq logic.

---

## Installation

```bash
# Install pre-commit hook
ln -s ../../dev/hooks/pre-commit-schema-check .git/hooks/pre-commit

# Verify it works
./dev/test-migration-generator.sh
```

---

## For End Users

**None of this applies to end users** - they just run:
```bash
cleo upgrade
```

All migration complexity is handled automatically.

---

## Technical Details

### Schema Diff Analysis
**File:** `dev/schema-diff-analyzer.sh`

Uses jq to compare old vs new schemas:
- Detects added/removed properties
- Finds constraint changes (maxLength, minLength, required, type)
- Classifies as PATCH/MINOR/MAJOR based on semver semantics

### Migration Insertion
**Location:** Appends to `lib/migrate.sh`

Functions are inserted inline (not in separate files) to keep it simple. The empty `lib/migrations/` directory is legacy/unused.

### Semver Semantics
- **PATCH**: Backward-compatible relaxation (no data change needed)
- **MINOR**: Additive change (new optional field, needs default)
- **MAJOR**: Breaking change (type change, removed field, etc.)

---

## Bypass Options

### Skip Hook (Emergency Only)
```bash
git commit --no-verify -m "emergency: bypass validation"
```

### Manual Migration
```bash
# If auto-generation fails, add manually to lib/migrate.sh:
migrate_todo_to_2_7_0() {
    local file="$1"
    # Your implementation
    bump_version_only "$file" "2.7.0"
}
```

---

## Testing

```bash
# Test analyzer
./dev/test-migration-generator.sh

# Test end-to-end
# 1. Edit schemas/todo.schema.json (bump version + change constraint)
# 2. git add schemas/todo.schema.json
# 3. git commit -m "test"
# 4. Hook should auto-generate and prompt
```

---

## Benefits

✅ **PATCH changes**: Fully automated (80% of changes)
✅ **MINOR changes**: Smart template with TODO
✅ **MAJOR changes**: Guided template with warnings
✅ **No forgotten migrations**: Hook blocks commits
✅ **No agent confusion**: Documentation only shows `upgrade`
✅ **Developer-friendly**: Preview before staging

---

## Future Improvements

Possible enhancements (not planned yet):
- Detect specific field additions and generate exact `add_field_if_missing` calls
- Parse schema $comment annotations for migration hints
- Generate test cases for migrations
- Validate generated migration against schema constraints
