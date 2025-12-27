# Development Scripts Overview

> Index of development tools for cleo contributors

This document provides comprehensive documentation for all development scripts in the `dev/` directory. These scripts are **not shipped to users** and are used exclusively for development, testing, and release management.

## Quick Reference

| Script | Purpose | Common Usage |
|--------|---------|--------------|
| `bump-version.sh` | Version management | `./dev/bump-version.sh patch` |
| `validate-version.sh` | Version consistency | `./dev/validate-version.sh` |
| `check-compliance.sh` | LLM-Agent-First compliance | `./dev/check-compliance.sh` |
| `benchmark-performance.sh` | Performance testing | `./dev/benchmark-performance.sh` |
| `test-rollback.sh` | Phase rollback testing | `./dev/test-rollback.sh` |

## Scripts

### bump-version.sh

Bumps the semantic version across all project files with validation and backup support.

**Purpose:** Single command to update version everywhere with pre/post validation.

**Usage:**
```bash
# Semantic version bumping
./dev/bump-version.sh patch    # 0.12.5 -> 0.12.6
./dev/bump-version.sh minor    # 0.12.5 -> 0.13.0
./dev/bump-version.sh major    # 0.12.5 -> 1.0.0

# Explicit version
./dev/bump-version.sh 1.0.0

# Options
./dev/bump-version.sh --dry-run patch       # Preview changes
./dev/bump-version.sh --no-validate minor   # Skip validation
./dev/bump-version.sh --verbose patch       # Detailed progress
./dev/bump-version.sh --format json patch   # JSON output
```

**Options:**

| Option | Description |
|--------|-------------|
| `--dry-run` | Show changes without making them |
| `--no-validate` | Skip pre/post validation checks |
| `--verbose` | Show detailed progress |
| `-f, --format <fmt>` | Output format: text, json (default: auto-detect TTY) |
| `--json` | Shortcut for `--format json` |
| `--human` | Shortcut for `--format text` |
| `-q, --quiet` | Only show errors and final result |
| `-h, --help` | Show help message |
| `--version` | Show script version |

**Files Updated:**
- `VERSION` (source of truth)
- `README.md` badge
- `templates/CLAUDE-INJECTION.md` version tag
- `CLAUDE.md` injection tag (if present)

**Features:**
- Pre-bump validation of current version
- Post-bump validation of all updates
- Automatic backup creation (`.bak` files)
- Rollback on failure (backups preserved for recovery)

**Exit Codes:**

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | `DEV_EXIT_SUCCESS` | Version bumped successfully |
| 2 | `DEV_EXIT_INVALID_INPUT` | Invalid argument |
| 4 | `DEV_EXIT_NOT_FOUND` | VERSION file not found |
| 10 | `DEV_EXIT_VERSION_INVALID` | Invalid version format |
| 20 | `DEV_EXIT_BUMP_FAILED` | Bump or validation failed |

**Post-Bump Steps:**
1. Update `CHANGELOG.md` with changes for the new version
2. `git add -A && git commit -m 'chore: Bump to v<VERSION>'`
3. `./install.sh --force`
4. `git push origin main`

---

### validate-version.sh

Validates that version numbers are consistent across all project files.

**Purpose:** Detect and optionally fix version drift between files.

**Usage:**
```bash
# Check for version drift
./dev/validate-version.sh

# Auto-fix version drift
./dev/validate-version.sh --fix

# Output formats
./dev/validate-version.sh --format json
./dev/validate-version.sh --quiet
```

**Options:**

| Option | Description |
|--------|-------------|
| `--fix` | Auto-fix version drift by syncing all files to VERSION file |
| `-f, --format <fmt>` | Output format: text, json (default: json for non-TTY, text for TTY) |
| `--json` | Shortcut for `--format json` |
| `--human` | Shortcut for `--format text` |
| `-q, --quiet` | Suppress non-error output |
| `-h, --help` | Show help message |
| `--version` | Show script version |

**Files Checked:**
- `VERSION` (source of truth)
- `README.md` badge
- `templates/CLAUDE-INJECTION.md` version tag
- `CLAUDE.md` injection tag (if present)

**Exit Codes:**

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | `DEV_EXIT_SUCCESS` | All versions synchronized |
| 4 | `DEV_EXIT_NOT_FOUND` | VERSION file not found |
| 10 | `DEV_EXIT_VERSION_INVALID` | Invalid version format |
| 11 | `DEV_EXIT_VERSION_DRIFT` | Version drift detected |

