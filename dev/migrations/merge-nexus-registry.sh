#!/usr/bin/env bash
# merge-nexus-registry.sh - Merge nexus/registry.json into projects-registry.json
#
# PURPOSE:
#   One-time migration to unify the separate nexus registry into the global
#   projects-registry.json. After this migration, nexus functions read/write
#   from projects-registry.json directly.
#
# WHAT IT DOES:
#   1. Reads ~/.cleo/nexus/registry.json (if it exists)
#   2. For each nexus project, merges permissions/lastSync/taskCount/labels
#      into matching projects-registry.json entry
#   3. For nexus projects not in projects-registry, creates complete entries
#   4. Renames nexus/registry.json to registry.json.migrated
#   5. Adds default nexus fields to existing entries that lack them
#
# USAGE:
#   bash dev/migrations/merge-nexus-registry.sh [--dry-run]
#
# OPTIONS:
#   --dry-run    Preview changes without modifying files

set -euo pipefail

#=== DEPENDENCIES ================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../../lib"

# shellcheck source=lib/core/paths.sh
source "$LIB_DIR/core/paths.sh"

#=== HELPERS =====================================================

# Write JSON atomically without save_json (avoids trap/lock complexity)
write_registry() {
    local content="$1"
    local target="$2"
    local tmp="${target}.mig.tmp"

    echo "$content" | jq '.' > "$tmp"
    mv "$tmp" "$target"
}

#=== ARGUMENTS ===================================================
DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
    DRY_RUN=true
fi

#=== MAIN ========================================================

CLEO_HOME_DIR="$(get_cleo_home)"
REGISTRY="${CLEO_HOME_DIR}/projects-registry.json"
NEXUS_REGISTRY="${CLEO_HOME_DIR}/nexus/registry.json"

echo "=== Merge Nexus Registry Migration ==="
echo "Global registry: $REGISTRY"
echo "Nexus registry:  $NEXUS_REGISTRY"
echo "Dry run: $DRY_RUN"
echo ""

# Verify global registry exists
if [[ ! -f "$REGISTRY" ]]; then
    echo "ERROR: Global registry not found at $REGISTRY" >&2
    echo "Run 'cleo init' first to create it." >&2
    exit 1
fi

# Count existing projects
existing_count=$(jq '.projects | length' "$REGISTRY")
echo "Existing projects in global registry: $existing_count"

# Step 1: Merge nexus registry if it exists
merged_count=0
created_count=0

