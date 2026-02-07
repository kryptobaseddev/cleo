#!/usr/bin/env bash
# CLEO Installer - Integrity Verification
# Validates checksums, directory structure, permissions, and installation state
#
# Version: 1.0.0
# Task: T1860
# Based on: claudedocs/research-outputs/2026-01-20_modular-installer-architecture.md
#
# LAYER: 1 (Utilities)
# DEPENDENCIES: core.sh
# PROVIDES: installer_validate_checksums, installer_validate_structure,
#           installer_validate_permissions, installer_validate_installation

# ============================================
# GUARD: Prevent double-sourcing
# ============================================
[[ -n "${_INSTALLER_VALIDATE_LOADED:-}" ]] && return 0
readonly _INSTALLER_VALIDATE_LOADED=1

# ============================================
# DEPENDENCIES
# ============================================
INSTALLER_LIB_DIR="${INSTALLER_LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
source "${INSTALLER_LIB_DIR}/core.sh"

# ============================================
# CONSTANTS
# ============================================
readonly VALIDATE_REQUIRED_DIRS=(
    "lib"
    "scripts"
    "schemas"
)

readonly VALIDATE_REQUIRED_FILES=(
    "lib/validation.sh"
    "lib/file-ops.sh"
    "lib/config.sh"
    "scripts/add.sh"
    "schemas/todo.schema.json"
)

# Minimum disk space required (in MB)
readonly VALIDATE_MIN_DISK_SPACE_MB=50

# ============================================
# CHECKSUM VERIFICATION
# ============================================

# Calculate SHA256 checksum for a file
# Args: file_path
# Returns: checksum string or empty on failure
installer_validate_calc_checksum() {
    local file="$1"

    [[ ! -f "$file" ]] && return 1

    if command -v sha256sum &>/dev/null; then
        sha256sum "$file" | cut -d' ' -f1
    elif command -v shasum &>/dev/null; then
        shasum -a 256 "$file" | cut -d' ' -f1
    else
        installer_log_warn "No checksum utility available"
        return 1
    fi
}

# Verify a single file's checksum
# Args: file_path expected_checksum
# Returns: 0 if matches, 1 otherwise
installer_validate_checksum() {
    local file="$1"
    local expected="$2"

    local actual
    actual=$(installer_validate_calc_checksum "$file") || {
        installer_log_error "Failed to calculate checksum for: $file"
        return 1
    }

    if [[ "$actual" == "$expected" ]]; then
        installer_log_debug "Checksum OK: $file"
        return 0
    else
        installer_log_error "Checksum mismatch for $file"
        installer_log_error "  Expected: $expected"
        installer_log_error "  Actual:   $actual"
        return 1
    fi
}

# Verify checksums from a manifest file
# Args: manifest_file base_dir
# Returns: 0 if all match, 1 otherwise
# Manifest format: SHA256 FILENAME (one per line)
installer_validate_checksums() {
    local manifest="$1"
    local base_dir="${2:-.}"
    local failed=0
    local checked=0

    [[ ! -f "$manifest" ]] && {
        installer_log_error "Checksum manifest not found: $manifest"
        return 1
    }

    installer_log_info "Verifying checksums from: $manifest"

    while IFS=' ' read -r expected_sum filename; do
        # Skip comments and empty lines
        [[ -z "$expected_sum" || "$expected_sum" == "#"* ]] && continue

        local file_path="$base_dir/$filename"

        if [[ ! -f "$file_path" ]]; then
            installer_log_error "File missing: $filename"
            ((failed++))
            continue
        fi

        if installer_validate_checksum "$file_path" "$expected_sum"; then
            ((checked++))
        else
            ((failed++))
        fi
    done < "$manifest"

    if [[ $failed -gt 0 ]]; then
        installer_log_error "Checksum verification failed: $failed file(s) did not match"
        return 1
    fi

    installer_log_info "Checksum verification passed: $checked file(s) verified"
    return 0
}