**JSON Output Structure:**
```json
{
  "$schema": "https://cleo.dev/schemas/validate-version.schema.json",
  "_meta": {
    "format": "json",
    "command": "validate-version",
    "version": "0.19.1",
    "timestamp": "2025-12-18T12:00:00Z"
  },
  "success": true,
  "message": "All versions synchronized to 0.19.1",
  "sourceVersion": "0.19.1",
  "fixMode": false,
  "exitCode": 0,
  "files": [
    {"file": "README.md", "status": "ok", "version": "0.19.1"},
    {"file": "templates/CLAUDE-INJECTION.md", "status": "ok", "version": "0.19.1"}
  ]
}
```

---

### check-compliance.sh

LLM-Agent-First compliance validator for cleo commands.

**Purpose:** Automated checking of scripts against the LLM-AGENT-FIRST-SPEC.md requirements.

**Usage:**
```bash
# Full compliance check
./dev/check-compliance.sh

# Check specific command(s)
./dev/check-compliance.sh --command list
./dev/check-compliance.sh --command list,show,add

# Run specific check category
./dev/check-compliance.sh --check foundation
./dev/check-compliance.sh --check flags
./dev/check-compliance.sh --check json-envelope

# Output formats
./dev/check-compliance.sh --format json
./dev/check-compliance.sh --format markdown
./dev/check-compliance.sh --format table

# CI mode with threshold
./dev/check-compliance.sh --ci --threshold 95
./dev/check-compliance.sh --ci --threshold 100  # Strict mode

# Incremental mode (only changed files)
./dev/check-compliance.sh --incremental

# Static analysis only (skip runtime tests)
./dev/check-compliance.sh --static-only

# Discover untracked scripts
./dev/check-compliance.sh --discover

# Generate fix suggestions
./dev/check-compliance.sh --suggest

# Check dev scripts (self-check)
./dev/check-compliance.sh --dev-scripts
```

**Options:**

| Option | Description |
|--------|-------------|
| `-c, --command <name>` | Check specific command(s), comma-separated |
| `-k, --check <category>` | Run specific check category |
| `-f, --format <format>` | Output format: text, json, jsonl, markdown, table |
| `-t, --threshold <n>` | Pass threshold percentage (default: 95) |
| `--ci` | CI mode (exit non-zero if below threshold) |
| `--incremental` | Only check files changed since last run |
| `--force` | Force full check (ignore cache) |
| `--static-only` | Skip runtime JSON tests |
| `--discover` | Find scripts not in schema (untracked) |
| `--suggest` | Add LLM-actionable fix suggestions to output |
| `--dev-scripts` | Check dev/ scripts instead of main scripts/ |
| `-v, --verbose` | Show detailed check output |
| `-q, --quiet` | Only show failures and summary |
| `-h, --help` | Show help message |
| `--version` | Show script version |

**Check Categories:**

| Category | What It Checks |
|----------|----------------|
| `foundation` | Library sourcing (exit-codes.sh, error-json.sh, output-format.sh), COMMAND_NAME, VERSION |
| `flags` | --format, --quiet, --json, --human shortcuts, resolve_format() |
| `exit-codes` | EXIT_* constants, no magic numbers |
| `errors` | output_error() usage, defensive checks, E_* error codes |
| `json-envelope` | Runtime JSON structure: $schema, _meta, success fields |

**Exit Codes:**

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | `DEV_EXIT_SUCCESS` | All checks passed or above threshold |
| 2 | `DEV_EXIT_INVALID_INPUT` | Invalid option |
| 4 | `DEV_EXIT_NOT_FOUND` | Schema or scripts not found |
| 5 | `DEV_EXIT_DEPENDENCY_ERROR` | Missing dependency (jq) |
| 12 | `DEV_EXIT_COMPLIANCE_FAILED` | Below threshold in CI mode |

**CI/CD Integration:**
```bash
# In CI pipeline - fails if below 95%
./dev/check-compliance.sh --ci --threshold 95

# Generate JSON report for CI artifacts
./dev/check-compliance.sh --format json > compliance-report.json

# Quick check on changed files only
./dev/check-compliance.sh --incremental --ci
```