if [[ -f "$NEXUS_REGISTRY" ]]; then
    echo ""
    echo "--- Step 1: Merging nexus registry entries ---"

    nexus_count=$(jq '.projects | length' "$NEXUS_REGISTRY")
    echo "Nexus projects to process: $nexus_count"

    # Get all nexus project hashes
    nexus_hashes=$(jq -r '.projects | keys[]' "$NEXUS_REGISTRY" 2>/dev/null || echo "")

    for hash in $nexus_hashes; do
        [[ -z "$hash" ]] && continue

        nexus_entry=$(jq --arg h "$hash" '.projects[$h]' "$NEXUS_REGISTRY")
        nexus_name=$(echo "$nexus_entry" | jq -r '.name // "unknown"')
        nexus_permissions=$(echo "$nexus_entry" | jq -r '.permissions // "read"')
        nexus_lastSync=$(echo "$nexus_entry" | jq -r '.lastSync // null')
        nexus_taskCount=$(echo "$nexus_entry" | jq -r '.taskCount // 0')
        nexus_labels=$(echo "$nexus_entry" | jq -c '.labels // []')

        # Check if hash exists in global registry
        if jq -e --arg h "$hash" '.projects[$h]' "$REGISTRY" >/dev/null 2>&1; then
            echo "  Merging nexus fields into existing entry: $nexus_name ($hash)"

            if [[ "$DRY_RUN" == "false" ]]; then
                updated=$(jq --arg h "$hash" \
                   --arg perm "$nexus_permissions" \
                   --arg sync "$nexus_lastSync" \
                   --argjson tc "$nexus_taskCount" \
                   --argjson lb "$nexus_labels" \
                   '.projects[$h].permissions = $perm |
                    .projects[$h].lastSync = $sync |
                    .projects[$h].taskCount = $tc |
                    .projects[$h].labels = $lb' \
                   "$REGISTRY")

                write_registry "$updated" "$REGISTRY"
            fi
            merged_count=$((merged_count + 1))
        else
            # Create new entry from nexus data
            nexus_path=$(echo "$nexus_entry" | jq -r '.path // ""')
            echo "  Creating new entry from nexus: $nexus_name ($hash) at $nexus_path"

            if [[ "$DRY_RUN" == "false" ]]; then
                now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
                updated=$(jq --arg h "$hash" \
                   --arg p "$nexus_path" \
                   --arg n "$nexus_name" \
                   --arg now "$now" \
                   --arg perm "$nexus_permissions" \
                   --arg sync "$nexus_lastSync" \
                   --argjson tc "$nexus_taskCount" \
                   --argjson lb "$nexus_labels" \
                   '.projects[$h] = {
                       hash: $h,
                       path: $p,
                       name: $n,
                       registeredAt: $now,
                       lastSeen: $now,
                       healthStatus: "unknown",
                       healthLastCheck: null,
                       permissions: $perm,
                       lastSync: $sync,
                       taskCount: $tc,
                       labels: $lb
                   } | .lastUpdated = $now' \
                   "$REGISTRY")

                write_registry "$updated" "$REGISTRY"
            fi
            created_count=$((created_count + 1))
        fi
    done

    # Rename nexus registry to .migrated
    if [[ "$DRY_RUN" == "false" ]]; then
        mv "$NEXUS_REGISTRY" "${NEXUS_REGISTRY}.migrated"
        echo ""
        echo "Renamed nexus registry to: ${NEXUS_REGISTRY}.migrated"
    else
        echo ""
        echo "[DRY RUN] Would rename: $NEXUS_REGISTRY -> ${NEXUS_REGISTRY}.migrated"
    fi
else
    echo ""
    echo "No nexus registry found at $NEXUS_REGISTRY - skipping merge step."
fi

# Step 2: Add default nexus fields to entries that lack them
echo ""
echo "--- Step 2: Backfilling default nexus fields ---"

backfill_count=0
hashes=$(jq -r '.projects | keys[]' "$REGISTRY" 2>/dev/null || echo "")

for hash in $hashes; do
    [[ -z "$hash" ]] && continue

    has_permissions=$(jq -r --arg h "$hash" '.projects[$h].permissions // empty' "$REGISTRY")
    if [[ -z "$has_permissions" ]]; then
        project_name=$(jq -r --arg h "$hash" '.projects[$h].name // "unknown"' "$REGISTRY")
        echo "  Backfilling nexus defaults: $project_name ($hash)"

        if [[ "$DRY_RUN" == "false" ]]; then
            now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
            updated=$(jq --arg h "$hash" \
               --arg now "$now" \
               '.projects[$h].permissions = "read" |
                .projects[$h].taskCount = (.projects[$h].taskCount // 0) |
                .projects[$h].labels = (.projects[$h].labels // []) |
                .projects[$h].lastSync = $now' \
               "$REGISTRY")

            write_registry "$updated" "$REGISTRY"
        fi
        backfill_count=$((backfill_count + 1))
    fi
done

# Step 3: Update schema version
echo ""
echo "--- Step 3: Updating schema version ---"

current_version=$(jq -r '.schemaVersion // "unknown"' "$REGISTRY")
echo "  Current schema version: $current_version"

if [[ "$current_version" != "2.0.0" ]]; then
    if [[ "$DRY_RUN" == "false" ]]; then
        now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        updated=$(jq --arg now "$now" \
           '.schemaVersion = "2.0.0" | .lastUpdated = $now' \
           "$REGISTRY")

        write_registry "$updated" "$REGISTRY"
    fi
    echo "  Updated to: 2.0.0"
else
    echo "  Already at 2.0.0 - no update needed"
fi

# Summary
echo ""
echo "=== Migration Summary ==="
echo "  Nexus entries merged:     $merged_count"
echo "  New entries created:      $created_count"
echo "  Entries backfilled:       $backfill_count"

final_count=$(jq '.projects | length' "$REGISTRY")
echo "  Total projects in registry: $final_count"

if [[ "$DRY_RUN" == "true" ]]; then
    echo ""
    echo "[DRY RUN] No files were modified. Run without --dry-run to apply changes."
fi
