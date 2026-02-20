#!/usr/bin/env bash
# check-lib-compliance.sh - Validate lib/*.sh against LIBRARY-ARCHITECTURE-SPEC.md
#
# This script validates library architecture compliance including:
#   - Source guards present (required pattern)
#   - Layer headers present (LAYER/DEPENDENCIES/PROVIDES)
#   - No circular dependencies
#   - Dependency count <=3 per file
#
# Usage:
#   ./dev/check-lib-compliance.sh                    # Full compliance check
#   ./dev/check-lib-compliance.sh --check guard      # Check source guards only
#   ./dev/check-lib-compliance.sh --check header     # Check layer headers only
#   ./dev/check-lib-compliance.sh --check circular   # Check circular deps only
#   ./dev/check-lib-compliance.sh --check count      # Check dependency count only
#   ./dev/check-lib-compliance.sh --format json      # JSON output
#   ./dev/check-lib-compliance.sh --fix              # Attempt to fix issues (future)
#
# Follows LLM-Agent-First principles:
#   - JSON output by default for non-TTY
#   - --format, --quiet, --json, --human flags
#   - Structured _meta envelope
#   - DEV_EXIT_* constants

set -euo pipefail

# ============================================================================
# SETUP - LLM-Agent-First compliant
# ============================================================================

# Script location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_LIB_DIR="$SCRIPT_DIR/lib"

# Source dev library
source "$DEV_LIB_DIR/dev-common.sh"

# Command identification
COMMAND_NAME="check-lib-compliance"

# Project paths
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB_DIR="$PROJECT_ROOT/lib"
SPEC_PATH="$PROJECT_ROOT/docs/specs/LIBRARY-ARCHITECTURE-SPEC.md"

# Version
TOOL_VERSION="1.0.0"

# ============================================================================
# DEFAULT OPTIONS
# ============================================================================

FORMAT=""
VERBOSE=false
QUIET=false
SPECIFIC_CHECK=""
FIX_MODE=false

# ============================================================================
# KNOWN LAYER MAPPINGS (fallback for files without LAYER headers)
# ============================================================================

declare -gA KNOWN_LAYERS=(
    ["exit-codes.sh"]=0
    ["platform-compat.sh"]=0
    ["version.sh"]=0
    ["config.sh"]=1
    ["error-json.sh"]=1
    ["output-format.sh"]=1
    ["jq-helpers.sh"]=1
    ["atomic-write.sh"]=1
    ["dependency-check.sh"]=1
    ["grammar.sh"]=1
    ["file-ops.sh"]=2
    ["validation.sh"]=2
    ["logging.sh"]=2
    ["backup.sh"]=2
    ["hierarchy.sh"]=2
    ["cache.sh"]=2
    ["migrate.sh"]=2
    ["analysis.sh"]=3
    ["cancel-ops.sh"]=3
    ["deletion-strategy.sh"]=3
    ["phase-tracking.sh"]=3
    ["archive-cancel.sh"]=3
    ["delete-preview.sh"]=3
    ["todowrite-integration.sh"]=3
)

declare -gA LAYER_LIMITS=(
    [0]=0
    [1]=2
    [2]=3
    [3]=3
)

# ============================================================================
# FOUNDATION UTILITIES (exempt from same-layer sourcing rule)
# ============================================================================
# These L2 files provide essential infrastructure and MAY be sourced by
# other L2 files. This is an intentional exception to the same-layer rule
# documented in LIBRARY-ARCHITECTURE-SPEC.md Section 5.1.
declare -gA FOUNDATION_UTILITIES=(
    ["file-ops.sh"]=1
    ["logging.sh"]=1
)

# ============================================================================
# USAGE
# ============================================================================

