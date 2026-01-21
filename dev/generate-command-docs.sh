#!/usr/bin/env bash
#
# generate-command-docs.sh - Generate Mintlify MDX documentation from COMMANDS-INDEX.json
#
# USAGE:
#   ./dev/generate-command-docs.sh [OPTIONS]
#
# OPTIONS:
#   --dry-run       Preview changes without writing files
#   --single CMD    Generate docs for single command only
#   --force         Overwrite existing documentation files
#   --update-nav    Update docs.json navigation entries
#   --verbose       Show detailed output
#   --help          Show this help message
#
# OUTPUT:
#   Creates/updates MDX files in docs/commands/
#   Optionally updates docs/docs.json navigation
#
# EXAMPLES:
#   ./dev/generate-command-docs.sh --dry-run          # Preview all changes
#   ./dev/generate-command-docs.sh --single add       # Generate only add.md
#   ./dev/generate-command-docs.sh --force            # Regenerate all docs
#   ./dev/generate-command-docs.sh --update-nav      # Also update docs.json
#
# AUTHOR: CLEO Documentation System
# VERSION: 1.0.0

set -euo pipefail

# ==============================================================================
# Configuration
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMANDS_INDEX="$PROJECT_ROOT/docs/commands/COMMANDS-INDEX.json"
OUTPUT_DIR="$PROJECT_ROOT/docs/commands"
DOCS_JSON="$PROJECT_ROOT/docs/docs.json"

# Flags
DRY_RUN=false
SINGLE_CMD=""
FORCE=false
UPDATE_NAV=false
VERBOSE=false

# Icons by category (Mintlify icon names)
declare -A CATEGORY_ICONS=(
    ["write"]="pencil"
    ["read"]="eye"
    ["sync"]="arrows-rotate"
    ["maintenance"]="wrench"
)

# Icons by specific command (overrides category default)
declare -A COMMAND_ICONS=(
    ["add"]="plus"
    ["complete"]="check"
    ["delete"]="trash"
    ["update"]="pen"
    ["find"]="magnifying-glass"
    ["search"]="magnifying-glass"
    ["list"]="list"
    ["show"]="file"
    ["analyze"]="chart-line"
    ["dash"]="gauge"
    ["next"]="forward"
    ["blockers"]="ban"
    ["deps"]="diagram-project"
    ["session"]="clock"
    ["focus"]="crosshairs"
    ["context"]="microchip"
    ["phase"]="flag"
    ["phases"]="flag-checkered"
    ["labels"]="tags"
    ["validate"]="shield-check"
    ["backup"]="floppy-disk"
    ["restore"]="rotate-left"
    ["archive"]="box-archive"
    ["upgrade"]="arrow-up"
    ["init"]="play"
    ["config"]="gear"
    ["export"]="file-export"
    ["import-tasks"]="file-import"
    ["export-tasks"]="file-arrow-up"
    ["sync"]="rotate"
    ["research"]="telescope"
    ["history"]="clock-rotate-left"
    ["stats"]="chart-bar"
    ["log"]="scroll"
    ["exists"]="circle-question"
    ["verify"]="badge-check"
    ["reparent"]="sitemap"
    ["promote"]="arrow-up-right-from-square"
    ["reorder"]="sort"
    ["reopen"]="rotate"
    ["uncancel"]="undo"
    ["unarchive"]="box-open"
    ["tree"]="folder-tree"
    ["self-update"]="download"
    ["doctor"]="stethoscope"
    ["migrate"]="database"
    ["commands"]="terminal"
    ["sequence"]="hashtag"
    ["roadmap"]="road"
)

# ==============================================================================
# Functions
# ==============================================================================

log() {
    echo "[INFO] $*" >&2
}

log_verbose() {
    [[ "$VERBOSE" == "true" ]] && echo "[DEBUG] $*" >&2 || true
}

log_error() {
    echo "[ERROR] $*" >&2
}

show_help() {
    sed -n '2,/^# AUTHOR/p' "$0" | sed 's/^# //' | head -n -1
    exit 0
}

get_icon() {
    local cmd="$1"
    local category="$2"

    # Check command-specific icon first
    if [[ -n "${COMMAND_ICONS[$cmd]:-}" ]]; then
        echo "${COMMAND_ICONS[$cmd]}"
        return
    fi

    # Fall back to category icon
    if [[ -n "${CATEGORY_ICONS[$category]:-}" ]]; then
        echo "${CATEGORY_ICONS[$category]}"
        return
    fi

    # Default icon
    echo "terminal"
}

