#!/usr/bin/env bash
# skillsmp.sh - SkillsMP API client library for CLEO
# Integrates with agentskills.in marketplace for skill discovery and installation

set -euo pipefail

# API Configuration
readonly SKILLSMP_API="https://www.agentskills.in/api/skills"
readonly SKILLSMP_CACHE_TTL=300  # 5 minutes for search results
readonly SKILLSMP_CONTENT_TTL=3600  # 1 hour for skill content

# Cache directory (will be created by initialization)
SKILLSMP_CACHE_DIR="${HOME}/.cleo/.skills-cache"

# Config file location
SKILLSMP_CONFIG_FILE="${CLEO_ROOT_DIR:-.cleo}/skillsmp.json"

# Load skillsmp.json configuration
# Returns: 0 on success, 1 if config missing/invalid
# Exports: SKILLSMP_* variables from config
smp_load_config() {
    if [[ ! -f "$SKILLSMP_CONFIG_FILE" ]]; then
        return 1
    fi

    # Validate JSON structure
    if ! jq empty "$SKILLSMP_CONFIG_FILE" 2>/dev/null; then
        echo "ERROR: Invalid JSON in $SKILLSMP_CONFIG_FILE" >&2
        return 1
    fi

    # Load configuration values
    local enabled
    enabled=$(jq -r '.enabled // false' "$SKILLSMP_CONFIG_FILE")

    if [[ "$enabled" != "true" ]]; then
        return 1
    fi

    # Export configuration
    export SKILLSMP_CACHE_DIR
    SKILLSMP_CACHE_DIR=$(jq -r '.cacheDir // "${HOME}/.cleo/.skills-cache"' "$SKILLSMP_CONFIG_FILE")
    SKILLSMP_CACHE_DIR=$(eval echo "$SKILLSMP_CACHE_DIR")  # Expand variables

    # Ensure cache directory exists
    mkdir -p "$SKILLSMP_CACHE_DIR" 2>/dev/null || true

    return 0
}

# Internal: Make API request with caching
# Args: $1=query_params (e.g., "search=bash&limit=10")
# Returns: JSON response from API or cache
# Exit codes: 0=success, 1=network error, 2=invalid response
_smp_api_request() {
    local query_params="$1"
    local cache_file="${SKILLSMP_CACHE_DIR}/$(echo -n "$query_params" | md5sum | cut -d' ' -f1).json"

    # Check cache validity
    if [[ -f "$cache_file" ]]; then
        local cache_age
        cache_age=$(($(date +%s) - $(stat -c %Y "$cache_file" 2>/dev/null || echo 0)))

        if [[ $cache_age -lt $SKILLSMP_CACHE_TTL ]]; then
            cat "$cache_file"
            return 0
        fi
    fi

    # Make API request
    local response
    if ! response=$(curl -sL -m 10 "${SKILLSMP_API}?${query_params}" 2>&1); then
        echo "ERROR: Network request failed: $response" >&2
        return 1
    fi

    # Validate JSON response
    if ! echo "$response" | jq empty 2>/dev/null; then
        echo "ERROR: Invalid JSON response from API" >&2
        return 2
    fi

    # Cache response
    mkdir -p "$SKILLSMP_CACHE_DIR"
    echo "$response" > "$cache_file"

    echo "$response"
    return 0
}

# Search skills by query
# Args: $1=query, $2=limit (default: 10), $3=sortBy (default: stars)
# Output: JSON array of skills
# Exit codes: 0=success, 1=API error
smp_search_skills() {
    local query="$1"
    local limit="${2:-10}"
    local sort_by="${3:-stars}"

    if [[ -z "$query" ]]; then
        echo "ERROR: Search query required" >&2
        return 1
    fi

    # URL-encode query (basic implementation)
    query="${query// /%20}"

    local params="search=${query}&limit=${limit}&sortBy=${sort_by}"
    local response

    if ! response=$(_smp_api_request "$params"); then
        return 1
    fi

    echo "$response"
    return 0
}

# Get skill details by scoped name or metadata
# Args: $1=scoped_name (e.g., "@author/skill-name") or skill_id
# Output: JSON object with skill metadata
# Exit codes: 0=success, 1=not found, 2=API error
smp_get_skill_details() {
    local identifier="$1"

    if [[ -z "$identifier" ]]; then
        echo "ERROR: Skill identifier required" >&2
        return 1
    fi

    local response
    local skill_data

    # Check if identifier is scoped name format (@author/name)
    if [[ "$identifier" =~ ^@([^/]+)/(.+)$ ]]; then
        local author="${BASH_REMATCH[1]}"
        local name="${BASH_REMATCH[2]}"

        local params="author=${author}&search=${name}&limit=1"

        if ! response=$(_smp_api_request "$params"); then
            return 2
        fi

        skill_data=$(echo "$response" | jq '.skills[0]')

        if [[ "$skill_data" == "null" ]]; then
            echo "ERROR: Skill not found: $identifier" >&2
            return 1
        fi
    else
        # Assume identifier is skill ID, search by name
        local params="search=${identifier}&limit=1"

        if ! response=$(_smp_api_request "$params"); then
            return 2
        fi

        skill_data=$(echo "$response" | jq '.skills[0]')

        if [[ "$skill_data" == "null" ]]; then
            echo "ERROR: Skill not found: $identifier" >&2
            return 1
        fi
    fi

    echo "$skill_data"
    return 0
}

