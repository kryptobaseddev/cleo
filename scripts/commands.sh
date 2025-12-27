#!/usr/bin/env bash
# commands.sh - List and query available commands from COMMANDS-INDEX.json
# LLM-AGENT-FIRST: JSON output by default (non-TTY), --human for text
set -euo pipefail

# ============================================================================
# SETUP
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(dirname "$SCRIPT_DIR")/lib"

# Source required libraries
source "${LIB_DIR}/exit-codes.sh"
source "${LIB_DIR}/error-json.sh"
source "${LIB_DIR}/output-format.sh"

# Source version library for proper version management
if [[ -f "$LIB_DIR/version.sh" ]]; then
  # shellcheck source=../lib/version.sh
  source "$LIB_DIR/version.sh"
fi

# Command identification (for error reporting)
COMMAND_NAME="commands"

# ============================================================================
# LOCATE COMMANDS INDEX
# ============================================================================

# Try multiple locations for COMMANDS-INDEX.json
COMMANDS_INDEX=""
if [[ -n "${CLEO_HOME:-}" ]] && [[ -f "$CLEO_HOME/docs/commands/COMMANDS-INDEX.json" ]]; then
    COMMANDS_INDEX="$CLEO_HOME/docs/commands/COMMANDS-INDEX.json"
elif [[ -f "${SCRIPT_DIR}/../docs/commands/COMMANDS-INDEX.json" ]]; then
    COMMANDS_INDEX="${SCRIPT_DIR}/../docs/commands/COMMANDS-INDEX.json"
elif [[ -f "/mnt/projects/claude-todo/docs/commands/COMMANDS-INDEX.json" ]]; then
    COMMANDS_INDEX="/mnt/projects/claude-todo/docs/commands/COMMANDS-INDEX.json"
fi

# ============================================================================
# FLAG DEFAULTS
# ============================================================================

FORMAT=""        # Resolved after parsing
QUIET=false
FILTER_CATEGORY=""
FILTER_RELEVANCE=""
SHOW_WORKFLOWS=false
SHOW_LOOKUP=false
COMMAND_NAME_FILTER=""

# ============================================================================
# HELP
# ============================================================================

show_help() {
    cat << 'EOF'
commands - List and query available cleo commands

Usage: cleo commands [OPTIONS] [COMMAND]

Options:
  -f, --format FORMAT   Output format (text|json|jsonl|markdown|table)
  --json                Shortcut for --format json
  --human               Shortcut for --format text
  -q, --quiet           Suppress non-essential output
  -c, --category CAT    Filter by category (write|read|sync|maintenance)
  -r, --relevance LVL   Filter by agent relevance (critical|high|medium|low)
  --workflows           Show agent workflow sequences
  --lookup              Show intent-to-command quick lookup
  -h, --help            Show this help message

Arguments:
  COMMAND               Show details for specific command

Examples:
  cleo commands                    # List all commands (JSON)
  cleo commands --human            # Human-readable list
  cleo commands -c write           # Write commands only
  cleo commands -r critical        # Agent-critical commands
  cleo commands add                # Details for 'add' command
  cleo commands --workflows        # Show agent workflow sequences

Exit Codes:
  0   Success
  2   Invalid input/arguments
  3   File read error (COMMANDS-INDEX.json not found)

Output (JSON):
  Returns commands array with metadata envelope per LLM-AGENT-FIRST-SPEC.
  Filter results without jq using --category and --relevance flags.
EOF
}

# ============================================================================
# ARGUMENT PARSING
# ============================================================================

while [[ $# -gt 0 ]]; do
    case "$1" in
        -f|--format)
            FORMAT="$2"
            shift 2
            ;;
        --json)
            FORMAT="json"
            shift
            ;;
        --human)
            FORMAT="text"
            shift
            ;;
        -q|--quiet)
            QUIET=true
            shift
            ;;
        -c|--category)
            FILTER_CATEGORY="$2"
            shift 2
            ;;
        -r|--relevance)
            FILTER_RELEVANCE="$2"
            shift 2
            ;;
        --workflows)
            SHOW_WORKFLOWS=true
            shift
            ;;
        --lookup)
            SHOW_LOOKUP=true
            shift
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        -*)
            output_error "E_INPUT_INVALID" "Unknown option: $1" $EXIT_INVALID_INPUT true \
                "Run 'cleo commands --help' for usage"
            exit $EXIT_INVALID_INPUT
            ;;
        *)
            # Positional argument - command name filter
            COMMAND_NAME_FILTER="$1"
            shift
            ;;
    esac