usage() {
    cat << EOF
Library Architecture Compliance Validator v${TOOL_VERSION}

Usage: $(basename "$0") [OPTIONS]

Options:
  -c, --check <type>      Which check to run
                          (guard, header, circular, count, all)
                          Default: all
  -f, --format <format>   Output format: text, json
                          (default: json for non-TTY, text for TTY)
      --json              JSON output shortcut
      --human             Human/text output shortcut
      --fix               Attempt to fix issues (placeholder)
  -v, --verbose           Show detailed check output
  -q, --quiet             Only show failures and summary
  -h, --help              Show this help message
      --version           Show version

Check Types:
  guard     - Source guard pattern present (prevents double-loading)
  header    - Layer header comments (LAYER/DEPENDENCIES/PROVIDES)
  circular  - No circular dependency chains
  count     - Dependency count <=3 per library
  all       - Run all checks (default)

Examples:
  $(basename "$0")                          # Full compliance check
  $(basename "$0") --check guard            # Only check source guards
  $(basename "$0") --check circular --json  # Check circular deps, JSON output
  $(basename "$0") --verbose                # Detailed output

Validates against: docs/specs/LIBRARY-ARCHITECTURE-SPEC.md
EOF
}

# ============================================================================
# ARGUMENT PARSING
# ============================================================================

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -c|--check)
                SPECIFIC_CHECK="$2"
                shift 2
                ;;
            -f|--format)
                FORMAT="$2"
                shift 2
                ;;
            --json)
                FORMAT="json"
                shift
                ;;
            --human)
                FORMAT="text"
                shift
                ;;
            --fix)
                FIX_MODE=true
                shift
                ;;
            -v|--verbose)
                VERBOSE=true
                shift
                ;;
            -q|--quiet)
                QUIET=true
                shift
                ;;
            -h|--help)
                usage
                exit $DEV_EXIT_SUCCESS
                ;;
            --version)
                echo "check-lib-compliance v${TOOL_VERSION}"
                exit $DEV_EXIT_SUCCESS
                ;;
            *)
                log_error "Unknown option: $1"
                usage >&2
                exit $DEV_EXIT_INVALID_INPUT
                ;;
        esac
    done

    # Validate check type if specified
    if [[ -n "$SPECIFIC_CHECK" ]]; then
        case "$SPECIFIC_CHECK" in
            guard|header|circular|count|all)
                # Valid check type
                ;;
            *)
                log_error "Invalid check type: $SPECIFIC_CHECK"
                log_error "Valid types: guard, header, circular, count, all"
                exit $DEV_EXIT_INVALID_INPUT
                ;;
        esac
    fi
}

# ============================================================================
# SOURCE GUARD CHECKER (T828)
# ============================================================================

# Convert filename to expected guard variable name
_filename_to_guard() {
    local filename="$1"
    local base_name="${filename%.sh}"
    base_name="${base_name//-/_}"
    base_name="${base_name^^}"
    echo "_${base_name}_LOADED"
}

# Extract guard variable from file
_extract_guard_variable() {
    local file_path="$1"
    local guard_var=""
    guard_var=$(head -40 "$file_path" 2>/dev/null | \
        grep -oE '\[\[ -n "\$\{_[A-Z_]+_LOADED:-\}" \]\] && return 0' | \
        head -1 | \
        grep -oE '_[A-Z_]+_LOADED' || true)

    if [[ -n "$guard_var" ]]; then
        echo "$guard_var"
        return 0
    fi
    return 1
}

# Verify declare statement exists
_verify_guard_declare() {
    local file_path="$1"
    local guard_var="$2"
    head -45 "$file_path" 2>/dev/null | \
        grep -qE "(declare -r ${guard_var}=1|${guard_var}=1)"
}

# Check if guard matches expected or variant
_guard_matches() {
    local actual="$1"
    local expected="$2"
    [[ "$actual" == "$expected" ]] && return 0
    local variant_sh="${expected%_LOADED}_SH_LOADED"
    [[ "$actual" == "$variant_sh" ]] && return 0
    return 1
}

