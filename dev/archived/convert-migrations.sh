#!/usr/bin/env bash
# Migration function name converter: semver → timestamp format
# Scans lib/data/migrate.sh for semver migration functions and generates
# timestamp equivalents. Output is conversion commands (not auto-applied).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATE_LIB="$PROJECT_ROOT/lib/data/migrate.sh"

# Load the migrate library to get access to parse_migration_identifier
source "$MIGRATE_LIB"

echo "=== Migration Function Converter (Semver → Timestamp) ==="
echo ""
echo "Scanning lib/data/migrate.sh for semver migration functions..."
echo ""

# Find all semver migration functions
semver_funcs=$(declare -F | grep -oE "migrate_[^_]+_to_[0-9]+_[0-9]+_[0-9]+" || true)

if [[ -z "$semver_funcs" ]]; then
    echo "No semver migration functions found."
    exit 0
fi

# Parse each function and generate timestamp equivalent
while IFS= read -r func_name; do
    # Skip if empty
    [[ -z "$func_name" ]] && continue

    # Parse the migration identifier
    parsed=$(parse_migration_identifier "$func_name" 2>/dev/null || echo "")
    if [[ -z "$parsed" ]]; then
        echo "WARNING: Could not parse: $func_name" >&2
        continue
    fi

    # Extract metadata
    type=$(echo "$parsed" | jq -r '.type')
    version=$(echo "$parsed" | jq -r '.identifier')

    # Generate timestamp (current date + sequence)
    # For demo purposes, we use a fixed base date + version-based offset
    # In production, you'd use git log to find actual commit dates
    timestamp=$(date -d "2026-01-01 12:00:00 + $((${version//.})) minutes" +%Y%m%d%H%M%S 2>/dev/null || echo "20260101120000")

    # Generate description from version
    description="v${version//./_}"

    # New function name
    new_func_name="migrate_${type}_${timestamp}_${description}"

    echo "# Convert: $func_name → $new_func_name"
    echo "# Version: $version (type: $type)"
    echo ""
    echo "# Step 1: Rename function in lib/data/migrate.sh"
    echo "sed -i 's/^${func_name}()/${new_func_name}()/' lib/data/migrate.sh"
    echo ""
    echo "# Step 2: Update function comment"
    echo "sed -i 's/# Migration from .* to ${version//./\\.}/# Migration: ${description} (${version})/' lib/data/migrate.sh"
    echo ""
    echo "---"
    echo ""

done <<< "$semver_funcs"

echo ""
echo "=== Summary ==="
echo "Found $(echo "$semver_funcs" | wc -l) semver migration functions"
echo ""
echo "IMPORTANT: Review commands before executing"
echo "These are suggestions - adjust timestamps based on git history"
echo ""
echo "To apply (CAREFULLY):"
echo "  1. Review each command"
echo "  2. Adjust timestamps based on actual commit dates"
echo "  3. Run commands manually or save to script"
echo "  4. Test with: bats tests/unit/migrate.bats"
