# Compliance Checking System

> Automated validation of LLM-Agent-First compliance for cleo scripts

## Overview

The compliance checking system validates that all cleo commands adhere to the [LLM-Agent-First specification](../specs/LLM-AGENT-FIRST-SPEC.md). This ensures consistent behavior across all commands for agent automation, including JSON output by default for non-TTY contexts, structured error handling, and documented exit codes.

### Why LLM-Agent-First Compliance Matters

| Benefit | Description |
|---------|-------------|
| **Agent Automation** | Consistent JSON output enables reliable parsing by AI agents |
| **Predictable Behavior** | Same flags and patterns across all commands |
| **Error Recovery** | Structured errors with codes enable programmatic error handling |
| **Documentation** | Schemas serve as living documentation for output formats |

### Spec Version

The compliance checker validates against **LLM-Agent-First Spec v2.1** as defined in `dev/compliance/schema.json`.

---

## Quick Start

```bash
# Check all main scripts (scripts/ directory)
./dev/check-compliance.sh

# Check dev scripts (dev/ directory)
./dev/check-compliance.sh --dev-scripts

# Check specific command
./dev/check-compliance.sh --command list

# Check multiple commands
./dev/check-compliance.sh --command list,show,add

# Run specific check category
./dev/check-compliance.sh --check foundation

# CI mode with threshold
./dev/check-compliance.sh --ci --threshold 95

# JSON output for scripting
./dev/check-compliance.sh --format json

# Show fix suggestions
./dev/check-compliance.sh --suggest

# Discover untracked scripts
./dev/check-compliance.sh --discover
```

---

## Check Categories

The compliance validator runs five categories of checks against each script.

### Foundation Checks

Validates core infrastructure requirements.

| Check | Pattern | Purpose |
|-------|---------|---------|
| **Library Sourcing** | `source.*exit-codes.sh`, `source.*error-json.sh`, `source.*output-format.sh` | Required libraries loaded |
| **Dual-Path Fallback** | `source.*\$LIB_DIR.*\.sh\|source.*CLEO_HOME.*\.sh` | Works from install or repo |
| **COMMAND_NAME** | `^COMMAND_NAME=` | Command identifier for JSON output |
| **VERSION Loading** | `VERSION=.*CLEO_HOME/VERSION` | Central version consistency |

**Example compliant pattern:**

```bash
# Dual-path library loading
if [[ -n "${CLEO_HOME:-}" ]]; then
    LIB_DIR="$CLEO_HOME/lib"
else
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    LIB_DIR="$SCRIPT_DIR/../lib"
fi

source "$LIB_DIR/exit-codes.sh"
source "$LIB_DIR/error-json.sh"
source "$LIB_DIR/output-format.sh"

COMMAND_NAME="list"
```

### Flag Checks

Validates universal flag support.

| Check | Pattern | Purpose |
|-------|---------|---------|
| **--format** | `-f\|--format\|--format)` | Output format selection |
| **--quiet** | `-q\|--quiet\|--quiet)` | Suppress non-essential output |
| **--json** | `--json)` | Shortcut for `--format json` |
| **--human** | `--human)` | Shortcut for `--format text` |
| **resolve_format()** | `resolve_format` | TTY-aware format resolution |
| **--dry-run** | `--dry-run)` | Required for write commands |

**Example compliant pattern:**

```bash
# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        -f|--format) FORMAT="$2"; shift 2 ;;
        --json)      FORMAT="json"; shift ;;
        --human)     FORMAT="text"; shift ;;
        -q|--quiet)  QUIET=true; shift ;;
        --dry-run)   DRY_RUN=true; shift ;;
        -h|--help)   usage; exit 0 ;;
        *) break ;;
    esac
done

# After parsing - resolve format based on TTY
FORMAT=$(resolve_format "$FORMAT")
```

### Exit Code Checks

Validates proper exit code usage.

| Check | Pattern | Purpose |
|-------|---------|---------|
| **EXIT_* Constants** | `exit.*\$EXIT_\|exit.*EXIT_` | Named constants used |
| **No Magic Numbers** | `exit [0-9](?!\})` (forbidden) | Prevents bare `exit 1` |

**Exit code constants (from `lib/exit-codes.sh`):**

```bash
EXIT_SUCCESS=0           # Successful operation
EXIT_GENERAL_ERROR=1     # General error
EXIT_INVALID_INPUT=2     # Invalid input/arguments
EXIT_NOT_FOUND=4         # Resource not found
EXIT_FILE_ERROR=3        # File operation error
EXIT_VALIDATION_FAILED=6 # Validation error
```

