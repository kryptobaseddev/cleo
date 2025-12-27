# Version Guard System - Final Design

> **SUPERSEDED**: This document has been superseded by [HEALTH-REGISTRY-SPEC.md](./HEALTH-REGISTRY-SPEC.md) which provides a comprehensive health registry system including version guards, health monitoring, and multi-agent coordination.

## Executive Summary

After sequential thinking analysis and 5 parallel challenge agents (Performance, Security, UX, Architecture, Backward Compatibility), we've refined the version guard system design. This document represents the consensus solution.

## Challenge Agent Findings Summary

### Performance Agent Key Insights
- **jq parses entire file** even for `._meta.version` query
  - Small file: 2ms, 500 tasks: 3ms, 2000 tasks: 7ms, 5000 tasks: 33ms
- **Alternative**: `head -n 3 | grep` stays constant at ~1ms regardless of file size
- Current wrapper startup: 15-16ms; adding guard adds 10-40% latency
- **Recommendation**: Use `head+grep` for startup, save jq for write operations

### Security Agent Key Insights (P0-P2 priorities)
- **P0**: Version check MUST happen AFTER lock acquisition (race condition)
- **P0**: Single atomic write per migration (no multi-save)
- **P1**: Add `.migration-in-progress` marker file
- **P1**: Extend checksum to cover full document structure
- Lock acquisition before version check to prevent TOCTOU attacks

### UX Agent Key Insights
- **Warning fatigue**: Once-per-session for reads, always for writes
- **Intent preservation**: Save user's command, execute after migration
- **Non-interactive mode**: JSON error with exit code 25, no prompts
- **TTY detection**: `[[ -t 0 && -t 1 ]]` for interactive detection
- **Migration wizard**: `ct migrate wizard` for post-install batch migration

### Architecture Agent Key Insights (CRITICAL)
- **Don't create startup-guard.sh or write-guard.sh** - Extend existing `lib/validation.sh`
- **Keep bash constants** in `lib/migrate.sh` - No JSON manifest (avoids jq overhead)
- **Reduce config to 2 options**: `migration.policy` + `migration.checkOnWrite`
- Existing `validate_version()` already provides 90% of needed functionality

### Backward Compatibility Agent Key Insights
- **Never add interactive prompts** without `--interactive` flag
- **All warnings to STDERR** - preserves JSON output integrity
- **Default to non-blocking** - warn, don't fail
- **Environment variable escape hatch**: `CLEO_VERSION_CHECK=0`
- **Add `_meta.lastWriterVersion`** field for team collaboration tracking

---

## Revised Architecture (Post-Challenge)

### What We're NOT Doing (Based on Challenge Feedback)

| Original Proposal | Why Not | Alternative |
|-------------------|---------|-------------|
| New `lib/startup-guard.sh` | Mixes concerns, duplicates validation.sh | Extend `lib/validation.sh` |
| New `lib/write-guard.sh` | Tight coupling, testing complexity | Extend existing write patterns |
| New `schemas/version-manifest.json` | jq parsing overhead, 6th version source | Keep bash constants in `lib/migrate.sh` |
| 4 config options | Complexity explosion | 2 options: policy + checkOnWrite |
| Version check on EVERY command | Performance hit | Read commands skip; write commands check |

### What We ARE Doing

```
LAYER 1: FAST VERSION CHECK (in wrapper, before dispatch)
├── Only for WRITE commands (add, update, complete, archive)
├── Use head+grep (not jq) - constant 1ms
├── Respects CLEO_VERSION_CHECK env var
└── Returns: 0=OK, 1=WARN, 2=BLOCK

LAYER 2: WRITE-TIME VALIDATION (in existing scripts)
├── Extend validate_version() in lib/validation.sh
├── Check happens AFTER lock acquisition
├── Policy-driven: warn | block | auto-migrate
└── Preserves user intent for retry

LAYER 3: FULL VALIDATION (existing validate.sh)
├── No changes needed
├── Already has --fix mode
└── Used for troubleshooting/CI
```

---

## Implementation Specification

### 1. Fast Version Check (wrapper addition)

