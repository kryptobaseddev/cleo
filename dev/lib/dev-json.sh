#!/usr/bin/env bash
# dev-json.sh - JSON utilities for dev scripts
# Part of the dev/lib/ shared library
#
# Provides reusable JSON operations with error handling for LLM-Agent-First compliance.
#
# Usage:
#   source "$DEV_LIB_DIR/dev-json.sh"
#   json=$(dev_json_load "path/to/file.json")
#   value=$(dev_json_query "$json" '.field.subfield')

set -euo pipefail

# Source dependencies if not already loaded
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -z "${DEV_EXIT_NOT_FOUND:-}" ]] && source "$SCRIPT_DIR/dev-exit-codes.sh"

# ============================================================================
# JSON FILE OPERATIONS
# ============================================================================

# Load and validate a JSON file
# Args: $1 = file path
# Returns: JSON content (echoed) or exits with error
# Usage: json=$(dev_json_load "schema.json")
dev_json_load() {
    local file="$1"

    if [[ ! -f "$file" ]]; then
        echo "ERROR: JSON file not found: $file" >&2
        return "${DEV_EXIT_NOT_FOUND:-4}"
    fi

    if ! jq . "$file" &>/dev/null; then
        echo "ERROR: Invalid JSON in file: $file" >&2
        return "${DEV_EXIT_GENERAL_ERROR:-1}"
    fi

    cat "$file"
}

# Query JSON with jq, with error handling
# Args: $1 = JSON string, $2 = jq query
# Returns: result or empty string on error
# Usage: value=$(dev_json_query "$json" '.field')
dev_json_query() {
    local json="$1"
    local query="$2"

    echo "$json" | jq -r "$query" 2>/dev/null || echo ""
}

# Query JSON and return raw (unquoted) value
# Args: $1 = JSON string, $2 = jq query
# Returns: raw value
# Usage: count=$(dev_json_query_raw "$json" '.count')
dev_json_query_raw() {
    local json="$1"
    local query="$2"

    echo "$json" | jq "$query" 2>/dev/null || echo "null"
}

# Check if JSON has a field
# Args: $1 = JSON, $2 = field name
# Returns: 0 if has field, 1 if not
# Usage: if dev_json_has_field "$json" "version"; then ...
dev_json_has_field() {
    local json="$1"
    local field="$2"

    echo "$json" | jq -e "has(\"$field\")" &>/dev/null
}

# Get array length from JSON
# Args: $1 = JSON, $2 = jq path to array (default: ".")
# Returns: length as number
# Usage: len=$(dev_json_array_length "$json" ".items")
dev_json_array_length() {
    local json="$1"
    local path="${2:-.}"

    echo "$json" | jq -r "$path | length" 2>/dev/null || echo "0"
}

# ============================================================================
# JSON CONSTRUCTION
# ============================================================================

# Build a JSON object from key-value pairs
# Args: pairs of key value (even number of args)
# Returns: JSON object string
# Usage: obj=$(dev_json_object "name" "test" "count" "5")
dev_json_object() {
    local result="{"
    local first=true

    while [[ $# -ge 2 ]]; do
        local key="$1"
        local value="$2"
        shift 2

        [[ "$first" == "true" ]] && first=false || result+=","

        # Detect if value is a number, boolean, null, or string
        if [[ "$value" =~ ^[0-9]+$ ]] || [[ "$value" =~ ^[0-9]+\.[0-9]+$ ]]; then
            result+="\"$key\":$value"
        elif [[ "$value" == "true" ]] || [[ "$value" == "false" ]] || [[ "$value" == "null" ]]; then
            result+="\"$key\":$value"
        else
            # Escape special characters in string
            value=$(echo "$value" | jq -Rs '.' | sed 's/^"//;s/"$//')
            result+="\"$key\":\"$value\""
        fi
    done

    result+="}"
    echo "$result"
}

# Merge two JSON objects
# Args: $1 = base JSON, $2 = overlay JSON
# Returns: merged JSON
# Usage: merged=$(dev_json_merge "$base" "$overlay")
dev_json_merge() {
    local base="$1"
    local overlay="$2"

    echo "$base" | jq --argjson overlay "$overlay" '. + $overlay'
}

# ============================================================================
# JSON VALIDATION
# ============================================================================

# Validate JSON string is valid
# Args: $1 = JSON string
# Returns: 0 if valid, 1 if invalid
# Usage: if dev_json_valid "$str"; then ...
dev_json_valid() {
    local json="$1"

    echo "$json" | jq . &>/dev/null
}

# Check if JSON output has required LLM-Agent-First envelope fields
# Args: $1 = JSON string
# Returns: 0 if valid envelope, 1 if missing fields
# Usage: if dev_json_valid_envelope "$output"; then ...
dev_json_valid_envelope() {
    local json="$1"

    # Check for required fields: _meta, success
    if ! echo "$json" | jq -e '._meta and has("success")' &>/dev/null; then
        return 1
    fi

    # Check _meta has required fields: command, timestamp, version
    if ! echo "$json" | jq -e '._meta | has("command") and has("timestamp") and has("version")' &>/dev/null; then
        return 1
    fi

    return 0
}

# ============================================================================
# JSON FORMATTING
# ============================================================================

# Pretty print JSON with optional compact mode
# Args: $1 = JSON, $2 = compact (true/false, default false)
# Returns: formatted JSON
# Usage: dev_json_format "$json" true
dev_json_format() {
    local json="$1"
    local compact="${2:-false}"

    if [[ "$compact" == "true" ]]; then
        echo "$json" | jq -c .
    else
        echo "$json" | jq .
    fi
}

# Convert JSON to tab-separated values for a given query
# Args: $1 = JSON, $2 = jq query that returns objects
# Returns: TSV output
# Usage: dev_json_to_tsv "$json" '.items[]' 'id,name,status'
dev_json_to_tsv() {
    local json="$1"
    local query="$2"
    local fields="$3"

    # Convert comma-separated fields to jq format
    local jq_fields
    jq_fields=$(echo "$fields" | sed 's/,/,./g' | sed 's/^/./')

    echo "$json" | jq -r "$query | [$jq_fields] | @tsv" 2>/dev/null
}
