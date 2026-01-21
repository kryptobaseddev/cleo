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
readonly EXIT_SELFUPDATE_MODE_SWITCH=101
readonly EXIT_SELFUPDATE_INVALID_REPO=102

# ============================================================================
# DEFAULTS
# ============================================================================
CHECK_ONLY=false
STATUS_ONLY=false
TARGET_VERSION=""
FORMAT=""
TO_RELEASE=false
TO_DEV=""

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

MODE SWITCHING:
    --to-release        Switch from dev mode to release mode
                        Downloads latest release and replaces symlinked installation
    --to-dev PATH       Switch from release mode to dev mode
                        Creates symlinks to local CLEO repository at PATH

EXIT CODES:
    0   - Success / already up to date
    1   - Update available (--check only)
    2   - Download failed
    3   - Checksum verification failed
    4   - Installation failed
    5   - GitHub API error
    100 - Dev mode (use git pull or --to-release to switch)
    101 - Mode switch successful
    102 - Invalid repository path

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

    # Switch from dev mode to release mode
    cleo self-update --to-release

    # Switch from release mode to dev mode
    cleo self-update --to-dev /path/to/cleo-repo

NOTES:
    - Development installations (symlinks) should use 'git pull' instead
    - Creates backup before updating
    - Verifies SHA256 checksum of downloaded files
    - Mode switching creates backup before making changes
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
            --to-release)
                TO_RELEASE=true
                shift
                ;;
            --to-dev)
                if [[ -z "${2:-}" ]]; then
                    echo "ERROR: --to-dev requires a repository path" >&2
                    exit "$EXIT_INVALID_INPUT"
                fi
                TO_DEV="$2"
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
    local repo_path
    repo_path=$(get_dev_mode_source)

    if is_json_output; then
        local current
        current=$(get_current_version)
        jq -nc \
            --arg current "$current" \
            --arg repo_path "$repo_path" \
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
                repo_path: $repo_path,
                message: "CLEO is installed in development mode. Use git pull to update or --to-release to switch modes.",
                suggestions: {
                    update: ("cd " + $repo_path + " && git pull"),
                    switch_to_release: "cleo self-update --to-release"
                }
            }'
    else
        echo ""
        echo "[INFO] Development mode detected."
        echo ""
        echo "CLEO is installed in development mode (symlinked to source repository)."
        echo ""
        echo "To update:"
        if [[ -n "$repo_path" ]]; then
            echo "  cd $repo_path && git pull"
        else
            echo "  cd \$CLEO_REPO && git pull"
        fi
        echo ""
        echo "To switch to release mode:"
        echo "  cleo self-update --to-release"
        echo ""
    fi
}

# get_dev_mode_source - Get the source repository path from VERSION file
get_dev_mode_source() {
    local version_file="$CLEO_HOME/VERSION"
    if [[ -f "$version_file" ]]; then
        grep "^source=" "$version_file" 2>/dev/null | cut -d= -f2 || echo ""
    else
        # Fallback: try to resolve from symlink
        local cleo_bin
        cleo_bin=$(command -v cleo 2>/dev/null || echo "")
        if [[ -n "$cleo_bin" && -L "$cleo_bin" ]]; then
            local target
            target=$(readlink -f "$cleo_bin" 2>/dev/null || echo "")
            if [[ -n "$target" ]]; then
                dirname "$(dirname "$target")"
            fi
        fi
    fi
}

# ============================================================================
# MODE SWITCHING FUNCTIONS
# ============================================================================

# validate_cleo_repo - Check if a path is a valid CLEO repository
# Args: $1 = path to check
# Returns: 0 if valid, 1 if not
validate_cleo_repo() {
    local repo_path="$1"

    # Must be a directory
    if [[ ! -d "$repo_path" ]]; then
        echo "ERROR: Path does not exist or is not a directory: $repo_path" >&2
        return 1
    fi

    # Must have VERSION file
    if [[ ! -f "$repo_path/VERSION" ]]; then
        echo "ERROR: No VERSION file found at $repo_path" >&2
        return 1
    fi

    # Must have scripts directory
    if [[ ! -d "$repo_path/scripts" ]]; then
        echo "ERROR: No scripts/ directory found at $repo_path" >&2
        return 1
    fi

    # Must have lib directory
    if [[ ! -d "$repo_path/lib" ]]; then
        echo "ERROR: No lib/ directory found at $repo_path" >&2
        return 1
    fi

    # Must have cleo.sh entry point
    if [[ ! -f "$repo_path/scripts/cleo.sh" ]]; then
        echo "ERROR: No scripts/cleo.sh found at $repo_path" >&2
        return 1
    fi

    return 0
}

