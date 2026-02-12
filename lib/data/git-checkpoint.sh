#!/usr/bin/env bash
# git-checkpoint.sh - Automatic git checkpointing for CLEO state files
#
# LAYER: 2 (Data Layer)
# DEPENDENCIES: config.sh (optional, for get_config_value)
# PROVIDES: git_checkpoint, should_checkpoint, git_checkpoint_status
#
# Design: Opt-in automatic git commits of .cleo/ state files at semantic
# boundaries (save_json, session end) with debounce to prevent commit noise.
# All git errors are suppressed - checkpointing is never fatal.
#
# Suppression: Set GIT_CHECKPOINT_SUPPRESS=true to disable checkpointing
# for the current process. Used by multi-step atomic flows (e.g., release ship)
# to prevent partial state commits during a coordinated sequence.
# The env var is per-process and does not persist across sessions.
#
# @task T3147

#=== SOURCE GUARD ================================================
[[ -n "${_GIT_CHECKPOINT_LOADED:-}" ]] && return 0
declare -r _GIT_CHECKPOINT_LOADED=1

# ============================================================================
# CONSTANTS
# ============================================================================

# State files eligible for checkpointing (relative to .cleo/)
# Core data files (task state, session history, audit log)
# Metrics files (compliance, token usage, session analytics)
# Sequence counter (ID generation state)
_GIT_CHECKPOINT_STATE_FILES=(
    "todo.json"
    "todo-log.json"
    "sessions.json"
    "todo-archive.json"
    "config.json"
    ".sequence"
    "metrics/COMPLIANCE.jsonl"
    "metrics/SESSIONS.jsonl"
    "metrics/TOKEN_USAGE.jsonl"
    "metrics/BENCHMARK.jsonl"
)

# Debounce state file location (relative to .cleo/)
_GIT_CHECKPOINT_STATE_FILE=".git-checkpoint-state"

# ============================================================================
# INTERNAL HELPERS
# ============================================================================

#######################################
# Load checkpoint configuration from config.json
# Outputs:
#   Sets global variables: _GC_ENABLED, _GC_DEBOUNCE_MINUTES,
#   _GC_MESSAGE_PREFIX, _GC_NO_VERIFY
# Returns:
#   0 always
#######################################
_load_checkpoint_config() {
    if declare -f get_config_value >/dev/null 2>&1; then
        _GC_ENABLED=$(get_config_value "gitCheckpoint.enabled" "true")
        _GC_DEBOUNCE_MINUTES=$(get_config_value "gitCheckpoint.debounceMinutes" "5")
        _GC_MESSAGE_PREFIX=$(get_config_value "gitCheckpoint.messagePrefix" "chore(cleo):")
        _GC_NO_VERIFY=$(get_config_value "gitCheckpoint.noVerify" "true")
    else
        _GC_ENABLED="true"
        _GC_DEBOUNCE_MINUTES="5"
        _GC_MESSAGE_PREFIX="chore(cleo):"
        _GC_NO_VERIFY="true"
    fi
    return 0
}

#######################################
# Get the .cleo/ directory path
# Outputs:
#   .cleo directory path to stdout
# Returns:
#   0 if found, 1 if not
#######################################
_get_cleo_dir() {
    local cleo_dir="${CLEO_DIR:-.cleo}"
    if [[ -d "$cleo_dir" ]]; then
        echo "$cleo_dir"
        return 0
    fi
    return 1
}

#######################################
# Record the current epoch time as last checkpoint time
# Arguments:
#   $1 - .cleo directory path
# Returns:
#   0 always (errors suppressed)
#######################################
_record_checkpoint_time() {
    local cleo_dir="$1"
    local state_file="$cleo_dir/$_GIT_CHECKPOINT_STATE_FILE"
    date +%s > "$state_file" 2>/dev/null || true
    return 0
}

#######################################
# Get the epoch time of the last checkpoint
# Arguments:
#   $1 - .cleo directory path
# Outputs:
#   Epoch seconds to stdout, or "0" if no checkpoint recorded
# Returns:
#   0 always
#######################################
_get_last_checkpoint_time() {
    local cleo_dir="$1"
    local state_file="$cleo_dir/$_GIT_CHECKPOINT_STATE_FILE"
    if [[ -f "$state_file" ]]; then
        cat "$state_file" 2>/dev/null || echo "0"
    else
        echo "0"
    fi
    return 0
}

# ============================================================================
# PUBLIC API
# ============================================================================

