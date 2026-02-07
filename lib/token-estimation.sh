#!/usr/bin/env bash
# token-estimation.sh - Token Usage Estimation and Tracking
#
# LAYER: 2 (Services - depends on Layer 1)
# DEPENDENCIES: exit-codes.sh
# PROVIDES:
#   estimate_tokens        - Estimate token count from text
#   track_file_read        - Log file read with token estimate
#   track_manifest_read    - Log manifest query with token estimate
#   track_skill_injection  - Log skill injection with token estimate
#   log_token_event        - Core event logging
#   get_token_summary      - Summarize token usage for a session/task
#   compare_token_usage    - Compare manifest vs full file usage
#   te_status              - Get tracking enabled/disabled status
#
# This library estimates token consumption since Claude Code doesn't expose
# actual token counts. Uses rough heuristic: 1 token ≈ 4 characters.
#
# ENVIRONMENT:
#   CLEO_TRACK_TOKENS - Set to 0 to disable tracking, 1 to enable (default: 1)
#
# @task T2833, T2898
# @epic T2724, T2897
# @why CLEO needs to prove it saves tokens - this enables measurement
# @what Token estimation and tracking for value proof metrics

#=== SOURCE GUARD ================================================
[[ -n "${_TOKEN_ESTIMATION_LOADED:-}" ]] && return 0
declare -r _TOKEN_ESTIMATION_LOADED=1

set -euo pipefail

# Determine library directory
_TE_LIB_DIR="${BASH_SOURCE[0]%/*}"
[[ "$_TE_LIB_DIR" == "${BASH_SOURCE[0]}" ]] && _TE_LIB_DIR="."

# Source dependencies
# shellcheck source=lib/exit-codes.sh
source "${_TE_LIB_DIR}/exit-codes.sh"

# Source file-ops for atomic_jsonl_append (T3148)
# shellcheck source=lib/file-ops.sh
source "${_TE_LIB_DIR}/file-ops.sh"

# Metrics file path
_TE_TOKEN_FILE="${TOKEN_METRICS_PATH:-.cleo/metrics/TOKEN_USAGE.jsonl}"

# Session tracking
declare -g _TE_SESSION_ID=""
declare -g _TE_SESSION_START=""
declare -gA _TE_SESSION_TOKENS=()

# ============================================================================
# INTERNAL HELPERS
# ============================================================================

# Check if token tracking is enabled via CLEO_TRACK_TOKENS environment variable
# Returns: 0 (true) if enabled, 1 (false) if disabled
# Default: enabled (CLEO_TRACK_TOKENS=1)
_te_tracking_enabled() {
    [[ "${CLEO_TRACK_TOKENS:-1}" == "1" ]]
}

_te_debug() {
    [[ -n "${TOKEN_ESTIMATION_DEBUG:-}" ]] && echo "[token-estimation] DEBUG: $1" >&2
    return 0
}

_te_ensure_metrics_dir() {
    local dir
    dir=$(dirname "$_TE_TOKEN_FILE")
    mkdir -p "$dir" 2>/dev/null || true
}

# ============================================================================
# CORE ESTIMATION FUNCTIONS
# ============================================================================

