# Golden File Tests

Golden file tests compare command output against known-good "golden" files to detect output regressions.

## Directory Structure

```
tests/golden/
├── README.md           # This file
├── golden.bats         # BATS test runner for golden tests
├── schema-validation.bats # Schema-specific validation tests
├── fixtures/           # Test data fixtures
│   └── todo.json       # Stable test data (must match current schema version)
└── expected/           # Golden output files (16 files)
    ├── list-*.golden   # list command outputs
    ├── labels-*.golden # labels command outputs
    ├── phases-*.golden # phases command outputs
    ├── stats-text.golden
    ├── dash-compact.golden
    ├── deps-tree.golden
    ├── blockers-text.golden
    └── export-*.golden # export command outputs
```

## Quick Reference

```bash
# Run golden tests
bats tests/golden/golden.bats

# REGENERATE ALL GOLDEN FILES (after schema/output changes)
UPDATE_GOLDEN=1 bats tests/golden/golden.bats

# Run specific test
bats tests/golden/golden.bats --filter "list"
```

## When to Update Golden Files

**MUST regenerate golden files when:**

| Change Type | Action Required |
|-------------|-----------------|
| Schema version bump (e.g., 2.1.0 → 2.2.0) | Update fixture + regenerate |
| New fields in JSON output | Regenerate affected golden files |
| Output format changes (text/JSON structure) | Regenerate affected golden files |
| New command added | Add test case + generate golden file |
| `_meta` version changes | Regenerate JSON golden files |

**Update process:**
```bash
# 1. Update fixture if schema changed
vim tests/golden/fixtures/todo.json

# 2. Regenerate all golden files
UPDATE_GOLDEN=1 bats tests/golden/golden.bats

# 3. Review changes
git diff tests/golden/expected/

# 4. Commit both fixture and golden files together
git add tests/golden/
git commit -m "chore: Update golden files for vX.Y.Z schema"
```

## Fixture Requirements

The `fixtures/todo.json` file MUST:
- Match the current schema version (check `schemas/todo.schema.json`)
- Include representative test data:
  - Multiple tasks (6 currently)
  - All status types: pending, active, blocked, done
  - Multiple phases with different statuses
  - Tasks with dependencies
  - Tasks with labels
  - Project-level phase configuration
- Pass schema validation: `claude-todo validate`

**Current fixture structure (v2.2.0):**
```json
{
  "version": "2.2.0",
  "_meta": { ... },
  "project": {
    "name": "...",
    "currentPhase": "core",
    "phases": { "setup": {...}, "core": {...}, ... }
  },
  "focus": { "currentTask": "T003", "currentPhase": "core", ... },
  "tasks": [ ... 6 tasks ... ]
}
```

## Test Cases (16 total)

| Command | Golden File | Description |
|---------|-------------|-------------|
| `list --format text` | list-text.golden | Default task list output |
| `list --format json` | list-json.golden | JSON task list with _meta |
| `list --format jsonl` | list-jsonl.golden | JSONL streaming output |
| `list --status pending` | list-pending.golden | Filtered pending tasks |
| `list --compact` | list-compact.golden | Compact list format |
| `stats` | stats-text.golden | Statistics display |
| `labels` | labels-text.golden | Label listing (text) |
| `labels --format json` | labels-json.golden | Label listing (JSON) |
| `phases` | phases-text.golden | Phase listing (text) |
| `phases --format json` | phases-json.golden | Phase listing (JSON) |
| `phases stats` | phases-stats.golden | Phase statistics |
| `dash --compact` | dash-compact.golden | Compact dashboard |
| `deps tree` | deps-tree.golden | Dependency tree |
| `blockers` | blockers-text.golden | Blocked tasks |
| `export --format todowrite` | export-todowrite.golden | TodoWrite export |
| `export --format csv` | export-csv.golden | CSV export |

## Normalization

Golden files are normalized to remove environment-specific values:
- Timestamps → `TIMESTAMP`
- Checksums → `CHECKSUM`
- Execution times → `XXXms`
- Test directory paths → `TESTDIR`
- Project root paths → `PROJECT`

## Troubleshooting

### "Golden file not found"
```bash
# Generate missing golden file
UPDATE_GOLDEN=1 bats tests/golden/golden.bats --filter "test-name"
```

### "Output differs from golden file"
1. Check if change is intentional (schema update, new feature)
2. If intentional: `UPDATE_GOLDEN=1 bats tests/golden/golden.bats`
3. If unintentional: Fix the regression in the command script

### Fixture validation fails
```bash
# Validate fixture against schema
cd tests/golden/fixtures
jq . todo.json  # Check JSON syntax
# Compare with templates/todo.template.json for structure
```

## Adding New Golden Tests

1. Add test case to `golden.bats`:
   ```bash
   @test "golden: new-command" {
       cd "$TEST_DIR"
       run "$PROJECT_ROOT/scripts/new-command.sh"
       [ "$status" -eq 0 ]
       compare_golden "new-command.golden" "$output"
   }
   ```
2. Generate golden file: `UPDATE_GOLDEN=1 bats tests/golden/golden.bats --filter "new-command"`
3. Review: `cat tests/golden/expected/new-command.golden`
4. Commit both test and golden file
