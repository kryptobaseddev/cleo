#!/usr/bin/env bash

#####################################################################
# roadmap.sh - Roadmap Generation Command for CLEO
#
# Generate roadmap from existing CLEO data:
# - Parse pending epics grouped by priority/phase
# - Parse CHANGELOG.md for completed releases
# - Read VERSION file for current version
#
# Usage:
#   roadmap.sh [OPTIONS]
#
# Options:
#   --format FORMAT   Output format: text | json | markdown (default: text)
#   --json            Shortcut for --format json
#   --human           Shortcut for --format text
#   --include-history Include release history from CHANGELOG
#   --upcoming-only   Only show upcoming/planned releases
#   -h, --help        Show this help message
#
# Examples:
#   cleo roadmap                           # Text format roadmap
#   cleo roadmap --format json             # JSON output
#   cleo roadmap --format markdown         # Markdown for ROADMAP.md
#   cleo roadmap --upcoming-only           # Only future releases
#
# Version: 0.1.0
# Part of: cleo CLI - Release Management (T1165, T1166)
#####################################################################

set -euo pipefail

# Script and library paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Source version from central location
if [[ -f "$CLEO_HOME/VERSION" ]]; then
    VERSION="$(cat "$CLEO_HOME/VERSION" | tr -d '[:space:]')"
elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
    VERSION="$(cat "$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')"
else
    VERSION="unknown"
fi

# Source library functions
source_lib() {
    local lib_name="$1"
    if [[ -f "${LIB_DIR}/${lib_name}" ]]; then
        source "${LIB_DIR}/${lib_name}"
    elif [[ -f "$CLEO_HOME/lib/${lib_name}" ]]; then
        source "$CLEO_HOME/lib/${lib_name}"
    fi
}

source_lib "file-ops.sh"
source_lib "logging.sh"
source_lib "output-format.sh"
source_lib "error-json.sh"
source_lib "jq-helpers.sh"
source_lib "flags.sh"

# Default configuration
COMMAND_NAME="roadmap"
INCLUDE_HISTORY=false
UPCOMING_ONLY=false
OUTPUT_FILE=""

# Initialize flag defaults
init_flag_defaults 2>/dev/null || true

# File paths
CLEO_DIR=".cleo"
TODO_FILE="${TODO_FILE:-${CLEO_DIR}/todo.json}"
CHANGELOG_FILE="CHANGELOG.md"
VERSION_FILE="VERSION"

#####################################################################
# Usage
#####################################################################

usage() {
    cat << 'EOF'
Usage: cleo roadmap [OPTIONS]

Generate roadmap from CLEO task data and CHANGELOG.

Options:
    --format, -f FORMAT   Output format: text | json | markdown (default: text)
    --json                Shortcut for --format json
    --human               Shortcut for --format text
    --output, -o PATH     Write to file instead of stdout
    --include-history     Include release history from CHANGELOG
    --upcoming-only       Only show upcoming/planned releases (epics)
    -h, --help            Show this help message

Output:
    Generates a roadmap showing:
    - Current version (from VERSION file)
    - Upcoming releases (pending epics grouped by priority/phase)
    - Release history (from CHANGELOG.md, if --include-history)

Examples:
    cleo roadmap                           # Text format
    cleo roadmap --format json             # JSON output
    cleo roadmap --format markdown         # Markdown to stdout
    cleo roadmap -o docs/ROADMAP.md        # Write markdown to file
    cleo roadmap --upcoming-only           # Only future releases

EOF
    exit "${EXIT_SUCCESS:-0}"
}

#####################################################################
# Color and Unicode Detection
#####################################################################

if declare -f should_use_color >/dev/null 2>&1 && should_use_color; then
    COLORS_ENABLED=true
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    MAGENTA='\033[0;35m'
    CYAN='\033[0;36m'
    BOLD='\033[1m'
    DIM='\033[2m'
    NC='\033[0m'
else
    COLORS_ENABLED=false
    RED='' GREEN='' YELLOW='' BLUE='' MAGENTA='' CYAN='' BOLD='' DIM='' NC=''
fi

if declare -f supports_unicode >/dev/null 2>&1 && supports_unicode; then
    UNICODE_ENABLED=true
    PROGRESS_FULL="█"
    PROGRESS_EMPTY="░"
    TREE_BRANCH="├──"
    TREE_LAST="└──"
    TREE_VERT="│"
    CHECK_MARK="✓"
    CROSS_MARK="✗"
    BULLET="•"
else
    UNICODE_ENABLED=false
    PROGRESS_FULL="#"
    PROGRESS_EMPTY="-"
    TREE_BRANCH="|--"
    TREE_LAST="\`--"
    TREE_VERT="|"
    CHECK_MARK="[x]"
    CROSS_MARK="[!]"
    BULLET="*"
