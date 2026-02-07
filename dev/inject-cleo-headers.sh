#!/usr/bin/env bash
# inject-cleo-headers.sh - Generate and inject ###CLEO headers into all scripts
# @task T3111
#
# Reads metadata from COMMANDS-INDEX.json and injects structured header blocks
# into each script file. This is a one-time migration tool.
#
# Usage: ./dev/inject-cleo-headers.sh [--dry-run] [--script <name>]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INDEX_FILE="$SCRIPT_DIR/docs/commands/COMMANDS-INDEX.json"
SCRIPTS_DIR="$SCRIPT_DIR/scripts"

DRY_RUN=false
SINGLE_SCRIPT=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) DRY_RUN=true; shift ;;
        --script) SINGLE_SCRIPT="$2"; shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

if [[ ! -f "$INDEX_FILE" ]]; then
    echo "ERROR: COMMANDS-INDEX.json not found at $INDEX_FILE" >&2
    exit 1
fi

# Count commands to process
TOTAL=$(jq '[.commands[] | select(.script)] | length' "$INDEX_FILE")
PROCESSED=0
SKIPPED=0
INJECTED=0

echo "Processing $TOTAL commands from COMMANDS-INDEX.json..."
echo ""

# Process each command
jq -c '.commands[] | select(.script)' "$INDEX_FILE" | while IFS= read -r cmd_json; do
    name=$(echo "$cmd_json" | jq -r '.name')
    script=$(echo "$cmd_json" | jq -r '.script')
    category=$(echo "$cmd_json" | jq -r '.category')
    synopsis=$(echo "$cmd_json" | jq -r '.synopsis')
    aliases=$(echo "$cmd_json" | jq -r '(.aliases // []) | join(",")')
    relevance=$(echo "$cmd_json" | jq -r '.agentRelevance')
    flags=$(echo "$cmd_json" | jq -r '(.flags // []) | join(",")')
    exits=$(echo "$cmd_json" | jq -r '(.exitCodes // []) | map(tostring) | join(",")')
    json_output=$(echo "$cmd_json" | jq -r '.jsonOutput // false')
    json_default=$(echo "$cmd_json" | jq -r '.jsonDefault // false')
    subcommands=$(echo "$cmd_json" | jq -r '(.subcommands // []) | join(",")')
    note=$(echo "$cmd_json" | jq -r '.note // ""')
    alias_for=$(echo "$cmd_json" | jq -r '.aliasFor // ""')

    # Skip if single script mode and not matching
    if [[ -n "$SINGLE_SCRIPT" && "$name" != "$SINGLE_SCRIPT" ]]; then
        continue
    fi

    script_path="$SCRIPTS_DIR/$script"

    # Check if script exists
    if [[ ! -f "$script_path" ]]; then
        echo "  WARN: Script not found: $script_path (command: $name)"
        ((SKIPPED++)) || true
        continue
    fi

    # Check if already has ###CLEO header
    if grep -q '^###CLEO' "$script_path" 2>/dev/null; then
        echo "  SKIP: $script (already has ###CLEO header)"
        ((SKIPPED++)) || true
        continue
    fi

    # Build header block
    header="###CLEO"
    header="$header
# command: $name"
    header="$header
# category: $category"
    header="$header
# synopsis: $synopsis"

    # Optional fields - only include if non-empty
    [[ -n "$aliases" ]] && header="$header
# aliases: $aliases"
    [[ -n "$alias_for" ]] && header="$header
# alias-for: $alias_for"

    header="$header
# relevance: $relevance"

    [[ -n "$flags" ]] && header="$header
# flags: $flags"
    [[ -n "$exits" ]] && header="$header
# exits: $exits"

    header="$header
# json-output: $json_output"

    # Only include json-default if true
    [[ "$json_default" == "true" ]] && header="$header
# json-default: true"

    [[ -n "$subcommands" ]] && header="$header
# subcommands: $subcommands"
    [[ -n "$note" ]] && header="$header
# note: $note"

    header="$header
###END"

    if [[ "$DRY_RUN" == "true" ]]; then
        echo "  DRY-RUN: Would inject into $script:"
        echo "$header" | sed 's/^/    /'
        echo ""
    else
        # Inject after shebang line
        # Read the file, find the shebang, insert header after it
        tmp_file="${script_path}.tmp.$$"

        # Get the shebang line (first line)
        shebang=$(head -1 "$script_path")

        # Write: shebang + header + rest of file
        {
            echo "$shebang"
            echo "$header"
            tail -n +2 "$script_path"
        } > "$tmp_file"

        mv "$tmp_file" "$script_path"
        chmod +x "$script_path"
        echo "  OK: $script ($name)"
    fi

    ((INJECTED++)) || true
done

echo ""
echo "Done. Injected: $INJECTED, Skipped: $SKIPPED"
