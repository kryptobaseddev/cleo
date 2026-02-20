#!/usr/bin/env bash
# release-provenance.sh - Release provenance tracking and SLSA attestation
#
# LAYER: 2 (Business Logic)
# DEPENDENCIES: file-ops.sh, config.sh, release-config.sh
# PROVIDES: link_task_to_release, get_release_provenance, generate_provenance_report,
#           record_release, get_task_releases, verify_provenance_chain
#
# PURPOSE: Track full provenance chain: Task → Commit → PR → Changelog → Release → Artifact
#          Store in .cleo/releases.json with SLSA Level 3 metadata
#
# @task T2672

#=== SOURCE GUARD ================================================
[[ -n "${_RELEASE_PROVENANCE_SH_LOADED:-}" ]] && return 0
declare -r _RELEASE_PROVENANCE_SH_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_RELEASE_PROV_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source file operations for atomic writes
if [[ -f "$_RELEASE_PROV_LIB_DIR/data/file-ops.sh" ]]; then
    source "$_RELEASE_PROV_LIB_DIR/data/file-ops.sh"
fi

# Source config for unified config access
if [[ -f "$_RELEASE_PROV_LIB_DIR/core/config.sh" ]]; then
    source "$_RELEASE_PROV_LIB_DIR/core/config.sh"
fi

# Source release config for security settings
if [[ -f "$_RELEASE_PROV_LIB_DIR/release/release-config.sh" ]]; then
    source "$_RELEASE_PROV_LIB_DIR/release/release-config.sh"
fi

# Source exit codes if available
if [[ -f "$_RELEASE_PROV_LIB_DIR/core/exit-codes.sh" ]]; then
    source "$_RELEASE_PROV_LIB_DIR/core/exit-codes.sh"
fi

# ============================================================================
# CONSTANTS
# ============================================================================

declare -r RELEASES_FILE="${CLEO_DIR:-.cleo}/releases.json"
declare -r SLSA_VERSION="1.0"
declare -r DEFAULT_SLSA_LEVEL="SLSA_BUILD_LEVEL_3"

# ============================================================================
# INITIALIZATION
# ============================================================================

# Initialize releases.json if it doesn't exist
# Creates empty structure with metadata
# Usage: _init_releases_file
_init_releases_file() {
    local releases_file="$1"

    if [[ -f "$releases_file" ]]; then
        return 0
    fi

    # Create parent directory
    local releases_dir
    releases_dir="$(dirname "$releases_file")"
    mkdir -p "$releases_dir"

    # Create initial structure
    local init_content
    init_content=$(jq -n '{
        "_meta": {
            "schemaVersion": "1.0.0",
            "createdAt": (now | strftime("%Y-%m-%dT%H:%M:%SZ")),
            "updatedAt": (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
        },
        "releases": []
    }')

    echo "$init_content" > "$releases_file"
}

# ============================================================================
# CORE FUNCTIONS
# ============================================================================

# Record a new release with full provenance metadata
# Arguments:
#   $1 - version (semver or calver)
#   $2 - artifacts JSON array (optional, defaults to [])
#   $3 - commits JSON array (optional, defaults to [])
#   $4 - tasks JSON array (optional, defaults to [])
# Returns: 0=success, 1=validation failed, 2=write failed
# Usage: record_release "1.0.0" '[{"type":"npm-package","sha256":"..."}]' '["abc123"]' '["T2666"]'
record_release() {
    local version="$1"
    local artifacts="${2:-[]}"
    local commits="${3:-[]}"
    local tasks="${4:-[]}"

    # Validate version format
    if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$ ]]; then
        echo "ERROR: Invalid version format: $version (must be semver or calver)" >&2
        return 1
    fi

    # Initialize file if needed
    _init_releases_file "$RELEASES_FILE"

    # Get security configuration
    local security_config
    security_config=$(get_security_config 2>/dev/null || echo '{}')

    local provenance_enabled
    provenance_enabled=$(echo "$security_config" | jq -r '.provenance.enabled // true')

    local slsa_level
    slsa_level=$(echo "$security_config" | jq -r '.provenance.level // "SLSA_BUILD_LEVEL_3"')

    local signing_method
    signing_method=$(echo "$security_config" | jq -r '.signing.method // "sigstore"')

    local signing_keyless
    signing_keyless=$(echo "$security_config" | jq -r '.signing.keyless // true')

    # Build release entry
    local release_entry
    release_entry=$(jq -n \
        --arg version "$version" \
        --arg date "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
        --argjson artifacts "$artifacts" \
        --argjson commits "$commits" \
        --argjson tasks "$tasks" \
        --arg slsaLevel "$slsa_level" \
        --arg signingMethod "$signing_method" \
        --argjson signingKeyless "$signing_keyless" \
        --argjson provenanceEnabled "$provenance_enabled" \
        '{
            version: $version,
            date: $date,
            tasks: $tasks,
            commits: $commits,
            artifacts: $artifacts,
            provenance: {
                slsaVersion: "1.0",
                slsaLevel: $slsaLevel,
                enabled: $provenanceEnabled,
                buildType: "https://github.com/cleo/cleo-release@v1",
                builder: {
                    id: "https://github.com/cleo/cleo-release/builder@v1"
                },
                invocation: {
                    configSource: {
                        uri: "git+https://github.com/cleo/cleo",
                        digest: {}
                    }
                },
                metadata: {
                    buildInvocationId: "",
                    buildStartedOn: $date,
                    buildFinishedOn: $date,
                    completeness: {
                        parameters: true,
                        environment: false,
                        materials: true
                    },
                    reproducible: false
                }
            },
            signing: {
                method: $signingMethod,
                keyless: $signingKeyless,
                signed: false
            }
        }')

    # Read current releases
    local current_releases
    current_releases=$(jq -c '.releases' "$RELEASES_FILE")

    # Check for duplicate version
    local existing
    existing=$(echo "$current_releases" | jq --arg v "$version" 'map(select(.version == $v)) | length')

    if [[ "$existing" != "0" ]]; then
        echo "ERROR: Release version $version already exists" >&2
        return 1
    fi

    # Append new release
    local updated_releases
    updated_releases=$(echo "$current_releases" | jq --argjson entry "$release_entry" '. + [$entry]')

    # Update releases.json atomically
    local temp_file="${RELEASES_FILE}.tmp"
    jq --argjson releases "$updated_releases" \
        --arg date "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
        '._meta.updatedAt = $date | .releases = $releases' \
        "$RELEASES_FILE" > "$temp_file"

    # Use atomic rename instead of save_json (releases.json has no schema validation yet)
    if [[ ! -f "$temp_file" ]]; then
        echo "ERROR: Failed to create temporary file" >&2
        return 2
    fi

    if ! mv "$temp_file" "$RELEASES_FILE"; then
        echo "ERROR: Failed to save releases.json" >&2
        rm -f "$temp_file"
        return 2
    fi

    return 0
}

