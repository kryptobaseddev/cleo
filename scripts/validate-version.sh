#!/usr/bin/env bash
# validate-version.sh - Validate version consistency across project files
#
# Usage:
#   ./scripts/validate-version.sh          # Check for version drift
#   ./scripts/validate-version.sh --fix    # Auto-fix version drift

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
VERSION_FILE="$PROJECT_ROOT/VERSION"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}✓${NC} $1"; }
log_warn() { echo -e "${YELLOW}⚠${NC} $1"; }
log_error() { echo -e "${RED}✗${NC} $1" >&2; }
log_check() { echo -e "${BLUE}→${NC} $1"; }

# Platform-safe sed in-place
sed_inplace() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "$@"
    else
        sed -i "$@"
    fi
}

FIX_MODE=false
EXIT_CODE=0

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --fix)
            FIX_MODE=true
            shift
            ;;
        -h|--help)
            cat << 'EOF'
Usage: validate-version.sh [OPTIONS]

Validates that version numbers are consistent across all project files.

Options:
  --fix     Auto-fix version drift by syncing all files to VERSION file
  --help    Show this help message

Files checked:
  - VERSION (source of truth)
  - README.md badge
  - templates/CLAUDE-INJECTION.md version tag
  - CLAUDE.md injection tag (if present)

Exit codes:
  0 - All versions synchronized
  1 - Version drift detected (or validation failed)
EOF
            exit 0
            ;;
        *)
            echo "ERROR: Unknown option: $1" >&2
            echo "Use --help for usage information" >&2
            exit 1
            ;;
    esac
done

# Validate semver format
validate_semver() {
    local version="$1"
    if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        return 1
    fi
    return 0
}

# Extract version from file (POSIX-compliant)
extract_version() {
    local file="$1"
    local pattern="$2"

    if [[ ! -f "$file" ]]; then
        echo ""
        return
    fi

    # Convert pattern to grep and sed compatible format
    # Pattern format: 'prefix\K[0-9]+\.[0-9]+\.[0-9]+'
    # Convert to: grep 'prefix[0-9]' then sed to extract version
    case "$pattern" in
        'version-\K[0-9]+\.[0-9]+\.[0-9]+')
            grep -o 'version-[0-9]\+\.[0-9]\+\.[0-9]\+' "$file" 2>/dev/null | head -1 | sed 's/version-//' || echo ""
            ;;
        'CLAUDE-TODO:START v\K[0-9]+\.[0-9]+\.[0-9]+')
            grep -o 'CLAUDE-TODO:START v[0-9]\+\.[0-9]\+\.[0-9]\+' "$file" 2>/dev/null | head -1 | sed 's/CLAUDE-TODO:START v//' || echo ""
            ;;
        *)
            echo ""
            ;;
    esac
}

# Main validation
echo "Version Consistency Check"
echo "=========================="
echo ""

# 1. Check VERSION file
log_check "Checking VERSION file..."
if [[ ! -f "$VERSION_FILE" ]]; then
    log_error "VERSION file not found at $VERSION_FILE"
    exit 1
fi

SOURCE_VERSION=$(cat "$VERSION_FILE" | tr -d '[:space:]')
if ! validate_semver "$SOURCE_VERSION"; then
    log_error "Invalid semver format in VERSION file: $SOURCE_VERSION"
    exit 1
fi
log_info "VERSION file: $SOURCE_VERSION (valid semver)"
echo ""

# Files to check
declare -A FILES_TO_CHECK
FILES_TO_CHECK["README.md"]='version-\K[0-9]+\.[0-9]+\.[0-9]+'
FILES_TO_CHECK["templates/CLAUDE-INJECTION.md"]='CLAUDE-TODO:START v\K[0-9]+\.[0-9]+\.[0-9]+'
FILES_TO_CHECK["CLAUDE.md"]='CLAUDE-TODO:START v\K[0-9]+\.[0-9]+\.[0-9]+'

# Check each file
log_check "Checking project files..."
for file in "${!FILES_TO_CHECK[@]}"; do
    filepath="$PROJECT_ROOT/$file"
    pattern="${FILES_TO_CHECK[$file]}"

    if [[ ! -f "$filepath" ]]; then
        log_warn "$file not found (skipping)"
        continue
    fi

    found_version=$(extract_version "$filepath" "$pattern")

    if [[ -z "$found_version" ]]; then
        log_warn "$file: version pattern not found"
        continue
    fi

    if [[ "$found_version" == "$SOURCE_VERSION" ]]; then
        log_info "$file: $found_version"
    else
        EXIT_CODE=1

        if [[ "$FIX_MODE" == true ]]; then
            # Show error before fixing
            log_error "$file: $found_version (drift detected, fixing...)"

            # Create backup before modification
            cp "$filepath" "$filepath.bak"

            # Fix the drift
            case "$file" in
                "README.md")
                    sed_inplace "s/version-[0-9]\+\.[0-9]\+\.[0-9]\+-/version-${SOURCE_VERSION}-/g" "$filepath"
                    log_info "  → Fixed: synced to $SOURCE_VERSION"
                    ;;
                "templates/CLAUDE-INJECTION.md"|"CLAUDE.md")
                    sed_inplace "s/CLAUDE-TODO:START v[0-9]\+\.[0-9]\+\.[0-9]\+/CLAUDE-TODO:START v${SOURCE_VERSION}/g" "$filepath"
                    log_info "  → Fixed: synced to $SOURCE_VERSION"
                    ;;
            esac

            # Verify fix succeeded
            new_version=$(extract_version "$filepath" "$pattern")
            if [[ "$new_version" == "$SOURCE_VERSION" ]]; then
                # Fix succeeded, remove backup
                rm -f "$filepath.bak"
            else
                # Fix failed, restore backup
                log_error "  → Fix failed, restoring from backup"
                mv "$filepath.bak" "$filepath"
                EXIT_CODE=1
            fi
        else
            # Just report the error
            log_error "$file: $found_version (drift detected, expected $SOURCE_VERSION)"
        fi
    fi
done

echo ""

# Summary
if [[ $EXIT_CODE -eq 0 ]]; then
    echo -e "${GREEN}All versions synchronized to $SOURCE_VERSION${NC}"
else
    if [[ "$FIX_MODE" == true ]]; then
        echo -e "${GREEN}Version drift fixed! All files now use $SOURCE_VERSION${NC}"
        EXIT_CODE=0
    else
        echo -e "${RED}Version drift detected!${NC}"
        echo "Run with --fix to automatically synchronize versions"
    fi
fi

exit $EXIT_CODE
