#!/usr/bin/env bash
# skill-discovery.sh - Skill Discovery and Registration Library
#
# ARCHITECTURE NOTE (Universal Subagent Architecture):
#   Skills are PROTOCOL IDENTIFIERS for context injection into cleo-subagent.
#   This library discovers skills by scanning for SKILL.md files, extracts metadata,
#   and registers them in skills/manifest.json.
#
# LAYER: 2 (Services - depends on Layer 1)
# DEPENDENCIES: exit-codes.sh, file-ops.sh, skill-validate.sh
# PROVIDES: discover_skills, validate_skill, register_skill, sync_manifest,
#           extract_skill_metadata, parse_skill_header, update_dispatch_matrix
#
# Enables automatic discovery and registration of skills from the skills/ directory.
# Skills are identified by SKILL.md files with structured headers containing metadata.
#
# USAGE:
#   source lib/skills/skill-discovery.sh
#
#   # Discover skills in directory
#   skills_json=$(discover_skills "skills/")
#
#   # Validate a skill
#   if validate_skill "skills/ct-research-agent"; then
#       echo "Skill valid"
#   fi
#
#   # Register a skill in manifest
#   register_skill "ct-research-agent" "skills/ct-research-agent"
#
#   # Sync manifest with discovered skills
#   sync_manifest

#=== SOURCE GUARD ================================================
[[ -n "${_SKILL_DISCOVERY_LOADED:-}" ]] && return 0
declare -r _SKILL_DISCOVERY_LOADED=1

set -euo pipefail

# Determine library directory
_SDISC_LIB_DIR="${BASH_SOURCE[0]%/*}/.."
[[ "$_SDISC_LIB_DIR" == "${BASH_SOURCE[0]}" ]] && _SDISC_LIB_DIR="."

# Determine project root (one level up from lib/)
_SDISC_PROJECT_ROOT="${_SDISC_LIB_DIR}/.."
[[ -d "${_SDISC_PROJECT_ROOT}/skills" ]] || _SDISC_PROJECT_ROOT="."

# Path to manifest.json
_SDISC_MANIFEST_JSON="${_SDISC_PROJECT_ROOT}/skills/manifest.json"

# Source dependencies
# shellcheck source=lib/core/exit-codes.sh
source "${_SDISC_LIB_DIR}/core/exit-codes.sh"
# shellcheck source=lib/skills/skill-validate.sh
source "${_SDISC_LIB_DIR}/skills/skill-validate.sh"

# ============================================================================
# INTERNAL HELPERS
# ============================================================================

# Log debug message to stderr
_sdisc_debug() {
    [[ -n "${SKILL_DISCOVERY_DEBUG:-}" ]] && echo "[skill-discovery] DEBUG: $1" >&2
    return 0
}

# Log error message to stderr
_sdisc_error() {
    echo "[skill-discovery] ERROR: $1" >&2
}

# Log warning message to stderr
_sdisc_warn() {
    echo "[skill-discovery] WARNING: $1" >&2
}

# Check if jq is available
_sdisc_require_jq() {
    if ! command -v jq &>/dev/null; then
        _sdisc_error "jq is required but not found"
        return "$EXIT_DEPENDENCY_ERROR"
    fi
    return 0
}

# ============================================================================
# SKILL HEADER PARSING
# ============================================================================