done

# Resolve format (TTY-aware auto-detection)
FORMAT=$(resolve_format "$FORMAT")

# ============================================================================
# VALIDATION
# ============================================================================

# Check commands index exists
if [[ -z "$COMMANDS_INDEX" ]] || [[ ! -f "$COMMANDS_INDEX" ]]; then
    output_error "E_FILE_NOT_FOUND" "COMMANDS-INDEX.json not found" $EXIT_FILE_ERROR false \
        "Reinstall cleo or check CLEO_HOME"
    exit $EXIT_FILE_ERROR
fi

# Validate category filter
if [[ -n "$FILTER_CATEGORY" ]]; then
    case "$FILTER_CATEGORY" in
        write|read|sync|maintenance) ;;
        *)
            output_error "E_INPUT_INVALID" "Invalid category: $FILTER_CATEGORY" $EXIT_INVALID_INPUT true \
                "Valid categories: write, read, sync, maintenance"
            exit $EXIT_INVALID_INPUT
            ;;
    esac
fi

# Validate relevance filter
if [[ -n "$FILTER_RELEVANCE" ]]; then
    case "$FILTER_RELEVANCE" in
        critical|high|medium|low) ;;
        *)
            output_error "E_INPUT_INVALID" "Invalid relevance: $FILTER_RELEVANCE" $EXIT_INVALID_INPUT true \
                "Valid levels: critical, high, medium, low"
            exit $EXIT_INVALID_INPUT
            ;;
    esac
fi

# ============================================================================
# MAIN LOGIC
# ============================================================================

TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Build jq filter based on options
build_jq_filter() {
    local filter=".commands"

    # Filter by category
    if [[ -n "$FILTER_CATEGORY" ]]; then
        filter="$filter | map(select(.category == \"$FILTER_CATEGORY\"))"
    fi

    # Filter by relevance
    if [[ -n "$FILTER_RELEVANCE" ]]; then
        filter="$filter | map(select(.agentRelevance == \"$FILTER_RELEVANCE\"))"
    fi

    # Filter by command name
    if [[ -n "$COMMAND_NAME_FILTER" ]]; then
        filter="$filter | map(select(.name == \"$COMMAND_NAME_FILTER\"))"
    fi

    echo "$filter"
}

# Get filtered commands
get_commands() {
    local filter
    filter=$(build_jq_filter)
    jq -c "$filter" "$COMMANDS_INDEX"
}

# Output JSON format
output_json() {
    local commands
    commands=$(get_commands)
    local count
    count=$(echo "$commands" | jq 'length')

    # Check if filtering for specific command that doesn't exist
    if [[ -n "$COMMAND_NAME_FILTER" ]] && [[ "$count" -eq 0 ]]; then
        output_error "E_NOT_FOUND" "Command not found: $COMMAND_NAME_FILTER" $EXIT_NOT_FOUND true \
            "Run 'cleo commands' to see available commands"
        exit $EXIT_NOT_FOUND
    fi

    # Build output based on what was requested
    if [[ "$SHOW_WORKFLOWS" == true ]]; then
        jq -n \
            --arg schema "https://cleo-dev.com/schemas/v1/output.schema.json" \
            --arg version "${CLEO_VERSION:-$(get_version)}" \
            --arg cmd "$COMMAND_NAME" \
            --arg ts "$TIMESTAMP" \
            --slurpfile index "$COMMANDS_INDEX" \
            '{
                "$schema": $schema,
                "_meta": {
                    "format": "json",
                    "version": $version,
                    "command": $cmd,
                    "timestamp": $ts
                },
                "success": true,
                "workflows": $index[0].agentWorkflows
            }'
    elif [[ "$SHOW_LOOKUP" == true ]]; then
        jq -n \
            --arg schema "https://cleo-dev.com/schemas/v1/output.schema.json" \
            --arg version "${CLEO_VERSION:-$(get_version)}" \
            --arg cmd "$COMMAND_NAME" \
            --arg ts "$TIMESTAMP" \
            --slurpfile index "$COMMANDS_INDEX" \
            '{
                "$schema": $schema,
                "_meta": {
                    "format": "json",
                    "version": $version,
                    "command": $cmd,
                    "timestamp": $ts
                },
                "success": true,
                "quickLookup": $index[0].quickLookup
            }'
    elif [[ -n "$COMMAND_NAME_FILTER" ]]; then
        # Single command detail
        jq -n \
            --arg schema "https://cleo-dev.com/schemas/v1/output.schema.json" \
            --arg version "${CLEO_VERSION:-$(get_version)}" \
            --arg cmd "$COMMAND_NAME" \
            --arg ts "$TIMESTAMP" \
            --argjson commands "$commands" \
            '{
                "$schema": $schema,
                "_meta": {
                    "format": "json",
                    "version": $version,
                    "command": $cmd,
                    "timestamp": $ts
                },
                "success": true,
                "command": $commands[0]
            }'
    else
        # Full commands list
        jq -n \
            --arg schema "https://cleo-dev.com/schemas/v1/output.schema.json" \
            --arg version "${CLEO_VERSION:-$(get_version)}" \
            --arg cmd "$COMMAND_NAME" \
            --arg ts "$TIMESTAMP" \
            --argjson count "$count" \
            --argjson commands "$commands" \
            --arg cat "${FILTER_CATEGORY:-all}" \
            --arg rel "${FILTER_RELEVANCE:-all}" \
            '{
                "$schema": $schema,
                "_meta": {
                    "format": "json",
                    "version": $version,
                    "command": $cmd,
                    "timestamp": $ts
                },
                "success": true,
                "summary": {
                    "totalCommands": $count,
                    "categoryFilter": $cat,
                    "relevanceFilter": $rel
                },
                "commands": $commands
            }'
    fi
}

