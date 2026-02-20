#!/usr/bin/env bash
# dev-common.sh - Common utilities for development scripts
# Part of claude-todo development tooling
#
# Provides file operations, pattern matching, timestamps, dependency checking,
# and other utilities shared across dev scripts.
#
# Dependencies:
#   - dev-colors.sh (via dev-output.sh)
#   - dev-exit-codes.sh (via dev-output.sh)
#   - dev-output.sh (required)
#
# Usage:
#   source "${DEV_LIB_DIR}/dev-common.sh"
#   dev_require_command jq
#   hash=$(dev_file_hash "$file")
#
# Version: 1.0.0

# ============================================================================
# GUARD AGAINST MULTIPLE SOURCING
# ============================================================================
[[ -n "${_DEV_COMMON_SH_LOADED:-}" ]] && return 0
_DEV_COMMON_SH_LOADED=1

# ============================================================================
# DEPENDENCIES
# ============================================================================

_DEV_COMMON_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source required dependencies
if [[ -f "$_DEV_COMMON_LIB_DIR/dev-output.sh" ]]; then
    source "$_DEV_COMMON_LIB_DIR/dev-output.sh"
else
    echo "ERROR: dev-common.sh requires dev-output.sh" >&2
    exit 1
fi

# ============================================================================
# PATH RESOLUTION
# ============================================================================

# Get the directory containing the calling script
# Usage: DEV_DIR=$(dev_get_script_dir)
dev_get_script_dir() {
    cd "$(dirname "${BASH_SOURCE[1]}")" && pwd
}

# Get the project root (parent of dev/ directory)
# Usage: PROJECT_ROOT=$(dev_get_project_root)
dev_get_project_root() {
    local script_dir
    script_dir="$(dev_get_script_dir)"

    # If in dev/lib/, go up two levels
    if [[ "$script_dir" == */dev/lib ]]; then
        dirname "$(dirname "$script_dir")"
    # If in dev/, go up one level
    elif [[ "$script_dir" == */dev ]]; then
        dirname "$script_dir"
    # Otherwise assume we're in project root
    else
        echo "$script_dir"
    fi
}

# Initialize standard path variables
# Call this early in your script after sourcing dev-common.sh
dev_init_paths() {
    export DEV_SCRIPT_DIR="${DEV_SCRIPT_DIR:-$(dev_get_script_dir)}"
    export DEV_LIB_DIR="${DEV_LIB_DIR:-$_DEV_COMMON_LIB_DIR}"
    export PROJECT_ROOT="${PROJECT_ROOT:-$(dev_get_project_root)}"
}

# ============================================================================
# DEPENDENCY CHECKING
# ============================================================================

# Check if a command exists
# Args: $1 = command name
# Returns: 0 if exists, 1 if not
dev_command_exists() {
    command -v "$1" &>/dev/null
}

# Require a command to exist, or exit with error
# Args: $1 = command name
#       $2 = install hint (optional)
dev_require_command() {
    local cmd="$1"
    local hint="${2:-}"

    if ! dev_command_exists "$cmd"; then
        dev_log_error "Required command not found: $cmd"
        [[ -n "$hint" ]] && echo "  Install: $hint" >&2
        exit $DEV_EXIT_DEPENDENCY_ERROR
    fi
}