# estimate_tokens - Estimate token count from text
# Args: $1 = text content (or file path with -f flag)
#       $2 = optional: "-f" to treat $1 as file path
# Returns: Estimated token count
# Note: Uses heuristic of ~4 characters per token (varies by content type)
estimate_tokens() {
    local input="$1"
    local flag="${2:-}"

    local text=""
    if [[ "$flag" == "-f" && -f "$input" ]]; then
        text=$(cat "$input" 2>/dev/null)
    else
        text="$input"
    fi

    local chars=${#text}
    # Rough heuristic: 1 token ≈ 4 characters for English text
    # Code tends to be ~3.5 chars/token, prose ~4.5
    echo $(( (chars + 3) / 4 ))  # Round up
}

# estimate_tokens_from_file - Estimate tokens for a file
# Args: $1 = file path
# Returns: Estimated token count, or 0 if file doesn't exist
estimate_tokens_from_file() {
    local file_path="$1"

    if [[ ! -f "$file_path" ]]; then
        echo "0"
        return 0
    fi

    local size
    size=$(wc -c < "$file_path" 2>/dev/null || echo 0)
    echo $(( (size + 3) / 4 ))
}

# ============================================================================
# EVENT LOGGING
# ============================================================================

# log_token_event - Log a token usage event
# Args: $1 = event_type (manifest_read|full_file_read|skill_inject|prompt_build)
#       $2 = estimated_tokens
#       $3 = source (file path or description)
#       $4 = optional: task_id
#       $5 = optional: additional context JSON
# Env: CLEO_TRACK_TOKENS - Set to 0 to disable tracking (default: 1)
# @task T3151
# @epic T3147
log_token_event() {
    # Early return if tracking disabled - zero overhead
    _te_tracking_enabled || return 0

    local event_type="$1"
    local tokens="$2"
    local source="$3"
    local task_id="${4:-}"
    local context="${5:-"{}"}"

    _te_ensure_metrics_dir

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Build entry
    local entry
    entry=$(jq -nc \
        --arg ts "$timestamp" \
        --arg event "$event_type" \
        --argjson tokens "$tokens" \
        --arg source "$source" \
        --arg task_id "$task_id" \
        --arg session_id "${_TE_SESSION_ID:-}" \
        --argjson ctx "$context" \
        '{
            timestamp: $ts,
            event_type: $event,
            estimated_tokens: $tokens,
            source: $source,
            task_id: (if $task_id == "" then null else $task_id end),
            session_id: (if $session_id == "" then null else $session_id end),
            context: $ctx
        }')

    # Use atomic JSONL append (T3148) - failures are now visible
    # Note: We don't fail the parent operation if token tracking fails,
    # but we do log the error instead of silently suppressing it
    if ! atomic_jsonl_append "$_TE_TOKEN_FILE" "$entry"; then
        _te_debug "WARNING: Failed to log token event to $_TE_TOKEN_FILE"
    fi

    # Update session totals if tracking
    if [[ -n "$_TE_SESSION_ID" ]]; then
        local current="${_TE_SESSION_TOKENS[$event_type]:-0}"
        _TE_SESSION_TOKENS[$event_type]=$((current + tokens))
    fi

    _te_debug "Logged $event_type: $tokens tokens from $source"
}

# ============================================================================
# TRACKING HELPERS
# ============================================================================

# track_file_read - Log a file read with token estimate
# Args: $1 = file_path
#       $2 = purpose (manifest|full_file|skill|protocol)
#       $3 = optional: task_id
# Env: CLEO_TRACK_TOKENS - Set to 0 to disable tracking (default: 1)
track_file_read() {
    # Early return if tracking disabled - zero overhead
    _te_tracking_enabled || return 0

    local file_path="$1"
    local purpose="$2"
    local task_id="${3:-}"

    local tokens
    tokens=$(estimate_tokens_from_file "$file_path")

    local event_type
    case "$purpose" in
        manifest) event_type="manifest_read" ;;
        full_file|full) event_type="full_file_read" ;;
        skill) event_type="skill_inject" ;;
        protocol) event_type="protocol_inject" ;;
        *) event_type="file_read" ;;
    esac

    log_token_event "$event_type" "$tokens" "$file_path" "$task_id"
    echo "$tokens"
}

# track_manifest_query - Log a manifest query (partial read)
# Args: $1 = query_type (find|show|list)
#       $2 = result_count
#       $3 = optional: task_id
# Env: CLEO_TRACK_TOKENS - Set to 0 to disable tracking (default: 1)
track_manifest_query() {
    # Early return if tracking disabled - zero overhead
    _te_tracking_enabled || return 0

    local query_type="$1"
    local result_count="$2"
    local task_id="${3:-}"

    # Estimate: each manifest entry is ~200 tokens
    local tokens=$((result_count * 200))

    log_token_event "manifest_query" "$tokens" "MANIFEST.jsonl:$query_type" "$task_id" \
        "{\"query_type\":\"$query_type\",\"result_count\":$result_count}"

    echo "$tokens"
}

# track_skill_injection - Log skill injection with tokens
# Args: $1 = skill_name
#       $2 = skill_tier
#       $3 = tokens (pre-calculated)
#       $4 = optional: task_id
# Env: CLEO_TRACK_TOKENS - Set to 0 to disable tracking (default: 1)
track_skill_injection() {
    # Early return if tracking disabled - zero overhead
    _te_tracking_enabled || return 0

    local skill_name="$1"
    local tier="$2"
    local tokens="$3"
    local task_id="${4:-}"

    log_token_event "skill_inject" "$tokens" "skills/$skill_name" "$task_id" \
        "{\"skill\":\"$skill_name\",\"tier\":$tier}"
}

