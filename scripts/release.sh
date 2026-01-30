#!/usr/bin/env bash

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
#   cleo release changelog v0.65.0 --write-changelog
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
source_lib "changelog.sh"

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

Options:
    --target-date DATE   Set target release date (YYYY-MM-DD)
    --tasks T001,T002    Tasks to include (comma-separated)
    --remove T003        Remove task from release (for plan)
    --notes "text"       Release notes or summary
    --bump-version       Bump VERSION file via dev/bump-version.sh (for ship)
    --create-tag         Create git tag for release (for ship)
    --force-tag          Overwrite existing git tag (requires --create-tag)
    --push               Push git tag to remote (requires --create-tag)
    --run-tests          Run test suite during validation (opt-in, slow)
    --skip-validation    Skip all validation gates (for emergency releases)
    --write-changelog    Write changelog to CHANGELOG.md (for ship/changelog)
    --output FILE        Output file for changelog (default: CHANGELOG.md)
    --format, -f FORMAT  Output format: text | json (default: auto)
    --json               Shortcut for --format json
    --human              Shortcut for --format text
    -h, --help           Show this help message

Release Status Flow:
    planned → active → released

Examples:
    cleo release create v0.65.0 --target-date 2026-02-01
    cleo release plan v0.65.0 --tasks T2058,T2059
    cleo release ship v0.65.0 --bump-version --create-tag --write-changelog
    cleo release ship v0.65.0 --bump-version --create-tag --push
    cleo release ship v0.65.0 --notes "Schema 2.8.0 release"
    cleo release list
    cleo release show v0.65.0
    cleo release changelog v0.65.0

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

# Format-aware log_error
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

# Validation gates (Part 5 from spec)
# @task T2739
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

        # Check 3: All task IDs exist in todo.json
        local task_ids
        task_ids=$(grep -oP '\(T\d+\)' <<< "$section_content" | tr -d '()' || echo "")
        if [[ -n "$task_ids" ]]; then
            while IFS= read -r task_id; do
                [[ -z "$task_id" ]] && continue
                if ! jq -e ".tasks[] | select(.id == \"$task_id\")" "$TODO_FILE" >/dev/null 2>&1; then
                    log_error "Invalid task ID in changelog" "E_VALIDATION_FAILED" "$EXIT_VALIDATION_FAILED" "Task $task_id in CHANGELOG.md not found in todo.json"
                    return "$EXIT_VALIDATION_FAILED"
                fi
            done <<< "$task_ids"
        fi

        [[ "$VERBOSE" == true ]] && log_info "Changelog validation passed"
    else
        [[ "$VERBOSE" == true ]] && log_warn "Changelog validation SKIPPED (--skip-changelog)"
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

    # Atomic write
    echo "$updated_json" > "$TODO_FILE.tmp"
    mv "$TODO_FILE.tmp" "$TODO_FILE"

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

    # Atomic write
    echo "$updated_json" > "$TODO_FILE.tmp"
    mv "$TODO_FILE.tmp" "$TODO_FILE"

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
        log_error "Release $normalized is already released" "E_RELEASE_LOCKED" "$EXIT_RELEASE_LOCKED" "Cannot ship an already released version"
        exit "$EXIT_RELEASE_LOCKED"
    fi

    # Step 0: Auto-populate release tasks using hybrid date+label strategy
    log_info "Discovering tasks for $normalized..."
    if ! populate_release_tasks "$normalized" "$TODO_FILE"; then
        log_error "Failed to populate release tasks" "E_CHANGELOG_GENERATION_FAILED" "$EXIT_CHANGELOG_GENERATION_FAILED" "Check that release exists in todo.json"
        exit "$EXIT_CHANGELOG_GENERATION_FAILED"
    fi
    log_info "Release tasks populated successfully"

    # Step 1: Bump VERSION if requested
    if [[ "$BUMP_VERSION" == "true" ]]; then
        log_info "Bumping VERSION to $normalized..."
        local bump_script="./dev/bump-version.sh"
        if [[ ! -x "$bump_script" ]]; then
            log_error "VERSION bump script not found" "E_VERSION_BUMP_FAILED" "$EXIT_VERSION_BUMP_FAILED" "Ensure dev/bump-version.sh exists and is executable"
            exit "$EXIT_VERSION_BUMP_FAILED"
        fi

        # Strip v prefix for bump-version.sh (expects X.Y.Z format)
        local version_no_v="${normalized#v}"
        if ! "$bump_script" "$version_no_v" --quiet; then
            log_error "VERSION bump failed" "E_VERSION_BUMP_FAILED" "$EXIT_VERSION_BUMP_FAILED" "Check dev/bump-version.sh output"
            exit "$EXIT_VERSION_BUMP_FAILED"
        fi
        log_info "VERSION bumped successfully"
    fi

    # Step 2: ALWAYS generate changelog (mandatory per CHANGELOG-GENERATION-SPEC.md)
    local changelog_content=""
    local changelog_file="${CHANGELOG_OUTPUT:-CHANGELOG.md}"

    if [[ "${SKIP_CHANGELOG:-false}" == "true" ]]; then
        log_warn "SKIPPING changelog generation (--skip-changelog)"
        log_warn "You MUST manually update CHANGELOG.md before release"
    else
        log_info "Generating changelog for $normalized..."

        # Generate changelog using lib/changelog.sh
        if ! changelog_content=$(generate_changelog "$normalized" "" "$TODO_FILE"); then
            log_error "Changelog generation failed" "E_CHANGELOG_GENERATION_FAILED" "$EXIT_CHANGELOG_GENERATION_FAILED" "Check lib/changelog.sh:generate_changelog()"
            exit "$EXIT_CHANGELOG_GENERATION_FAILED"
        fi

        # Append to CHANGELOG.md
        if ! append_to_changelog "$normalized" "$changelog_file" "$TODO_FILE"; then
            log_error "Failed to write CHANGELOG.md" "E_CHANGELOG_GENERATION_FAILED" "$EXIT_CHANGELOG_GENERATION_FAILED" "Check file permissions"
            exit "$EXIT_CHANGELOG_GENERATION_FAILED"
        fi
        log_info "Changelog generated and written to $changelog_file"
    fi

    # Step 3: Run validation gates
    if ! validate_release "$normalized"; then
        log_error "Release validation failed" "E_VALIDATION_FAILED" "$EXIT_VALIDATION_FAILED" "Fix validation errors before shipping"
        exit "$EXIT_VALIDATION_FAILED"
    fi

    # Step 4: Create git tag if requested
    local git_tag_created=false
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
        [[ -n "$release_desc" ]] && tag_message="$tag_message