# Generate checksums for a directory
# Args: dir output_manifest
# Returns: 0 on success, 1 on failure
installer_validate_generate_checksums() {
    local dir="$1"
    local manifest="${2:-$dir/CHECKSUMS.sha256}"

    [[ ! -d "$dir" ]] && {
        installer_log_error "Directory not found: $dir"
        return 1
    }

    installer_log_info "Generating checksums for: $dir"

    local temp_manifest="${manifest}.tmp.$$"

    # Find all files and generate checksums
    find "$dir" -type f ! -name "*.sha256" ! -name ".*" -print0 | \
        while IFS= read -r -d '' file; do
            local rel_path="${file#$dir/}"
            local checksum
            checksum=$(installer_validate_calc_checksum "$file") || continue
            echo "$checksum $rel_path"
        done > "$temp_manifest"

    if [[ -s "$temp_manifest" ]]; then
        mv "$temp_manifest" "$manifest"
        installer_log_info "Checksums written to: $manifest"
        return 0
    else
        rm -f "$temp_manifest"
        installer_log_error "Failed to generate checksums"
        return 1
    fi
}

# ============================================
# STRUCTURE VERIFICATION
# ============================================

# Verify required directory structure exists
# Args: base_dir
# Returns: 0 if structure valid, 1 otherwise
installer_validate_structure() {
    local base_dir="${1:-$INSTALL_DIR}"
    local failed=0

    installer_log_info "Validating directory structure: $base_dir"

    # Check required directories
    for dir in "${VALIDATE_REQUIRED_DIRS[@]}"; do
        if [[ ! -d "$base_dir/$dir" ]]; then
            installer_log_error "Missing required directory: $dir"
            ((failed++))
        else
            installer_log_debug "Directory OK: $dir"
        fi
    done

    # Check required files
    for file in "${VALIDATE_REQUIRED_FILES[@]}"; do
        if [[ ! -f "$base_dir/$file" ]]; then
            installer_log_error "Missing required file: $file"
            ((failed++))
        else
            installer_log_debug "File OK: $file"
        fi
    done

    if [[ $failed -gt 0 ]]; then
        installer_log_error "Structure validation failed: $failed missing item(s)"
        return 1
    fi

    installer_log_info "Directory structure validated"
    return 0
}

# ============================================
# PERMISSION VERIFICATION
# ============================================

# Check if directory is writable
# Args: dir
# Returns: 0 if writable, 1 otherwise
installer_validate_writable() {
    local dir="$1"

    # Create dir if it doesn't exist
    if [[ ! -d "$dir" ]]; then
        local parent
        parent=$(dirname "$dir")
        if [[ ! -w "$parent" ]]; then
            installer_log_error "Cannot write to parent directory: $parent"
            return 1
        fi
        return 0
    fi

    if [[ ! -w "$dir" ]]; then
        installer_log_error "Directory not writable: $dir"
        return 1
    fi

    return 0
}

# Check permissions on installed files
# Args: base_dir
# Returns: 0 if permissions valid, 1 otherwise
installer_validate_permissions() {
    local base_dir="${1:-$INSTALL_DIR}"
    local failed=0

    installer_log_info "Validating file permissions: $base_dir"

    # Check that script files are executable
    while IFS= read -r -d '' script; do
        if [[ ! -x "$script" ]]; then
            installer_log_warn "Script not executable: ${script#$base_dir/}"
            ((failed++))
        fi
    done < <(find "$base_dir/scripts" -name "*.sh" -type f -print0 2>/dev/null)

    # Check lib files are readable
    while IFS= read -r -d '' lib; do
        if [[ ! -r "$lib" ]]; then
            installer_log_error "Library not readable: ${lib#$base_dir/}"
            ((failed++))
        fi
    done < <(find "$base_dir/lib" -name "*.sh" -type f -print0 2>/dev/null)

    # Check install directory ownership
    local owner
    owner=$(stat -c '%U' "$base_dir" 2>/dev/null || stat -f '%Su' "$base_dir" 2>/dev/null)
    if [[ "$owner" != "$(whoami)" ]]; then
        installer_log_warn "Directory owner ($owner) differs from current user ($(whoami))"
    fi

    if [[ $failed -gt 0 ]]; then
        installer_log_error "Permission validation found $failed issue(s)"
        return 1
    fi

    installer_log_info "Permissions validated"
    return 0
}

# ============================================
# DISK SPACE VERIFICATION
# ============================================

# Check available disk space
# Args: dir required_mb
# Returns: 0 if sufficient space, 1 otherwise
installer_validate_disk_space() {
    local dir="${1:-$HOME}"
    local required_mb="${2:-$VALIDATE_MIN_DISK_SPACE_MB}"

    # Get available space in MB
    local available_mb

    if df -BM "$dir" &>/dev/null; then
        # GNU df
        available_mb=$(df -BM "$dir" | tail -1 | awk '{print $4}' | sed 's/M//')
    else
        # BSD df (macOS)
        local available_kb
        available_kb=$(df -k "$dir" | tail -1 | awk '{print $4}')
        available_mb=$((available_kb / 1024))
    fi

    if [[ "$available_mb" -lt "$required_mb" ]]; then
        installer_log_error "Insufficient disk space: ${available_mb}MB available, ${required_mb}MB required"
        return 1
    fi

    installer_log_debug "Disk space OK: ${available_mb}MB available"
    return 0
}

