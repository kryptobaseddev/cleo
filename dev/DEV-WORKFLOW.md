# Development Workflow

**Canonical guide for ALL CLEO development** - both main application and dev tooling.

---

## Quick Reference: What To Do After Code Changes

| Change Type | Documentation | Version | Tests |
|-------------|---------------|---------|-------|
| Bug fix (`scripts/`) | Update if behavior changed | `patch` bump | Required |
| New feature (`scripts/`) | Full doc update (all layers) | `minor` bump | Required |
| Dev tooling (`dev/`) | Update `dev/README.md` only | No bump | Recommended |
| Breaking change | Full doc update + migration guide | `major` bump | Required |

**Before committing ANY main application change, you MUST:**
1. Update documentation per [DOCUMENTATION-MAINTENANCE.md](../docs/DOCUMENTATION-MAINTENANCE.md)
2. Bump version per [VERSION-MANAGEMENT.md](../docs/reference/VERSION-MANAGEMENT.md)
3. Run tests: `./tests/run-all-tests.sh`

---

## Part 1: Main Application Development

### Workflow for `scripts/` and `lib/` Changes

```
1. Make code changes
        ↓
2. Write/update tests
        ↓
3. Run tests: ./tests/run-all-tests.sh
        ↓
4. Update documentation (see Section 2)
        ↓
5. Bump version (see Section 3)
        ↓
6. Commit with proper prefix
        ↓
7. Install and verify: ./install.sh --force
```

### Commit Prefixes (Main Application)

| Prefix | Usage | Requires Version Bump |
|--------|-------|----------------------|
| `feat:` | New feature | Yes (minor) |
| `fix:` | Bug fix | Yes (patch) |
| `docs:` | Documentation only | No |
| `refactor:` | Code restructure, no behavior change | Yes (patch) |
| `test:` | Test additions/fixes | No |
| `chore:` | Maintenance, version bumps | Depends |

---

## Part 2: Documentation Updates

**CRITICAL**: All documentation follows a layered hierarchy. You MUST understand this before updating.

### The Documentation Hierarchy

```
Layer 1: AGENT-INJECTION.md    → Minimal (≤10 essential commands)
Layer 2: TODO_Task_Management.md → Concise (all commands, brief usage)
Layer 3: docs/commands/*.md      → Comprehensive (source of truth)
Layer 4: docs/INDEX.md           → Master index (links everything)
```

**Flow**: Users/LLMs start at Layer 1, drill down as needed.

### When to Update Each Layer

| Change | Layer 1 | Layer 2 | Layer 3 | Layer 4 |
|--------|---------|---------|---------|---------|
| New command | Only if essential | Yes | Yes (create) | Yes |
| New flag on existing cmd | No | Yes | Yes | No |
| Bug fix (no behavior change) | No | No | Maybe | No |
| Behavior change | If essential | Yes | Yes | No |

### Documentation Update Checklist

Before committing code changes:

- [ ] **Layer 3** (`docs/commands/<cmd>.md`): Create/update detailed docs
- [ ] **Layer 4** (`docs/INDEX.md`): Add link if new command
- [ ] **Layer 2** (`docs/TODO_Task_Management.md`): Add command syntax
- [ ] **Layer 1** (`templates/AGENT-INJECTION.md`): Only if essential command

**Full details**: [docs/DOCUMENTATION-MAINTENANCE.md](../docs/DOCUMENTATION-MAINTENANCE.md)

---

## Part 3: Version Management

### When to Bump Versions

| Change Type | Version Bump | Example |
|-------------|--------------|---------|
| Breaking change | `major` | Remove command, change behavior |
| New feature/command | `minor` | Add `analyze` command |
| Bug fix | `patch` | Fix output formatting |
| Docs only | None | Update README |
| Dev tooling | None | Add dev script |

### How to Bump

```bash
# Preview changes first
./dev/bump-version.sh --dry-run <type>

# Execute bump
./dev/bump-version.sh <type>   # major, minor, or patch

# Verify
./dev/validate-version.sh
```

### Version Bump Checklist

- [ ] Determine bump type (major/minor/patch)
- [ ] Run: `./dev/bump-version.sh <type>`
- [ ] Update `CHANGELOG.md` with changes
- [ ] Verify: `./dev/validate-version.sh`
- [ ] Install: `./install.sh --force`
- [ ] Test: `cleo version`

**Full details**: [docs/reference/VERSION-MANAGEMENT.md](../docs/reference/VERSION-MANAGEMENT.md)

---

## Part 4: Dev Tooling Development

Guidelines for contributing to dev tooling (`dev/` directory) specifically.

## Commit Strategy

Development tooling uses a separate commit strategy from the main application:

### Commit Prefixes

| Prefix | Usage | Example |
|--------|-------|---------|
| `chore(dev):` | Dev tooling changes | `chore(dev): Add compliance validator` |
| `fix(dev):` | Bug fixes in dev tools | `fix(dev): Fix pattern matching in checks` |
| `docs(dev):` | Dev documentation | `docs(dev): Update compliance schema docs` |
| `refactor(dev):` | Dev code restructuring | `refactor(dev): Extract shared utilities` |

### No Version Bumps

Dev tooling does **NOT** require version bumps:
- Dev scripts are not shipped to users
- No need to update VERSION, CHANGELOG, or package.json
- Changes are tracked through git history only

### Commit Message Format