# extract_skill_metadata - Extract metadata from SKILL.md header
# Args: $1 = path to SKILL.md file
# Returns: 0 on success, error code on failure
# Output: JSON object with skill metadata to stdout
#
# Supports two formats:
# 1. Structured header format:
#   **Protocol**: @protocols/research.md
#   **Type**: Context Injection (cleo-subagent)
#   **Version**: 2.0.0
#
# 2. YAML frontmatter:
#   ---
#   name: skill-name
#   version: 1.0.0
#   description: |
#     Multi-line description
#   ---
#
# Returns JSON:
#   {"protocol": "research.md", "type": "Context Injection", "version": "2.0.0"}
extract_skill_metadata() {
    local skill_file="$1"

    _sdisc_require_jq || return $?

    if [[ ! -f "$skill_file" ]]; then
        _sdisc_error "Skill file not found: $skill_file"
        return "$EXIT_FILE_ERROR"
    fi

    # Check if file starts with YAML frontmatter
    local first_line
    first_line=$(head -1 "$skill_file" | tr -d '\r')

    if [[ "$first_line" == "---" ]]; then
        # Parse YAML frontmatter
        _sdisc_debug "Parsing YAML frontmatter in: $skill_file"

        # Extract YAML block (between first and second ---)
        local yaml_block
        yaml_block=$(awk '/^---$/{if(++n==2)exit}n==1' "$skill_file" | tail -n +2)

        # Parse YAML fields using grep/sed (simple parser)
        local name description version
        name=$(echo "$yaml_block" | grep -i '^name:' | sed 's/^name: *//' | tr -d '\r' || echo "")
        version=$(echo "$yaml_block" | grep -i '^version:' | sed 's/^version: *//' | tr -d '\r' || echo "")

        # Parse multi-line description (after "description: |")
        description=$(echo "$yaml_block" | awk '/^description: *\|/{flag=1; next} /^[a-zA-Z]/{flag=0} flag' | sed 's/^  //' | tr '\n' ' ' | sed 's/  */ /g' | sed 's/^ *//;s/ *$//' || echo "")

        # If no description in YAML, extract from first H1 heading
        if [[ -z "$description" ]]; then
            description=$(grep '^# ' "$skill_file" | head -1 | sed 's/^# *//' | tr -d '\r' || echo "")
        fi

        # Build JSON
        local json
        json=$(jq -n \
            --arg protocol "" \
            --arg type "" \
            --arg version "$version" \
            --arg title "$description" \
            --arg name "$name" \
            '{protocol: $protocol, type: $type, version: $version, title: $title, name: $name}')

        echo "$json"
        return 0
    else
        # Parse structured header format
        _sdisc_debug "Parsing structured header in: $skill_file"

        local header
        header=$(head -20 "$skill_file")

        # Parse structured header fields
        local protocol type version
        protocol=$(echo "$header" | grep -i '^\*\*Protocol\*\*:' | sed 's/^.*: *@protocols\///' | sed 's/\.md.*//' | tr -d '\r' || echo "")
        type=$(echo "$header" | grep -i '^\*\*Type\*\*:' | sed 's/^.*: *//' | tr -d '\r' || echo "")
        version=$(echo "$header" | grep -i '^\*\*Version\*\*:' | sed 's/^.*: *//' | tr -d '\r' || echo "")

        # Extract title (first H1 heading)
        local title
        title=$(echo "$header" | grep '^# ' | head -1 | sed 's/^# *//' | tr -d '\r' || echo "")

        # Build JSON (escaping quotes)
        local json
        json=$(jq -n \
            --arg protocol "$protocol" \
            --arg type "$type" \
            --arg version "$version" \
            --arg title "$title" \
            '{protocol: $protocol, type: $type, version: $version, title: $title}')

        echo "$json"
        return 0
    fi
}

# parse_skill_header - Parse full skill directory for metadata
# Args: $1 = path to skill directory (e.g., "skills/ct-research-agent")
# Returns: 0 on success, error code on failure
# Output: JSON object with complete skill metadata to stdout
#
# Returns JSON with fields:
#   {
#     "name": "ct-research-agent",
#     "version": "2.0.0",
#     "description": "...",
#     "path": "skills/ct-research-agent",
#     "tags": [],
#     "status": "discovered"
#   }
parse_skill_header() {
    local skill_dir="$1"

    _sdisc_require_jq || return $?

    if [[ ! -d "$skill_dir" ]]; then
        _sdisc_error "Skill directory not found: $skill_dir"
        return "$EXIT_FILE_ERROR"
    fi

    local skill_file="${skill_dir}/SKILL.md"
    if [[ ! -f "$skill_file" ]]; then
        _sdisc_error "SKILL.md not found in: $skill_dir"
        return "$EXIT_FILE_ERROR"
    fi

    # Extract metadata from SKILL.md
    local metadata
    metadata=$(extract_skill_metadata "$skill_file") || return $?

    # Extract skill name from directory path
    local skill_name
    skill_name=$(basename "$skill_dir")

    # Extract version from metadata
    local version
    version=$(echo "$metadata" | jq -r '.version // "1.0.0"')

    # Extract title as description
    local description
    description=$(echo "$metadata" | jq -r '.title // ""')

    # Parse protocol type to infer tags
    local protocol
    protocol=$(echo "$metadata" | jq -r '.protocol // ""')
    local tags="[]"
    case "$protocol" in
        research)
            tags='["research", "investigation", "discovery"]'
            ;;
        decomposition)
            tags='["planning", "architecture", "task-management"]'
            ;;
        implementation)
            tags='["execution", "implementation", "task-management"]'
            ;;
        specification)
            tags='["specification", "documentation", "rfc"]'
            ;;
        *)
            tags='["general"]'
            ;;
    esac

    # Build full skill metadata JSON
    local skill_json
    skill_json=$(jq -n \
        --arg name "$skill_name" \
        --arg version "$version" \
        --arg description "$description" \
        --arg path "$skill_dir" \
        --argjson tags "$tags" \
        '{
            name: $name,
            version: $version,
            description: $description,
            path: $path,
            tags: $tags,
            status: "discovered"
        }')

    echo "$skill_json"
    return 0
}

