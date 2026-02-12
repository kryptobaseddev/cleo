#!/usr/bin/env bash
# migrate-registry-cleanup.sh - Clean up global registry to minimal format
#
# PURPOSE:
#   Migrates the global projects-registry.json to contain only minimal fields:
#   - hash, path, name, registeredAt, lastSeen, healthStatus, healthLastCheck
#
# REMOVES:
#   - cleoVersion (belongs in project-info.json)
#   - schemas (belongs in project-info.json)
#   - injection (belongs in project-info.json)
#   - health (nested object - replaced by flat healthStatus/healthLastCheck)
#
# USAGE:
#   ./scripts/migrate-registry-cleanup.sh [--dry-run]
#
# OPTIONS:
#   --dry-run    Preview changes without modifying the registry

set -euo pipefail

#=== DEPENDENCIES ================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# Source required libraries
# shellcheck source=lib/core/paths.sh
source "$LIB_DIR/core/paths.sh"
# shellcheck source=lib/data/file-ops.sh
source "$LIB_DIR/data/file-ops.sh"

#=== ARGUMENTS ===================================================
DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
    DRY_RUN=true
fi

#=== MAIN ========================================================

REGISTRY="$(get_cleo_home)/projects-registry.json"

if [[ ! -f "$REGISTRY" ]]; then
    echo "ERROR: Registry not found at $REGISTRY" >&2
    exit 1
fi

echo "=== Global Registry Cleanup Migration ==="
echo "Registry: $REGISTRY"
echo "Mode: $( [[ "$DRY_RUN" == "true" ]] && echo "DRY RUN" || echo "LIVE" )"
echo ""

# Count projects before
TOTAL_PROJECTS=$(jq '.projects | length' "$REGISTRY")
echo "Total projects in registry: $TOTAL_PROJECTS"
echo ""

# Fields to remove from each project entry
FIELDS_TO_REMOVE='["cleoVersion", "schemas", "injection", "health"]'

# Create the migration jq query
# For each project:
# 1. Remove unwanted fields
# 2. If old nested health exists but no flat healthStatus, migrate the value
MIGRATION_QUERY='
.projects |= with_entries(
  .value |= (
    # If we have old nested health but no flat healthStatus, migrate
    if (.healthStatus == null and .health.status != null) then
      .healthStatus = .health.status |
      .healthLastCheck = .health.lastCheck
    else
      .
    end |
    # Remove all unwanted fields
    del(.cleoVersion, .schemas, .injection, .health)
  )
) |
.lastUpdated = (now | todate)
'

# Show what will be changed
echo "=== Fields being removed from each project entry ==="
echo "  - cleoVersion (detailed version info belongs in project-info.json)"
echo "  - schemas (schema versions belong in project-info.json)"
echo "  - injection (injection status belongs in project-info.json)"
echo "  - health (nested object - using flat healthStatus/healthLastCheck instead)"
echo ""

# Count entries that have fields to remove
HAS_CLEOVERSION=$(jq '[.projects[] | select(.cleoVersion != null)] | length' "$REGISTRY")
HAS_SCHEMAS=$(jq '[.projects[] | select(.schemas != null)] | length' "$REGISTRY")
HAS_INJECTION=$(jq '[.projects[] | select(.injection != null)] | length' "$REGISTRY")
HAS_HEALTH=$(jq '[.projects[] | select(.health != null)] | length' "$REGISTRY")

echo "=== Entries with fields to remove ==="
echo "  - cleoVersion: $HAS_CLEOVERSION entries"
echo "  - schemas: $HAS_SCHEMAS entries"
echo "  - injection: $HAS_INJECTION entries"
echo "  - health (nested): $HAS_HEALTH entries"
echo ""

# Show sample before/after for first entry with old format
SAMPLE_HASH=$(jq -r '.projects | to_entries | map(select(.value.cleoVersion != null or .value.health != null)) | .[0].key // empty' "$REGISTRY")

if [[ -n "$SAMPLE_HASH" ]]; then
    echo "=== Sample transformation (hash: $SAMPLE_HASH) ==="
    echo ""
    echo "BEFORE:"
    jq --arg h "$SAMPLE_HASH" '.projects[$h]' "$REGISTRY"
    echo ""
    echo "AFTER:"
    jq --arg h "$SAMPLE_HASH" "$MIGRATION_QUERY" "$REGISTRY" | jq --arg h "$SAMPLE_HASH" '.projects[$h]'
    echo ""
fi

if [[ "$DRY_RUN" == "true" ]]; then
    echo "=== DRY RUN - No changes made ==="
    echo "Run without --dry-run to apply changes."
    exit 0
fi

# Apply migration
echo "=== Applying migration ==="

TEMP_FILE=$(mktemp)
trap 'rm -f "$TEMP_FILE"' EXIT

if jq "$MIGRATION_QUERY" "$REGISTRY" > "$TEMP_FILE"; then
    # Validate the result is valid JSON
    if ! jq -e . "$TEMP_FILE" >/dev/null 2>&1; then
        echo "ERROR: Migration produced invalid JSON" >&2
        exit 1
    fi

    # Use atomic write
    if save_json "$REGISTRY" < "$TEMP_FILE"; then
        echo "SUCCESS: Registry cleaned up successfully"
        echo ""

        # Show final stats
        echo "=== Final verification ==="
        REMAINING_CLEOVERSION=$(jq '[.projects[] | select(.cleoVersion != null)] | length' "$REGISTRY")
        REMAINING_SCHEMAS=$(jq '[.projects[] | select(.schemas != null)] | length' "$REGISTRY")
        REMAINING_INJECTION=$(jq '[.projects[] | select(.injection != null)] | length' "$REGISTRY")
        REMAINING_HEALTH=$(jq '[.projects[] | select(.health != null)] | length' "$REGISTRY")

        echo "Remaining entries with old fields:"
        echo "  - cleoVersion: $REMAINING_CLEOVERSION (should be 0)"
        echo "  - schemas: $REMAINING_SCHEMAS (should be 0)"
        echo "  - injection: $REMAINING_INJECTION (should be 0)"
        echo "  - health (nested): $REMAINING_HEALTH (should be 0)"
    else
        echo "ERROR: Failed to save registry" >&2
        exit 1
    fi
else
    echo "ERROR: Migration query failed" >&2
    exit 1
fi