# update_version_file - Update VERSION file with mode information
# Args: $1 = version, $2 = mode (dev|release), $3 = source path (optional for dev mode)
update_version_file() {
    local version="$1"
    local mode="$2"
    local source_path="${3:-}"
    local version_file="$CLEO_HOME/VERSION"
    local timestamp
    timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    {
        echo "$version"
        echo "mode=$mode"
        if [[ "$mode" == "dev" && -n "$source_path" ]]; then
            echo "source=$source_path"
        fi
        echo "installed=$timestamp"
    } > "$version_file"
}

# remove_symlinks - Remove symlinked installation
remove_symlinks() {
    local bin_dir="${HOME}/.local/bin"

    if ! is_json_output; then
        echo "[STEP] Removing existing symlinks..."
    fi

    # Remove cleo symlink
    if [[ -L "$bin_dir/cleo" ]]; then
        rm -f "$bin_dir/cleo"
    fi

    # Remove ct alias symlink
    if [[ -L "$bin_dir/ct" ]]; then
        rm -f "$bin_dir/ct"
    fi

    # Remove symlinked directories in CLEO_HOME
    local dirs_to_remove=("scripts" "lib" "schemas" "templates" "docs" "completions")
    for dir in "${dirs_to_remove[@]}"; do
        if [[ -L "$CLEO_HOME/$dir" ]]; then
            rm -f "$CLEO_HOME/$dir"
        fi
    done
}

# remove_copied_files - Remove copied (release mode) installation files
remove_copied_files() {
    if ! is_json_output; then
        echo "[STEP] Removing existing release installation..."
    fi

    # Remove regular directories in CLEO_HOME (not symlinks)
    local dirs_to_remove=("scripts" "lib" "schemas" "templates" "docs" "completions")
    for dir in "${dirs_to_remove[@]}"; do
        if [[ -d "$CLEO_HOME/$dir" && ! -L "$CLEO_HOME/$dir" ]]; then
            rm -rf "$CLEO_HOME/$dir"
        fi
    done
}

# update_skills_for_mode_switch - Update skills symlinks after mode switch
# Removes stale ct-* symlinks and ensures cleo umbrella symlink exists
update_skills_for_mode_switch() {
    local skills_dir="$HOME/.claude/skills"
    local cleo_skills_dir="$CLEO_HOME/skills"

    if ! is_json_output; then
        echo "[STEP] Updating skills symlinks..."
    fi

    # Ensure skills directory exists
    mkdir -p "$skills_dir" 2>/dev/null || true

    # 1. Remove stale ct-* symlinks pointing to old dev locations
    local cleaned=0
    for skill in "$skills_dir"/ct-*; do
        if [[ -L "$skill" ]]; then
            local target
            target=$(readlink -f "$skill" 2>/dev/null || true)

            # If target doesn't exist OR points outside ~/.cleo, remove it
            if [[ ! -e "$target" ]] || [[ "$target" != "$CLEO_HOME/"* ]]; then
                if ! is_json_output; then
                    echo "  Removing stale symlink: $(basename "$skill")"
                fi
                rm -f "$skill"
                ((cleaned++))
            fi
        fi
    done

    if [[ $cleaned -gt 0 ]] && ! is_json_output; then
        echo "  Cleaned up $cleaned old ct-* skill symlinks"
    fi

    # 2. Ensure cleo umbrella symlink exists
    if [[ -d "$cleo_skills_dir" ]]; then
        local target_link="$skills_dir/cleo"

        # Check if symlink already correct
        if [[ -L "$target_link" ]]; then
            local current_target
            current_target=$(readlink "$target_link" 2>/dev/null || true)
            if [[ "$current_target" == "$cleo_skills_dir" ]]; then
                if ! is_json_output; then
                    echo "  Skills symlink already correct"
                fi
                return 0
            fi
            # Remove incorrect symlink
            rm -f "$target_link"
        fi

        # Create the cleo umbrella symlink
        if ln -sf "$cleo_skills_dir" "$target_link"; then
            if ! is_json_output; then
                echo "  Created skills symlink: cleo -> $cleo_skills_dir"
            fi
        else
            if ! is_json_output; then
                echo "  Warning: Failed to create skills symlink"
            fi
        fi
    fi
}

# create_dev_symlinks - Create symlinks to a local repository
# Args: $1 = source repository path
create_dev_symlinks() {
    local repo_path="$1"
    local bin_dir="${HOME}/.local/bin"

    if ! is_json_output; then
        echo "[STEP] Creating symlinks to $repo_path..."
    fi

    # Ensure bin directory exists
    mkdir -p "$bin_dir"
    mkdir -p "$CLEO_HOME"

    # Create cleo symlink
    ln -sf "$repo_path/scripts/cleo.sh" "$bin_dir/cleo"

    # Create ct alias symlink
    ln -sf "$repo_path/scripts/cleo.sh" "$bin_dir/ct"

    # Create directory symlinks
    local dirs_to_link=("scripts" "lib" "schemas" "templates" "docs" "completions")
    for dir in "${dirs_to_link[@]}"; do
        if [[ -d "$repo_path/$dir" ]]; then
            ln -sf "$repo_path/$dir" "$CLEO_HOME/$dir"
        fi
    done

    # Get version from repo
    local version
    version=$(head -1 "$repo_path/VERSION" 2>/dev/null || echo "unknown")

    # Update VERSION file
    update_version_file "$version" "dev" "$repo_path"
}