# Generate exit codes table from command data
generate_exit_codes_table() {
    local exit_codes_json="$1"

    # Standard exit code meanings
    declare -A EXIT_CODE_MEANINGS=(
        [0]="Success"
        [1]="General error"
        [2]="Invalid arguments"
        [3]="File operation failure"
        [4]="Resource not found"
        [5]="Missing dependency"
        [6]="Validation error"
        [7]="Lock timeout"
        [8]="Configuration error"
        [10]="Parent task not found"
        [11]="Max depth exceeded"
        [12]="Max siblings exceeded"
        [13]="Invalid parent type"
        [14]="Circular hierarchy"
        [16]="Has children (use --children)"
        [17]="Task completed (use archive)"
        [20]="Checksum mismatch"
        [21]="Sequence corruption"
        [22]="ID collision"
        [40]="Gate not found"
        [41]="Invalid gate value"
        [42]="Gate already set"
        [43]="Missing agent ID"
        [44]="Verification failed"
        [45]="Gate validation error"
        [50]="Context warning (70-84%)"
        [51]="Context caution (85-89%)"
        [52]="Context critical (90-94%)"
        [53]="Context emergency (95%+)"
        [54]="Context stale"
        [100]="No data/results"
        [101]="Already exists"
        [102]="No change needed"
    )

    # Recoverable exit codes
    declare -A RECOVERABLE_CODES=(
        [7]="Yes"
        [20]="Yes"
        [21]="Yes"
        [22]="Yes"
    )

    echo "| Code | Meaning | Recoverable |"
    echo "|------|---------|:-----------:|"

    # Parse exit codes array and generate table rows
    echo "$exit_codes_json" | jq -r '.[]' | while read -r code; do
        local meaning="${EXIT_CODE_MEANINGS[$code]:-Unknown}"
        local recoverable="${RECOVERABLE_CODES[$code]:-No}"
        [[ "$recoverable" == "Yes" ]] && recoverable="**Yes**"
        echo "| \`$code\` | $meaning | $recoverable |"
    done
}

