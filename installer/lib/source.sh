#!/usr/bin/env bash
# CLEO Installer - Fetch Operations
# Detects install mode and fetches files from local/remote sources
#
# Version: 1.3.0
# Task: T1860, T1864, T1866, T1868 (Version Detection and Selection)
# Based on: claudedocs/research-outputs/2026-01-20_modular-installer-architecture.md
#
# LAYER: 2 (Operations)
# DEPENDENCIES: core.sh, validate.sh
# PROVIDES: installer_source_detect_mode, installer_source_fetch, installer_source_get_versions
#           installer_source_validate_repo, installer_source_link_repo, installer_source_dev_status
#           installer_source_fetch_release, installer_source_get_releases, installer_source_get_latest
#           installer_source_get_installed_version, installer_source_get_installed_mode
#           installer_source_compare_versions, installer_source_check_upgrade, installer_source_upgrade
#           installer_source_version_info, installer_source_select_version_interactive
#
# Local Dev Mode (T1864):
#   - Symlinks to repo for live updates during development
#   - Auto-detected when run from cloned repo
#   - VERSION file tracks mode and source path
#   - Use --dev flag to force dev mode
#
# Release Mode (T1866):
#   - Download from GitHub releases
#   - Support version selection (latest, specific tag)
#   - Checksum verification
#   - Retry logic for network issues

# ============================================
# GUARD: Prevent double-sourcing
# ============================================
[[ -n "${_INSTALLER_SOURCE_LOADED:-}" ]] && return 0
readonly _INSTALLER_SOURCE_LOADED=1

# ============================================
# DEPENDENCIES
# ============================================
INSTALLER_LIB_DIR="${INSTALLER_LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
source "${INSTALLER_LIB_DIR}/core.sh"

# Optional: validate.sh for checksum verification
if [[ -f "${INSTALLER_LIB_DIR}/validate.sh" ]]; then
    source "${INSTALLER_LIB_DIR}/validate.sh"
fi

# ============================================
# CONSTANTS
# ============================================
readonly SOURCE_GITHUB_REPO="${CLEO_REPO:-kryptobaseddev/cleo}"
readonly SOURCE_GITHUB_RAW_BASE="https://raw.githubusercontent.com/${SOURCE_GITHUB_REPO}"
readonly SOURCE_GITHUB_API="https://api.github.com/repos/${SOURCE_GITHUB_REPO}/releases"
readonly SOURCE_GITHUB_DOWNLOAD="https://github.com/${SOURCE_GITHUB_REPO}/releases/download"

# Network configuration
readonly SOURCE_DOWNLOAD_RETRIES="${CLEO_DOWNLOAD_RETRIES:-3}"
readonly SOURCE_DOWNLOAD_RETRY_DELAY="${CLEO_DOWNLOAD_RETRY_DELAY:-5}"
readonly SOURCE_DOWNLOAD_TIMEOUT="${CLEO_DOWNLOAD_TIMEOUT:-60}"

# Exit codes specific to source operations (70-79 range)
readonly EXIT_NETWORK_ERROR=70
readonly EXIT_CHECKSUM_FAILED=71
readonly EXIT_INVALID_VERSION=72
readonly EXIT_EXTRACT_FAILED=73

# Directory patterns that indicate we're in a development checkout
readonly SOURCE_DEV_MARKERS=(
    ".git"
    "tests/unit"
    "dev/bump-version.sh"
)

# Required directories for a valid CLEO repo
readonly SOURCE_REQUIRED_DIRS=(
    "scripts"
    "lib"
    "schemas"
)

# Required files for a valid CLEO repo
readonly SOURCE_REQUIRED_FILES=(
    "VERSION"
    "lib/validation/validation.sh"
    "lib/data/file-ops.sh"
    "scripts/add.sh"
    "schemas/todo.schema.json"
)

# Directories to link/copy during installation
readonly SOURCE_INSTALLABLE_DIRS=(
    "lib"
    "scripts"
    "schemas"
    "templates"
    "docs"
    "skills"
    "completions"
    "dev"
)

# Files to copy (not link) during dev mode installation
readonly SOURCE_COPY_FILES=(
    "VERSION"
    "LICENSE"
    "README.md"
)

# Data files that MUST never be overwritten by installation
readonly SOURCE_DATA_FILES=(
    "todo.json"
    "todo-archive.json"
    "todo-log.json"
    "sessions.json"
    "config.json"
    "project-info.json"
    ".sequence"
    ".current-session"
    ".context-alert-state.json"
)

# Preserve data files before destructive operations
# Args: install_dir
# Outputs: backup directory path (if files were preserved)
# Returns: 0 on success
installer_source_preserve_data_files() {
    local install_dir="$1"
    local backup_dir="${install_dir}/.data-preserve-$$"

    if [[ ! -d "$install_dir" ]]; then
        return 0  # Nothing to preserve
    fi

    local preserved=0
    mkdir -p "$backup_dir"

    for file in "${SOURCE_DATA_FILES[@]}"; do
        if [[ -f "$install_dir/$file" ]]; then
            cp -p "$install_dir/$file" "$backup_dir/$file" && ((preserved++))
            installer_log_debug "Preserved: $file"
        fi
    done

    # Also preserve backups directory if it exists
    if [[ -d "$install_dir/.backups" ]]; then
        cp -rp "$install_dir/.backups" "$backup_dir/.backups" || true
        installer_log_debug "Preserved: .backups/"
    fi

    if [[ $preserved -gt 0 ]]; then
        installer_log_info "Preserved $preserved data file(s)"
        echo "$backup_dir"  # Return backup dir path
    fi

    return 0
}