check_source_guards() {
    local lib_dir="${LIB_DIR:-}"

    if [[ -z "$lib_dir" || ! -d "$lib_dir" ]]; then
        jq -n '{"passed": false, "files_checked": 0, "issues": [{"file": "N/A", "issue": "LIB_DIR not set or not found"}]}'
        return 0
    fi

    local files_checked=0
    local issues=()
    local all_passed=true

    for file_path in "$lib_dir"/*.sh; do
        [[ -f "$file_path" ]] || continue
        local filename
        filename=$(basename "$file_path")
        ((files_checked++)) || true

        local expected_guard
        expected_guard=$(_filename_to_guard "$filename")

        local actual_guard
        if ! actual_guard=$(_extract_guard_variable "$file_path"); then
            all_passed=false
            issues+=("{\"file\": \"lib/$filename\", \"issue\": \"Missing source guard\", \"expected\": \"$expected_guard\"}")
            continue
        fi

        if ! _guard_matches "$actual_guard" "$expected_guard"; then
            all_passed=false
            issues+=("{\"file\": \"lib/$filename\", \"issue\": \"Guard name mismatch (found: $actual_guard)\", \"expected\": \"$expected_guard\"}")
        fi

        if ! _verify_guard_declare "$file_path" "$actual_guard"; then
            all_passed=false
            issues+=("{\"file\": \"lib/$filename\", \"issue\": \"Missing declare statement\", \"expected\": \"declare -r $actual_guard=1\"}")
        fi
    done

    local issues_json="[]"
    if [[ ${#issues[@]} -gt 0 ]]; then
        issues_json=$(printf '%s\n' "${issues[@]}" | jq -s '.')
    fi

    jq -n \
        --arg check "source_guards" \
        --argjson passed "$all_passed" \
        --argjson files_checked "$files_checked" \
        --argjson issues_found "${#issues[@]}" \
        --argjson issues "$issues_json" \
        '{check: $check, passed: $passed, files_checked: $files_checked, issues_found: $issues_found, issues: $issues}'
}

# ============================================================================
# LAYER HEADER CHECKER (T829)
# ============================================================================

check_layer_headers() {
    local lib_dir="${LIB_DIR:-lib}"
    local files_checked=0
    local passed=true
    local issues_json="[]"
    local layers_0="[]"
    local layers_1="[]"
    local layers_2="[]"
    local layers_3="[]"

    for file in "$lib_dir"/*.sh; do
        [[ -f "$file" ]] || continue
        local filename
        filename=$(basename "$file")
        ((files_checked++))

        local header
        header=$(head -n 30 "$file")

        # Check LAYER header
        local layer_line
        layer_line=$(echo "$header" | grep -E "^#[[:space:]]*LAYER:" | head -n 1)
        if [[ -z "$layer_line" ]]; then
            passed=false
            issues_json=$(echo "$issues_json" | jq --arg file "$filename" --arg issue "Missing LAYER header" '. + [{"file": ("lib/" + $file), "issue": $issue}]')
            continue
        fi

        local layer_value
        layer_value=$(echo "$layer_line" | sed -E 's/^#[[:space:]]*LAYER:[[:space:]]*([0-9]+).*/\1/')
        if [[ ! "$layer_value" =~ ^[0-3]$ ]]; then
            passed=false
            issues_json=$(echo "$issues_json" | jq --arg file "$filename" --arg issue "Invalid LAYER value: $layer_value" '. + [{"file": ("lib/" + $file), "issue": $issue}]')
            continue
        fi

        # Check DEPENDENCIES header
        local deps_line
        deps_line=$(echo "$header" | grep -E "^#[[:space:]]*DEPENDENCIES:" | head -n 1)
        if [[ -z "$deps_line" ]]; then
            passed=false
            issues_json=$(echo "$issues_json" | jq --arg file "$filename" --arg issue "Missing DEPENDENCIES header" '. + [{"file": ("lib/" + $file), "issue": $issue}]')
            continue
        fi

        local deps_value
        deps_value=$(echo "$deps_line" | sed -E 's/^#[[:space:]]*DEPENDENCIES:[[:space:]]*//')
        if [[ -z "$deps_value" ]]; then
            passed=false
            issues_json=$(echo "$issues_json" | jq --arg file "$filename" --arg issue "Empty DEPENDENCIES value" '. + [{"file": ("lib/" + $file), "issue": $issue}]')
            continue
        fi

        # Layer 0 must have DEPENDENCIES: none
        if [[ "$layer_value" == "0" ]]; then
            local deps_normalized
            deps_normalized=$(echo "$deps_value" | tr '[:upper:]' '[:lower:]' | sed 's/[[:space:]]//g')
            if [[ "$deps_normalized" != "none" ]]; then
                passed=false
                issues_json=$(echo "$issues_json" | jq --arg file "$filename" --arg issue "Layer 0 must have DEPENDENCIES: none" '. + [{"file": ("lib/" + $file), "issue": $issue}]')
                continue
            fi
        fi

        # Check PROVIDES header
        local provides_line
        provides_line=$(echo "$header" | grep -E "^#[[:space:]]*PROVIDES:" | head -n 1)
        if [[ -z "$provides_line" ]]; then
            passed=false
            issues_json=$(echo "$issues_json" | jq --arg file "$filename" --arg issue "Missing PROVIDES header" '. + [{"file": ("lib/" + $file), "issue": $issue}]')
            continue
        fi

        # Add to layer inventory
        case "$layer_value" in
            0) layers_0=$(echo "$layers_0" | jq --arg f "$filename" '. + [$f]') ;;
            1) layers_1=$(echo "$layers_1" | jq --arg f "$filename" '. + [$f]') ;;
            2) layers_2=$(echo "$layers_2" | jq --arg f "$filename" '. + [$f]') ;;
            3) layers_3=$(echo "$layers_3" | jq --arg f "$filename" '. + [$f]') ;;
        esac
    done

    jq -n \
        --arg check "layer_headers" \
        --argjson passed "$passed" \
        --argjson files_checked "$files_checked" \
        --argjson issues "$issues_json" \
        --argjson issues_found "$(echo "$issues_json" | jq 'length')" \
        --argjson l0 "$layers_0" \
        --argjson l1 "$layers_1" \
        --argjson l2 "$layers_2" \
        --argjson l3 "$layers_3" \
        '{check: $check, passed: $passed, files_checked: $files_checked, issues_found: $issues_found, issues: $issues, layers: {"0": $l0, "1": $l1, "2": $l2, "3": $l3}}'
}

