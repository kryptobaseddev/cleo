#!/usr/bin/env bash
# release.sh - Release management library functions
#
# PURPOSE: Shared functionality for release workflow (validation, git ops, etc.)
# LAYER: 3 (Feature Layer)
# DEPENDENCIES: config.sh
# PROVIDES: validate_release_prerequisites, run_release_gates, prepare_changelog_header

#=== SOURCE GUARD ================================================
[[ -n "${_RELEASE_LIB_LOADED:-}" ]] && return 0
declare -r _RELEASE_LIB_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source config for gate functions (Layer 2)
if [[ -f "$_LIB_DIR/core/config.sh" ]]; then
    # shellcheck source=lib/core/config.sh
    source "$_LIB_DIR/core/config.sh"
fi

# ============================================================================
# LOGGING HELPERS
# ============================================================================

# Note: These are lightweight fallbacks. Scripts that source this lib
# should provide their own logging functions with proper colors/formatting.

_release_log_info() {
    local message="$1"
    echo "[INFO] $message" >&2
}

_release_log_warn() {
    local message="$1"
    echo "[WARN] $message" >&2
}

_release_log_error() {
    local message="$1"
    echo "[ERROR] $message" >&2
}

_release_log_step() {
    local message="$1"
    echo "[→] $message" >&2
}

# ============================================================================
# VALIDATION FUNCTIONS
# ============================================================================

# validate_release_prerequisites - Run test suite before release
#
# Args:
#   $1 - (optional) skip_tests flag (true/false, default: false)
#
# Returns:
#   0 - Tests passed or skipped
#   1 - Tests failed
#
# Uses config.json to determine test command and framework
validate_release_prerequisites() {
    local skip_tests="${1:-false}"

    if [[ "$skip_tests" == "true" ]]; then
        _release_log_warn "Skipping test validation (--skip-tests)"
        return 0
    fi

    # Get test command from config (fallback to default)
    local test_cmd
    test_cmd=$(get_test_command 2>/dev/null || echo "./tests/run-all-tests.sh")

    local framework
    framework=$(get_test_framework 2>/dev/null || echo "bats")

    _release_log_step "Running tests with $framework framework..."
    _release_log_info "Command: $test_cmd"

    # Execute tests
    if ! eval "$test_cmd" >/dev/null 2>&1; then
        _release_log_error "Tests failed - release blocked"
        _release_log_info "Fix: Run '$test_cmd' and fix failures before release"
        return 1
    fi

    _release_log_info "All tests passed"
    return 0
}

# run_release_gates - Execute custom validation gates from config
#
# Returns:
#   0 - All required gates passed
#   1 - One or more required gates failed
#
# Uses config.json release.gates configuration (T2844)
run_release_gates() {
    local gates_json
    gates_json=$(get_release_gates 2>/dev/null || echo "[]")

    # Check if any gates defined
    local gate_count
    gate_count=$(echo "$gates_json" | jq 'length' 2>/dev/null || echo "0")

    if [[ "$gate_count" -eq 0 ]]; then
        _release_log_info "No custom validation gates configured"
        return 0
    fi

    _release_log_step "Running $gate_count custom validation gate(s)..."

    local failed_required=0
    local gate_index=0

    while IFS= read -r gate; do
        local name command required description
        name=$(echo "$gate" | jq -r '.name')
        command=$(echo "$gate" | jq -r '.command')
        required=$(echo "$gate" | jq -r '.required // false')
        description=$(echo "$gate" | jq -r '.description // ""')

        _release_log_step "Gate: $name${description:+ - $description}"

        # Execute gate command
        if eval "$command" >/dev/null 2>&1; then
            _release_log_info "  ✓ $name passed"
        else
            if [[ "$required" == "true" ]]; then
                _release_log_error "  ✗ $name FAILED (required - blocking release)"
                ((failed_required++))
            else
                _release_log_warn "  ⚠ $name failed (optional - continuing)"
            fi
        fi

        ((gate_index++))
    done < <(echo "$gates_json" | jq -c '.[]')

    if [[ $failed_required -gt 0 ]]; then
        _release_log_error "$failed_required required gate(s) failed - release blocked"
        return 1
    fi

    _release_log_info "All required gates passed"
    return 0
}

# ============================================================================
# CHANGELOG PREPARATION
# ============================================================================

