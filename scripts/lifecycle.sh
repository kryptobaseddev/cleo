#!/usr/bin/env bash
###CLEO
# command: lifecycle
# category: validation
# synopsis: Manage RCSD-IVTR lifecycle pipeline stages and gates
# relevance: high
# flags: --format,--json,--human,--pipeline,--reason,--notes,--strict,--overwrite,--history
# exits: 0,4,80,83
# json-output: true
# subcommands: stages,status,validate,report,export,record,enforce,skip,unskip,import
# note: Manages RCSD-IVTR lifecycle gate enforcement for epic progression
###END
# CLEO Lifecycle Operations Command
# Manage RCSD-IVTR lifecycle pipeline stages and gates
#
# @task T3085
# LAYER: CLI Entry Point
# DEPENDS: lib/tasks/lifecycle.sh, lib/core/output-format.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# Source core libraries
source "$LIB_DIR/core/exit-codes.sh"
[[ -f "$LIB_DIR/core/output-format.sh" ]] && source "$LIB_DIR/core/output-format.sh"
[[ -f "$LIB_DIR/core/error-json.sh" ]] && source "$LIB_DIR/core/error-json.sh"
[[ -f "$LIB_DIR/ui/flags.sh" ]] && source "$LIB_DIR/ui/flags.sh"

# Source lifecycle library
source "$LIB_DIR/tasks/lifecycle.sh"

TODO_DIR="${TODO_DIR:-.cleo}"
COMMAND_NAME="lifecycle"

# ============================================================================
# USAGE
# ============================================================================

usage() {
    cat << 'EOF'
Usage: cleo lifecycle <subcommand> [OPTIONS]

Manage RCSD-IVTR lifecycle pipeline stages and gates.

Query Subcommands (Read-only):
  stages                     List lifecycle stages
  status <EPIC_ID>           Get lifecycle status for epic
  validate <EPIC_ID> <STAGE> Validate lifecycle progression
  report                     Generate lifecycle report
  export                     Export lifecycle data

Mutate Subcommands (Write):
  record <EPIC_ID> <STAGE> <STATUS>  Record stage completion
  enforce <EPIC_ID> <STAGE>          Enforce lifecycle gates
  skip <EPIC_ID> <STAGE>             Skip a stage
  unskip <EPIC_ID> <STAGE>           Unskip a stage
  import <SOURCE>                    Import lifecycle data

Options:
  --pipeline <rcsd|ivtr|all>   Pipeline filter (for stages)
  --format <summary|detailed>  Report format (for report)
  --format <json|csv>          Export format (for export)
  --history                    Include history (for export)
  --reason <TEXT>              Skip reason (for skip, required)
  --notes <TEXT>               Completion notes (for record)
  --strict                     Strict gate enforcement (for enforce)
  --overwrite                  Overwrite existing (for import)
  --json                       JSON output format
  --help                       Show this help message

Lifecycle Stages (RCSD-IVTR):
  research → consensus → specification → decomposition →
  implementation → validation → testing → release

Stage Status Values:
  pending, completed, skipped, blocked

Exit Codes:
  0:  Success
  4:  Not found (EXIT_NOT_FOUND)
  75: Lifecycle gate failed (EXIT_LIFECYCLE_GATE_FAILED)
  80: Lifecycle transition invalid (EXIT_LIFECYCLE_TRANSITION_INVALID)

Examples:
  # List all lifecycle stages
  cleo lifecycle stages

  # List only RCSD pipeline stages
  cleo lifecycle --pipeline rcsd stages

  # Get status for epic
  cleo lifecycle status T1234

  # Validate progression to implementation
  cleo lifecycle validate T1234 implementation

  # Record completion of research stage
  cleo lifecycle --notes "Completed analysis" record T1234 research completed

  # Skip consensus stage
  cleo lifecycle --reason "Single agent decision" skip T1234 consensus

  # Unskip a stage
  cleo lifecycle unskip T1234 consensus

  # Generate summary report
  cleo lifecycle --format summary report

  # Export data for specific epic
  cleo lifecycle --epic T1234 --format json --history export

Output:
  JSON with operation-specific results
EOF
}