# Link a task to a release version
# Arguments:
#   $1 - task_id (e.g., "T2666")
#   $2 - version (e.g., "1.0.0")
# Returns: 0=success, 1=release not found, 2=write failed
# Usage: link_task_to_release "T2666" "1.0.0"
link_task_to_release() {
    local task_id="$1"
    local version="$2"

    # Validate task ID format
    if [[ ! "$task_id" =~ ^T[0-9]+$ ]]; then
        echo "ERROR: Invalid task ID format: $task_id (must be T####)" >&2
        return 1
    fi

    # Initialize file if needed
    _init_releases_file "$RELEASES_FILE"

    # Check if release exists
    local release_exists
    release_exists=$(jq --arg v "$version" '.releases | map(select(.version == $v)) | length' "$RELEASES_FILE")

    if [[ "$release_exists" == "0" ]]; then
        echo "ERROR: Release version $version not found" >&2
        return 1
    fi

    # Add task to release if not already present
    local temp_file="${RELEASES_FILE}.tmp"
    jq --arg v "$version" \
       --arg t "$task_id" \
       --arg date "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
       '._meta.updatedAt = $date |
        .releases = (.releases | map(
            if .version == $v then
                .tasks = ((.tasks // []) + [$t] | unique)
            else
                .
            end
        ))' \
       "$RELEASES_FILE" > "$temp_file"

    # Use atomic rename
    if [[ ! -f "$temp_file" ]]; then
        echo "ERROR: Failed to create temporary file" >&2
        return 2
    fi

    if ! mv "$temp_file" "$RELEASES_FILE"; then
        echo "ERROR: Failed to update releases.json" >&2
        rm -f "$temp_file"
        return 2
    fi

    return 0
}

# Get full provenance chain for a release version
# Arguments:
#   $1 - version (e.g., "1.0.0")
# Returns: JSON object with full provenance chain
# Usage: provenance=$(get_release_provenance "1.0.0")
get_release_provenance() {
    local version="$1"

    # Initialize file if needed
    _init_releases_file "$RELEASES_FILE"

    # Extract release entry
    local release
    release=$(jq --arg v "$version" '.releases[] | select(.version == $v)' "$RELEASES_FILE")

    if [[ -z "$release" || "$release" == "null" ]]; then
        echo "ERROR: Release version $version not found" >&2
        return 1
    fi

    echo "$release"
    return 0
}

# Get all releases for a specific task
# Arguments:
#   $1 - task_id (e.g., "T2666")
# Returns: JSON array of releases containing the task
# Usage: releases=$(get_task_releases "T2666")
get_task_releases() {
    local task_id="$1"

    # Validate task ID format
    if [[ ! "$task_id" =~ ^T[0-9]+$ ]]; then
        echo "ERROR: Invalid task ID format: $task_id (must be T####)" >&2
        return 1
    fi

    # Initialize file if needed
    _init_releases_file "$RELEASES_FILE"

    # Find releases containing this task
    local releases
    releases=$(jq --arg t "$task_id" '[.releases[] | select(.tasks // [] | contains([$t]))]' "$RELEASES_FILE")

    echo "$releases"
    return 0
}

# Generate human-readable provenance report for a release
# Arguments:
#   $1 - version (e.g., "1.0.0")
#   $2 - output_format (markdown|json, default: markdown)
# Returns: Formatted provenance report
# Usage: generate_provenance_report "1.0.0" "markdown"
generate_provenance_report() {
    local version="$1"
    local output_format="${2:-markdown}"

    # Get provenance data
    local provenance
    if ! provenance=$(get_release_provenance "$version"); then
        return 1
    fi

    if [[ "$output_format" == "json" ]]; then
        echo "$provenance" | jq '.'
        return 0
    fi

    # Generate markdown report
    local date tasks_count commits_count artifacts_count slsa_level signing_method
    date=$(echo "$provenance" | jq -r '.date')
    tasks_count=$(echo "$provenance" | jq '.tasks | length')
    commits_count=$(echo "$provenance" | jq '.commits | length')
    artifacts_count=$(echo "$provenance" | jq '.artifacts | length')
    slsa_level=$(echo "$provenance" | jq -r '.provenance.slsaLevel')
    signing_method=$(echo "$provenance" | jq -r '.signing.method')

    cat <<EOF
# Release Provenance Report: v${version}

**Date**: ${date}
**SLSA Level**: ${slsa_level}
**Signing Method**: ${signing_method}

---

## Summary

| Metric | Count |
|--------|-------|
| Tasks | ${tasks_count} |
| Commits | ${commits_count} |
| Artifacts | ${artifacts_count} |

## Tasks

EOF

    # List tasks
    echo "$provenance" | jq -r '.tasks[]? // empty' | while read -r task; do
        echo "- $task"
    done

    cat <<EOF

## Commits

EOF

    # List commits
    echo "$provenance" | jq -r '.commits[]? // empty' | while read -r commit; do
        echo "- \`$commit\`"
    done

    cat <<EOF

## Artifacts

EOF

    # List artifacts
    echo "$provenance" | jq -c '.artifacts[]? // empty' | while read -r artifact; do
        local type sha256
        type=$(echo "$artifact" | jq -r '.type')
        sha256=$(echo "$artifact" | jq -r '.sha256 // "N/A"')
        echo "- **$type**: \`${sha256:0:16}...\`"
    done

    cat <<EOF

## SLSA Provenance

\`\`\`json
EOF

    echo "$provenance" | jq '.provenance'

    cat <<EOF
\`\`\`

## Signing Information

\`\`\`json
EOF

    echo "$provenance" | jq '.signing'

    echo '```'

    return 0
}

# Verify provenance chain integrity
# Arguments:
#   $1 - version (e.g., "1.0.0")
# Returns: 0=valid, 1=invalid
# Usage: verify_provenance_chain "1.0.0"
verify_provenance_chain() {
    local version="$1"

    # Get provenance data
    local provenance
    if ! provenance=$(get_release_provenance "$version"); then
        echo "ERROR: Failed to retrieve provenance for version $version" >&2
        return 1
    fi

    # Verify required fields
    local has_version has_date has_tasks has_artifacts has_provenance
    has_version=$(echo "$provenance" | jq -e '.version' >/dev/null 2>&1 && echo "true" || echo "false")
    has_date=$(echo "$provenance" | jq -e '.date' >/dev/null 2>&1 && echo "true" || echo "false")
    has_tasks=$(echo "$provenance" | jq -e '.tasks' >/dev/null 2>&1 && echo "true" || echo "false")
    has_artifacts=$(echo "$provenance" | jq -e '.artifacts' >/dev/null 2>&1 && echo "true" || echo "false")
    has_provenance=$(echo "$provenance" | jq -e '.provenance' >/dev/null 2>&1 && echo "true" || echo "false")

    if [[ "$has_version" != "true" || "$has_date" != "true" || "$has_tasks" != "true" || \
          "$has_artifacts" != "true" || "$has_provenance" != "true" ]]; then
        echo "ERROR: Provenance chain incomplete for version $version" >&2
        return 1
    fi

    # Verify SLSA fields
    local slsa_version slsa_level
    slsa_version=$(echo "$provenance" | jq -r '.provenance.slsaVersion // empty')
    slsa_level=$(echo "$provenance" | jq -r '.provenance.slsaLevel // empty')

    if [[ -z "$slsa_version" || -z "$slsa_level" ]]; then
        echo "ERROR: Missing SLSA provenance metadata for version $version" >&2
        return 1
    fi

    return 0
}

# ============================================================================
# EXPORTS
# ============================================================================

# Internal helpers (needed for subshell compatibility)
export -f _init_releases_file

# Public API
export -f record_release
export -f link_task_to_release
export -f get_release_provenance
export -f get_task_releases
export -f generate_provenance_report
export -f verify_provenance_chain