**Pre-commit Hook Example:**
```bash
#!/bin/bash
# .git/hooks/pre-commit

# Check compliance on changed script files
changed_scripts=$(git diff --cached --name-only -- 'scripts/*.sh')
if [[ -n "$changed_scripts" ]]; then
    ./dev/check-compliance.sh --static-only --ci --threshold 90
fi
```

---

### benchmark-performance.sh

Performance testing for cleo commands with varying dataset sizes.

**Purpose:** Measure and validate command performance against defined targets.

**Usage:**
```bash
# Default benchmark (100, 500, 1000, 2000 tasks)
./dev/benchmark-performance.sh

# Custom dataset sizes
./dev/benchmark-performance.sh --sizes "1000 2000 5000"

# Custom number of runs per test
./dev/benchmark-performance.sh --runs 5

# Save results to file
./dev/benchmark-performance.sh --output benchmark.txt

# JSON output
./dev/benchmark-performance.sh --format json
```

**Options:**

| Option | Description |
|--------|-------------|
| `--sizes "<sizes>"` | Custom dataset sizes (default: "100 500 1000 2000") |
| `--runs <n>` | Number of runs per test (default: 3) |
| `--output <file>` | Save results to file (default: stdout) |
| `-f, --format <format>` | Output format: text, json (default: auto-detect) |
| `--json` | Force JSON output |
| `--human` | Force human-readable text output |
| `-q, --quiet` | Suppress progress output |
| `-h, --help` | Show help message |
| `--version` | Show script version |

**Performance Targets:**

| Command | Target | Dataset |
|---------|--------|---------|
| `list` | < 100ms | 1000+ tasks |
| `stats` | < 1000ms | 1000+ tasks |

**Exit Codes:**

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | `DEV_EXIT_SUCCESS` | All benchmarks passed |
| 2 | `DEV_EXIT_INVALID_INPUT` | Invalid option |
| 5 | `DEV_EXIT_DEPENDENCY_ERROR` | Missing dependency (jq, bc) |
| 21 | `DEV_EXIT_BENCHMARK_FAILED` | Performance targets exceeded |

**JSON Output Structure:**
```json
{
  "$schema": "https://cleo.dev/schemas/v1/benchmark-report.schema.json",
  "_meta": {
    "format": "json",
    "command": "benchmark-performance",
    "version": "0.19.1",
    "timestamp": "2025-12-18T12:00:00Z"
  },
  "success": true,
  "config": {
    "datasetSizes": [100, 500, 1000, 2000],
    "runsPerTest": 3,
    "targets": {"listMs": 100, "statsMs": 1000}
  },
  "benchmarks": [
    {
      "taskCount": 1000,
      "runs": 3,
      "list": {"meanMs": 45, "minMs": 42, "maxMs": 48, "targetMs": 100, "status": "PASS"},
      "stats": {"meanMs": 320, "minMs": 310, "maxMs": 335, "targetMs": 1000, "status": "PASS"}
    }
  ],
  "summary": {"totalTests": 8, "passed": 8, "failed": 0, "allPassed": true}
}
```

---

### test-rollback.sh

Manual test script for the phase rollback feature.

**Purpose:** Validate that phase rollback detection and safety features work correctly.

**Usage:**
```bash
# Run all rollback tests
./dev/test-rollback.sh

# JSON output
./dev/test-rollback.sh --format json

# Minimal output
./dev/test-rollback.sh --quiet

# Verbose output
./dev/test-rollback.sh --verbose
```

**Options:**

| Option | Description |
|--------|-------------|
| `-f, --format <format>` | Output format: text, json (default: auto-detect) |
| `--json` | JSON output (shortcut for --format json) |
| `--human` | Human-readable output (shortcut for --format text) |
| `-q, --quiet` | Suppress non-essential output |
| `-v, --verbose` | Show detailed test output |
| `-h, --help` | Show help message |
| `--version` | Show script version |

**Tests Performed:**

1. **Forward Movement** - Verify forward phase transitions work without `--rollback`
2. **Rollback Blocked** - Verify rollback is blocked without `--rollback` flag
3. **Rollback Cancel Prompt** - Verify cancellation at confirmation prompt
4. **Rollback Accept Prompt** - Verify rollback succeeds when confirmed
5. **Rollback Force** - Verify `--rollback --force` skips confirmation
6. **JSON Rollback Requires Force** - Verify JSON mode requires `--force`
7. **JSON Rollback Force** - Verify JSON mode succeeds with `--force`

