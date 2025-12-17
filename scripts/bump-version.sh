#!/usr/bin/env bash
# bump-version.sh - Single command to bump version everywhere with validation
#
# Usage:
#   ./scripts/bump-version.sh 0.12.6
#   ./scripts/bump-version.sh patch   # 0.12.5 -> 0.12.6
#   ./scripts/bump-version.sh minor   # 0.12.5 -> 0.13.0
#   ./scripts/bump-version.sh major   # 0.12.5 -> 1.0.0
#   ./scripts/bump-version.sh --dry-run patch
#   ./scripts/bump-version.sh --no-validate minor

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
VERSION_FILE="$PROJECT_ROOT/VERSION"
VALIDATE_SCRIPT="$SCRIPT_DIR/validate-version.sh"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}✓${NC} $1"; }
log_warn() { echo -e "${YELLOW}⚠${NC} $1"; }
log_error() { echo -e "${RED}✗${NC} $1" >&2; }
log_step() { echo -e "${BLUE}→${NC} $1"; }

# Options
DRY_RUN=false
NO_VALIDATE=false
VERBOSE=false

usage() {
    cat << 'EOF'
Usage: bump-version.sh [OPTIONS] <version|patch|minor|major>

Arguments:
  <version>   Explicit version (e.g., 0.12.6)
  patch       Increment patch version (0.12.5 -> 0.12.6)
  minor       Increment minor version (0.12.5 -> 0.13.0)
  major       Increment major version (0.12.5 -> 1.0.0)

Options:
  --dry-run       Show what would be changed without making changes
  --no-validate   Skip validation checks (for automation)
  --verbose       Show detailed progress
  -h, --help      Show this help message

This script updates:
  - VERSION file (source of truth)
  - README.md badge
  - templates/CLAUDE-INJECTION.md version tag
  - CLAUDE.md injection tag (if present)

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
    exit 1
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
        exit 1
    fi
}

# Pre-bump validation
pre_bump_validation() {
    [[ "$VERBOSE" == true ]] && log_step "Running pre-bump validation..."

    # Check VERSION file exists and is readable
    if [[ ! -f "$VERSION_FILE" ]]; then
        log_error "VERSION file not found at $VERSION_FILE"
        exit 1
    fi
    [[ "$VERBOSE" == true ]] && log_info "VERSION file exists"

    # Validate current version format
    local current_version=$(get_current_version)
    if ! validate_version "$current_version" 2>/dev/null; then
        log_error "Current VERSION file has invalid format: $current_version"
        exit 1
    fi
    [[ "$VERBOSE" == true ]] && log_info "Current version is valid semver: $current_version"

    # Warn about drift but continue
    if [[ "$NO_VALIDATE" == false ]] && [[ -x "$VALIDATE_SCRIPT" ]]; then
        if ! "$VALIDATE_SCRIPT" >/dev/null 2>&1; then
            log_warn "Version drift detected in current state (continuing anyway)"
            [[ "$VERBOSE" == true ]] && "$VALIDATE_SCRIPT" 2>&1 | head -10
        fi
    fi
}

# Post-bump validation
post_bump_validation() {
    [[ "$VERBOSE" == true ]] && log_step "Running post-bump validation..."

    if [[ "$NO_VALIDATE" == true ]]; then
        [[ "$VERBOSE" == true ]] && log_warn "Skipping validation (--no-validate)"
        return 0
    fi

    if [[ ! -x "$VALIDATE_SCRIPT" ]]; then
        log_warn "Validation script not found at $VALIDATE_SCRIPT"
        return 0
    fi

    if ! "$VALIDATE_SCRIPT"; then
        log_error "Post-bump validation failed!"
        echo ""
        echo "Backup files (.bak) have been preserved for recovery."
        echo "To rollback:"
        echo "  find . -name '*.bak' -exec bash -c 'mv \"\$1\" \"\${1%.bak}\"' _ {} \\;"
        return 1
    fi

    return 0
}

# Create backup of file
backup_file() {
    local file="$1"
    if [[ -f "$file" ]] && [[ "$DRY_RUN" == false ]]; then
        cp "$file" "$file.bak"
        [[ "$VERBOSE" == true ]] && log_info "Backed up: $file"
    fi
}

# Clean up backup files on success
cleanup_backups() {
    [[ "$VERBOSE" == true ]] && log_step "Cleaning up backup files..."
    find "$PROJECT_ROOT" -maxdepth 3 -name "*.bak" -type f -delete 2>/dev/null || true
}

# Update file with sed (with backup)
update_file_sed() {
    local file="$1"
    local pattern="$2"
    local replacement="$3"
    local description="$4"

    if [[ ! -f "$file" ]]; then
        log_warn "$description: File not found"
        return 0  # Don't fail on missing optional files
    fi

    if ! grep -q "$pattern" "$file"; then
        log_warn "$description: Pattern not found"
        return 0  # Don't fail on missing patterns
    fi

    backup_file "$file"

    if [[ "$DRY_RUN" == true ]]; then
        log_info "$description (dry-run, no changes made)"
    else
        sed -i "s|$pattern|$replacement|g" "$file"
        log_info "$description"
    fi

    return 0
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
        -h|--help)
            usage
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

echo ""
echo "Bumping version: $CURRENT_VERSION → $NEW_VERSION"
echo ""

if [[ "$DRY_RUN" == true ]]; then
    log_warn "DRY-RUN MODE: No changes will be made"
    echo ""
fi

# Updating files section
[[ "$VERBOSE" == true ]] && log_step "Updating files..."

# 1. Update VERSION file
if [[ "$DRY_RUN" == true ]]; then
    log_info "VERSION file (dry-run, no changes made)"
else
    backup_file "$VERSION_FILE"
    echo "$NEW_VERSION" > "$VERSION_FILE"
    log_info "VERSION file"
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
    "CLAUDE-TODO:START v[0-9]\+\.[0-9]\+\.[0-9]\+" \
    "CLAUDE-TODO:START v${NEW_VERSION}" \
    "templates/CLAUDE-INJECTION.md"

# 4. Update CLAUDE.md injection tag (if present)
CLAUDE_MD="$PROJECT_ROOT/CLAUDE.md"
if [[ -f "$CLAUDE_MD" ]]; then
    update_file_sed \
        "$CLAUDE_MD" \
        "CLAUDE-TODO:START v[0-9]\+\.[0-9]\+\.[0-9]\+" \
        "CLAUDE-TODO:START v${NEW_VERSION}" \
        "CLAUDE.md injection tag"
fi

echo ""

# Post-bump validation
if [[ "$DRY_RUN" == false ]]; then
    if ! post_bump_validation; then
        log_error "Bump failed validation!"
        exit 1
    fi

    # Clean up backups on success
    cleanup_backups

    echo ""
    echo -e "${GREEN}✓ Version bumped to $NEW_VERSION${NC}"
else
    echo -e "${YELLOW}DRY-RUN: Would bump version to $NEW_VERSION${NC}"
fi

echo ""
echo "Next steps:"
echo "  1. Update CHANGELOG.md with changes for v$NEW_VERSION"
echo "  2. git add -A && git commit -m 'chore: Bump to v$NEW_VERSION'"
echo "  3. ./install.sh --force"
echo "  4. git push origin main"
