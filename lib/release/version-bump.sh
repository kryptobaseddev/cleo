#!/usr/bin/env bash
# version-bump.sh - Portable, config-driven version bump library
#
# LAYER: 2 (Business Logic)
# DEPENDENCIES: config.sh (for get_config_section)
# PROVIDES: bump_version_from_config, calculate_new_version, validate_version_format,
#           get_version_bump_config, check_version_bump_configured
#
# This library reads release.versionBump from .cleo/config.json and updates
# all configured files with the new version. It replaces the CLEO-internal
# dev/bump-version.sh with a portable, project-agnostic solution.
#
# Supports four strategies:
#   plain  - Overwrite entire file with version string (e.g., VERSION file)
#   json   - Update a JSON field via jq (e.g., package.json .version)
#   toml   - Update a TOML key via sed (e.g., Cargo.toml [package] version)
#   sed    - Apply custom sed substitution with {{VERSION}} placeholder

#=== SOURCE GUARD ================================================
[[ -n "${_VERSION_BUMP_LOADED:-}" ]] && return 0
_VERSION_BUMP_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_VB_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source config.sh for get_config_section
if [[ -f "$_VB_LIB_DIR/core/config.sh" ]]; then
    source "$_VB_LIB_DIR/core/config.sh"
fi

# ============================================================================
# CONSTANTS
# ============================================================================

# Exit codes (must match release.sh EXIT_VERSION_BUMP_FAILED=55)
export _VB_EXIT_SUCCESS=0
export _VB_EXIT_NOT_CONFIGURED=55
export _VB_EXIT_INVALID_VERSION=55
export _VB_EXIT_FILE_NOT_FOUND=55
export _VB_EXIT_BUMP_FAILED=55
export _VB_EXIT_VALIDATION_FAILED=55

# Version regex
export _VB_SEMVER_REGEX='^[0-9]+\.[0-9]+\.[0-9]+$'

# ============================================================================
# VERSION ARITHMETIC
# ============================================================================

# validate_version_format - Check that a string is valid semver X.Y.Z
#
# Args:
#   $1 - Version string to validate
#
# Returns: 0 if valid, 1 if invalid
# Outputs: Nothing on success, error message to stderr on failure
validate_version_format() {
    local version="$1"
    if [[ ! "$version" =~ $_VB_SEMVER_REGEX ]]; then
        echo "Invalid version format: '$version' (expected X.Y.Z)" >&2
        return 1
    fi
    return 0
}

# calculate_new_version - Compute new version from current + bump type
#
# Args:
#   $1 - Current version (X.Y.Z)
#   $2 - Bump type: "patch", "minor", "major", or explicit "X.Y.Z"
#
# Returns: 0 on success, 1 on invalid input
# Outputs: New version string to stdout
calculate_new_version() {
    local current="$1"
    local bump_type="$2"

    case "$bump_type" in
        patch|minor|major)
            local major minor patch
            IFS='.' read -r major minor patch <<< "$current"
            case "$bump_type" in
                patch) echo "$major.$minor.$((patch + 1))" ;;
                minor) echo "$major.$((minor + 1)).0" ;;
                major) echo "$((major + 1)).0.0" ;;
            esac
            ;;
        *)
            # Explicit version — validate and return
            if validate_version_format "$bump_type"; then
                echo "$bump_type"
            else
                return 1
            fi
            ;;
    esac
}

# ============================================================================
# CONFIG READING
# ============================================================================

# check_version_bump_configured - Check if release.versionBump.files is configured
#
# Args:
#   $1 - (optional) Config file path (default: .cleo/config.json)
#
# Returns: 0 if configured with at least one file, 1 if not configured
# Outputs: Actionable error message to stderr if not configured
check_version_bump_configured() {
    local config_file="${1:-.cleo/config.json}"

    if [[ ! -f "$config_file" ]]; then
        _vb_actionable_error "$config_file"
        return 1
    fi

    local enabled
    enabled=$(jq -r 'if .release.versionBump.enabled == false then "false" else "true" end' "$config_file" 2>/dev/null)
    if [[ "$enabled" == "false" ]]; then
        echo "Version bump is disabled in config (release.versionBump.enabled = false)" >&2
        return 1
    fi

    local file_count
    file_count=$(jq -r '.release.versionBump.files // [] | length' "$config_file" 2>/dev/null)

    if [[ "$file_count" == "0" ]] || [[ -z "$file_count" ]]; then
        _vb_actionable_error "$config_file"
        return 1
    fi

    return 0
}

# get_version_bump_config - Read version bump configuration as JSON
#
# Args:
#   $1 - (optional) Config file path (default: .cleo/config.json)
#
# Returns: 0 on success, 1 if not configured
# Outputs: JSON object with versionBump config to stdout
get_version_bump_config() {
    local config_file="${1:-.cleo/config.json}"

    if ! check_version_bump_configured "$config_file"; then
        return 1
    fi

    jq -c '.release.versionBump // {}' "$config_file" 2>/dev/null
}