```
chore(dev): Short description

Detailed explanation of what changed and why.

Files:
- dev/check-compliance.sh (new feature)
- dev/lib/dev-common.sh (updated)
```

## Directory Structure

```
dev/
├── check-compliance.sh      # LLM-Agent-First compliance validator
├── bump-version.sh          # Version management
├── validate-version.sh      # Version consistency checker
├── benchmark-performance.sh # Performance testing
├── test-rollback.sh         # Rollback testing
├── README.md                # Dev scripts overview
├── DEV-WORKFLOW.md          # This file
├── lib/                     # Shared dev library
│   ├── dev-colors.sh        # Color codes and symbols
│   ├── dev-exit-codes.sh    # Exit code constants
│   ├── dev-output.sh        # Logging functions
│   ├── dev-common.sh        # Common utilities
│   ├── dev-progress.sh      # Progress bars, timing
│   └── README.md            # Library documentation
└── compliance/              # Compliance checker modules
    ├── schema.json          # Main scripts schema
    ├── dev-schema.json      # Dev scripts schema
    ├── checks/              # Check modules
    └── lib/                 # Compliance utilities
```

## Compliance Checking

### Main Scripts

Check main application scripts against LLM-Agent-First spec:

```bash
# Full check
./dev/check-compliance.sh

# Specific command
./dev/check-compliance.sh --command list

# With fix suggestions
./dev/check-compliance.sh --suggest

# CI mode
./dev/check-compliance.sh --ci --threshold 95
```

### Dev Scripts (Self-Check)

Check dev scripts against dev standards:

```bash
# Check dev scripts
./dev/check-compliance.sh --dev-scripts

# Discover untracked dev scripts
./dev/check-compliance.sh --dev-scripts --discover

# With suggestions
./dev/check-compliance.sh --dev-scripts --suggest
```

## Dev Script Standards (LLM-Agent-First)

Dev scripts follow the same LLM-Agent-First principles as main scripts for consistency and agent automation support.

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

3. **Support format flags (--format, --json, --human, --quiet)**
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

5. **Use DEV_EXIT_* constants (no magic numbers)**
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

7. **Output JSON for non-TTY (agent automation)**
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

1. **Support --verbose for detailed output**
2. **Support --dry-run for destructive operations**
3. **Use dev_die for fatal errors**
4. **Use dev_require_command for dependencies**

## Updating Compliance Schemas

### Main Scripts Schema

Edit `dev/compliance/schema.json`:

```json
{
  "commandScripts": {
    "new-command": "new-command.sh"
  },
  "commands": {
    "read": ["...", "new-command"]
  }
}
```

### Dev Scripts Schema

Edit `dev/compliance/dev-schema.json`:

```json
{
  "commandScripts": {
    "new-dev-tool": "new-dev-tool.sh"
  },
  "commands": {
    "utilities": ["new-dev-tool"]
  }
}
```

## Pre-Commit Checklist

Before committing dev tooling changes:

- [ ] Run `./dev/check-compliance.sh --dev-scripts` (should pass 95%+)
- [ ] Run `./dev/check-compliance.sh` (ensure main scripts still pass)
- [ ] Test affected scripts manually
- [ ] Verify JSON output works (`./dev/<script>.sh --format json | jq .`)
- [ ] Update dev/README.md if adding new scripts
- [ ] Update this file if changing workflow

## CI Integration

```yaml
# Example GitHub Actions
dev-compliance:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - name: Check dev scripts compliance (LLM-Agent-First)
      run: ./dev/check-compliance.sh --dev-scripts --ci --threshold 95
```

## Adding New Dev Scripts

1. Create script in `dev/` directory
2. Source `dev-common.sh` at the top
3. Set `COMMAND_NAME` variable
4. Implement format flags (`--format`, `--json`, `--human`, `--quiet`, `--help`)
5. Call `dev_resolve_format()` after arg parsing
6. Use `DEV_EXIT_*` constants (no magic exit numbers)
7. Output JSON envelope for non-TTY (`_meta`, `success`, data)
8. Add to `dev/compliance/dev-schema.json`
9. Update `dev/README.md`
10. Run compliance check: `./dev/check-compliance.sh --dev-scripts --discover`

## Relationship to Main Application

| Aspect | Main (`scripts/`) | Dev (`dev/`) |
|--------|-------------------|--------------|
| Shipped | Yes | No |
| Versioning | Semver | None |
| Compliance | 95%+ required | 95%+ required (LLM-Agent-First) |
| Library | `lib/` | `dev/lib/` |
| Exit codes | `EXIT_*` | `DEV_EXIT_*` |
| Output | `output_error()` | `log_error()` / `dev_die()` |
| JSON output | Required (non-TTY) | Required (non-TTY) |
| Format resolution | `resolve_format()` | `dev_resolve_format()` |

## Troubleshooting

### Low Compliance Score

Dev scripts use different patterns than main scripts. If compliance is low:

1. Check you're using `--dev-scripts` flag
2. Ensure script sources `dev-common.sh`
3. Use `DEV_EXIT_*` instead of `EXIT_*`
4. Use `log_*` functions instead of `echo`

### Schema Not Found

```bash
# If dev-schema.json missing
./dev/check-compliance.sh --dev-scripts
# Error: Dev scripts schema not found
```

The schema should be at `dev/compliance/dev-schema.json`.

### Script Not Being Checked

Add the script to `dev/compliance/dev-schema.json`:

```json
{
  "commandScripts": {
    "my-script": "my-script.sh"
  }
}
```