# Generate MDX content for a single command
generate_command_mdx() {
    local cmd_json="$1"
    local cmd_name
    local category
    local synopsis
    local script
    local doc
    local flags_json
    local subcommands_json
    local exit_codes_json
    local aliases_json
    local note
    local json_output
    local json_default
    local agent_relevance
    local icon

    # Extract command data
    cmd_name=$(echo "$cmd_json" | jq -r '.name')
    category=$(echo "$cmd_json" | jq -r '.category // "read"')
    synopsis=$(echo "$cmd_json" | jq -r '.synopsis // ""')
    script=$(echo "$cmd_json" | jq -r '.script // ""')
    doc=$(echo "$cmd_json" | jq -r '.doc // null')
    flags_json=$(echo "$cmd_json" | jq -c '.flags // []')
    subcommands_json=$(echo "$cmd_json" | jq -c '.subcommands // []')
    exit_codes_json=$(echo "$cmd_json" | jq -c '.exitCodes // [0]')
    aliases_json=$(echo "$cmd_json" | jq -c '.aliases // []')
    note=$(echo "$cmd_json" | jq -r '.note // ""')
    json_output=$(echo "$cmd_json" | jq -r '.jsonOutput // false')
    json_default=$(echo "$cmd_json" | jq -r '.jsonDefault // false')
    agent_relevance=$(echo "$cmd_json" | jq -r '.agentRelevance // "medium"')

    # Get icon for command
    icon=$(get_icon "$cmd_name" "$category")

    # Check if this is an alias
    local alias_for
    alias_for=$(echo "$cmd_json" | jq -r '.aliasFor // ""')

    # Build MDX content
    cat << EOF
---
title: "cleo $cmd_name"
description: "$synopsis"
icon: "$icon"
---

# cleo $cmd_name

EOF

    # Add aliases if present
    local aliases_count
    aliases_count=$(echo "$aliases_json" | jq 'length')
    if [[ "$aliases_count" -gt 0 ]]; then
        local aliases_list
        aliases_list=$(echo "$aliases_json" | jq -r 'join(", ")')
        echo "**Aliases**: \`$aliases_list\`"
        echo ""
    fi

    # Add alias notice if this is an alias
    if [[ -n "$alias_for" ]]; then
        echo "<Note>This command is an alias for \`cleo $alias_for\`</Note>"
        echo ""
    fi

    # Synopsis section
    echo "$synopsis"
    echo ""

    # Add note if present
    if [[ -n "$note" ]]; then
        echo "<Tip>$note</Tip>"
        echo ""
    fi

    # Agent relevance badge
    case "$agent_relevance" in
        critical)
            echo "<Info>**Agent Relevance**: Critical - Essential for LLM agent workflows</Info>"
            ;;
        high)
            echo "<Info>**Agent Relevance**: High - Frequently used by LLM agents</Info>"
            ;;
    esac
    echo ""

    # Synopsis code block
    echo "## Synopsis"
    echo ""
    echo "\`\`\`bash"

    # Build usage string
    local usage="cleo $cmd_name"

    # Add subcommands if present
    local subcommands_count
    subcommands_count=$(echo "$subcommands_json" | jq 'length')
    if [[ "$subcommands_count" -gt 0 ]]; then
        local subcommands_list
        subcommands_list=$(echo "$subcommands_json" | jq -r 'join("|")')
        usage="$usage <$subcommands_list>"
    fi

    # Add arguments placeholder based on command type
    case "$cmd_name" in
        add)
            usage="$usage \"TITLE\""
            ;;
        complete|show|exists|delete|reopen|uncancel|unarchive|verify|reparent|promote|reorder)
            usage="$usage TASK_ID"
            ;;
        find|search)
            usage="$usage [QUERY]"
            ;;
        update)
            usage="$usage TASK_ID"
            ;;
    esac

    usage="$usage [OPTIONS]"
    echo "$usage"
    echo "\`\`\`"
    echo ""

    # Subcommands section if present
    if [[ "$subcommands_count" -gt 0 ]]; then
        echo "## Subcommands"
        echo ""
        echo "| Subcommand | Description |"
        echo "|------------|-------------|"
        echo "$subcommands_json" | jq -r '.[]' | while read -r subcmd; do
            echo "| \`$subcmd\` | Run \`cleo $cmd_name $subcmd --help\` for details |"
        done
        echo ""
    fi

    # Options section
    local flags_count
    flags_count=$(echo "$flags_json" | jq 'length')
    if [[ "$flags_count" -gt 0 ]]; then
        echo "## Options"
        echo ""
        echo "| Option | Description |"
        echo "|--------|-------------|"
        echo "$flags_json" | jq -r '.[]' | while read -r flag; do
            # Generate description based on flag name
            local desc=""
            case "$flag" in
                --format) desc="Output format: \`text\`, \`json\`" ;;
                --quiet|-q) desc="Suppress output, return only essential data" ;;
                --json) desc="Force JSON output" ;;
                --human) desc="Force human-readable output" ;;
                --dry-run) desc="Preview changes without applying" ;;
                --force) desc="Force operation without confirmation" ;;
                --verbose) desc="Show detailed output" ;;
                --status) desc="Filter by status" ;;
                --priority) desc="Filter by priority" ;;
                --label) desc="Filter by label" ;;
                --phase) desc="Filter by phase" ;;
                --parent) desc="Filter by parent task ID" ;;
                --children) desc="Handle child tasks" ;;
                --tree) desc="Show hierarchical tree view" ;;
                --include-archive) desc="Include archived tasks in search" ;;
                --help|-h) desc="Show help message" ;;
                --explain) desc="Show reasoning for suggestion" ;;
                --auto-focus) desc="Automatically set focus to result" ;;
                --full) desc="Show comprehensive report" ;;
                --compact) desc="Show condensed output" ;;
                --list) desc="List items" ;;
                --output) desc="Output file path" ;;
                --session) desc="Session ID or scope" ;;
                --reason) desc="Reason for operation (often required)" ;;
                --notes) desc="Add notes to task" ;;
                --cascade) desc="Apply to children recursively" ;;
                --subtree) desc="Include entire subtree" ;;
                --limit) desc="Limit number of results" ;;
                --id) desc="Search by task ID prefix" ;;
                --exact) desc="Exact string matching" ;;
                --field) desc="Search in specific field" ;;
                --analyze) desc="Run analysis" ;;
                --all) desc="Apply to all items" ;;
                --gate) desc="Verification gate name" ;;
                --value) desc="Gate value" ;;
                --agent) desc="Agent identifier" ;;
                --reset) desc="Reset to default state" ;;
                --to) desc="Target parent ID" ;;
                --position) desc="New position index" ;;
                --before) desc="Insert before task ID" ;;
                --after) desc="Insert after task ID" ;;
                --top) desc="Move to top of list" ;;
                --bottom) desc="Move to bottom of list" ;;
                --no-type-update) desc="Don't update task type automatically" ;;
                --skip-notes) desc="Skip notes requirement" ;;
                --skip-reason) desc="Skip reason requirement" ;;
                --check) desc="Check status without making changes" ;;
                --fix) desc="Attempt automatic fixes" ;;
                --prune) desc="Remove stale entries" ;;
                --global) desc="Apply to global configuration" ;;
                --project) desc="Apply to project only" ;;
                --destination) desc="Target destination path" ;;
                --detect) desc="Detect issues" ;;
                --run) desc="Execute migration" ;;
                --days) desc="Number of days to include" ;;
                --since) desc="Start date for filter" ;;
                --period) desc="Time period for statistics" ;;
                --operation) desc="Filter by operation type" ;;
                --task) desc="Filter by task ID" ;;
                --type) desc="Filter by task type" ;;
                --depth) desc="Depth level for search/display" ;;
                --url) desc="URL to fetch" ;;
                --reddit) desc="Search Reddit discussions" ;;
                --library) desc="Library documentation lookup" ;;
                --topic) desc="Topic for research" ;;
                --subreddit) desc="Specific subreddit to search" ;;
                --include-reddit) desc="Include Reddit in search" ;;
                --link-task) desc="Link research to task" ;;
                --plan-only) desc="Show plan without executing" ;;
                --filter) desc="Filter expression" ;;
                --include-deps) desc="Include dependencies" ;;
                --interactive) desc="Interactive mode" ;;
                --on-duplicate) desc="Handle duplicate entries" ;;
                --on-missing-dep) desc="Handle missing dependencies" ;;
                --on-phase-mismatch) desc="Handle phase mismatches" ;;
                --add-label) desc="Add label to imported tasks" ;;
                --inject) desc="Inject tasks for TodoWrite" ;;
                --extract) desc="Extract from TodoWrite" ;;
                --focused-only) desc="Only process focused task" ;;
                --preserve-status) desc="Keep original status" ;;
                --confirm-wipe) desc="Confirm destructive operation" ;;
                --history) desc="Include history" ;;
                --related) desc="Show related items" ;;
                --version) desc="Specific version" ;;
                --verification-status) desc="Filter by verification status" ;;
                --verification) desc="Show verification details" ;;
                *) desc="See \`cleo $cmd_name --help\` for details" ;;
            esac
            echo "| \`$flag\` | $desc |"
        done
        echo ""
    fi

    # JSON output notice
    if [[ "$json_default" == "true" ]]; then
        echo "<Note>**Default output is JSON** for LLM agent consumption. Use \`--human\` for human-readable output.</Note>"
        echo ""
    elif [[ "$json_output" == "true" ]]; then
        echo "<Note>This command supports JSON output via \`--json\` flag for LLM agent integration.</Note>"
        echo ""
    fi

    # Examples section (basic template)
    echo "## Examples"
    echo ""
    echo "<CodeGroup>"
    echo ""
    echo "\`\`\`bash Basic Usage"
    echo "cleo $cmd_name"
    echo "\`\`\`"
    echo ""
    if [[ "$json_output" == "true" ]]; then
        echo "\`\`\`bash JSON Output"
        echo "cleo $cmd_name --json"
        echo "\`\`\`"
        echo ""
    fi
    echo "</CodeGroup>"
    echo ""

    # Exit codes section
    echo "## Exit Codes"
    echo ""
    generate_exit_codes_table "$exit_codes_json"
    echo ""

    # See Also section
    echo "## See Also"
    echo ""
    echo "- [Commands Index](/commands/commands) - Full command reference"

    # Add related commands based on category
    case "$category" in
        write)
            [[ "$cmd_name" != "add" ]] && echo "- [add](/commands/add) - Create new tasks"
            [[ "$cmd_name" != "update" ]] && echo "- [update](/commands/update) - Modify tasks"
            [[ "$cmd_name" != "complete" ]] && echo "- [complete](/commands/complete) - Mark tasks done"
            ;;
        read)
            [[ "$cmd_name" != "list" ]] && echo "- [list](/commands/list) - View tasks"
            [[ "$cmd_name" != "show" ]] && echo "- [show](/commands/show) - Task details"
            [[ "$cmd_name" != "find" ]] && echo "- [find](/commands/find) - Search tasks"
            ;;
        maintenance)
            [[ "$cmd_name" != "validate" ]] && echo "- [validate](/commands/validate) - Check integrity"
            [[ "$cmd_name" != "backup" ]] && echo "- [backup](/commands/backup) - Create backups"
            ;;
    esac
    echo ""
}

