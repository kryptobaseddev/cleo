# Development Scripts

Scripts for project development and maintenance. **Not shipped to users.**

## Scripts

| Script | Purpose |
|--------|---------|
| `bump-version.sh` | Bump semantic version across all files |
| `validate-version.sh` | Verify version consistency |
| `benchmark-performance.sh` | Performance testing |
| `check-compliance.sh` | LLM-Agent-First compliance validation |
| `test-rollback.sh` | Test phase rollback feature |

## Shared Library (`lib/`)

The `dev/lib/` directory contains shared utilities for all dev scripts:

| Module | Purpose |
|--------|---------|
| `dev-colors.sh` | Color codes and Unicode symbols (NO_COLOR support) |
| `dev-exit-codes.sh` | Standardized exit code constants |
| `dev-output.sh` | Logging functions (log_info, log_error, etc.) |
| `dev-common.sh` | Common utilities (file ops, patterns, timestamps) |
| `dev-progress.sh` | Progress bars, spinners, and timing |

See [`lib/README.md`](lib/README.md) for detailed documentation.

## Usage

```bash
# From project root
./dev/bump-version.sh patch    # 0.16.0 → 0.16.1
./dev/bump-version.sh minor    # 0.16.0 → 0.17.0
./dev/bump-version.sh major    # 0.16.0 → 1.0.0

./dev/validate-version.sh      # Check version sync

./dev/benchmark-performance.sh # Run benchmarks

./dev/check-compliance.sh      # Full compliance check
```

## Compliance Checker

The `check-compliance.sh` tool validates all cleo commands against the LLM-AGENT-FIRST-SPEC.md requirements.

### Quick Start

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

# Verbose output (show all check details)
./dev/check-compliance.sh --verbose

# CI mode with threshold
./dev/check-compliance.sh --ci --threshold 95
./dev/check-compliance.sh --ci --threshold 100  # Strict mode

# Incremental mode (only changed files)
./dev/check-compliance.sh --incremental

# Static analysis only (skip runtime tests)
./dev/check-compliance.sh --static-only
```

### Check Categories

| Category | What it checks |
|----------|----------------|
| `foundation` | Library sourcing (exit-codes.sh, error-json.sh, output-format.sh), COMMAND_NAME, VERSION |
| `flags` | --format, --quiet, --json, --human shortcuts, resolve_format() |
| `exit-codes` | EXIT_* constants, no magic numbers |
| `errors` | output_error() usage, defensive checks, E_* error codes |
| `json-envelope` | Runtime JSON structure: $schema, _meta, success fields |

### CI/CD Integration

```bash
# In CI pipeline - fails if below 95%
./dev/check-compliance.sh --ci --threshold 95

# Generate JSON report for CI artifacts
./dev/check-compliance.sh --format json > compliance-report.json

# Quick check on changed files only
./dev/check-compliance.sh --incremental --ci
```

### Pre-commit Hook Example

```bash
#!/bin/bash
# .git/hooks/pre-commit

# Check compliance on changed script files
changed_scripts=$(git diff --cached --name-only -- 'scripts/*.sh')
if [[ -n "$changed_scripts" ]]; then
    ./dev/check-compliance.sh --static-only --ci --threshold 90
fi
```

### Updating the Schema

The compliance rules are defined in `dev/compliance/schema.json`. To add new requirements:

1. Edit `dev/compliance/schema.json`
2. Add patterns/rules to the appropriate section
3. Update the corresponding check module in `dev/compliance/checks/`
4. Test with `./dev/check-compliance.sh --verbose`

### Directory Structure

```
dev/
├── bump-version.sh              # Version bump script
├── validate-version.sh          # Version validation
├── benchmark-performance.sh     # Performance testing
├── check-compliance.sh          # Compliance validator (main entry)
├── test-rollback.sh             # Rollback tests
├── lib/                         # Shared dev library
│   ├── dev-colors.sh            # Colors and symbols
│   ├── dev-exit-codes.sh        # Exit code constants
│   ├── dev-output.sh            # Logging functions
│   ├── dev-common.sh            # Common utilities
│   ├── dev-progress.sh          # Progress bars and timing
│   └── README.md                # Library documentation
├── compliance/
│   ├── schema.json              # Central validation rules
│   ├── checks/
│   │   ├── foundation.sh        # Library sourcing checks
│   │   ├── flags.sh             # Flag support checks
│   │   ├── json-envelope.sh     # JSON output structure (runtime)
│   │   ├── exit-codes.sh        # Exit code usage checks
│   │   └── errors.sh            # Error handling checks
│   └── lib/
│       └── test-helpers.sh      # Compliance-specific utilities
└── .compliance-cache/           # Incremental check cache (gitignored)
```

## Note

These scripts are excluded from `install.sh` and never copied to `~/.cleo/`.