# Check multiple required commands at once
# Args: $@ = command names
dev_require_commands() {
    local missing=()
    for cmd in "$@"; do
        dev_command_exists "$cmd" || missing+=("$cmd")
    done

    if [[ ${#missing[@]} -gt 0 ]]; then
        dev_log_error "Missing required commands: ${missing[*]}"
        exit $DEV_EXIT_DEPENDENCY_ERROR
    fi
}

# ============================================================================
# FILE OPERATIONS
# ============================================================================

# Get file hash (SHA256 preferred, with fallbacks)
# Args: $1 = file path
# Returns: hash string (echoed)
dev_file_hash() {
    local file="$1"

    if [[ ! -f "$file" ]]; then
        echo "no-file"
        return 1
    fi

    if command -v sha256sum &>/dev/null; then
        sha256sum "$file" 2>/dev/null | cut -d' ' -f1
    elif command -v shasum &>/dev/null; then
        shasum -a 256 "$file" 2>/dev/null | cut -d' ' -f1
    elif command -v md5sum &>/dev/null; then
        md5sum "$file" 2>/dev/null | cut -d' ' -f1
    else
        # Last resort: use file stats
        stat -c '%s%Y' "$file" 2>/dev/null || stat -f '%z%m' "$file" 2>/dev/null || echo "no-hash"
    fi
}

# Get file modification time as epoch seconds
# Args: $1 = file path
# Returns: epoch seconds (echoed)
dev_file_mtime() {
    local file="$1"

    if [[ ! -f "$file" ]]; then
        echo "0"
        return 1
    fi

    # GNU stat
    if stat -c %Y "$file" 2>/dev/null; then
        return 0
    fi
    # BSD stat (macOS)
    stat -f %m "$file" 2>/dev/null || echo "0"
}

# Platform-safe sed in-place
# Args: same as sed
dev_sed_inplace() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "$@"
    else
        sed -i "$@"
    fi
}

# Require a file to exist, or exit with error
# Args: $1 = file path
#       $2 = description (optional)
dev_require_file() {
    local file="$1"
    local desc="${2:-File}"

    if [[ ! -f "$file" ]]; then
        dev_log_error "$desc not found: $file"
        exit $DEV_EXIT_NOT_FOUND
    fi
}

# Create backup of a file
# Args: $1 = file path
# Returns: backup file path (echoed)
dev_backup_file() {
    local file="$1"

    if [[ -f "$file" ]]; then
        local backup="${file}.bak"
        cp "$file" "$backup"
        echo "$backup"
    fi
}

# ============================================================================
# PATTERN MATCHING (grep wrappers)
# ============================================================================

# Check if pattern exists in file
# Args: $1 = file path
#       $2 = pattern (extended regex)
# Returns: 0 if found, 1 if not
dev_pattern_exists() {
    local file="$1"
    local pattern="$2"
    grep -qE -- "$pattern" "$file" 2>/dev/null
}

# Count pattern matches in file
# Args: $1 = file path
#       $2 = pattern (extended regex)
# Returns: count (echoed)
dev_pattern_count() {
    local file="$1"
    local pattern="$2"
    local count
    count=$(grep -cE -- "$pattern" "$file" 2>/dev/null) || count=0
    echo "$count" | tr -d '[:space:]'
}

# Get all matching lines with line numbers
# Args: $1 = file path
#       $2 = pattern (extended regex)
# Returns: matching lines (echoed, format: line_num:content)
dev_pattern_matches() {
    local file="$1"
    local pattern="$2"
    grep -nE -- "$pattern" "$file" 2>/dev/null || true
}

# Legacy aliases for compatibility with test-helpers.sh
pattern_exists() { dev_pattern_exists "$@"; }
pattern_count() { dev_pattern_count "$@"; }
pattern_matches() { dev_pattern_matches "$@"; }

# Legacy alias for get_file_hash (used by check-compliance.sh)
get_file_hash() { dev_file_hash "$@"; }

# ============================================================================
# TIMESTAMPS
# ============================================================================

# Get ISO 8601 UTC timestamp
# Returns: timestamp string (echoed)
dev_timestamp() {
    date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# Get timestamp suitable for filenames (no special chars)
# Returns: timestamp string (echoed)
dev_timestamp_filename() {
    date -u +"%Y%m%d-%H%M%S"
}

# Get current date in YYYY-MM-DD format
# Returns: date string (echoed)
dev_date() {
    date -u +"%Y-%m-%d"
}

# Legacy alias
format_timestamp() { dev_timestamp; }

# ============================================================================
# TEMPORARY FILES
# ============================================================================

# Create temporary file with automatic cleanup registration
# Args: $1 = prefix (optional, default: "dev-temp")
# Returns: temp file path (echoed)
dev_temp_file() {
    local prefix="${1:-dev-temp}"
    mktemp "/tmp/${prefix}.XXXXXX"
}

# Create temporary directory with automatic cleanup registration
# Args: $1 = prefix (optional, default: "dev-temp")
# Returns: temp dir path (echoed)
dev_temp_dir() {
    local prefix="${1:-dev-temp}"
    mktemp -d "/tmp/${prefix}.XXXXXX"
}

# ============================================================================
# VERSION UTILITIES
# ============================================================================

# Validate semver format (X.Y.Z)
# Args: $1 = version string
# Returns: 0 if valid, 1 if not
dev_validate_semver() {
    local version="$1"
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

# Compare semver versions
# Args: $1 = version1, $2 = operator (<, <=, =, >=, >), $3 = version2
# Returns: 0 if comparison is true, 1 if false
dev_compare_semver() {
    local v1="$1"
    local op="$2"
    local v2="$3"

    # Convert versions to comparable format
    local v1_parts v2_parts
    IFS='.' read -r -a v1_parts <<< "$v1"
    IFS='.' read -r -a v2_parts <<< "$v2"

    local v1_num=$((v1_parts[0] * 10000 + v1_parts[1] * 100 + v1_parts[2]))
    local v2_num=$((v2_parts[0] * 10000 + v2_parts[1] * 100 + v2_parts[2]))

    case "$op" in
        '<')  [[ $v1_num -lt $v2_num ]] ;;
        '<=') [[ $v1_num -le $v2_num ]] ;;
        '=')  [[ $v1_num -eq $v2_num ]] ;;
        '>=') [[ $v1_num -ge $v2_num ]] ;;
        '>')  [[ $v1_num -gt $v2_num ]] ;;
        *)    return 1 ;;
    esac
}

