#!/usr/bin/env bash
# platform-compat.sh - Platform compatibility layer for external tools
# Part of claude-todo system
# Provides fallbacks and compatibility wrappers for cross-platform support

set -euo pipefail

# ============================================================================
# PLATFORM DETECTION
# ============================================================================

detect_platform() {
    local os_type
    os_type="$(uname -s)"

    case "$os_type" in
        Linux*)     echo "linux" ;;
        Darwin*)    echo "macos" ;;
        CYGWIN*|MINGW*|MSYS*) echo "windows" ;;
        *)          echo "unknown" ;;
    esac
}

# Set PLATFORM only if not already set (prevent re-sourcing errors)
if [[ -z "${PLATFORM:-}" ]]; then
    PLATFORM="$(detect_platform)"
    readonly PLATFORM
fi

# ============================================================================
# EXTERNAL TOOL DETECTION
# ============================================================================

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check for required tool with helpful error message
require_tool() {
    local tool="$1"
    local install_hint="${2:-}"

    if ! command_exists "$tool"; then
        echo "ERROR: Required tool not found: $tool" >&2
        if [[ -n "$install_hint" ]]; then
            echo "Install with: $install_hint" >&2
        fi
        return 1
    fi
    return 0
}

# Check all required tools for claude-todo
check_required_tools() {
    local missing_tools=()

    # Core requirement: jq for JSON processing
    if ! command_exists jq; then
        missing_tools+=("jq")
    fi

    # Core requirement: date for timestamps
    if ! command_exists date; then
        missing_tools+=("date")
    fi

    if [[ ${#missing_tools[@]} -gt 0 ]]; then
        echo "ERROR: Missing required tools: ${missing_tools[*]}" >&2
        echo "" >&2
        echo "Installation instructions:" >&2

        for tool in "${missing_tools[@]}"; do
            case "$tool" in
                jq)
                    case "$PLATFORM" in
                        linux)   echo "  jq: sudo apt-get install jq  (Debian/Ubuntu)" >&2
                                echo "      sudo yum install jq      (RHEL/CentOS)" >&2 ;;
                        macos)   echo "  jq: brew install jq" >&2 ;;
                        windows) echo "  jq: Download from https://stedolan.github.io/jq/download/" >&2 ;;
                    esac
                    ;;
            esac
        done

        return 1
    fi

    return 0
}

# ============================================================================
# DATE COMMAND COMPATIBILITY
# ============================================================================

# Get ISO 8601 timestamp (cross-platform)
get_iso_timestamp() {
    date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null
}

# Convert ISO timestamp to epoch (cross-platform)
# Args: $1 = ISO 8601 timestamp
# Returns: Unix epoch seconds or 0 on error
iso_to_epoch() {
    local timestamp="$1"

    # Try GNU date (Linux)
    if date -d "$timestamp" +%s 2>/dev/null; then
        return 0
    fi

    # Try BSD date (macOS)
    if date -j -f "%Y-%m-%dT%H:%M:%SZ" "$timestamp" +%s 2>/dev/null; then
        return 0
    fi

    # Fallback: return 0 to prevent script failure
    echo "0"
    return 1
}

# Get date N days ago (cross-platform)
# Args: $1 = number of days
# Returns: ISO timestamp
date_days_ago() {
    local days="$1"

    # Try GNU date (Linux)
    if date -u -d "$days days ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null; then
        return 0
    fi

    # Try BSD date (macOS)
    if date -u -v-"${days}d" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null; then
        return 0
    fi

    # Fallback: current time (better than failing)
    get_iso_timestamp
    return 1
}

# ============================================================================
# STAT COMMAND COMPATIBILITY
# ============================================================================

# Get file size (cross-platform)
# Args: $1 = file path
# Returns: file size in bytes
get_file_size() {
    local file="$1"

    if [[ ! -f "$file" ]]; then
        echo "0"
        return 1
    fi

    # Try GNU stat (Linux)
    if stat -c %s "$file" 2>/dev/null; then
        return 0
    fi

    # Try BSD stat (macOS)
    if stat -f %z "$file" 2>/dev/null; then
        return 0
    fi

    # Fallback: use wc (less efficient but portable)
    wc -c < "$file" 2>/dev/null || echo "0"
}

# Get file modification time (cross-platform)
# Args: $1 = file path
# Returns: Unix epoch timestamp
get_file_mtime() {
    local file="$1"

    if [[ ! -f "$file" ]]; then
        echo "0"
        return 1
    fi

    # Try GNU stat (Linux)
    if stat -c %Y "$file" 2>/dev/null; then
        return 0
    fi

    # Try BSD stat (macOS)
    if stat -f %m "$file" 2>/dev/null; then
        return 0
    fi

    # Fallback
    echo "0"
    return 1
}

# ============================================================================
# RANDOM NUMBER GENERATION
# ============================================================================