# _vb_actionable_error - Print actionable error telling user what to configure
#
# Args:
#   $1 - Config file path
_vb_actionable_error() {
    local config_file="$1"
    cat >&2 <<'ACTIONABLE_EOF'
Version bump not configured. Add version bump targets to your project config.

Minimal example (add to .cleo/config.json under "release"):

  "versionBump": {
    "files": [
      { "path": "VERSION", "strategy": "plain" }
    ]
  }

Common configurations by language:

  Node.js:
    { "path": "package.json", "strategy": "json", "jsonPath": ".version" }

  Rust:
    { "path": "Cargo.toml", "strategy": "toml", "tomlKey": "package.version" }

  Python (pyproject.toml):
    { "path": "pyproject.toml", "strategy": "toml", "tomlKey": "project.version" }

  Custom sed pattern (e.g., README badge):
    { "path": "README.md", "strategy": "sed",
      "sedPattern": "s|version-[0-9]+\\.[0-9]+\\.[0-9]+-|version-{{VERSION}}-|g",
      "sedMatch": "version-[0-9]", "optional": true }

Run: cleo config set release.versionBump.files '[...]'
Or edit .cleo/config.json directly.
ACTIONABLE_EOF
}

# ============================================================================
# FILE UPDATE STRATEGIES
# ============================================================================

# _vb_update_plain - Overwrite file with version string
#
# Args:
#   $1 - File path
#   $2 - New version
#   $3 - Dry run ("true"/"false")
#
# Returns: 0 on success, 1 on failure
_vb_update_plain() {
    local file="$1" new_version="$2" dry_run="$3"

    if [[ "$dry_run" == "true" ]]; then
        return 0
    fi

    echo "$new_version" > "$file"
}

# _vb_update_json - Update a JSON field via jq
#
# Args:
#   $1 - File path
#   $2 - New version
#   $3 - jq path expression (e.g., ".version")
#   $4 - Dry run ("true"/"false")
#
# Returns: 0 on success, 1 on failure
_vb_update_json() {
    local file="$1" new_version="$2" jq_path="$3" dry_run="$4"

    if ! command -v jq >/dev/null 2>&1; then
        echo "jq is required for JSON strategy but not found" >&2
        return 1
    fi

    if [[ "$dry_run" == "true" ]]; then
        return 0
    fi

    local tmp_file
    tmp_file=$(mktemp "${file}.XXXXXX")

    # Build jq expression: .version = "X.Y.Z" or .package.version = "X.Y.Z"
    if jq --arg v "$new_version" "${jq_path} = \$v" "$file" > "$tmp_file" 2>/dev/null; then
        mv "$tmp_file" "$file"
    else
        rm -f "$tmp_file"
        echo "jq update failed for ${file} path ${jq_path}" >&2
        return 1
    fi
}

# _vb_update_toml - Update a TOML key via sed
#
# Handles keys in format: key = "value" or key = "value" within sections.
# For dotted keys like "package.version", looks for [package] section then version = "...".
#
# Args:
#   $1 - File path
#   $2 - New version
#   $3 - TOML key (e.g., "version" or "package.version")
#   $4 - Dry run ("true"/"false")
#
# Returns: 0 on success, 1 on failure
_vb_update_toml() {
    local file="$1" new_version="$2" toml_key="$3" dry_run="$4"

    if [[ "$dry_run" == "true" ]]; then
        return 0
    fi

    local key_name="$toml_key"

    # Handle dotted keys: "package.version" -> find [package] section, update "version"
    if [[ "$toml_key" == *.* ]]; then
        local section="${toml_key%.*}"
        key_name="${toml_key##*.}"

        # Verify section exists
        if ! grep -q "^\[${section}\]" "$file" 2>/dev/null; then
            echo "TOML section [${section}] not found in ${file}" >&2
            return 1
        fi

        # Use awk to update key only within the target section
        local tmp_file
        tmp_file=$(mktemp "${file}.XXXXXX")
        awk -v section="[${section}]" -v key="$key_name" -v ver="$new_version" '
            BEGIN { in_section = 0 }
            /^\[/ {
                in_section = ($0 == section) ? 1 : 0
            }
            in_section && $0 ~ "^" key " *= *\"" {
                sub(/"[^"]*"/, "\"" ver "\"")
            }
            { print }
        ' "$file" > "$tmp_file"

        if [[ -s "$tmp_file" ]]; then
            mv "$tmp_file" "$file"
        else
            rm -f "$tmp_file"
            echo "TOML update failed for ${file} key ${toml_key}" >&2
            return 1
        fi
    else
        # Simple key at root level: version = "X.Y.Z"
        if ! grep -q "^${key_name} *= *\"" "$file" 2>/dev/null; then
            echo "TOML key '${key_name}' not found in ${file}" >&2
            return 1
        fi
        sed -i "s|^\(${key_name} *= *\)\"[^\"]*\"|\1\"${new_version}\"|" "$file"
    fi
}

