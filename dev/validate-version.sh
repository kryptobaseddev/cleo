#!/usr/bin/env bash
# validate-version.sh - Validate version consistency across project files
#
# This script follows LLM-Agent-First principles:
# - JSON output by default for non-TTY
# - --format, --quiet, --json, --human flags
# - DEV_EXIT_* constants
#
# Usage:
#   ./dev/validate-version.sh          # Check for version drift
#   ./dev/validate-version.sh --fix    # Auto-fix version drift
#   ./dev/validate-version.sh --format json  # JSON output
#   ./dev/validate-version.sh --quiet  # Suppress non-error output

set -euo pipefail

# ============================================================================
# SETUP - LLM-Agent-First compliant
# ============================================================================

# Script location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_LIB_DIR="$SCRIPT_DIR/lib"

# Source dev library (required for LLM-Agent-First compliance)
source "$DEV_LIB_DIR/dev-common.sh"

# Defensive check: verify log_error is available after sourcing
if ! declare -f log_error >/dev/null 2>&1; then
    echo "ERROR: log_error function not available after sourcing dev-common.sh" >&2
    exit "${DEV_EXIT_DEPENDENCY_ERROR:-5}"
fi

# Project paths
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
VERSION_FILE="$PROJECT_ROOT/VERSION"

# Command identification (for error reporting)
COMMAND_NAME="validate-version"

# Load version from central VERSION file
TOOL_VERSION=$(cat "$PROJECT_ROOT/VERSION" 2>/dev/null || echo "0.1.0")

# Use library's sed_inplace function
sed_inplace() { dev_sed_inplace "$@"; }

# Default options
FIX_MODE=false
FORMAT=""
QUIET=false
EXIT_CODE=0

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --fix)
            FIX_MODE=true
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
            cat << EOF
Usage: validate-version.sh [OPTIONS]

Validates that version numbers are consistent across all project files.

Options:
  --fix               Auto-fix version drift by syncing all files to VERSION file
  -f, --format FMT    Output format: text, json (default: json for non-TTY, text for TTY)
  --json              Shortcut for --format json
  --human             Shortcut for --format text
  -q, --quiet         Suppress non-error output
  -h, --help          Show this help message
  --version           Show version

Files checked:
  - VERSION (source of truth)
  - README.md badge
  - templates/CLAUDE-INJECTION.md version tag
  - CLAUDE.md injection tag (if present)

Exit codes:
  0  - All versions synchronized
  11 - Version drift detected (DEV_EXIT_VERSION_DRIFT)
  10 - Invalid version format (DEV_EXIT_VERSION_INVALID)
  4  - File not found (DEV_EXIT_NOT_FOUND)
EOF
            exit $DEV_EXIT_SUCCESS
            ;;
        --version)
            echo "validate-version v${TOOL_VERSION}"
            exit $DEV_EXIT_SUCCESS
            ;;
        *)
            echo "ERROR: Unknown option: $1" >&2
            echo "Use --help for usage information" >&2
            exit $DEV_EXIT_INVALID_INPUT
            ;;
    esac
done

# Resolve format (TTY-aware for LLM-Agent-First)
FORMAT=$(dev_resolve_format "$FORMAT")

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
        'CLEO:START v\K[0-9]+\.[0-9]+\.[0-9]+')
            grep -o 'CLEO:START v[0-9]\+\.[0-9]\+\.[0-9]\+' "$file" 2>/dev/null | head -1 | sed 's/CLEO:START v//' || echo ""
            ;;
        *)
            echo ""
            ;;
    esac
}

# Main validation
if [[ "$QUIET" != "true" ]] && [[ "$FORMAT" == "text" ]]; then
    echo "Version Consistency Check"
    echo "=========================="
    echo ""
fi

# 1. Check VERSION file
[[ "$QUIET" != "true" ]] && [[ "$FORMAT" == "text" ]] && log_check "Checking VERSION file..."
if [[ ! -f "$VERSION_FILE" ]]; then
    log_error "VERSION file not found at $VERSION_FILE"
    exit $DEV_EXIT_NOT_FOUND
fi

SOURCE_VERSION=$(cat "$VERSION_FILE" | tr -d '[:space:]')
if ! validate_semver "$SOURCE_VERSION"; then
    log_error "Invalid semver format in VERSION file: $SOURCE_VERSION"
    exit $DEV_EXIT_VERSION_INVALID
fi
[[ "$QUIET" != "true" ]] && [[ "$FORMAT" == "text" ]] && log_info "VERSION file: $SOURCE_VERSION (valid semver)"
[[ "$QUIET" != "true" ]] && [[ "$FORMAT" == "text" ]] && echo ""

# Files to check
declare -A FILES_TO_CHECK
FILES_TO_CHECK["README.md"]='version-\K[0-9]+\.[0-9]+\.[0-9]+'
FILES_TO_CHECK["templates/CLAUDE-INJECTION.md"]='CLEO:START v\K[0-9]+\.[0-9]+\.[0-9]+'
FILES_TO_CHECK["CLAUDE.md"]='CLEO:START v\K[0-9]+\.[0-9]+\.[0-9]+'

# Track results for JSON output
declare -a FILE_RESULTS=()

