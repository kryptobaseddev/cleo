#!/usr/bin/env bash
# manifest-resolver.sh - Cached Manifest Generation and Resolution
#
# Generates and caches a unified skills manifest by scanning all skill search
# paths (CAAMP + embedded). Uses TTL-based cache with graceful degradation:
#   Fresh cache → Stale cache (warning) → Embedded manifest → empty
#
# LAYER: 2 (Services - depends on Layer 1)
# DEPENDENCIES: exit-codes.sh, skill-paths.sh, skill-discovery.sh
# PROVIDES:
#   mr_resolve_manifest       - Find or generate manifest, return path
#   mr_is_cache_fresh         - Check if cache is within TTL
#   mr_generate_manifest      - Scan skills, parse frontmatters, write manifest to path
#   mr_invalidate_cache       - Force cache rebuild on next resolve
#   mr_parse_skill_frontmatter - Parse YAML frontmatter from SKILL.md
#
# ENVIRONMENT VARIABLES:
#   CLEO_MANIFEST_CACHE_TTL  - Override TTL in seconds (default: read from cache _meta.ttlSeconds, or 300)
#   CLEO_MANIFEST_CACHE_DIR  - Cache directory (default: ~/.cleo/cache)
#
# GRACEFUL DEGRADATION:
#   1. Fresh cached manifest (within TTL)
#   2. Stale cached manifest (expired but valid JSON, warning to stderr)
#   3. Embedded project manifest (skills/manifest.json)
#   4. Empty string (caller handles)
#
# USAGE:
#   source lib/skills/manifest-resolver.sh
#
#   # Get manifest path (generates/caches as needed)
#   manifest=$(mr_resolve_manifest)
#
#   # Force rebuild
#   mr_invalidate_cache
#   manifest=$(mr_resolve_manifest)
#
#   # Check freshness
#   if mr_is_cache_fresh "$manifest"; then
#       echo "Cache is fresh"
#   fi
#
#   # Parse a single skill's frontmatter
#   mr_parse_skill_frontmatter "skills/ct-research-agent"

#=== SOURCE GUARD ================================================
[[ -n "${_MANIFEST_RESOLVER_LOADED:-}" ]] && return 0
declare -r _MANIFEST_RESOLVER_LOADED=1

set -euo pipefail

# ============================================================================
# DEPENDENCIES
# ============================================================================

_MR_LIB_DIR="${BASH_SOURCE[0]%/*}/.."
[[ "$_MR_LIB_DIR" == "${BASH_SOURCE[0]}" ]] && _MR_LIB_DIR="."

_MR_PROJECT_ROOT="${_MR_LIB_DIR}/.."
if command -v realpath &>/dev/null; then
    _MR_PROJECT_ROOT="$(realpath "$_MR_PROJECT_ROOT" 2>/dev/null || echo "$_MR_PROJECT_ROOT")"
fi

# shellcheck source=lib/core/exit-codes.sh
source "${_MR_LIB_DIR}/core/exit-codes.sh"
# shellcheck source=lib/skills/skill-paths.sh
source "${_MR_LIB_DIR}/skills/skill-paths.sh"

# ============================================================================
# CONSTANTS
# ============================================================================

# Default cache TTL in seconds (5 minutes), overridden by cache _meta.ttlSeconds
_MR_DEFAULT_TTL=300

# Cache directory and file
_MR_CACHE_DIR="${CLEO_MANIFEST_CACHE_DIR:-$HOME/.cleo/cache}"
_MR_CACHE_FILE="${_MR_CACHE_DIR}/skills-manifest.json"

# Embedded fallback manifest
_MR_EMBEDDED_MANIFEST="${_MR_PROJECT_ROOT}/skills/manifest.json"

# Manifest schema version for generated manifests
_MR_SCHEMA_VERSION="3.0.0"

# ============================================================================
# INTERNAL HELPERS
# ============================================================================

# Log debug message to stderr
_mr_debug() {
    [[ -n "${MANIFEST_RESOLVER_DEBUG:-}" ]] && echo "[manifest-resolver] DEBUG: $1" >&2
    return 0
}

# Log warning message to stderr
_mr_warn() {
    echo "[manifest-resolver] WARNING: $1" >&2
}

# Log error message to stderr
_mr_error() {
    echo "[manifest-resolver] ERROR: $1" >&2
}