# do_switch_to_release - Switch from dev mode to release mode
do_switch_to_release() {
    if ! is_dev_mode; then
        if is_json_output; then
            jq -nc \
                --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        format: "json",
                        command: "self-update",
                        timestamp: $timestamp
                    },
                    success: false,
                    message: "Already in release mode. Use --to-dev to switch to development mode."
                }'
        else
            echo "[ERROR] Already in release mode."
            echo ""
            echo "Use --to-dev PATH to switch to development mode."
        fi
        exit 0
    fi

    if ! is_json_output; then
        echo ""
        echo "[INFO] Switching from development mode to release mode..."
        echo ""
    fi

    # Confirm unless --force
    if [[ "$FLAG_FORCE" != true ]] && ! is_json_output; then
        echo "This will:"
        echo "  1. Remove symlinks to your development repository"
        echo "  2. Download and install the latest release"
        echo ""
        read -p "Continue? [y/N] " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "Mode switch cancelled."
            exit 0
        fi
    fi

    # Create backup
    if ! is_json_output; then
        echo "[STEP 1/4] Creating backup..."
    fi
    local backup_path
    backup_path=$(create_backup)

    # Remove symlinks
    if ! is_json_output; then
        echo "[STEP 2/4] Removing symlinks..."
    fi
    remove_symlinks

    # Download latest release
    if ! is_json_output; then
        echo "[STEP 3/4] Downloading latest release..."
    fi

    local release_info
    release_info=$(get_latest_release) || {
        if is_json_output; then
            jq -nc \
                --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        format: "json",
                        command: "self-update",
                        timestamp: $timestamp
                    },
                    success: false,
                    message: "Failed to fetch latest release from GitHub"
                }'
        fi
        exit "$EXIT_SELFUPDATE_GITHUB_ERROR"
    }

    local latest_version
    latest_version=$(echo "$release_info" | jq -r '.tag_name // empty' | sed 's/^v//')

    # Download our release tarball (NOT GitHub's source archive)
    # Our tarball has execute permissions set on scripts
    local download_url
    download_url="https://github.com/${GITHUB_REPO}/releases/download/v${latest_version}/cleo-${latest_version}.tar.gz"

    local temp_dir
    temp_dir=$(mktemp -d)
    trap "rm -rf '$temp_dir'" EXIT

    local tarball_path="$temp_dir/cleo-${latest_version}.tar.gz"

    if ! download_release "$download_url" "$tarball_path"; then
        if is_json_output; then
            jq -nc \
                --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        format: "json",
                        command: "self-update",
                        timestamp: $timestamp
                    },
                    success: false,
                    message: "Failed to download release"
                }'
        fi
        exit "$EXIT_SELFUPDATE_DOWNLOAD_FAILED"
    fi

    # Install release
    if ! is_json_output; then
        echo "[STEP 4/4] Installing release v${latest_version}..."
    fi

    if ! install_release "$tarball_path"; then
        if is_json_output; then
            jq -nc \
                --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
                --arg backup "$backup_path" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        format: "json",
                        command: "self-update",
                        timestamp: $timestamp
                    },
                    success: false,
                    message: "Installation failed",
                    backup_path: $backup
                }'
        else
            echo ""
            echo "Installation failed. Backup available at: $backup_path.*"
        fi
        exit "$EXIT_SELFUPDATE_INSTALL_FAILED"
    fi

    # Update skills symlinks after mode switch
    update_skills_for_mode_switch

    # Success
    if is_json_output; then
        jq -nc \
            --arg version "$latest_version" \
            --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    format: "json",
                    command: "self-update",
                    timestamp: $timestamp
                },
                success: true,
                action: "mode_switch",
                from_mode: "dev",
                to_mode: "release",
                version: $version,
                message: ("Successfully switched to release mode v" + $version)
            }'
    else
        echo ""
        echo "Successfully switched to release mode (v${latest_version})"
        echo ""
        echo "Run 'cleo --version' to verify"
    fi

    exit 0
}

