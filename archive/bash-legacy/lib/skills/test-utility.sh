#!/usr/bin/env bash
# lib/skills/test-utility.sh - Test utility functions for implementation protocol validation
# @task T3038 - Implementation: Add utility function for testing

set -euo pipefail

# @task T3038
# Format a date string in ISO 8601 format
# Usage: format_iso_date "2026-02-03"
# Returns: Formatted ISO date string
format_iso_date() {
    local input_date="${1:-}"

    if [[ -z "$input_date" ]]; then
        echo "Error: Date required" >&2
        return 1
    fi

    # Simple validation - check format YYYY-MM-DD
    if [[ ! "$input_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
        echo "Error: Invalid date format. Expected YYYY-MM-DD" >&2
        return 1
    fi

    echo "${input_date}T00:00:00Z"
}

# @task T3038
# Get current timestamp in ISO format
# Usage: get_current_timestamp
# Returns: Current timestamp in ISO 8601 format
get_current_timestamp() {
    date -u +"%Y-%m-%dT%H:%M:%SZ"
}
