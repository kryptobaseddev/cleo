#!/usr/bin/env bash
###CLEO
# command: release
# category: write
# synopsis: Manage releases (create, plan, ship, list, show, changelog)
# relevance: high
# flags: --target-date,--tasks,--notes,--status,--format
# exits: 0,4,6,101
# json-output: true
###END

#####################################################################
# release.sh - Release Management Command for CLEO
#
# Manage release lifecycle from planning through deployment:
# - Create releases with planned tasks
# - Plan releases by adding/removing tasks
# - Ship releases (mark as released with timestamp)
# - List and show release details
#
# Usage:
#   release.sh <subcommand> [OPTIONS]
#
# Subcommands:
#   create <version>     Create a new planned release
#   plan <version>       Add/remove tasks from a release
#   ship <version>       Mark release as released
#   list                 List all releases
#   show <version>       Show release details
#   changelog <version>  Generate changelog for a release
#   validate <task-id>   Validate release protocol compliance for a task
#   init-ci              Initialize CI/CD workflow configuration
#
# Options:
#   --target-date DATE   Set target release date (YYYY-MM-DD)
#   --tasks T001,T002    Tasks to include (for create/plan)
#   --remove T003        Remove task from release (for plan)
#   --notes "text"       Release notes
#   --format FORMAT      Output format: text | json (default: auto)
#   --json               Shortcut for --format json
#   --human              Shortcut for --format text
#   -h, --help           Show this help message
#
# Examples:
#   cleo release create v0.65.0 --target-date 2026-02-01
#   cleo release plan v0.65.0 --tasks T2058,T2059
#   cleo release ship v0.65.0 --notes "Schema 2.8.0 release"
#   cleo release list
#   cleo release show v0.65.0
#   cleo release changelog v0.65.0
#
# Version: 0.2.0
# Part of: cleo CLI - Release Management (T2073)
#####################################################################

set -euo pipefail

# Script and library paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Source version from central location (first line only)
if [[ -f "$CLEO_HOME/VERSION" ]]; then
    VERSION="$(head -1 "$CLEO_HOME/VERSION" | tr -d '[:space:]')"
elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
    VERSION="$(head -1 "$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')"
else
    VERSION="unknown"
fi

# Source library functions
source_lib() {
    local lib_name="$1"
    local base_dir="${LIB_DIR:-$CLEO_HOME/lib}"

    # Direct path (new hierarchy - file includes subdir)
    if [[ -f "${base_dir}/${lib_name}" ]]; then
        source "${base_dir}/${lib_name}"
        return 0
    fi

    # Search subdirectories (backward compat - just filename)
    local found
    found=$(find "${base_dir}" -maxdepth 2 -name "${lib_name}" -type f 2>/dev/null | head -1)
    if [[ -n "$found" ]]; then
        source "$found"
        return 0
    fi

    echo "ERROR: Library not found: ${lib_name}" >&2
    return 1
}

source_lib "file-ops.sh"
source_lib "logging.sh"
source_lib "output-format.sh"
source_lib "error-json.sh"
source_lib "jq-helpers.sh"
source_lib "flags.sh"
source_lib "changelog.sh"
source_lib "config.sh"  # @task T2823 - For get_release_gates()
source_lib "release.sh" # @task T2845 - Release workflow functions
source_lib "release-ci.sh" # @task T2670 - CI/CD template generation
source_lib "release-guards.sh" # @task T4434 - Epic completeness & double-listing guards
source_lib "version-bump.sh"  # Portable config-driven version bump

# Exit codes (50-59 range for release operations per spec)
EXIT_RELEASE_NOT_FOUND=50
EXIT_RELEASE_EXISTS=51
EXIT_RELEASE_LOCKED=52
EXIT_INVALID_VERSION=53
EXIT_VALIDATION_FAILED=54
EXIT_VERSION_BUMP_FAILED=55
EXIT_TAG_CREATION_FAILED=56
EXIT_CHANGELOG_GENERATION_FAILED=57
EXIT_TAG_EXISTS=58
EXIT_TASKS_INCOMPLETE=59

# Default configuration
COMMAND_NAME="release"
FORMAT=""
SUBCOMMAND=""
VERSION_ARG=""
TARGET_DATE=""
TASKS_TO_ADD=""
TASKS_TO_REMOVE=""
RELEASE_NOTES=""
WRITE_CHANGELOG=""
CHANGELOG_OUTPUT=""
BUMP_VERSION=""
CREATE_TAG=""
PUSH_TAG=""
FORCE_TAG=""
VERBOSE=""
RUN_TESTS=""
SKIP_VALIDATION=""
DRY_RUN=""
SKIP_COMMIT=""
SKIP_CHANGELOG=""
CI_PLATFORM=""
CI_OUTPUT=""
CI_FORCE=""
STRICT=""
PREVIEW=""
FORCE_GUARDS=""
FORCE_RESHIP=""

# Initialize flag defaults
init_flag_defaults 2>/dev/null || true

# File paths
CLEO_DIR=".cleo"
TODO_FILE="${TODO_FILE:-${CLEO_DIR}/todo.json}"

#####################################################################
# Usage
#####################################################################

