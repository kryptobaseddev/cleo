#!/usr/bin/env bash
# release-config.sh - Release configuration loader and validator
#
# LAYER: 2 (Business Logic)
# DEPENDENCIES: config.sh, exit-codes.sh
# PROVIDES: load_release_config, validate_release_config, get_artifact_type,
#           get_release_gates, get_changelog_config
#
# @task T2669

#=== SOURCE GUARD ================================================
[[ -n "${_RELEASE_CONFIG_SH_LOADED:-}" ]] && return 0
declare -r _RELEASE_CONFIG_SH_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_RELEASE_CONFIG_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source config.sh for get_config_value and get_config_section
if [[ -f "$_RELEASE_CONFIG_LIB_DIR/core/config.sh" ]]; then
    source "$_RELEASE_CONFIG_LIB_DIR/core/config.sh"
fi

# Source exit codes if available
if [[ -f "$_RELEASE_CONFIG_LIB_DIR/core/exit-codes.sh" ]]; then
    source "$_RELEASE_CONFIG_LIB_DIR/core/exit-codes.sh"
fi

# ============================================================================
# CONSTANTS
# ============================================================================

# Default values for unconfigured projects
declare -r DEFAULT_VERSIONING_SCHEME="semver"
declare -r DEFAULT_SEMVER_TAG_PREFIX="v"
declare -r DEFAULT_CHANGELOG_FORMAT="keepachangelog"
declare -r DEFAULT_CHANGELOG_FILE="CHANGELOG.md"
declare -r DEFAULT_ARTIFACT_TYPE="generic-tarball"

# ============================================================================
# CORE FUNCTIONS
# ============================================================================

# Load release configuration from config.json
# Returns: JSON object with release configuration
# Exit codes: 0=success, 1=config file not found
# Usage: config=$(load_release_config)
load_release_config() {
    local config_file="${CONFIG_FILE:-.cleo/config.json}"

    # Check if config file exists
    if [[ ! -f "$config_file" ]]; then
        echo "ERROR: Config file not found: $config_file" >&2
        return 1
    fi

    # Extract release section directly with jq (simpler than get_config_section)
    local release_config
    release_config=$(jq -c '.release // {}' "$config_file" 2>/dev/null)

    # If release section exists, return it
    if [[ -n "$release_config" && "$release_config" != "{}" && "$release_config" != "null" ]]; then
        echo "$release_config"
        return 0
    fi

    # No release section - return empty object (use defaults)
    echo "{}"
    return 0
}

# Validate release configuration against schema
# Arguments:
#   $1 - Optional: release config JSON (defaults to loaded config)
# Returns: 0=valid, 1=invalid
# Usage: validate_release_config "$config_json"
validate_release_config() {
    local release_config="${1:-}"

    # Load config if not provided
    if [[ -z "$release_config" ]]; then
        release_config=$(load_release_config) || return 1
    fi

    # Empty config is valid (use defaults)
    if [[ "$release_config" == "{}" || "$release_config" == "null" ]]; then
        return 0
    fi

    # Basic JSON validation
    if ! echo "$release_config" | jq -e '.' >/dev/null 2>&1; then
        echo "ERROR: Invalid JSON in release configuration" >&2
        return 1
    fi

    # Validate versioning.scheme if present
    if echo "$release_config" | jq -e '.versioning.scheme' >/dev/null 2>&1; then
        local scheme
        scheme=$(echo "$release_config" | jq -r '.versioning.scheme')
        case "$scheme" in
            semver|calver|custom)
                # Valid scheme
                ;;
            *)
                echo "ERROR: Invalid versioning.scheme: $scheme (must be semver, calver, or custom)" >&2
                return 1
                ;;
        esac
    fi

    # Validate changelog.format if present
    if echo "$release_config" | jq -e '.changelog.format' >/dev/null 2>&1; then
        local format
        format=$(echo "$release_config" | jq -r '.changelog.format')
        case "$format" in
            keepachangelog|conventional|github-releases|custom)
                # Valid format
                ;;
            *)
                echo "ERROR: Invalid changelog.format: $format" >&2
                return 1
                ;;
        esac
    fi

    # Validate artifacts array if present and non-empty
    local artifacts_count
    artifacts_count=$(echo "$release_config" | jq '.artifacts | length // 0' 2>/dev/null)
    if [[ "$artifacts_count" -gt 0 ]]; then
        local artifacts
        artifacts=$(echo "$release_config" | jq -c '.artifacts[]' 2>/dev/null)

        while IFS= read -r artifact; do
            [[ -z "$artifact" ]] && continue  # Skip empty lines
            # Validate artifact type
            local artifact_type
            artifact_type=$(echo "$artifact" | jq -r '.type // empty')

            if [[ -z "$artifact_type" ]]; then
                echo "ERROR: Artifact missing required 'type' field" >&2
                return 1
            fi

            case "$artifact_type" in
                npm-package|python-wheel|python-sdist|cargo-crate|go-module|ruby-gem|github-release|docker-image|generic-tarball)
                    # Valid type
                    ;;
                *)
                    echo "ERROR: Invalid artifact type: $artifact_type" >&2
                    return 1
                    ;;
            esac
        done <<< "$artifacts"
    fi

    # Validate gates array if present and non-empty
    local gates_count
    gates_count=$(echo "$release_config" | jq '.gates | length // 0' 2>/dev/null)
    if [[ "$gates_count" -gt 0 ]]; then
        local gates
        gates=$(echo "$release_config" | jq -c '.gates[]' 2>/dev/null)

        while IFS= read -r gate; do
            [[ -z "$gate" ]] && continue  # Skip empty lines
            # Validate required fields
            local gate_name gate_command
            gate_name=$(echo "$gate" | jq -r '.name // empty')
            gate_command=$(echo "$gate" | jq -r '.command // empty')

            if [[ -z "$gate_name" ]]; then
                echo "ERROR: Gate missing required 'name' field" >&2
                return 1
            fi

            if [[ -z "$gate_command" ]]; then
                echo "ERROR: Gate '$gate_name' missing required 'command' field" >&2
                return 1
            fi

            # Validate name pattern (snake_case or kebab-case)
            if [[ ! "$gate_name" =~ ^[a-z][a-z0-9_-]*$ ]]; then
                echo "ERROR: Gate name '$gate_name' must match pattern ^[a-z][a-z0-9_-]*$" >&2
                return 1
            fi
        done <<< "$gates"
    fi

    return 0
}

