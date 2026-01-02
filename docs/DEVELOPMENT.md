# CLEO Development Guide

Guide for maintainers and contributors on development tools, scripts, and workflows.

## Table of Contents

- [Development Scripts](#development-scripts)
- [Documentation Generation](#documentation-generation)
- [Version Management](#version-management)
- [Testing](#testing)
- [Compliance Checking](#compliance-checking)

---

## Development Scripts

All development scripts are in the `dev/` directory. These are NOT installed to PATH - run them from the repo root.

| Script | Purpose |
|--------|---------|
| `dev/bump-version.sh` | Update version across all files |
| `dev/validate-version.sh` | Verify version consistency |
| `dev/benchmark-performance.sh` | Performance testing |
| `dev/check-compliance.sh` | Check script compliance |
| `dev/check-lib-compliance.sh` | Check library compliance |
| `dev/test-rollback.sh` | Test backup/restore |

---

## Documentation Generation

### Features Documentation

The feature inventory is maintained in structured JSON and auto-generated to markdown.

**Source of Truth**: `docs/FEATURES.json`
**Generated Output**: `docs/FEATURES.md`
**Generator**: `scripts/generate-features.sh`

#### Usage

```bash
# Regenerate FEATURES.md from FEATURES.json
./scripts/generate-features.sh
```

#### Workflow

1. Edit `docs/FEATURES.json` to add/update features
2. Run `./scripts/generate-features.sh`
3. Commit both files together

#### FEATURES.json Structure

```json
{
  "$schema": "https://cleo-dev.com/schemas/v1/features.schema.json",
  "_meta": {
    "version": "0.47.0",
    "generatedAt": "2026-01-02T00:00:00Z"
  },
  "categories": [
    {
      "id": "task-management",
      "name": "Task Management",
      "description": "Core CRUD operations",
      "status": "stable",
      "features": [
        {
          "id": "add",
          "name": "Task Creation",
          "command": "cleo add",
          "description": "Create tasks with hierarchy...",
          "status": "complete",
          "version": "0.1.0",
          "docs": "docs/commands/add.md"
        }
      ]
    }
  ],
  "summary": {
    "totalCategories": 16,
    "totalFeatures": 85
  }
}
```

#### Adding a New Feature

```bash
# 1. Edit FEATURES.json - add to appropriate category
jq '.categories[0].features += [{
  "id": "new-feature",
  "name": "New Feature Name",
  "command": "cleo newcmd",
  "description": "What it does",
  "status": "complete",
  "version": "0.48.0"
}]' docs/FEATURES.json > tmp.json && mv tmp.json docs/FEATURES.json

# 2. Update summary counts
# (manual or use jq to recalculate)

# 3. Regenerate markdown
./scripts/generate-features.sh
```

---

### Roadmap Generation

Generate roadmap from pending epics and CHANGELOG history.

**Command**: `cleo roadmap`
**Documentation**: `docs/commands/roadmap.md`

#### Usage

```bash
# Display roadmap in terminal
cleo roadmap

# Generate ROADMAP.md file
cleo roadmap -o docs/ROADMAP.md

# Include release history from CHANGELOG
cleo roadmap --include-history -o docs/ROADMAP.md

# JSON output for scripting
cleo roadmap --json | jq '.upcoming[0]'
```

#### Output Formats

| Format | When Used | Flag |
|--------|-----------|------|
| `text` | TTY (terminal) | `--human` |
| `json` | Piped output | `--json` |
| `markdown` | File output (`-o`) | `--format markdown` |

#### What It Includes

- **Upcoming**: Pending epics grouped by priority
- **In Progress**: Active epics with progress bars
- **Release History**: Parsed from CHANGELOG.md (with `--include-history`)

---

## Version Management

### Bump Version

Updates version string across all files that contain it.

```bash
# Bump patch version (0.47.0 -> 0.47.1)
./dev/bump-version.sh patch

# Bump minor version (0.47.0 -> 0.48.0)
./dev/bump-version.sh minor

# Bump major version (0.47.0 -> 1.0.0)
./dev/bump-version.sh major

# Set specific version
./dev/bump-version.sh 0.50.0
```

#### Files Updated

- `VERSION`
- `CHANGELOG.md` (adds new section)
- `README.md` (badge)
- `docs/FEATURES.json` (`_meta.version`)
- Schema files (`$schema` URLs)
- Templates

### Validate Version

Checks version consistency across all files.

```bash
./dev/validate-version.sh
```

Returns exit code 0 if all versions match, 1 if mismatches found.

---

## Testing

### Run All Tests

```bash
./tests/run-all-tests.sh
```

### Run Specific Test Suites

```bash
# Unit tests only
bats tests/unit/*.bats

# Integration tests only
bats tests/integration/*.bats

# Specific test file
bats tests/unit/analyze.bats

# Parallel execution (faster)
bats --jobs 4 tests/unit/*.bats
```

### Test Structure

```
tests/
├── unit/           # Individual function tests
├── integration/    # End-to-end workflow tests
├── golden/         # Output format validation
├── fixtures/       # Test data
└── test_helper/    # Shared test utilities
```

### Writing Tests

```bash
# tests/unit/new-feature.bats
#!/usr/bin/env bats

load '../test_helper/common_setup'

setup_file() {
    common_setup_file
}

setup() {
    common_setup_per_test
}

@test "feature does expected thing" {
    run cleo new-command --flag
    assert_success
    assert_output --partial "expected output"
}
```

---

## Compliance Checking

### Script Compliance

Checks all scripts follow coding standards.

```bash
./dev/check-compliance.sh
```

Checks:
- Shebang line
- `set -euo pipefail`
- Function naming (snake_case)
- Variable quoting
- Header comments

### Library Compliance

Checks all library files follow architecture spec.

```bash
./dev/check-lib-compliance.sh
```

Checks:
- Layer headers (Layer 0-3)
- Source guards
- Dependency declarations
- Function documentation

---

## Performance Benchmarking

Test command performance against targets.

```bash
./dev/benchmark-performance.sh
```

### Target Metrics

| Operation | Target |
|-----------|--------|
| Task creation | < 100ms |
| Task completion | < 100ms |
| List tasks | < 50ms |
| Archive (100 tasks) | < 500ms |
| Validation (100 tasks) | < 200ms |

---

## Release Workflow

1. **Update FEATURES.json** with new features
2. **Regenerate FEATURES.md**: `./scripts/generate-features.sh`
3. **Bump version**: `./dev/bump-version.sh minor`
4. **Update CHANGELOG.md** with changes
5. **Run tests**: `./tests/run-all-tests.sh`
6. **Validate version**: `./dev/validate-version.sh`
7. **Generate roadmap**: `cleo roadmap -o docs/ROADMAP.md --include-history`
8. **Commit and tag**: `git tag v0.48.0`

---

## Quick Reference

```bash
# Documentation
./scripts/generate-features.sh    # Regenerate FEATURES.md
cleo roadmap -o docs/ROADMAP.md   # Generate ROADMAP.md

# Version
./dev/bump-version.sh patch       # Bump version
./dev/validate-version.sh         # Check consistency

# Testing
./tests/run-all-tests.sh          # Full test suite
bats tests/unit/*.bats            # Unit tests only

# Compliance
./dev/check-compliance.sh         # Script standards
./dev/check-lib-compliance.sh     # Library standards

# Performance
./dev/benchmark-performance.sh    # Benchmark commands
```
