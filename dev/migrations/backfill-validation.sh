#!/usr/bin/env bash
# backfill-validation.sh - Backfill real validation scores for historical COMPLIANCE.jsonl
#
# CRITICAL PURPOSE: Replace fake (hardcoded 100%) validation scores with real ones
#
# This script:
#   1. Reads entries from COMPLIANCE.jsonl
#   2. For each entry without real validation, re-runs actual protocol validation
#   3. Updates COMPLIANCE.jsonl with real validation scores
#
# Usage:
#   ./dev/migrations/backfill-validation.sh [--dry-run] [--limit N]
#
# Options:
#   --dry-run       Show what would change without modifying files
#   --limit N       Process only first N entries (for testing)
#
# @task T2853
# @epic T2163

set -euo pipefail

# Determine script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Source dependencies
# shellcheck source=lib/validation/manifest-validation.sh
source "$PROJECT_ROOT/lib/validation/manifest-validation.sh"

# shellcheck source=lib/core/exit-codes.sh
source "$PROJECT_ROOT/lib/core/exit-codes.sh"

# Paths
COMPLIANCE_PATH="${COMPLIANCE_PATH:-.cleo/metrics/COMPLIANCE.jsonl}"
MANIFEST_PATH="${MANIFEST_PATH:-claudedocs/agent-outputs/MANIFEST.jsonl}"
BACKUP_DIR=".cleo/.backups"

# ============================================================================
# CONFIGURATION
# ============================================================================

DRY_RUN=false
LIMIT=""
VERBOSE=false

# ============================================================================
# HELPERS
# ============================================================================

log() {
    echo "[backfill-validation] $1" >&2
}

error() {
    echo "[backfill-validation] ERROR: $1" >&2
}

debug() {
    [[ "$VERBOSE" == true ]] && echo "[backfill-validation] DEBUG: $1" >&2
    return 0
}

# has_real_validation - Check if compliance entry has real validation data
# Args: $1 = compliance_entry_json
# Returns: 0 if has real validation, 1 if needs backfill
has_real_validation() {
    local entry="$1"

    # Check if _context.validation_score exists
    local has_validation_score
    has_validation_score=$(echo "$entry" | jq 'has("_context") and (._context | has("validation_score"))')

    # If no validation_score field at all, needs backfill
    if [[ "$has_validation_score" != "true" ]]; then
        debug "Entry missing _context.validation_score"
        return 1
    fi

    # Check if validation_score is exactly 100 (hardcoded fake)
    local validation_score
    validation_score=$(echo "$entry" | jq -r '._context.validation_score // 0')

    if [[ "$validation_score" == "100" ]]; then
        debug "Entry has hardcoded validation_score=100 (fake)"
        return 1
    fi

    # Check if compliance_pass_rate is exactly 1.0 AND violation_count is 0 (likely fake)
    local pass_rate violation_count
    pass_rate=$(echo "$entry" | jq -r '.compliance.compliance_pass_rate // 0')
    violation_count=$(echo "$entry" | jq -r '.compliance.violation_count // 0')

    if [[ "$pass_rate" == "1.0" || "$pass_rate" == "1" ]] && [[ "$violation_count" == "0" ]]; then
        # Check if _context.violations exists (real validation includes this)
        local has_violations
        has_violations=$(echo "$entry" | jq 'has("_context") and (._context | has("violations"))')

        if [[ "$has_violations" != "true" ]]; then
            debug "Entry has perfect score without violations array (fake)"
            return 1
        fi
    fi

    # Has real validation data
    return 0
}

# ============================================================================
# MAIN LOGIC
# ============================================================================