# Restore preserved data files after installation
# Args: install_dir backup_dir
# Returns: 0 on success
installer_source_restore_data_files() {
    local install_dir="$1"
    local backup_dir="$2"

    if [[ ! -d "$backup_dir" ]]; then
        return 0  # Nothing to restore
    fi

    local restored=0

    for file in "${SOURCE_DATA_FILES[@]}"; do
        if [[ -f "$backup_dir/$file" ]]; then
            cp -p "$backup_dir/$file" "$install_dir/$file" && ((restored++))
            installer_log_debug "Restored: $file"
        fi
    done

    # Restore backups directory
    if [[ -d "$backup_dir/.backups" ]]; then
        cp -rp "$backup_dir/.backups" "$install_dir/.backups" || true
        installer_log_debug "Restored: .backups/"
    fi

    # Clean up backup
    rm -rf "$backup_dir"

    if [[ $restored -gt 0 ]]; then
        installer_log_info "Restored $restored data file(s)"
    fi

    return 0
}

# ============================================
# MODE DETECTION
# ============================================

# Detect if we're running from a development checkout or release
# Checks (in order):
#   1. INSTALLER_MODE env var (explicit override)
#   2. --dev flag (sets INSTALLER_DEV_MODE=1)
#   3. Development markers (.git, tests/unit, etc.)
# Returns: "dev" for development checkout, "release" for standalone installer
installer_source_detect_mode() {
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

    # Check for explicit mode override via environment
    if [[ -n "${INSTALLER_MODE:-}" ]]; then
        installer_log_debug "Mode override via INSTALLER_MODE: $INSTALLER_MODE"
        echo "$INSTALLER_MODE"
        return 0
    fi

    # Check for --dev flag (sets INSTALLER_DEV_MODE=1)
    if [[ "${INSTALLER_DEV_MODE:-0}" == "1" ]]; then
        installer_log_debug "Dev mode forced via --dev flag"
        echo "dev"
        return 0
    fi

    # Check for development markers in repo structure
    for marker in "${SOURCE_DEV_MARKERS[@]}"; do
        if [[ -e "$script_dir/$marker" ]]; then
            installer_log_debug "Detected dev mode (found: $marker)"
            echo "dev"
            return 0
        fi
    done

    installer_log_debug "Detected release mode"
    echo "release"
}

# Get the source directory for installation
# Args: [mode] (default: auto-detect)
# Returns: Path to source directory
installer_source_get_dir() {
    local mode="${1:-$(installer_source_detect_mode)}"

    case "$mode" in
        dev)
            # Development: use repository root
            cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd
            ;;
        release)
            # Release: use temp directory (populated by fetch)
            installer_get_temp_dir
            ;;
        *)
            installer_log_error "Unknown source mode: $mode"
            return 1
            ;;
    esac
}

# ============================================
# REPOSITORY VALIDATION
# ============================================

# Validate that a directory is a valid CLEO repository
# Args: repo_dir
# Returns: 0 if valid, EXIT_VALIDATION_FAILED otherwise
installer_source_validate_repo() {
    local repo_dir="$1"

    if [[ -z "$repo_dir" || ! -d "$repo_dir" ]]; then
        installer_log_error "Repository directory not found: ${repo_dir:-<empty>}"
        return $EXIT_VALIDATION_FAILED
    fi

    installer_log_debug "Validating repository: $repo_dir"

    # Check required directories
    for dir in "${SOURCE_REQUIRED_DIRS[@]}"; do
        if [[ ! -d "$repo_dir/$dir" ]]; then
            installer_log_error "Missing required directory: $dir"
            return $EXIT_VALIDATION_FAILED
        fi
    done

    # Check required files
    for file in "${SOURCE_REQUIRED_FILES[@]}"; do
        if [[ ! -f "$repo_dir/$file" ]]; then
            installer_log_error "Missing required file: $file"
            return $EXIT_VALIDATION_FAILED
        fi
    done

    installer_log_debug "Repository validation passed"
    return 0
}

# ============================================
# DEV MODE SYMLINK OPERATIONS
# ============================================

# Create symlinks from repo to target directory (dev mode)
# Args: repo_dir target_dir
# Returns: 0 on success, EXIT_STAGING_FAILED on failure
installer_source_link_repo() {
    local repo_dir="$1"
    local target_dir="$2"

    installer_log_info "Creating dev mode symlinks: $repo_dir -> $target_dir"

    # Ensure target directory exists
    mkdir -p "$target_dir"

    # Create symlinks for installable directories
    for dir in "${SOURCE_INSTALLABLE_DIRS[@]}"; do
        if [[ -d "$repo_dir/$dir" ]]; then
            # Remove existing if present
            [[ -e "$target_dir/$dir" || -L "$target_dir/$dir" ]] && rm -rf "$target_dir/$dir"

            # Create symlink
            if ! ln -sf "$repo_dir/$dir" "$target_dir/$dir"; then
                installer_log_error "Failed to create symlink: $dir"
                return $EXIT_STAGING_FAILED
            fi
            installer_log_debug "Linked: $dir -> $repo_dir/$dir"
        fi
    done

    # Copy (not link) VERSION and metadata files
    for file in "${SOURCE_COPY_FILES[@]}"; do
        if [[ -f "$repo_dir/$file" ]]; then
            cp "$repo_dir/$file" "$target_dir/$file" || true
        fi
    done

    # Record dev mode info in VERSION file
    installer_source_write_version_metadata "$target_dir" "$repo_dir" "dev"

    installer_log_info "Dev mode symlinks created successfully"
    return 0
}