# ============================================================================
# CIRCULAR DEPENDENCY CHECKER (T830)
# ============================================================================

_extract_layer() {
    local file="$1"
    local layer_line
    layer_line=$(grep -m1 '^# LAYER:' "$file" 2>/dev/null || echo "")
    if [[ -z "$layer_line" ]]; then
        echo "-1"
        return 0
    fi
    local layer_num
    layer_num=$(echo "$layer_line" | sed -E 's/^# LAYER:[[:space:]]*([0-3]).*/\1/')
    [[ "$layer_num" =~ ^[0-3]$ ]] && echo "$layer_num" || echo "-1"
}

# Extract eager (top-level) dependencies only
# Lazy-loaded dependencies (inside functions) are excluded from layer violation checks
# because they don't create load-time circular dependencies
_extract_dependencies() {
    local file="$1"
    local deps=()
    local in_function=0
    local brace_depth=0

    while IFS= read -r line; do
        # Skip comments
        [[ "$line" =~ ^[[:space:]]*# ]] && continue

        # Track function entry (function name() { or function name {)
        if [[ "$line" =~ ^[[:space:]]*(function[[:space:]]+)?[a-zA-Z_][a-zA-Z0-9_]*[[:space:]]*\(\)[[:space:]]*\{? ]] || \
           [[ "$line" =~ ^[[:space:]]*function[[:space:]]+[a-zA-Z_][a-zA-Z0-9_]*[[:space:]]*\{ ]]; then
            in_function=1
            # Check if opening brace is on same line
            if [[ "$line" =~ \{ ]]; then
                brace_depth=1
            fi
            continue
        fi

        # Track brace depth when inside function
        if [[ "$in_function" -eq 1 ]]; then
            # Count opening braces (excluding those in strings/comments)
            local open_braces
            open_braces=$(echo "$line" | grep -o '{' | wc -l)
            local close_braces
            close_braces=$(echo "$line" | grep -o '}' | wc -l)
            brace_depth=$((brace_depth + open_braces - close_braces))

            # Exit function when brace depth returns to 0
            if [[ "$brace_depth" -le 0 ]]; then
                in_function=0
                brace_depth=0
            fi
            # Skip source statements inside functions (lazy-loaded)
            continue
        fi

        # Only process source statements at top level (eager loading)
        [[ ! "$line" =~ source ]] && continue

        local sourced_file=""
        if [[ "$line" =~ source[[:space:]]+[\"\']?\$\{?[A-Za-z_]+\}?/([a-zA-Z0-9_-]+\.sh) ]]; then
            sourced_file="${BASH_REMATCH[1]}"
        elif [[ "$line" =~ source[[:space:]]+[\"\']?[^\"\']*lib/([a-zA-Z0-9_-]+\.sh) ]]; then
            sourced_file="${BASH_REMATCH[1]}"
        fi
        if [[ -n "$sourced_file" ]]; then
            local found=0
            for d in "${deps[@]:-}"; do
                [[ "$d" == "$sourced_file" ]] && found=1 && break
            done
            [[ "$found" -eq 0 ]] && deps+=("$sourced_file")
        fi
    done < "$file"
    echo "${deps[*]}"
}

_check_layer_violations() {
    local lib_dir="$1"
    local violations=()
    declare -A file_layers

    for file in "$lib_dir"/*.sh; do
        [[ ! -f "$file" ]] && continue
        local basename
        basename=$(basename "$file")
        file_layers["$basename"]=$(_extract_layer "$file")
    done

    for file in "$lib_dir"/*.sh; do
        [[ ! -f "$file" ]] && continue
        local basename
        basename=$(basename "$file")
        local file_layer="${file_layers[$basename]}"
        [[ "$file_layer" == "-1" ]] && continue

        if [[ "$file_layer" == "0" ]]; then
            local deps
            deps=$(_extract_dependencies "$file")
            if [[ -n "$deps" ]]; then
                for dep in $deps; do
                    violations+=("{\"type\":\"layer_violation\",\"file\":\"$basename\",\"sources\":\"$dep\",\"message\":\"Layer 0 file must not source other libraries\"}")
                done
            fi
            continue
        fi

        local deps
        deps=$(_extract_dependencies "$file")
        for dep in $deps; do
            local dep_layer="${file_layers[$dep]:-}"
            [[ -z "$dep_layer" || "$dep_layer" == "-1" ]] && continue
            if [[ "$dep_layer" -ge "$file_layer" ]]; then
                # Allow Foundation Utilities to be sourced by same-layer files
                if [[ "$dep_layer" -eq "$file_layer" && -n "${FOUNDATION_UTILITIES[$dep]:-}" ]]; then
                    [[ "$VERBOSE" == true ]] && log_info "Allowed Foundation Utility: $basename → $dep" >&2
                    continue
                fi
                violations+=("{\"type\":\"layer_violation\",\"file\":\"$basename\",\"sources\":\"$dep\",\"file_layer\":$file_layer,\"dep_layer\":$dep_layer,\"message\":\"Layer $file_layer cannot source Layer $dep_layer\"}")
            fi
        done
    done

    if [[ ${#violations[@]} -eq 0 ]]; then
        echo "[]"
    else
        printf '%s\n' "${violations[@]}" | jq -s '.'
    fi
}

check_circular_deps() {
    local lib_dir="${LIB_DIR:-}"

    if [[ ! -d "$lib_dir" ]]; then
        echo '{"check":"circular_deps","passed":false,"files_checked":0,"issues_found":1,"issues":[{"type":"error","message":"Library directory not found"}]}'
        return 0
    fi

    local file_count=0
    for f in "$lib_dir"/*.sh; do
        [[ -f "$f" ]] && ((file_count++))
    done

    # Build dependency graph
    declare -A dep_graph
    local graph_json="{"
    local first_file=1
    for file in "$lib_dir"/*.sh; do
        [[ ! -f "$file" ]] && continue
        local basename
        basename=$(basename "$file")
        dep_graph["$basename"]=$(_extract_dependencies "$file")

        local deps_arr="${dep_graph[$basename]}"
        local deps_json="["
        local first_dep=1
        for d in $deps_arr; do
            [[ $first_dep -eq 0 ]] && deps_json+=","
            deps_json+="\"$d\""
            first_dep=0
        done
        deps_json+="]"

        [[ $first_file -eq 0 ]] && graph_json+=","
        graph_json+="\"$basename\":$deps_json"
        first_file=0
    done
    graph_json+="}"

    # Check layer violations
    local layer_violations
    layer_violations=$(_check_layer_violations "$lib_dir")

    local issues_found=0
    local passed="true"
    if [[ "$layer_violations" != "[]" ]]; then
        passed="false"
        issues_found=$(echo "$layer_violations" | jq 'length')
    fi

    jq -n \
        --arg check "circular_deps" \
        --argjson passed "$passed" \
        --argjson files_checked "$file_count" \
        --argjson issues_found "$issues_found" \
        --argjson dependency_graph "$graph_json" \
        --argjson issues "$layer_violations" \
        '{check: $check, passed: $passed, files_checked: $files_checked, issues_found: $issues_found, dependency_graph: $dependency_graph, issues: $issues}'
}

# ============================================================================
# DEPENDENCY COUNT CHECKER (T831)
# ============================================================================

_get_file_layer() {
    local file_path="$1"
    local filename
    filename=$(basename "$file_path")

    local layer_line
    layer_line=$(grep -m1 "^# LAYER:" "$file_path" 2>/dev/null || true)
    if [[ -n "$layer_line" ]]; then
        local layer_num
        layer_num=$(echo "$layer_line" | grep -oE '[0-9]+' | head -1)
        [[ -n "$layer_num" && "$layer_num" =~ ^[0-3]$ ]] && echo "$layer_num" && return 0
    fi

    [[ -v "KNOWN_LAYERS[$filename]" ]] && echo "${KNOWN_LAYERS[$filename]}" && return 0
    echo "-1"
}

_get_layer_limit() {
    local layer="$1"
    [[ "$layer" == "-1" ]] && echo "3" && return 0
    [[ -v "LAYER_LIMITS[$layer]" ]] && echo "${LAYER_LIMITS[$layer]}" || echo "3"
}

_count_source_statements() {
    local file_path="$1"
    # Count only EAGER (top-level) source statements, not LAZY (inside functions)
    # EAGER: sourced at file load time (depth 0)
    # LAZY: sourced inside functions like _ensure_migrate_loaded() (depth > 0)
    local count
    count=$(awk '
        # Track function depth
        /^[a-zA-Z_][a-zA-Z0-9_]*[[:space:]]*\(\)[[:space:]]*\{/ { in_func++ }
        /^function[[:space:]]+[a-zA-Z_][a-zA-Z0-9_]*/ { in_func++ }
        /^\}[[:space:]]*$/ { if (in_func > 0) in_func-- }

        # Count source statements only at top-level (depth 0)
        # Skip comment lines and only match lib source patterns
        /^[[:space:]]*source[[:space:]]/ && !/^[[:space:]]*#/ && in_func == 0 {
            if ($0 ~ /\$[{_A-Za-z]*[A-Za-z_]+[^\/]*\/[a-z0-9_-]+\.sh/) {
                eager_count++
            }
        }

        END { print eager_count + 0 }
    ' "$file_path" 2>/dev/null)
    echo "${count:-0}"
}

check_dependency_count() {
    local lib_dir="${LIB_DIR:-}"
    local files_checked=0
    local total_dependencies=0
    local target_max=25
    local issues=()
    local file_counts=()
    local within_limit=0
    local exceeding_limit=0

    if [[ ! -d "$lib_dir" ]]; then
        jq -n '{"check":"dependency_count","passed":false,"files_checked":0,"issues_found":1,"issues":[{"issue":"Library directory not found"}]}'
        return 0
    fi

    for lib_file in "$lib_dir"/*.sh; do
        [[ -f "$lib_file" ]] || continue
        local filename
        filename=$(basename "$lib_file")
        files_checked=$((files_checked + 1))

        local layer
        layer=$(_get_file_layer "$lib_file")
        local max_allowed
        max_allowed=$(_get_layer_limit "$layer")

        local dep_count
        dep_count=$(_count_source_statements "$lib_file")
        dep_count="${dep_count:-0}"
        [[ ! "$dep_count" =~ ^[0-9]+$ ]] && dep_count=0

        total_dependencies=$((total_dependencies + dep_count))
        file_counts+=("\"$filename\": $dep_count")

        if [[ "$dep_count" -gt "$max_allowed" ]]; then
            exceeding_limit=$((exceeding_limit + 1))
            issues+=("{\"file\": \"$filename\", \"layer\": $layer, \"count\": $dep_count, \"max_allowed\": $max_allowed, \"message\": \"Layer $layer exceeds $max_allowed-dependency limit\"}")
        else
            within_limit=$((within_limit + 1))
        fi
    done

    local passed=true
    if [[ "$total_dependencies" -gt "$target_max" ]]; then
        passed=false
        issues+=("{\"file\": \"_total\", \"count\": $total_dependencies, \"max_allowed\": $target_max, \"message\": \"Total ($total_dependencies) exceeds target ($target_max)\"}")
    fi
    [[ "$exceeding_limit" -gt 0 ]] && passed=false

    local file_counts_json="{}"
    if [[ ${#file_counts[@]} -gt 0 ]]; then
        file_counts_json=$(printf '%s\n' "${file_counts[@]}" | paste -sd, | sed 's/^/{/; s/$/}/')
    fi

    local issues_json="[]"
    [[ ${#issues[@]} -gt 0 ]] && issues_json=$(printf '%s\n' "${issues[@]}" | jq -s '.')

    jq -n \
        --arg check "dependency_count" \
        --argjson passed "$passed" \
        --argjson files_checked "$files_checked" \
        --argjson issues_found "${#issues[@]}" \
        --argjson total_dependencies "$total_dependencies" \
        --argjson target_max "$target_max" \
        --argjson file_counts "$file_counts_json" \
        --argjson issues "$issues_json" \
        --argjson within_limit "$within_limit" \
        --argjson exceeding_limit "$exceeding_limit" \
        '{check: $check, passed: $passed, files_checked: $files_checked, issues_found: $issues_found, total_dependencies: $total_dependencies, target_max: $target_max, within_limit: $within_limit, exceeding_limit: $exceeding_limit, file_counts: $file_counts, issues: $issues}'
}

# ============================================================================
# RESULT AGGREGATION
# ============================================================================

aggregate_results() {
    local checks_json="$1"
    local files_checked issues_found checks_passed checks_failed

    files_checked=$(echo "$checks_json" | jq '[.[].files_checked] | add // 0')
    issues_found=$(echo "$checks_json" | jq '[.[].issues_found] | add // 0')
    checks_passed=$(echo "$checks_json" | jq '[.[] | select(.passed == true)] | length')
    checks_failed=$(echo "$checks_json" | jq '[.[] | select(.passed == false)] | length')

    jq -n \
        --argjson files_checked "$files_checked" \
        --argjson issues_found "$issues_found" \
        --argjson checks_passed "$checks_passed" \
        --argjson checks_failed "$checks_failed" \
        '{files_checked: $files_checked, issues_found: $issues_found, checks_passed: $checks_passed, checks_failed: $checks_failed}'
}

# ============================================================================
# OUTPUT FORMATTING
# ============================================================================

format_json_output() {
    local success="$1"
    local summary="$2"
    local checks="$3"
    local timestamp
    timestamp=$(dev_timestamp)

    jq -n \
        --arg cmd "$COMMAND_NAME" \
        --arg ts "$timestamp" \
        --arg ver "$TOOL_VERSION" \
        --argjson success "$success" \
        --argjson summary "$summary" \
        --argjson checks "$checks" \
        '{
            "_meta": {"command": $cmd, "timestamp": $ts, "version": $ver},
            "success": $success,
            "summary": $summary,
            "checks": {
                "source_guards": ($checks | map(select(.check == "source_guards")) | .[0] // null),
                "layer_headers": ($checks | map(select(.check == "layer_headers")) | .[0] // null),
                "circular_deps": ($checks | map(select(.check == "circular_deps")) | .[0] // null),
                "dependency_count": ($checks | map(select(.check == "dependency_count")) | .[0] // null)
            }
        }'
}

format_text_output() {
    local success="$1"
    local summary="$2"
    local checks="$3"

    echo ""
    echo -e "${BOLD:-}Library Architecture Compliance Check${NC:-}"
    echo "======================================"
    echo -e "Spec: ${CYAN:-}LIBRARY-ARCHITECTURE-SPEC.md${NC:-}"
    echo ""

    echo "$checks" | jq -r '.[] | "\(.check)|\(.passed)|\(.files_checked)|\(.issues_found)"' | while IFS='|' read -r check passed files issues; do
        local status_icon
        if [[ "$passed" == "true" ]]; then
            status_icon="${GREEN:-}[PASS]${NC:-}"
        else
            status_icon="${RED:-}[FAIL]${NC:-}"
        fi
        printf "%s %-20s (files: %s, issues: %s)\n" "$status_icon" "$check" "$files" "$issues"
    done

    echo ""
    echo -e "${BOLD:-}Summary${NC:-}"
    echo "-------"
    echo "$summary" | jq -r '"Files checked: \(.files_checked)\nIssues found: \(.issues_found)\nChecks passed: \(.checks_passed)\nChecks failed: \(.checks_failed)"'

    echo ""
    if [[ "$success" == "true" ]]; then
        echo -e "${GREEN:-}✓ All checks passed.${NC:-}"
    else
        echo -e "${RED:-}✗ Some checks failed.${NC:-}"
    fi
}

# ============================================================================
# MAIN EXECUTION
# ============================================================================

main() {
    parse_args "$@"

    # Resolve format (TTY-aware for LLM-Agent-First)
    FORMAT=$(dev_resolve_format "$FORMAT")

    # Verify lib directory exists
    if [[ ! -d "$LIB_DIR" ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            jq -n \
                --arg cmd "$COMMAND_NAME" \
                --arg ts "$(dev_timestamp)" \
                --arg ver "$TOOL_VERSION" \
                --arg msg "Library directory not found: $LIB_DIR" \
                '{"_meta": {"command": $cmd, "timestamp": $ts, "version": $ver}, "success": false, "error": {"code": "E_NOT_FOUND", "message": $msg}}'
        else
            log_error "Library directory not found: $LIB_DIR"
        fi
        exit $DEV_EXIT_NOT_FOUND
    fi

    # Fix mode placeholder
    if [[ "$FIX_MODE" == "true" ]]; then
        [[ "$FORMAT" == "text" ]] && log_info "Fix mode is not yet implemented. Running check-only mode."
    fi

    # Run selected checks
    local all_checks=()

    case "${SPECIFIC_CHECK:-all}" in
        guard)
            all_checks+=("$(check_source_guards)")
            ;;
        header)
            all_checks+=("$(check_layer_headers)")
            ;;
        circular)
            all_checks+=("$(check_circular_deps)")
            ;;
        count)
            all_checks+=("$(check_dependency_count)")
            ;;
        all|"")
            all_checks+=("$(check_source_guards)")
            all_checks+=("$(check_layer_headers)")
            all_checks+=("$(check_circular_deps)")
            all_checks+=("$(check_dependency_count)")
            ;;
    esac

    # Combine check results into JSON array
    local checks_json
    checks_json=$(printf '%s\n' "${all_checks[@]}" | jq -s '.')

    # Aggregate summary
    local summary
    summary=$(aggregate_results "$checks_json")

    # Determine overall success
    local success=true
    local checks_failed
    checks_failed=$(echo "$summary" | jq '.checks_failed')
    [[ "$checks_failed" -gt 0 ]] && success=false

    # Output results
    if [[ "$FORMAT" == "json" ]]; then
        format_json_output "$success" "$summary" "$checks_json"
    else
        format_text_output "$success" "$summary" "$checks_json"
    fi

    # Exit code
    if [[ "$success" == "true" ]]; then
        exit $DEV_EXIT_SUCCESS
    else
        exit $DEV_EXIT_COMPLIANCE_FAILED
    fi
}

main "$@"