# Check each file
[[ "$QUIET" != "true" ]] && [[ "$FORMAT" == "text" ]] && log_check "Checking project files..."
for file in "${!FILES_TO_CHECK[@]}"; do
    filepath="$PROJECT_ROOT/$file"
    pattern="${FILES_TO_CHECK[$file]}"

    if [[ ! -f "$filepath" ]]; then
        [[ "$QUIET" != "true" ]] && [[ "$FORMAT" == "text" ]] && log_warn "$file not found (skipping)"
        FILE_RESULTS+=("{\"file\": \"$file\", \"status\": \"skipped\", \"reason\": \"not found\"}")
        continue
    fi

    found_version=$(extract_version "$filepath" "$pattern")

    if [[ -z "$found_version" ]]; then
        [[ "$QUIET" != "true" ]] && [[ "$FORMAT" == "text" ]] && log_warn "$file: version pattern not found"
        FILE_RESULTS+=("{\"file\": \"$file\", \"status\": \"skipped\", \"reason\": \"pattern not found\"}")
        continue
    fi

    if [[ "$found_version" == "$SOURCE_VERSION" ]]; then
        [[ "$QUIET" != "true" ]] && [[ "$FORMAT" == "text" ]] && log_info "$file: $found_version"
        FILE_RESULTS+=("{\"file\": \"$file\", \"status\": \"ok\", \"version\": \"$found_version\"}")
    else
        EXIT_CODE=$DEV_EXIT_VERSION_DRIFT

        if [[ "$FIX_MODE" == true ]]; then
            # Show error before fixing
            [[ "$FORMAT" == "text" ]] && log_error "$file: $found_version (drift detected, fixing...)"

            # Create backup before modification
            cp "$filepath" "$filepath.bak"

            # Fix the drift
            case "$file" in
                "README.md")
                    sed_inplace "s/version-[0-9]\+\.[0-9]\+\.[0-9]\+-/version-${SOURCE_VERSION}-/g" "$filepath"
                    [[ "$FORMAT" == "text" ]] && log_info "  → Fixed: synced to $SOURCE_VERSION"
                    ;;
                "templates/CLAUDE-INJECTION.md"|"CLAUDE.md")
                    sed_inplace "s/CLEO:START v[0-9]\+\.[0-9]\+\.[0-9]\+/CLEO:START v${SOURCE_VERSION}/g" "$filepath"
                    [[ "$FORMAT" == "text" ]] && log_info "  → Fixed: synced to $SOURCE_VERSION"
                    ;;
            esac

            # Verify fix succeeded
            new_version=$(extract_version "$filepath" "$pattern")
            if [[ "$new_version" == "$SOURCE_VERSION" ]]; then
                # Fix succeeded, remove backup
                rm -f "$filepath.bak"
                FILE_RESULTS+=("{\"file\": \"$file\", \"status\": \"fixed\", \"from\": \"$found_version\", \"to\": \"$SOURCE_VERSION\"}")
            else
                # Fix failed, restore backup
                [[ "$FORMAT" == "text" ]] && log_error "  → Fix failed, restoring from backup"
                mv "$filepath.bak" "$filepath"
                EXIT_CODE=$DEV_EXIT_GENERAL_ERROR
                FILE_RESULTS+=("{\"file\": \"$file\", \"status\": \"fix_failed\", \"version\": \"$found_version\", \"expected\": \"$SOURCE_VERSION\"}")
            fi
        else
            # Just report the error
            [[ "$FORMAT" == "text" ]] && log_error "$file: $found_version (drift detected, expected $SOURCE_VERSION)"
            FILE_RESULTS+=("{\"file\": \"$file\", \"status\": \"drift\", \"version\": \"$found_version\", \"expected\": \"$SOURCE_VERSION\"}")
        fi
    fi
done

# Summary and output
if [[ "$FORMAT" == "json" ]]; then
    # Build JSON output
    TIMESTAMP=$(dev_timestamp)

    # Determine success and final exit code
    if [[ $EXIT_CODE -eq 0 ]]; then
        SUCCESS="true"
        MESSAGE="All versions synchronized to $SOURCE_VERSION"
    elif [[ "$FIX_MODE" == true ]] && [[ $EXIT_CODE -eq $DEV_EXIT_VERSION_DRIFT ]]; then
        SUCCESS="true"
        MESSAGE="Version drift fixed! All files now use $SOURCE_VERSION"
        EXIT_CODE=$DEV_EXIT_SUCCESS
    else
        SUCCESS="false"
        MESSAGE="Version drift detected"
    fi

    # Build JSON array from FILE_RESULTS
    FILES_JSON=$(printf '%s\n' "${FILE_RESULTS[@]}" | jq -s '.')

    jq -n \
        --arg cmd "$COMMAND_NAME" \
        --arg ver "$TOOL_VERSION" \
        --arg ts "$TIMESTAMP" \
        --arg fmt "$FORMAT" \
        --argjson success "$SUCCESS" \
        --arg msg "$MESSAGE" \
        --arg source_version "$SOURCE_VERSION" \
        --argjson exit_code "$EXIT_CODE" \
        --argjson files "$FILES_JSON" \
        --argjson fix_mode "$FIX_MODE" \
        '{
            "$schema": "https://cleo-dev.com/schemas/validate-version.schema.json",
            "_meta": {
                "format": $fmt,
                "command": $cmd,
                "version": $ver,
                "timestamp": $ts
            },
            "success": $success,
            "message": $msg,
            "sourceVersion": $source_version,
            "fixMode": $fix_mode,
            "exitCode": $exit_code,
            "files": $files
        }'
else
    # Text output
    [[ "$QUIET" != "true" ]] && echo ""

    if [[ $EXIT_CODE -eq 0 ]]; then
        [[ "$QUIET" != "true" ]] && echo -e "${GREEN}All versions synchronized to $SOURCE_VERSION${NC}"
    else
        if [[ "$FIX_MODE" == true ]]; then
            [[ "$QUIET" != "true" ]] && echo -e "${GREEN}Version drift fixed! All files now use $SOURCE_VERSION${NC}"
            EXIT_CODE=$DEV_EXIT_SUCCESS
        else
            echo -e "${RED}Version drift detected!${NC}"
            echo "Run with --fix to automatically synchronize versions"
        fi
    fi
fi

exit $EXIT_CODE
