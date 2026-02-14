#!/usr/bin/env bash
# backfill-manifest-hierarchy.sh - One-time migration to add hierarchy fields to MANIFEST.jsonl
# @task T4355
# @epic T4352
#
# Adds parentId, epicId, path, depth, childCount to all existing manifest entries.
# Strategy:
#   1. Backup the manifest
#   2. For each entry, derive hierarchy from linked_tasks
#   3. Compute childCount from parent references
#   4. Validate invariants after backfill
#   5. Generate report

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

MANIFEST_PATH="$PROJECT_ROOT/claudedocs/agent-outputs/MANIFEST.jsonl"
BACKUP_PATH="${MANIFEST_PATH}.pre-hierarchy-backfill.$(date +%Y%m%d%H%M%S)"
TMP_OUTPUT="${MANIFEST_PATH}.hierarchy-tmp.$$"

if [[ ! -f "$MANIFEST_PATH" ]]; then
    echo "ERROR: MANIFEST.jsonl not found at $MANIFEST_PATH"
    exit 1
fi

# Step 1: Create backup
echo "Step 1: Creating backup..."
cp "$MANIFEST_PATH" "$BACKUP_PATH"
echo "  Backup: $BACKUP_PATH"

total_entries=$(wc -l < "$MANIFEST_PATH")
echo "  Total entries: $total_entries"

# Step 2: Process each entry - add hierarchy fields
echo ""
echo "Step 2: Backfilling hierarchy fields..."

enriched=0
orphans=0
errors=0

# Process line by line
while IFS= read -r line; do
    [[ -z "$line" ]] && continue

    # Check if entry already has hierarchy fields
    has_epic=$(echo "$line" | jq -r '.epicId // empty' 2>/dev/null)
    has_path=$(echo "$line" | jq -r 'if .path != null and .path != "" then "yes" else "no" end' 2>/dev/null)

    if [[ -n "$has_epic" && "$has_path" == "yes" ]]; then
        # Already has hierarchy, keep as-is
        echo "$line" >> "$TMP_OUTPUT"
        continue
    fi

    # Extract linked_tasks
    linked_tasks=$(echo "$line" | jq -r '.linked_tasks // [] | .[]' 2>/dev/null)

    epic_id=""
    task_id=""

    # Try to find epic from linked_tasks
    while IFS= read -r tid; do
        [[ -z "$tid" ]] && continue
        # Check if task exists and get its type
        local_type=$(ct show "$tid" --json 2>/dev/null | jq -r '.task.type // "task"' 2>/dev/null || echo "unknown")
        if [[ "$local_type" == "epic" ]]; then
            epic_id="$tid"
        elif [[ -z "$task_id" ]]; then
            task_id="$tid"
        fi
    done <<< "$linked_tasks"

    # If no epic found, try walking up from task_id
    if [[ -z "$epic_id" && -n "$task_id" ]]; then
        parent_id=$(ct show "$task_id" --json 2>/dev/null | jq -r '.task.parentId // empty' 2>/dev/null || echo "")
        if [[ -n "$parent_id" ]]; then
            epic_id="$parent_id"
            grandparent=$(ct show "$parent_id" --json 2>/dev/null | jq -r '.task.parentId // empty' 2>/dev/null || echo "")
            if [[ -n "$grandparent" ]]; then
                epic_id="$grandparent"
            fi
        fi
    fi

    # Build path
    path=""
    depth=0
    if [[ -n "$epic_id" && -n "$task_id" && "$epic_id" != "$task_id" ]]; then
        task_parent=$(ct show "$task_id" --json 2>/dev/null | jq -r '.task.parentId // empty' 2>/dev/null || echo "")
        if [[ "$task_parent" == "$epic_id" ]]; then
            path="${epic_id}/${task_id}"
            depth=1
        elif [[ -n "$task_parent" ]]; then
            path="${epic_id}/${task_parent}/${task_id}"
            depth=2
        else
            path="${epic_id}/${task_id}"
            depth=1
        fi
    elif [[ -n "$epic_id" ]]; then
        path="${epic_id}"
        depth=0
    fi

    # Mark orphans
    if [[ -z "$epic_id" ]]; then
        ((orphans++)) || true
    fi

    # Enrich entry
    enriched_line=$(echo "$line" | jq -c \
        --arg eid "${epic_id:-}" \
        --arg p "$path" \
        --argjson d "$depth" \
        '. +
        (if .parentId == null then {parentId: null} else {} end) +
        (if .epicId == null then {epicId: (if $eid != "" then $eid else null end)} else {} end) +
        (if (.path == null or .path == "") then {path: $p} else {} end) +
        (if .depth == null then {depth: $d} else {} end) +
        (if .childCount == null then {childCount: 0} else {} end)' 2>/dev/null)

    if [[ -n "$enriched_line" ]]; then
        echo "$enriched_line" >> "$TMP_OUTPUT"
        ((enriched++)) || true
    else
        # On error, keep original line
        echo "$line" >> "$TMP_OUTPUT"
        ((errors++)) || true
    fi
done < "$MANIFEST_PATH"

# Step 3: Compute childCount based on parentId references
echo ""
echo "Step 3: Computing childCount values..."

# For each entry with a non-null parentId, increment the parent's childCount
# This is done in a second pass since we need all entries enriched first
if [[ -f "$TMP_OUTPUT" ]]; then
    # Build a parentId->count map
    parent_counts=$(jq -r 'select(.parentId != null) | .parentId' "$TMP_OUTPUT" 2>/dev/null | sort | uniq -c | awk '{print $2"\t"$1}')

    if [[ -n "$parent_counts" ]]; then
        TMP_FINAL="${MANIFEST_PATH}.hierarchy-final.$$"
        while IFS= read -r line; do
            entry_id=$(echo "$line" | jq -r '.id' 2>/dev/null)
            count=$(echo "$parent_counts" | awk -F'\t' -v id="$entry_id" '$1==id{print $2}')
            if [[ -n "$count" ]]; then
                echo "$line" | jq -c --argjson c "$count" '.childCount = $c' >> "$TMP_FINAL"
            else
                echo "$line" >> "$TMP_FINAL"
            fi
        done < "$TMP_OUTPUT"
        mv "$TMP_FINAL" "$TMP_OUTPUT"
    fi
fi

# Step 4: Replace original
echo ""
echo "Step 4: Replacing original manifest..."
mv "$TMP_OUTPUT" "$MANIFEST_PATH"

# Step 5: Generate report
final_count=$(wc -l < "$MANIFEST_PATH")
with_epic=$(jq -r 'select(.epicId != null) | .id' "$MANIFEST_PATH" 2>/dev/null | wc -l)
with_path=$(jq -r 'select(.path != null and .path != "") | .id' "$MANIFEST_PATH" 2>/dev/null | wc -l)

echo ""
echo "=== Backfill Report ==="
echo "  Total entries:     $final_count"
echo "  Enriched:          $enriched"
echo "  Orphans (no epic): $orphans"
echo "  Errors:            $errors"
echo "  With epicId:       $with_epic"
echo "  With path:         $with_path"
echo "  Backup at:         $BACKUP_PATH"
echo ""
echo "Backfill complete."