**Example compliant pattern:**

```bash
# Correct - using constants
if [[ ! -f "$TODO_FILE" ]]; then
    output_error "E_NOT_FOUND" "File not found: $TODO_FILE" "$EXIT_NOT_FOUND"
    exit $EXIT_NOT_FOUND
fi

# Incorrect - magic number
exit 1  # Never do this
```

### Error Handling Checks

Validates structured error output.

| Check | Pattern | Purpose |
|-------|---------|---------|
| **output_error()** | `output_error` | Structured error function used |
| **Defensive Check** | `declare -f output_error.*>/dev/null` | Function existence verified |
| **E_* Error Codes** | `E_[A-Z_]+` | Named error codes used |

**Example compliant pattern:**

```bash
# Defensive check for required function
if ! declare -f output_error >/dev/null 2>&1; then
    echo "ERROR: output_error function not available" >&2
    exit 1
fi

# Using output_error
output_error "E_INVALID_ID" "Invalid task ID: $task_id" "$EXIT_INVALID_INPUT" \
    true "Use 'cleo list' to see valid IDs"
```

### JSON Envelope Checks (Runtime)

Validates actual JSON output structure. These are runtime checks that execute the command.

| Check | Pattern | Purpose |
|-------|---------|---------|
| **$schema Field** | `\"\$schema\".*output\.schema\.json` | Schema reference present |
| **_meta Block** | `\"_meta\"` | Metadata envelope |
| **success Field** | `\"success\".*true\|\"success\".*false` | Operation status |

**Example compliant JSON output:**

```json
{
  "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
  "_meta": {
    "format": "json",
    "version": "0.19.1",
    "command": "list",
    "timestamp": "2025-12-18T10:30:00Z"
  },
  "success": true,
  "summary": {
    "total": 15,
    "filtered": 10
  },
  "tasks": [...]
}
```

---

## Schema Structure

The compliance system uses JSON schemas to define validation rules.

### Main Scripts Schema (`dev/compliance/schema.json`)

```
schema.json
├── requirements/
│   ├── foundation/
│   │   ├── libraries/
│   │   │   ├── required: ["exit-codes.sh", "error-json.sh", "output-format.sh"]
│   │   │   └── patterns: { dual_path: "..." }
│   │   └── variables/
│   │       ├── required: ["COMMAND_NAME", "VERSION"]
│   │       └── patterns: { command_name: "...", version_central: "..." }
│   ├── flags/
│   │   ├── universal: { required: ["--format", "--quiet"], shortcuts: ["--json", "--human"] }
│   │   ├── write_commands: { required: ["--dry-run"], commands: [...] }
│   │   └── format_resolution: { required: true, pattern: "resolve_format" }
│   ├── json_envelope/
│   │   ├── required_fields: ["$schema", "_meta", "success"]
│   │   └── meta_fields: ["format", "version", "command", "timestamp"]
│   ├── exit_codes/
│   │   ├── required_constants: true
│   │   ├── pattern: "exit.*\$EXIT_|exit.*EXIT_"
│   │   └── forbidden: "exit [0-9](?!\})"
│   └── error_handling/
│       ├── required_function: "output_error"
│       └── error_codes_pattern: "E_[A-Z_]+"
├── commands/
│   ├── write: ["add", "archive", "complete", "focus", "phase", "session", "update"]
│   ├── read: ["analyze", "blockers", "dash", "deps", "exists", "export", ...]
│   ├── sync: ["extract", "inject", "sync"]
│   └── maintenance: ["backup", "config", "init", "migrate", "restore", "validate"]
├── commandScripts/
│   └── { "list": "list-tasks.sh", "add": "add-task.sh", ... }
├── scoring/
│   └── { foundation_libs: 15, format_flag: 10, resolve_format: 15, ... }
└── thresholds/
    └── { pass: 95, warn: 80, fail: 0 }
```

### Dev Scripts Schema (`dev/compliance/dev-schema.json`)

Dev scripts use a parallel schema with different requirements:

| Main Scripts | Dev Scripts |
|--------------|-------------|
| `source lib/*.sh` | `source dev/lib/dev-common.sh` |
| `EXIT_*` constants | `DEV_EXIT_*` constants |
| `output_error()` | `log_error()` / `dev_die()` |
| `resolve_format()` | `dev_resolve_format()` |

---

## Adding New Commands to Schema

When adding a new command, update the schema to include it in compliance checks.