```bash
# In ~/.cleo/scripts/cleo (wrapper)
# Add after load_config_aliases, before command dispatch

# Write commands that need version check
WRITE_COMMANDS="add update complete archive focus session sync"

fast_version_check() {
    # Skip if disabled via env
    [[ "${CLEO_VERSION_CHECK:-1}" == "0" ]] && return 0

    # Skip if not a write command
    [[ " $WRITE_COMMANDS " != *" $1 "* ]] && return 0

    # Skip if no project
    [[ ! -f ".cleo/todo.json" ]] && return 0

    # Fast version extraction (no jq, constant time)
    local project_version
    project_version=$(head -n 5 .cleo/todo.json 2>/dev/null | \
                      grep -oP '"version"\s*:\s*"\K[^"]+' | head -1)
    project_version="${project_version:-1.0.0}"

    # Compare major versions only for fast path
    local expected_major="${SCHEMA_VERSION_TODO%%.*}"
    local project_major="${project_version%%.*}"

    if [[ "$project_major" != "$expected_major" ]]; then
        return 2  # BLOCK - major mismatch
    elif [[ "$project_version" != "$SCHEMA_VERSION_TODO" ]]; then
        return 1  # WARN - minor mismatch
    fi
    return 0
}

# Call before dispatch (after case statement begins)
if [[ "$CMD" != "help" && "$CMD" != "version" && "$CMD" != "migrate" && "$CMD" != "validate" ]]; then
    fast_version_check "$CMD"
    case $? in
        1)  # Warn
            if [[ -t 2 ]]; then
                echo "[WARN] Schema outdated. Run: ct migrate run" >&2
            fi
            ;;
        2)  # Block
            echo "[ERROR] Schema incompatible. Run: ct migrate run" >&2
            exit 25
            ;;
    esac
fi
```

### 2. Enhanced validate_version_with_policy() (lib/validation.sh)

```bash
# Add to lib/validation.sh

# Policy-driven version validation for write operations
# Called by write scripts AFTER lock acquisition
validate_version_with_policy() {
    local file="$1"
    local schema_type="${2:-todo}"

    # Get policy from config (default: warn)
    local policy
    policy=$(get_config_value "migration.policy" "warn")

    # Detect versions
    local current_version expected_version
    current_version=$(detect_file_version "$file")
    expected_version=$(get_expected_version "$schema_type")

    # Compare
    compare_versions "$current_version" "$expected_version"
    local compat=$?

    case $compat in
        0)  # current < expected - needs migration
            case "$policy" in
                "warn")
                    [[ -t 2 ]] && log_warn "Migration available: v$current_version → v$expected_version"
                    return 0  # Allow operation
                    ;;
                "block")
                    log_error "Migration required: v$current_version → v$expected_version"
                    log_error "Run: ct migrate run"
                    return 1
                    ;;
                "auto")
                    log_info "Auto-migrating: v$current_version → v$expected_version"
                    if migrate_file "$file" "$schema_type" "$current_version" "$expected_version"; then
                        return 0
                    else
                        log_error "Auto-migration failed"
                        return 1
                    fi
                    ;;
            esac
            ;;
        1)  # Equal - OK
            return 0
            ;;
        2)  # current > expected - project newer than CLI
            [[ -t 2 ]] && log_warn "Project v$current_version newer than CLI. Some data may not be preserved."
            return 0  # Allow but warn
            ;;
    esac
}
```

### 3. Write Script Integration (minimal change)

```bash
# In add-task.sh, update-task.sh, complete-task.sh, archive.sh
# Add after lock acquisition, before write operation

# Check version policy (respects migration.checkOnWrite config)
if [[ "$(get_config_value 'migration.checkOnWrite' 'true')" == "true" ]]; then
    if ! validate_version_with_policy "$TODO_FILE" "todo"; then
        unlock_file "$TODO_FILE"
        exit "${EXIT_MIGRATION_REQUIRED:-25}"
    fi
fi
```

### 4. New Exit Code

```bash
# Add to lib/exit-codes.sh
readonly EXIT_MIGRATION_REQUIRED=25
export EXIT_MIGRATION_REQUIRED
```

### 5. Configuration Schema Addition