**Exit Codes:**

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | `DEV_EXIT_SUCCESS` | All tests passed |
| 2 | `DEV_EXIT_INVALID_INPUT` | Invalid option |
| 4 | `DEV_EXIT_NOT_FOUND` | Phase script not found |
| 22 | `DEV_EXIT_TEST_FAILED` | One or more tests failed |

**JSON Output Structure:**
```json
{
  "$schema": "https://cleo.dev/schemas/v1/test-results.schema.json",
  "_meta": {
    "format": "json",
    "command": "test-rollback",
    "version": "0.19.1",
    "timestamp": "2025-12-18T12:00:00Z"
  },
  "success": true,
  "summary": {"total": 7, "passed": 7, "failed": 0},
  "tests": [
    {"name": "forward_movement", "passed": true, "details": "Forward movement works without --rollback"},
    {"name": "rollback_blocked", "passed": true, "details": "Rollback blocked without --rollback flag"}
  ]
}
```

---

## Shared Library (dev/lib/)

The `dev/lib/` directory contains shared utilities for all dev scripts. This library provides standardized colors, logging, exit codes, and utilities.

### Architecture

```
dev/lib/
├── dev-colors.sh      # Color codes and symbols (foundation - no deps)
├── dev-exit-codes.sh  # Exit code constants (foundation - no deps)
├── dev-output.sh      # Logging functions (depends on colors, exit-codes)
├── dev-common.sh      # Common utilities (depends on output)
├── dev-progress.sh    # Progress bars, timing (depends on colors, output)
├── dev-json.sh        # JSON output utilities
└── README.md          # Detailed library documentation
```

### Module Summary

| Module | Purpose | Key Functions |
|--------|---------|---------------|
| `dev-colors.sh` | Color codes and Unicode symbols | `DEV_RED`, `DEV_GREEN`, `DEV_SYM_CHECK` |
| `dev-exit-codes.sh` | Standardized exit code constants | `DEV_EXIT_SUCCESS`, `DEV_EXIT_*` |
| `dev-output.sh` | Logging functions | `log_info`, `log_error`, `log_warn`, `log_step` |
| `dev-common.sh` | Common utilities (file ops, patterns, timestamps) | `dev_require_command`, `dev_file_hash`, `dev_pattern_exists` |
| `dev-progress.sh` | Progress bars, spinners, and timing | `dev_progress_bar`, `dev_spinner_start`, `dev_measure_ms` |
| `dev-json.sh` | JSON output utilities | JSON envelope construction |

### Quick Start

For most dev scripts, source `dev-common.sh` which includes everything:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_LIB_DIR="$SCRIPT_DIR/lib"

# Source shared dev library
source "$DEV_LIB_DIR/dev-common.sh"

# Now you have access to:
# - Colors: DEV_RED, DEV_GREEN, DEV_YELLOW, etc.
# - Logging: log_info, log_error, log_warn, log_step
# - Utilities: dev_require_command, dev_file_hash, dev_pattern_exists
# - Exit codes: DEV_EXIT_SUCCESS, DEV_EXIT_INVALID_INPUT, etc.
```

### With Fallback (Recommended)

For backward compatibility, include a fallback:

```bash
DEV_LIB_DIR="$SCRIPT_DIR/lib"

if [[ -d "$DEV_LIB_DIR" ]] && [[ -f "$DEV_LIB_DIR/dev-common.sh" ]]; then
    source "$DEV_LIB_DIR/dev-common.sh"
else
    # Inline fallback definitions
    RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
    log_info() { echo -e "${GREEN}+${NC} $*"; }
    log_error() { echo -e "${RED}x${NC} $*" >&2; }