backfill_validation() {
    local compliance_path="$1"
    local manifest_path="$2"
    local dry_run="$3"
    local limit="$4"

    # Validate paths
    if [[ ! -f "$compliance_path" ]]; then
        error "COMPLIANCE.jsonl not found: $compliance_path"
        return "${EXIT_FILE_NOT_FOUND:-4}"
    fi

    if [[ ! -f "$manifest_path" ]]; then
        error "MANIFEST.jsonl not found: $manifest_path"
        return "${EXIT_FILE_NOT_FOUND:-4}"
    fi

    # Create backup unless dry-run
    if [[ "$dry_run" == false ]]; then
        log "Creating backup of COMPLIANCE.jsonl..."
        mkdir -p "$BACKUP_DIR"
        local backup_file="$BACKUP_DIR/COMPLIANCE.jsonl.$(date +%Y%m%d-%H%M%S)"
        cp "$compliance_path" "$backup_file"
        log "Backup created: $backup_file"
    fi

    # Count total entries
    local total_entries
    total_entries=$(wc -l < "$compliance_path")
    log "Total compliance entries: $total_entries"

    # Process entries
    local processed=0
    local backfilled=0
    local skipped=0
    local errors=0

    local temp_output=""
    if [[ "$dry_run" == false ]]; then
        temp_output=$(mktemp)
    fi

    while IFS= read -r entry; do
        processed=$((processed + 1))

        # Show progress every 10 entries
        if (( processed % 10 == 0 )); then
            log "Progress: $processed/$total_entries"
        fi

        # Check limit
        if [[ -n "$limit" ]] && (( processed > limit )); then
            log "Reached limit of $limit entries"
            break
        fi

        # Extract source_id (task ID)
        local task_id
        task_id=$(echo "$entry" | jq -r '.source_id // empty')

        if [[ -z "$task_id" ]]; then
            debug "Entry $processed: no source_id, skipping"
            skipped=$((skipped + 1))
            if [[ "$dry_run" == false ]]; then
                echo "$entry" >> "$temp_output"
            fi
            continue
        fi

        # Check if entry needs backfill
        if has_real_validation "$entry"; then
            debug "Entry $processed ($task_id): already has real validation"
            skipped=$((skipped + 1))
            if [[ "$dry_run" == false ]]; then
                echo "$entry" >> "$temp_output"
            fi
            continue
        fi

        log "Entry $processed ($task_id): needs backfill..."

        # Find manifest entry
        local manifest_entry
        manifest_entry=$(find_manifest_entry "$task_id" "$manifest_path" 2>/dev/null || true)

        if [[ -z "$manifest_entry" ]]; then
            log "  WARNING: No manifest entry found for $task_id, keeping original"
            errors=$((errors + 1))
            if [[ "$dry_run" == false ]]; then
                echo "$entry" >> "$temp_output"
            fi
            continue
        fi

        # Get agent_type from manifest
        local agent_type
        agent_type=$(echo "$manifest_entry" | jq -r '.agent_type // "unknown"')

        # Run real validation
        local validation_result
        validation_result=$(validate_manifest_entry "$task_id" "$manifest_entry" 2>/dev/null || echo '{"valid":false,"score":0,"pass":false}')

        # Extract metrics
        local score pass violation_count violations
        score=$(echo "$validation_result" | jq -r '.score // 0')
        pass=$(echo "$validation_result" | jq -r '.pass // .valid // false')
        violations=$(echo "$validation_result" | jq -c '.violations // []')
        violation_count=$(echo "$violations" | jq 'length')

        # Determine severity
        local severity="none"
        if [[ "$violation_count" -gt 0 ]]; then
            local has_error
            has_error=$(echo "$violations" | jq '[.[] | select(.severity == "error")] | length')
            if [[ "$has_error" -gt 0 ]]; then
                severity="error"
            else
                severity="warning"
            fi
        fi

        # Calculate pass rate
        local pass_rate
        if [[ "$pass" == "true" ]]; then
            pass_rate="1.0"
        else
            pass_rate=$(awk "BEGIN {printf \"%.2f\", $score / 100}")
        fi

        log "  Real validation: score=$score, pass=$pass, violations=$violation_count"

        if [[ "$dry_run" == true ]]; then
            log "  [DRY-RUN] Would update compliance entry"
        else
            # Build updated entry with real validation
            local updated_entry
            updated_entry=$(echo "$entry" | jq -c \
                --argjson pass_rate "$pass_rate" \
                --argjson score "$score" \
                --argjson violation_count "$violation_count" \
                --arg severity "$severity" \
                --argjson violations "$violations" \
                --arg agent_type "$agent_type" \
                '
                .compliance.compliance_pass_rate = $pass_rate |
                .compliance.rule_adherence_score = ($score / 100) |
                .compliance.violation_count = $violation_count |
                .compliance.violation_severity = $severity |
                .compliance.manifest_integrity = (if $violation_count == 0 then "valid" else "violations_found" end) |
                ._context.agent_type = $agent_type |
                ._context.validation_score = $score |
                ._context.violations = $violations
                ')

            echo "$updated_entry" >> "$temp_output"
        fi

        backfilled=$((backfilled + 1))

    done < "$compliance_path"

    # Replace original file with updated version
    if [[ "$dry_run" == false ]] && [[ -f "$temp_output" ]]; then
        mv "$temp_output" "$compliance_path"
        log "Updated COMPLIANCE.jsonl"
    fi

    # Summary
    echo ""
    log "=== BACKFILL SUMMARY ==="
    log "Total entries:     $processed"
    log "Backfilled:        $backfilled"
    log "Already valid:     $skipped"
    log "Errors:            $errors"

    if [[ "$dry_run" == true ]]; then
        log ""
        log "DRY RUN - No changes made"
        log "Run without --dry-run to apply changes"
    fi

    return 0
}

# ============================================================================
# CLI ARGUMENT PARSING
# ============================================================================

show_help() {
    cat <<EOF
Usage: $0 [OPTIONS]

Backfill real validation scores for historical COMPLIANCE.jsonl entries.

Options:
    --dry-run       Show what would change without modifying files
    --limit N       Process only first N entries (for testing)
    --verbose       Enable debug output
    --help          Show this help message

Examples:
    # Preview first 5 entries
    $0 --dry-run --limit 5

    # Backfill all entries
    $0

    # Backfill with verbose output
    $0 --verbose

Exit Codes:
    0   Success
    3   File error
    4   File not found
    6   Validation error
EOF
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --limit)
            LIMIT="$2"
            shift 2
            ;;
        --verbose)
            VERBOSE=true
            shift
            ;;
        --help|-h)
            show_help
            exit 0
            ;;
        *)
            error "Unknown option: $1"
            show_help
            exit "${EXIT_INVALID_ARGS:-2}"
            ;;
    esac
done

# ============================================================================
# MAIN EXECUTION
# ============================================================================

main() {
    log "Starting validation backfill..."

    if [[ "$DRY_RUN" == true ]]; then
        log "DRY RUN MODE - No changes will be made"
    fi

    if [[ -n "$LIMIT" ]]; then
        log "Processing limit: $LIMIT entries"
    fi

    backfill_validation \
        "$PROJECT_ROOT/$COMPLIANCE_PATH" \
        "$PROJECT_ROOT/$MANIFEST_PATH" \
        "$DRY_RUN" \
        "$LIMIT"
}

# Run if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