$release_desc"

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

        # Push tag if requested
        if [[ "$PUSH_TAG" == "true" ]]; then
            log_info "Pushing tag to remote..."

            # Detect if credentials are available (non-interactive check)
            if ! git ls-remote --exit-code --tags origin >/dev/null 2>&1; then
                log_warn "Git credential check failed - remote may not be accessible"
                log_warn "Run manually: git push origin $normalized"
            else
                # Use GIT_TERMINAL_PROMPT=0 to prevent hang on credential prompt
                # Use GIT_SSH_COMMAND to disable interactive SSH
                if ! GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes" git push origin "$normalized" 2>&1; then
                    log_error "Failed to push tag to remote" "E_TAG_CREATION_FAILED" "$EXIT_TAG_CREATION_FAILED" "Push manually: git push origin $normalized"
                    # Don't exit - tag was created successfully locally
                else
                    log_info "Tag pushed to remote"
                fi
            fi
        fi
    fi

    # Step 5: Update release status to shipped
    local timestamp
    timestamp=$(get_timestamp)

    local updated_json
    updated_json=$(jq \
        --arg version "$normalized" \
        --arg timestamp "$timestamp" \
        --arg notes "$RELEASE_NOTES" \
        --arg git_tag "$normalized" \
        --arg changelog "$changelog_content" \
        --argjson tag_created "$git_tag_created" \
        '
        .project.releases = [
            .project.releases[] |
            if .version == $version then
                .status = "released" |
                .releasedAt = $timestamp |
                (if $notes != "" then .notes = $notes else . end) |
                (if $tag_created then .gitTag = $git_tag else . end) |
                (if $changelog != "" then .changelog = $changelog else . end)
            else .
            end
        ] |
        .lastUpdated = $timestamp
    ' "$TODO_FILE")

    # Atomic write
    echo "$updated_json" > "$TODO_FILE.tmp"
    mv "$TODO_FILE.tmp" "$TODO_FILE"

    # Get updated release for output
    local updated_release
    updated_release=$(echo "$updated_json" | jq --arg v "$normalized" '
        .project.releases | map(select(.version == $v)) | .[0]
    ')

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

    if [[ "$FORMAT" == "json" ]]; then
        jq -n \
            --arg version "$VERSION" \
            --argjson release "$release" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "command": "release show",
                    "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ")),
                    "version": $version
                },
                "success": true,
                "release": $release
            }'
        return
    fi

    # Text output
    local status target_date released_at tasks notes
    status=$(echo "$release" | jq -r '.status')
    target_date=$(echo "$release" | jq -r '.targetDate // "Not set"')
    released_at=$(echo "$release" | jq -r '.releasedAt // "Not released"')
    tasks=$(echo "$release" | jq -r '.tasks // []')
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
    task_count=$(echo "$tasks" | jq 'length')
    echo ""
    echo "Tasks ($task_count):"
    if [[ "$task_count" -gt 0 ]]; then
        echo "$tasks" | jq -r '.[]' | while read -r task_id; do
            echo "  $BULLET $task_id"
        done
    else
        echo "  (no tasks assigned)"
    fi

    if [[ -n "$notes" && "$notes" != "null" ]]; then
        echo ""
        echo "Notes:"
        echo "  $notes"
    fi
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
            create|plan|ship|list|show|changelog)
                SUBCOMMAND="$1"
                shift
                # Get version argument for subcommands that need it
                if [[ "$SUBCOMMAND" != "list" && $# -gt 0 && ! "$1" =~ ^- ]]; then
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
            --push)
                PUSH_TAG="true"
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
                CHANGELOG_OUTPUT="$1"
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
        "")
            log_error "Subcommand required" "E_INVALID_INPUT" "${EXIT_INVALID_INPUT:-2}" "Valid subcommands: create, plan, ship, list, show, changelog"
            usage
            ;;
        *)
            log_error "Unknown subcommand: $SUBCOMMAND" "E_INVALID_INPUT" "${EXIT_INVALID_INPUT:-2}" "Valid subcommands: create, plan, ship, list, show, changelog"
            exit "${EXIT_INVALID_INPUT:-2}"
            ;;
    esac
}

main "$@"