usage() {
    cat << 'EOF'
Usage: cleo release <subcommand> [OPTIONS]

Manage release lifecycle for roadmap and changelog integration.

Subcommands:
    create <version>     Create a new planned release
    plan <version>       Add/remove tasks from a release
    ship <version>       Mark release as released (set releasedAt)
    list                 List all releases
    show <version>       Show release details
    changelog <version>  Generate changelog from release tasks
    init-ci              Initialize CI/CD workflow configuration

Options:
    --target-date DATE   Set target release date (YYYY-MM-DD)
    --tasks T001,T002    Tasks to include (comma-separated)
    --remove T003        Remove task from release (for plan)
    --notes "text"       Release notes or summary
    --bump-version       Bump version in all configured files (for ship)
    --create-tag         Create git tag for release (for ship)
    --force-tag          Overwrite existing git tag (requires --create-tag)
    --push               Push changes and tag to remote (for ship)
    --preview            Preview which tasks would be included without shipping
    --dry-run            Show what would happen without making changes (for ship)
    --no-commit          Skip git commit (just update files) (for ship)
    --no-changelog       Skip changelog generation (for ship)
    --run-tests          Run test suite during validation (opt-in, slow)
    --skip-validation    Skip all validation gates (for emergency releases)
    --output FILE        Output file for changelog (default: CHANGELOG.md)
    --platform PLATFORM  CI platform (github-actions|gitlab-ci|circleci) (for init-ci)
    --force              Force operation (overrides tag conflict, epic guard, and allows re-ship)
    --format, -f FORMAT  Output format: text | json (default: auto)
    --json               Shortcut for --format json
    --human              Shortcut for --format text
    -h, --help           Show this help message

Release Status Flow:
    planned → active → released

Examples:
    cleo release create v0.65.0 --target-date 2026-02-01
    cleo release plan v0.65.0 --tasks T2058,T2059
    cleo release ship v0.65.0 --bump-version --create-tag --push
    cleo release ship v0.65.0 --preview  # Preview tasks and guards
    cleo release ship v0.65.0 --dry-run  # Preview what would happen
    cleo release ship v0.65.0 --notes "Schema 2.8.0 release"
    cleo release list
    cleo release show v0.65.0
    cleo release changelog v0.65.0
    cleo release init-ci  # Use platform from config
    cleo release init-ci --platform gitlab-ci --dry-run
    cleo release init-ci --platform github-actions --force

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
    CHECK_MARK="✓"
    CROSS_MARK="✗"
    BULLET="•"
else
    UNICODE_ENABLED=false
    CHECK_MARK="[x]"
    CROSS_MARK="[!]"
    BULLET="*"
fi

#####################################################################
# Helper Functions
#####################################################################

# @task T2806
# @epic T2802
# @why Standardize error handling for better agent/user experience
# @what Convert all release.sh errors to JSON format with fix suggestions

# Format-aware log_error - Uses lib/core/error-json.sh for proper JSON output
log_error() {
    local message="$1"
    local error_code="${2:-E_UNKNOWN}"
    local exit_code="${3:-1}"
    local suggestion="${4:-}"

    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
        output_error "$error_code" "$message" "$exit_code" true "$suggestion"
    else
        echo -e "${RED}[ERROR]${NC} $message" >&2
        [[ -n "$suggestion" ]] && echo -e "${DIM}Suggestion: $suggestion${NC}" >&2
    fi
}

# Format-aware log_warn - Outputs warnings properly in JSON/text
log_warn() {
    local message="$1"

    if [[ "$FORMAT" == "json" ]]; then
        # For JSON format, warnings should be in structured format
        # Note: release.sh doesn't currently include warnings in JSON output
        # but this provides consistency if needed in future
        return 0
    else
        echo -e "${YELLOW}[WARN]${NC} $message" >&2
    fi
}

log_info() {
    if [[ "$FORMAT" != "json" ]]; then
        echo -e "${DIM}[INFO]${NC} $1" >&2
    fi
}

# Check dependencies
check_deps() {
    if ! command -v jq &> /dev/null; then
        log_error "jq is required but not installed" "E_DEPENDENCY_MISSING" 1 "Install jq: brew install jq (macOS) or apt install jq (Linux)"
        exit "${EXIT_DEPENDENCY_ERROR:-5}"
    fi
}

# Validate version format (semver with optional v prefix)
validate_version() {
    local version="$1"
    if [[ ! "$version" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$ ]]; then
        log_error "Invalid version format: $version" "E_INVALID_VERSION" "$EXIT_INVALID_VERSION" "Use semver format: v0.65.0 or 0.65.0"
        exit "$EXIT_INVALID_VERSION"
    fi
}

# Normalize version to include v prefix
normalize_version() {
    local version="$1"
    if [[ ! "$version" =~ ^v ]]; then
        echo "v${version}"
    else
        echo "$version"
    fi
}

# Check if release exists
release_exists() {
    local version="$1"
    local normalized
    normalized=$(normalize_version "$version")

    jq -e --arg v "$normalized" '
        .project.releases // [] | map(select(.version == $v)) | length > 0
    ' "$TODO_FILE" >/dev/null 2>&1
}

# Get release by version
get_release() {
    local version="$1"
    local normalized
    normalized=$(normalize_version "$version")

    jq --arg v "$normalized" '
        .project.releases // [] | map(select(.version == $v)) | .[0] // null
    ' "$TODO_FILE"
}

# Get current timestamp in ISO 8601 format
get_timestamp() {
    date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# @task T2827
# @epic T2819
# @why Ensure version headers exist before changelog generation
# @what Auto-insert version header in CHANGELOG.md if missing
ensure_changelog_header() {
    local version="$1"
    local date="${2:-$(date +%Y-%m-%d)}"
    local changelog="${3:-CHANGELOG.md}"

    # Skip if changelog doesn't exist yet
    if [[ ! -f "$changelog" ]]; then
        log_info "CHANGELOG.md does not exist yet (will be created)"
        return 0
    fi

    # Normalize version (strip v prefix for header)
    local version_no_v="${version#v}"

    # Check if header already exists (idempotent)
    if grep -q "^## \[${version_no_v}\]" "$changelog"; then
        log_info "Version header already exists for ${version_no_v}"
        return 0
    fi

    log_info "Inserting version header for ${version_no_v} in CHANGELOG.md..."

    # Create version header
    local header="## [${version_no_v}] - ${date}"

    # Find the line number of "## [Unreleased]"
    local unreleased_line
    unreleased_line=$(grep -n "^## \[Unreleased\]" "$changelog" | head -1 | cut -d: -f1 || true)

    # Create backup
    cp "$changelog" "${changelog}.bak"

    if [[ -z "$unreleased_line" ]]; then
        # No [Unreleased] section - insert both [Unreleased] and version header
        # Find the first version header to insert before it
        local first_version_line
        first_version_line=$(grep -n "^## \[" "$changelog" | head -1 | cut -d: -f1 || true)

        if [[ -n "$first_version_line" ]]; then
            # Insert [Unreleased] + version header before the first existing version
            sed -i "${first_version_line}i\\
## [Unreleased]\\
\\
${header}\\
" "$changelog"
        else
            # No version headers at all - append after the file header (line 3 = after title + blank line)
            local header_end=3
            if [[ $(wc -l < "$changelog") -lt 3 ]]; then
                header_end=$(wc -l < "$changelog")
            fi
            sed -i "${header_end}a\\
\\
## [Unreleased]\\
\\
${header}\\
" "$changelog"
        fi
        log_info "[Unreleased] section created and version header inserted"
    else
        # Insert header after Unreleased + blank line
        local insert_line=$((unreleased_line + 2))

        sed -i "${insert_line}i\\
${header}\\
" "$changelog"
    fi

    log_info "Version header inserted successfully"
    return 0
}

# Validation gates (Part 5 from spec)
# Note: Checkpoint suppression is handled by the caller (cmd_ship sets GIT_CHECKPOINT_SUPPRESS=true)
# This ensures cleo validate's auto-fix writes don't trigger mid-flow checkpoint commits
# @task T2739 T4250
validate_release() {
    local version="$1"

    # Skip all validation if --skip-validation flag set
    if [[ "$SKIP_VALIDATION" == "true" ]]; then
        [[ "$VERBOSE" == true ]] && log_warn "Skipping all validation gates (--skip-validation)"
        return 0
    fi

    [[ "$VERBOSE" == true ]] && log_info "Running validation gates..."

    # Gate 1: Tests (opt-in only with --run-tests flag)
    # Tests are NOT run by default to avoid release ship timeout
    if [[ "$RUN_TESTS" == "true" ]]; then
        if [[ -x "./tests/run-all-tests.sh" ]]; then
            [[ "$VERBOSE" == true ]] && log_info "Running test suite (--run-tests enabled)..."
            if ! ./tests/run-all-tests.sh >/dev/null 2>&1; then
                log_error "Tests failed" "E_VALIDATION_FAILED" "$EXIT_VALIDATION_FAILED" "Fix test failures: ./tests/run-all-tests.sh"
                return "$EXIT_VALIDATION_FAILED"
            fi
            [[ "$VERBOSE" == true ]] && log_info "Tests passed"
        fi
    else
        [[ "$VERBOSE" == true ]] && log_info "Skipping tests (use --run-tests to enable)"
    fi

    # Gate 2: Schema validation
    if command -v cleo >/dev/null 2>&1; then
        if ! cleo validate >/dev/null 2>&1; then
            log_error "Schema validation failed" "E_VALIDATION_FAILED" "$EXIT_VALIDATION_FAILED" "Fix validation errors: cleo validate"
            return "$EXIT_VALIDATION_FAILED"
        fi
        [[ "$VERBOSE" == true ]] && log_info "Schema validation passed"
    fi

    # Gate 3: VERSION consistency (if --bump-version was used)
    if [[ "$BUMP_VERSION" == "true" ]] && [[ -f "VERSION" ]]; then
        local version_file
        version_file=$(cat VERSION | tr -d '[:space:]')
        local normalized
        normalized=$(normalize_version "$version")
        # Remove v prefix for comparison
        normalized="${normalized#v}"
        if [[ "$version_file" != "$normalized" ]]; then
            log_error "VERSION file mismatch" "E_VERSION_BUMP_FAILED" "$EXIT_VERSION_BUMP_FAILED" "VERSION file has $version_file but expected $normalized"
            return "$EXIT_VERSION_BUMP_FAILED"
        fi
        [[ "$VERBOSE" == true ]] && log_info "VERSION consistency verified"
    fi

    # Gate 4: Changelog validation (MANDATORY unless --skip-changelog)
    if [[ "${SKIP_CHANGELOG:-false}" != "true" ]]; then
        if [[ ! -f "CHANGELOG.md" ]]; then
            log_error "CHANGELOG.md not found" "E_CHANGELOG_GENERATION_FAILED" "$EXIT_CHANGELOG_GENERATION_FAILED" "Changelog generation failed - file missing"
            return "$EXIT_CHANGELOG_GENERATION_FAILED"
        fi

        local normalized
        normalized=$(normalize_version "$version")
        local version_no_v="${normalized#v}"

        # Check 1: Entry exists (with or without 'v' prefix)
        if ! grep -q "^## \[v\?${version_no_v}\]" CHANGELOG.md; then
            log_error "Changelog entry not found" "E_CHANGELOG_GENERATION_FAILED" "$EXIT_CHANGELOG_GENERATION_FAILED" "CHANGELOG.md missing entry for $normalized"
            return "$EXIT_CHANGELOG_GENERATION_FAILED"
        fi

        # Check 2: Entry is not empty
        local section_content
        section_content=$(extract_changelog_section "$normalized" "CHANGELOG.md" 2>/dev/null || echo "")
        if [[ -z "$section_content" ]] || [[ "$section_content" =~ ^[[:space:]]*$ ]]; then
            log_error "Changelog entry is empty" "E_CHANGELOG_GENERATION_FAILED" "$EXIT_CHANGELOG_GENERATION_FAILED" "CHANGELOG.md entry for $normalized has no content"
            return "$EXIT_CHANGELOG_GENERATION_FAILED"
        fi

        # Check 3: Warn about task IDs in changelog that are missing or not done
        # @task T2807
        # @epic T2802
        # @why Tasks may be archived or be epics referenced by commits - warn, don't block
        # @what Changed from blocking to warning-only for missing/non-done tasks
        local task_ids
        task_ids=$(grep -oP '\(T\d+\)' <<< "$section_content" | tr -d '()' || echo "")
        if [[ -n "$task_ids" ]]; then
            local missing_tasks=()
            local non_done_tasks=()
            while IFS= read -r task_id; do
                [[ -z "$task_id" ]] && continue

                # Check task exists
                if ! jq -e ".tasks[] | select(.id == \"$task_id\")" "$TODO_FILE" >/dev/null 2>&1; then
                    missing_tasks+=("$task_id")
                    continue
                fi

                # Check task status
                local task_status
                task_status=$(jq -r ".tasks[] | select(.id == \"$task_id\") | .status" "$TODO_FILE")
                if [[ "$task_status" != "done" ]]; then
                    non_done_tasks+=("$task_id")
                fi
            done <<< "$task_ids"

            # Warn about missing tasks (may be archived) - don't block
            if [[ ${#missing_tasks[@]} -gt 0 ]]; then
                log_warn "Tasks referenced in changelog but not in todo.json (may be archived): ${missing_tasks[*]}"
            fi

            # Warn about non-done tasks (may be epics) - don't block
            if [[ ${#non_done_tasks[@]} -gt 0 ]]; then
                log_warn "Tasks in changelog with non-done status: ${non_done_tasks[*]}"
            fi
        fi

        [[ "$VERBOSE" == true ]] && log_info "Changelog validation passed"
    else
        [[ "$VERBOSE" == true ]] && log_warn "Changelog validation SKIPPED (--skip-changelog)"
    fi

    # @task T2823 - Dynamic release gates from config
    local gates
    gates=$(get_release_gates)
    if [[ "$gates" != "[]" && -n "$gates" ]]; then
        [[ "$VERBOSE" == true ]] && log_info "Executing custom release gates..."

        echo "$gates" | jq -c '.[]' | while read -r gate; do
            local gate_name gate_cmd gate_required gate_timeout
            gate_name=$(echo "$gate" | jq -r '.name')
            gate_cmd=$(echo "$gate" | jq -r '.command')
            gate_required=$(echo "$gate" | jq -r '.required // true')
            gate_timeout=$(echo "$gate" | jq -r '.timeout // 60')

            [[ "$VERBOSE" == true ]] && log_info "Running gate: $gate_name"

            if timeout "$gate_timeout" bash -c "$gate_cmd" >/dev/null 2>&1; then
                [[ "$VERBOSE" == true ]] && log_success "Gate passed: $gate_name"
            else
                if [[ "$gate_required" == "true" ]]; then
                    log_error "Required gate failed: $gate_name" "E_VALIDATION_FAILED" "$EXIT_VALIDATION_FAILED" "Fix gate failure: $gate_cmd"
                    return "$EXIT_VALIDATION_FAILED"
                else
                    log_warn "Optional gate failed: $gate_name (continuing)"
                fi
            fi
        done
    fi

    return 0
}

#####################################################################
# Subcommand: create
#####################################################################

cmd_create() {
    local version="$1"
    shift

    validate_version "$version"
    local normalized
    normalized=$(normalize_version "$version")

    # Check if release already exists
    if release_exists "$normalized"; then
        log_error "Release $normalized already exists" "E_RELEASE_EXISTS" "$EXIT_RELEASE_EXISTS" "Use 'cleo release plan $normalized' to modify"
        exit "$EXIT_RELEASE_EXISTS"
    fi

    # Build release object
    local target_date_json="null"
    if [[ -n "$TARGET_DATE" ]]; then
        target_date_json="\"$TARGET_DATE\""
    fi

    local tasks_json="[]"
    if [[ -n "$TASKS_TO_ADD" ]]; then
        # Convert comma-separated to JSON array
        tasks_json=$(echo "$TASKS_TO_ADD" | tr ',' '\n' | jq -R . | jq -s .)
    fi

    local notes_json="null"
    if [[ -n "$RELEASE_NOTES" ]]; then
        notes_json="\"$RELEASE_NOTES\""
    fi

    # Create the new release
    local new_release
    new_release=$(jq -n \
        --arg version "$normalized" \
        --arg status "planned" \
        --argjson targetDate "$target_date_json" \
        --argjson tasks "$tasks_json" \
        --argjson notes "$notes_json" \
        '{
            version: $version,
            status: $status,
            targetDate: $targetDate,
            releasedAt: null,
            createdAt: (now | strftime("%Y-%m-%dT%H:%M:%SZ")),
            tasks: $tasks,
            notes: $notes
        }')

    # Update todo.json
    local updated_json
    updated_json=$(jq --argjson release "$new_release" '
        .project.releases = ((.project.releases // []) + [$release]) |
        .lastUpdated = (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
    ' "$TODO_FILE")

    # Recalculate checksum after modifying todo.json
    updated_json=$(recalculate_checksum "$updated_json")

    # @task T4249 - Route through save_json for generation counter, audit trail, checkpoint
    if declare -f save_json >/dev/null 2>&1; then
        echo "$updated_json" | save_json "$TODO_FILE" || {
            echo "Error: Failed to save $TODO_FILE" >&2
            return 1
        }
    else
        # Fallback for contexts where file-ops.sh isn't loaded
        echo "$updated_json" > "$TODO_FILE.tmp"
        mv "$TODO_FILE.tmp" "$TODO_FILE"
    fi

    # Output result
    if [[ "$FORMAT" == "json" ]]; then
        jq -n \
            --arg version "$VERSION" \
            --argjson release "$new_release" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "command": "release create",
                    "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ")),
                    "version": $version
                },
                "success": true,
                "action": "created",
                "release": $release
            }'
    else
        echo -e "${GREEN}${CHECK_MARK}${NC} Created release $normalized"
        [[ -n "$TARGET_DATE" ]] && echo "  Target date: $TARGET_DATE"
        [[ -n "$TASKS_TO_ADD" ]] && echo "  Tasks: $TASKS_TO_ADD"
    fi
}

#####################################################################
# Subcommand: plan
#####################################################################

cmd_plan() {
    local version="$1"
    shift

    validate_version "$version"
    local normalized
    normalized=$(normalize_version "$version")

    # Check if release exists
    if ! release_exists "$normalized"; then
        log_error "Release $normalized not found" "E_RELEASE_NOT_FOUND" "$EXIT_RELEASE_NOT_FOUND" "Create it first: cleo release create $normalized"
        exit "$EXIT_RELEASE_NOT_FOUND"
    fi

    # Get current release
    local current_release
    current_release=$(get_release "$normalized")

    # Check release status - can only plan if status is planned or active
    local status
    status=$(echo "$current_release" | jq -r '.status')
    if [[ "$status" == "released" ]]; then
        log_error "Cannot modify released release $normalized" "E_RELEASE_LOCKED" "$EXIT_RELEASE_LOCKED" "Released releases are read-only"
        exit "$EXIT_RELEASE_LOCKED"
    fi

    # Build updated tasks array
    local tasks_to_add_json="[]"
    if [[ -n "$TASKS_TO_ADD" ]]; then
        tasks_to_add_json=$(echo "$TASKS_TO_ADD" | tr ',' '\n' | jq -R . | jq -s .)
    fi

    local tasks_to_remove_json="[]"
    if [[ -n "$TASKS_TO_REMOVE" ]]; then
        tasks_to_remove_json=$(echo "$TASKS_TO_REMOVE" | tr ',' '\n' | jq -R . | jq -s .)
    fi

    # Update release
    local updated_json
    updated_json=$(jq \
        --arg version "$normalized" \
        --argjson add_tasks "$tasks_to_add_json" \
        --argjson remove_tasks "$tasks_to_remove_json" \
        '
        .project.releases = [
            .project.releases[] |
            if .version == $version then
                .tasks = ((.tasks // []) + $add_tasks | unique | map(select(. as $t | $remove_tasks | index($t) | not)))
            else .
            end
        ] |
        .lastUpdated = (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
    ' "$TODO_FILE")

    # Recalculate checksum after modifying todo.json
    updated_json=$(recalculate_checksum "$updated_json")

    # @task T4249 - Route through save_json for generation counter, audit trail, checkpoint
    if declare -f save_json >/dev/null 2>&1; then
        echo "$updated_json" | save_json "$TODO_FILE" || {
            echo "Error: Failed to save $TODO_FILE" >&2
            return 1
        }
    else
        # Fallback for contexts where file-ops.sh isn't loaded
        echo "$updated_json" > "$TODO_FILE.tmp"
        mv "$TODO_FILE.tmp" "$TODO_FILE"
    fi

    # Get updated release for output
    local updated_release
    updated_release=$(echo "$updated_json" | jq --arg v "$normalized" '
        .project.releases | map(select(.version == $v)) | .[0]
    ')

    # Output result
    if [[ "$FORMAT" == "json" ]]; then
        jq -n \
            --arg version "$VERSION" \
            --argjson release "$updated_release" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "command": "release plan",
                    "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ")),
                    "version": $version
                },
                "success": true,
                "action": "updated",
                "release": $release
            }'
    else
        echo -e "${GREEN}${CHECK_MARK}${NC} Updated release $normalized"
        local task_count
        task_count=$(echo "$updated_release" | jq '.tasks | length')
        echo "  Tasks: $task_count total"
    fi
}

#####################################################################
# Subcommand: ship
#####################################################################

cmd_ship() {
    local version="$1"
    shift

    # Suppress checkpoints during multi-step release flow
    # @task T4248
    export GIT_CHECKPOINT_SUPPRESS=true
    trap 'unset GIT_CHECKPOINT_SUPPRESS' EXIT

    validate_version "$version"
    local normalized
    normalized=$(normalize_version "$version")

    # Check if release exists
    if ! release_exists "$normalized"; then
        log_error "Release $normalized not found" "E_RELEASE_NOT_FOUND" "$EXIT_RELEASE_NOT_FOUND" "Create it first: cleo release create $normalized"
        exit "$EXIT_RELEASE_NOT_FOUND"
    fi

    # Get current release
    local current_release
    current_release=$(get_release "$normalized")

    # Check release status
    local status
    status=$(echo "$current_release" | jq -r '.status')
    if [[ "$status" == "released" ]]; then
        if [[ "${FLAG_FORCE:-false}" == "true" || "${FORCE_RESHIP:-false}" == "true" ]]; then
            log_warn "Re-shipping already released version $normalized (--force)"
            log_warn "This will re-create the git tag and re-push if requested"
            # Force tag overwrite since tag likely already exists
            FORCE_TAG="true"
        else
            log_error "Release $normalized is already released" "E_RELEASE_LOCKED" "$EXIT_RELEASE_LOCKED" \
                "Use --force to re-ship (e.g., after CI failure fix)"
            exit "$EXIT_RELEASE_LOCKED"
        fi
    fi

    # PREVIEW MODE: Show task preview without shipping
    # @task T4434 @epic T4431
    if [[ "${PREVIEW:-false}" == "true" ]]; then
        # Get manually-planned tasks (current release.tasks[])
        local manual_tasks
        manual_tasks=$(jq -r --arg v "$normalized" '
            .project.releases[] | select(.version == $v) | .tasks // []
        ' "$TODO_FILE")

        # Run discovery (pure, no writes)
        local discovered_tasks
        discovered_tasks=$(discover_release_tasks "$normalized" "$TODO_FILE" 2>/dev/null) || discovered_tasks="[]"

        # Compute union (manual + discovered, deduped)
        local all_tasks
        all_tasks=$(jq -n --argjson manual "$manual_tasks" --argjson discovered "$discovered_tasks" '
            ($manual + $discovered) | unique
        ')

        # Classify each task as "manual", "auto", or "both"
        local task_details
        task_details=$(jq -n --argjson manual "$manual_tasks" --argjson discovered "$discovered_tasks" --argjson all "$all_tasks" '
            [($all)[] | . as $id |
             {
               id: $id,
               inManual: ($manual | index($id) != null),
               inDiscovered: ($discovered | index($id) != null)
             } |
             .source = (if .inManual and .inDiscovered then "both"
                         elif .inManual then "manual"
                         else "auto" end) |
             del(.inManual, .inDiscovered)
            ]
        ')

        # Enrich with task metadata (title, labels)
        local enriched_tasks="[]"
        for task_id in $(echo "$all_tasks" | jq -r '.[]'); do
            local title labels source
            title=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .title // "(archived or unknown)"' "$TODO_FILE")
            labels=$(jq -c --arg id "$task_id" '.tasks[] | select(.id == $id) | .labels // []' "$TODO_FILE")
            source=$(echo "$task_details" | jq -r --arg id "$task_id" '.[] | select(.id == $id) | .source')
            [[ -z "$title" ]] && title="(archived or unknown)"
            [[ -z "$labels" || "$labels" == "null" ]] && labels="[]"
            enriched_tasks=$(echo "$enriched_tasks" | jq --arg id "$task_id" --arg title "$title" --argjson labels "$labels" --arg source "$source" '. + [{id: $id, title: $title, labels: $labels, source: $source}]')
        done

        # Run guard checks
        local epic_result double_result
        epic_result=$(check_epic_completeness "$all_tasks" "$TODO_FILE" 2>/dev/null) || epic_result='{"hasIncomplete":false,"epics":[],"orphanTasks":[]}'
        double_result=$(check_double_listing "$all_tasks" "$normalized" "$TODO_FILE" 2>/dev/null) || double_result='{"hasOverlap":false,"overlaps":[]}'

        if [[ "$FORMAT" == "json" ]]; then
            jq -n \
                --arg version "$normalized" \
                --argjson tasks "$enriched_tasks" \
                --argjson epicCompleteness "$epic_result" \
                --argjson doubleListing "$double_result" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "format": "json",
                        "command": "release ship --preview",
                        "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ")),
                        "version": $version
                    },
                    "success": true,
                    "preview": true,
                    "tasks": $tasks,
                    "epicCompleteness": $epicCompleteness,
                    "doubleListing": $doubleListing
                }'
        else
            echo ""
            echo -e "${BOLD}Release Preview: $normalized${NC}"
            echo "════════════════════════════════════════════════════════════"

            local total auto_count manual_count both_count
            total=$(echo "$enriched_tasks" | jq 'length')
            auto_count=$(echo "$enriched_tasks" | jq '[.[] | select(.source == "auto")] | length')
            manual_count=$(echo "$enriched_tasks" | jq '[.[] | select(.source == "manual")] | length')
            both_count=$(echo "$enriched_tasks" | jq '[.[] | select(.source == "both")] | length')

            echo ""
            echo "Tasks ($total total):"

            # Show auto-discovered tasks
            if [[ "$auto_count" -gt 0 || "$both_count" -gt 0 ]]; then
                echo "  Auto-discovered ($((auto_count + both_count))):"
                echo "$enriched_tasks" | jq -r '.[] | select(.source == "auto" or .source == "both") | "    \(.id)  \(.title)  [\(.labels | join(", "))]"'
            fi

            # Show manually-planned tasks
            if [[ "$manual_count" -gt 0 ]]; then
                echo "  Manually planned ($manual_count):"
                echo "$enriched_tasks" | jq -r '.[] | select(.source == "manual") | "    \(.id)  \(.title)  [\(.labels | join(", "))]"'
            fi

            if [[ "$total" -eq 0 ]]; then
                echo "  (no tasks found)"
            fi

            # Render guard results
            echo ""
            render_epic_completeness "$epic_result" "text"
            render_double_listing "$double_result" "text"
        fi

        return 0
    fi

    # DRY RUN: Enhanced preview with task discovery and guard checks
    # @task T4434 @epic T4431
    if [[ "$DRY_RUN" == "true" ]]; then
        # Run preview computation first
        local manual_tasks discovered_tasks all_tasks
        manual_tasks=$(jq -r --arg v "$normalized" '.project.releases[] | select(.version == $v) | .tasks // []' "$TODO_FILE")
        discovered_tasks=$(discover_release_tasks "$normalized" "$TODO_FILE" 2>/dev/null) || discovered_tasks="[]"
        all_tasks=$(jq -n --argjson manual "$manual_tasks" --argjson discovered "$discovered_tasks" '($manual + $discovered) | unique')

        local epic_result double_result
        epic_result=$(check_epic_completeness "$all_tasks" "$TODO_FILE" 2>/dev/null) || epic_result='{"hasIncomplete":false,"epics":[],"orphanTasks":[]}'
        double_result=$(check_double_listing "$all_tasks" "$normalized" "$TODO_FILE" 2>/dev/null) || double_result='{"hasOverlap":false,"overlaps":[]}'

        if [[ "$FORMAT" != "json" ]]; then
            echo ""
            log_warn "DRY RUN - Would perform:"
            echo ""

            # Show task summary
            local total
            total=$(echo "$all_tasks" | jq 'length')
            echo "  Tasks to include ($total):"
            for task_id in $(echo "$all_tasks" | jq -r '.[]'); do
                local title
                title=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .title // "(unknown)"' "$TODO_FILE")
                echo "    $task_id  $title"
            done
            echo ""

            # Show guard warnings
            render_epic_completeness "$epic_result" "text"
            render_double_listing "$double_result" "text"

            # Show steps
            echo "  Steps:"
            echo "    1. Auto-populate release tasks from completed work"
            [[ "$BUMP_VERSION" == "true" ]] && echo "    2. Bump VERSION to ${normalized#v}"
            [[ "${SKIP_CHANGELOG:-false}" != "true" ]] && echo "    3. Prepare CHANGELOG.md header for $normalized"
            [[ "${SKIP_CHANGELOG:-false}" != "true" ]] && echo "    4. Generate changelog from commits"
            [[ "${SKIP_CHANGELOG:-false}" != "true" ]] && echo "    5. Generate task-based changelog"
            echo "    6. Run validation gates"
            [[ "$SKIP_COMMIT" != "true" ]] && echo "    7. Git commit: 'chore: Release ${normalized#v}'"
            [[ "$CREATE_TAG" == "true" ]] && echo "    8. Git tag: $normalized"
            [[ "$PUSH_TAG" == "true" ]] && echo "    9. Git push origin main --tags"
            echo "    10. Mark release as 'released' in todo.json"
        fi

        if [[ "$FORMAT" == "json" ]]; then
            jq -n \
                --arg version "$normalized" \
                --argjson tasks "$all_tasks" \
                --argjson epicCompleteness "$epic_result" \
                --argjson doubleListing "$double_result" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "format": "json",
                        "command": "release ship --dry-run",
                        "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ")),
                        "version": $version
                    },
                    "success": true,
                    "dryRun": true,
                    "tasks": $tasks,
                    "epicCompleteness": $epicCompleteness,
                    "doubleListing": $doubleListing,
                    "message": "Dry run completed - no changes made"
                }'
        fi
        return 0
    fi

    # Step 0: Auto-populate release tasks using hybrid date+label strategy
    log_info "Discovering tasks for $normalized..."
    if ! populate_release_tasks "$normalized" "$TODO_FILE"; then
        log_error "Failed to populate release tasks" "E_CHANGELOG_GENERATION_FAILED" "$EXIT_CHANGELOG_GENERATION_FAILED" "Check that release exists in todo.json"
        exit "$EXIT_CHANGELOG_GENERATION_FAILED"
    fi
    log_info "Release tasks populated successfully"

    # Step 0.5: Release guards (epic completeness + double-listing)
    # @task T4434 @epic T4431
    local guard_mode
    guard_mode=$(get_epic_completeness_mode 2>/dev/null) || guard_mode="warn"

    if [[ "$guard_mode" != "off" ]]; then
        # Get current release task list after auto-populate
        local release_task_ids
        release_task_ids=$(jq -r --arg v "$normalized" '
            .project.releases[] | select(.version == $v) | .tasks // []
        ' "$TODO_FILE")

        # Run epic completeness check
        local epic_result
        epic_result=$(check_epic_completeness "$release_task_ids" "$TODO_FILE" 2>/dev/null) || epic_result='{"hasIncomplete":false,"epics":[],"orphanTasks":[]}'

        local has_incomplete
        has_incomplete=$(echo "$epic_result" | jq -r '.hasIncomplete')

        if [[ "$has_incomplete" == "true" ]]; then
            render_epic_completeness "$epic_result" "${FORMAT:-text}"

            if [[ "$guard_mode" == "block" && "${FORCE_GUARDS:-false}" != "true" ]]; then
                log_error "Epic completeness check failed" "E_TASKS_INCOMPLETE" "$EXIT_TASKS_INCOMPLETE" "Use --force to override or set release.guards.epicCompleteness to 'warn'"
                exit "$EXIT_TASKS_INCOMPLETE"
            fi
        fi

        # Run double-listing check (always warn, never block)
        local double_result
        double_result=$(check_double_listing "$release_task_ids" "$normalized" "$TODO_FILE" 2>/dev/null) || double_result='{"hasOverlap":false,"overlaps":[]}'

        local has_overlap
        has_overlap=$(echo "$double_result" | jq -r '.hasOverlap')

        if [[ "$has_overlap" == "true" ]]; then
            render_double_listing "$double_result" "${FORMAT:-text}"
        fi
    fi

    # Step 1: Bump VERSION if requested (portable config-driven system)
    if [[ "$BUMP_VERSION" == "true" ]]; then
        log_info "Bumping VERSION to $normalized..."

        # Strip v prefix (version bump expects X.Y.Z format)
        local version_no_v="${normalized#v}"

        # Check if config-driven version bump is configured
        local config_file="${CONFIG_FILE:-.cleo/config.json}"
        if check_version_bump_configured "$config_file" 2>/dev/null; then
            # Use portable config-driven bump
            local dry_run_flag="false"
            [[ "${DRY_RUN:-false}" == "true" ]] && dry_run_flag="true"

            local bump_result
            if ! bump_result=$(bump_version_from_config "$version_no_v" "$dry_run_flag" "$config_file"); then
                log_error "VERSION bump failed" "E_VERSION_BUMP_FAILED" "$EXIT_VERSION_BUMP_FAILED" \
                    "Check release.versionBump config in $config_file"
                exit "$EXIT_VERSION_BUMP_FAILED"
            fi

            # Log per-file results in verbose/text mode
            if [[ "$FORMAT" != "json" ]]; then
                local files_updated files_skipped files_failed
                files_updated=$(echo "$bump_result" | jq -r '.filesUpdated')
                files_skipped=$(echo "$bump_result" | jq -r '.filesSkipped')
                files_failed=$(echo "$bump_result" | jq -r '.filesFailed')
                log_info "VERSION bumped: ${files_updated} updated, ${files_skipped} skipped, ${files_failed} failed"
            fi

            # Capture bumped file paths for git staging (GH #31)
            BUMPED_FILES=$(echo "$bump_result" | jq -r '.files[] | select(.status == "updated") | .path' 2>/dev/null || true)
        else
            # No version bump config — try auto-detection (GH #32)
            log_info "No versionBump config found, attempting auto-detection..."
            local auto_config
            if auto_config=$(auto_detect_version_bump_files); then
                log_info "Auto-detected version bump targets"
                # Write auto-detected config to a temp file for bump_version_from_config
                local tmp_config
                tmp_config=$(mktemp)
                # Merge auto-detected versionBump into existing config (or create minimal)
                if [[ -f "$config_file" ]]; then
                    jq --argjson vb "$auto_config" '.release.versionBump = $vb' "$config_file" > "$tmp_config"
                else
                    jq -nc --argjson vb "$auto_config" '{"release":{"versionBump":$vb}}' > "$tmp_config"
                fi

                local dry_run_flag="false"
                [[ "${DRY_RUN:-false}" == "true" ]] && dry_run_flag="true"

                local bump_result
                if ! bump_result=$(bump_version_from_config "$version_no_v" "$dry_run_flag" "$tmp_config"); then
                    log_error "VERSION bump failed (auto-detected)" "E_VERSION_BUMP_FAILED" "$EXIT_VERSION_BUMP_FAILED" \
                        "Auto-detection found files but bump failed. Configure release.versionBump manually."
                    rm -f "$tmp_config"
                    exit "$EXIT_VERSION_BUMP_FAILED"
                fi
                rm -f "$tmp_config"

                if [[ "$FORMAT" != "json" ]]; then
                    local files_updated files_skipped files_failed
                    files_updated=$(echo "$bump_result" | jq -r '.filesUpdated')
                    files_skipped=$(echo "$bump_result" | jq -r '.filesSkipped')
                    files_failed=$(echo "$bump_result" | jq -r '.filesFailed')
                    log_info "VERSION bumped (auto-detected): ${files_updated} updated, ${files_skipped} skipped, ${files_failed} failed"
                fi

                # Capture bumped files for staging (same as configured path)
                BUMPED_FILES=$(echo "$bump_result" | jq -r '.files[] | select(.status == "updated") | .path' 2>/dev/null || true)
            else
                # Auto-detection failed too — show actionable error
                check_version_bump_configured "$config_file" 2>&1 | while IFS= read -r line; do
                    echo "  $line" >&2
                done
                log_error "VERSION bump not configured and auto-detection found no project files" "E_VERSION_BUMP_FAILED" "$EXIT_VERSION_BUMP_FAILED" \
                    "Configure release.versionBump in $config_file (see error above)"
                exit "$EXIT_VERSION_BUMP_FAILED"
            fi
        fi
        log_info "VERSION bumped successfully"
    fi

    # Step 1.5: Ensure changelog header exists (T2827)
    if [[ "${SKIP_CHANGELOG:-false}" != "true" ]]; then
        ensure_changelog_header "$normalized"
    fi

    # Step 2: ALWAYS generate changelog (mandatory per CHANGELOG-GENERATION-SPEC.md)
    local changelog_content=""
    local changelog_file="${CHANGELOG_OUTPUT:-CHANGELOG.md}"

    if [[ "${SKIP_CHANGELOG:-false}" == "true" ]]; then
        log_warn "SKIPPING changelog generation (--no-changelog)"
        if [[ "${CREATE_TAG:-false}" == "true" ]]; then
            log_warn "Tag annotation will use git commit history as fallback for release notes"
        fi
    else
        log_info "Generating changelog for $normalized..."

        # Generate changelog using lib/ui/changelog.sh
        if ! changelog_content=$(generate_changelog "$normalized" "" "$TODO_FILE"); then
            log_error "Changelog generation failed" "E_CHANGELOG_GENERATION_FAILED" "$EXIT_CHANGELOG_GENERATION_FAILED" "Check lib/ui/changelog.sh:generate_changelog()"
            exit "$EXIT_CHANGELOG_GENERATION_FAILED"
        fi

        # T2864: Validate changelog content is not empty before appending
        # This prevents creating empty version headers that break GitHub release notes
        local version_no_v="${normalized#v}"
        local changelog_section_content
        changelog_section_content=$(extract_changelog_section "$version_no_v" "$changelog_file" 2>/dev/null || echo "")

        # Check if we have content from task-based generation
        if [[ -z "$changelog_section_content" || "$changelog_section_content" =~ ^[[:space:]]*$ ]] && \
           [[ -z "$changelog_content" || "$changelog_content" =~ ^[[:space:]]*$ ]]; then
            log_error "Changelog content is empty" "E_CHANGELOG_GENERATION_FAILED" "$EXIT_CHANGELOG_GENERATION_FAILED" \
                "No changelog content generated from tasks. Add tasks with labels (feat, fix, docs) to the release."
            exit "$EXIT_CHANGELOG_GENERATION_FAILED"
        fi

        # Append to CHANGELOG.md
        if ! append_to_changelog "$normalized" "$changelog_file" "$TODO_FILE"; then
            log_error "Failed to write CHANGELOG.md" "E_CHANGELOG_GENERATION_FAILED" "$EXIT_CHANGELOG_GENERATION_FAILED" "Check file permissions"
            exit "$EXIT_CHANGELOG_GENERATION_FAILED"
        fi
        log_info "Changelog generated and written to $changelog_file"

        # Step 2.5: Generate platform-specific changelog outputs (e.g., Mintlify MDX, Docusaurus)
        # Only runs if user has configured changelog output platforms
        local platforms
        platforms=$(get_changelog_platforms 2>/dev/null || true)
        if [[ -n "$platforms" ]]; then
            local generate_script="$SCRIPT_DIR/generate-changelog.sh"
            if [[ -x "$generate_script" ]]; then
                log_info "Generating platform-specific changelog outputs..."
                if "$generate_script" 20 2>/dev/null; then
                    log_info "Platform changelog outputs generated"
                    # Stage any generated doc files for the release commit
                    while IFS= read -r platform; do
                        local doc_path
                        doc_path=$(get_changelog_output_path "$platform" 2>/dev/null || true)
                        if [[ -n "$doc_path" && -f "$doc_path" ]]; then
                            git add "$doc_path" 2>/dev/null || true
                        fi
                    done <<< "$platforms"
                else
                    log_warn "Platform changelog generation failed (non-blocking)"
                fi
            fi
        fi
    fi

    # Step 3: Run validation gates
    if ! validate_release "$normalized"; then
        log_error "Release validation failed" "E_VALIDATION_FAILED" "$EXIT_VALIDATION_FAILED" "Fix validation errors before shipping"
        exit "$EXIT_VALIDATION_FAILED"
    fi

    # Step 3.5: Update release status to shipped BEFORE commit
    # @task T4248 - Moved before git commit so release commit captures final state
    local timestamp
    timestamp=$(get_timestamp)

    local git_tag_created=false
    local updated_json
    updated_json=$(jq \
        --arg version "$normalized" \
        --arg timestamp "$timestamp" \
        --arg notes "$RELEASE_NOTES" \
        --arg git_tag "$normalized" \
        --arg changelog "$changelog_content" \
        '
        .project.releases = [
            .project.releases[] |
            if .version == $version then
                .status = "released" |
                .releasedAt = $timestamp |
                (if $notes != "" then .notes = $notes else . end) |
                (if true then .gitTag = $git_tag else . end) |
                (if $changelog != "" then .changelog = $changelog else . end)
            else .
            end
        ] |
        .lastUpdated = $timestamp
    ' "$TODO_FILE")

    # Recalculate checksum after modifying todo.json
    updated_json=$(recalculate_checksum "$updated_json")

    # @task T4248 - Route through save_json for generation counter, audit trail
    if declare -f save_json >/dev/null 2>&1; then
        echo "$updated_json" | save_json "$TODO_FILE" || {
            echo "Error: Failed to save $TODO_FILE" >&2
            return 1
        }
    else
        # Fallback for contexts where file-ops.sh isn't loaded
        echo "$updated_json" > "$TODO_FILE.tmp"
        mv "$TODO_FILE.tmp" "$TODO_FILE"
    fi

    # Refresh current_release from updated data for tag annotation
    # @task T4248
    current_release=$(echo "$updated_json" | jq --arg v "$normalized" '
        .project.releases | map(select(.version == $v)) | .[0]
    ')

    log_info "Release status set to 'released'"

    # Step 4: Create git commit if requested (before tagging)
    # @task T4248 - Renumbered: was Step 3.5, now Step 4
    local git_commit_created=false
    if [[ "$SKIP_COMMIT" != "true" ]]; then
        log_info "Creating release commit..."

        # Stage files for commit
        local files_to_stage="VERSION README.md"
        [[ -f "CHANGELOG.md" ]] && files_to_stage="$files_to_stage CHANGELOG.md"
        [[ -f "docs/changelog/overview.mdx" ]] && files_to_stage="$files_to_stage docs/changelog/overview.mdx"
        [[ -f ".cleo/todo.json" ]] && files_to_stage="$files_to_stage .cleo/todo.json"
        [[ -f "mcp-server/package.json" ]] && files_to_stage="$files_to_stage mcp-server/package.json"

        # Add version-bumped files (GH #31)
        if [[ -n "${BUMPED_FILES:-}" ]]; then
            while IFS= read -r bumped_file; do
                [[ -f "$bumped_file" ]] && files_to_stage="$files_to_stage $bumped_file"
            done <<< "$BUMPED_FILES"
        fi

        git add $files_to_stage 2>/dev/null || {
            log_warn "Some files could not be staged (may not exist)"
        }

        # Create commit with --no-verify to bypass pre-commit hooks
        # We've already done our own validation via validate_release()
        local version_no_v="${normalized#v}"
        if git commit --no-verify -m "chore: Release v$version_no_v

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"; then
            git_commit_created=true
            log_info "Release commit created"
        else
            # Check if there were actually changes to commit
            if git diff --cached --quiet; then
                log_warn "No changes to commit (files already up to date)"
                git_commit_created=true  # Allow tag creation since state is correct
            else
                log_error "Git commit failed" "E_TAG_CREATION_FAILED" "$EXIT_TAG_CREATION_FAILED" "Check git status and try again"
                exit "$EXIT_TAG_CREATION_FAILED"
            fi
        fi
    else
        log_info "Skipping git commit (--no-commit)"
    fi

    # Step 5: Create git tag if requested
    # @task T4248 - Renumbered: was Step 4, now Step 5
    if [[ "$CREATE_TAG" == "true" ]]; then
        # Check if tag already exists
        if git rev-parse "$normalized" >/dev/null 2>&1; then
            if [[ "$FORCE_TAG" != "true" ]]; then
                log_error "Tag $normalized already exists" "E_TAG_EXISTS" "$EXIT_TAG_EXISTS" "Use --force-tag to overwrite existing tag"
                exit "$EXIT_TAG_EXISTS"
            fi
            log_info "Overwriting existing git tag $normalized..."
        else
            log_info "Creating git tag $normalized..."
        fi

        # Get release name and description for tag message
        local release_name
        local release_desc
        release_name=$(echo "$current_release" | jq -r '.name // ""')
        release_desc=$(echo "$current_release" | jq -r '.notes // ""')

        local tag_message="Release $normalized"
        [[ -n "$release_name" ]] && tag_message="$tag_message: $release_name"

        # Include changelog content in tag annotation for GitHub release notes
        # Fallback chain: CHANGELOG.md section → git commit notes → release description
        local changelog_section=""
        if [[ -f "CHANGELOG.md" ]]; then
            changelog_section=$(extract_changelog_section "$normalized" "CHANGELOG.md" 2>/dev/null || echo "")
        fi

        if [[ -n "$changelog_section" ]]; then
            tag_message="$tag_message

$changelog_section"
        else
            # No CHANGELOG section available (e.g., --no-changelog was used)
            # Generate release notes from git commits as fallback
            local commit_notes=""
            if declare -f generate_changelog_from_commits >/dev/null 2>&1; then
                local prev_tag
                prev_tag=$(git describe --tags --abbrev=0 HEAD^ 2>/dev/null || echo "")
                if [[ -n "$prev_tag" ]]; then
                    commit_notes=$(generate_changelog_from_commits "$prev_tag" "HEAD" 2>/dev/null || echo "")
                fi
            fi

            if [[ -n "$commit_notes" ]]; then
                tag_message="$tag_message

$commit_notes"
            elif [[ -n "$release_desc" ]]; then
                tag_message="$tag_message

$release_desc"
            else
                log_warn "Tag annotation has no release notes content"
                log_warn "Consider running without --no-changelog or providing --notes"
            fi
        fi

        # Create tag with force flag if requested
        local tag_opts="-a"
        if [[ "$FORCE_TAG" == "true" ]]; then
            tag_opts="-fa"
        fi

        if ! git tag $tag_opts "$normalized" -m "$tag_message" 2>/dev/null; then
            log_error "Git tag creation failed" "E_TAG_CREATION_FAILED" "$EXIT_TAG_CREATION_FAILED" "Check git status and permissions"
            exit "$EXIT_TAG_CREATION_FAILED"
        fi
        git_tag_created=true
        log_info "Git tag $normalized created"

    fi

    # Step 6: Push to remote if requested
    # @task T4248 - Renumbered: was Step 5, now Step 6
    if [[ "$PUSH_TAG" == "true" ]]; then
        log_info "Pushing to remote..."

        # Detect if credentials are available (non-interactive check)
        if ! git ls-remote --exit-code --tags origin >/dev/null 2>&1; then
            log_warn "Git credential check failed - remote may not be accessible"
            log_warn "Run manually: git push origin main --tags"
        else
            # Push both commits and tags
            # Use GIT_TERMINAL_PROMPT=0 to prevent hang on credential prompt
            # Use GIT_SSH_COMMAND to disable interactive SSH
            local push_success=true

            # Push main branch if we created a commit
            if [[ "$git_commit_created" == true ]]; then
                if ! GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes" git push origin main 2>&1; then
                    log_error "Failed to push commits to remote" "E_TAG_CREATION_FAILED" "$EXIT_TAG_CREATION_FAILED" "Push manually: git push origin main"
                    push_success=false
                else
                    log_info "Commits pushed to remote"
                fi
            fi

            # Push tags (force-push if FORCE_TAG is set, e.g., during re-ship)
            if [[ "$git_tag_created" == true ]] && [[ "$push_success" == true ]]; then
                local tag_push_args=("origin" "$normalized")
                if [[ "$FORCE_TAG" == "true" ]]; then
                    tag_push_args=("origin" "$normalized" "--force")
                fi
                if ! GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes" git push "${tag_push_args[@]}" 2>&1; then
                    log_error "Failed to push tag to remote" "E_TAG_CREATION_FAILED" "$EXIT_TAG_CREATION_FAILED" "Push manually: git push origin $normalized"
                else
                    log_info "Tag pushed to remote"
                fi
            fi
        fi
    fi

    # Get updated release for output (from data written in Step 3.5)
    # @task T4248 - Old Step 6 removed; status update moved to Step 3.5
    local updated_release
    updated_release=$(jq --arg v "$normalized" '
        .project.releases | map(select(.version == $v)) | .[0]
    ' "$TODO_FILE")

    # Output result
    if [[ "$FORMAT" == "json" ]]; then
        local changelog_json="null"
        if [[ -n "$changelog_content" ]]; then
            changelog_json=$(jq -n --arg c "$changelog_content" --arg f "$changelog_file" '{content: $c, file: $f}')
        fi
        jq -n \
            --arg version "$VERSION" \
            --argjson release "$updated_release" \
            --argjson changelog "$changelog_json" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "command": "release ship",
                    "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ")),
                    "version": $version
                },
                "success": true,
                "action": "shipped",
                "release": $release,
                "changelog": $changelog
            }'
    else
        echo -e "${GREEN}${CHECK_MARK}${NC} Shipped release $normalized"
        echo "  Released at: $timestamp"
        local task_count
        task_count=$(echo "$updated_release" | jq '.tasks | length')
        echo "  Tasks shipped: $task_count"
        if [[ -n "$changelog_file" ]]; then
            echo "  Changelog: $changelog_file updated"
        fi
        if [[ "$git_tag_created" == true ]]; then
            echo "  Git tag: $normalized created"
        fi
    fi

    # Re-enable checkpoints after release flow completes
    # @task T4248
    unset GIT_CHECKPOINT_SUPPRESS
}

#####################################################################
# Subcommand: changelog
#####################################################################

cmd_changelog() {
    local version="$1"
    shift

    validate_version "$version"
    local normalized
    normalized=$(normalize_version "$version")

    # Check if release exists
    if ! release_exists "$normalized"; then
        log_error "Release $normalized not found" "E_RELEASE_NOT_FOUND" "$EXIT_RELEASE_NOT_FOUND" "Run 'cleo release list' to see available releases"
        exit "$EXIT_RELEASE_NOT_FOUND"
    fi

    # Get release date (use releasedAt if available, otherwise today)
    local release_date
    release_date=$(jq -r --arg v "$normalized" '
        .project.releases // [] |
        map(select(.version == $v)) |
        .[0].releasedAt // empty
    ' "$TODO_FILE" 2>/dev/null | cut -d'T' -f1)
    [[ -z "$release_date" ]] && release_date=$(date +%Y-%m-%d)

    # Generate changelog
    local changelog_content
    changelog_content=$(generate_changelog "$normalized" "$release_date" "$TODO_FILE")

    # Write to file if requested
    local changelog_file=""
    if [[ "$WRITE_CHANGELOG" == "true" ]]; then
        changelog_file="${CHANGELOG_OUTPUT:-CHANGELOG.md}"
        append_to_changelog "$normalized" "$changelog_file" "$TODO_FILE"
    fi

    # Output result
    if [[ "$FORMAT" == "json" ]]; then
        local changelog_json
        changelog_json=$(format_changelog_json "$normalized" "$release_date" "$TODO_FILE")
        jq -n \
            --arg cli_version "$VERSION" \
            --argjson changelog "$changelog_json" \
            --arg markdown "$changelog_content" \
            --arg file "${changelog_file:-null}" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "command": "release changelog",
                    "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ")),
                    "version": $cli_version
                },
                "success": true,
                "changelog": $changelog,
                "markdown": $markdown,
                "file": (if $file == "null" then null else $file end)
            }'
    else
        echo "$changelog_content"
        if [[ -n "$changelog_file" ]]; then
            echo ""
            echo -e "${DIM}Written to: $changelog_file${NC}"
        fi
    fi
}

#####################################################################
# Subcommand: list
#####################################################################

cmd_list() {
    # Get all releases
    local releases
    releases=$(jq '.project.releases // []' "$TODO_FILE")

    local count
    count=$(echo "$releases" | jq 'length')

    if [[ "$FORMAT" == "json" ]]; then
        jq -n \
            --arg version "$VERSION" \
            --argjson releases "$releases" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "command": "release list",
                    "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ")),
                    "version": $version
                },
                "success": true,
                "count": ($releases | length),
                "releases": $releases
            }'
        return
    fi

    # Text output
    if [[ "$count" -eq 0 ]]; then
        echo "No releases found."
        echo ""
        echo "Create a release: cleo release create v0.65.0"
        return
    fi

    echo -e "${BOLD}RELEASES${NC}"
    echo "════════════════════════════════════════════════════════════"
    printf "%-12s  %-10s  %-12s  %-6s  %s\n" "VERSION" "STATUS" "TARGET" "TASKS" "RELEASED"
    echo "────────────────────────────────────────────────────────────"

    echo "$releases" | jq -r '.[] | [.version, .status, (.targetDate // "-"), (.tasks | length | tostring), (.releasedAt // "-")] | @tsv' | \
    while IFS=$'\t' read -r ver status target tasks released; do
        local status_color
        case "$status" in
            planned) status_color="$YELLOW" ;;
            active) status_color="$CYAN" ;;
            released) status_color="$GREEN" ;;
            *) status_color="$NC" ;;
        esac

        printf "%-12s  ${status_color}%-10s${NC}  %-12s  %-6s  %s\n" "$ver" "$status" "$target" "$tasks" "$released"
    done

    echo "────────────────────────────────────────────────────────────"
    echo "Total: $count releases"
}

