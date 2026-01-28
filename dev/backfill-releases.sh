#!/usr/bin/env bash
#####################################################################
# backfill-releases.sh - Backfill Historical Releases with Task Data
#
# PURPOSE: Parse CHANGELOG.md to extract task IDs and populate
#          release.tasks[] arrays for historical releases that were
#          shipped before the changelog system was implemented.
#
# USAGE:
#   ./dev/backfill-releases.sh [OPTIONS]
#
# OPTIONS:
#   --dry-run           Show what would be done without modifying files
#   --version <ver>     Backfill specific version only
#   --from <ver>        Backfill from this version onwards
#   --to <ver>          Backfill up to this version
#   --changelog <path>  Path to CHANGELOG.md (default: CHANGELOG.md)
#   --todo <path>       Path to todo.json (default: .cleo/todo.json)
#   --verbose           Show detailed progress
#   --help              Show this help message
#
# EXAMPLES:
#   # Dry-run for all releases
#   ./dev/backfill-releases.sh --dry-run
#
#   # Backfill specific version
#   ./dev/backfill-releases.sh --version v0.74.0
#
#   # Backfill range
#   ./dev/backfill-releases.sh --from v0.70.0 --to v0.74.0
#
# VERSION: 1.0.0
# PART OF: CLEO Changesets (T2602, T2618)
#####################################################################

set -euo pipefail

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Default paths
CHANGELOG_FILE="${CHANGELOG_FILE:-$PROJECT_ROOT/CHANGELOG.md}"
TODO_FILE="${TODO_FILE:-$PROJECT_ROOT/.cleo/todo.json}"

# Options
DRY_RUN=false
VERBOSE=false
SPECIFIC_VERSION=""
FROM_VERSION=""
TO_VERSION=""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $*"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $*"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $*"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*" >&2
}

log_debug() {
    [[ "$VERBOSE" == true ]] && echo -e "[DEBUG] $*"
}

# Show usage
show_usage() {
    grep '^#' "$0" | grep -v '#!/usr/bin/env' | sed 's/^# \?//'
    exit 0
}

# Parse arguments
parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            --verbose)
                VERBOSE=true
                shift
                ;;
            --version)
                SPECIFIC_VERSION="$2"
                shift 2
                ;;
            --from)
                FROM_VERSION="$2"
                shift 2
                ;;
            --to)
                TO_VERSION="$2"
                shift 2
                ;;
            --changelog)
                CHANGELOG_FILE="$2"
                shift 2
                ;;
            --todo)
                TODO_FILE="$2"
                shift 2
                ;;
            -h|--help)
                show_usage
                ;;
            *)
                log_error "Unknown option: $1"
                echo "Use --help for usage information"
                exit 1
                ;;
        esac
    done
}

# Validate prerequisites
validate_prerequisites() {
    log_info "Validating prerequisites..."

    # Check required commands
    for cmd in jq awk grep; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            log_error "Required command not found: $cmd"
            exit 1
        fi
    done

    # Check files exist
    if [[ ! -f "$CHANGELOG_FILE" ]]; then
        log_error "CHANGELOG.md not found: $CHANGELOG_FILE"
        exit 1
    fi

    if [[ ! -f "$TODO_FILE" ]]; then
        log_error "todo.json not found: $TODO_FILE"
        exit 1
    fi

    # Validate JSON
    if ! jq empty "$TODO_FILE" 2>/dev/null; then
        log_error "todo.json is not valid JSON"
        exit 1
    fi

    log_success "Prerequisites validated"
}

# Extract task IDs from CHANGELOG.md section
extract_task_ids_from_changelog() {
    local version="$1"
    local version_normalized="${version#v}"

    log_debug "Extracting task IDs for version $version from CHANGELOG.md"

    # Extract section content using awk
    local section_content
    section_content=$(awk -v ver="$version_normalized" '
        /^## \[(v)?'"$version_normalized"'\]/ {
            found=1
            next
        }
        found && /^## \[/ {
            exit
        }
        found {
            print
        }
    ' "$CHANGELOG_FILE")

    if [[ -z "$section_content" ]]; then
        log_debug "No changelog section found for $version"
        echo "[]"
        return 0
    fi

    # Extract task IDs (format: (T####))
    local task_ids
    task_ids=$(grep -oP '\(T\d+\)' <<< "$section_content" | tr -d '()' | sort -u || echo "")

    if [[ -z "$task_ids" ]]; then
        log_debug "No task IDs found in changelog section for $version"
        echo "[]"
        return 0
    fi

    # Convert to JSON array
    local json_array="["
    local first=true
    while IFS= read -r task_id; do
        [[ -z "$task_id" ]] && continue

        # Verify task exists in todo.json
        if jq -e ".tasks[] | select(.id == \"$task_id\")" "$TODO_FILE" >/dev/null 2>&1; then
            if [[ "$first" == true ]]; then
                json_array+="\"$task_id\""
                first=false
            else
                json_array+=",\"$task_id\""
            fi
            log_debug "  Found valid task: $task_id"
        else
            log_warn "  Task $task_id in changelog not found in todo.json (skipping)"
        fi
    done <<< "$task_ids"
    json_array+="]"

    echo "$json_array"
}