# track_prompt_build - Log final prompt size
# Args: $1 = prompt_text
#       $2 = task_id
#       $3 = skills_used (comma-separated)
# Env: CLEO_TRACK_TOKENS - Set to 0 to disable tracking (default: 1)
track_prompt_build() {
    # Early return if tracking disabled - zero overhead
    _te_tracking_enabled || return 0

    local prompt="$1"
    local task_id="$2"
    local skills_used="$3"

    local tokens
    tokens=$(estimate_tokens "$prompt")

    log_token_event "prompt_build" "$tokens" "spawn_prompt" "$task_id" \
        "{\"skills\":\"$skills_used\"}"

    echo "$tokens"
}

# track_spawn_output - Log subagent output tokens after completion
# Args: $1 = task_id
#       $2 = output_text (from manifest, file, or return message)
#       $3 = optional: session_id
# Env: CLEO_TRACK_TOKENS - Set to 0 to disable tracking (default: 1)
# @task T2903
# @epic T2897
track_spawn_output() {
    # Early return if tracking disabled - zero overhead
    _te_tracking_enabled || return 0

    local task_id="$1"
    local output_text="$2"
    local session_id="${3:-}"

    local tokens
    tokens=$(estimate_tokens "$output_text")

    log_token_event "spawn_output" "$tokens" "subagent_response" "$task_id" \
        "{\"session_id\":\"$session_id\"}"

    echo "$tokens"
}

# track_spawn_complete - Log complete spawn cycle (prompt + output)
# Args: $1 = task_id
#       $2 = prompt_tokens (from track_prompt_build)
#       $3 = output_tokens (from track_spawn_output)
#       $4 = optional: session_id
# Env: CLEO_TRACK_TOKENS - Set to 0 to disable tracking (default: 1)
# @task T2903
# @epic T2897
track_spawn_complete() {
    # Early return if tracking disabled - zero overhead
    _te_tracking_enabled || return 0

    local task_id="$1"
    local prompt_tokens="$2"
    local output_tokens="$3"
    local session_id="${4:-}"

    local total_tokens=$((prompt_tokens + output_tokens))

    # Calculate savings vs full file approach
    # Baseline: Reading full files instead of manifest would be ~10x more tokens
    local baseline_tokens=$((total_tokens * 10))
    local saved_tokens=$((baseline_tokens - total_tokens))
    local savings_percent=0
    [[ $baseline_tokens -gt 0 ]] && savings_percent=$(( (saved_tokens * 100) / baseline_tokens ))

    log_token_event "spawn_complete" "$total_tokens" "spawn_cycle" "$task_id" \
        "{\"prompt_tokens\":$prompt_tokens,\"output_tokens\":$output_tokens,\"total_tokens\":$total_tokens,\"baseline_tokens\":$baseline_tokens,\"saved_tokens\":$saved_tokens,\"savings_percent\":$savings_percent,\"session_id\":\"$session_id\"}"

    echo "$total_tokens"
}

# ============================================================================
# SESSION TRACKING
# ============================================================================

# start_token_session - Begin tracking tokens for a session
# Args: $1 = session_id
start_token_session() {
    local session_id="$1"

    _TE_SESSION_ID="$session_id"
    _TE_SESSION_START=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    _TE_SESSION_TOKENS=()

    log_token_event "session_start" "0" "session" "" \
        "{\"session_id\":\"$session_id\"}"

    _te_debug "Started token session: $session_id"
}

# end_token_session - End token tracking session with summary
# Returns: JSON summary of token usage
end_token_session() {
    if [[ -z "$_TE_SESSION_ID" ]]; then
        echo '{"error":"No active session"}'
        return 1
    fi

    local manifest_tokens="${_TE_SESSION_TOKENS[manifest_read]:-0}"
    local full_file_tokens="${_TE_SESSION_TOKENS[full_file_read]:-0}"
    local skill_tokens="${_TE_SESSION_TOKENS[skill_inject]:-0}"
    local prompt_tokens="${_TE_SESSION_TOKENS[prompt_build]:-0}"

    local total=$((manifest_tokens + full_file_tokens + skill_tokens + prompt_tokens))

    # Calculate savings: if we had read full files instead of manifest
    # Assume each manifest read could have been a full file read (10x larger)
    local avoided_tokens=$((manifest_tokens * 9))  # 10x - 1x already counted
    local savings_percent=0
    if [[ $total -gt 0 ]]; then
        savings_percent=$(( (avoided_tokens * 100) / (total + avoided_tokens) ))
    fi

    local summary
    summary=$(jq -nc \
        --arg session_id "$_TE_SESSION_ID" \
        --arg start "$_TE_SESSION_START" \
        --arg end "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --argjson manifest "$manifest_tokens" \
        --argjson full_file "$full_file_tokens" \
        --argjson skill "$skill_tokens" \
        --argjson prompt "$prompt_tokens" \
        --argjson total "$total" \
        --argjson avoided "$avoided_tokens" \
        --argjson savings "$savings_percent" \
        '{
            session_id: $session_id,
            start: $start,
            end: $end,
            tokens: {
                manifest_reads: $manifest,
                full_file_reads: $full_file,
                skill_injections: $skill,
                prompt_builds: $prompt,
                total: $total
            },
            savings: {
                avoided_tokens: $avoided,
                savings_percent: $savings
            }
        }')

    log_token_event "session_end" "$total" "session" "" "$summary"

    # Clear session
    _TE_SESSION_ID=""
    _TE_SESSION_START=""
    _TE_SESSION_TOKENS=()

    echo "$summary"
}