# Check if jq is available
_mr_require_jq() {
    if ! command -v jq &>/dev/null; then
        _mr_error "jq is required but not found"
        return "$EXIT_DEPENDENCY_ERROR"
    fi
    return 0
}

# Get file modification time (cross-platform: GNU stat vs BSD stat)
# Args: $1 = file path
# Output: epoch seconds
_mr_file_mtime() {
    local path="$1"
    if stat --version &>/dev/null 2>&1; then
        stat -c '%Y' "$path" 2>/dev/null
    else
        stat -f '%m' "$path" 2>/dev/null
    fi
}

# Get effective TTL for a cache file
# Reads _meta.ttlSeconds from the JSON, falls back to env var, then default
# Args: $1 = cache file path
# Output: TTL in seconds
_mr_get_ttl() {
    local cache_path="$1"

    # Environment variable override takes highest priority
    if [[ -n "${CLEO_MANIFEST_CACHE_TTL:-}" ]]; then
        echo "$CLEO_MANIFEST_CACHE_TTL"
        return 0
    fi

    # Try reading ttlSeconds from the cached manifest's _meta
    if [[ -f "$cache_path" ]]; then
        local cached_ttl
        cached_ttl=$(jq -r '._meta.ttlSeconds // empty' "$cache_path" 2>/dev/null || echo "")
        if [[ -n "$cached_ttl" && "$cached_ttl" =~ ^[0-9]+$ ]]; then
            echo "$cached_ttl"
            return 0
        fi
    fi

    echo "$_MR_DEFAULT_TTL"
}

# Check if a file contains valid manifest JSON with a skills array
# Args: $1 = path to manifest file
# Returns: 0 if valid, 1 if not
_mr_is_valid_manifest() {
    local path="$1"

    [[ -f "$path" ]] || return 1
    [[ -s "$path" ]] || return 1

    jq -e '.skills | type == "array"' "$path" &>/dev/null
}

# ============================================================================
# FRONTMATTER PARSING
# ============================================================================