fi
```

For complete library documentation, see [dev/lib/README.md](../../dev/lib/README.md).

---

## LLM-Agent-First Compliance

All dev scripts follow LLM-Agent-First patterns for consistency and agent automation support.

### Required Patterns

Every dev script MUST:

1. **Source dev-common.sh**
   ```bash
   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
   DEV_LIB_DIR="$SCRIPT_DIR/lib"
   source "$DEV_LIB_DIR/dev-common.sh"
   ```

2. **Set COMMAND_NAME**
   ```bash
   COMMAND_NAME="bump-version"
   ```

3. **Support format flags** (`--format`, `--json`, `--human`, `--quiet`)
   ```bash
   -f|--format) FORMAT="$2"; shift 2 ;;
   --json)      FORMAT="json"; shift ;;
   --human)     FORMAT="text"; shift ;;
   -q|--quiet)  QUIET=true; shift ;;
   -h|--help)   usage; exit 0 ;;
   ```

4. **Call dev_resolve_format() for TTY-aware output**
   ```bash
   # After arg parsing
   FORMAT=$(dev_resolve_format "$FORMAT")
   ```

5. **Use DEV_EXIT_* constants** (no magic numbers)
   ```bash
   exit $DEV_EXIT_SUCCESS
   exit $DEV_EXIT_INVALID_INPUT
   exit $DEV_EXIT_GENERAL_ERROR
   ```

6. **Use log_* functions for output**
   ```bash
   log_info "Success message"
   log_error "Error message"
   log_step "Action message"
   ```

7. **Output JSON for non-TTY** (agent automation)
   ```bash
   if [[ "$FORMAT" == "json" ]]; then
       jq -n \
           --arg cmd "$COMMAND_NAME" \
           --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
           '{
               "_meta": {"command": $cmd, "timestamp": $ts},
               "success": true,
               "data": {}
           }'
   else
       [[ "$QUIET" != true ]] && log_info "Operation completed"
   fi
   ```

### Recommended Patterns

- Support `--verbose` for detailed output
- Support `--dry-run` for destructive operations
- Use `dev_die` for fatal errors
- Use `dev_require_command` for dependencies

### Compliance Checking

```bash
# Check main scripts
./dev/check-compliance.sh

# Check dev scripts (self-check)
./dev/check-compliance.sh --dev-scripts

# Check with fix suggestions
./dev/check-compliance.sh --suggest
```

---

## Compliance Checker Infrastructure

The compliance checking system uses a modular architecture:

```
dev/compliance/
├── schema.json              # Main scripts validation rules
├── dev-schema.json          # Dev scripts validation rules
├── checks/                  # Check modules
│   ├── foundation.sh        # Library sourcing checks
│   ├── flags.sh             # Flag support checks
│   ├── json-envelope.sh     # JSON output structure (runtime)
│   ├── exit-codes.sh        # Exit code usage checks
│   └── errors.sh            # Error handling checks
└── lib/
    └── test-helpers.sh      # Compliance-specific utilities
```

### Updating the Schema

To add new compliance requirements:

1. Edit `dev/compliance/schema.json` (or `dev-schema.json` for dev scripts)
2. Add patterns/rules to the appropriate section
3. Update the corresponding check module in `dev/compliance/checks/`
4. Test with `./dev/check-compliance.sh --verbose`

---

## Related Documentation

- [DEV-WORKFLOW.md](../../dev/DEV-WORKFLOW.md) - Contribution guidelines and commit strategy
- [dev/lib/README.md](../../dev/lib/README.md) - Shared library documentation
- [LLM-AGENT-FIRST-SPEC.md](../../docs/specs/LLM-AGENT-FIRST-SPEC.md) - Compliance specification
- [CHANGELOG.md](../../CHANGELOG.md) - Version history

---

## Development Notes

### No Version Bumps for Dev Tooling

Dev tooling changes do **NOT** require version bumps:
- Dev scripts are not shipped to users
- No need to update VERSION, CHANGELOG, or package.json
- Changes are tracked through git history only

### Commit Prefix Convention

| Prefix | Usage | Example |
|--------|-------|---------|
| `chore(dev):` | Dev tooling changes | `chore(dev): Add compliance validator` |
| `fix(dev):` | Bug fixes in dev tools | `fix(dev): Fix pattern matching in checks` |
| `docs(dev):` | Dev documentation | `docs(dev): Update compliance schema docs` |
| `refactor(dev):` | Dev code restructuring | `refactor(dev): Extract shared utilities` |

### Pre-Commit Checklist

Before committing dev tooling changes:

- [ ] Run `./dev/check-compliance.sh --dev-scripts` (should pass 95%+)
- [ ] Run `./dev/check-compliance.sh` (ensure main scripts still pass)
- [ ] Test affected scripts manually
- [ ] Verify JSON output works (`./dev/<script>.sh --format json | jq .`)
- [ ] Update `dev/README.md` if adding new scripts
- [ ] Update `dev/DEV-WORKFLOW.md` if changing workflow