# Copy repo to target directory (for testing or non-symlink dev mode)
# Args: repo_dir target_dir
# Returns: 0 on success, EXIT_STAGING_FAILED on failure
installer_source_copy_repo() {
    local repo_dir="$1"
    local target_dir="$2"

    installer_log_info "Copying repository: $repo_dir -> $target_dir"

    # Ensure target directory exists
    mkdir -p "$target_dir"

    # Copy installable directories
    for dir in "${SOURCE_INSTALLABLE_DIRS[@]}"; do
        if [[ -d "$repo_dir/$dir" ]]; then
            installer_log_debug "Copying: $dir/"
            if ! cp -r "$repo_dir/$dir" "$target_dir/"; then
                installer_log_error "Failed to copy: $dir"
                return $EXIT_STAGING_FAILED
            fi
        fi
    done

    # Copy metadata files
    for file in "${SOURCE_COPY_FILES[@]}"; do
        if [[ -f "$repo_dir/$file" ]]; then
            cp "$repo_dir/$file" "$target_dir/" || true
        fi
    done

    # Record copy mode info in VERSION file
    installer_source_write_version_metadata "$target_dir" "$repo_dir" "copy"

    installer_log_info "Repository copy complete"
    return 0
}

# Write mode metadata to VERSION file
# Args: target_dir source_dir mode
installer_source_write_version_metadata() {
    local target_dir="$1"
    local source_dir="$2"
    local mode="$3"
    local version_file="$target_dir/VERSION"

    # Read existing version if present
    local version=""
    if [[ -f "$version_file" ]]; then
        version=$(head -n1 "$version_file")
    fi

    # Write VERSION file with metadata
    cat > "$version_file" <<EOF
${version:-development}
mode=$mode
source=$source_dir
installed=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

    installer_log_debug "Wrote VERSION metadata: mode=$mode"
}

# ============================================
# DEV MODE STATUS AND MANAGEMENT
# ============================================

# Show dev mode installation status
# Args: [install_dir] (default: INSTALL_DIR)
# Outputs: Status information to stdout
installer_source_dev_status() {
    local install_dir="${1:-$INSTALL_DIR}"
    local version_file="$install_dir/VERSION"

    if [[ ! -f "$version_file" ]]; then
        echo "Mode: not installed"
        return 1
    fi

    local version mode source installed
    version=$(head -n1 "$version_file" 2>/dev/null || echo "unknown")
    mode=$(grep "^mode=" "$version_file" 2>/dev/null | cut -d= -f2 || echo "unknown")
    source=$(grep "^source=" "$version_file" 2>/dev/null | cut -d= -f2 || echo "none")
    installed=$(grep "^installed=" "$version_file" 2>/dev/null | cut -d= -f2 || echo "unknown")

    echo "CLEO Installation Status"
    echo "========================"
    echo "Version:   $version"
    echo "Mode:      $mode"
    echo "Source:    $source"
    echo "Installed: $installed"

    if [[ "$mode" == "dev" ]]; then
        # Count symlinks
        local symlink_count
        symlink_count=$(find "$install_dir" -maxdepth 1 -type l 2>/dev/null | wc -l | tr -d ' ')
        echo "Symlinks:  $symlink_count"

        # Check if source still exists
        if [[ -n "$source" && -d "$source" ]]; then
            echo "Source OK: yes"
        else
            echo "Source OK: NO (source directory missing!)"
            return 1
        fi
    fi

    return 0
}

# Refresh dev mode symlinks (if repo moved or reinstalling)
# Args: new_source_dir [install_dir]
# Returns: 0 on success, non-zero on failure
installer_source_dev_refresh() {
    local new_source="${1:-}"
    local install_dir="${2:-$INSTALL_DIR}"

    if [[ -z "$new_source" ]]; then
        # Try to get current source from VERSION
        local version_file="$install_dir/VERSION"
        if [[ -f "$version_file" ]]; then
            new_source=$(grep "^source=" "$version_file" 2>/dev/null | cut -d= -f2)
        fi
    fi

    if [[ -z "$new_source" || ! -d "$new_source" ]]; then
        installer_log_error "Cannot refresh: source directory not found"
        return $EXIT_VALIDATION_FAILED
    fi

    # Validate the new source
    installer_source_validate_repo "$new_source" || return $?

    # Re-create symlinks
    installer_log_info "Refreshing dev mode symlinks from: $new_source"
    installer_source_link_repo "$new_source" "$install_dir"
}

# Check if installation is in dev mode
# Args: [install_dir]
# Returns: 0 if dev mode, 1 otherwise
installer_source_is_dev_mode() {
    local install_dir="${1:-$INSTALL_DIR}"
    local version_file="$install_dir/VERSION"

    if [[ ! -f "$version_file" ]]; then
        return 1
    fi

    local mode
    mode=$(grep "^mode=" "$version_file" 2>/dev/null | cut -d= -f2)
    [[ "$mode" == "dev" ]]
}


# ============================================
# VERSION MANAGEMENT (T1868)
# ============================================

# Exit code for mode conflicts
readonly EXIT_MODE_CONFLICT=74
readonly EXIT_USER_CANCELLED=75

# Get the installed CLEO version from VERSION file
# Args: [install_dir]
# Returns: Version string (e.g., "0.55.0") or "none"
installer_source_get_installed_version() {
    local install_dir="${1:-$INSTALL_DIR}"
    local version_file="$install_dir/VERSION"

    if [[ -f "$version_file" ]]; then
        # First line of VERSION file is the version number
        head -1 "$version_file" 2>/dev/null | tr -d '[:space:]' || echo "none"
    else
        echo "none"
    fi
}

# Get the installed mode from VERSION file
# Args: [install_dir]
# Returns: "dev", "release", "copy", or "unknown"
installer_source_get_installed_mode() {
    local install_dir="${1:-$INSTALL_DIR}"
    local version_file="$install_dir/VERSION"

    if [[ -f "$version_file" ]]; then
        grep "^mode=" "$version_file" 2>/dev/null | cut -d= -f2 || echo "unknown"
    else
        echo "unknown"
    fi
}

