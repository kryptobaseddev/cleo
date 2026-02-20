# Development Library (`dev/lib/`)

Shared utilities for claude-todo development scripts. This library provides standardized colors, logging, exit codes, and utilities used across all dev tools.

## Architecture

```
dev/lib/
├── dev-colors.sh      # Color codes and symbols (foundation - no deps)
├── dev-exit-codes.sh  # Exit code constants (foundation - no deps)
├── dev-output.sh      # Logging functions (depends on colors, exit-codes)
├── dev-common.sh      # Common utilities (depends on output)
├── dev-progress.sh    # Progress bars, timing (depends on colors, output)
└── README.md          # This file
```

### Dependency Order

```
Layer 0 (no dependencies):
  ├── dev-colors.sh
  └── dev-exit-codes.sh

Layer 1:
  └── dev-output.sh (requires: colors, exit-codes)

Layer 2:
  ├── dev-common.sh (requires: output)
  └── dev-progress.sh (requires: colors, output)
```

## Usage

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
    log_info() { echo -e "${GREEN}✓${NC} $*"; }
    log_error() { echo -e "${RED}✗${NC} $*" >&2; }
fi
```

## Module Reference

### dev-colors.sh

Terminal colors with NO_COLOR support and Unicode symbols.

**Colors:**
- `DEV_RED`, `DEV_GREEN`, `DEV_YELLOW`, `DEV_BLUE`, `DEV_CYAN`
- `DEV_BOLD`, `DEV_DIM`, `DEV_NC` (no color/reset)
- Legacy aliases: `RED`, `GREEN`, `YELLOW`, `BLUE`, `NC`

**Symbols:**
- `DEV_SYM_CHECK` (✓), `DEV_SYM_CROSS` (✗), `DEV_SYM_WARN` (⚠)
- `DEV_SYM_ARROW` (→), `DEV_SYM_BULLET` (•)
- Progress bar: `DEV_SYM_BAR_FULL` (█), `DEV_SYM_BAR_EMPTY` (░)
- Legacy aliases: `PASS_SYM`, `FAIL_SYM`, `WARN_SYM`

**Functions:**
- `dev_should_use_color` - Check if colors should be used
- `dev_should_use_unicode` - Check if Unicode should be used

### dev-exit-codes.sh

Standardized exit codes for dev tools.

**Success:**
- `DEV_EXIT_SUCCESS=0`

**Errors (1-9):**
- `DEV_EXIT_GENERAL_ERROR=1`
- `DEV_EXIT_INVALID_INPUT=2`
- `DEV_EXIT_FILE_ERROR=3`
- `DEV_EXIT_NOT_FOUND=4`
- `DEV_EXIT_DEPENDENCY_ERROR=5`
- `DEV_EXIT_JSON_ERROR=6`

**Validation Errors (10-19):**
- `DEV_EXIT_VERSION_INVALID=10`
- `DEV_EXIT_VERSION_DRIFT=11`
- `DEV_EXIT_COMPLIANCE_FAILED=12`
- `DEV_EXIT_SCHEMA_ERROR=13`

**Dev-Specific (20-29):**
- `DEV_EXIT_BUMP_FAILED=20`
- `DEV_EXIT_BENCHMARK_FAILED=21`
- `DEV_EXIT_TEST_FAILED=22`
- `DEV_EXIT_ROLLBACK_FAILED=23`

**Special (100+):**
- `DEV_EXIT_NO_CHANGE=100`
- `DEV_EXIT_DRY_RUN=101`

**Functions:**
- `dev_get_exit_code_name <code>` - Get human-readable name
- `dev_is_error_code <code>` - Check if code is an error

### dev-output.sh

Logging and output formatting.

**Logging:**
```bash
log_info "Success message"      # ✓ Success message
log_warn "Warning message"      # ⚠ Warning message
log_error "Error message"       # ✗ Error message (to stderr)
log_step "Action message"       # → Action message
log_skip "Skipped item"         # ○ Skipped item (skipped)
log_debug "Debug info"          # Only shown if DEV_DEBUG is set
```

**Headers:**
```bash
dev_print_header "Section Title"
dev_print_subheader "Subsection"
```

**Check Results:**
```bash
dev_print_check pass "Test passed"
dev_print_check fail "Test failed" "Details here"
dev_print_check skip "Test skipped"
dev_print_check warn "Warning" "Details"
```

**Summary:**
```bash
dev_print_summary 10 2 1  # 10 passed, 2 failed, 1 skipped
```

**Utilities:**
```bash
dev_die "Error message" $DEV_EXIT_INVALID_INPUT  # Log error and exit
dev_print_next_steps "Run tests" "Deploy"        # Print numbered steps
```

### dev-common.sh

Common utilities for file operations, patterns, and more.

**Dependencies:**
```bash
dev_require_command jq "apt install jq"  # Exit if missing
dev_require_commands jq bc grep          # Check multiple
dev_command_exists foo                    # Returns 0/1
```

**File Operations:**
```bash
hash=$(dev_file_hash "$file")            # SHA256/MD5 hash
mtime=$(dev_file_mtime "$file")          # Modification time
dev_sed_inplace "s/old/new/" "$file"     # Platform-safe sed -i
dev_require_file "$file" "Config file"   # Exit if missing
backup=$(dev_backup_file "$file")        # Create .bak
```

**Pattern Matching:**
```bash
if dev_pattern_exists "$file" "pattern"; then ...
count=$(dev_pattern_count "$file" "pattern")
matches=$(dev_pattern_matches "$file" "pattern")
```

**Timestamps:**
```bash
ts=$(dev_timestamp)           # 2025-01-01T12:00:00Z
ts=$(dev_timestamp_filename)  # 20250101-120000
```

**Temp Files:**
```bash
tmp=$(dev_temp_file "prefix")    # /tmp/prefix.XXXXXX
dir=$(dev_temp_dir "prefix")     # /tmp/prefix.XXXXXX/
```

**Version Utilities:**
```bash
if dev_validate_semver "1.2.3"; then ...
if dev_compare_semver "1.2.0" "<" "1.3.0"; then ...
```

**Scoring:**
```bash
score=$(dev_calc_score 8 10)  # "80.0"
```

### dev-progress.sh

Progress bars, spinners, and timing.

**Progress Bar:**
```bash
for i in {1..100}; do
    dev_progress_bar $i 100 30 "Processing..."
    sleep 0.01