fi

#####################################################################
# Argument Parsing
#####################################################################

parse_args() {
    # Parse common flags first (if flags.sh was sourced successfully)
    if declare -f parse_common_flags &>/dev/null; then
        parse_common_flags "$@"
        set -- "${REMAINING_ARGS[@]}"

        # Bridge to legacy variables
        apply_flags_to_globals
        FORMAT=$(resolve_format "$FORMAT")

        # Handle help flag
        if [[ "$FLAG_HELP" == true ]]; then
            usage
        fi
    fi

    # Parse command-specific arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -o|--output)
                shift
                OUTPUT_FILE="$1"
                ;;
            --include-history)
                INCLUDE_HISTORY=true
                ;;
            --upcoming-only)
                UPCOMING_ONLY=true
                ;;
            -*)
                echo "Unknown option: $1" >&2
                usage
                ;;
            *)
                shift
                continue
                ;;
        esac
        shift
    done

    # Auto-detect format based on TTY or output file
    if [[ -z "$FORMAT" ]]; then
        if [[ -n "$OUTPUT_FILE" ]]; then
            # Default to markdown when writing to file
            FORMAT="markdown"
        elif [[ -t 1 ]]; then
            FORMAT="human"
        else
            FORMAT="json"
        fi
    fi
}

#####################################################################
# Data Extraction Functions
#####################################################################

# Get current version from VERSION file
get_current_version() {
    if [[ -f "$VERSION_FILE" ]]; then
        cat "$VERSION_FILE" | tr -d '[:space:]'
    elif [[ -f "$CLEO_HOME/VERSION" ]]; then
        cat "$CLEO_HOME/VERSION" | tr -d '[:space:]'
    else
        echo "unknown"
    fi
}

# Parse pending epics from todo.json
# Returns JSON array of epics with progress info
get_pending_epics() {
    if [[ ! -f "$TODO_FILE" ]]; then
        echo "[]"
        return
    fi

    jq -r '
        .tasks
        | map(select(.type == "epic" and .status != "done" and .status != "cancelled"))
        | sort_by(
            (if .priority == "critical" then 0
             elif .priority == "high" then 1
             elif .priority == "medium" then 2
             else 3 end),
            (if .phase == "setup" then 0
             elif .phase == "core" then 1
             elif .phase == "testing" then 2
             elif .phase == "polish" then 3
             elif .phase == "maintenance" then 4
             else 5 end)
        )
        | map({
            id: .id,
            title: .title,
            description: .description,
            status: .status,
            priority: .priority,
            phase: .phase,
            labels: .labels,
            epicLifecycle: .epicLifecycle
        })
    ' "$TODO_FILE"
}

# Get child tasks for an epic and calculate progress
get_epic_progress() {
    local epic_id="$1"

    if [[ ! -f "$TODO_FILE" ]]; then
        echo '{"total": 0, "done": 0, "percent": 0}'
        return
    fi

    jq -r --arg epic_id "$epic_id" '
        .tasks
        | map(select(.parentId == $epic_id))
        | {
            total: length,
            done: map(select(.status == "done")) | length
        }
        | .percent = (if .total > 0 then ((.done / .total) * 100 | floor) else 0 end)
    ' "$TODO_FILE"
}

# Parse CHANGELOG.md for release history
# Returns JSON array of releases
parse_changelog() {
    if [[ ! -f "$CHANGELOG_FILE" ]]; then
        echo "[]"
        return
    fi

    # Parse changelog headers: ## [version] - date
    local releases="[]"
    local current_version=""
    local current_date=""
    local in_section=false

    while IFS= read -r line; do
        # Match release header: ## [0.43.0] - 2026-01-01
        if [[ "$line" =~ ^##\ \[([0-9]+\.[0-9]+\.[0-9]+)\]\ -\ ([0-9]{4}-[0-9]{2}-[0-9]{2}) ]]; then
            current_version="${BASH_REMATCH[1]}"
            current_date="${BASH_REMATCH[2]}"
            releases=$(echo "$releases" | jq --arg v "$current_version" --arg d "$current_date" \
                '. + [{version: $v, date: $d, type: "released"}]')
        fi
    done < "$CHANGELOG_FILE"

    echo "$releases"
}

#####################################################################
# Output Formatting Functions
#####################################################################

# Generate progress bar
make_progress_bar() {
    local percent="${1:-0}"
    local width="${2:-20}"
    local filled=$((percent * width / 100))
    local empty=$((width - filled))
    local bar=""

    for ((i = 0; i < filled; i++)); do
        bar+="$PROGRESS_FULL"
    done
    for ((i = 0; i < empty; i++)); do
        bar+="$PROGRESS_EMPTY"
    done

    echo "$bar"
}

# Format priority for display
format_priority_display() {
    local priority="$1"
    case "$priority" in
        critical) echo -e "${RED}critical${NC}" ;;
        high)     echo -e "${YELLOW}high${NC}" ;;
        medium)   echo -e "${BLUE}medium${NC}" ;;
        low)      echo -e "${DIM}low${NC}" ;;
        *)        echo "$priority" ;;
    esac
}