# do_switch_to_dev - Switch from release mode to dev mode
# Args: Uses global TO_DEV variable for repository path
do_switch_to_dev() {
    local repo_path="$TO_DEV"

    # Resolve to absolute path
    repo_path=$(cd "$repo_path" 2>/dev/null && pwd) || {
        echo "ERROR: Cannot resolve path: $TO_DEV" >&2
        exit "$EXIT_SELFUPDATE_INVALID_REPO"
    }

    # Validate repository
    if ! validate_cleo_repo "$repo_path"; then
        if is_json_output; then
            jq -nc \
                --arg path "$repo_path" \
                --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        format: "json",
                        command: "self-update",
                        timestamp: $timestamp
                    },
                    success: false,
                    message: "Invalid CLEO repository",
                    path: $path
                }'
        fi
        exit "$EXIT_SELFUPDATE_INVALID_REPO"
    fi

    if is_dev_mode; then
        local current_source
        current_source=$(get_dev_mode_source)
        if [[ "$current_source" == "$repo_path" ]]; then
            if is_json_output; then
                jq -nc \
                    --arg path "$repo_path" \
                    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
                    '{
                        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                        "_meta": {
                            format: "json",
                            command: "self-update",
                            timestamp: $timestamp
                        },
                        success: true,
                        message: "Already in dev mode with this repository",
                        path: $path
                    }'
            else
                echo "[INFO] Already in dev mode pointing to: $repo_path"
            fi
            exit 0
        fi
    fi

    if ! is_json_output; then
        echo ""
        echo "[INFO] Switching to development mode..."
        echo "  Repository: $repo_path"
        echo ""
    fi

    # Confirm unless --force
    if [[ "$FLAG_FORCE" != true ]] && ! is_json_output; then
        if is_dev_mode; then
            echo "This will:"
            echo "  1. Remove current symlinks"
            echo "  2. Create new symlinks to: $repo_path"
        else
            echo "This will:"
            echo "  1. Remove installed release files"
            echo "  2. Create symlinks to: $repo_path"
        fi
        echo ""
        read -p "Continue? [y/N] " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "Mode switch cancelled."
            exit 0
        fi
    fi

    # Create backup
    if ! is_json_output; then
        echo "[STEP 1/3] Creating backup..."
    fi
    local backup_path
    backup_path=$(create_backup)

    # Remove existing installation
    if ! is_json_output; then
        echo "[STEP 2/3] Removing existing installation..."
    fi
    if is_dev_mode; then
        remove_symlinks
    else
        remove_copied_files
    fi

    # Create dev symlinks
    if ! is_json_output; then
        echo "[STEP 3/3] Creating symlinks..."
    fi
    create_dev_symlinks "$repo_path"

    # Update skills symlinks after mode switch
    update_skills_for_mode_switch

    # Get version
    local version
    version=$(head -1 "$repo_path/VERSION" 2>/dev/null || echo "unknown")

    # Success
    if is_json_output; then
        jq -nc \
            --arg version "$version" \
            --arg path "$repo_path" \
            --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    format: "json",
                    command: "self-update",
                    timestamp: $timestamp
                },
                success: true,
                action: "mode_switch",
                from_mode: "release",
                to_mode: "dev",
                version: $version,
                repo_path: $path,
                message: ("Successfully switched to dev mode (v" + $version + ")")
            }'
    else
        echo ""
        echo "Successfully switched to development mode"
        echo "  Version: $version"
        echo "  Repository: $repo_path"
        echo ""
        echo "To update CLEO:"
        echo "  cd $repo_path && git pull"
        echo ""
    fi

    exit 0
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
            echo "[INFO] Fetching release v${TARGET_VERSION}..."
        fi
        release_info=$(get_specific_release "$TARGET_VERSION") || exit "$EXIT_SELFUPDATE_GITHUB_ERROR"
        latest_version="$TARGET_VERSION"
    else
        if ! is_json_output; then
            echo "[INFO] Checking for updates..."
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

    # Download our release tarball (NOT GitHub's source archive)
    # Our tarball has execute permissions set on scripts
    local download_url
    download_url="https://github.com/${GITHUB_REPO}/releases/download/v${latest_version}/cleo-${latest_version}.tar.gz"

    # Create temp directory for download
    local temp_dir
    temp_dir=$(mktemp -d)
    trap "rm -rf '$temp_dir'" EXIT

    local tarball_path="$temp_dir/cleo-${latest_version}.tar.gz"

    # Download release
    if ! is_json_output; then
        echo "[STEP 1/4] Downloading v$latest_version..."
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
            echo "[STEP 2/4] Verifying checksum..."
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
        echo "[STEP 3/4] Creating backup..."
    fi
    local backup_path
    backup_path=$(create_backup)

    # Install release
    if ! is_json_output; then
        echo "[STEP 4/4] Installing v$latest_version..."
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

    # Handle mode switching flags first (these work regardless of current mode)
    if [[ "$TO_RELEASE" == true ]]; then
        do_switch_to_release
    fi

    if [[ -n "$TO_DEV" ]]; then
        do_switch_to_dev
    fi

    # Check for development mode (only for regular update operations)
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