# ============================================================================
# REPORTING
# ============================================================================

# get_token_summary - Get token usage summary for a time period
# Args: $1 = days (default: 7)
# Returns: JSON summary
get_token_summary() {
    local days="${1:-7}"

    if [[ ! -f "$_TE_TOKEN_FILE" ]]; then
        echo '{"error":"No token data","manifest_tokens":0,"full_file_tokens":0,"savings_percent":0}'
        return 0
    fi

    # Calculate date threshold
    local threshold
    threshold=$(date -u -d "$days days ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
                date -u -v-${days}d +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
                echo "1970-01-01T00:00:00Z")

    # Aggregate by event type
    local manifest_tokens=0
    local full_file_tokens=0
    local skill_tokens=0
    local prompt_tokens=0

    while IFS= read -r line; do
        local ts event tokens
        ts=$(echo "$line" | jq -r '.timestamp // ""')
        event=$(echo "$line" | jq -r '.event_type // ""')
        tokens=$(echo "$line" | jq -r '.estimated_tokens // 0')

        # Simple date comparison (works for ISO format)
        [[ "$ts" < "$threshold" ]] && continue

        case "$event" in
            manifest_read|manifest_query) manifest_tokens=$((manifest_tokens + tokens)) ;;
            full_file_read) full_file_tokens=$((full_file_tokens + tokens)) ;;
            skill_inject) skill_tokens=$((skill_tokens + tokens)) ;;
            prompt_build) prompt_tokens=$((prompt_tokens + tokens)) ;;
        esac
    done < "$_TE_TOKEN_FILE"

    local total=$((manifest_tokens + full_file_tokens + skill_tokens + prompt_tokens))
    local avoided=$((manifest_tokens * 9))
    local savings=0
    [[ $total -gt 0 ]] && savings=$(( (avoided * 100) / (total + avoided) ))

    jq -nc \
        --argjson days "$days" \
        --argjson manifest "$manifest_tokens" \
        --argjson full_file "$full_file_tokens" \
        --argjson skill "$skill_tokens" \
        --argjson prompt "$prompt_tokens" \
        --argjson total "$total" \
        --argjson avoided "$avoided" \
        --argjson savings "$savings" \
        '{
            period_days: $days,
            tokens: {
                manifest_reads: $manifest,
                full_file_reads: $full_file,
                skill_injections: $skill,
                prompt_builds: $prompt,
                total: $total
            },
            savings: {
                avoided_tokens: $avoided,
                savings_percent: $savings,
                message: ("Using manifest saves ~" + ($savings | tostring) + "% context compared to full files")
            }
        }'
}

# compare_manifest_vs_full - Compare token usage strategies
# Args: $1 = manifest_entry_count (how many entries we read via manifest)
# Returns: Comparison JSON
compare_manifest_vs_full() {
    local manifest_entries="${1:-0}"

    # Average manifest entry: ~200 tokens
    # Average full output file: ~2000 tokens
    local manifest_tokens=$((manifest_entries * 200))
    local full_file_tokens=$((manifest_entries * 2000))
    local savings=$((full_file_tokens - manifest_tokens))
    local savings_percent=0
    [[ $full_file_tokens -gt 0 ]] && savings_percent=$(( (savings * 100) / full_file_tokens ))

    jq -nc \
        --argjson entries "$manifest_entries" \
        --argjson manifest "$manifest_tokens" \
        --argjson full "$full_file_tokens" \
        --argjson savings "$savings" \
        --argjson percent "$savings_percent" \
        '{
            manifest_entries_read: $entries,
            manifest_tokens: $manifest,
            full_file_equivalent: $full,
            tokens_saved: $savings,
            savings_percent: $percent,
            verdict: (if $percent >= 80 then "Excellent" elif $percent >= 50 then "Good" else "Moderate" end)
        }'
}