# Output text format
output_text() {
    local current_version="$1"
    local epics_json="$2"
    local history_json="$3"

    echo -e "${BOLD}ROADMAP${NC}"
    echo "═══════════════════════════════════════════════════════════════════════════════"
    echo ""
    echo -e "${DIM}Current Version:${NC} v${current_version}"
    echo ""

    # Upcoming releases (pending epics)
    local epic_count
    epic_count=$(echo "$epics_json" | jq 'length')

    if [[ "$epic_count" -gt 0 ]]; then
        echo -e "${BOLD}UPCOMING${NC}"
        echo "───────────────────────────────────────────────────────────────────────────────"

        echo "$epics_json" | jq -r '.[] | @base64' | while read -r encoded; do
            local epic
            epic=$(echo "$encoded" | base64 -d)

            local id title status priority phase
            id=$(echo "$epic" | jq -r '.id')
            title=$(echo "$epic" | jq -r '.title')
            status=$(echo "$epic" | jq -r '.status')
            priority=$(echo "$epic" | jq -r '.priority // "medium"')
            phase=$(echo "$epic" | jq -r '.phase // "core"')

            # Get progress
            local progress
            progress=$(get_epic_progress "$id")
            local total done percent
            total=$(echo "$progress" | jq -r '.total')
            done=$(echo "$progress" | jq -r '.done')
            percent=$(echo "$progress" | jq -r '.percent')

            local bar
            bar=$(make_progress_bar "$percent")

            # Format output
            printf "\n${CYAN}%s${NC}: %s\n" "$id" "$title"
            printf "  ${DIM}Phase:${NC} %-12s ${DIM}Priority:${NC} %s\n" "$phase" "$priority"
            printf "  ${DIM}Progress:${NC} [%s] %3d%% (%d/%d tasks)\n" "$bar" "$percent" "$done" "$total"
        done
        echo ""
    else
        echo -e "${DIM}No pending epics found.${NC}"
        echo ""
    fi

    # Release history
    if [[ "$INCLUDE_HISTORY" == "true" && "$UPCOMING_ONLY" != "true" ]]; then
        local history_count
        history_count=$(echo "$history_json" | jq 'length')

        if [[ "$history_count" -gt 0 ]]; then
            echo -e "${BOLD}RELEASE HISTORY${NC}"
            echo "───────────────────────────────────────────────────────────────────────────────"

            echo "$history_json" | jq -r '.[] | "v\(.version) - \(.date)"' | head -10

            if [[ "$history_count" -gt 10 ]]; then
                echo -e "${DIM}... and $((history_count - 10)) more releases${NC}"
            fi
            echo ""
        fi
    fi
}

# Output JSON format
output_json() {
    local current_version="$1"
    local epics_json="$2"
    local history_json="$3"

    # Build epics with progress
    local epics_with_progress="[]"
    local epic_count
    epic_count=$(echo "$epics_json" | jq 'length')

    if [[ "$epic_count" -gt 0 ]]; then
        for i in $(seq 0 $((epic_count - 1))); do
            local epic
            epic=$(echo "$epics_json" | jq ".[$i]")
            local id
            id=$(echo "$epic" | jq -r '.id')
            local progress
            progress=$(get_epic_progress "$id")

            epic=$(echo "$epic" | jq --argjson prog "$progress" '. + {progress: $prog}')
            epics_with_progress=$(echo "$epics_with_progress" | jq --argjson e "$epic" '. + [$e]')
        done
    fi

    # Build output object
    local output
    output=$(jq -n \
        --arg version "$current_version" \
        --argjson upcoming "$epics_with_progress" \
        --argjson history "$history_json" \
        --argjson include_history "$INCLUDE_HISTORY" \
        '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
                "format": "json",
                "command": "roadmap",
                "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ")),
                "version": $version
            },
            "success": true,
            "currentVersion": ("v" + $version),
            "upcoming": {
                "count": ($upcoming | length),
                "epics": $upcoming
            }
        }
        + if $include_history then {
            "history": {
                "count": ($history | length),
                "releases": $history
            }
        } else {} end
    ')

    echo "$output"
}

