#!/usr/bin/env bash
# ============================================================================
# scripts/self-update.sh - CLEO self-update command
# ============================================================================
# Allows CLEO to update itself from GitHub releases.
# Checks for new versions, downloads, verifies, and installs updates.
#
# Usage:
#   cleo self-update              # Update to latest version
#   cleo self-update --check      # Check if update available (no install)
#   cleo self-update --version X  # Update to specific version
#   cleo self-update --status     # Show current vs latest version
#   cleo self-update --help       # Show help
#
# Exit Codes:
#   0   - Success / already up to date
#   1   - Update available (for --check)
#   2   - Download failed
#   3   - Checksum mismatch
#   4   - Installation failed
#   5   - GitHub API error
#   100 - Dev mode (use git pull instead)
# ============================================================================

set -euo pipefail

# ============================================================================
# INITIALIZATION
# ============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Source required libraries
source "$LIB_DIR/exit-codes.sh"
source "$LIB_DIR/config.sh"
source "$LIB_DIR/output-format.sh" 2>/dev/null || true
source "$LIB_DIR/flags.sh"

# Command name for error reporting
COMMAND_NAME="self-update"

# ============================================================================
# CONSTANTS
# ============================================================================
GITHUB_REPO="kryptobaseddev/cleo"
GITHUB_API_URL="https://api.github.com/repos/${GITHUB_REPO}/releases"

# Exit codes specific to self-update
# Note: Using different names to avoid conflict with exit-codes.sh constants
readonly EXIT_SELFUPDATE_AVAILABLE=1
readonly EXIT_SELFUPDATE_DOWNLOAD_FAILED=2
readonly EXIT_SELFUPDATE_CHECKSUM=3
readonly EXIT_SELFUPDATE_INSTALL_FAILED=4
readonly EXIT_SELFUPDATE_GITHUB_ERROR=5
readonly EXIT_SELFUPDATE_DEV_MODE=100

# ============================================================================
# DEFAULTS
# ============================================================================
CHECK_ONLY=false
STATUS_ONLY=false
TARGET_VERSION=""
FORMAT=""

# ============================================================================
# ARGUMENT PARSING
# ============================================================================
show_help() {
    cat <<'EOF'
CLEO SELF-UPDATE - Update CLEO to the latest version

USAGE:
    cleo self-update [OPTIONS]

DESCRIPTION:
    Downloads and installs the latest CLEO release from GitHub.
    Verifies checksums and creates backups before updating.

OPTIONS:
    --check             Check if update is available (no install)
    --version VERSION   Update to specific version (e.g., "0.57.0" or "v0.57.0")
    --status            Show current and latest version info
    --force             Skip confirmation prompts
    -f, --format FMT    Output format: json (default) or human
    --json              Shorthand for --format json
    --human             Shorthand for --format human
    -q, --quiet         Suppress non-essential output
    -h, --help          Show this help message

EXIT CODES:
    0   - Success / already up to date
    1   - Update available (--check only)
    2   - Download failed
    3   - Checksum verification failed
    4   - Installation failed
    5   - GitHub API error
    100 - Dev mode (use git pull)

EXAMPLES:
    # Check for updates
    cleo self-update --check

    # Show version status
    cleo self-update --status

    # Update to latest
    cleo self-update

    # Update to specific version
    cleo self-update --version 0.57.0

    # Non-interactive update
    cleo self-update --force

NOTES:
    - Development installations (symlinks) should use 'git pull' instead
    - Creates backup before updating
    - Verifies SHA256 checksum of downloaded files
EOF
}

parse_args() {
    # Parse common flags first
    init_flag_defaults
    parse_common_flags "$@"
    set -- "${REMAINING_ARGS[@]}"

    # Handle help flag
    if [[ "$FLAG_HELP" == true ]]; then
        show_help
        exit 0
    fi

    # Parse command-specific flags
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --check)
                CHECK_ONLY=true
                shift
                ;;
            --status)
                STATUS_ONLY=true
                shift
                ;;
            --version)
                if [[ -z "${2:-}" ]]; then
                    echo "ERROR: --version requires a version number" >&2
                    exit "$EXIT_INVALID_INPUT"
                fi
                TARGET_VERSION="$2"
                # Normalize: remove leading 'v' if present
                TARGET_VERSION="${TARGET_VERSION#v}"
                shift 2
                ;;
            *)
                echo "ERROR: Unknown option: $1" >&2
                echo "Run 'cleo self-update --help' for usage" >&2
                exit "$EXIT_INVALID_INPUT"
                ;;
        esac
    done

    # Apply common flags to globals
    apply_flags_to_globals
    FORMAT=$(resolve_format "$FORMAT")
}

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