### Step 1: Add Script Mapping

Edit `dev/compliance/schema.json`:

```json
{
  "commandScripts": {
    "existing-cmd": "existing-cmd.sh",
    "new-command": "new-command.sh"
  }
}
```

### Step 2: Add to Command Category

```json
{
  "commands": {
    "read": ["existing-cmd", "new-command"],
    "write": ["add", "update"]
  }
}
```

### Step 3: Verify Compliance

```bash
# Check new command specifically
./dev/check-compliance.sh --command new-command --verbose

# Check for untracked scripts
./dev/check-compliance.sh --discover
```

### Step 4: Fix Any Issues

```bash
# Get fix suggestions
./dev/check-compliance.sh --command new-command --suggest
```

---

## CI Integration

### GitHub Actions Example

```yaml
name: Compliance Check

on:
  push:
    branches: [main]
  pull_request:
    paths:
      - 'scripts/**'
      - 'lib/**'

jobs:
  compliance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install jq
        run: sudo apt-get install -y jq

      - name: Check main scripts compliance
        run: ./dev/check-compliance.sh --ci --threshold 95

      - name: Check dev scripts compliance
        run: ./dev/check-compliance.sh --dev-scripts --ci --threshold 95

      - name: Upload compliance report
        if: always()
        run: ./dev/check-compliance.sh --format json > compliance-report.json

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: compliance-report
          path: compliance-report.json
```

### Pre-Commit Hook

```bash
#!/bin/bash
# .git/hooks/pre-commit

# Check compliance for changed scripts
changed_scripts=$(git diff --cached --name-only --diff-filter=ACM | grep -E '^scripts/.*\.sh$')

if [[ -n "$changed_scripts" ]]; then
    for script in $changed_scripts; do
        cmd=$(basename "$script" .sh | sed 's/-task$//' | sed 's/-command$//')
        echo "Checking compliance: $cmd"
        if ! ./dev/check-compliance.sh --command "$cmd" --ci --threshold 95; then
            echo "Compliance check failed for $cmd"
            exit 1
        fi
    done
fi
```

---

## Command Reference

### Output Formats

| Format | Description | Use Case |
|--------|-------------|----------|
| `text` | Human-readable with colors | Interactive terminal |
| `json` | Structured JSON object | Scripting, CI |
| `jsonl` | JSON Lines (one per check) | Streaming processing |
| `markdown` | Markdown table format | Documentation |
| `table` | ASCII table | Reports |

### Exit Codes

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | `DEV_EXIT_SUCCESS` | All checks passed threshold |
| 1 | `DEV_EXIT_GENERAL_ERROR` | General error |
| 2 | `DEV_EXIT_INVALID_INPUT` | Invalid arguments |
| 4 | `DEV_EXIT_NOT_FOUND` | Script or schema not found |
| 5 | `DEV_EXIT_DEPENDENCY_ERROR` | Missing dependency (jq) |
| 12 | `DEV_EXIT_COMPLIANCE_FAILED` | Below threshold (CI mode) |

### Full Options Reference

```
./dev/check-compliance.sh [OPTIONS]

Options:
  -c, --command <name>      Check specific command(s) (comma-separated)
  -k, --check <category>    Run specific check category
                            (foundation, flags, json-envelope, exit-codes, errors)
  -f, --format <format>     Output format: text, json, jsonl, markdown, table
  -t, --threshold <n>       Pass threshold percentage (default: 95)
      --ci                  CI mode (exit non-zero if below threshold)
      --incremental         Only check files changed since last run
      --force               Force full check (ignore cache)
      --static-only         Skip runtime JSON tests
      --discover            Find scripts not in schema (untracked)
      --suggest             Add LLM-actionable fix suggestions to output
      --dev-scripts         Check dev/ scripts instead of main scripts/
  -v, --verbose             Show detailed check output
  -q, --quiet               Only show failures and summary
  -h, --help                Show help message
      --version             Show version
```

---

## Troubleshooting

### Common Issues

#### Issue: Low Compliance Score

**Symptom:** Score below 95% threshold.

**Solutions:**

1. Run with `--suggest` to get fix recommendations:
   ```bash
   ./dev/check-compliance.sh --command <cmd> --suggest --verbose
   ```

2. Check specific category:
   ```bash
   ./dev/check-compliance.sh --command <cmd> --check foundation
   ```

3. Common missing patterns:
   - `resolve_format` call after argument parsing
   - Dual-path library loading
   - `--json` / `--human` shortcuts