# ============================================================================
# QUERY SUBCOMMANDS (Read-only)
# ============================================================================

# stages - List lifecycle stages
cmd_stages() {
    local pipeline="${PIPELINE:-all}"

    # Define all stages with metadata
    local -A stage_info=(
        ["research"]="RCSD,1,Research phase,60,false"
        ["consensus"]="RCSD,2,Consensus phase,61,false"
        ["specification"]="RCSD,3,Specification phase,62,false"
        ["decomposition"]="RCSD,4,Decomposition phase,63,false"
        ["implementation"]="IVTR,5,Implementation phase,64,false"
        ["validation"]="IVTR,6,Validation phase,68,false"
        ["testing"]="IVTR,7,Testing phase,69,false"
        ["release"]="IVTR,8,Release phase,66,false"
    )

    local stages=()

    # Filter stages based on pipeline
    for stage in "${!stage_info[@]}"; do
        IFS=',' read -r stage_pipeline order name exit_code optional <<< "${stage_info[$stage]}"

        case "$pipeline" in
            rcsd)
                [[ "$stage_pipeline" == "RCSD" ]] && stages+=("$stage")
                ;;
            ivtr)
                [[ "$stage_pipeline" == "IVTR" ]] && stages+=("$stage")
                ;;
            all|*)
                stages+=("$stage")
                ;;
        esac
    done

    # Build JSON output - sort stages by order (only include filtered stages)
    local -A stages_by_order=()
    local -A included_stages=()

    # Mark included stages
    for stage in "${stages[@]}"; do
        included_stages[$stage]=1
    done

    # Map by order
    for stage in "${stages[@]}"; do
        IFS=',' read -r stage_pipeline order name exit_code optional <<< "${stage_info[$stage]}"
        stages_by_order[$order]="$stage"
    done

    local json_stages="["
    local first=true

    # Iterate in order (1-8), only output included stages
    for order in {1..8}; do
        if [[ -n "${stages_by_order[$order]:-}" ]]; then
            local stage="${stages_by_order[$order]}"

            # Only output if stage was included in filter
            if [[ -n "${included_stages[$stage]:-}" ]]; then
                IFS=',' read -r stage_pipeline o name exit_code optional <<< "${stage_info[$stage]}"

                [[ "$first" == "false" ]] && json_stages+=","
                first=false

                json_stages+="{\"stage\":\"$stage\",\"name\":\"$name\",\"description\":\"$name\",\"exitCode\":$exit_code,\"order\":$order,\"optional\":$optional}"
            fi
        fi
    done

    json_stages+="]"

    # Output result
    if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
        jq -n --argjson stages "$json_stages" '{
            success: true,
            stages: $stages
        }'
    else
        echo "$json_stages" | jq -r '.[] | "\(.order). \(.stage) (\(.name)) - Exit: \(.exitCode)"'
    fi
}