#######################################
# Check whether a checkpoint should be performed
# Evaluates: enabled, git repo, debounce elapsed, files changed
# Arguments:
#   $1 - force (optional, "true" to bypass debounce)
# Returns:
#   0 if checkpoint should proceed, 1 if not
#######################################
should_checkpoint() {
    local force="${1:-false}"

    # Suppression check (even force doesn't override explicit suppression)
    # @task T4247
    if [[ "${GIT_CHECKPOINT_SUPPRESS:-}" == "true" ]]; then
        return 1
    fi

    # Load config
    _load_checkpoint_config

    # Check if enabled
    if [[ "$_GC_ENABLED" != "true" ]]; then
        return 1
    fi

    # Check if we're in a git repo
    if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        return 1
    fi

    # Check for merge in progress
    local git_dir
    git_dir=$(git rev-parse --git-dir 2>/dev/null) || return 1
    if [[ -f "$git_dir/MERGE_HEAD" ]]; then
        return 1
    fi

    # Check for detached HEAD
    if ! git symbolic-ref HEAD >/dev/null 2>&1; then
        return 1
    fi

    # Check for rebase in progress
    if [[ -d "$git_dir/rebase-merge" ]] || [[ -d "$git_dir/rebase-apply" ]]; then
        return 1
    fi

    # Get .cleo directory
    local cleo_dir
    if ! cleo_dir=$(_get_cleo_dir); then
        return 1
    fi

    # Check debounce (unless forced)
    if [[ "$force" != "true" ]]; then
        local last_checkpoint
        last_checkpoint=$(_get_last_checkpoint_time "$cleo_dir")
        local now
        now=$(date +%s)
        local elapsed=$(( now - last_checkpoint ))
        local debounce_seconds=$(( _GC_DEBOUNCE_MINUTES * 60 ))

        if [[ $elapsed -lt $debounce_seconds ]]; then
            return 1
        fi
    fi

    # Check if any state files have changes (staged or unstaged)
    local has_changes=false
    for state_file in "${_GIT_CHECKPOINT_STATE_FILES[@]}"; do
        local full_path="$cleo_dir/$state_file"
        if [[ -f "$full_path" ]]; then
            if ! git diff --quiet -- "$full_path" 2>/dev/null || \
               ! git diff --cached --quiet -- "$full_path" 2>/dev/null || \
               git ls-files --others --exclude-standard -- "$full_path" 2>/dev/null | grep -q .; then
                has_changes=true
                break
            fi
        fi
    done

    if [[ "$has_changes" != "true" ]]; then
        return 1
    fi

    return 0
}

#######################################
# Stage .cleo/ state files and commit if conditions met
# Arguments:
#   $1 - trigger (e.g., "auto", "session-end", "manual")
#   $2 - context message (optional extra detail)
# Returns:
#   0 always (never fatal - all git errors suppressed)
#######################################
git_checkpoint() {
    local trigger="${1:-auto}"
    local context="${2:-}"

    # Checkpoint suppression: skip during multi-step atomic flows (e.g., release ship)
    # @task T4247
    if [[ "${GIT_CHECKPOINT_SUPPRESS:-}" == "true" ]]; then
        return 0
    fi

    local force="false"
    [[ "$trigger" == "manual" ]] && force="true"

    # Check all preconditions
    if ! should_checkpoint "$force"; then
        return 0
    fi

    # Load config (may already be loaded by should_checkpoint, but safe to reload)
    _load_checkpoint_config

    local cleo_dir
    cleo_dir=$(_get_cleo_dir) || return 0

    # Stage only the tracked state files that have changes
    local staged_count=0
    for state_file in "${_GIT_CHECKPOINT_STATE_FILES[@]}"; do
        local full_path="$cleo_dir/$state_file"
        if [[ -f "$full_path" ]]; then
            if ! git diff --quiet -- "$full_path" 2>/dev/null || \
               ! git diff --cached --quiet -- "$full_path" 2>/dev/null || \
               git ls-files --others --exclude-standard -- "$full_path" 2>/dev/null | grep -q .; then
                git add "$full_path" 2>/dev/null || continue
                ((staged_count++)) || true
            fi
        fi
    done

    # Nothing to commit
    if [[ $staged_count -eq 0 ]]; then
        return 0
    fi

    # Build commit message
    local commit_msg="${_GC_MESSAGE_PREFIX} ${trigger} checkpoint"
    if [[ -n "$context" ]]; then
        commit_msg="${_GC_MESSAGE_PREFIX} ${trigger} checkpoint (${context})"
    fi

    # Build commit command
    local -a commit_args=("commit" "-m" "$commit_msg")
    if [[ "$_GC_NO_VERIFY" == "true" ]]; then
        commit_args+=("--no-verify")
    fi

    # Commit (suppress all output)
    git "${commit_args[@]}" >/dev/null 2>&1 || {
        # If commit failed, unstage our changes to avoid leaving dirty index
        for state_file in "${_GIT_CHECKPOINT_STATE_FILES[@]}"; do
            local full_path="$cleo_dir/$state_file"
            git reset HEAD -- "$full_path" >/dev/null 2>&1 || true
        done
        return 0
    }

    # Record checkpoint time
    _record_checkpoint_time "$cleo_dir"

    return 0
}