# ============================================
# VERSION COMPARISON
# ============================================

# Compare two semantic versions
# Args: version1 version2
# Returns: -1 if v1<v2, 0 if v1==v2, 1 if v1>v2
# Output: Comparison result to stdout
installer_validate_compare_versions() {
    local v1="$1"
    local v2="$2"

    # Strip leading 'v' if present
    v1="${v1#v}"
    v2="${v2#v}"

    if [[ "$v1" == "$v2" ]]; then
        echo "0"
        return 0
    fi

    # Split into arrays
    IFS='.' read -ra v1_parts <<< "$v1"
    IFS='.' read -ra v2_parts <<< "$v2"

    local max_parts=$((${#v1_parts[@]} > ${#v2_parts[@]} ? ${#v1_parts[@]} : ${#v2_parts[@]}))

    for ((i = 0; i < max_parts; i++)); do
        local p1="${v1_parts[$i]:-0}"
        local p2="${v2_parts[$i]:-0}"

        # Handle non-numeric parts (e.g., alpha, beta)
        if [[ "$p1" =~ ^[0-9]+$ ]] && [[ "$p2" =~ ^[0-9]+$ ]]; then
            if ((p1 > p2)); then
                echo "1"
                return 0
            elif ((p1 < p2)); then
                echo "-1"
                return 0
            fi
        else
            # String comparison for non-numeric parts
            if [[ "$p1" > "$p2" ]]; then
                echo "1"
                return 0
            elif [[ "$p1" < "$p2" ]]; then
                echo "-1"
                return 0
            fi
        fi
    done

    echo "0"
    return 0
}

# Get installed CLEO version
# Args: [install_dir]
# Returns: version string or empty
installer_validate_get_installed_version() {
    local install_dir="${1:-$INSTALL_DIR}"
    local version_file="$install_dir/VERSION"
    local lib_version="$install_dir/lib/version.sh"

    if [[ -f "$version_file" ]]; then
        cat "$version_file"
    elif [[ -f "$lib_version" ]]; then
        # Extract version from lib/version.sh
        grep -E "^CLEO_VERSION=" "$lib_version" | cut -d'"' -f2
    else
        echo ""
    fi
}

# ============================================
# FULL VALIDATION SUITE
# ============================================

# Run complete installation validation
# Args: [base_dir]
# Returns: 0 if valid, 1 otherwise
installer_validate_installation() {
    local base_dir="${1:-$INSTALL_DIR}"
    local failed=0

    installer_log_step "Running installation validation..."

    # Check structure
    installer_validate_structure "$base_dir" || ((failed++))

    # Check permissions
    installer_validate_permissions "$base_dir" || ((failed++))

    # Check disk space
    installer_validate_disk_space "$base_dir" || ((failed++))

    # Verify version file exists
    local version
    version=$(installer_validate_get_installed_version "$base_dir")
    if [[ -z "$version" ]]; then
        installer_log_warn "Version information not found"
    else
        installer_log_info "Installed version: $version"
    fi

    # Verify checksums if manifest exists
    local manifest="$base_dir/CHECKSUMS.sha256"
    if [[ -f "$manifest" ]]; then
        installer_validate_checksums "$manifest" "$base_dir" || ((failed++))
    else
        installer_log_debug "No checksum manifest found (optional)"
    fi

    if [[ $failed -gt 0 ]]; then
        installer_log_error "Installation validation failed with $failed error(s)"
        return $EXIT_VALIDATION_FAILED
    fi

    installer_log_info "Installation validation passed"
    return 0
}

# ============================================
# EXPORT PUBLIC API
# ============================================
export -f installer_validate_calc_checksum
export -f installer_validate_checksum
export -f installer_validate_checksums
export -f installer_validate_generate_checksums
export -f installer_validate_structure
export -f installer_validate_writable
export -f installer_validate_permissions
export -f installer_validate_disk_space
export -f installer_validate_compare_versions
export -f installer_validate_get_installed_version
export -f installer_validate_installation