# Get configured artifact type(s)
# Arguments:
#   $1 - Optional: release config JSON (defaults to loaded config)
# Returns: JSON array of artifact types (e.g., ["npm-package", "docker-image"])
# Usage: types=$(get_artifact_type "$config_json")
get_artifact_type() {
    local release_config="${1:-}"

    # Load config if not provided
    if [[ -z "$release_config" ]]; then
        release_config=$(load_release_config) || {
            echo "[]"
            return 0
        }
    fi

    # Extract artifact types from artifacts array
    local artifact_types
    artifact_types=$(echo "$release_config" | jq -c '[.artifacts[]? | select(.enabled != false) | .type] // []' 2>/dev/null)

    # If no artifacts configured, return default
    if [[ -z "$artifact_types" || "$artifact_types" == "[]" || "$artifact_types" == "null" ]]; then
        echo '["generic-tarball"]'
        return 0
    fi

    echo "$artifact_types"
}

# Get release gates configuration
# Arguments:
#   $1 - Optional: release config JSON (defaults to loaded config)
# Returns: JSON array of gate objects
# Usage: gates=$(get_release_gates "$config_json")
get_release_gates() {
    local release_config="${1:-}"

    # Load config if not provided
    if [[ -z "$release_config" ]]; then
        release_config=$(load_release_config) || {
            echo "[]"
            return 0
        }
    fi

    # Extract gates from release.gates path (new location)
    local gates
    gates=$(echo "$release_config" | jq -c '.gates // []' 2>/dev/null)

    # If no gates in new location, check deprecated locations
    if [[ "$gates" == "[]" || "$gates" == "null" ]]; then
        # Check validation.releaseGates
        local legacy_gates
        legacy_gates=$(get_config_value "validation.releaseGates" "")

        if [[ -n "$legacy_gates" && "$legacy_gates" != "[]" && "$legacy_gates" != "null" ]]; then
            echo "DEPRECATION WARNING: Using validation.releaseGates. Please migrate to release.gates" >&2
            echo "$legacy_gates"
            return 0
        fi

        # Check orchestrator.validation.customGates
        local orchestrator_gates
        orchestrator_gates=$(get_config_value "orchestrator.validation.customGates" "")

        if [[ -n "$orchestrator_gates" && "$orchestrator_gates" != "[]" && "$orchestrator_gates" != "null" ]]; then
            echo "DEPRECATION WARNING: Using orchestrator.validation.customGates. Please migrate to release.gates" >&2
            echo "$orchestrator_gates"
            return 0
        fi
    fi

    echo "$gates"
}

