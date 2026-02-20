#!/usr/bin/env bash
#####################################################################
# release-version.sh - DEPRECATED - Use `cleo release ship` instead
#
# DEPRECATION NOTICE:
# This script is deprecated as of v0.78.0. All functionality has been
# merged into `cleo release ship`. This wrapper remains for backward
# compatibility but will be removed in a future version.
#
# Migration:
#   OLD: ./dev/release-version.sh patch --push
#   NEW: cleo release ship patch --bump-version --create-tag --push
#
#   OLD: ./dev/release-version.sh 0.74.0 --dry-run
#   NEW: cleo release ship v0.74.0 --bump-version --dry-run
#
#   OLD: ./dev/release-version.sh minor --no-changelog
#   NEW: cleo release ship minor --bump-version --no-changelog --create-tag
#
# See: docs/DEPRECATION-NOTICE.md
# Task: T2845
#####################################################################

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_warn() { echo -e "${YELLOW}⚠${NC} $1" >&2; }
log_error() { echo -e "${RED}✗${NC} $1" >&2; }
log_info() { echo -e "${BLUE}ℹ${NC} $1" >&2; }

# Show deprecation warning
echo ""
log_warn "DEPRECATION WARNING:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log_warn "dev/release-version.sh is DEPRECATED as of v0.78.0"
log_info "Use 'cleo release ship' instead for all release operations"
echo ""
echo "This wrapper will execute 'cleo release ship' with the appropriate flags."
echo "Please update your scripts and workflows to use the new command."
echo ""
echo "See docs/guides/release-workflow.md for migration guide"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Parse arguments and convert to cleo release ship format
NEW_ARGS=()
VERSION_ARG=""
DRY_RUN=false
PUSH=false
SKIP_CHANGELOG=false
SKIP_COMMIT=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            echo "dev/release-version.sh is DEPRECATED"
            echo ""
            echo "Use: cleo release ship <version|patch|minor|major> [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --bump-version     Bump VERSION file"
            echo "  --create-tag       Create git tag"
            echo "  --push             Push to remote"
            echo "  --dry-run          Preview changes"
            echo "  --no-changelog     Skip changelog generation"
            echo "  --no-commit        Skip git commit"
            echo ""
            echo "Examples:"
            echo "  cleo release ship patch --bump-version --create-tag --push"
            echo "  cleo release ship v0.74.0 --dry-run"
            exit 0
            ;;
        --dry-run)
            DRY_RUN=true
            NEW_ARGS+=("--dry-run")
            shift
            ;;
        --push)
            PUSH=true
            NEW_ARGS+=("--push")
            shift
            ;;
        --no-changelog)
            SKIP_CHANGELOG=true
            NEW_ARGS+=("--no-changelog")
            shift
            ;;
        --no-commit)
            SKIP_COMMIT=true
            NEW_ARGS+=("--no-commit")
            shift
            ;;
        --skip-tests)
            # Map to run-tests flag (inverse logic)
            # Old script had --skip-tests, new one has --run-tests (opt-in)
            # So if --skip-tests is NOT present, we DON'T add --run-tests
            shift
            ;;
        --allow-dirty)
            # This was a safety check - new system handles it differently
            log_info "Ignoring --allow-dirty flag (handled by git status check in new system)"
            shift
            ;;
        -*)
            log_error "Unknown option: $1"
            echo "Use --help to see available options"
            exit 1
            ;;
        *)
            if [[ -z "$VERSION_ARG" ]]; then
                VERSION_ARG="$1"
                # Ensure version has v prefix for consistency
                if [[ ! "$VERSION_ARG" =~ ^v ]] && [[ "$VERSION_ARG" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
                    VERSION_ARG="v${VERSION_ARG}"
                fi
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
    echo "Use --help for more information"
    exit 1
fi

# Build the new command
NEW_CMD="cleo release ship $VERSION_ARG --bump-version --create-tag ${NEW_ARGS[*]}"

echo "Executing: $NEW_CMD"
echo ""

# Execute the new command
cd "$PROJECT_ROOT"
exec $NEW_CMD