# Output markdown format
output_markdown() {
    local current_version="$1"
    local epics_json="$2"
    local history_json="$3"

    echo "# Roadmap"
    echo ""
    echo "> Auto-generated from CLEO task data. Current version: v${current_version}"
    echo ""
    echo "---"
    echo ""

    # Upcoming releases
    local epic_count
    epic_count=$(echo "$epics_json" | jq 'length')

    if [[ "$epic_count" -gt 0 ]]; then
        echo "## Upcoming"
        echo ""

        # Group by priority
        local priorities=("critical" "high" "medium" "low")
        for priority in "${priorities[@]}"; do
            local priority_epics
            priority_epics=$(echo "$epics_json" | jq --arg p "$priority" '[.[] | select(.priority == $p)]')
            local count
            count=$(echo "$priority_epics" | jq 'length')

            if [[ "$count" -gt 0 ]]; then
                local priority_label
                case "$priority" in
                    critical) priority_label="Critical Priority" ;;
                    high) priority_label="High Priority" ;;
                    medium) priority_label="Medium Priority" ;;
                    low) priority_label="Low Priority" ;;
                esac

                echo "### ${priority_label}"
                echo ""

                echo "$priority_epics" | jq -r '.[] | @base64' | while read -r encoded; do
                    local epic
                    epic=$(echo "$encoded" | base64 -d)

                    local id title description phase
                    id=$(echo "$epic" | jq -r '.id')
                    title=$(echo "$epic" | jq -r '.title')
                    description=$(echo "$epic" | jq -r '.description // ""')
                    phase=$(echo "$epic" | jq -r '.phase // "core"')

                    # Get progress
                    local progress
                    progress=$(get_epic_progress "$id")
                    local total done percent
                    total=$(echo "$progress" | jq -r '.total')
                    done=$(echo "$progress" | jq -r '.done')
                    percent=$(echo "$progress" | jq -r '.percent')

                    # Clean title (remove "EPIC: " prefix if present)
                    title="${title#EPIC: }"

                    echo "#### ${id}: ${title}"
                    echo ""
                    echo "**Phase**: ${phase} | **Progress**: ${percent}% (${done}/${total} tasks)"
                    echo ""
                    if [[ -n "$description" && "$description" != "null" ]]; then
                        echo "$description"
                        echo ""
                    fi
                done
            fi
        done
    else
        echo "## Upcoming"
        echo ""
        echo "*No pending epics found.*"
        echo ""
    fi

    # Release history
    if [[ "$INCLUDE_HISTORY" == "true" && "$UPCOMING_ONLY" != "true" ]]; then
        local history_count
        history_count=$(echo "$history_json" | jq 'length')

        if [[ "$history_count" -gt 0 ]]; then
            echo "---"
            echo ""
            echo "## Release History"
            echo ""
            echo "| Version | Date |"
            echo "|---------|------|"
            echo "$history_json" | jq -r '.[] | "| v\(.version) | \(.date) |"' | head -15
            echo ""
        fi
    fi

    echo "---"
    echo ""
    echo "*Generated by \`cleo roadmap\` on $(date -u +%Y-%m-%d)*"
}

#####################################################################
# Main
#####################################################################

main() {
    parse_args "$@"

    # Verify cleo directory exists
    if [[ ! -d "$CLEO_DIR" ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            jq -n '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {"format": "json", "command": "roadmap"},
                "success": false,
                "error": {
                    "code": "E_NOT_INITIALIZED",
                    "message": "CLEO not initialized. Run: cleo init"
                }
            }'
        else
            echo "Error: CLEO not initialized. Run: cleo init" >&2
        fi
        exit "${EXIT_NOT_INITIALIZED:-3}"
    fi

    # Get data
    local current_version
    current_version=$(get_current_version)

    local epics_json
    epics_json=$(get_pending_epics)

    local history_json="[]"
    if [[ "$INCLUDE_HISTORY" == "true" ]]; then
        history_json=$(parse_changelog)
    fi

    # Generate output
    local output
    case "$FORMAT" in
        json)
            output=$(output_json "$current_version" "$epics_json" "$history_json")
            ;;
        markdown|md)
            output=$(output_markdown "$current_version" "$epics_json" "$history_json")
            ;;
        text|*)
            output=$(output_text "$current_version" "$epics_json" "$history_json")
            ;;
    esac

    # Write to file or stdout
    if [[ -n "$OUTPUT_FILE" ]]; then
        echo "$output" > "$OUTPUT_FILE"
        if [[ "$FORMAT" == "json" ]]; then
            jq -n --arg file "$OUTPUT_FILE" '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {"format": "json", "command": "roadmap"},
                "success": true,
                "outputFile": $file,
                "message": ("Roadmap written to " + $file)
            }'
        else
            echo "Roadmap written to $OUTPUT_FILE"
        fi
    else
        echo "$output"
    fi
}

main "$@"
