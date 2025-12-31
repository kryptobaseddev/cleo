#!/usr/bin/env bash
# bump-version.sh - Single command to bump version everywhere with validation
#
# This script follows LLM-Agent-First principles:
# - --format, --quiet, --json, --human flags
# - DEV_EXIT_* constants (no magic exit numbers)
# - Centralized version loading
#
# Usage:
#   ./dev/bump-version.sh 0.12.6
#   ./dev/bump-version.sh patch   # 0.12.5 -> 0.12.6
#   ./dev/bump-version.sh minor   # 0.12.5 -> 0.13.0
#   ./dev/bump-version.sh major   # 0.12.5 -> 1.0.0
#   ./dev/bump-version.sh --dry-run patch
#   ./dev/bump-version.sh --no-validate minor
#   ./dev/bump-version.sh --format json patch

set -euo pipefail

# ============================================================================
# SETUP - LLM-Agent-First compliant
# ============================================================================

# Script location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_LIB_DIR="$SCRIPT_DIR/lib"

# Source dev library (with fallback for compatibility)
if [[ -d "$DEV_LIB_DIR" ]] && [[ -f "$DEV_LIB_DIR/dev-common.sh" ]]; then
    source "$DEV_LIB_DIR/dev-common.sh"
else
    # Fallback definitions if dev-common.sh not available
    RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; NC='\033[0m'
    log_info() { echo -e "${GREEN}✓${NC} $1"; }
    log_warn() { echo -e "${YELLOW}⚠${NC} $1"; }
    log_error() { echo -e "${RED}✗${NC} $1" >&2; }
    log_step() { echo -e "${BLUE}→${NC} $1"; }
    dev_resolve_format() {
        local f="${1:-}"; [[ -n "$f" ]] && echo "$f" && return
        [[ -t 1 ]] && echo "text" || echo "json"
    }
    # Define exit codes if not available
    DEV_EXIT_SUCCESS=0
    DEV_EXIT_GENERAL_ERROR=1
    DEV_EXIT_INVALID_INPUT=2
    DEV_EXIT_NOT_FOUND=4
    DEV_EXIT_VERSION_INVALID=10
    DEV_EXIT_BUMP_FAILED=20
fi

# Project paths
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
VERSION_FILE="$PROJECT_ROOT/VERSION"
VALIDATE_SCRIPT="$SCRIPT_DIR/validate-version.sh"

# Command identification (for error reporting and JSON output)
COMMAND_NAME="bump-version"

# Load version from central file
TOOL_VERSION=$(cat "$PROJECT_ROOT/VERSION" 2>/dev/null || echo "0.1.0")

# Options
DRY_RUN=false
NO_VALIDATE=false
VERBOSE=false
FORMAT=""
QUIET=false

usage() {
    cat << EOF
Usage: bump-version.sh [OPTIONS] <version|patch|minor|major>

Arguments:
  <version>   Explicit version (e.g., 0.12.6)
  patch       Increment patch version (0.12.5 -> 0.12.6)
  minor       Increment minor version (0.12.5 -> 0.13.0)
  major       Increment major version (0.12.5 -> 1.0.0)

Options:
  --dry-run           Show what would be changed without making changes
  --no-validate       Skip validation checks (for automation)
  --verbose           Show detailed progress
  -f, --format <fmt>  Output format: text, json (default: auto-detect TTY)
  --json              Shortcut for --format json
  --human             Shortcut for --format text
  -q, --quiet         Only show errors and final result
  -h, --help          Show this help message
  --version           Show version

This script updates:
  - VERSION file (source of truth)
  - README.md badge
  - templates/CLAUDE-INJECTION.md version tag
  - CLAUDE.md injection tag (if present)
  - plugin/plugin.json version (if present)

Features:
  - Pre-bump validation of current version
  - Post-bump validation of all updates
  - Automatic backup creation (.bak files)
  - Rollback on failure (keeps .bak files for recovery)

After running, you should:
  1. Update CHANGELOG.md with changes for v<VERSION>
  2. git add -A && git commit -m 'chore: Bump to v<VERSION>'
  3. ./install.sh --force
  4. git push origin main
EOF
    exit $DEV_EXIT_SUCCESS
}

# Get current version
get_current_version() {
    if [[ -f "$VERSION_FILE" ]]; then
        cat "$VERSION_FILE" | tr -d '[:space:]'
    else
        echo "0.0.0"
    fi
}

# Calculate new version based on bump type
calculate_version() {
    local current="$1"
    local bump_type="$2"

    local major minor patch
    IFS='.' read -r major minor patch <<< "$current"

    case "$bump_type" in
        patch)
            echo "$major.$minor.$((patch + 1))"
            ;;
        minor)
            echo "$major.$((minor + 1)).0"
            ;;
        major)
            echo "$((major + 1)).0.0"
            ;;
        *)
            # Explicit version provided
            echo "$bump_type"
            ;;
    esac
}