# Compare two version strings
# Args: v1 v2
# Returns: "equal", "upgrade" (v2 > v1), or "downgrade" (v2 < v1)
installer_source_compare_versions() {
    local v1="$1"
    local v2="$2"

    # Normalize versions (remove 'v' prefix)
    v1="${v1#v}"
    v2="${v2#v}"

    # Handle "none" or empty versions
    if [[ "$v1" == "none" || -z "$v1" ]]; then
        [[ "$v2" == "none" || -z "$v2" ]] && echo "equal" || echo "upgrade"
        return
    fi
    if [[ "$v2" == "none" || -z "$v2" ]]; then
        echo "downgrade"
        return
    fi

    # Use the numeric comparison from validate.sh
    if declare -f installer_validate_compare_versions &>/dev/null; then
        local cmp
        cmp=$(installer_validate_compare_versions "$v1" "$v2")
        case "$cmp" in
            0)  echo "equal" ;;
            -1) echo "upgrade" ;;    # v2 > v1
            1)  echo "downgrade" ;;  # v2 < v1
        esac
        return
    fi

    # Fallback: use sort -V if validate.sh not loaded
    if [[ "$v1" == "$v2" ]]; then
        echo "equal"
    elif [[ "$(printf '%s\n' "$v1" "$v2" | sort -V | head -1)" == "$v1" ]]; then
        echo "upgrade"  # v2 > v1
    else
        echo "downgrade"  # v2 < v1
    fi
}

# Check if an upgrade is available
# Args: [install_dir]
# Returns: "upgrade", "downgrade", "equal", or "unknown" (if can't fetch latest)
installer_source_check_upgrade() {
    local install_dir="${1:-$INSTALL_DIR}"
    local installed
    local latest

    installed=$(installer_source_get_installed_version "$install_dir")
    latest=$(installer_source_get_latest 2>/dev/null)

    if [[ -z "$latest" ]]; then
        installer_log_debug "Could not fetch latest version from GitHub"
        echo "unknown"
        return 1
    fi

    installer_source_compare_versions "$installed" "$latest"
}

# Interactive version selection with markers for installed/latest
# Args: [limit]
# Outputs: Selected version tag to stdout
# Returns: 0 on success, 1 on error/cancel
installer_source_select_version_interactive() {
    local limit="${1:-10}"
    local installed
    local versions=()

    installed=$(installer_source_get_installed_version)

    # Fetch available versions
    local releases
    releases=$(installer_source_get_releases "$limit" 2>/dev/null)

    if [[ -z "$releases" ]]; then
        installer_log_error "Could not fetch available versions from GitHub"
        return 1
    fi

    # Convert to array
    while IFS= read -r ver; do
        [[ -n "$ver" ]] && versions+=("$ver")
    done <<< "$releases"

    if [[ ${#versions[@]} -eq 0 ]]; then
        installer_log_error "No releases found"
        return 1
    fi

    echo "" >&2
    echo "Available CLEO versions:" >&2
    echo "========================" >&2

    for i in "${!versions[@]}"; do
        local v="${versions[$i]}"
        local v_normalized="${v#v}"
        local marker=""

        # Mark current version
        if [[ "$v_normalized" == "$installed" || "$v" == "$installed" ]]; then
            marker=" (installed)"
        fi

        # Mark latest
        if [[ $i -eq 0 ]]; then
            marker="$marker (latest)"
        fi

        printf "  %2d) %s%s\n" "$((i+1))" "$v" "$marker" >&2
    done

    echo "" >&2
    local selection
    read -rp "Select version [1 for latest]: " selection
    selection=${selection:-1}

    # Validate selection
    if [[ ! "$selection" =~ ^[0-9]+$ ]] || [[ "$selection" -lt 1 ]] || [[ "$selection" -gt ${#versions[@]} ]]; then
        installer_log_error "Invalid selection: $selection"
        return 1
    fi

    echo "${versions[$((selection-1))]}"
}

# Upgrade to a specific version (or latest)
# Args: [target_version]
# Returns: 0 on success, non-zero on failure
installer_source_upgrade() {
    local target_version="${1:-latest}"
    local install_dir="${2:-$INSTALL_DIR}"
    local installed
    local mode

    installed=$(installer_source_get_installed_version "$install_dir")
    mode=$(installer_source_get_installed_mode "$install_dir")

    # Resolve latest
    if [[ "$target_version" == "latest" ]]; then
        installer_log_info "Resolving latest version..."
        target_version=$(installer_source_get_latest)

        if [[ -z "$target_version" ]]; then
            installer_log_error "Could not determine latest version from GitHub"
            return $EXIT_INVALID_VERSION
        fi
    fi

    # Normalize for comparison
    local target_normalized="${target_version#v}"

    # Compare versions
    local comparison
    comparison=$(installer_source_compare_versions "$installed" "$target_normalized")

    case "$comparison" in
        equal)
            installer_log_info "Already at version $installed"
            return 0
            ;;
        upgrade)
            installer_log_info "Upgrading from $installed to $target_version"
            ;;
        downgrade)
            installer_log_warn "Downgrading from $installed to $target_version"
            local confirm
            read -rp "Continue with downgrade? [y/N]: " confirm
            if [[ ! "$confirm" =~ ^[Yy] ]]; then
                installer_log_info "Downgrade cancelled by user"
                return $EXIT_USER_CANCELLED
            fi
            ;;
    esac

    # Check for dev mode conflict
    if [[ "$mode" == "dev" ]]; then
        installer_log_warn "Development mode installation detected"
        installer_log_warn "For dev mode, pull latest from the git repository instead:"
        installer_log_info "  cd \$(grep '^source=' '$install_dir/VERSION' | cut -d= -f2)"
        installer_log_info "  git pull origin main"
        return $EXIT_MODE_CONFLICT
    fi

    # Perform the upgrade via fetch
    installer_log_info "Downloading and installing $target_version..."
    installer_source_fetch_release "$target_version" "$install_dir"
}

# Display comprehensive version information
# Args: [install_dir]
installer_source_version_info() {
    local install_dir="${1:-$INSTALL_DIR}"
    local version_file="$install_dir/VERSION"

    local installed
    local mode
    local latest
    local status

    installed=$(installer_source_get_installed_version "$install_dir")
    mode=$(installer_source_get_installed_mode "$install_dir")
    latest=$(installer_source_get_latest 2>/dev/null || echo "unavailable")
    status=$(installer_source_check_upgrade "$install_dir" 2>/dev/null || echo "unknown")

    echo "CLEO Version Information"
    echo "========================"
    echo "Installed: $installed"
    echo "Mode:      $mode"
    echo "Latest:    $latest"
    echo "Status:    $status"

    # Additional metadata from VERSION file
    if [[ -f "$version_file" ]]; then
        local source
        local installed_date
        local download_url
        local version_tag

        source=$(grep "^source=" "$version_file" 2>/dev/null | cut -d= -f2)
        installed_date=$(grep "^installed=" "$version_file" 2>/dev/null | cut -d= -f2)
        version_tag=$(grep "^version=" "$version_file" 2>/dev/null | cut -d= -f2)
        download_url=$(grep "^download_url=" "$version_file" 2>/dev/null | cut -d= -f2)

        [[ -n "$source" ]] && echo "Source:    $source"
        [[ -n "$version_tag" ]] && echo "Tag:       $version_tag"
        [[ -n "$installed_date" ]] && echo "Date:      $installed_date"
        [[ -n "$download_url" ]] && echo "URL:       $download_url"
    fi

    # Dev mode specific info
    if [[ "$mode" == "dev" ]]; then
        echo ""
        echo "Development Mode Details:"
        local symlink_count
        symlink_count=$(find "$install_dir" -maxdepth 1 -type l 2>/dev/null | wc -l | tr -d ' ')
        echo "  Symlinks:  $symlink_count"

        local source_dir
        source_dir=$(grep "^source=" "$version_file" 2>/dev/null | cut -d= -f2)
        if [[ -n "$source_dir" && -d "$source_dir" ]]; then
            echo "  Source OK: yes"

            # Check git status if available
            if [[ -d "$source_dir/.git" ]] && command -v git &>/dev/null; then
                local branch
                local ahead_behind
                branch=$(git -C "$source_dir" branch --show-current 2>/dev/null || echo "unknown")
                ahead_behind=$(git -C "$source_dir" rev-list --count --left-right "@{upstream}...HEAD" 2>/dev/null || echo "")
                echo "  Branch:    $branch"
                if [[ -n "$ahead_behind" ]]; then
                    local behind ahead
                    behind=$(echo "$ahead_behind" | cut -f1)
                    ahead=$(echo "$ahead_behind" | cut -f2)
                    [[ "$behind" -gt 0 ]] && echo "  Behind:    $behind commits"
                    [[ "$ahead" -gt 0 ]] && echo "  Ahead:     $ahead commits"
                fi
            fi
        else
            echo "  Source OK: NO (source directory missing!)"
        fi
    fi

    # Upgrade suggestion
    if [[ "$status" == "upgrade" && "$latest" != "unavailable" ]]; then
        echo ""
        echo "Upgrade available: $installed -> $latest"
        if [[ "$mode" == "dev" ]]; then
            echo "  For dev mode: cd <repo> && git pull"
        else
            echo "  Run: ./install.sh --upgrade"
        fi
    fi
}

# Check if upgrade is available (for scripting)
# Args: [install_dir]
# Returns: 0 if upgrade available, 1 if current/downgrade, 2 if can't determine
installer_source_check_upgrade_available() {
    local install_dir="${1:-$INSTALL_DIR}"
    local status

    status=$(installer_source_check_upgrade "$install_dir" 2>/dev/null)

    case "$status" in
        upgrade)   return 0 ;;
        equal)     return 1 ;;
        downgrade) return 1 ;;
        *)         return 2 ;;
    esac
}