#####################################################################
# Subcommand: show
#####################################################################

# cmd_show - Show detailed release information with task details and auto-discovery preview
#
# @task T4435
# @epic T4431
# @why Task IDs alone lack context; showing titles and auto-discovery preview
#      helps users understand release scope and catch missing tasks
# @what Enhance cmd_show to display task titles/labels alongside IDs, and show
#       auto-discovery preview for planned/active releases in both text and JSON
cmd_show() {
    local version="$1"
    shift

    validate_version "$version"
    local normalized
    normalized=$(normalize_version "$version")

    # Check if release exists
    if ! release_exists "$normalized"; then
        log_error "Release $normalized not found" "E_RELEASE_NOT_FOUND" "$EXIT_RELEASE_NOT_FOUND" "Run 'cleo release list' to see available releases"
        exit "$EXIT_RELEASE_NOT_FOUND"
    fi

    # Get release
    local release
    release=$(get_release "$normalized")

    local status
    status=$(echo "$release" | jq -r '.status')
    local tasks_json
    tasks_json=$(echo "$release" | jq -c '.tasks // []')

    # Build task details array: look up each assigned task in todo.json
    local task_details_json="[]"
    local task_id title labels_csv
    while IFS= read -r task_id; do
        [[ -z "$task_id" ]] && continue
        title=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .title' "$TODO_FILE" 2>/dev/null)
        if [[ -n "$title" && "$title" != "null" ]]; then
            labels_csv=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | (.labels // []) | join(", ")' "$TODO_FILE" 2>/dev/null)
            task_details_json=$(echo "$task_details_json" | jq -c \
                --arg id "$task_id" \
                --arg title "$title" \
                --arg labels "$labels_csv" \
                '. + [{"id": $id, "title": $title, "labels": ($labels | split(", ") | map(select(. != "")))}]')
        else
            task_details_json=$(echo "$task_details_json" | jq -c \
                --arg id "$task_id" \
                '. + [{"id": $id, "title": "(archived or unknown)", "labels": []}]')
        fi
    done < <(echo "$tasks_json" | jq -r '.[]')

    # Auto-discovery: attempt for planned/active releases
    local auto_discovery_available=false
    local auto_discovered_ids="[]"
    local additional_tasks_json="[]"
    if [[ "$status" == "planned" || "$status" == "active" ]]; then
        if declare -f discover_release_tasks >/dev/null 2>&1; then
            local discover_output
            if discover_output=$(discover_release_tasks "$normalized" "$TODO_FILE" 2>/dev/null); then
                auto_discovery_available=true
                auto_discovered_ids="$discover_output"

                # Compute additional tasks (in auto-discovery but NOT in release.tasks[])
                additional_tasks_json=$(jq -n -c \
                    --argjson discovered "$auto_discovered_ids" \
                    --argjson assigned "$tasks_json" \
                    '[($discovered - $assigned)[]]')

                # Annotate task_details with source: "both" (in assigned + discovered) or "manual" (assigned only)
                task_details_json=$(echo "$task_details_json" | jq -c \
                    --argjson discovered "$auto_discovered_ids" \
                    '[.[] | .source = (if (.id as $i | $discovered | index($i)) then "both" else "manual" end)]')

                # Build additional_tasks details (not yet assigned)
                local additional_details="[]"
                local add_id
                while IFS= read -r add_id; do
                    [[ -z "$add_id" ]] && continue
                    title=$(jq -r --arg id "$add_id" '.tasks[] | select(.id == $id) | .title' "$TODO_FILE" 2>/dev/null)
                    if [[ -n "$title" && "$title" != "null" ]]; then
                        labels_csv=$(jq -r --arg id "$add_id" '.tasks[] | select(.id == $id) | (.labels // []) | join(", ")' "$TODO_FILE" 2>/dev/null)
                        additional_details=$(echo "$additional_details" | jq -c \
                            --arg id "$add_id" \
                            --arg title "$title" \
                            --arg labels "$labels_csv" \
                            '. + [{"id": $id, "title": $title, "labels": ($labels | split(", ") | map(select(. != "")))}]')
                    else
                        additional_details=$(echo "$additional_details" | jq -c \
                            --arg id "$add_id" \
                            '. + [{"id": $id, "title": "(archived or unknown)", "labels": []}]')
                    fi
                done < <(echo "$additional_tasks_json" | jq -r '.[]')
                additional_tasks_json="$additional_details"
            fi
        fi
    fi

    if [[ "$FORMAT" == "json" ]]; then
        local auto_discovery_obj
        if [[ "$status" == "planned" || "$status" == "active" ]]; then
            auto_discovery_obj=$(jq -n -c \
                --argjson available "$auto_discovery_available" \
                --argjson additional "$additional_tasks_json" \
                '{available: $available, additionalTasks: $additional}')
        else
            auto_discovery_obj=$(jq -n -c '{available: false, additionalTasks: []}')
        fi

        jq -n \
            --arg version "$VERSION" \
            --argjson release "$release" \
            --argjson taskDetails "$task_details_json" \
            --argjson autoDiscoveryPreview "$auto_discovery_obj" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "command": "release show",
                    "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ")),
                    "version": $version
                },
                "success": true,
                "release": $release,
                "taskDetails": $taskDetails,
                "autoDiscoveryPreview": $autoDiscoveryPreview
            }'
        return
    fi

    # Text output
    local target_date released_at notes
    target_date=$(echo "$release" | jq -r '.targetDate // "Not set"')
    released_at=$(echo "$release" | jq -r '.releasedAt // "Not released"')
    notes=$(echo "$release" | jq -r '.notes // ""')

    local status_color
    case "$status" in
        planned) status_color="$YELLOW" ;;
        active) status_color="$CYAN" ;;
        released) status_color="$GREEN" ;;
        *) status_color="$NC" ;;
    esac

    echo -e "${BOLD}Release: $normalized${NC}"
    echo "════════════════════════════════════════════════════════════"
    echo -e "Status:      ${status_color}$status${NC}"
    echo "Target Date: $target_date"
    echo "Released At: $released_at"

    local task_count
    task_count=$(echo "$tasks_json" | jq 'length')
    echo ""
    echo "Tasks ($task_count assigned):"
    if [[ "$task_count" -gt 0 ]]; then
        echo "$task_details_json" | jq -r '.[] | @json' | while IFS= read -r entry; do
            local tid tname tlabels tsource label_display source_display
            tid=$(echo "$entry" | jq -r '.id')
            tname=$(echo "$entry" | jq -r '.title')
            tlabels=$(echo "$entry" | jq -r '(.labels // []) | join(", ")')
            tsource=$(echo "$entry" | jq -r '.source // ""')
            label_display=""
            if [[ -n "$tlabels" ]]; then
                label_display="  [$tlabels]"
            fi
            source_display=""
            if [[ "$auto_discovery_available" == "true" && -n "$tsource" ]]; then
                case "$tsource" in
                    both) source_display="  (manual + auto)" ;;
                    manual) source_display="  (manual only)" ;;
                    auto) source_display="  (auto-discovered)" ;;
                esac
            fi
            echo "  $BULLET $tid  $tname${label_display}${source_display}"
        done
    else
        echo "  (no tasks assigned)"
    fi

    # Auto-discovery preview for planned/active releases
    if [[ "$status" == "planned" || "$status" == "active" ]]; then
        echo ""
        echo "Auto-Discovery Preview:"
        if [[ "$auto_discovery_available" == "true" ]]; then
            local additional_count
            additional_count=$(echo "$additional_tasks_json" | jq 'length')
            if [[ "$additional_count" -gt 0 ]]; then
                echo "  Would additionally discover ($additional_count not yet assigned):"
                echo "$additional_tasks_json" | jq -r '.[] | @json' | while IFS= read -r entry; do
                    local aid aname alabels alabel_display
                    aid=$(echo "$entry" | jq -r '.id')
                    aname=$(echo "$entry" | jq -r '.title')
                    alabels=$(echo "$entry" | jq -r '(.labels // []) | join(", ")')
                    alabel_display=""
                    if [[ -n "$alabels" ]]; then
                        alabel_display="  [$alabels]"
                    fi
                    echo "    $BULLET $aid  $aname${alabel_display}"
                done
            else
                echo "  (no additional tasks to discover)"
            fi
        else
            echo "  (auto-discovery not available — release has no timestamp yet)"
        fi
    fi

    if [[ -n "$notes" && "$notes" != "null" ]]; then
        echo ""
        echo "Notes:"
        echo "  $notes"
    fi
}

