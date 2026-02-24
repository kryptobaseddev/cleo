# Injection Library API Reference

**Version**: 2.0.0
**Date**: 2026-01-05
**Epic**: T1384
**Files**: `lib/injection-registry.sh`, `lib/injection-config.sh`, `lib/injection.sh`

## Overview

The injection library provides multi-file LLM agent instruction injection for CLEO projects. It manages CLAUDE.md, AGENTS.md, and GEMINI.md files with versioned content blocks, ensuring agents always have current CLEO instructions.

### Architecture

**Layer 0: Registry** (`lib/injection-registry.sh`)
- Constants and configuration
- No dependencies (except implicit bash)
- Single source of truth for target files

**Layer 1: Configuration** (`lib/injection-config.sh`)
- Query functions for registry data
- Depends on: Layer 0 only

**Layer 2: Operations** (`lib/injection.sh`)
- File modification operations
- Depends on: Layers 0-1, exit-codes.sh

## Registry Constants (Layer 0)

### `INJECTION_TARGETS`
```bash
readonly INJECTION_TARGETS="CLAUDE.md AGENTS.md GEMINI.md"
```
Space-separated list of injectable files. To add new targets, modify this constant.

### `INJECTION_MARKER_START`
```bash
readonly INJECTION_MARKER_START="<!-- CLEO:START"
```
Start marker for injection blocks (version appended at runtime).

### `INJECTION_MARKER_END`
```bash
readonly INJECTION_MARKER_END="<!-- CLEO:END -->"
```
End marker for injection blocks.

### `INJECTION_VERSION_PATTERN`
```bash
readonly INJECTION_VERSION_PATTERN='CLEO:START v([0-9]+\.[0-9]+\.[0-9]+)'
```
Regex pattern for extracting version from markers.

### `INJECTION_TEMPLATE_MAIN`
```bash
readonly INJECTION_TEMPLATE_MAIN="templates/AGENT-INJECTION.md"
```
Path to main injection template (relative to `$CLEO_HOME`).

### `INJECTION_TEMPLATE_DIR`
```bash
readonly INJECTION_TEMPLATE_DIR="templates/agents"
```
Directory containing agent-specific header templates.

### `INJECTION_HEADERS`
```bash
declare -A INJECTION_HEADERS=(
    ["GEMINI.md"]="GEMINI-HEADER.md"
    ["CODEX.md"]="CODEX-HEADER.md"
    ["KIMI.md"]="KIMI-HEADER.md"
)
```
Associative array mapping target files to optional header templates.

### `INJECTION_VALIDATION_KEYS`
```bash
declare -A INJECTION_VALIDATION_KEYS=(
    ["CLAUDE.md"]="claude_md"
    ["AGENTS.md"]="agents_md"
    ["GEMINI.md"]="gemini_md"
)
```
JSON key names for validation output.

## Configuration Functions (Layer 1)

### `injection_is_valid_target()`

Check if a filename is a valid injection target.

**Signature:**
```bash
injection_is_valid_target <filename>
```

**Parameters:**
- `filename` - File to check (e.g., "CLAUDE.md")

**Returns:**
- `0` - Valid target
- `1` - Invalid target

**Example:**
```bash
if injection_is_valid_target "CLAUDE.md"; then
    echo "Valid target"
fi
```

### `injection_get_targets()`

Get array of all injection targets.

**Signature:**
```bash
injection_get_targets
```

**Parameters:** None

**Returns:**
- Sets `REPLY` array with target filenames

**Example:**
```bash
injection_get_targets
for target in "${REPLY[@]}"; do
    echo "Processing $target"
done
```

**Note:** Uses local `IFS=' '` to work around global IFS modifications by other libraries (e.g., `lib/backup.sh`).

### `injection_get_header_path()`

Get path to agent-specific header template (if exists).

**Signature:**
```bash
injection_get_header_path <target>
```

**Parameters:**
- `target` - Target filename (e.g., "GEMINI.md")

**Returns:**
- Prints full path to header template, or empty string if none