# ============================================
# VERSION DISCOVERY (GitHub Release Mode - T1866)
# ============================================

# Get available releases from GitHub API
# Args: [limit] (default: 10)
# Outputs: List of release tags, one per line
installer_source_get_releases() {
    local limit="${1:-10}"
    local api_url="${SOURCE_GITHUB_API}?per_page=${limit}"

    installer_log_debug "Fetching releases from GitHub API: $api_url"

    if ! command -v curl &>/dev/null && ! command -v wget &>/dev/null; then
        installer_log_warn "No downloader available - release list unavailable"
        return 1
    fi

    local response
    if command -v curl &>/dev/null; then
        response=$(curl -fsSL --connect-timeout 10 "$api_url" 2>/dev/null)
    else
        response=$(wget -q -O - --timeout=10 "$api_url" 2>/dev/null)
    fi

    if [[ -z "$response" ]]; then
        installer_log_debug "Failed to fetch releases from GitHub"
        return 1
    fi

    # Extract tag names using jq if available, fallback to grep/sed
    if command -v jq &>/dev/null; then
        echo "$response" | jq -r '.[].tag_name' 2>/dev/null
    else
        # Fallback: simple grep/sed extraction
        echo "$response" | grep -o '"tag_name":[[:space:]]*"[^"]*"' | sed 's/"tag_name":[[:space:]]*"//;s/"$//'
    fi
}

# Get the latest release tag from GitHub
# Returns: Latest tag name or empty
installer_source_get_latest() {
    local api_url="${SOURCE_GITHUB_API}/latest"

    installer_log_debug "Fetching latest release: $api_url"

    local response
    if command -v curl &>/dev/null; then
        response=$(curl -fsSL --connect-timeout 10 "$api_url" 2>/dev/null)
    elif command -v wget &>/dev/null; then
        response=$(wget -q -O - --timeout=10 "$api_url" 2>/dev/null)
    else
        installer_log_warn "No downloader available"
        return 1
    fi

    if [[ -z "$response" ]]; then
        installer_log_debug "Failed to fetch latest release"
        return 1
    fi

    if command -v jq &>/dev/null; then
        echo "$response" | jq -r '.tag_name // empty' 2>/dev/null
    else
        echo "$response" | grep -o '"tag_name":[[:space:]]*"[^"]*"' | head -1 | sed 's/"tag_name":[[:space:]]*"//;s/"$//'
    fi
}