# is_json_output - Check if output should be JSON
is_json_output() {
    [[ "$FORMAT" == "json" ]]
}

# get_current_version - Get currently installed CLEO version
get_current_version() {
    if [[ -f "$CLEO_HOME/VERSION" ]]; then
        # Read only first line (VERSION file may contain metadata on subsequent lines)
        head -1 "$CLEO_HOME/VERSION" 2>/dev/null || echo "unknown"
    else
        echo "unknown"
    fi
}

# is_dev_mode - Check if CLEO is installed in development mode (symlinks)
is_dev_mode() {
    local cleo_bin
    cleo_bin=$(command -v cleo 2>/dev/null || echo "")

    if [[ -z "$cleo_bin" ]]; then
        return 1
    fi

    # Check if the cleo binary is a symlink
    if [[ -L "$cleo_bin" ]]; then
        return 0
    fi

    # Check if scripts directory contains symlinks (dev mode indicator)
    if [[ -L "$CLEO_HOME/scripts" ]]; then
        return 0
    fi

    # Check for .git directory in CLEO_HOME (cloned repo)
    if [[ -d "$CLEO_HOME/.git" ]]; then
        return 0
    fi

    return 1
}

# get_latest_release - Fetch latest release info from GitHub API
# Returns JSON with tag_name and assets
get_latest_release() {
    local response
    local http_code

    # Use curl with error handling
    response=$(curl -fsSL \
        -H "Accept: application/vnd.github+json" \
        -w "\n%{http_code}" \
        "${GITHUB_API_URL}/latest" 2>&1) || {
        local exit_code=$?
        if [[ "$exit_code" -eq 22 ]]; then
            echo "ERROR: GitHub API returned error (HTTP 404 or similar)" >&2
        else
            echo "ERROR: Failed to connect to GitHub API" >&2
        fi
        return 1
    }

    # Extract HTTP code from last line
    http_code=$(echo "$response" | tail -n1)
    response=$(echo "$response" | sed '$d')

    if [[ "$http_code" != "200" ]]; then
        echo "ERROR: GitHub API returned HTTP $http_code" >&2
        return 1
    fi

    echo "$response"
}

# get_specific_release - Fetch specific release info by tag
# Args: $1 = version (without 'v' prefix)
get_specific_release() {
    local version="$1"
    local response
    local http_code

    response=$(curl -fsSL \
        -H "Accept: application/vnd.github+json" \
        -w "\n%{http_code}" \
        "${GITHUB_API_URL}/tags/v${version}" 2>&1) || {
        echo "ERROR: Failed to fetch release v${version}" >&2
        return 1
    }

    http_code=$(echo "$response" | tail -n1)
    response=$(echo "$response" | sed '$d')

    if [[ "$http_code" != "200" ]]; then
        echo "ERROR: Release v${version} not found (HTTP $http_code)" >&2
        return 1
    fi

    echo "$response"
}