# Output text format (human-readable)
output_text() {
    local commands
    commands=$(get_commands)
    local count
    count=$(echo "$commands" | jq 'length')

    # Check if filtering for specific command that doesn't exist
    if [[ -n "$COMMAND_NAME_FILTER" ]] && [[ "$count" -eq 0 ]]; then
        echo "Command not found: $COMMAND_NAME_FILTER" >&2
        echo "Run 'cleo commands' to see available commands" >&2
        exit $EXIT_NOT_FOUND
    fi

    if [[ "$SHOW_WORKFLOWS" == true ]]; then
        echo "Agent Workflows"
        echo "==============="
        jq -r '.agentWorkflows | to_entries[] | "\(.key):\n  " + (.value | join("\n  "))' "$COMMANDS_INDEX"
    elif [[ "$SHOW_LOOKUP" == true ]]; then
        echo "Quick Lookup (Intent → Command)"
        echo "================================"
        jq -r '.quickLookup | to_entries[] | "  \(.key) → \(.value)"' "$COMMANDS_INDEX"
    elif [[ -n "$COMMAND_NAME_FILTER" ]]; then
        # Single command detail
        echo "$commands" | jq -r '.[0] | "
Command: \(.name)
Script:  \(.script)
Category: \(.category)
Relevance: \(.agentRelevance)
Doc: \(.doc)

Synopsis: \(.synopsis)

Flags: \(.flags | join(", "))
Exit Codes: \(.exitCodes | map(tostring) | join(", "))
\(if .subcommands then "Subcommands: " + (.subcommands | join(", ")) else "" end)
\(if .aliases then "Aliases: " + (.aliases | join(", ")) else "" end)
\(if .note then "Note: " + .note else "" end)"'
    else
        # List all commands
        [[ "$QUIET" != true ]] && echo "Commands ($count total)"
        [[ "$QUIET" != true ]] && echo "========================"
        echo ""

        # Group by category
        for cat in write read sync maintenance; do
            local cat_commands
            cat_commands=$(echo "$commands" | jq -c "[.[] | select(.category == \"$cat\")]")
            local cat_count
            cat_count=$(echo "$cat_commands" | jq 'length')

            if [[ "$cat_count" -gt 0 ]]; then
                echo "[$cat] ($cat_count)"
                echo "$cat_commands" | jq -r '.[] | "  \(.name | . + " " * (14 - length)) \(.synopsis[0:60])\(if (.synopsis | length) > 60 then "..." else "" end)"'
                echo ""
            fi
        done

        [[ "$QUIET" != true ]] && echo "Use 'cleo commands <name>' for details"
        [[ "$QUIET" != true ]] && echo "Use 'cleo commands --workflows' for agent sequences"
    fi
}

# Main output dispatch
case "$FORMAT" in
    json)
        output_json
        ;;
    text)
        output_text
        ;;
    *)
        # Default to JSON for non-TTY (LLM-AGENT-FIRST compliance)
        output_json
        ;;
esac

exit $EXIT_SUCCESS
