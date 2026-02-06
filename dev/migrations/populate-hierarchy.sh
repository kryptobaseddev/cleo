#!/usr/bin/env bash
# populate-hierarchy.sh - Populate parentId from naming convention and depends→epic
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(dirname "$SCRIPT_DIR")/lib"

source "${LIB_DIR}/exit-codes.sh"
source "${LIB_DIR}/error-json.sh"
source "${LIB_DIR}/output-format.sh"
source "${LIB_DIR}/version.sh"
source "${LIB_DIR}/flags.sh"

# Get CLI version (fail loudly if unreadable)
if [[ -z "${CLEO_VERSION:-}" ]]; then
    echo "ERROR: CLEO_VERSION not set. Cannot determine version." >&2
    exit "${EXIT_FILE_READ_ERROR:-3}"
fi
VERSION="$CLEO_VERSION"
COMMAND_NAME="populate-hierarchy"
TODO_FILE="${CLEO_DIR:-.cleo}/todo.json"

# Initialize flag defaults
init_flag_defaults

show_help() {
    cat << 'EOF'
Usage: cleo populate-hierarchy [OPTIONS]

Populate parentId field based on:
1. Naming convention: "T001.1" in title → parentId: "T001"
2. Depends on epic: if depends=[T001] and T001.type=epic → parentId: "T001"

Options:
  -f, --format FORMAT   Output format (text|json)
  --json                Shortcut for --format json
  --human               Shortcut for --format text
  -q, --quiet           Suppress non-essential output
  --dry-run             Preview changes without applying
  -h, --help            Show this help message
EOF
}

# Parse common flags first
parse_common_flags "$@"
set -- "${REMAINING_ARGS[@]}"

# Bridge to legacy variables
apply_flags_to_globals
FORMAT="${FORMAT:-}"
QUIET="${QUIET:-false}"
DRY_RUN="${DRY_RUN:-false}"

# Handle help flag
if [[ "$FLAG_HELP" == true ]]; then
  show_help
  exit 0
fi

# Parse command-specific arguments (none currently)
while [[ $# -gt 0 ]]; do
  case "$1" in
    *)  shift ;;
  esac
done

FORMAT=$(resolve_format "$FORMAT")

if [[ ! -f "$TODO_FILE" ]]; then
    output_error "E_FILE_NOT_FOUND" "Todo file not found: $TODO_FILE" $EXIT_FILE_ERROR false
    exit $EXIT_FILE_ERROR
fi

# Do all the work in a single jq call for efficiency
result=$(jq -c '
# Build epic lookup
def epic_ids: [.tasks[] | select(.type == "epic") | .id];

# Extract parent from title pattern "T###.N:"
def extract_parent_from_title:
  if .title | test("^T[0-9]+\\.") then
    .title | capture("^(?<parent>T[0-9]+)\\.") | .parent
  else
    null
  end;

# Check if single depends points to epic
def single_epic_dep(epics):
  if (.depends // []) | length == 1 then
    (.depends[0]) as $dep |
    if (epics | index($dep)) then $dep else null end
  else
    null
  end;

epic_ids as $epics |
{
  changes: [
    .tasks[] |
    select(.type != "epic") |
    select(.parentId == null or .parentId == "") |
    . as $task |
    (extract_parent_from_title // single_epic_dep($epics)) as $new_parent |
    select($new_parent != null) |
    # Verify parent exists in epics
    select($epics | index($new_parent)) |
    {
      taskId: .id,
      title: .title,
      newParentId: $new_parent,
      source: (if extract_parent_from_title then "naming" else "depends" end)
    }
  ],
  skipped: [.tasks[] | select(.parentId != null and .parentId != "")] | length
}
' "$TODO_FILE")

naming_changes=$(echo "$result" | jq '[.changes[] | select(.source == "naming")] | length')
depends_changes=$(echo "$result" | jq '[.changes[] | select(.source == "depends")] | length')
skipped=$(echo "$result" | jq '.skipped')
total_changes=$((naming_changes + depends_changes))
changes_json=$(echo "$result" | jq '.changes')

# Apply changes if not dry-run
if [[ "$DRY_RUN" != true ]] && [[ $total_changes -gt 0 ]]; then
    temp_file=$(mktemp)
    cp "$TODO_FILE" "$temp_file"

    # Apply all changes in one jq call
    echo "$changes_json" | jq -c '.[]' | while read -r change; do
        tid=$(echo "$change" | jq -r '.taskId')
        new_pid=$(echo "$change" | jq -r '.newParentId')

        local _mig_content
        _mig_content=$(jq --arg id "$tid" --arg pid "$new_pid" \
            '(.tasks[] | select(.id == $id)).parentId = $pid' \
            "$temp_file")
        echo "$_mig_content" > "$temp_file"
    done

    # Update checksum
    new_checksum=$(jq -cS '.tasks' "$temp_file" | sha256sum | cut -c1-16)
    local _mig_cs_content
    _mig_cs_content=$(jq --arg cs "$new_checksum" '.checksum = $cs' "$temp_file")
    echo "$_mig_cs_content" > "$temp_file"

    mv "$temp_file" "$TODO_FILE"
fi

# Output
timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

if [[ "$FORMAT" == "json" ]]; then
    jq -nc \
        --arg version "$VERSION" \
        --arg cmd "$COMMAND_NAME" \
        --arg ts "$timestamp" \
        --argjson dry_run "$DRY_RUN" \
        --argjson changes "$changes_json" \
        --argjson naming "$naming_changes" \
        --argjson depends "$depends_changes" \
        --argjson skipped "$skipped" \
        '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
                "format": "json",
                "version": $version,
                "command": $cmd,
                "timestamp": $ts
            },
            "success": true,
            "dryRun": $dry_run,
            "summary": {
                "totalChanges": ($naming + $depends),
                "byNamingConvention": $naming,
                "byDependsOnEpic": $depends,
                "skippedAlreadyHasParent": $skipped
            },
            "changes": $changes
        }'
else
    if [[ "$DRY_RUN" == true ]]; then
        echo "DRY RUN - No changes applied"
        echo ""
    fi

    echo "Hierarchy Population Results"
    echo "═══════════════════════════════════════════════════════════"
    echo ""
    echo "Changes: $total_changes"
    echo "  • By naming convention (T###.#): $naming_changes"
    echo "  • By depends→epic: $depends_changes"
    echo "  • Skipped (already has parent): $skipped"

    if [[ $total_changes -gt 0 ]]; then
        echo ""
        echo "Details:"
        echo "───────────────────────────────────────────────────────────"
        echo "$changes_json" | jq -r '.[] | "  \(.taskId) → parentId: \(.newParentId) (\(.source))\n    \"\(.title[0:50])...\""'
    fi

    if [[ "$DRY_RUN" != true ]] && [[ $total_changes -gt 0 ]]; then
        echo ""
        echo "✓ Changes applied to $TODO_FILE"
    fi
fi

exit $EXIT_SUCCESS