# te_status - Get tracking status
# Returns: JSON with tracking enabled status and environment variable value
te_status() {
    if _te_tracking_enabled; then
        echo '{"tracking_enabled":true,"env_var":"'"${CLEO_TRACK_TOKENS:-1}"'"}'
    else
        echo '{"tracking_enabled":false,"env_var":"'"${CLEO_TRACK_TOKENS:-1}"'"}'
    fi
}

# ============================================================================
# REAL TOKEN CAPTURE (from Claude Code transcripts)
# ============================================================================

# get_real_token_usage - Extract real API token data from Claude Code transcripts
# Args: $1 = session_id (optional, to filter to specific session)
#       $2 = since (optional, ISO timestamp to filter from)
# Returns: JSON with real token counts
# @task T2949
# @epic T2724
get_real_token_usage() {
    local session_id="${1:-}"
    local since="${2:-}"
    local project_dir

    # Find Claude Code project directory for current project
    local project_name
    project_name=$(basename "$PWD")
    project_dir=$(find ~/.claude/projects -maxdepth 1 -type d -name "*${project_name}*" 2>/dev/null | head -1)

    if [[ -z "$project_dir" ]]; then
        echo '{"error":"No Claude Code project found","input_tokens":0,"output_tokens":0,"cache_read_tokens":0,"cache_creation_tokens":0,"total":0,"source":"none"}'
        return 1
    fi

    # Aggregate tokens from transcript files
    local total_input=0
    local total_output=0
    local total_cache_read=0
    local total_cache_creation=0
    local message_count=0

    # Process each transcript file
    for f in "$project_dir"/*.jsonl; do
        [[ -f "$f" ]] || continue

        # Use Python for robust JSON parsing (handles large files better than jq)
        local file_stats
        file_stats=$(python3 -c "
import json
import sys

total_in = 0
total_out = 0
total_cache_read = 0
total_cache_create = 0
msg_count = 0

session_filter = '$session_id'
since_filter = '$since'

try:
    with open('$f', 'r') as fh:
        for line in fh:
            try:
                entry = json.loads(line)

                # Filter by session if provided
                if session_filter and entry.get('sessionId') != session_filter:
                    continue

                # Filter by timestamp if provided
                if since_filter and entry.get('timestamp', '') < since_filter:
                    continue

                # Extract usage from message field
                usage = entry.get('message', {}).get('usage')
                if usage:
                    total_in += usage.get('input_tokens', 0)
                    total_out += usage.get('output_tokens', 0)
                    total_cache_read += usage.get('cache_read_input_tokens', 0)
                    total_cache_create += usage.get('cache_creation_input_tokens', 0)
                    msg_count += 1
            except json.JSONDecodeError:
                continue

    print(json.dumps({
        'input': total_in,
        'output': total_out,
        'cache_read': total_cache_read,
        'cache_creation': total_cache_create,
        'messages': msg_count
    }))
except Exception as e:
    print(json.dumps({'input': 0, 'output': 0, 'cache_read': 0, 'cache_creation': 0, 'messages': 0}))
" 2>/dev/null)

        # Aggregate file stats
        if [[ -n "$file_stats" ]]; then
            total_input=$((total_input + $(echo "$file_stats" | jq -r '.input // 0')))
            total_output=$((total_output + $(echo "$file_stats" | jq -r '.output // 0')))
            total_cache_read=$((total_cache_read + $(echo "$file_stats" | jq -r '.cache_read // 0')))
            total_cache_creation=$((total_cache_creation + $(echo "$file_stats" | jq -r '.cache_creation // 0')))
            message_count=$((message_count + $(echo "$file_stats" | jq -r '.messages // 0')))
        fi
    done

    local total=$((total_input + total_output + total_cache_read))

    jq -nc \
        --argjson input "$total_input" \
        --argjson output "$total_output" \
        --argjson cache_read "$total_cache_read" \
        --argjson cache_creation "$total_cache_creation" \
        --argjson total "$total" \
        --argjson messages "$message_count" \
        --arg project_dir "$project_dir" \
        '{
            input_tokens: $input,
            output_tokens: $output,
            cache_read_tokens: $cache_read,
            cache_creation_tokens: $cache_creation,
            total: $total,
            messages: $messages,
            source: "claude_api",
            project_dir: $project_dir
        }'
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f estimate_tokens
export -f estimate_tokens_from_file
export -f log_token_event
export -f track_file_read
export -f track_manifest_query
export -f track_skill_injection
export -f track_prompt_build
export -f track_spawn_output
export -f track_spawn_complete
export -f start_token_session
export -f end_token_session
export -f get_token_summary
export -f compare_manifest_vs_full
export -f te_status
export -f get_real_token_usage