# Get release assets for a specific tag
# Args: tag
# Outputs: "name url" pairs, one per line
installer_source_get_release_assets() {
    local tag="$1"
    local api_url="${SOURCE_GITHUB_API}/tags/$tag"

    installer_log_debug "Fetching release assets for: $tag"

    local response
    if command -v curl &>/dev/null; then
        response=$(curl -fsSL --connect-timeout 10 "$api_url" 2>/dev/null)
    elif command -v wget &>/dev/null; then
        response=$(wget -q -O - --timeout=10 "$api_url" 2>/dev/null)
    else
        return 1
    fi

    if [[ -z "$response" ]]; then
        return 1
    fi

    if command -v jq &>/dev/null; then
        echo "$response" | jq -r '.assets[] | "\(.name) \(.browser_download_url)"' 2>/dev/null
    else
        installer_log_warn "jq required for asset parsing"
        return 1
    fi
}

# Get available versions from GitHub releases (legacy wrapper)
# Args: [limit] (default: 10)
# Outputs: JSON array of versions
installer_source_get_versions() {
    local limit="${1:-10}"

    installer_log_debug "Fetching available versions (limit: $limit)"

    # Check if we can access GitHub
    if ! command -v curl &>/dev/null && ! command -v wget &>/dev/null; then
        installer_log_warn "No downloader available - version list unavailable"
        echo "[]"
        return 1
    fi

    # Try GitHub API first
    local releases
    releases=$(installer_source_get_releases "$limit" 2>/dev/null)

    if [[ -n "$releases" ]]; then
        # Convert newline-separated to JSON array
        if command -v jq &>/dev/null; then
            echo "$releases" | jq -R -s 'split("\n") | map(select(length > 0))'
        else
            # Fallback: manual JSON array construction
            local arr="["
            local first=true
            while IFS= read -r tag; do
                [[ -z "$tag" ]] && continue
                [[ "$first" != "true" ]] && arr+=","
                arr+="\"$tag\""
                first=false
            done <<< "$releases"
            arr+="]"
            echo "$arr"
        fi
        return 0
    fi

    # Fallback: Return local version if GitHub unavailable
    local local_version=""
    local source_dir
    source_dir=$(installer_source_get_dir "dev" 2>/dev/null || echo "")

    if [[ -n "$source_dir" && -f "$source_dir/VERSION" ]]; then
        local_version=$(head -n1 "$source_dir/VERSION")
    elif [[ -n "$source_dir" && -f "$source_dir/lib/core/version.sh" ]]; then
        local_version=$(grep -E "^CLEO_VERSION=" "$source_dir/lib/core/version.sh" | cut -d'"' -f2)
    fi

    if [[ -n "$local_version" ]]; then
        echo "[\"$local_version\"]"
    else
        echo "[]"
    fi
}

# Get the latest version available
# Returns: Version string or empty
installer_source_get_latest_version() {
    # Try GitHub API first
    local latest
    latest=$(installer_source_get_latest 2>/dev/null)

    if [[ -n "$latest" ]]; then
        echo "$latest"
        return 0
    fi

    # Fallback to versions list
    local versions
    versions=$(installer_source_get_versions 1)

    if command -v jq &>/dev/null; then
        echo "$versions" | jq -r '.[0] // empty'
    else
        echo "$versions" | tr -d '[]"' | cut -d',' -f1
    fi
}