done
dev_progress_done
```

**Spinner:**
```bash
dev_spinner_start "Working..."
# ... long operation ...
dev_spinner_stop "Done!"
```

**Timing:**
```bash
elapsed=$(dev_measure_ms "sleep 0.1")     # Measure command time
echo "Took $(dev_format_duration $elapsed)"  # "100ms"
```

**Benchmarking:**
```bash
dev_benchmark "ls -la" 5                  # Run 5 times
echo "Mean: $DEV_BENCH_MEAN ms"
echo "Min: $DEV_BENCH_MIN ms"
echo "Max: $DEV_BENCH_MAX ms"
```

## Design Principles

1. **Guard Pattern**: All modules guard against multiple sourcing
2. **Dependency Sourcing**: Each module sources its dependencies
3. **Legacy Aliases**: Provides aliases for backward compatibility
4. **NO_COLOR Support**: Respects the NO_COLOR environment variable
5. **Fallback Support**: Scripts should include fallbacks for robustness
6. **Export Functions**: All public functions are exported

## Relationship to Main `lib/`

| Aspect | Main `lib/` | `dev/lib/` |
|--------|-------------|------------|
| Scope | Runtime (shipped) | Development only |
| Prefix | `EXIT_`, no prefix | `DEV_EXIT_`, `dev_*` |
| Dependencies | Cross-references | Self-contained |
| Platform compat | Full | Basic (modern systems) |

## Testing

The library is tested implicitly through the dev scripts:

```bash
# Run validate-version (uses dev-common.sh)
./dev/validate-version.sh

# Run bump-version dry-run (uses dev-output.sh)
./dev/bump-version.sh --dry-run patch

# Run compliance check (uses test-helpers.sh → dev-common.sh)
./dev/check-compliance.sh --static-only --command list
```