# status - Get lifecycle status for epic
cmd_status() {
    local epic_id="$1"

    if [[ -z "$epic_id" ]]; then
        error_json "E_INVALID_INPUT" "epicId is required" "$EXIT_USAGE"
        exit "$EXIT_USAGE"
    fi

    local manifest_path=".cleo/rcsd/${epic_id}/_manifest.json"

    if [[ ! -f "$manifest_path" ]]; then
        # No manifest = all stages pending
        local pending_stages='["research","consensus","specification","decomposition","implementation","validation","testing","release"]'

        if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
            jq -n --arg id "$epic_id" --argjson stages "$pending_stages" '{
                success: true,
                epicId: $id,
                currentStage: null,
                stages: ($stages | map({stage: ., status: "pending"})),
                nextStage: "research",
                blockedOn: []
            }'
        else
            echo "Epic: $epic_id"
            echo "Status: No lifecycle data (all stages pending)"
            echo "Next: research"
        fi
        return 0
    fi

    # Read manifest
    local manifest
    manifest=$(cat "$manifest_path")

    # Extract stage statuses
    local stages_json="[]"
    for stage in research consensus specification decomposition implementation validation testing release; do
        local status
        status=$(echo "$manifest" | jq -r --arg stage "$stage" '.status[$stage].state // "pending"')
        local completed_at
        completed_at=$(echo "$manifest" | jq -r --arg stage "$stage" '.status[$stage].completedAt // null')

        stages_json=$(echo "$stages_json" | jq --arg stage "$stage" --arg status "$status" --arg ts "$completed_at" \
            '. + [{stage: $stage, status: $status, completedAt: ($ts | if . == "null" then null else . end)}]')
    done

    # Determine current and next stage
    local current_stage="null"
    local next_stage="null"

    for stage in research consensus specification decomposition implementation validation testing release; do
        local status
        status=$(echo "$manifest" | jq -r --arg stage "$stage" '.status[$stage].state // "pending"')

        if [[ "$status" == "pending" || "$status" == "blocked" ]]; then
            if [[ "$next_stage" == "null" ]]; then
                next_stage="\"$stage\""
            fi
        fi

        if [[ "$status" == "completed" || "$status" == "skipped" ]]; then
            current_stage="\"$stage\""
        fi
    done

    # Output result
    if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
        jq -n --arg id "$epic_id" --argjson stages "$stages_json" --argjson current "$current_stage" --argjson next "$next_stage" '{
            success: true,
            epicId: $id,
            currentStage: $current,
            stages: $stages,
            nextStage: $next,
            blockedOn: []
        }'
    else
        echo "Epic: $epic_id"
        echo "Current stage: $(echo "$current_stage" | jq -r '.')"
        echo "Next stage: $(echo "$next_stage" | jq -r '.')"
        echo ""
        echo "Stages:"
        echo "$stages_json" | jq -r '.[] | "  \(.stage): \(.status)"'
    fi
}