#######################################
# Show checkpoint configuration and status
# Arguments:
#   $1 - format ("json" or "text", default "json")
# Outputs:
#   Status information to stdout
# Returns:
#   0 always
#######################################
git_checkpoint_status() {
    local format="${1:-json}"

    _load_checkpoint_config

    local cleo_dir
    cleo_dir=$(_get_cleo_dir 2>/dev/null) || cleo_dir=".cleo"

    local last_checkpoint
    last_checkpoint=$(_get_last_checkpoint_time "$cleo_dir")

    local last_checkpoint_iso="never"
    if [[ "$last_checkpoint" != "0" ]]; then
        last_checkpoint_iso=$(date -d "@$last_checkpoint" -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
                             date -r "$last_checkpoint" -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
                             echo "unknown")
    fi

    local is_git_repo="false"
    git rev-parse --is-inside-work-tree >/dev/null 2>&1 && is_git_repo="true"

    # Count pending changes
    local pending_changes=0
    if [[ "$is_git_repo" == "true" ]]; then
        for state_file in "${_GIT_CHECKPOINT_STATE_FILES[@]}"; do
            local full_path="$cleo_dir/$state_file"
            if [[ -f "$full_path" ]]; then
                if ! git diff --quiet -- "$full_path" 2>/dev/null || \
                   ! git diff --cached --quiet -- "$full_path" 2>/dev/null || \
                   git ls-files --others --exclude-standard -- "$full_path" 2>/dev/null | grep -q .; then
                    ((pending_changes++)) || true
                fi
            fi
        done
    fi

    # Check suppression state
    # @task T4247
    local suppressed="false"
    if [[ "${GIT_CHECKPOINT_SUPPRESS:-}" == "true" ]]; then
        suppressed="true"
    fi

    if [[ "$format" == "json" ]]; then
        jq -n \
            --argjson enabled "$([[ "$_GC_ENABLED" == "true" ]] && echo "true" || echo "false")" \
            --argjson debounceMinutes "$_GC_DEBOUNCE_MINUTES" \
            --arg messagePrefix "$_GC_MESSAGE_PREFIX" \
            --argjson noVerify "$([[ "$_GC_NO_VERIFY" == "true" ]] && echo "true" || echo "false")" \
            --argjson isGitRepo "$([[ "$is_git_repo" == "true" ]] && echo "true" || echo "false")" \
            --arg lastCheckpoint "$last_checkpoint_iso" \
            --argjson lastCheckpointEpoch "$last_checkpoint" \
            --argjson pendingChanges "$pending_changes" \
            --argjson suppressed "$([[ "$suppressed" == "true" ]] && echo "true" || echo "false")" \
            '{
                success: true,
                config: {
                    enabled: $enabled,
                    debounceMinutes: $debounceMinutes,
                    messagePrefix: $messagePrefix,
                    noVerify: $noVerify
                },
                status: {
                    isGitRepo: $isGitRepo,
                    lastCheckpoint: $lastCheckpoint,
                    lastCheckpointEpoch: $lastCheckpointEpoch,
                    pendingChanges: $pendingChanges,
                    suppressed: $suppressed
                }
            }'
    else
        echo "Git Checkpoint Status"
        echo "====================="
        echo "Enabled:          $_GC_ENABLED"
        echo "Suppressed:       $suppressed"
        echo "Debounce:         ${_GC_DEBOUNCE_MINUTES} minutes"
        echo "Message prefix:   $_GC_MESSAGE_PREFIX"
        echo "No-verify:        $_GC_NO_VERIFY"
        echo "Git repo:         $is_git_repo"
        echo "Last checkpoint:  $last_checkpoint_iso"
        echo "Pending changes:  $pending_changes"
    fi

    return 0
}

#######################################
# Show what files would be committed (dry-run)
# Outputs:
#   List of changed state files to stdout
# Returns:
#   0 always
#######################################
git_checkpoint_dry_run() {
    local cleo_dir
    cleo_dir=$(_get_cleo_dir 2>/dev/null) || cleo_dir=".cleo"

    local is_git_repo="false"
    git rev-parse --is-inside-work-tree >/dev/null 2>&1 && is_git_repo="true"

    local changed_files=()
    if [[ "$is_git_repo" == "true" ]]; then
        for state_file in "${_GIT_CHECKPOINT_STATE_FILES[@]}"; do
            local full_path="$cleo_dir/$state_file"
            if [[ -f "$full_path" ]]; then
                if ! git diff --quiet -- "$full_path" 2>/dev/null || \
                   ! git diff --cached --quiet -- "$full_path" 2>/dev/null; then
                    changed_files+=("$full_path (modified)")
                elif git ls-files --others --exclude-standard -- "$full_path" 2>/dev/null | grep -q .; then
                    changed_files+=("$full_path (untracked)")
                fi
            fi
        done
    fi

    if [[ ${#changed_files[@]} -eq 0 ]]; then
        echo "No state files have pending changes."
    else
        echo "Files that would be committed:"
        for f in "${changed_files[@]}"; do
            echo "  $f"
        done
    fi

    return 0
}

# Export functions
export -f git_checkpoint
export -f should_checkpoint
export -f git_checkpoint_status
export -f git_checkpoint_dry_run