**Example:**
```bash
header=$(injection_get_header_path "GEMINI.md")
if [[ -n "$header" && -f "$header" ]]; then
    cat "$header"
fi
```

### `injection_get_template_path()`

Get path to main injection template.

**Signature:**
```bash
injection_get_template_path
```

**Parameters:** None

**Returns:**
- Prints full path to `templates/AGENT-INJECTION.md`

**Example:**
```bash
template=$(injection_get_template_path)
cat "$template"
```

### `injection_get_validation_key()`

Get JSON key name for a target file.

**Signature:**
```bash
injection_get_validation_key <target>
```

**Parameters:**
- `target` - Target filename (e.g., "CLAUDE.md")

**Returns:**
- Prints validation key (e.g., "claude_md")

**Example:**
```bash
key=$(injection_get_validation_key "CLAUDE.md")
echo "{\"$key\": \"valid\"}"
```

### `injection_has_block()`

Check if file contains an injection block.

**Signature:**
```bash
injection_has_block <file>
```

**Parameters:**
- `file` - Path to file to check

**Returns:**
- `0` - Injection block present
- `1` - No injection block

**Example:**
```bash
if injection_has_block "CLAUDE.md"; then
    echo "Injection present"
fi
```

## Operations Functions (Layer 2)

### `injection_update()`

Add or update injection in a target file.

**Signature:**
```bash
injection_update <target> [--dry-run]
```

**Parameters:**
- `target` - Target filename (must be in `INJECTION_TARGETS`)
- `--dry-run` - Optional. Preview action without modifying file

**Returns:**
- `0` - Success
- `EXIT_INVALID_INPUT` - Invalid target

**Output:**
- JSON object: `{"action": "created|added|updated", "target": "...", "success": true}`

**Actions:**
- `created` - File didn't exist, created with injection
- `added` - File existed without injection, prepended injection
- `updated` - File had injection, replaced with current version

**Example:**
```bash
# Preview
result=$(injection_update "CLAUDE.md" --dry-run)
echo "$result"  # {"action":"updated","target":"CLAUDE.md","dryRun":true}

# Execute
result=$(injection_update "CLAUDE.md")
echo "$result"  # {"action":"updated","target":"CLAUDE.md","success":true}
```

### `injection_check()`

Check injection status for a target file.

**Signature:**
```bash
injection_check <target>
```

**Parameters:**
- `target` - Path to file to check

**Returns:**
- Always returns `0`

**Output:**
- JSON object with status

**Status Values:**
- `missing` - File doesn't exist
- `none` - File exists but no injection block
- `legacy` - Injection present but no version marker
- `current` - Injection matches installed version
- `outdated` - Injection version differs from installed

**Example:**
```bash
status=$(injection_check "CLAUDE.md")
echo "$status"
# {"target":"CLAUDE.md","status":"current","currentVersion":"0.50.2","installedVersion":"0.50.2"}

# Parse status
status_code=$(echo "$status" | jq -r '.status')
case "$status_code" in
    current) echo "Up to date" ;;
    outdated) echo "Needs update" ;;
    missing) echo "File not found" ;;
esac
```

### `injection_check_all()`

Check injection status for all existing target files.

**Signature:**
```bash
injection_check_all
```

**Parameters:** None

**Returns:**
- Always returns `0`

**Output:**
- JSON array of status objects

**Example:**
```bash
statuses=$(injection_check_all)
echo "$statuses" | jq '.'
# [
#   {"target":"CLAUDE.md","status":"current","currentVersion":"0.50.2","installedVersion":"0.50.2"},
#   {"target":"AGENTS.md","status":"outdated","currentVersion":"0.49.0","installedVersion":"0.50.2"}
# ]

# Count outdated files
outdated=$(echo "$statuses" | jq '[.[] | select(.status == "outdated")] | length')
echo "Outdated files: $outdated"
```

### `injection_update_all()`

Update all injectable files in a project directory.

**Signature:**
```bash
injection_update_all [project_root]
```