# compare_versions - Compare two semver versions
# Returns: 0 if v1 >= v2, 1 if v1 < v2
# Args: $1 = version1, $2 = version2
compare_versions() {
    local v1="$1"
    local v2="$2"

    # Remove 'v' prefix if present
    v1="${v1#v}"
    v2="${v2#v}"

    # Split into major.minor.patch
    local IFS='.'
    read -ra v1_parts <<< "$v1"
    read -ra v2_parts <<< "$v2"

    # Pad arrays to ensure 3 elements
    while [[ ${#v1_parts[@]} -lt 3 ]]; do v1_parts+=("0"); done
    while [[ ${#v2_parts[@]} -lt 3 ]]; do v2_parts+=("0"); done

    # Compare each part
    for i in 0 1 2; do
        local p1="${v1_parts[$i]:-0}"
        local p2="${v2_parts[$i]:-0}"

        # Remove any non-numeric suffix (e.g., "-beta")
        p1="${p1%%[!0-9]*}"
        p2="${p2%%[!0-9]*}"

        if [[ "$p1" -gt "$p2" ]]; then
            return 0  # v1 > v2
        elif [[ "$p1" -lt "$p2" ]]; then
            return 1  # v1 < v2
        fi
    done

    return 0  # v1 == v2
}

# download_release - Download release tarball
# Args: $1 = download URL, $2 = output file
download_release() {
    local url="$1"
    local output="$2"

    if ! curl -fsSL -o "$output" "$url"; then
        echo "ERROR: Failed to download release from $url" >&2
        return 1
    fi

    return 0
}

# verify_checksum - Verify SHA256 checksum of downloaded file
# Args: $1 = file path, $2 = expected checksum
verify_checksum() {
    local file="$1"
    local expected="$2"

    if [[ -z "$expected" || "$expected" == "null" ]]; then
        # No checksum provided - skip verification (with warning)
        if ! is_json_output; then
            echo "  Warning: No checksum available for verification" >&2
        fi
        return 0
    fi

    local actual
    actual=$(sha256sum "$file" | cut -d' ' -f1)

    if [[ "$actual" != "$expected" ]]; then
        echo "ERROR: Checksum mismatch" >&2
        echo "  Expected: $expected" >&2
        echo "  Got: $actual" >&2
        return 1
    fi

    return 0
}

# create_backup - Create backup of current installation
create_backup() {
    local backup_dir="$CLEO_HOME/backups/self-update"
    local timestamp
    timestamp=$(date +%Y%m%d_%H%M%S)
    local backup_name="pre-update_${timestamp}"
    local backup_path="$backup_dir/$backup_name"

    mkdir -p "$backup_dir"

    # Backup key directories and files
    if [[ -d "$CLEO_HOME/scripts" && ! -L "$CLEO_HOME/scripts" ]]; then
        cp -r "$CLEO_HOME/scripts" "$backup_path.scripts" 2>/dev/null || true
    fi
    if [[ -d "$CLEO_HOME/lib" && ! -L "$CLEO_HOME/lib" ]]; then
        cp -r "$CLEO_HOME/lib" "$backup_path.lib" 2>/dev/null || true
    fi
    if [[ -f "$CLEO_HOME/VERSION" ]]; then
        cp "$CLEO_HOME/VERSION" "$backup_path.VERSION" 2>/dev/null || true
    fi

    echo "$backup_path"
}

# install_release - Extract and install release
# Args: $1 = tarball path
install_release() {
    local tarball="$1"
    local temp_extract
    temp_extract=$(mktemp -d)

    trap "rm -rf '$temp_extract'" RETURN

    # Extract tarball
    if ! tar -xzf "$tarball" -C "$temp_extract" 2>/dev/null; then
        echo "ERROR: Failed to extract release tarball" >&2
        return 1
    fi

    # Find extracted directory (usually named cleo-X.Y.Z or similar)
    local extracted_dir
    extracted_dir=$(find "$temp_extract" -maxdepth 1 -type d -name "cleo*" | head -1)

    if [[ -z "$extracted_dir" ]]; then
        # Try finding any directory
        extracted_dir=$(find "$temp_extract" -maxdepth 1 -type d ! -path "$temp_extract" | head -1)
    fi

    if [[ -z "$extracted_dir" || ! -d "$extracted_dir" ]]; then
        echo "ERROR: Could not find extracted release directory" >&2
        return 1
    fi

    # Run the installer from extracted release
    if [[ -f "$extracted_dir/install.sh" ]]; then
        if ! bash "$extracted_dir/install.sh"; then
            echo "ERROR: Installation failed" >&2
            return 1
        fi
    else
        echo "ERROR: No install.sh found in release" >&2
        return 1
    fi

    return 0
}

# ============================================================================
# OUTPUT FUNCTIONS
# ============================================================================

output_json() {
    local current="$1"
    local latest="$2"
    local update_available="$3"
    local action="$4"
    local message="${5:-}"

    jq -nc \
        --arg current "$current" \
        --arg latest "$latest" \
        --argjson update_available "$update_available" \
        --arg action "$action" \
        --arg message "$message" \
        --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
                format: "json",
                command: "self-update",
                timestamp: $timestamp
            },
            current_version: $current,
            latest_version: $latest,
            update_available: $update_available,
            action: $action,
            message: $message
        }'
}

output_dev_mode_warning() {
    if is_json_output; then
        local current
        current=$(get_current_version)
        jq -nc \
            --arg current "$current" \
            --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    format: "json",
                    command: "self-update",
                    timestamp: $timestamp
                },
                success: false,
                dev_mode: true,
                current_version: $current,
                message: "CLEO is installed in development mode. Use git pull to update instead."
            }'
    else
        echo ""
        echo "CLEO is installed in development mode."
        echo "Use 'git pull' to update instead."
        echo ""
        echo "Development mode indicators:"
        echo "  - Symlinked installation"
        echo "  - Git repository present"
        echo ""
    fi
}

# ============================================================================
# MAIN FUNCTIONS
# ============================================================================

do_check() {
    local current_version
    local latest_version
    local release_info

    current_version=$(get_current_version)

    # Fetch release info
    if [[ -n "$TARGET_VERSION" ]]; then
        release_info=$(get_specific_release "$TARGET_VERSION") || exit "$EXIT_SELFUPDATE_GITHUB_ERROR"
        latest_version="$TARGET_VERSION"
    else
        release_info=$(get_latest_release) || exit "$EXIT_SELFUPDATE_GITHUB_ERROR"
        latest_version=$(echo "$release_info" | jq -r '.tag_name // empty' | sed 's/^v//')
    fi

    if [[ -z "$latest_version" ]]; then
        echo "ERROR: Could not determine latest version" >&2
        exit "$EXIT_SELFUPDATE_GITHUB_ERROR"
    fi

    # Compare versions
    local update_available=false
    if [[ "$current_version" == "unknown" ]]; then
        update_available=true
    elif ! compare_versions "$current_version" "$latest_version"; then
        update_available=true
    fi

    if is_json_output; then
        output_json "$current_version" "$latest_version" "$update_available" "checked" ""
    else
        echo "Current version: $current_version"
        echo "Latest version:  $latest_version"
        echo ""
        if [[ "$update_available" == true ]]; then
            echo "Update available: $current_version -> $latest_version"
            echo "Run 'cleo self-update' to install"
        else
            echo "Already up to date"
        fi
    fi

    # Exit with 1 if update available (for --check), 0 if up to date
    if [[ "$CHECK_ONLY" == true && "$update_available" == true ]]; then
        exit "$EXIT_SELFUPDATE_AVAILABLE"
    fi

    exit 0
}

do_status() {
    local current_version
    local latest_version
    local release_info

    current_version=$(get_current_version)
    release_info=$(get_latest_release) || exit "$EXIT_SELFUPDATE_GITHUB_ERROR"
    latest_version=$(echo "$release_info" | jq -r '.tag_name // empty' | sed 's/^v//')

    local update_available=false
    if [[ "$current_version" == "unknown" ]]; then
        update_available=true
    elif ! compare_versions "$current_version" "$latest_version"; then
        update_available=true
    fi

    if is_json_output; then
        output_json "$current_version" "$latest_version" "$update_available" "status" ""
    else
        echo "CLEO Version Status"
        echo "==================="
        echo ""
        echo "Installed:  $current_version"
        echo "Latest:     $latest_version"
        echo "Up to date: $([ "$update_available" == true ] && echo "No" || echo "Yes")"
        echo ""
        echo "Installation path: $CLEO_HOME"
        if is_dev_mode; then
            echo "Mode: Development (use git pull)"
        else
            echo "Mode: Release"
        fi
    fi

    exit 0
}

do_update() {
    local current_version
    local latest_version
    local release_info

    current_version=$(get_current_version)

    # Fetch release info
    if [[ -n "$TARGET_VERSION" ]]; then
        if ! is_json_output; then
            echo "Fetching release v${TARGET_VERSION}..."
        fi
        release_info=$(get_specific_release "$TARGET_VERSION") || exit "$EXIT_SELFUPDATE_GITHUB_ERROR"
        latest_version="$TARGET_VERSION"
    else
        if ! is_json_output; then
            echo "Checking for updates..."
        fi
        release_info=$(get_latest_release) || exit "$EXIT_SELFUPDATE_GITHUB_ERROR"
        latest_version=$(echo "$release_info" | jq -r '.tag_name // empty' | sed 's/^v//')
    fi

    if [[ -z "$latest_version" ]]; then
        echo "ERROR: Could not determine target version" >&2
        exit "$EXIT_SELFUPDATE_GITHUB_ERROR"
    fi

    # Check if update is needed
    local update_available=false
    if [[ "$current_version" == "unknown" ]]; then
        update_available=true
    elif ! compare_versions "$current_version" "$latest_version"; then
        update_available=true
    fi

    if [[ "$update_available" == false && -z "$TARGET_VERSION" ]]; then
        if is_json_output; then
            output_json "$current_version" "$latest_version" false "already_current" "Already up to date"
        else
            echo "Already up to date (v$current_version)"
        fi
        exit 0
    fi

    # Confirm update (unless --force)
    if [[ "$FLAG_FORCE" != true ]] && ! is_json_output; then
        echo ""
        echo "Update CLEO from v$current_version to v$latest_version?"
        read -p "Continue? [y/N] " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "Update cancelled."
            exit 0
        fi
    fi

    # Get download URL for tarball
    local download_url
    download_url=$(echo "$release_info" | jq -r '.tarball_url // empty')

    if [[ -z "$download_url" ]]; then
        # Fallback: construct URL from tag
        download_url="https://github.com/${GITHUB_REPO}/archive/refs/tags/v${latest_version}.tar.gz"
    fi

    # Create temp directory for download
    local temp_dir
    temp_dir=$(mktemp -d)
    trap "rm -rf '$temp_dir'" EXIT

    local tarball_path="$temp_dir/cleo-${latest_version}.tar.gz"

    # Download release
    if ! is_json_output; then
        echo "Downloading v$latest_version..."
    fi

    if ! download_release "$download_url" "$tarball_path"; then
        if is_json_output; then
            output_json "$current_version" "$latest_version" true "failed" "Download failed"
        fi
        exit "$EXIT_SELFUPDATE_DOWNLOAD_FAILED"
    fi

    # Try to get and verify checksum (if available in release assets)
    local checksum_url checksum_expected
    checksum_url=$(echo "$release_info" | jq -r '.assets[]? | select(.name | endswith("sha256sum.txt")) | .browser_download_url // empty')

    if [[ -n "$checksum_url" ]]; then
        if ! is_json_output; then
            echo "Verifying checksum..."
        fi
        checksum_expected=$(curl -fsSL "$checksum_url" 2>/dev/null | grep -E "\.tar\.gz$" | cut -d' ' -f1)

        if ! verify_checksum "$tarball_path" "$checksum_expected"; then
            if is_json_output; then
                output_json "$current_version" "$latest_version" true "failed" "Checksum verification failed"
            fi
            exit "$EXIT_SELFUPDATE_CHECKSUM"
        fi
    fi

    # Create backup
    if ! is_json_output; then
        echo "Creating backup..."
    fi
    local backup_path
    backup_path=$(create_backup)

    # Install release
    if ! is_json_output; then
        echo "Installing v$latest_version..."
    fi

    if ! install_release "$tarball_path"; then
        if is_json_output; then
            output_json "$current_version" "$latest_version" true "failed" "Installation failed"
        else
            echo ""
            echo "Installation failed. Backup available at:"
            echo "  $backup_path.*"
        fi
        exit "$EXIT_SELFUPDATE_INSTALL_FAILED"
    fi

    # Success
    if is_json_output; then
        output_json "$current_version" "$latest_version" true "updated" "Successfully updated to v$latest_version"
    else
        echo ""
        echo "Successfully updated CLEO to v$latest_version"
        echo ""
        echo "Backup created at:"
        echo "  $backup_path.*"
        echo ""
        echo "Run 'cleo --version' to verify"
    fi

    exit 0
}

# ============================================================================
# MAIN
# ============================================================================

main() {
    parse_args "$@"

    # Check for development mode
    if is_dev_mode; then
        output_dev_mode_warning
        exit "$EXIT_SELFUPDATE_DEV_MODE"
    fi

    # Execute requested action
    if [[ "$CHECK_ONLY" == true ]]; then
        do_check
    elif [[ "$STATUS_ONLY" == true ]]; then
        do_status
    else
        do_update
    fi
}

main "$@"