# Validate version format
validate_version() {
    local version="$1"
    if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        log_error "Invalid version format: $version (expected X.Y.Z)"
        exit $DEV_EXIT_VERSION_INVALID
    fi
}

# Pre-bump validation
pre_bump_validation() {
    [[ "$VERBOSE" == true ]] && [[ "$QUIET" != true ]] && log_step "Running pre-bump validation..."

    # Check VERSION file exists and is readable
    if [[ ! -f "$VERSION_FILE" ]]; then
        log_error "VERSION file not found at $VERSION_FILE"
        exit $DEV_EXIT_NOT_FOUND
    fi
    [[ "$VERBOSE" == true ]] && [[ "$QUIET" != true ]] && log_info "VERSION file exists"

    # Validate current version format
    local current_version=$(get_current_version)
    if ! validate_version "$current_version" 2>/dev/null; then
        log_error "Current VERSION file has invalid format: $current_version"
        exit $DEV_EXIT_VERSION_INVALID
    fi
    [[ "$VERBOSE" == true ]] && [[ "$QUIET" != true ]] && log_info "Current version is valid semver: $current_version"

    # Warn about drift but continue
    if [[ "$NO_VALIDATE" == false ]] && [[ -x "$VALIDATE_SCRIPT" ]]; then
        if ! "$VALIDATE_SCRIPT" >/dev/null 2>&1; then
            [[ "$QUIET" != true ]] && log_warn "Version drift detected in current state (continuing anyway)"
            # Note: || true prevents set -e exit when VERBOSE=false (short-circuit returns 1)
            [[ "$VERBOSE" == true ]] && [[ "$QUIET" != true ]] && "$VALIDATE_SCRIPT" 2>&1 | head -10 || true
        fi
    fi
}

# Post-bump validation
post_bump_validation() {
    [[ "$VERBOSE" == true ]] && [[ "$QUIET" != true ]] && log_step "Running post-bump validation..."

    if [[ "$NO_VALIDATE" == true ]]; then
        [[ "$VERBOSE" == true ]] && [[ "$QUIET" != true ]] && log_warn "Skipping validation (--no-validate)"
        return $DEV_EXIT_SUCCESS
    fi

    if [[ ! -x "$VALIDATE_SCRIPT" ]]; then
        [[ "$QUIET" != true ]] && log_warn "Validation script not found at $VALIDATE_SCRIPT"
        return $DEV_EXIT_SUCCESS
    fi

    if ! "$VALIDATE_SCRIPT"; then
        log_error "Post-bump validation failed!"
        if [[ "$QUIET" != true ]]; then
            echo ""
            echo "Backup files (.bak) have been preserved for recovery."
            echo "To rollback:"
            echo "  find . -name '*.bak' -exec bash -c 'mv \"\$1\" \"\${1%.bak}\"' _ {} \\;"
        fi
        return $DEV_EXIT_BUMP_FAILED
    fi

    return $DEV_EXIT_SUCCESS
}

# Create backup of file
backup_file() {
    local file="$1"
    if [[ -f "$file" ]] && [[ "$DRY_RUN" == false ]]; then
        cp "$file" "$file.bak"
        # Note: || true prevents set -e exit when VERBOSE=false (short-circuit returns 1)
        [[ "$VERBOSE" == true ]] && [[ "$QUIET" != true ]] && log_info "Backed up: $file" || true
    fi
}

# Clean up backup files on success
cleanup_backups() {
    [[ "$VERBOSE" == true ]] && [[ "$QUIET" != true ]] && log_step "Cleaning up backup files..."
    find "$PROJECT_ROOT" -maxdepth 3 -name "*.bak" -type f -delete 2>/dev/null || true
}

# Update file with sed (with backup)
update_file_sed() {
    local file="$1"
    local pattern="$2"
    local replacement="$3"
    local description="$4"

    if [[ ! -f "$file" ]]; then
        [[ "$QUIET" != true ]] && log_warn "$description: File not found"
        return $DEV_EXIT_SUCCESS  # Don't fail on missing optional files
    fi

    if ! grep -q "$pattern" "$file"; then
        [[ "$QUIET" != true ]] && log_warn "$description: Pattern not found"
        return $DEV_EXIT_SUCCESS  # Don't fail on missing patterns
    fi

    backup_file "$file"

    if [[ "$DRY_RUN" == true ]]; then
        [[ "$QUIET" != true ]] && log_info "$description (dry-run, no changes made)"
    else
        sed -i "s|$pattern|$replacement|g" "$file"
        [[ "$QUIET" != true ]] && log_info "$description"
    fi

    return $DEV_EXIT_SUCCESS
}

# Parse arguments
BUMP_ARG=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --no-validate)
            NO_VALIDATE=true
            shift
            ;;
        --verbose)
            VERBOSE=true
            shift
            ;;
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
        -h|--help)
            usage
            ;;
        --version)
            echo "bump-version v${TOOL_VERSION}"
            exit $DEV_EXIT_SUCCESS
            ;;
        *)
            if [[ -z "$BUMP_ARG" ]]; then
                BUMP_ARG="$1"
            else
                log_error "Unknown argument: $1"
                usage
            fi
            shift
            ;;
    esac