**Parameters:**
- `project_root` - Optional. Project directory (defaults to `.`)

**Returns:**
- `0` - At least one file processed
- Non-zero - All files failed

**Output:**
- JSON summary object

**Example:**
```bash
result=$(injection_update_all ".")
echo "$result" | jq '.'
# {
#   "updated": 2,
#   "skipped": 1,
#   "failed": 0,
#   "results": [
#     {"target":"CLAUDE.md","action":"updated","success":true},
#     {"target":"AGENTS.md","action":"updated","success":true}
#   ]
# }

# Check if any failed
failed=$(echo "$result" | jq -r '.failed')
if [[ $failed -gt 0 ]]; then
    echo "Some files failed to update"
    echo "$result" | jq -r '.results[] | select(.success == false)'
fi
```

**Behavior:**
- Skips files with `status == "current"`
- Creates missing files
- Updates outdated/legacy/none files
- Reports failures with error messages

### `injection_get_summary()`

Get compact summary of injection status across all targets.

**Signature:**
```bash
injection_get_summary
```

**Parameters:** None

**Returns:**
- Always returns `0`

**Output:**
- JSON summary object

**Example:**
```bash
summary=$(injection_get_summary)
echo "$summary" | jq '.'
# {
#   "current": 2,
#   "outdated": 1,
#   "none": 0,
#   "missing": 0,
#   "total": 3
# }

# Display status
current=$(echo "$summary" | jq -r '.current')
total=$(echo "$summary" | jq -r '.total')
echo "$current/$total files current"
```

## Internal Functions

### `injection_apply()`

**Internal use only.** Applies injection content to a file.

**Signature:**
```bash
injection_apply <target> <content> <action>
```

**Parameters:**
- `target` - File path
- `content` - Injection content (with markers)
- `action` - One of: `created`, `added`, `updated`

**Behavior:**
- `created` - Writes content to new file
- `added` - Prepends content to existing file
- `updated` - Replaces existing injection block, preserves other content

**Note:** Uses `awk` to strip existing injection blocks. Handles special characters in markers via shell escaping.

## Integration Patterns

### Command Integration

**init.sh:**
```bash
source "$LIB_DIR/injection.sh"

# Auto-inject all targets
result=$(injection_update_all ".")
updated=$(echo "$result" | jq -r '.updated')
log_info "Injected $updated files"
```

**validate.sh:**
```bash
source "$LIB_DIR/injection.sh"

injection_get_targets
for target in "${REPLY[@]}"; do
    [[ ! -f "$target" ]] && continue

    status_json=$(injection_check "$target")
    status=$(echo "$status_json" | jq -r '.status')

    case "$status" in
        current) log_info "$target current" ;;
        outdated)
            if [[ "$FIX" == true ]]; then
                injection_update "$target"
            else
                log_warn "$target outdated. Run with --fix"
            fi
            ;;
    esac
done
```

**upgrade.sh:**
```bash
source "$LIB_DIR/injection.sh"

# Check status
statuses=$(injection_check_all)
outdated=$(echo "$statuses" | jq '[.[] | select(.status != "current")] | length')

if [[ $outdated -gt 0 ]]; then
    echo "Agent docs need updating ($outdated files)"
    # ... upgrade logic ...
    injection_update_all "."
fi
```

## Error Handling

### Exit Codes

- `0` - Success or informational (check/get functions)
- `EXIT_INVALID_INPUT` (6) - Invalid target filename

### JSON Error Format

```json
{
  "error": "Invalid target",
  "target": "INVALID.md",
  "validTargets": "CLAUDE.md AGENTS.md GEMINI.md"
}
```

Errors are written to stderr. Capture with:
```bash
error_file=$(mktemp)
result=$(injection_update "$target" 2>"$error_file")
exit_code=$?
if [[ $exit_code -ne 0 ]]; then
    error=$(cat "$error_file")
    echo "ERROR: $error" >&2
fi
rm -f "$error_file"
```

## Version Management

### Template Version