# ============================================================================
# SKILL DISCOVERY
# ============================================================================

# discover_skills - Scan directory for skills
# Args: $1 = search directory (default: "skills/")
# Returns: 0 on success
# Output: JSON array of discovered skill metadata to stdout
#
# Scans for SKILL.md files, extracts metadata, returns array:
#   [
#     {"name": "ct-research-agent", "version": "2.0.0", ...},
#     {"name": "ct-task-executor", "version": "1.0.0", ...}
#   ]
discover_skills() {
    local search_dir="${1:-${_SDISC_PROJECT_ROOT}/skills}"

    _sdisc_require_jq || return $?

    if [[ ! -d "$search_dir" ]]; then
        _sdisc_error "Search directory not found: $search_dir"
        return "$EXIT_FILE_ERROR"
    fi

    _sdisc_debug "Scanning for skills in: $search_dir"

    # Find all SKILL.md files
    local skill_files
    skill_files=$(find "$search_dir" -name "SKILL.md" -type f 2>/dev/null | sort)

    if [[ -z "$skill_files" ]]; then
        _sdisc_warn "No SKILL.md files found in: $search_dir"
        echo "[]"
        return 0
    fi

    # Parse each skill and collect metadata
    local skills_array="[]"
    local count=0

    while IFS= read -r skill_file; do
        local skill_dir
        skill_dir=$(dirname "$skill_file")

        # Skip _shared directory
        if [[ "$skill_dir" == *"/_shared"* ]]; then
            _sdisc_debug "Skipping shared directory: $skill_dir"
            continue
        fi

        _sdisc_debug "Parsing skill: $skill_dir"

        local skill_metadata
        if skill_metadata=$(parse_skill_header "$skill_dir" 2>/dev/null); then
            skills_array=$(echo "$skills_array" | jq --argjson skill "$skill_metadata" '. + [$skill]')
            ((count++))
        else
            _sdisc_warn "Failed to parse skill: $skill_dir"
        fi
    done <<< "$skill_files"

    _sdisc_debug "Discovered $count skills"
    echo "$skills_array"
    return 0
}

# ============================================================================
# SKILL VALIDATION
# ============================================================================

# validate_skill - Validate skill against protocol requirements
# Args: $1 = path to skill directory
# Returns: 0 if valid, error code if invalid
# Output: Error messages to stderr on failure
#
# Checks:
#   - SKILL.md file exists
#   - Required header fields present
#   - Version format valid (semver)
validate_skill() {
    local skill_dir="$1"

    if [[ ! -d "$skill_dir" ]]; then
        _sdisc_error "Skill directory not found: $skill_dir"
        return "$EXIT_FILE_ERROR"
    fi

    local skill_file="${skill_dir}/SKILL.md"
    if [[ ! -f "$skill_file" ]]; then
        _sdisc_error "SKILL.md not found in: $skill_dir"
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Extract metadata
    local metadata
    if ! metadata=$(extract_skill_metadata "$skill_file" 2>/dev/null); then
        _sdisc_error "Failed to extract metadata from: $skill_file"
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Validate version format (semver: X.Y.Z)
    local version
    version=$(echo "$metadata" | jq -r '.version // ""')
    if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        _sdisc_error "Invalid version format: $version (expected X.Y.Z)"
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Validate title/description exists
    local title
    title=$(echo "$metadata" | jq -r '.title // ""')
    if [[ -z "$title" ]]; then
        _sdisc_error "Missing title in: $skill_file"
        return "$EXIT_VALIDATION_ERROR"
    fi

    _sdisc_debug "Skill validation passed: $skill_dir"
    return 0
}