# mr_parse_skill_frontmatter - Parse YAML frontmatter from SKILL.md
#
# Reads the YAML block between the first --- and second --- markers in SKILL.md.
# Extracts key: value pairs and outputs as a JSON object.
#
# Supported fields: name, version, description, tier, category, core, protocol,
#   dependencies, sharedResources, tags, model, status
#
# Args: $1 = path to skill directory (e.g., "skills/ct-research-agent")
# Output: JSON object to stdout
# Returns: 0 on success, 1 if no SKILL.md or no frontmatter
mr_parse_skill_frontmatter() {
    local skill_dir="${1:?mr_parse_skill_frontmatter requires skill_dir}"
    local skill_file="${skill_dir}/SKILL.md"

    _mr_require_jq || return $?

    if [[ ! -f "$skill_file" ]]; then
        _mr_debug "No SKILL.md in: $skill_dir"
        return 1
    fi

    local first_line
    first_line=$(head -1 "$skill_file" | tr -d '\r')

    # If file does not start with YAML frontmatter, try structured header fallback
    if [[ "$first_line" != "---" ]]; then
        _mr_debug "No YAML frontmatter in: $skill_file, trying structured header"
        _mr_parse_structured_header "$skill_file"
        return $?
    fi

    # Extract YAML block (lines between first --- and second ---)
    local yaml_block
    yaml_block=$(awk '/^---$/{if(++n==2)exit}n==1' "$skill_file" | tail -n +2)

    if [[ -z "$yaml_block" ]]; then
        _mr_debug "Empty YAML frontmatter in: $skill_file"
        return 1
    fi

    # Parse scalar fields: key: value (single line)
    local name version description tier category core protocol model status
    name=$(_mr_yaml_value "$yaml_block" "name")
    version=$(_mr_yaml_value "$yaml_block" "version")
    tier=$(_mr_yaml_value "$yaml_block" "tier")
    category=$(_mr_yaml_value "$yaml_block" "category")
    core=$(_mr_yaml_value "$yaml_block" "core")
    protocol=$(_mr_yaml_value "$yaml_block" "protocol")
    model=$(_mr_yaml_value "$yaml_block" "model")
    status=$(_mr_yaml_value "$yaml_block" "status")

    # Parse multi-line description (after "description: |" or "description: >")
    description=$(echo "$yaml_block" | awk '
        /^description: *[|>]/{flag=1; next}
        /^[a-zA-Z_]/{flag=0}
        flag' | sed 's/^  //' | tr '\n' ' ' | sed 's/  */ /g; s/^ *//; s/ *$//')

    # If no multi-line description, try single-line
    if [[ -z "$description" ]]; then
        description=$(_mr_yaml_value "$yaml_block" "description")
    fi

    # Derive name from directory if not in frontmatter
    if [[ -z "$name" ]]; then
        name=$(basename "$skill_dir")
    fi

    # Parse array fields: dependencies, sharedResources, tags
    # These can appear as YAML lists (- item) or inline arrays ([item1, item2])
    local dependencies_json shared_resources_json tags_json
    dependencies_json=$(_mr_yaml_array "$yaml_block" "dependencies")
    shared_resources_json=$(_mr_yaml_array "$yaml_block" "sharedResources")
    tags_json=$(_mr_yaml_array "$yaml_block" "tags")

    # Build JSON output via heredoc to avoid bash expansion of jq operators
    local jq_filter
    jq_filter=$(cat <<'JQEOF'
{
    name: $name,
    version: $version,
    description: $description,
    tags: $tags,
    status: $status
}
+ (if $tier != "" then {tier: ($tier | tonumber? // $tier)} else {} end)
+ (if $category != "" then {category: $category} else {} end)
+ (if $core != "" then {core: ($core == "true")} else {} end)
+ (if $protocol != "" then {protocol: $protocol} else {} end)
+ (if $model != "" then {model: $model} else {} end)
+ (if ($dependencies | length) > 0 then {dependencies: $dependencies} else {} end)
+ (if ($sharedResources | length) > 0 then {sharedResources: $sharedResources} else {} end)
JQEOF
    )

    jq -n \
        --arg name "$name" \
        --arg version "${version:-1.0.0}" \
        --arg description "$description" \
        --arg tier "${tier:-}" \
        --arg category "${category:-}" \
        --arg core "${core:-}" \
        --arg protocol "${protocol:-}" \
        --arg model "${model:-}" \
        --arg status "${status:-active}" \
        --argjson dependencies "${dependencies_json:-[]}" \
        --argjson sharedResources "${shared_resources_json:-[]}" \
        --argjson tags "${tags_json:-[]}" \
        "$jq_filter"
}

# Extract a scalar value from YAML-like text
# Args: $1 = yaml text, $2 = key name
# Output: value string (empty if not found)
_mr_yaml_value() {
    local yaml="$1" key="$2"
    local match
    match=$(echo "$yaml" | grep -i "^${key}:" | head -1 || true)
    if [[ -n "$match" ]]; then
        echo "$match" | sed "s/^${key}: *//i" | tr -d '\r' | sed 's/^ *"//; s/" *$//'
    fi
}

# Extract a YAML array as JSON array
# Supports both block style (- item) and inline style ([item1, item2])
# Args: $1 = yaml text, $2 = key name
# Output: JSON array string
_mr_yaml_array() {
    local yaml="$1" key="$2"

    # Check for inline array: key: [item1, item2]
    local inline
    inline=$(echo "$yaml" | grep -i "^${key}: *\[" | head -1 || true)
    if [[ -n "$inline" ]]; then
        inline=$(echo "$inline" | sed "s/^${key}: *//i" | tr -d '\r')
        # Validate it's a JSON array and normalize
        echo "$inline" | jq -c '.' 2>/dev/null || echo "[]"
        return 0
    fi

    # Check for block array:
    #   key:
    #     - item1
    #     - item2
    local block_items
    block_items=$(echo "$yaml" | awk -v key="$key" '
        BEGIN { IGNORECASE=1 }
        $0 ~ "^"key":" { flag=1; next }
        flag && /^  *- / { gsub(/^  *- */, ""); gsub(/"/, ""); print; next }
        flag && /^[a-zA-Z_]/ { flag=0 }
    ')

    if [[ -n "$block_items" ]]; then
        # Convert newline-separated items to JSON array
        echo "$block_items" | jq -Rc '[., inputs]' 2>/dev/null || echo "[]"
        return 0
    fi

    echo "[]"
}

# Parse structured header format (non-YAML fallback)
# Reads **Key**: Value patterns from first 20 lines of SKILL.md
# Args: $1 = path to SKILL.md
# Output: JSON object to stdout
# Returns: 0 on success
_mr_parse_structured_header() {
    local skill_file="$1"
    local header
    header=$(head -20 "$skill_file")

    local protocol type version title
    protocol=$(echo "$header" | grep -i '^\*\*Protocol\*\*:' | sed 's/^.*: *@protocols\///' | sed 's/\.md.*//' | tr -d '\r' || true)
    type=$(echo "$header" | grep -i '^\*\*Type\*\*:' | sed 's/^.*: *//' | tr -d '\r' || true)
    version=$(echo "$header" | grep -i '^\*\*Version\*\*:' | sed 's/^.*: *//' | tr -d '\r' || true)
    title=$(echo "$header" | grep '^# ' | head -1 | sed 's/^# *//' | tr -d '\r' || true)

    local jq_filter
    jq_filter=$(cat <<'JQEOF'
{
    name: $name,
    version: $version,
    description: $description,
    status: $status,
    tags: []
}
+ (if $protocol != "" then {protocol: $protocol} else {} end)
JQEOF
    )

    jq -n \
        --arg name "$(basename "$(dirname "$skill_file")")" \
        --arg version "${version:-1.0.0}" \
        --arg description "$title" \
        --arg protocol "$protocol" \
        --arg status "active" \
        "$jq_filter"
}

# ============================================================================
# CAAMP REGISTRY INTEGRATION
# ============================================================================

# Attempt to use @cleocode/ct-skills registry API for richer metadata
# Returns: 0 with JSON array on stdout if available, 1 if not
_mr_try_caamp_registry() {
    # Check if the package is requireable via node
    if ! command -v node &>/dev/null; then
        _mr_debug "node not available for CAAMP registry"
        return 1
    fi

    local registry_output
    registry_output=$(node -e "
        try {
            const registry = require('@cleocode/ct-skills');
            const skills = typeof registry.listSkills === 'function'
                ? registry.listSkills()
                : (registry.skills || []);
            console.log(JSON.stringify(skills));
        } catch (e) {
            process.exit(1);
        }
    " 2>/dev/null) || return 1

    if echo "$registry_output" | jq -e 'type == "array"' &>/dev/null; then
        echo "$registry_output"
        return 0
    fi

    _mr_debug "CAAMP registry returned invalid data"
    return 1
}

# ============================================================================
# CACHE MANAGEMENT
# ============================================================================

# mr_is_cache_fresh - Check if cached manifest is within TTL
#
# Reads _meta.ttlSeconds from the cached JSON to determine TTL.
# Falls back to CLEO_MANIFEST_CACHE_TTL env var, then default 300s.
#
# Args: $1 = path to cache file (optional, defaults to _MR_CACHE_FILE)
# Returns: 0 if cache exists and is within TTL, 1 otherwise
mr_is_cache_fresh() {
    local cache_path="${1:-$_MR_CACHE_FILE}"

    if [[ ! -f "$cache_path" ]]; then
        _mr_debug "Cache file does not exist: $cache_path"
        return 1
    fi

    if [[ ! -s "$cache_path" ]]; then
        _mr_debug "Cache file is empty: $cache_path"
        return 1
    fi

    local file_mtime now age ttl
    file_mtime=$(_mr_file_mtime "$cache_path") || return 1
    now=$(date +%s)
    age=$(( now - file_mtime ))
    ttl=$(_mr_get_ttl "$cache_path")

    if [[ "$age" -le "$ttl" ]]; then
        _mr_debug "Cache is fresh (age: ${age}s, TTL: ${ttl}s)"
        return 0
    else
        _mr_debug "Cache is stale (age: ${age}s, TTL: ${ttl}s)"
        return 1
    fi
}

# mr_invalidate_cache - Force cache rebuild on next resolve
#
# Removes the cached manifest file so the next call to mr_resolve_manifest
# will regenerate it.
#
# Returns: 0 always (idempotent)
mr_invalidate_cache() {
    if [[ -f "$_MR_CACHE_FILE" ]]; then
        rm -f "$_MR_CACHE_FILE"
        _mr_debug "Cache invalidated: $_MR_CACHE_FILE"
    else
        _mr_debug "No cache to invalidate"
    fi
    return 0
}

# ============================================================================
# MANIFEST GENERATION
# ============================================================================

# mr_generate_manifest - Scan installed skills and build manifest JSON
#
# Scans all search paths from skill-paths.sh, parses SKILL.md frontmatters,
# merges with CAAMP registry data (when available), and writes a unified
# v3.0.0 manifest with resolvedPath and source fields.
#
# Args: $1 = output_path (file to write the manifest to)
# Returns: 0 on success, error code on failure
mr_generate_manifest() {
    local output_path="${1:?mr_generate_manifest requires output_path}"

    _mr_require_jq || return $?
    _mr_debug "Generating unified manifest to: $output_path"

    local generated_at
    generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    # Collect skills from all search paths, tracking per-source stats
    local all_skills="[]"
    local sources_array="[]"
    local seen_names=""
    local total_count=0

    # Try CAAMP registry API first for richer metadata
    local registry_skills=""
    if registry_skills=$(_mr_try_caamp_registry 2>/dev/null); then
        _mr_debug "Got skills from CAAMP registry API"
    else
        registry_skills=""
    fi

    # Scan each search path
    local search_path
    while IFS= read -r search_path; do
        [[ -z "$search_path" ]] && continue
        _mr_debug "Scanning search path: $search_path"

        # Classify the search path
        local path_type
        if [[ "$search_path" == *"/.agents/"* ]]; then
            path_type="caamp"
        else
            path_type="embedded"
        fi

        local path_skill_count=0

        # Find SKILL.md files in this search path (max 2 levels deep)
        local skill_dirs
        skill_dirs=$(find "$search_path" -maxdepth 2 -name "SKILL.md" -type f 2>/dev/null | sort)

        while IFS= read -r skill_file; do
            [[ -z "$skill_file" ]] && continue

            local skill_dir skill_name
            skill_dir=$(dirname "$skill_file")
            skill_name=$(basename "$skill_dir")

            # Skip internal/shared directories
            case "$skill_name" in
                _shared|_ct-skills-shared|_ct-skills-protocols|mp) continue ;;
            esac

            # Deduplicate: first occurrence wins (priority order)
            if echo "$seen_names" | grep -qF "|${skill_name}|" 2>/dev/null; then
                _mr_debug "Skipping duplicate: $skill_name (found in higher-priority path)"
                continue
            fi
            seen_names="${seen_names}|${skill_name}|"

            # Resolve absolute path
            local resolved_path="$skill_dir"
            if command -v realpath &>/dev/null; then
                resolved_path="$(realpath "$skill_dir" 2>/dev/null || echo "$skill_dir")"
            fi

            # Classify source
            local skill_source
            skill_source=$(get_skill_source_type "$skill_dir" 2>/dev/null || echo "$path_type")

            # Try CAAMP registry for richer metadata first
            local skill_json=""
            if [[ -n "$registry_skills" ]]; then
                skill_json=$(echo "$registry_skills" | jq -e --arg name "$skill_name" \
                    '[.[] | select(.name == $name)] | if length > 0 then .[0] else empty end' \
                    2>/dev/null || echo "")
            fi

            # Fall back to frontmatter parsing
            if [[ -z "$skill_json" ]]; then
                skill_json=$(mr_parse_skill_frontmatter "$skill_dir" 2>/dev/null || echo "")
            fi

            if [[ -z "$skill_json" ]]; then
                _mr_warn "Could not parse skill metadata: $skill_dir"
                continue
            fi

            # Enrich with v3.0.0 fields: resolvedPath, source
            skill_json=$(echo "$skill_json" | jq \
                --arg resolvedPath "$resolved_path" \
                --arg source "$skill_source" \
                '. + {resolvedPath: $resolvedPath, source: $source}')

            all_skills=$(echo "$all_skills" | jq --argjson skill "$skill_json" '. + [$skill]')
            ((total_count++))
            ((path_skill_count++))

        done <<< "$skill_dirs"

        # Record source stats for _meta.sources
        sources_array=$(echo "$sources_array" | jq \
            --arg path "$search_path" \
            --arg type "$path_type" \
            --argjson skillCount "$path_skill_count" \
            '. + [{path: $path, type: $type, skillCount: $skillCount}]')

    done < <(get_skill_search_paths)

    _mr_debug "Found $total_count skills across all search paths"

    # Build the full manifest document
    local manifest
    manifest=$(jq -n \
        --arg schemaVersion "$_MR_SCHEMA_VERSION" \
        --arg generatedAt "$generated_at" \
        --argjson ttlSeconds "$_MR_DEFAULT_TTL" \
        --argjson totalSkills "$total_count" \
        --argjson sources "$sources_array" \
        --argjson skills "$all_skills" \
        '{
            "$schema": "https://cleo-dev.com/schemas/v3/skills-manifest.schema.json",
            "_meta": {
                "schemaVersion": $schemaVersion,
                "generatedAt": $generatedAt,
                "ttlSeconds": $ttlSeconds,
                "totalSkills": $totalSkills,
                "sources": $sources,
                "generatedBy": "manifest-resolver"
            },
            "skills": $skills
        }')

    # Merge dispatch_matrix from embedded manifest if available
    if [[ -f "$_MR_EMBEDDED_MANIFEST" ]]; then
        local dispatch_matrix
        dispatch_matrix=$(jq -c '.dispatch_matrix // empty' "$_MR_EMBEDDED_MANIFEST" 2>/dev/null || echo "")
        if [[ -n "$dispatch_matrix" ]]; then
            manifest=$(echo "$manifest" | jq --argjson dm "$dispatch_matrix" '. + {dispatch_matrix: $dm}')
        fi
    fi

    # Validate the generated manifest
    if ! echo "$manifest" | jq -e '.skills | type == "array"' &>/dev/null; then
        _mr_error "Generated manifest failed validation"
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Atomic write: temp file → validate → mv
    local output_dir
    output_dir=$(dirname "$output_path")
    if [[ ! -d "$output_dir" ]]; then
        mkdir -p "$output_dir" 2>/dev/null || {
            _mr_error "Cannot create output directory: $output_dir"
            return "$EXIT_FILE_ERROR"
        }
    fi

    local temp_file="${output_path}.tmp.$$"
    if ! echo "$manifest" > "$temp_file" 2>/dev/null; then
        _mr_error "Failed to write temp file: $temp_file"
        rm -f "$temp_file" 2>/dev/null
        return "$EXIT_FILE_ERROR"
    fi

    if ! mv "$temp_file" "$output_path" 2>/dev/null; then
        _mr_error "Failed to move temp file to: $output_path"
        rm -f "$temp_file" 2>/dev/null
        return "$EXIT_FILE_ERROR"
    fi

    _mr_debug "Wrote manifest to: $output_path ($total_count skills)"
    return 0
}

# ============================================================================
# PRIMARY API
# ============================================================================

# mr_resolve_manifest - Find or generate manifest, return path
#
# Implements graceful degradation:
#   1. Fresh cached manifest → return cache path
#   2. Generate new manifest → write to cache → return cache path
#   3. On generation failure: stale cache → return stale cache path (warning)
#   4. On stale cache miss: embedded manifest → return embedded path (warning)
#   5. Last resort: echo empty string, return 1
#
# Output: Absolute path to a valid manifest JSON file (or empty on total failure)
# Returns: 0 on success, 1 if no manifest available
mr_resolve_manifest() {
    _mr_require_jq || return $?

    # Level 1: Fresh cache
    if mr_is_cache_fresh "$_MR_CACHE_FILE"; then
        _mr_debug "Using fresh cached manifest"
        echo "$_MR_CACHE_FILE"
        return 0
    fi

    # Ensure cache directory exists
    if [[ ! -d "$_MR_CACHE_DIR" ]]; then
        mkdir -p "$_MR_CACHE_DIR" 2>/dev/null || {
            _mr_warn "Cannot create cache directory: $_MR_CACHE_DIR"
        }
    fi

    # Level 2: Generate fresh manifest to cache
    if [[ -d "$_MR_CACHE_DIR" ]]; then
        _mr_debug "Generating fresh manifest"
        if mr_generate_manifest "$_MR_CACHE_FILE" 2>/dev/null; then
            _mr_debug "Wrote fresh manifest to cache"
            echo "$_MR_CACHE_FILE"
            return 0
        else
            _mr_warn "Manifest generation failed"
        fi
    fi

    # Level 3: Stale cache (expired but valid)
    if _mr_is_valid_manifest "$_MR_CACHE_FILE"; then
        _mr_warn "Using stale cached manifest (generation failed)"
        echo "$_MR_CACHE_FILE"
        return 0
    fi

    # Level 4: Embedded project manifest
    if _mr_is_valid_manifest "$_MR_EMBEDDED_MANIFEST"; then
        _mr_warn "Using embedded project manifest (no cache available)"
        echo "$_MR_EMBEDDED_MANIFEST"
        return 0
    fi

    # Level 5: No manifest available
    _mr_error "All manifest sources failed"
    echo ""
    return 1
}