#####################################################################
# Subcommand: init-ci
#####################################################################

# @task T2670
# @epic T2666
cmd_init_ci() {
    log_info "Initializing CI/CD workflow configuration..."

    # Call generate_ci_config from lib/release/release-ci.sh
    if declare -f generate_ci_config >/dev/null 2>&1; then
        if generate_ci_config "$CI_PLATFORM" "$CI_OUTPUT" "$DRY_RUN" "$CI_FORCE"; then
            if [[ "$FORMAT" == "json" ]]; then
                local platform="${CI_PLATFORM:-$(get_ci_platform)}"
                local output="${CI_OUTPUT:-${PLATFORM_PATHS[$platform]}}"
                jq -n \
                    --arg version "$VERSION" \
                    --arg platform "$platform" \
                    --arg output "$output" \
                    --argjson dryRun "$DRY_RUN" \
                    '{
                        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                        "_meta": {
                            "format": "json",
                            "command": "release init-ci",
                            "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ")),
                            "version": $version
                        },
                        "success": true,
                        "platform": $platform,
                        "outputFile": $output,
                        "dryRun": $dryRun
                    }'
            else
                echo -e "${GREEN}${CHECK_MARK}${NC} CI/CD configuration initialized"
            fi
            return 0
        else
            log_error "CI/CD configuration failed" "E_CI_INIT_FAILED" 72 "Check platform support and template availability"
            exit 72
        fi
    else
        log_error "CI template generator not available" "E_CI_INIT_FAILED" 72 "lib/release/release-ci.sh not loaded"
        exit 72
    fi
}