# ============================================================================
# SKILL REGISTRATION
# ============================================================================

# register_skill - Register a skill in manifest.json
# Args: $1 = skill name (e.g., "ct-research-agent")
#       $2 = skill directory path (e.g., "skills/ct-research-agent")
# Returns: 0 on success, error code on failure
# Output: Success/error messages to stderr
#
# Adds skill to manifest.json if not already present.
# If skill exists, updates version if newer.
register_skill() {
    local skill_name="$1"
    local skill_dir="$2"

    _sdisc_require_jq || return $?

    if [[ ! -f "$_SDISC_MANIFEST_JSON" ]]; then
        _sdisc_error "Manifest not found: $_SDISC_MANIFEST_JSON"
        return "$EXIT_FILE_ERROR"
    fi

    # Validate skill first
    if ! validate_skill "$skill_dir"; then
        _sdisc_error "Skill validation failed: $skill_dir"
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Parse skill metadata
    local skill_metadata
    skill_metadata=$(parse_skill_header "$skill_dir") || return $?

    # Check if skill already exists in manifest
    local existing
    existing=$(jq -r --arg name "$skill_name" \
        '.skills[] | select(.name == $name) | .name' \
        "$_SDISC_MANIFEST_JSON" 2>/dev/null || echo "")

    if [[ -n "$existing" ]]; then
        _sdisc_debug "Skill already exists in manifest: $skill_name"

        # Compare versions - update if newer
        local existing_version new_version
        existing_version=$(jq -r --arg name "$skill_name" \
            '.skills[] | select(.name == $name) | .version' \
            "$_SDISC_MANIFEST_JSON")
        new_version=$(echo "$skill_metadata" | jq -r '.version')

        if [[ "$new_version" != "$existing_version" ]]; then
            _sdisc_debug "Updating skill version: $existing_version -> $new_version"
            # Update version in manifest
            local temp_file="${_SDISC_MANIFEST_JSON}.tmp"
            jq --arg name "$skill_name" --arg version "$new_version" \
                '(.skills[] | select(.name == $name) | .version) = $version' \
                "$_SDISC_MANIFEST_JSON" > "$temp_file"
            mv "$temp_file" "$_SDISC_MANIFEST_JSON"
            echo "Updated skill version: $skill_name ($existing_version -> $new_version)" >&2
        else
            echo "Skill already registered: $skill_name" >&2
        fi
        return "$EXIT_ALREADY_EXISTS"
    fi

    # Add skill to manifest
    _sdisc_debug "Adding new skill to manifest: $skill_name"

    # Update manifest: add to skills array
    local temp_file="${_SDISC_MANIFEST_JSON}.tmp"
    jq --argjson skill "$skill_metadata" \
        '.skills += [$skill] | ._meta.totalSkills = (.skills | length)' \
        "$_SDISC_MANIFEST_JSON" > "$temp_file"

    if [[ -s "$temp_file" ]]; then
        mv "$temp_file" "$_SDISC_MANIFEST_JSON"
        echo "Registered new skill: $skill_name" >&2
        return 0
    else
        _sdisc_error "Failed to update manifest"
        rm -f "$temp_file"
        return "$EXIT_FILE_ERROR"
    fi
}

# ============================================================================
# MANIFEST SYNC
# ============================================================================