# Download skill content from GitHub
# Args: $1=skill_metadata (JSON), $2=destination_path
# Output: Writes SKILL.md to destination
# Exit codes: 0=success, 1=download failed, 2=invalid metadata
smp_download_skill() {
    local skill_metadata="$1"
    local dest_path="$2"

    if [[ -z "$skill_metadata" ]] || [[ -z "$dest_path" ]]; then
        echo "ERROR: Skill metadata and destination path required" >&2
        return 1
    fi

    # Extract GitHub information
    local repo_full_name
    local path
    local branch="main"  # Default branch

    repo_full_name=$(echo "$skill_metadata" | jq -r '.repoFullName // empty')
    path=$(echo "$skill_metadata" | jq -r '.path // empty')

    if [[ -z "$repo_full_name" ]] || [[ -z "$path" ]]; then
        echo "ERROR: Invalid skill metadata: missing repoFullName or path" >&2
        return 2
    fi

    # Construct raw GitHub URL
    local raw_url="https://raw.githubusercontent.com/${repo_full_name}/${branch}/${path}"

    # Create destination directory
    mkdir -p "$dest_path"

    # Download skill content with caching
    local cache_key="${repo_full_name}/${path}"
    local cache_file="${SKILLSMP_CACHE_DIR}/content/$(echo -n "$cache_key" | md5sum | cut -d' ' -f1).md"
    local use_cache=false

    # Check content cache validity (1 hour TTL)
    if [[ -f "$cache_file" ]]; then
        local cache_age
        cache_age=$(($(date +%s) - $(stat -c %Y "$cache_file" 2>/dev/null || echo 0)))

        if [[ $cache_age -lt $SKILLSMP_CONTENT_TTL ]]; then
            use_cache=true
        fi
    fi

    if [[ "$use_cache" == "true" ]]; then
        cp "$cache_file" "${dest_path}/SKILL.md"
    else
        # Download from GitHub
        if ! curl -sL -m 15 "$raw_url" -o "${dest_path}/SKILL.md" 2>/dev/null; then
            echo "ERROR: Failed to download skill from $raw_url" >&2
            return 1
        fi

        # Verify download (check if file is not empty and contains valid content)
        if [[ ! -s "${dest_path}/SKILL.md" ]]; then
            echo "ERROR: Downloaded skill file is empty" >&2
            rm -f "${dest_path}/SKILL.md"
            return 1
        fi

        # Cache the content
        mkdir -p "${SKILLSMP_CACHE_DIR}/content"
        cp "${dest_path}/SKILL.md" "$cache_file"
    fi

    return 0
}

# Install skill to CLEO skills directory
# Args: $1=scoped_name (e.g., "@author/skill-name"), $2=skills_dir (optional)
# Output: Installs skill to skills directory
# Exit codes: 0=success, 1=skill not found, 2=installation failed
smp_install_skill() {
    local scoped_name="$1"
    local skills_dir="${2:-${CLEO_ROOT_DIR:-.cleo}/skills}"

    if [[ -z "$scoped_name" ]]; then
        echo "ERROR: Scoped skill name required (e.g., @author/skill-name)" >&2
        return 1
    fi

    # Get skill metadata
    local skill_data
    if ! skill_data=$(smp_get_skill_details "$scoped_name"); then
        return 1
    fi

    # Extract skill name (without scope)
    local skill_name
    skill_name=$(echo "$skill_data" | jq -r '.name')

    if [[ -z "$skill_name" ]]; then
        echo "ERROR: Could not extract skill name from metadata" >&2
        return 2
    fi

    # Determine installation path
    local install_path="${skills_dir}/${skill_name}"

    # Check if skill already exists
    if [[ -d "$install_path" ]]; then
        echo "WARNING: Skill already exists at $install_path" >&2
        read -p "Overwrite existing skill? [y/N] " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "Installation cancelled"
            return 0
        fi
    fi

    # Download and install
    echo "Installing skill: $scoped_name -> $install_path"

    if ! smp_download_skill "$skill_data" "$install_path"; then
        echo "ERROR: Failed to download skill" >&2
        return 2
    fi

    # Create metadata file
    echo "$skill_data" | jq '.' > "${install_path}/metadata.json"

    echo "✓ Skill installed successfully: $skill_name"
    return 0
}

# Export functions for external use
export -f smp_load_config
export -f smp_search_skills
export -f smp_get_skill_details
export -f smp_download_skill
export -f smp_install_skill