#### Issue: Script Not Being Checked

**Symptom:** New script not appearing in compliance report.

**Solution:** Add to `commandScripts` in schema:

```bash
# Discover untracked scripts
./dev/check-compliance.sh --discover

# Add to dev/compliance/schema.json:
# "commandScripts": { "new-cmd": "new-cmd.sh" }
```

#### Issue: Dev Scripts Failing Different Checks

**Symptom:** Dev scripts fail on main script patterns.

**Solution:** Use `--dev-scripts` flag:

```bash
# Wrong - uses main schema
./dev/check-compliance.sh --command bump-version

# Correct - uses dev schema
./dev/check-compliance.sh --dev-scripts
```

#### Issue: Runtime JSON Checks Failing

**Symptom:** Static checks pass but runtime fails.

**Solutions:**

1. Skip runtime checks during development:
   ```bash
   ./dev/check-compliance.sh --static-only
   ```

2. Verify JSON output manually:
   ```bash
   ./scripts/list-tasks.sh --format json | jq .
   ```

3. Check for `$schema` field in JSON output

#### Issue: Cache Causing Stale Results

**Symptom:** Changes not reflected in check results.

**Solution:** Force fresh check:

```bash
./dev/check-compliance.sh --force
```

### Debug Mode

For detailed debugging:

```bash
./dev/check-compliance.sh --command list --verbose 2>&1 | less
```

---

## Scoring System

Each check contributes points toward the total score.

### Point Values (Main Scripts)

| Check | Points |
|-------|--------|
| Foundation libs | 15 |
| COMMAND_NAME | 5 |
| VERSION central | 5 |
| --format flag | 10 |
| --quiet flag | 5 |
| --json shortcut | 5 |
| --human shortcut | 5 |
| resolve_format() | 15 |
| $schema field | 10 |
| _meta block | 10 |
| success field | 10 |
| EXIT_* constants | 5 |
| output_error() | 5 |
| --dry-run (write cmds) | 5 |

**Total possible: ~105 points** (varies by command type)

### Thresholds

| Level | Score | Result |
|-------|-------|--------|
| Pass | >= 95% | Green, exit 0 |
| Warn | >= 80% | Yellow, exit 0 |
| Fail | < 80% | Red, exit 0 (or 12 in CI mode) |

---

## Library Architecture Compliance

In addition to LLM-Agent-First compliance for scripts, there is a separate compliance checker for library architecture.

### Library Architecture Checker

The `check-lib-compliance.sh` script validates `lib/*.sh` files against the [Library Architecture Specification](../specs/LIBRARY-ARCHITECTURE-SPEC.md).

```bash
# Full library architecture check
./dev/check-lib-compliance.sh

# Check specific aspect
./dev/check-lib-compliance.sh --check guard      # Source guards
./dev/check-lib-compliance.sh --check header     # Layer headers
./dev/check-lib-compliance.sh --check circular   # Circular dependencies
./dev/check-lib-compliance.sh --check count      # Dependency counts

# JSON output
./dev/check-lib-compliance.sh --json
```

### Library Checks

| Check | Validates | Purpose |
|-------|-----------|---------|
| **Source Guards** | `[[ -n "${_*_LOADED:-}" ]] && return 0` | Prevents double-sourcing |
| **Layer Headers** | `# LAYER:`, `# DEPENDENCIES:`, `# PROVIDES:` | Documents architecture |
| **Circular Deps** | No same-layer or upward sourcing | Maintains layer hierarchy |
| **Dependency Count** | ≤3 deps per file, ≤25 total | Controls complexity |

### Layer Limits

| Layer | Max Dependencies | Can Source |
|-------|------------------|------------|
| 0 (Foundation) | 0 | None |
| 1 (Core) | 2 | Layer 0 only |
| 2 (Services) | 3 | Layers 0-1 |
| 3 (Application) | 3 | Layers 0-2 |

---

## Related Documentation

- [LLM-Agent-First Specification](../specs/LLM-AGENT-FIRST-SPEC.md) - Authoritative design spec
- [Library Architecture Specification](../specs/LIBRARY-ARCHITECTURE-SPEC.md) - Library layer design
- [DEV-SCRIPTS-OVERVIEW.md](DEV-SCRIPTS-OVERVIEW.md) - Dev tooling documentation
- [DEV-WORKFLOW.md](../../dev/DEV-WORKFLOW.md) - Development workflow and commit strategy
- [Architecture](../architecture/ARCHITECTURE.md) - System architecture overview