# Generate random hex string (cross-platform)
# Args: $1 = number of bytes (default: 6)
# Returns: hex string
generate_random_hex() {
    local bytes="${1:-6}"

    # Try openssl (most portable)
    if command_exists openssl; then
        openssl rand -hex "$bytes" 2>/dev/null
        return 0
    fi

    # Try /dev/urandom with xxd
    if [[ -c /dev/urandom ]] && command_exists xxd; then
        head -c "$bytes" /dev/urandom | xxd -p | tr -d '\n'
        return 0
    fi

    # Try /dev/urandom with od
    if [[ -c /dev/urandom ]] && command_exists od; then
        head -c "$bytes" /dev/urandom | od -An -tx1 | tr -d ' \n'
        return 0
    fi

    # Fallback: use timestamp + RANDOM (less secure but works)
    printf "%x%04x" "$(date +%s)" "$RANDOM"
    return 1
}

# ============================================================================
# JSON SCHEMA VALIDATOR COMPATIBILITY
# ============================================================================

# Detect available JSON schema validator
# Returns: validator name or "none"
detect_json_validator() {
    if command_exists ajv; then
        echo "ajv"
    elif command_exists jsonschema; then
        echo "jsonschema"
    else
        echo "none"
    fi
}

# Validate JSON against schema (cross-validator)
# Args: $1 = data file, $2 = schema file
# Returns: 0 if valid, 1 if invalid
validate_json_schema() {
    local data_file="$1"
    local schema_file="$2"
    local validator

    validator="$(detect_json_validator)"

    case "$validator" in
        ajv)
            ajv validate -s "$schema_file" -d "$data_file" 2>&1
            return $?
            ;;
        jsonschema)
            jsonschema -i "$data_file" "$schema_file" 2>&1
            return $?
            ;;
        none)
            # Fallback: basic jq validation (no schema enforcement)
            if jq empty "$data_file" 2>/dev/null; then
                echo "WARNING: No schema validator found. Install ajv-cli or jsonschema for proper validation." >&2
                return 0
            else
                return 1
            fi
            ;;
    esac
}

# ============================================================================
# FIND COMPATIBILITY
# ============================================================================

# Find files with compatibility wrapper
# Args: $1 = directory, $2 = pattern
# Returns: list of matching files
safe_find() {
    local dir="$1"
    local pattern="$2"

    if [[ ! -d "$dir" ]]; then
        return 0
    fi

    # Use find if available (most systems)
    if command_exists find; then
        find "$dir" -maxdepth 1 -name "$pattern" -type f 2>/dev/null || true
        return 0
    fi

    # Fallback: use glob expansion
    # shellcheck disable=SC2012
    ls -1 "$dir"/"$pattern" 2>/dev/null | while read -r file; do
        [[ -f "$file" ]] && echo "$file"
    done
}

# Find files sorted by modification time (oldest first)
# Args: $1 = directory, $2 = pattern
# Returns: list of matching files sorted by mtime (oldest first)
safe_find_sorted_by_mtime() {
    local dir="$1"
    local pattern="$2"

    if [[ ! -d "$dir" ]]; then
        return 0
    fi

    # Use find with printf to get mtime, then sort numerically
    if command_exists find; then
        # GNU find supports -printf
        if find "$dir" -maxdepth 1 -name "$pattern" -type f -printf '%T@ %p\n' 2>/dev/null | sort -n | cut -d' ' -f2-; then
            return 0
        fi

        # Fallback for BSD find (macOS) - use stat for mtime
        find "$dir" -maxdepth 1 -name "$pattern" -type f 2>/dev/null | while read -r file; do
            local mtime
            mtime=$(get_file_mtime "$file")
            echo "$mtime $file"
        done | sort -n | cut -d' ' -f2-
        return 0
    fi

    # Final fallback: return unsorted (same as safe_find)
    ls -1 "$dir"/"$pattern" 2>/dev/null | while read -r file; do
        [[ -f "$file" ]] && echo "$file"
    done
}

# ============================================================================
# TEMP FILE HANDLING
# ============================================================================

# Create temp file with cleanup trap (cross-platform)
# Returns: temp file path
create_temp_file() {
    local temp_file

    # Try mktemp (most portable)
    if command_exists mktemp; then
        temp_file="$(mktemp)"
        echo "$temp_file"
        return 0
    fi

    # Fallback: create in /tmp with unique name
    temp_file="/tmp/claude-todo-$$-$(date +%s)"
    touch "$temp_file"
    echo "$temp_file"
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f detect_platform
export -f command_exists
export -f require_tool
export -f check_required_tools
export -f get_iso_timestamp
export -f iso_to_epoch
export -f date_days_ago
export -f get_file_size
export -f get_file_mtime
export -f generate_random_hex
export -f detect_json_validator
export -f validate_json_schema
export -f safe_find
export -f safe_find_sorted_by_mtime
export -f create_temp_file

# Export platform constant
export PLATFORM