# Interactive version selection
# Args: [limit] (default: 10)
# Outputs: Selected version tag
installer_source_select_version() {
    local limit="${1:-10}"

    local releases
    releases=$(installer_source_get_releases "$limit" 2>/dev/null)

    if [[ -z "$releases" ]]; then
        installer_log_error "Could not fetch available versions"
        return 1
    fi

    # Convert to array
    local versions=()
    while IFS= read -r ver; do
        [[ -n "$ver" ]] && versions+=("$ver")
    done <<< "$releases"

    if [[ ${#versions[@]} -eq 0 ]]; then
        installer_log_error "No releases found"
        return 1
    fi

    echo "Available versions:" >&2
    for i in "${!versions[@]}"; do
        echo "  $((i+1))) ${versions[$i]}" >&2
    done

    local selection
    read -rp "Select version [1]: " selection
    selection=${selection:-1}

    # Validate selection
    if ! [[ "$selection" =~ ^[0-9]+$ ]] || [[ "$selection" -lt 1 ]] || [[ "$selection" -gt ${#versions[@]} ]]; then
        installer_log_error "Invalid selection"
        return 1
    fi

    echo "${versions[$((selection-1))]}"
}

# ============================================
# FETCH OPERATIONS
# ============================================

# Main fetch dispatcher
# Args: version [target_dir]
# Returns: 0 on success, non-zero on failure
installer_source_fetch() {
    local version="${1:-latest}"
    local target_dir="${2:-$(installer_get_temp_dir)}"
    local mode
    mode=$(installer_source_detect_mode)

    installer_log_info "Fetching CLEO version: $version (mode: $mode)"

    case "$mode" in
        dev)
            installer_source_fetch_local "$target_dir"
            ;;
        release)
            installer_source_fetch_remote "$version" "$target_dir"
            ;;
        *)
            installer_log_error "Unknown fetch mode: $mode"
            return 1
            ;;
    esac
}

# Fetch from local development checkout
# Args: target_dir [use_symlinks]
#   target_dir: Directory to install to
#   use_symlinks: "true" (default) for symlinks, "false" for copy
# Returns: 0 on success, EXIT_STAGING_FAILED on failure
installer_source_fetch_local() {
    local target_dir="$1"
    local use_symlinks="${2:-true}"
    local source_dir
    source_dir=$(installer_source_get_dir "dev")

    installer_log_info "Fetching from local source: $source_dir"
    installer_log_debug "Mode: $([ "$use_symlinks" = "true" ] && echo "symlinks" || echo "copy")"

    if [[ ! -d "$source_dir" ]]; then
        installer_log_error "Source directory not found: $source_dir"
        return $EXIT_STAGING_FAILED
    fi

    # Validate the repository structure
    installer_source_validate_repo "$source_dir" || return $?

    if [[ "$use_symlinks" == "true" ]]; then
        # Dev mode: create symlinks for live development
        installer_source_link_repo "$source_dir" "$target_dir"
    else
        # Copy mode: for testing or release simulation
        installer_source_copy_repo "$source_dir" "$target_dir"
    fi
}

# Download a file with retry and progress
# Args: url output [retries] [retry_delay]
# Returns: 0 on success, EXIT_NETWORK_ERROR on failure
installer_source_download() {
    local url="$1"
    local output="$2"
    local retries="${3:-$SOURCE_DOWNLOAD_RETRIES}"
    local retry_delay="${4:-$SOURCE_DOWNLOAD_RETRY_DELAY}"

    installer_log_debug "Downloading: $url -> $output"

    for ((i=1; i<=retries; i++)); do
        installer_log_info "Downloading (attempt $i/$retries)..."

        if command -v curl &>/dev/null; then
            if curl -fSL --connect-timeout 30 --max-time "$SOURCE_DOWNLOAD_TIMEOUT" \
                   --progress-bar -o "$output" "$url" 2>/dev/null; then
                installer_log_debug "Download successful"
                return 0
            fi
        elif command -v wget &>/dev/null; then
            if wget --timeout="$SOURCE_DOWNLOAD_TIMEOUT" -q --show-progress \
                   -O "$output" "$url" 2>/dev/null; then
                installer_log_debug "Download successful"
                return 0
            fi
        else
            installer_log_error "No download utility available (need curl or wget)"
            return $EXIT_NETWORK_ERROR
        fi

        if [[ $i -lt $retries ]]; then
            installer_log_warn "Download attempt $i failed, retrying in ${retry_delay}s..."
            sleep "$retry_delay"
        fi
    done

    installer_log_error "Download failed after $retries attempts: $url"
    return $EXIT_NETWORK_ERROR
}

# Verify downloaded file checksum
# Args: file checksum_url
# Returns: 0 if verified, EXIT_CHECKSUM_FAILED on mismatch, 0 if no checksum available (warn)
installer_source_verify_checksum() {
    local file="$1"
    local checksum_url="$2"
    local lookup_name="${3:-}"  # Optional: filename to look up in checksum file

    installer_log_info "Verifying checksum..."

    # Download checksum file
    local checksum_file
    checksum_file=$(mktemp)

    if ! installer_source_download "$checksum_url" "$checksum_file" 1 0 2>/dev/null; then
        installer_log_warn "No checksum file available (verification skipped)"
        rm -f "$checksum_file"
        return 0  # Optional verification
    fi

    # Extract expected checksum for our file
    # Use lookup_name if provided, otherwise use local filename
    local filename
    filename="${lookup_name:-$(basename "$file")}"
    local expected
    expected=$(grep "$filename" "$checksum_file" 2>/dev/null | awk '{print $1}')

    rm -f "$checksum_file"

    if [[ -z "$expected" ]]; then
        installer_log_warn "Checksum entry not found for $filename"
        return 0  # Optional verification
    fi

    # Calculate actual checksum (use validate.sh function if available)
    local actual
    if declare -f installer_validate_calc_checksum &>/dev/null; then
        actual=$(installer_validate_calc_checksum "$file")
    elif command -v sha256sum &>/dev/null; then
        actual=$(sha256sum "$file" | awk '{print $1}')
    elif command -v shasum &>/dev/null; then
        actual=$(shasum -a 256 "$file" | awk '{print $1}')
    else
        installer_log_warn "No checksum utility available"
        return 0
    fi

    if [[ "$expected" == "$actual" ]]; then
        installer_log_info "Checksum verified: $filename"
        return 0
    else
        installer_log_error "Checksum mismatch!"
        installer_log_error "  Expected: $expected"
        installer_log_error "  Actual:   $actual"
        return $EXIT_CHECKSUM_FAILED
    fi
}

# Fetch from remote GitHub release (T1866 full implementation)
# Args: version target_dir
# Returns: 0 on success, non-zero on failure
installer_source_fetch_remote() {
    local version="${1:-latest}"
    local target_dir="$2"
    local temp_dir

    # Create temp directory for download
    temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/cleo-download.XXXXXX")

    # Resolve "latest" to actual version tag
    if [[ "$version" == "latest" ]]; then
        installer_log_info "Resolving latest version..."
        version=$(installer_source_get_latest)

        if [[ -z "$version" ]]; then
            installer_log_error "Could not determine latest version from GitHub"
            rm -rf "$temp_dir"
            return $EXIT_INVALID_VERSION
        fi
    fi

    # Validate version exists
    installer_log_info "Installing CLEO $version from GitHub releases"

    # Construct download URLs
    # Try tarball first, then source archive as fallback
    # Strip 'v' prefix for tarball name (release assets use bare version numbers)
    local version_bare="${version#v}"
    local tarball_name="cleo-${version_bare}.tar.gz"
    local tarball_url="${SOURCE_GITHUB_DOWNLOAD}/${version}/${tarball_name}"
    local checksum_url="${SOURCE_GITHUB_DOWNLOAD}/${version}/SHA256SUMS"

    # Fallback to GitHub-generated source archive
    local source_archive_url="https://github.com/${SOURCE_GITHUB_REPO}/archive/refs/tags/${version}.tar.gz"

    local tarball_path="$temp_dir/cleo.tar.gz"
    local use_source_archive=false

    # Try release tarball first
    installer_log_info "Downloading release tarball..."
    if ! installer_source_download "$tarball_url" "$tarball_path"; then
        installer_log_info "Release tarball not found, trying source archive..."
        use_source_archive=true

        if ! installer_source_download "$source_archive_url" "$tarball_path"; then
            installer_log_error "Failed to download CLEO $version"
            rm -rf "$temp_dir"
            return $EXIT_DOWNLOAD_FAILED
        fi
    fi

    # Verify checksum (only for release tarballs, not source archives)
    if [[ "$use_source_archive" != "true" ]]; then
        if ! installer_source_verify_checksum "$tarball_path" "$checksum_url" "$tarball_name"; then
            installer_log_error "Checksum verification failed"
            rm -rf "$temp_dir"
            return $EXIT_CHECKSUM_FAILED
        fi
    fi

    # Extract tarball
    installer_log_info "Extracting archive..."
    local extract_dir="$temp_dir/extracted"
    mkdir -p "$extract_dir"

    if ! tar -xzf "$tarball_path" -C "$extract_dir" 2>/dev/null; then
        installer_log_error "Failed to extract archive"
        rm -rf "$temp_dir"
        return $EXIT_EXTRACT_FAILED
    fi

    # Find the extracted directory (may be nested)
    local source_dir
    source_dir=$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d | head -1)

    if [[ -z "$source_dir" || ! -d "$source_dir" ]]; then
        installer_log_error "Could not find extracted content"
        rm -rf "$temp_dir"
        return $EXIT_EXTRACT_FAILED
    fi

    # Validate extracted content
    if ! installer_source_validate_repo "$source_dir"; then
        installer_log_error "Extracted archive does not contain valid CLEO installation"
        rm -rf "$temp_dir"
        return $EXIT_VALIDATION_FAILED
    fi

    # Ensure target directory exists
    mkdir -p "$target_dir"

    # Copy installable directories to target
    for dir in "${SOURCE_INSTALLABLE_DIRS[@]}"; do
        if [[ -d "$source_dir/$dir" ]]; then
            installer_log_debug "Installing: $dir/"
            [[ -e "$target_dir/$dir" ]] && rm -rf "$target_dir/$dir"
            if ! cp -r "$source_dir/$dir" "$target_dir/"; then
                installer_log_error "Failed to install: $dir"
                rm -rf "$temp_dir"
                return $EXIT_STAGING_FAILED
            fi
        fi
    done

    # Copy metadata files
    for file in "${SOURCE_COPY_FILES[@]}"; do
        if [[ -f "$source_dir/$file" ]]; then
            cp "$source_dir/$file" "$target_dir/" || true
        fi
    done

    # Write VERSION metadata with release mode info
    installer_source_write_version_metadata "$target_dir" "github:$SOURCE_GITHUB_REPO" "release"

    # Add version info
    {
        echo "version=$version"
        echo "download_url=$tarball_url"
    } >> "$target_dir/VERSION"

    # Cleanup temp directory
    rm -rf "$temp_dir"

    installer_log_info "Release installation complete: CLEO $version"
    return 0
}

# Fetch complete release (wrapper for release mode)
# Args: [version] [target_dir]
# Returns: 0 on success, non-zero on failure
installer_source_fetch_release() {
    local version="${1:-latest}"
    local target_dir="${2:-$INSTALL_DIR}"

    installer_source_fetch_remote "$version" "$target_dir"
}

# Legacy download function (wrapper for compatibility)
# Args: url target retry_count
# Returns: 0 on success, non-zero on failure
installer_source_download_file() {
    local url="$1"
    local target="$2"
    local retries="${3:-$SOURCE_DOWNLOAD_RETRIES}"

    installer_source_download "$url" "$target" "$retries"
}

# ============================================
# STAGING VERIFICATION
# ============================================

# Verify staged files are complete
# Args: staging_dir
# Returns: 0 if valid, 1 otherwise
installer_source_verify_staging() {
    local staging_dir="$1"

    if [[ ! -d "$staging_dir" ]]; then
        installer_log_error "Staging directory not found: $staging_dir"
        return 1
    fi

    # Verify minimum required files exist
    local required=(
        "lib/validation/validation.sh"
        "lib/data/file-ops.sh"
        "scripts/add.sh"
        "schemas/todo.schema.json"
    )

    for file in "${required[@]}"; do
        if [[ ! -f "$staging_dir/$file" ]]; then
            installer_log_error "Missing required file in staging: $file"
            return 1
        fi
    done

    installer_log_debug "Staging verification passed"
    return 0
}

# ============================================
# EXPORT PUBLIC API
# ============================================

# Mode detection
export -f installer_source_detect_mode
export -f installer_source_get_dir
export -f installer_source_is_dev_mode

# Repository validation
export -f installer_source_validate_repo

# Version discovery (T1866)
export -f installer_source_get_releases
export -f installer_source_get_latest
export -f installer_source_get_release_assets
export -f installer_source_get_versions
export -f installer_source_get_latest_version
export -f installer_source_select_version

# Fetch operations
export -f installer_source_fetch
export -f installer_source_fetch_local
export -f installer_source_fetch_remote
export -f installer_source_fetch_release
export -f installer_source_download
export -f installer_source_download_file
export -f installer_source_verify_checksum
export -f installer_source_verify_staging

# Dev mode symlink operations
export -f installer_source_link_repo
export -f installer_source_copy_repo
export -f installer_source_write_version_metadata

# Dev mode management
export -f installer_source_dev_status
export -f installer_source_dev_refresh

# Version management (T1868)
export -f installer_source_get_installed_version
export -f installer_source_get_installed_mode
export -f installer_source_compare_versions
export -f installer_source_check_upgrade
export -f installer_source_select_version_interactive
export -f installer_source_upgrade
export -f installer_source_version_info
export -f installer_source_check_upgrade_available

# Data file preservation (T3135)
export -f installer_source_preserve_data_files
export -f installer_source_restore_data_files