# Process all commands from COMMANDS-INDEX.json
process_commands() {
    log "Reading commands from $COMMANDS_INDEX"

    # Validate index file exists
    if [[ ! -f "$COMMANDS_INDEX" ]]; then
        log_error "COMMANDS-INDEX.json not found at $COMMANDS_INDEX"
        exit 1
    fi

    local total_commands
    total_commands=$(jq '.commands | length' "$COMMANDS_INDEX")
    log "Found $total_commands commands to process"

    local generated=0
    local skipped=0
    local updated=0

    # Process each command
    jq -c '.commands[]' "$COMMANDS_INDEX" | while read -r cmd_json; do
        local cmd_name
        local existing_doc
        local output_file

        cmd_name=$(echo "$cmd_json" | jq -r '.name')
        existing_doc=$(echo "$cmd_json" | jq -r '.doc // null')
        output_file="$OUTPUT_DIR/${cmd_name}.mdx"

        # Filter for single command if specified
        if [[ -n "$SINGLE_CMD" && "$cmd_name" != "$SINGLE_CMD" ]]; then
            continue
        fi

        log_verbose "Processing command: $cmd_name"

        # Check if existing doc already exists and is not auto-generated
        if [[ -f "$OUTPUT_DIR/${cmd_name}.md" && "$FORCE" != "true" ]]; then
            # Check if file has custom content (not auto-generated)
            # Support both old HTML and new JSX comment formats
            if ! grep -qE "(<!-- AUTO-GENERATED -->|\{/\* AUTO-GENERATED)" "$OUTPUT_DIR/${cmd_name}.md" 2>/dev/null; then
                log_verbose "Skipping $cmd_name - existing manual documentation"
                ((skipped++)) || true
                continue
            fi
        fi

        # Generate MDX content
        local mdx_content
        mdx_content=$(generate_command_mdx "$cmd_json")

        # Add auto-generated marker AFTER frontmatter (MDX requires frontmatter first)
        # Insert JSX comment after the closing --- of frontmatter
        mdx_content=$(echo "$mdx_content" | awk '
            /^---$/ && NR > 1 && !done {
                print $0
                print ""
                print "{/* AUTO-GENERATED by generate-command-docs.sh - DO NOT EDIT MANUALLY */}"
                done = 1
                next
            }
            { print }
        ')

        if [[ "$DRY_RUN" == "true" ]]; then
            log "[DRY-RUN] Would write: $output_file"
            echo "--- Preview: $cmd_name ---"
            echo "$mdx_content" | head -50
            echo "..."
            echo ""
        else
            echo "$mdx_content" > "$output_file"
            log "Generated: $output_file"
            ((generated++)) || true
        fi
    done

    log "Processing complete: $generated generated, $skipped skipped"
}

# Update docs.json navigation
update_navigation() {
    if [[ "$UPDATE_NAV" != "true" ]]; then
        return
    fi

    log "Updating docs.json navigation..."

    # This is a complex operation - generate a list of commands by category
    # and suggest additions to docs.json

    local write_cmds read_cmds sync_cmds maint_cmds
    write_cmds=$(jq -r '.commands[] | select(.category=="write") | .name' "$COMMANDS_INDEX" | sort)
    read_cmds=$(jq -r '.commands[] | select(.category=="read") | .name' "$COMMANDS_INDEX" | sort)
    sync_cmds=$(jq -r '.commands[] | select(.category=="sync") | .name' "$COMMANDS_INDEX" | sort)
    maint_cmds=$(jq -r '.commands[] | select(.category=="maintenance") | .name' "$COMMANDS_INDEX" | sort)

    echo ""
    echo "=== Suggested docs.json Updates ==="
    echo ""
    echo "Write Commands: $write_cmds"
    echo "Read Commands: $read_cmds"
    echo "Sync Commands: $sync_cmds"
    echo "Maintenance Commands: $maint_cmds"
    echo ""
    echo "Add these entries to docs/docs.json navigation as needed."
}

# ==============================================================================
# Main
# ==============================================================================

main() {
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            --single)
                SINGLE_CMD="$2"
                shift 2
                ;;
            --force)
                FORCE=true
                shift
                ;;
            --update-nav)
                UPDATE_NAV=true
                shift
                ;;
            --verbose)
                VERBOSE=true
                shift
                ;;
            --help|-h)
                show_help
                ;;
            *)
                log_error "Unknown option: $1"
                show_help
                ;;
        esac
    done

    log "CLEO Command Documentation Generator v1.0.0"
    log "Project root: $PROJECT_ROOT"

    # Verify jq is available
    if ! command -v jq &>/dev/null; then
        log_error "jq is required but not installed"
        exit 1
    fi

    # Process commands
    process_commands

    # Update navigation if requested
    update_navigation

    log "Done."
}

main "$@"