```json
// Add to schemas/config.schema.json under "properties"
"migration": {
    "type": "object",
    "description": "Schema version management settings",
    "properties": {
        "policy": {
            "type": "string",
            "enum": ["warn", "block", "auto"],
            "default": "warn",
            "description": "Behavior when schema version mismatch detected"
        },
        "checkOnWrite": {
            "type": "boolean",
            "default": true,
            "description": "Check schema version before write operations"
        }
    },
    "additionalProperties": false
}
```

### 6. Tracking Field Addition

```bash
# In save_json() or atomic write functions
# Add after successful write:
update_last_writer_version() {
    local file="$1"
    local cli_version
    cli_version=$(cat "${CLEO_HOME:-$HOME/.cleo}/VERSION" 2>/dev/null || echo "unknown")

    jq --arg v "$cli_version" \
       --arg t "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
       '._meta.lastWriterVersion = $v | ._meta.lastWrittenAt = $t' \
       "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
}
```

---

## Migration Path

### Phase 1: Observation (v0.24.0)
- [x] Add `_meta.lastWriterVersion` tracking (non-breaking)
- [x] Add `EXIT_MIGRATION_REQUIRED=25` exit code
- [x] Add config schema for `migration.policy` and `migration.checkOnWrite`
- [x] Add `validate_version_with_policy()` to validation.sh
- [ ] Defaults: `policy=warn`, `checkOnWrite=true`

### Phase 2: Integration (v0.25.0)
- [ ] Add fast version check to wrapper (write commands only)
- [ ] Integrate `validate_version_with_policy()` into write scripts
- [ ] Add `CLEO_VERSION_CHECK` env var override
- [ ] Add JSON error output for non-TTY mode

### Phase 3: Polish (v0.26.0)
- [ ] Add `ct migrate wizard` for batch migration
- [ ] Add post-install project scan to install.sh
- [ ] Add session-based warning suppression
- [ ] Documentation consolidation

---

## Testing Strategy

### Unit Tests (test_version_guard.bats)
```bash
@test "fast_version_check returns 0 for matching versions" { ... }
@test "fast_version_check returns 1 for minor mismatch" { ... }
@test "fast_version_check returns 2 for major mismatch" { ... }
@test "fast_version_check skips for read commands" { ... }
@test "CLEO_VERSION_CHECK=0 disables checks" { ... }
```

### Integration Tests
```bash
@test "add-task warns on version mismatch (policy=warn)" { ... }
@test "add-task blocks on version mismatch (policy=block)" { ... }
@test "add-task auto-migrates (policy=auto)" { ... }
@test "piped output returns JSON error, exit 25" { ... }
```

### Fixtures Needed
- `fixtures/todo-v2.0.0.json`
- `fixtures/todo-v2.1.0.json`
- `fixtures/todo-v2.2.0.json`
- `fixtures/todo-v2.3.0.json`
- `fixtures/todo-no-version.json`

---

## Risk Mitigations Applied

| Risk | Mitigation |
|------|------------|
| Performance regression | Use head+grep (1ms) not jq (2-33ms) |
| CI/CD breaking | Default policy=warn (non-blocking), env var override |
| Race conditions | Version check after lock acquisition |
| Warning fatigue | Write commands only, session-based suppression |
| Configuration explosion | Only 2 options (policy, checkOnWrite) |
| Backward compatibility | Fallback version detection, warn-only defaults |
| Team collaboration | `lastWriterVersion` tracking field |

---

## Files to Modify

| File | Change |
|------|--------|
| `lib/exit-codes.sh` | Add `EXIT_MIGRATION_REQUIRED=25` |
| `lib/validation.sh` | Add `validate_version_with_policy()` |
| `schemas/config.schema.json` | Add `migration` section |
| `scripts/add-task.sh` | Add version check after lock |
| `scripts/update-task.sh` | Add version check after lock |
| `scripts/complete-task.sh` | Add version check after lock |
| `scripts/archive.sh` | Add version check after lock |
| Wrapper script | Add `fast_version_check()` |

---

## Success Criteria

1. **Performance**: < 5ms added latency for typical projects (< 500 tasks)
2. **Safety**: No data corruption on version mismatch
3. **UX**: Clear, actionable messages; no warning fatigue
4. **Compatibility**: All existing scripts/automation continue to work
5. **Testability**: All new code has unit + integration tests