# cmd_validate - Validate release protocol compliance for a task
# Args: $1 = task_id
cmd_validate() {
    local task_id="$1"

    # Source protocol validation library if not already loaded
    if ! declare -f validate_release_protocol &>/dev/null; then
        if [[ -f "$LIB_DIR/validation/protocol-validation.sh" ]]; then
            source "$LIB_DIR/validation/protocol-validation.sh"
        else
            log_error "Protocol validation library not found" "E_FILE_NOT_FOUND" "$EXIT_NOT_FOUND"
            exit "$EXIT_NOT_FOUND"
        fi
    fi

    local manifest_path="claudedocs/agent-outputs/MANIFEST.jsonl"

    # Find manifest entry for task
    if [[ ! -f "$manifest_path" ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            jq -nc \
                --arg error "Manifest not found: $manifest_path" \
                --argjson exit_code "$EXIT_NOT_FOUND" \
                '{
                    "success": false,
                    "error": {
                        "message": $error,
                        "code": "E_FILE_NOT_FOUND",
                        "exitCode": $exit_code
                    }
                }'
        else
            echo "Error: Manifest not found: $manifest_path" >&2
        fi
        exit "$EXIT_NOT_FOUND"
    fi

    local manifest_entry
    manifest_entry=$(grep "\"linked_tasks\".*\"$task_id\"" "$manifest_path" | tail -1 || true)

    if [[ -z "$manifest_entry" ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            jq -nc \
                --arg task_id "$task_id" \
                --arg error "No manifest entry found for task" \
                --argjson exit_code "$EXIT_NOT_FOUND" \
                '{
                    "success": false,
                    "error": {
                        "message": $error,
                        "taskId": $task_id,
                        "code": "E_TASK_NOT_FOUND",
                        "exitCode": $exit_code
                    }
                }'
        else
            echo "Error: No manifest entry found for task $task_id" >&2
        fi
        exit "$EXIT_NOT_FOUND"
    fi

    # Validate release protocol (strict mode if --strict flag was set)
    local strict="${STRICT:-false}"
    set +e
    local result
    result=$(validate_release_protocol "$task_id" "$manifest_entry" "$strict")
    local exit_code=$?
    set -e

    # Output result
    if [[ "$FORMAT" == "json" ]]; then
        echo "$result"
    else
        # Human-readable format
        local valid
        valid=$(echo "$result" | jq -r '.valid')
        local score
        score=$(echo "$result" | jq -r '.score')
        local violations_count
        violations_count=$(echo "$result" | jq -r '.violations | length')

        echo ""
        echo "Release Protocol Validation"
        echo "==========================="
        echo ""
        echo "  Task ID:    $task_id"
        echo "  Valid:      $valid"
        echo "  Score:      $score/100"
        echo "  Violations: $violations_count"
        echo ""

        if [[ "$violations_count" -gt 0 ]]; then
            echo "Violations:"
            echo "$result" | jq -r '.violations[] | "  - [\(.severity | ascii_upcase)] \(.requirement): \(.message)"'
            echo ""
            echo "Fixes:"
            echo "$result" | jq -r '.violations[] | "  - \(.fix)"'
            echo ""
        fi
    fi

    exit "$exit_code"
}

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

    # Parse subcommand and command-specific arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            create|plan|ship|list|show|changelog|init-ci|validate)
                SUBCOMMAND="$1"
                shift
                # Get version argument for subcommands that need it
                if [[ "$SUBCOMMAND" != "list" && "$SUBCOMMAND" != "init-ci" && $# -gt 0 && ! "$1" =~ ^- ]]; then
                    VERSION_ARG="$1"
                    shift
                fi
                continue
                ;;
            --target-date)
                shift
                TARGET_DATE="$1"
                shift
                continue
                ;;
            --tasks)
                shift
                TASKS_TO_ADD="$1"
                shift
                continue
                ;;
            --remove)
                shift
                TASKS_TO_REMOVE="$1"
                shift
                continue
                ;;
            --notes)
                shift
                RELEASE_NOTES="$1"
                shift
                continue
                ;;
            --bump-version)
                BUMP_VERSION="true"
                shift
                continue
                ;;
            --create-tag)
                CREATE_TAG="true"
                shift
                continue
                ;;
            --force-tag)
                FORCE_TAG="true"
                shift
                continue
                ;;
            --force)
                # Can be used for --force-tag, CI init --force, ship guard override, and reship
                # @task T4434
                if [[ "$SUBCOMMAND" == "init-ci" ]]; then
                    CI_FORCE="true"
                elif [[ "$SUBCOMMAND" == "ship" ]]; then
                    FORCE_TAG="true"
                    FORCE_GUARDS="true"
                    FORCE_RESHIP="true"
                else
                    FORCE_TAG="true"
                fi
                shift
                continue
                ;;
            --platform)
                shift
                CI_PLATFORM="$1"
                shift
                continue
                ;;
            --run-tests)
                RUN_TESTS="true"
                shift
                continue
                ;;
            --skip-validation)
                SKIP_VALIDATION="true"
                shift
                continue
                ;;
            --strict)
                STRICT="true"
                shift
                continue
                ;;
            --push)
                PUSH_TAG="true"
                shift
                continue
                ;;
            --dry-run)
                DRY_RUN="true"
                shift
                continue
                ;;
            --preview)
                PREVIEW="true"
                shift
                continue
                ;;
            --no-commit)
                SKIP_COMMIT="true"
                shift
                continue
                ;;
            --no-changelog)
                SKIP_CHANGELOG="true"
                shift
                continue
                ;;
            --write-changelog)
                WRITE_CHANGELOG="true"
                shift
                continue
                ;;
            --output)
                shift
                # Can be used for both changelog and CI output
                if [[ "$SUBCOMMAND" == "init-ci" ]]; then
                    CI_OUTPUT="$1"
                else
                    CHANGELOG_OUTPUT="$1"
                fi
                shift
                continue
                ;;
            -h|--help)
                usage
                ;;
            -*)
                log_error "Unknown option: $1" "E_INVALID_INPUT" "${EXIT_INVALID_INPUT:-2}"
                usage
                ;;
            *)
                # Unknown positional - may be version for subcommand
                if [[ -z "$SUBCOMMAND" ]]; then
                    log_error "Unknown subcommand: $1" "E_INVALID_INPUT" "${EXIT_INVALID_INPUT:-2}" "Valid subcommands: create, plan, ship, list, show, changelog"
                    exit "${EXIT_INVALID_INPUT:-2}"
                elif [[ -z "$VERSION_ARG" ]]; then
                    VERSION_ARG="$1"
                fi
                shift
                ;;
        esac
    done

    # Auto-detect format based on TTY
    if [[ -z "$FORMAT" ]]; then
        if [[ -t 1 ]]; then
            FORMAT="human"
        else
            FORMAT="json"
        fi
    fi
}