# prepare_changelog_header - Create version header in CHANGELOG.md
#
# Args:
#   $1 - version (e.g., "v0.75.0" or "0.75.0")
#   $2 - (optional) date (YYYY-MM-DD format, default: today)
#   $3 - (optional) changelog path (default: CHANGELOG.md)
#
# Returns:
#   0 - Header created or already exists
#   1 - Failed to create header
#
# Idempotent: Safe to call multiple times
prepare_changelog_header() {
    local version="$1"
    local date="${2:-$(date +%Y-%m-%d)}"
    local changelog="${3:-CHANGELOG.md}"

    # Skip if changelog doesn't exist
    if [[ ! -f "$changelog" ]]; then
        _release_log_warn "CHANGELOG.md not found, skipping version header preparation"
        return 0
    fi

    # Normalize version (strip v prefix for header)
    local version_no_v="${version#v}"

    # Check if version header already exists (idempotent)
    if grep -q "^## \[${version_no_v}\]" "$changelog"; then
        _release_log_info "Changelog header for $version_no_v already exists"
        return 0
    fi

    _release_log_step "Creating version header for $version_no_v in $changelog..."

    # Create new version header
    local version_header="## [$version_no_v] - $date"

    # Check if Unreleased section exists; create one if missing
    if ! grep -q "^## \[Unreleased\]" "$changelog"; then
        _release_log_warn "No [Unreleased] section found - creating one"
        # Find the first version header to insert before
        local first_version_line
        first_version_line=$(grep -n "^## \[" "$changelog" | head -1 | cut -d: -f1 || true)

        if [[ -n "$first_version_line" ]]; then
            sed -i "${first_version_line}i\\
## [Unreleased]\\
" "$changelog"
        else
            # No version headers - append after file header
            echo -e "\n## [Unreleased]\n" >> "$changelog"
        fi
    fi

    # T2864: Fixed awk logic to correctly insert version header
    # The new version header must come AFTER [Unreleased] but BEFORE any existing versions
    awk -v header="$version_header" '
        /^## \[Unreleased\]/ {
            print               # Print [Unreleased]
            getline             # Read next line
            # If next line is blank, print it and read another
            if ($0 ~ /^[[:space:]]*$/) {
                print           # Print blank line
                getline         # Read the line after blank
            }
            # Now insert new version header before any existing version headers
            print ""            # Ensure blank line before new header
            print header        # Print new version header
            print ""            # Blank line after header
            # If current line is a version header, print it (dont lose it)
            if ($0 ~ /^## \[/) {
                print
            } else if ($0 !~ /^[[:space:]]*$/) {
                # Print non-blank content that was under [Unreleased]
                print
            }
            next
        }
        { print }
    ' "$changelog" > "${changelog}.tmp"

    # Atomic replace
    mv "${changelog}.tmp" "$changelog"

    _release_log_info "Created version header: $version_header"
    return 0
}

# ============================================================================
# GIT OPERATIONS
# ============================================================================

# create_release_commit - Create git commit for release
#
# Args:
#   $1 - version (e.g., "v0.75.0")
#   $2 - (optional) additional files to stage (space-separated)
#
# Returns:
#   0 - Commit created successfully
#   1 - Commit failed or nothing to commit
create_release_commit() {
    local version="$1"
    local additional_files="${2:-}"

    _release_log_step "Staging changes..."

    # Always stage VERSION, README.md, and CHANGELOG.md if they exist
    local files_to_stage="VERSION"
    [[ -f "README.md" ]] && files_to_stage="$files_to_stage README.md"
    [[ -f "CHANGELOG.md" ]] && files_to_stage="$files_to_stage CHANGELOG.md"

    # Add Mintlify changelog if exists
    [[ -f "docs/changelog/overview.mdx" ]] && files_to_stage="$files_to_stage docs/changelog/overview.mdx"

    # Add any additional files
    if [[ -n "$additional_files" ]]; then
        files_to_stage="$files_to_stage $additional_files"
    fi

    # Stage files
    git add $files_to_stage 2>/dev/null || {
        _release_log_error "Failed to stage files for commit"
        return 1
    }

    _release_log_step "Creating commit..."

    # Strip v prefix for commit message
    local version_no_v="${version#v}"

    if ! git commit -m "chore: Release v$version_no_v

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"; then
        _release_log_warn "Nothing to commit or commit failed"
        return 1
    fi

    _release_log_info "Commit created"
    return 0
}

# create_release_tag - Create annotated git tag for release
#
# Args:
#   $1 - version (e.g., "v0.75.0")
#   $2 - (optional) tag message (default: "Release <version>")
#   $3 - (optional) force flag (true/false, default: false)
#
# Returns:
#   0 - Tag created successfully
#   1 - Tag creation failed
create_release_tag() {
    local version="$1"
    local tag_message="${2:-Release $version}"
    local force="${3:-false}"

    # Check if tag already exists
    if git rev-parse "$version" >/dev/null 2>&1; then
        if [[ "$force" != "true" ]]; then
            _release_log_error "Tag $version already exists (use force=true to overwrite)"
            return 1
        fi
        _release_log_info "Overwriting existing git tag $version..."
    else
        _release_log_step "Creating git tag $version..."
    fi

    # Create tag with force flag if requested
    local tag_opts="-a"
    if [[ "$force" == "true" ]]; then
        tag_opts="-fa"
    fi

    if ! git tag $tag_opts "$version" -m "$tag_message" 2>/dev/null; then
        _release_log_error "Git tag creation failed"
        return 1
    fi

    _release_log_info "Git tag $version created"
    return 0
}

# push_release_tag - Push git tag to remote
#
# Args:
#   $1 - version (e.g., "v0.75.0")
#   $2 - (optional) remote name (default: origin)
#   $3 - (optional) force flag (true/false, default: false)
#
# Returns:
#   0 - Tag pushed successfully
#   1 - Push failed
push_release_tag() {
    local version="$1"
    local remote="${2:-origin}"
    local force="${3:-false}"

    _release_log_step "Pushing tag to $remote..."

    # Detect if credentials are available (non-interactive check)
    if ! git ls-remote --exit-code --tags "$remote" >/dev/null 2>&1; then
        _release_log_warn "Git credential check failed - remote may not be accessible"
        _release_log_warn "Run manually: git push $remote $version"
        return 1
    fi

    # Build push command
    local push_cmd="git push"
    [[ "$force" == "true" ]] && push_cmd="$push_cmd --force"
    push_cmd="$push_cmd $remote $version"

    # Use GIT_TERMINAL_PROMPT=0 to prevent hang on credential prompt
    # Use GIT_SSH_COMMAND to disable interactive SSH
    if ! GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes" $push_cmd 2>&1; then
        _release_log_error "Failed to push tag to remote"
        _release_log_info "Push manually: git push $remote $version"
        return 1
    fi

    _release_log_info "Tag pushed to $remote"
    return 0
}