Version is embedded in template markers:
```markdown
<!-- CLEO:START v0.50.2 -->
...
<!-- CLEO:END -->
```

### Status Checking

```bash
# Check injection status (versionless - content-based comparison)
status=$(injection_check "CLAUDE.md" | jq -r '.status')

if [[ "$status" != "current" ]]; then
    echo "Update needed: status is $status"
fi
```

## Extending the System

### Adding New Target Files

**Step 1:** Update registry constant in `lib/injection-registry.sh`:
```bash
readonly INJECTION_TARGETS="CLAUDE.md AGENTS.md GEMINI.md COPILOT.md"
```

**Step 2:** (Optional) Add header template:
```bash
declare -A INJECTION_HEADERS=(
    ["COPILOT.md"]="COPILOT-HEADER.md"
)
```

**Step 3:** (Optional) Add validation key:
```bash
declare -A INJECTION_VALIDATION_KEYS=(
    ["COPILOT.md"]="copilot_md"
)
```

**Step 4:** Create header template (if needed):
```bash
cat > templates/agents/COPILOT-HEADER.md <<'EOF'
<!-- GitHub Copilot specific configuration -->
EOF
```

**Result:** All commands (init/validate/upgrade) will auto-discover and process the new file.

## Testing

### Unit Test Example

```bash
# tests/unit/injection.bats
@test "injection_is_valid_target returns 0 for CLAUDE.md" {
    source "$CLEO_HOME/lib/injection-config.sh"
    run injection_is_valid_target "CLAUDE.md"
    assert_success
}

@test "injection_get_targets returns array" {
    source "$CLEO_HOME/lib/injection-config.sh"
    injection_get_targets
    [[ ${#REPLY[@]} -eq 3 ]]
}

@test "injection_update creates missing file" {
    source "$CLEO_HOME/lib/injection.sh"
    cd "$BATS_TEST_TMPDIR"
    result=$(injection_update "CLAUDE.md")
    [[ -f "CLAUDE.md" ]]
    echo "$result" | grep -q '"action":"created"'
}
```

### Integration Test Example

```bash
# tests/integration/injection.bats
@test "init creates all agent docs" {
    cleo init test-project
    cd test-project
    [[ -f CLAUDE.md ]]
    [[ -f AGENTS.md ]]
    [[ -f GEMINI.md ]]
}

@test "validate --fix updates outdated injections" {
    cleo init test-project
    cd test-project

    # Simulate outdated
    sed -i 's/CLEO:START v.*/CLEO:START v0.1.0 -->/' CLAUDE.md

    cleo validate --fix

    version=$(grep -oP 'CLEO:START v\K[0-9.]+' CLAUDE.md)
    [[ "$version" == "$(cleo version -s)" ]]
}
```

## Performance Considerations

### Batch Operations

`injection_update_all()` is optimized for minimal disk I/O:
- Checks status before updating (skips current files)
- Uses single pass for version extraction
- Minimal temp file usage

### Large Files

Injection operations use `awk` for content manipulation:
- Memory-efficient streaming (no full file buffering)
- Handles files of any size
- Preserves original content unchanged (outside injection blocks)

## Common Issues

### Issue: Array Splitting Fails

**Symptom:** `injection_get_targets` returns 1 element instead of 3

**Cause:** Global `IFS` modified by other libraries (e.g., `lib/backup.sh`)

**Solution:** Function sets local `IFS=' '` to force space-based splitting

### Issue: Update Fails Silently

**Symptom:** `injection_update` returns success but file unchanged

**Cause:** Permissions issue or file in use

**Solution:** Check stderr output, verify write permissions

## See Also

- [INJECTION-SYSTEM-DESIGN.md](../../claudedocs/designs/INJECTION-SYSTEM-DESIGN.md) - Architecture specification
- [init.md](../commands/init.md) - init command documentation
- [upgrade.md](../commands/upgrade.md) - upgrade command documentation
- [validate.md](../commands/validate.md) - validate command documentation
- [AGENT-INJECTION.md](../../templates/AGENT-INJECTION.md) - Injection template content