#####################################################################
# Main
#####################################################################

main() {
    parse_args "$@"

    check_deps

    # Check if todo.json exists
    if [[ ! -f "$TODO_FILE" ]]; then
        log_error "todo.json not found. Run 'cleo init' first." "E_NOT_INITIALIZED" "${EXIT_NOT_FOUND:-4}" "Run 'cleo init' to initialize"
        exit "${EXIT_NOT_FOUND:-4}"
    fi

    # Execute subcommand
    case "$SUBCOMMAND" in
        create)
            if [[ -z "$VERSION_ARG" ]]; then
                log_error "Version required. Usage: cleo release create <version>" "E_INVALID_INPUT" "${EXIT_INVALID_INPUT:-2}"
                exit "${EXIT_INVALID_INPUT:-2}"
            fi
            cmd_create "$VERSION_ARG"
            ;;
        plan)
            if [[ -z "$VERSION_ARG" ]]; then
                log_error "Version required. Usage: cleo release plan <version> --tasks T001,T002" "E_INVALID_INPUT" "${EXIT_INVALID_INPUT:-2}"
                exit "${EXIT_INVALID_INPUT:-2}"
            fi
            cmd_plan "$VERSION_ARG"
            ;;
        ship)
            if [[ -z "$VERSION_ARG" ]]; then
                log_error "Version required. Usage: cleo release ship <version>" "E_INVALID_INPUT" "${EXIT_INVALID_INPUT:-2}"
                exit "${EXIT_INVALID_INPUT:-2}"
            fi
            cmd_ship "$VERSION_ARG"
            ;;
        list)
            cmd_list
            ;;
        show)
            if [[ -z "$VERSION_ARG" ]]; then
                log_error "Version required. Usage: cleo release show <version>" "E_INVALID_INPUT" "${EXIT_INVALID_INPUT:-2}"
                exit "${EXIT_INVALID_INPUT:-2}"
            fi
            cmd_show "$VERSION_ARG"
            ;;
        changelog)
            if [[ -z "$VERSION_ARG" ]]; then
                log_error "Version required. Usage: cleo release changelog <version>" "E_INVALID_INPUT" "${EXIT_INVALID_INPUT:-2}"
                exit "${EXIT_INVALID_INPUT:-2}"
            fi
            cmd_changelog "$VERSION_ARG"
            ;;
        init-ci)
            cmd_init_ci
            ;;
        validate)
            if [[ -z "$VERSION_ARG" ]]; then
                log_error "Task ID required. Usage: cleo release validate <task-id>" "E_INVALID_INPUT" "${EXIT_INVALID_INPUT:-2}"
                exit "${EXIT_INVALID_INPUT:-2}"
            fi
            cmd_validate "$VERSION_ARG"
            ;;
        "")
            log_error "Subcommand required" "E_INVALID_INPUT" "${EXIT_INVALID_INPUT:-2}" "Valid subcommands: create, plan, ship, list, show, changelog, init-ci, validate"
            usage
            ;;
        *)
            log_error "Unknown subcommand: $SUBCOMMAND" "E_INVALID_INPUT" "${EXIT_INVALID_INPUT:-2}" "Valid subcommands: create, plan, ship, list, show, changelog, init-ci, validate"
            exit "${EXIT_INVALID_INPUT:-2}"
            ;;
    esac
}

main "$@"