# ============================================================================
# CACHE UTILITIES
# ============================================================================

# Load cache from JSON file
# Args: $1 = cache file path
# Returns: JSON content (echoed) or empty object if not found
dev_load_cache() {
    local cache_path="$1"
    if [[ -f "$cache_path" ]]; then
        cat "$cache_path"
    else
        echo "{}"
    fi
}

# Check if file has changed since cached
# Args: $1 = file path
#       $2 = cache JSON
# Returns: 0 if changed or not cached, 1 if unchanged
dev_file_changed() {
    local file="$1"
    local cache="$2"

    local current_hash
    current_hash=$(dev_file_hash "$file")

    local cached_hash
    cached_hash=$(echo "$cache" | jq -r ".files[\"$file\"].hash // empty" 2>/dev/null)

    [[ "$current_hash" != "$cached_hash" ]]
}

# Legacy alias
file_changed() { dev_file_changed "$@"; }
load_cache() { dev_load_cache "$@"; }

# ============================================================================
# SCORING UTILITIES
# ============================================================================

# Calculate percentage score
# Args: $1 = passed count
#       $2 = total count
# Returns: percentage as float string (echoed)
dev_calc_score() {
    local passed="$1"
    local total="$2"

    if [[ "$total" -eq 0 ]]; then
        echo "0"
        return
    fi

    # Use bc for floating point, or awk as fallback
    if command -v bc &>/dev/null; then
        echo "scale=1; $passed * 100 / $total" | bc
    else
        awk "BEGIN {printf \"%.1f\", $passed * 100 / $total}"
    fi
}

# Legacy alias
calc_score() { dev_calc_score "$@"; }

# ============================================================================
# PLATFORM DETECTION
# ============================================================================

# Check if running on macOS
dev_is_macos() {
    [[ "$OSTYPE" == "darwin"* ]]
}

# Check if running on Linux
dev_is_linux() {
    [[ "$OSTYPE" == "linux-gnu"* ]]
}

# ============================================================================
# EXPORTS
# ============================================================================

# Path functions
export -f dev_get_script_dir
export -f dev_get_project_root
export -f dev_init_paths

# Dependency checking
export -f dev_command_exists
export -f dev_require_command
export -f dev_require_commands

# File operations
export -f dev_file_hash
export -f dev_file_mtime
export -f dev_sed_inplace
export -f dev_require_file
export -f dev_backup_file

# Pattern matching
export -f dev_pattern_exists
export -f dev_pattern_count
export -f dev_pattern_matches
export -f pattern_exists pattern_count pattern_matches get_file_hash  # Legacy

# Timestamps
export -f dev_timestamp
export -f dev_timestamp_filename
export -f dev_date
export -f format_timestamp  # Legacy

# Temp files
export -f dev_temp_file
export -f dev_temp_dir

# Version utilities
export -f dev_validate_semver
export -f dev_compare_semver

# Cache utilities
export -f dev_load_cache
export -f dev_file_changed
export -f load_cache file_changed  # Legacy

# Scoring
export -f dev_calc_score
export -f calc_score  # Legacy

# Platform detection
export -f dev_is_macos
export -f dev_is_linux

# ============================================================================
# FORMAT RESOLUTION (LLM-Agent-First)
# ============================================================================

# TTY-aware format resolution for LLM-Agent-First design
# Args: $1 = format from command line (may be empty)
# Returns: resolved format (json for non-TTY, text for TTY)
dev_resolve_format() {
    local requested_format="${1:-}"

    # If format explicitly requested, use it
    if [[ -n "$requested_format" ]]; then
        echo "$requested_format"
        return 0
    fi

    # Auto-detect based on TTY
    if [[ -t 1 ]]; then
        echo "text"  # Interactive terminal
    else
        echo "json"  # Pipe/redirect/agent context
    fi
}

# Legacy alias
resolve_format() { dev_resolve_format "$@"; }

# Export format functions
export -f dev_resolve_format
export -f resolve_format