done

# Resolve format (TTY-aware for LLM-Agent-First)
FORMAT=$(dev_resolve_format "$FORMAT")

# Main
if [[ -z "$BUMP_ARG" ]]; then
    usage
fi

# Pre-bump validation
if [[ "$NO_VALIDATE" == false ]]; then
    pre_bump_validation
fi

NEW_VERSION="$BUMP_ARG"
CURRENT_VERSION=$(get_current_version)

# Handle bump types
case "$NEW_VERSION" in
    patch|minor|major)
        NEW_VERSION=$(calculate_version "$CURRENT_VERSION" "$NEW_VERSION")
        ;;
esac

validate_version "$NEW_VERSION"

if [[ "$QUIET" != true ]]; then
    echo ""
    echo "Bumping version: $CURRENT_VERSION -> $NEW_VERSION"
    echo ""
fi

if [[ "$DRY_RUN" == true ]] && [[ "$QUIET" != true ]]; then
    log_warn "DRY-RUN MODE: No changes will be made"
    echo ""
fi

# Updating files section
[[ "$VERBOSE" == true ]] && [[ "$QUIET" != true ]] && log_step "Updating files..."

# 1. Update VERSION file
if [[ "$DRY_RUN" == true ]]; then
    [[ "$QUIET" != true ]] && log_info "VERSION file (dry-run, no changes made)"
else
    backup_file "$VERSION_FILE"
    echo "$NEW_VERSION" > "$VERSION_FILE"
    [[ "$QUIET" != true ]] && log_info "VERSION file"
fi

# 2. Update README badge
README_FILE="$PROJECT_ROOT/README.md"
update_file_sed \
    "$README_FILE" \
    "version-[0-9]\+\.[0-9]\+\.[0-9]\+-" \
    "version-${NEW_VERSION}-" \
    "README.md badge"

# 3. Update CLAUDE-INJECTION.md template
INJECTION_TEMPLATE="$PROJECT_ROOT/templates/CLAUDE-INJECTION.md"
update_file_sed \
    "$INJECTION_TEMPLATE" \
    "CLEO:START v[0-9]\+\.[0-9]\+\.[0-9]\+" \
    "CLEO:START v${NEW_VERSION}" \
    "templates/CLAUDE-INJECTION.md"

# 4. Update CLAUDE.md injection tag (if present)
CLAUDE_MD="$PROJECT_ROOT/CLAUDE.md"
if [[ -f "$CLAUDE_MD" ]]; then
    update_file_sed \
        "$CLAUDE_MD" \
        "CLEO:START v[0-9]\+\.[0-9]\+\.[0-9]\+" \
        "CLEO:START v${NEW_VERSION}" \
        "CLAUDE.md injection tag"
fi

# 5. Update plugin/plugin.json (if present)
PLUGIN_JSON="$PROJECT_ROOT/plugin/plugin.json"
if [[ -f "$PLUGIN_JSON" ]]; then
    backup_file "$PLUGIN_JSON"
    if [[ "$DRY_RUN" == true ]]; then
        [[ "$QUIET" != true ]] && log_info "plugin/plugin.json (dry-run, no changes made)"
    else
        # Use jq to update version field in JSON
        if command -v jq >/dev/null 2>&1; then
            jq --arg v "$NEW_VERSION" '.version = $v' "$PLUGIN_JSON" > "$PLUGIN_JSON.tmp" && \
                mv "$PLUGIN_JSON.tmp" "$PLUGIN_JSON"
            [[ "$QUIET" != true ]] && log_info "plugin/plugin.json"
        else
            [[ "$QUIET" != true ]] && log_warn "plugin/plugin.json: jq not found, skipping"
        fi
    fi
else
    [[ "$VERBOSE" == true ]] && [[ "$QUIET" != true ]] && log_info "plugin/plugin.json: File not found (skipping)"
fi

[[ "$QUIET" != true ]] && echo ""

# Post-bump validation
if [[ "$DRY_RUN" == false ]]; then
    if ! post_bump_validation; then
        log_error "Bump failed validation!"
        exit $DEV_EXIT_BUMP_FAILED
    fi

    # Clean up backups on success
    cleanup_backups

    if [[ "$QUIET" != true ]]; then
        echo ""
        echo -e "${GREEN:-}Version bumped to $NEW_VERSION${NC:-}"
    fi
else
    [[ "$QUIET" != true ]] && echo -e "${YELLOW:-}DRY-RUN: Would bump version to $NEW_VERSION${NC:-}"
fi

if [[ "$QUIET" != true ]]; then
    echo ""
    echo "Next steps:"
    echo "  1. Update CHANGELOG.md with changes for v$NEW_VERSION"
    echo "  2. git add -A && git commit -m 'chore: Bump to v$NEW_VERSION'"
    echo "  3. ./install.sh --force"
    echo "  4. git push origin main"
fi

exit $DEV_EXIT_SUCCESS