# _vb_update_sed - Apply custom sed pattern with {{VERSION}} placeholder
#
# Args:
#   $1 - File path
#   $2 - New version
#   $3 - sed pattern with {{VERSION}} placeholder
#   $4 - (optional) grep match pattern for verification
#   $5 - Dry run ("true"/"false")
#
# Returns: 0 on success, 1 on failure
_vb_update_sed() {
    local file="$1" new_version="$2" pattern="$3" match="${4:-}" dry_run="$5"

    # Verify target pattern exists if sedMatch is provided
    if [[ -n "$match" ]]; then
        if ! grep -q "$match" "$file" 2>/dev/null; then
            echo "sed match pattern '${match}' not found in ${file}" >&2
            return 1
        fi
    fi

    if [[ "$dry_run" == "true" ]]; then
        return 0
    fi

    # Replace {{VERSION}} with actual version
    local resolved_pattern="${pattern//\{\{VERSION\}\}/$new_version}"

    sed -i "$resolved_pattern" "$file"
}

# ============================================================================
# MAIN BUMP FUNCTION
# ============================================================================

# bump_version_from_config - Bump version in all configured files
#
# Reads release.versionBump.files from config, creates backups,
# applies updates, and runs optional validation commands.
#
# Args:
#   $1 - New version (X.Y.Z, no 'v' prefix)
#   $2 - (optional) Dry run: "true"/"false" (default: "false")
#   $3 - (optional) Config file path (default: .cleo/config.json)
#
# Returns: 0 on success, non-zero on failure
# Outputs: JSON result object to stdout with per-file results
#
# Exit codes:
#   0  - All files bumped successfully
#   55 - Configuration missing, version invalid, or bump failed
bump_version_from_config() {
    local new_version="$1"
    local dry_run="${2:-false}"
    local config_file="${3:-.cleo/config.json}"

    # Validate version format
    if ! validate_version_format "$new_version"; then
        return $_VB_EXIT_INVALID_VERSION
    fi

    # Read config
    local config
    if ! config=$(get_version_bump_config "$config_file"); then
        return $_VB_EXIT_NOT_CONFIGURED
    fi

    # Run pre-validation if configured
    local pre_validate
    pre_validate=$(echo "$config" | jq -r '.preValidate // empty')
    if [[ -n "$pre_validate" ]]; then
        if [[ "$dry_run" != "true" ]]; then
            if ! eval "$pre_validate" >/dev/null 2>&1; then
                echo "Pre-validation command failed: $pre_validate" >&2
                return $_VB_EXIT_VALIDATION_FAILED
            fi
        fi
    fi

    # Process each file
    local file_count
    file_count=$(echo "$config" | jq -r '.files | length')

    local results=()
    local all_ok=true
    local i=0

    while [[ $i -lt $file_count ]]; do
        local file_config
        file_config=$(echo "$config" | jq -c ".files[$i]")

        local path strategy optional description
        path=$(echo "$file_config" | jq -r '.path')
        strategy=$(echo "$file_config" | jq -r '.strategy')
        optional=$(echo "$file_config" | jq -r '.optional // false')
        description=$(echo "$file_config" | jq -r '.description // .path')

        # Check file exists
        if [[ ! -f "$path" ]]; then
            if [[ "$optional" == "true" ]]; then
                results+=("{\"path\":\"$path\",\"status\":\"skipped\",\"reason\":\"file not found (optional)\"}")
                ((i++))
                continue
            else
                echo "Required file not found: $path" >&2
                results+=("{\"path\":\"$path\",\"status\":\"failed\",\"reason\":\"file not found\"}")
                all_ok=false
                ((i++))
                continue
            fi
        fi

        # Create backup (unless dry run)
        if [[ "$dry_run" != "true" ]]; then
            cp "$path" "${path}.vb-bak"
        fi

        # Apply strategy
        local update_result=0
        case "$strategy" in
            plain)
                _vb_update_plain "$path" "$new_version" "$dry_run" || update_result=$?
                ;;
            json)
                local jq_path
                jq_path=$(echo "$file_config" | jq -r '.jsonPath // ".version"')
                _vb_update_json "$path" "$new_version" "$jq_path" "$dry_run" || update_result=$?
                ;;
            toml)
                local toml_key
                toml_key=$(echo "$file_config" | jq -r '.tomlKey // "version"')
                _vb_update_toml "$path" "$new_version" "$toml_key" "$dry_run" || update_result=$?
                ;;
            sed)
                local sed_pattern sed_match
                sed_pattern=$(echo "$file_config" | jq -r '.sedPattern // ""')
                sed_match=$(echo "$file_config" | jq -r '.sedMatch // ""')
                if [[ -z "$sed_pattern" ]]; then
                    echo "sed strategy requires 'sedPattern' for $path" >&2
                    update_result=1
                else
                    _vb_update_sed "$path" "$new_version" "$sed_pattern" "$sed_match" "$dry_run" || update_result=$?
                fi
                ;;
            *)
                echo "Unknown strategy '$strategy' for $path (expected: plain, json, toml, sed)" >&2
                update_result=1
                ;;
        esac

        if [[ $update_result -ne 0 ]]; then
            if [[ "$optional" == "true" ]]; then
                # Optional files: pattern mismatch or update failure is a skip, not an error
                results+=("{\"path\":\"$path\",\"status\":\"skipped\",\"reason\":\"$strategy update failed (optional)\"}")
                # Restore backup for optional file that failed
                if [[ "$dry_run" != "true" ]] && [[ -f "${path}.vb-bak" ]]; then
                    mv "${path}.vb-bak" "$path"
                fi
            else
                results+=("{\"path\":\"$path\",\"status\":\"failed\",\"reason\":\"$strategy update failed\"}")
                all_ok=false
            fi
        else
            local status_label="updated"
            [[ "$dry_run" == "true" ]] && status_label="would-update"
            results+=("{\"path\":\"$path\",\"status\":\"$status_label\",\"strategy\":\"$strategy\"}")
        fi

        ((i++))
    done

    # Run post-validation if configured (and not dry-run, and all files OK)
    local post_validate
    post_validate=$(echo "$config" | jq -r '.postValidate // empty')
    if [[ -n "$post_validate" ]] && [[ "$dry_run" != "true" ]] && [[ "$all_ok" == "true" ]]; then
        if ! eval "$post_validate" >/dev/null 2>&1; then
            echo "Post-validation command failed: $post_validate" >&2
            # Restore backups on post-validation failure
            _vb_restore_backups "$config" "$file_count"
            return $_VB_EXIT_VALIDATION_FAILED
        fi
    fi

    # Clean up backups on success (unless dry run or failure)
    if [[ "$dry_run" != "true" ]] && [[ "$all_ok" == "true" ]]; then
        _vb_cleanup_backups "$config" "$file_count"
    fi

    # If any files failed, restore their backups
    if [[ "$all_ok" != "true" ]] && [[ "$dry_run" != "true" ]]; then
        _vb_restore_backups "$config" "$file_count"
    fi

    # Build result JSON
    local results_json="["
    local first=true
    for r in "${results[@]}"; do
        [[ "$first" == "true" ]] && first=false || results_json+=","
        results_json+="$r"
    done
    results_json+="]"

    jq -n \
        --arg version "$new_version" \
        --argjson dryRun "$([[ "$dry_run" == "true" ]] && echo true || echo false)" \
        --argjson success "$([[ "$all_ok" == "true" ]] && echo true || echo false)" \
        --argjson files "$results_json" \
        '{
            version: $version,
            dryRun: $dryRun,
            success: $success,
            filesProcessed: ($files | length),
            filesUpdated: ($files | map(select(.status == "updated" or .status == "would-update")) | length),
            filesSkipped: ($files | map(select(.status == "skipped")) | length),
            filesFailed: ($files | map(select(.status == "failed")) | length),
            files: $files
        }'

    if [[ "$all_ok" != "true" ]]; then
        return $_VB_EXIT_BUMP_FAILED
    fi
}

# ============================================================================
# BACKUP MANAGEMENT
# ============================================================================

# _vb_cleanup_backups - Remove .vb-bak files for all configured paths
_vb_cleanup_backups() {
    local config="$1" file_count="$2"
    local i=0
    while [[ $i -lt $file_count ]]; do
        local path
        path=$(echo "$config" | jq -r ".files[$i].path")
        rm -f "${path}.vb-bak"
        ((i++))
    done
}

# _vb_restore_backups - Restore .vb-bak files for all configured paths
_vb_restore_backups() {
    local config="$1" file_count="$2"
    local i=0
    while [[ $i -lt $file_count ]]; do
        local path
        path=$(echo "$config" | jq -r ".files[$i].path")
        if [[ -f "${path}.vb-bak" ]]; then
            mv "${path}.vb-bak" "$path"
        fi
        ((i++))
    done
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f validate_version_format
export -f calculate_new_version
export -f check_version_bump_configured
export -f get_version_bump_config
export -f bump_version_from_config