# Get releases from todo.json
get_releases() {
    jq -r '.project.releases[] | .version' "$TODO_FILE" 2>/dev/null || echo ""
}

# Check if release already has tasks
has_tasks() {
    local version="$1"
    local task_count
    task_count=$(jq --arg v "$version" '.project.releases[] | select(.version == $v) | .tasks // [] | length' "$TODO_FILE")
    [[ "$task_count" -gt 0 ]]
}

# Update release tasks in todo.json
update_release_tasks() {
    local version="$1"
    local task_ids_json="$2"

    if [[ "$DRY_RUN" == true ]]; then
        log_info "[DRY-RUN] Would update $version with tasks: $task_ids_json"
        return 0
    fi

    log_info "Updating $version with tasks: $task_ids_json"

    local updated_json
    updated_json=$(jq \
        --arg version "$version" \
        --argjson task_ids "$task_ids_json" \
        '
        .project.releases = [
            .project.releases[] |
            if .version == $version then
                .tasks = $task_ids
            else .
            end
        ]
    ' "$TODO_FILE")

    # Atomic write
    echo "$updated_json" > "$TODO_FILE.tmp"
    mv "$TODO_FILE.tmp" "$TODO_FILE"

    log_success "Updated $version"
}

# Main backfill logic
backfill_releases() {
    log_info "Starting backfill process..."

    if [[ "$DRY_RUN" == true ]]; then
        log_warn "DRY-RUN MODE: No changes will be made"
    fi

    local releases
    if [[ -n "$SPECIFIC_VERSION" ]]; then
        # Single version mode
        releases="$SPECIFIC_VERSION"
        log_info "Backfilling specific version: $SPECIFIC_VERSION"
    else
        # All releases mode
        releases=$(get_releases)
        if [[ -z "$releases" ]]; then
            log_error "No releases found in todo.json"
            exit 1
        fi
        log_info "Found $(wc -l <<< "$releases") releases to process"
    fi

    local processed=0
    local skipped=0
    local updated=0

    while IFS= read -r version; do
        [[ -z "$version" ]] && continue

        # Filter by range if specified
        if [[ -n "$FROM_VERSION" ]] && [[ "$version" < "$FROM_VERSION" ]]; then
            log_debug "Skipping $version (before $FROM_VERSION)"
            ((skipped++))
            continue
        fi

        if [[ -n "$TO_VERSION" ]] && [[ "$version" > "$TO_VERSION" ]]; then
            log_debug "Skipping $version (after $TO_VERSION)"
            ((skipped++))
            continue
        fi

        ((processed++))
        log_info "Processing $version..."

        # Check if already has tasks (unless forcing)
        if has_tasks "$version"; then
            log_warn "  $version already has tasks (skipping)"
            ((skipped++))
            continue
        fi

        # Extract task IDs from CHANGELOG.md
        local task_ids_json
        task_ids_json=$(extract_task_ids_from_changelog "$version")

        # Check if any tasks found
        local task_count
        task_count=$(jq '. | length' <<< "$task_ids_json")

        if [[ "$task_count" -eq 0 ]]; then
            log_warn "  No task IDs found for $version in CHANGELOG.md"
            ((skipped++))
            continue
        fi

        # Update release
        update_release_tasks "$version" "$task_ids_json"
        ((updated++))

    done <<< "$releases"

    # Summary
    echo ""
    log_success "Backfill complete!"
    log_info "  Processed: $processed releases"
    log_info "  Updated: $updated releases"
    log_info "  Skipped: $skipped releases"

    if [[ "$DRY_RUN" == true ]]; then
        echo ""
        log_warn "DRY-RUN MODE: Run without --dry-run to apply changes"
    fi
}

# Main execution
main() {
    parse_args "$@"
    validate_prerequisites
    backfill_releases
}

# Run main
main "$@"