# sync_manifest - Sync manifest.json with discovered skills
# Args: none
# Returns: 0 on success
# Output: Summary of changes to stderr
#
# Compares discovered skills vs manifest:
#   - Adds new skills as status "discovered"
#   - Marks missing skills as status "deprecated"
#   - Updates skill counts in _meta
sync_manifest() {
    _sdisc_require_jq || return $?

    if [[ ! -f "$_SDISC_MANIFEST_JSON" ]]; then
        _sdisc_error "Manifest not found: $_SDISC_MANIFEST_JSON"
        return "$EXIT_FILE_ERROR"
    fi

    # Discover skills in filesystem
    local discovered_skills
    discovered_skills=$(discover_skills) || return $?

    # Get current skills from manifest
    local manifest_skills
    manifest_skills=$(jq -r '.skills[].name' "$_SDISC_MANIFEST_JSON" 2>/dev/null | sort)

    # Get discovered skill names
    local discovered_names
    discovered_names=$(echo "$discovered_skills" | jq -r '.[].name' | sort)

    # Find new skills (in discovered but not in manifest)
    local new_skills
    new_skills=$(comm -13 <(echo "$manifest_skills") <(echo "$discovered_names"))

    # Find missing skills (in manifest but not discovered)
    local missing_skills
    missing_skills=$(comm -23 <(echo "$manifest_skills") <(echo "$discovered_names"))

    # Register new skills
    if [[ -n "$new_skills" ]]; then
        echo "Found new skills:" >&2
        while IFS= read -r skill_name; do
            if [[ -n "$skill_name" ]]; then
                local skill_dir="${_SDISC_PROJECT_ROOT}/skills/${skill_name}"
                echo "  - $skill_name" >&2
                register_skill "$skill_name" "$skill_dir" 2>/dev/null || true
            fi
        done <<< "$new_skills"
    fi

    # Mark missing skills as deprecated
    if [[ -n "$missing_skills" ]]; then
        echo "Skills marked as deprecated:" >&2
        while IFS= read -r skill_name; do
            if [[ -n "$skill_name" ]]; then
                echo "  - $skill_name" >&2
                local temp_file="${_SDISC_MANIFEST_JSON}.tmp"
                jq --arg name "$skill_name" \
                    '(.skills[] | select(.name == $name) | .status) = "deprecated"' \
                    "$_SDISC_MANIFEST_JSON" > "$temp_file"
                mv "$temp_file" "$_SDISC_MANIFEST_JSON"
            fi
        done <<< "$missing_skills"
    fi

    # Update metadata counts
    local total_skills active_skills
    total_skills=$(jq '.skills | length' "$_SDISC_MANIFEST_JSON")
    active_skills=$(jq '[.skills[] | select(.status == "active")] | length' "$_SDISC_MANIFEST_JSON")

    local temp_file="${_SDISC_MANIFEST_JSON}.tmp"
    jq --arg total "$total_skills" \
        '._meta.totalSkills = ($total | tonumber)' \
        "$_SDISC_MANIFEST_JSON" > "$temp_file"
    mv "$temp_file" "$_SDISC_MANIFEST_JSON"

    echo "Sync complete: $total_skills total skills, $active_skills active" >&2
    return 0
}

# ============================================================================
# DISPATCH MATRIX UPDATE
# ============================================================================

# update_dispatch_matrix - Update dispatch matrix with skill keywords
# Args: $1 = skill name
#       $2 = keywords string (pipe-separated, e.g., "research|investigate|explore")
# Returns: 0 on success
# Output: none
#
# Updates manifest.json dispatch_matrix.by_keyword with skill's keywords
update_dispatch_matrix() {
    local skill_name="$1"
    local keywords="${2:-}"

    _sdisc_require_jq || return $?

    if [[ -z "$keywords" ]]; then
        _sdisc_debug "No keywords provided for: $skill_name"
        return 0
    fi

    if [[ ! -f "$_SDISC_MANIFEST_JSON" ]]; then
        _sdisc_error "Manifest not found: $_SDISC_MANIFEST_JSON"
        return "$EXIT_FILE_ERROR"
    fi

    # Update dispatch matrix
    local temp_file="${_SDISC_MANIFEST_JSON}.tmp"
    jq --arg keywords "$keywords" --arg skill "$skill_name" \
        '.dispatch_matrix.by_keyword[$keywords] = $skill' \
        "$_SDISC_MANIFEST_JSON" > "$temp_file"

    if [[ -s "$temp_file" ]]; then
        mv "$temp_file" "$_SDISC_MANIFEST_JSON"
        _sdisc_debug "Updated dispatch matrix for: $skill_name"
        return 0
    else
        _sdisc_error "Failed to update dispatch matrix"
        rm -f "$temp_file"
        return "$EXIT_FILE_ERROR"
    fi
}

# ============================================================================
# EXPORT FUNCTIONS
# ============================================================================

export -f discover_skills
export -f validate_skill
export -f register_skill
export -f sync_manifest
export -f extract_skill_metadata
export -f parse_skill_header
export -f update_dispatch_matrix