# Get changelog configuration
# Arguments:
#   $1 - Optional: release config JSON (defaults to loaded config)
# Returns: JSON object with changelog settings
# Usage: changelog=$(get_changelog_config "$config_json")
get_changelog_config() {
    local release_config="${1:-}"

    # Load config if not provided
    if [[ -z "$release_config" ]]; then
        release_config=$(load_release_config) || {
            # Return default changelog config
            jq -n '{
                "format": "'"$DEFAULT_CHANGELOG_FORMAT"'",
                "file": "'"$DEFAULT_CHANGELOG_FILE"'",
                "autoGenerate": true,
                "sections": ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"],
                "includeTaskIds": true,
                "unreleased": {
                    "enabled": true,
                    "header": "## [Unreleased]"
                }
            }'
            return 0
        }
    fi

    # Extract changelog section with defaults
    echo "$release_config" | jq '{
        format: (.changelog.format // "keepachangelog"),
        file: (.changelog.file // "CHANGELOG.md"),
        autoGenerate: (if .changelog.autoGenerate != null then .changelog.autoGenerate else true end),
        sections: (.changelog.sections // ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"]),
        includeTaskIds: (if .changelog.includeTaskIds != null then .changelog.includeTaskIds else true end),
        unreleased: (.changelog.unreleased // {
            enabled: true,
            header: "## [Unreleased]"
        })
    }'
}

# Get versioning configuration
# Arguments:
#   $1 - Optional: release config JSON (defaults to loaded config)
# Returns: JSON object with versioning settings
# Usage: versioning=$(get_versioning_config "$config_json")
get_versioning_config() {
    local release_config="${1:-}"

    # Load config if not provided
    if [[ -z "$release_config" ]]; then
        release_config=$(load_release_config) || {
            # Return default versioning config
            jq -n '{
                "scheme": "'"$DEFAULT_VERSIONING_SCHEME"'",
                "semver": {
                    "format": "MAJOR.MINOR.PATCH",
                    "prereleaseTags": ["alpha", "beta", "rc"],
                    "buildMetadata": true,
                    "tagPrefix": "'"$DEFAULT_SEMVER_TAG_PREFIX"'"
                },
                "strategy": "auto"
            }'
            return 0
        }
    fi

    # Extract versioning section with defaults
    echo "$release_config" | jq '{
        scheme: (.versioning.scheme // "semver"),
        semver: (.versioning.semver // {
            format: "MAJOR.MINOR.PATCH",
            prereleaseTags: ["alpha", "beta", "rc"],
            buildMetadata: true,
            tagPrefix: "v"
        }),
        calver: (.versioning.calver // {
            format: "YY.MINOR.MICRO",
            yearFormat: "YY",
            epoch: null
        }),
        strategy: (.versioning.strategy // "auto")
    }'
}

# Get security configuration
# Arguments:
#   $1 - Optional: release config JSON (defaults to loaded config)
# Returns: JSON object with security settings
# Usage: security=$(get_security_config "$config_json")
get_security_config() {
    local release_config="${1:-}"

    # Load config if not provided
    if [[ -z "$release_config" ]]; then
        release_config=$(load_release_config) || {
            # Return default security config
            jq -n '{
                "provenance": {
                    "enabled": true,
                    "framework": "slsa",
                    "level": "SLSA_BUILD_LEVEL_3"
                },
                "signing": {
                    "method": "sigstore",
                    "keyless": true
                },
                "checksums": {
                    "algorithm": "sha256",
                    "file": "checksums.txt"
                }
            }'
            return 0
        }
    fi

    # Extract security section with defaults
    echo "$release_config" | jq '{
        provenance: (.security.provenance // {
            enabled: true,
            framework: "slsa",
            level: "SLSA_BUILD_LEVEL_3"
        }),
        signing: (.security.signing // {
            method: "sigstore",
            keyless: true
        }),
        checksums: (.security.checksums // {
            algorithm: "sha256",
            file: "checksums.txt"
        })
    }'
}

# ============================================================================
# GUARD CONFIGURATION
# ============================================================================

# Get epic completeness guard mode from config
#
# Reads .release.guards.epicCompleteness from .cleo/config.json.
# Valid values: "warn" (default), "block", "off"
#
# Returns: Guard mode string to stdout
# Exit codes: 0 always
#
# Usage: mode=$(get_epic_completeness_mode)
#
# @task T4433
get_epic_completeness_mode() {
    local config_file="${CONFIG_FILE:-.cleo/config.json}"

    if [[ ! -f "$config_file" ]]; then
        echo "warn"
        return 0
    fi

    local mode
    mode=$(jq -r '.release.guards.epicCompleteness // "warn"' "$config_file" 2>/dev/null)

    # Validate and default to "warn" for unknown values
    case "$mode" in
        warn|block|off)
            echo "$mode"
            ;;
        *)
            echo "warn"
            ;;
    esac

    return 0
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f load_release_config
export -f validate_release_config
export -f get_artifact_type
export -f get_release_gates
export -f get_changelog_config
export -f get_versioning_config
export -f get_security_config
export -f get_epic_completeness_mode