# validate - Validate lifecycle progression
cmd_validate() {
    local epic_id="$1"
    local target_stage="$2"

    if [[ -z "$epic_id" || -z "$target_stage" ]]; then
        error_json "E_INVALID_INPUT" "epicId and targetStage are required" "$EXIT_USAGE"
        exit "$EXIT_USAGE"
    fi

    # Validate using library function
    local missing_prereqs=()
    local issues=()

    # Check prerequisite status
    if query_rcsd_prerequisite_status "$epic_id" "$target_stage"; then
        local can_progress=true
    else
        local can_progress=false

        # Determine which prerequisites are missing
        local -a stages=("research" "consensus" "specification" "decomposition" "implementation" "validation" "testing" "release")
        local target_idx=-1

        for i in "${!stages[@]}"; do
            [[ "${stages[$i]}" == "$target_stage" ]] && target_idx=$i && break
        done

        if [[ $target_idx -gt 0 ]]; then
            for ((i=0; i<target_idx; i++)); do
                local state
                state=$(get_rcsd_stage_status "$epic_id" "${stages[$i]}")

                if [[ "$state" != "completed" && "$state" != "skipped" ]]; then
                    missing_prereqs+=("${stages[$i]}")
                    issues+=("{\"stage\":\"${stages[$i]}\",\"severity\":\"error\",\"message\":\"Stage ${stages[$i]} must be completed or skipped before $target_stage\"}")
                fi
            done
        fi
    fi

    # Build issues JSON
    local issues_json="["
    local first=true
    for issue in "${issues[@]}"; do
        [[ "$first" == "false" ]] && issues_json+=","
        first=false
        issues_json+="$issue"
    done
    issues_json+="]"

    # Build missing prereqs JSON
    local prereqs_json="["
    first=true
    for prereq in "${missing_prereqs[@]}"; do
        [[ "$first" == "false" ]] && prereqs_json+=","
        first=false
        prereqs_json+="\"$prereq\""
    done
    prereqs_json+="]"

    # Output result
    if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
        jq -n --argjson valid "$can_progress" --argjson can "$can_progress" \
            --argjson missing "$prereqs_json" --argjson issues "$issues_json" '{
            success: true,
            valid: $valid,
            canProgress: $can,
            missingPrerequisites: $missing,
            issues: $issues
        }'
    else
        echo "Validation for $epic_id → $target_stage:"
        echo "Valid: $can_progress"
        echo "Can progress: $can_progress"
        [[ ${#missing_prereqs[@]} -gt 0 ]] && echo "Missing prerequisites: ${missing_prereqs[*]}"
    fi

    # Exit with appropriate code
    [[ "$can_progress" == "true" ]] && exit 0 || exit "$EXIT_LIFECYCLE_GATE_FAILED"
}

# report - Generate lifecycle report
cmd_report() {
    local epic_id="${EPIC_ID:-}"
    local format="${REPORT_FORMAT:-summary}"

    # Count epics with lifecycle data
    local total_epics=0
    if [[ -d ".cleo/rcsd" ]]; then
        total_epics=$(find ".cleo/rcsd" -mindepth 1 -maxdepth 1 -type d | wc -l)
    fi

    # Count by stage (if specific epic provided)
    local by_stage_json="[]"

    if [[ -n "$epic_id" && -f ".cleo/rcsd/${epic_id}/_manifest.json" ]]; then
        local manifest
        manifest=$(cat ".cleo/rcsd/${epic_id}/_manifest.json")

        for stage in research consensus specification decomposition implementation validation testing release; do
            local state
            state=$(echo "$manifest" | jq -r --arg stage "$stage" '.status[$stage].state // "pending"')
            local count=0
            [[ "$state" != "pending" ]] && count=1

            by_stage_json=$(echo "$by_stage_json" | jq --arg stage "$stage" --argjson count "$count" \
                '. + [{stage: $stage, count: $count}]')
        done
    fi

    # Calculate completion rate
    local completion_rate=0
    if [[ ${#by_stage_json} -gt 2 ]]; then  # More than just []
        local completed
        completed=$(echo "$by_stage_json" | jq '[.[] | select(.count > 0)] | length')
        completion_rate=$((completed * 100 / 8))  # 8 total stages
    fi

    # Output result
    if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
        jq -n --argjson total "$total_epics" --argjson stages "$by_stage_json" --argjson rate "$completion_rate" '{
            success: true,
            totalEpics: $total,
            byStage: $stages,
            completionRate: $rate
        }'
    else
        echo "Lifecycle Report:"
        echo "  Total epics with lifecycle data: $total_epics"
        echo "  Completion rate: ${completion_rate}%"
        [[ ${#by_stage_json} -gt 2 ]] && echo "$by_stage_json" | jq -r '.[] | "  \(.stage): \(.count)"'
    fi
}

# export - Export lifecycle data
cmd_export() {
    local epic_id="${EPIC_ID:-}"
    local format="${EXPORT_FORMAT:-json}"
    local include_history="${INCLUDE_HISTORY:-false}"

    local data="{}"

    if [[ -n "$epic_id" ]]; then
        # Export specific epic
        local manifest_path=".cleo/rcsd/${epic_id}/_manifest.json"

        if [[ -f "$manifest_path" ]]; then
            data=$(cat "$manifest_path")
        else
            error_json "E_NOT_FOUND" "No lifecycle data found for epic $epic_id" "$EXIT_NOT_FOUND"
            exit "$EXIT_NOT_FOUND"
        fi
    else
        # Export all epics
        local all_data="[]"

        if [[ -d ".cleo/rcsd" ]]; then
            for dir in .cleo/rcsd/*/; do
                [[ ! -d "$dir" ]] && continue
                local manifest="$dir/_manifest.json"
                [[ ! -f "$manifest" ]] && continue

                local entry
                entry=$(cat "$manifest")
                all_data=$(echo "$all_data" | jq --argjson entry "$entry" '. + [$entry]')
            done
        fi

        data=$(jq -n --argjson epics "$all_data" '{epics: $epics}')
    fi

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Output based on format
    case "$format" in
        json)
            jq -n --argjson data "$data" --arg ts "$timestamp" --arg fmt "json" '{
                success: true,
                format: $fmt,
                data: $data,
                timestamp: $ts
            }'
            ;;
        csv)
            # Simple CSV export (can be enhanced)
            echo "epicId,stage,status,completedAt"

            if [[ -n "$epic_id" ]]; then
                local epic="$epic_id"
                for stage in research consensus specification decomposition implementation validation testing release; do
                    local status completed_at
                    status=$(echo "$data" | jq -r --arg stage "$stage" '.status[$stage].state // "pending"')
                    completed_at=$(echo "$data" | jq -r --arg stage "$stage" '.status[$stage].completedAt // ""')
                    echo "$epic,$stage,$status,$completed_at"
                done
            fi
            ;;
        *)
            error_json "E_INVALID_INPUT" "Invalid format: $format (use json or csv)" "$EXIT_USAGE"
            exit "$EXIT_USAGE"
            ;;
    esac
}

# ============================================================================
# MUTATE SUBCOMMANDS (Write)
# ============================================================================

# record - Record stage completion
cmd_record() {
    local epic_id="$1"
    local stage="$2"
    local status="$3"
    local notes="${NOTES:-}"

    if [[ -z "$epic_id" || -z "$stage" || -z "$status" ]]; then
        error_json "E_INVALID_INPUT" "epicId, stage, and status are required" "$EXIT_USAGE"
        exit "$EXIT_USAGE"
    fi

    # Validate stage
    case "$stage" in
        research|consensus|specification|decomposition|implementation|validation|testing|release)
            ;;
        *)
            error_json "E_INVALID_INPUT" "Invalid stage: $stage" "$EXIT_USAGE"
            exit "$EXIT_USAGE"
            ;;
    esac

    # Validate status
    case "$status" in
        completed|skipped|blocked|pending)
            ;;
        *)
            error_json "E_INVALID_INPUT" "Invalid status: $status (use completed, skipped, blocked, or pending)" "$EXIT_USAGE"
            exit "$EXIT_USAGE"
            ;;
    esac

    # Record stage completion
    record_rcsd_stage_completion "$epic_id" "$stage" "$status"

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Output result
    if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
        jq -n --arg id "$epic_id" --arg stage "$stage" --arg status "$status" --arg ts "$timestamp" '{
            success: true,
            epicId: $id,
            stage: $stage,
            status: $status,
            recorded: true,
            timestamp: $ts
        }'
    else
        echo "Recorded: $epic_id → $stage = $status"
        [[ -n "$notes" ]] && echo "Notes: $notes"
    fi
}

# enforce - Enforce lifecycle gates
cmd_enforce() {
    local epic_id="$1"
    local stage="$2"
    local strict="${STRICT:-false}"

    if [[ -z "$epic_id" || -z "$stage" ]]; then
        error_json "E_INVALID_INPUT" "epicId and stage are required" "$EXIT_USAGE"
        exit "$EXIT_USAGE"
    fi

    # Check gates using library function
    local gates_passed=()
    local gates_failed=()
    local allowed=false

    if query_rcsd_prerequisite_status "$epic_id" "$stage"; then
        allowed=true
        gates_passed=("prerequisites")
    else
        gates_failed=("prerequisites")
    fi

    # Build JSON arrays
    local passed_json="["
    local first=true
    for gate in "${gates_passed[@]}"; do
        [[ "$first" == "false" ]] && passed_json+=","
        first=false
        passed_json+="\"$gate\""
    done
    passed_json+="]"

    local failed_json="["
    first=true
    for gate in "${gates_failed[@]}"; do
        [[ "$first" == "false" ]] && failed_json+=","
        first=false
        failed_json+="\"$gate\""
    done
    failed_json+="]"

    # Output result
    if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
        jq -n --arg id "$epic_id" --arg stage "$stage" --argjson allowed "$allowed" \
            --argjson passed "$passed_json" --argjson failed "$failed_json" '{
            success: true,
            epicId: $id,
            stage: $stage,
            allowed: $allowed,
            gatesPassed: $passed,
            gatesFailed: $failed
        }'
    else
        echo "Lifecycle gates for $epic_id → $stage:"
        echo "  Allowed: $allowed"
        echo "  Passed: ${gates_passed[*]}"
        [[ ${#gates_failed[@]} -gt 0 ]] && echo "  Failed: ${gates_failed[*]}"
    fi

    # Exit based on result and strict mode
    if [[ "$allowed" == "false" && "$strict" == "true" ]]; then
        exit "$EXIT_LIFECYCLE_GATE_FAILED"
    fi
}

# skip - Skip a stage
cmd_skip() {
    local epic_id="$1"
    local stage="$2"
    local reason="${SKIP_REASON:-}"

    if [[ -z "$epic_id" || -z "$stage" || -z "$reason" ]]; then
        error_json "E_INVALID_INPUT" "epicId, stage, and reason are required" "$EXIT_USAGE"
        exit "$EXIT_USAGE"
    fi

    # Record as skipped
    record_rcsd_stage_completion "$epic_id" "$stage" "skipped"

    # Output result
    if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
        jq -n --arg id "$epic_id" --arg stage "$stage" --arg reason "$reason" '{
            success: true,
            epicId: $id,
            stage: $stage,
            skipped: true,
            reason: $reason
        }'
    else
        echo "Skipped: $epic_id → $stage"
        echo "Reason: $reason"
    fi
}

# unskip - Unskip a stage
cmd_unskip() {
    local epic_id="$1"
    local stage="$2"

    if [[ -z "$epic_id" || -z "$stage" ]]; then
        error_json "E_INVALID_INPUT" "epicId and stage are required" "$EXIT_USAGE"
        exit "$EXIT_USAGE"
    fi

    # Record as pending (unskip)
    record_rcsd_stage_completion "$epic_id" "$stage" "pending"

    # Output result
    if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
        jq -n --arg id "$epic_id" --arg stage "$stage" '{
            success: true,
            epicId: $id,
            stage: $stage,
            unskipped: true
        }'
    else
        echo "Unskipped: $epic_id → $stage (now pending)"
    fi
}

# import - Import lifecycle data
cmd_import() {
    local source="$1"
    local epic_id="${EPIC_ID:-}"
    local overwrite="${OVERWRITE:-false}"

    if [[ -z "$source" ]]; then
        error_json "E_INVALID_INPUT" "source is required" "$EXIT_USAGE"
        exit "$EXIT_USAGE"
    fi

    if [[ ! -f "$source" ]]; then
        error_json "E_FILE_NOT_FOUND" "Source file not found: $source" "$EXIT_NOT_FOUND"
        exit "$EXIT_NOT_FOUND"
    fi

    local imported=0
    local skipped=0
    local errors=()

    # Read source data
    local data
    data=$(cat "$source")

    # Import single epic or multiple
    if echo "$data" | jq -e '.epics' >/dev/null 2>&1; then
        # Multiple epics
        local count
        count=$(echo "$data" | jq '.epics | length')

        for ((i=0; i<count; i++)); do
            local entry
            entry=$(echo "$data" | jq --argjson i "$i" '.epics[$i]')
            local entry_id
            entry_id=$(echo "$entry" | jq -r '.taskId // .epicId // "UNKNOWN"')

            if [[ -n "$epic_id" && "$entry_id" != "$epic_id" ]]; then
                ((skipped++))
                continue
            fi

            local target_path=".cleo/rcsd/${entry_id}/_manifest.json"

            if [[ -f "$target_path" && "$overwrite" != "true" ]]; then
                ((skipped++))
                continue
            fi

            mkdir -p ".cleo/rcsd/${entry_id}"
            echo "$entry" > "$target_path"
            ((imported++))
        done
    else
        # Single epic
        local entry_id
        entry_id=$(echo "$data" | jq -r '.taskId // .epicId // "UNKNOWN"')

        if [[ -n "$epic_id" && "$entry_id" != "$epic_id" ]]; then
            errors+=("Epic ID mismatch: expected $epic_id, got $entry_id")
        else
            local target_path=".cleo/rcsd/${entry_id}/_manifest.json"

            if [[ -f "$target_path" && "$overwrite" != "true" ]]; then
                ((skipped++))
            else
                mkdir -p ".cleo/rcsd/${entry_id}"
                echo "$data" > "$target_path"
                ((imported++))
            fi
        fi
    fi

    # Build errors JSON
    local errors_json="["
    local first=true
    for error in "${errors[@]}"; do
        [[ "$first" == "false" ]] && errors_json+=","
        first=false
        errors_json+="\"$error\""
    done
    errors_json+="]"

    # Output result
    if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
        jq -n --argjson imported "$imported" --argjson skipped "$skipped" --argjson errors "$errors_json" '{
            success: true,
            imported: $imported,
            skipped: $skipped,
            errors: $errors
        }'
    else
        echo "Import complete:"
        echo "  Imported: $imported"
        echo "  Skipped: $skipped"
        [[ ${#errors[@]} -gt 0 ]] && echo "  Errors: ${errors[*]}"
    fi
}

# ============================================================================
# MAIN
# ============================================================================

# Parse global flags
PIPELINE=""
EPIC_ID=""
REPORT_FORMAT="summary"
EXPORT_FORMAT="json"
INCLUDE_HISTORY="false"
NOTES=""
STRICT="false"
SKIP_REASON=""
OVERWRITE="false"
OUTPUT_JSON="false"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --help|-h)
            usage
            exit 0
            ;;
        --json)
            OUTPUT_JSON="true"
            shift
            ;;
        --pipeline)
            PIPELINE="$2"
            shift 2
            ;;
        --epic)
            EPIC_ID="$2"
            shift 2
            ;;
        --format)
            # Determine context (report or export)
            if [[ "${SUBCOMMAND:-}" == "report" ]]; then
                REPORT_FORMAT="$2"
            else
                EXPORT_FORMAT="$2"
            fi
            shift 2
            ;;
        --history)
            INCLUDE_HISTORY="true"
            shift
            ;;
        --notes)
            NOTES="$2"
            shift 2
            ;;
        --strict)
            STRICT="true"
            shift
            ;;
        --reason)
            SKIP_REASON="$2"
            shift 2
            ;;
        --overwrite)
            OVERWRITE="true"
            shift
            ;;
        stages|status|validate|report|export|record|enforce|skip|unskip|import)
            SUBCOMMAND="$1"
            shift
            break
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage
            exit "$EXIT_USAGE"
            ;;
    esac
done

# Execute subcommand
case "${SUBCOMMAND:-}" in
    stages)
        cmd_stages
        ;;
    status)
        if [[ $# -lt 1 ]]; then
            echo "Error: status requires EPIC_ID" >&2
            usage
            exit "$EXIT_USAGE"
        fi
        cmd_status "$1"
        ;;
    validate)
        if [[ $# -lt 2 ]]; then
            echo "Error: validate requires EPIC_ID and STAGE" >&2
            usage
            exit "$EXIT_USAGE"
        fi
        cmd_validate "$1" "$2"
        ;;
    report)
        cmd_report
        ;;
    export)
        cmd_export
        ;;
    record)
        if [[ $# -lt 3 ]]; then
            echo "Error: record requires EPIC_ID, STAGE, and STATUS" >&2
            usage
            exit "$EXIT_USAGE"
        fi
        cmd_record "$1" "$2" "$3"
        ;;
    enforce)
        if [[ $# -lt 2 ]]; then
            echo "Error: enforce requires EPIC_ID and STAGE" >&2
            usage
            exit "$EXIT_USAGE"
        fi
        cmd_enforce "$1" "$2"
        ;;
    skip)
        if [[ $# -lt 2 ]]; then
            echo "Error: skip requires EPIC_ID and STAGE" >&2
            usage
            exit "$EXIT_USAGE"
        fi
        cmd_skip "$1" "$2"
        ;;
    unskip)
        if [[ $# -lt 2 ]]; then
            echo "Error: unskip requires EPIC_ID and STAGE" >&2
            usage
            exit "$EXIT_USAGE"
        fi
        cmd_unskip "$1" "$2"
        ;;
    import)
        if [[ $# -lt 1 ]]; then
            echo "Error: import requires SOURCE" >&2
            usage
            exit "$EXIT_USAGE"
        fi
        cmd_import "$1"
        ;;
    "")
        echo "Error: subcommand required" >&2
        usage
        exit "$EXIT_USAGE"
        ;;
    *)
        echo "Unknown subcommand: $SUBCOMMAND" >&2
        usage
        exit "$EXIT_USAGE"
        ;;
esac
