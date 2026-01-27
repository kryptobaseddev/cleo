#!/usr/bin/env bash
#####################################################################
# release-version.sh - Automated version release workflow
#
# Automates the full release process:
# 1. Bump version (patch/minor/major)
# 2. Update README badge
# 3. Generate Mintlify changelog
# 4. Commit and tag
# 5. Optionally push to remote
#
# Usage:
#   ./dev/release-version.sh patch              # 0.73.3 -> 0.73.4
#   ./dev/release-version.sh minor              # 0.73.3 -> 0.74.0
#   ./dev/release-version.sh major              # 0.73.3 -> 1.0.0
#   ./dev/release-version.sh 0.74.0             # Explicit version
#   ./dev/release-version.sh patch --push       # Also push to remote
#   ./dev/release-version.sh patch --dry-run    # Show what would happen
#
# Options:
#   --push          Push to remote after commit
#   --dry-run       Show what would happen without making changes
#   --no-changelog  Skip Mintlify changelog generation
#   --no-commit     Skip git commit (just update files)
#   -h, --help      Show this help
#
# Prerequisites:
#   - Clean git working tree (or --allow-dirty)
#   - CHANGELOG.md must have new version section already added
#
#####################################################################

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

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

# Defaults
DRY_RUN=false
PUSH=false
SKIP_CHANGELOG=false
SKIP_COMMIT=false
ALLOW_DIRTY=false
VERSION_ARG=""

usage() {
    cat << EOF
Usage: $(basename "$0") <version|patch|minor|major> [OPTIONS]

Automated version release workflow.

Arguments:
  version         Explicit version (e.g., 0.74.0)
  patch           Bump patch version (0.73.3 -> 0.73.4)
  minor           Bump minor version (0.73.3 -> 0.74.0)
  major           Bump major version (0.73.3 -> 1.0.0)

Options:
  --push          Push to remote after commit
  --dry-run       Show what would happen without changes
  --no-changelog  Skip Mintlify changelog generation
  --no-commit     Skip git commit (just update files)
  --allow-dirty   Allow release with uncommitted changes
  -h, --help      Show this help

Examples:
  $(basename "$0") patch                    # Bump patch, commit, no push
  $(basename "$0") minor --push             # Bump minor, commit, push
  $(basename "$0") 0.74.0 --dry-run         # Preview explicit version
EOF
    exit 0
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            usage
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --push)
            PUSH=true
            shift
            ;;
        --no-changelog)
            SKIP_CHANGELOG=true
            shift
            ;;
        --no-commit)
            SKIP_COMMIT=true
            shift
            ;;
        --allow-dirty)
            ALLOW_DIRTY=true
            shift
            ;;
        -*)
            log_error "Unknown option: $1"
            exit 1
            ;;
        *)
            if [[ -z "$VERSION_ARG" ]]; then
                VERSION_ARG="$1"
            else
                log_error "Unexpected argument: $1"
                exit 1
            fi
            shift
            ;;
    esac
done

if [[ -z "$VERSION_ARG" ]]; then
    log_error "Version argument required (patch, minor, major, or explicit version)"
    usage
fi

cd "$PROJECT_ROOT"

# Check for clean working tree
if [[ "$ALLOW_DIRTY" != "true" ]] && [[ "$DRY_RUN" != "true" ]]; then
    if ! git diff --quiet HEAD -- VERSION README.md CHANGELOG.md 2>/dev/null; then
        log_error "Working tree has uncommitted changes to release files"
        log_error "Commit changes first or use --allow-dirty"
        exit 1
    fi
fi

# Get current version
CURRENT_VERSION=$(cat VERSION | tr -d '[:space:]')
log_info "Current version: $CURRENT_VERSION"

# Calculate new version
calculate_new_version() {
    local current="$1"
    local bump_type="$2"

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
            # Assume explicit version
            echo "$bump_type"
            ;;
    esac
}

NEW_VERSION=$(calculate_new_version "$CURRENT_VERSION" "$VERSION_ARG")
log_info "New version: $NEW_VERSION"

# Validate version format
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    log_error "Invalid version format: $NEW_VERSION"
    exit 1
fi

# Dry run mode
if [[ "$DRY_RUN" == "true" ]]; then
    echo ""
    log_step "DRY RUN - Would perform:"
    echo "  1. Update VERSION: $CURRENT_VERSION -> $NEW_VERSION"
    echo "  2. Update README.md badge"
    if [[ "$SKIP_CHANGELOG" != "true" ]]; then
        echo "  3. Generate Mintlify changelog"
    fi
    if [[ "$SKIP_COMMIT" != "true" ]]; then
        echo "  4. Git commit with message: 'chore: Release v$NEW_VERSION'"
        echo "  5. Git tag: v$NEW_VERSION"
    fi
    if [[ "$PUSH" == "true" ]]; then
        echo "  6. Git push origin main --tags"
    fi
    exit 0
fi

# Step 1: Update VERSION file
log_step "Updating VERSION file..."
echo "$NEW_VERSION" > VERSION

# Step 2: Update README badge
log_step "Updating README.md version badge..."
sed -i "s/version-${CURRENT_VERSION//./\\.}-/version-${NEW_VERSION}-/g" README.md

# Step 3: Generate Mintlify changelog
if [[ "$SKIP_CHANGELOG" != "true" ]]; then
    log_step "Generating Mintlify changelog..."
    if [[ -x "$PROJECT_ROOT/scripts/generate-changelog.sh" ]]; then
        "$PROJECT_ROOT/scripts/generate-changelog.sh" >/dev/null 2>&1 || {
            log_warn "Changelog generation had issues (non-fatal)"
        }
        log_info "Mintlify changelog updated"
    else
        log_warn "generate-changelog.sh not found, skipping"
    fi
fi

# Step 4: Commit
if [[ "$SKIP_COMMIT" != "true" ]]; then
    log_step "Staging changes..."
    git add VERSION README.md

    # Add changelog files if they exist and were modified
    [[ -f "docs/changelog/overview.mdx" ]] && git add docs/changelog/overview.mdx 2>/dev/null || true
    [[ -f "CHANGELOG.md" ]] && git add CHANGELOG.md 2>/dev/null || true

    log_step "Creating commit..."
    git commit -m "chore: Release v$NEW_VERSION

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>" || {
        log_warn "Nothing to commit or commit failed"
    }

    log_step "Creating tag v$NEW_VERSION..."
    git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"
    log_info "Tag v$NEW_VERSION created"
fi

# Step 5: Push
if [[ "$PUSH" == "true" ]]; then
    log_step "Pushing to remote..."
    git push origin main --tags 2>&1 | grep -v "already exists" || true
    log_info "Pushed to remote"
fi

echo ""
log_info "Release v$NEW_VERSION complete!"
echo ""
echo "Next steps:"
if [[ "$PUSH" != "true" ]]; then
    echo "  git push origin main --tags"
fi
echo "  Verify: cleo version"
