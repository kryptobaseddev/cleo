#!/usr/bin/env bash
# lib/claude-aliases.sh - Claude Code CLI alias management
#
# LAYER: 1 (Core Infrastructure)
# DEPENDENCIES: platform-compat.sh, exit-codes.sh
# PROVIDES: detect_available_shells, get_rc_file_path, get_current_shell,
#           get_alias_content, generate_bash_aliases, generate_powershell_aliases,
#           generate_cmd_aliases, aliases_has_block, get_installed_aliases_version,
#           inject_aliases, remove_aliases, check_aliases_status, is_claude_cli_installed

#=== SOURCE GUARD ================================================
[[ -n "${_CLAUDE_ALIASES_LOADED:-}" ]] && return 0
declare -r _CLAUDE_ALIASES_LOADED=1

set -euo pipefail

# ============================================================================
# DEPENDENCY LOADING
# ============================================================================

# Determine library directory
_CLAUDE_ALIASES_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source dependencies if not already loaded
if [[ -z "${_PLATFORM_COMPAT_LOADED:-}" ]]; then
    source "${_CLAUDE_ALIASES_SCRIPT_DIR}/platform-compat.sh"
fi

if [[ -z "${_EXIT_CODES_SH_LOADED:-}" ]]; then
    source "${_CLAUDE_ALIASES_SCRIPT_DIR}/exit-codes.sh"
fi

# ============================================================================
# CONSTANTS
# ============================================================================

# Marker constants for idempotent injection
readonly CLAUDE_ALIASES_MARKER_START="# CLEO-CLAUDE-ALIASES:START"
readonly CLAUDE_ALIASES_MARKER_END="# CLEO-CLAUDE-ALIASES:END"

# Current alias version (for upgrade detection)
readonly CLAUDE_ALIASES_VERSION="1.0.0"

# Supported shells
readonly SUPPORTED_SHELLS=("bash" "zsh" "powershell" "cmd")

# Environment variables for all aliases
readonly CLAUDE_ENV_VARS=(
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=true"
    "ENABLE_BACKGROUND_TASKS=true"
    "FORCE_AUTO_BACKGROUND_TASKS=true"
    "CLAUDE_CODE_ENABLE_UNIFIED_READ_TOOL=true"
)

# ============================================================================
# WINDOWS-SPECIFIC HELPER FUNCTIONS
# ============================================================================

# normalize_windows_path - Convert path to Windows format with backslashes
# Args: path
# Returns: Path with backslashes (for Windows) or unchanged (for other platforms)
normalize_windows_path() {
    local path="$1"

    if [[ "$PLATFORM" == "windows" ]]; then
        # Convert forward slashes to backslashes for Windows
        echo "${path//\//\\}"
    else
        echo "$path"
    fi
}

# get_windows_documents_path - Get Windows Documents folder (handles localization)
# Returns: Path to Documents folder or fallback
get_windows_documents_path() {
    if [[ "$PLATFORM" != "windows" ]]; then
        echo "$HOME/Documents"
        return 0
    fi

    # Try to get from Windows environment
    local docs_path="${USERPROFILE:-$HOME}/Documents"

    # Check if PowerShell can tell us the actual path (handles localized folder names)
    if command_exists pwsh; then
        local ps_docs
        ps_docs=$(pwsh -NoProfile -Command '[Environment]::GetFolderPath("MyDocuments")' 2>/dev/null)
        [[ -n "$ps_docs" ]] && docs_path="$ps_docs"
    elif command_exists powershell; then
        local ps_docs
        ps_docs=$(powershell -NoProfile -Command '[Environment]::GetFolderPath("MyDocuments")' 2>/dev/null)
        [[ -n "$ps_docs" ]] && docs_path="$ps_docs"
    fi

    echo "$docs_path"
}

# ensure_powershell_profile_dir - Create PowerShell profile directory if missing
# Args: profile_path
# Returns: 0 on success, 1 on failure
# Output: JSON result
ensure_powershell_profile_dir() {
    local profile_path="$1"
    local profile_dir
    profile_dir=$(dirname "$profile_path")

    if [[ -d "$profile_dir" ]]; then
        echo '{"created":false,"exists":true,"path":"'"$profile_dir"'"}'
        return 0
    fi

    # Create directory (handles both Unix and Windows paths)
    if mkdir -p "$profile_dir" 2>/dev/null; then
        echo '{"created":true,"exists":true,"path":"'"$profile_dir"'"}'
        return 0
    fi

    # Fallback for Windows: try with PowerShell
    if [[ "$PLATFORM" == "windows" ]]; then
        local win_dir
        win_dir=$(normalize_windows_path "$profile_dir")

        if command_exists pwsh; then
            pwsh -NoProfile -Command "New-Item -ItemType Directory -Path '$win_dir' -Force" >/dev/null 2>&1
        elif command_exists powershell; then
            powershell -NoProfile -Command "New-Item -ItemType Directory -Path '$win_dir' -Force" >/dev/null 2>&1
        fi

        if [[ -d "$profile_dir" ]]; then
            echo '{"created":true,"exists":true,"path":"'"$profile_dir"'","method":"powershell"}'
            return 0
        fi
    fi

    echo '{"created":false,"exists":false,"path":"'"$profile_dir"'","error":"cannot_create_directory"}'
    return 1
}

# setup_cmd_autorun - Configure CMD.exe to auto-load aliases via registry
# Args: batch_file_path [--remove]
# Returns: 0 on success, 1 on failure
# Output: JSON result
# Note: Requires Windows registry access (reg.exe)
setup_cmd_autorun() {
    local batch_file="$1"
    local remove="${2:-}"
    local registry_key='HKCU\Software\Microsoft\Command Processor'
    local registry_value='AutoRun'

    if [[ "$PLATFORM" != "windows" ]]; then
        echo '{"success":false,"error":"not_windows","message":"CMD AutoRun is Windows-only"}'
        return 1
    fi

    # Check if reg.exe is available
    if ! command_exists reg.exe && ! command_exists reg; then
        echo '{"success":false,"error":"no_reg_exe","message":"Registry tool not available"}'
        return 1
    fi

    local reg_cmd="reg.exe"
    command_exists reg.exe || reg_cmd="reg"

    if [[ "$remove" == "--remove" ]]; then
        # Remove the registry value
        if $reg_cmd delete "$registry_key" /v "$registry_value" /f >/dev/null 2>&1; then
            echo '{"success":true,"action":"removed","key":"'"$registry_key"'","value":"'"$registry_value"'"}'
            return 0
        else
            echo '{"success":false,"action":"remove_failed","key":"'"$registry_key"'"}'
            return 1
        fi
    fi

    # Normalize path for Windows registry
    local win_path
    win_path=$(normalize_windows_path "$batch_file")

    # Check if file exists
    if [[ ! -f "$batch_file" ]]; then
        echo '{"success":false,"error":"file_not_found","path":"'"$batch_file"'"}'
        return 1
    fi

    # Set registry value
    if $reg_cmd add "$registry_key" /v "$registry_value" /t REG_SZ /d "$win_path" /f >/dev/null 2>&1; then
        echo '{"success":true,"action":"set","key":"'"$registry_key"'","value":"'"$registry_value"'","data":"'"$win_path"'"}'
        return 0
    else
        echo '{"success":false,"error":"registry_write_failed","key":"'"$registry_key"'"}'
        return 1
    fi
}

# check_cmd_autorun - Check if CMD AutoRun is configured for CLEO aliases
# Returns: JSON with current AutoRun status
check_cmd_autorun() {
    local registry_key='HKCU\Software\Microsoft\Command Processor'
    local registry_value='AutoRun'

    if [[ "$PLATFORM" != "windows" ]]; then
        echo '{"configured":false,"reason":"not_windows"}'
        return 0
    fi

    local reg_cmd="reg.exe"
    command_exists reg.exe || reg_cmd="reg"

    if ! command_exists "$reg_cmd"; then
        echo '{"configured":false,"reason":"no_reg_exe"}'
        return 0
    fi

    # Query registry
    local reg_output
    if reg_output=$($reg_cmd query "$registry_key" /v "$registry_value" 2>/dev/null); then
        local current_value
        current_value=$(echo "$reg_output" | grep -i "AutoRun" | sed 's/.*REG_SZ[[:space:]]*//')

        # Check if it points to our file
        local is_cleo="false"
        if [[ "$current_value" == *"cleo-aliases.cmd"* ]]; then
            is_cleo="true"
        fi

        echo '{"configured":true,"value":"'"$current_value"'","isCleo":'"$is_cleo"'}'
    else
        echo '{"configured":false,"reason":"not_set"}'
    fi

    return 0
}

# ============================================================================
# SHELL DETECTION FUNCTIONS
# ============================================================================

# detect_available_shells - Find all installed shells
# Returns: JSON array of shell objects with name, path, rc_file
# Example: [{"name":"bash","path":"/bin/bash","rcFile":"~/.bashrc"}]
detect_available_shells() {
    local shells=()

    # Check bash
    if command_exists bash; then
        local bashrc
        bashrc=$(get_rc_file_path "bash")
        shells+=("{\"name\":\"bash\",\"path\":\"$(command -v bash)\",\"rcFile\":\"$bashrc\"}")
    fi

    # Check zsh
    if command_exists zsh; then
        local zshrc
        zshrc=$(get_rc_file_path "zsh")
        shells+=("{\"name\":\"zsh\",\"path\":\"$(command -v zsh)\",\"rcFile\":\"$zshrc\"}")
    fi

    # Check PowerShell (Windows/cross-platform)
    if command_exists pwsh || command_exists powershell; then
        local ps_profile
        ps_profile=$(get_rc_file_path "powershell")
        local ps_path
        ps_path=$(command -v pwsh 2>/dev/null || command -v powershell 2>/dev/null)
        shells+=("{\"name\":\"powershell\",\"path\":\"$ps_path\",\"rcFile\":\"$ps_profile\"}")
    fi

    # Check CMD (Windows only)
    if [[ "$PLATFORM" == "windows" ]]; then
        local userprofile="${USERPROFILE:-$HOME}"
        shells+=("{\"name\":\"cmd\",\"path\":\"cmd.exe\",\"rcFile\":\"${userprofile//\\/\\\\}\\\\cleo-aliases.cmd\"}")
    fi

    # Build JSON array
    if [[ ${#shells[@]} -eq 0 ]]; then
        echo "[]"
    else
        printf '[%s]' "$(IFS=,; echo "${shells[*]}")"
    fi
}

# get_rc_file_path - Get RC file path for shell type
# Args: shell_type (bash|zsh|powershell|cmd)
# Returns: RC file path
get_rc_file_path() {
    local shell_type="$1"

    case "$shell_type" in
        bash)
            # Prefer .bashrc, fall back to .bash_profile
            if [[ -f "$HOME/.bashrc" ]]; then
                echo "$HOME/.bashrc"
            elif [[ -f "$HOME/.bash_profile" ]]; then
                echo "$HOME/.bash_profile"
            else
                echo "$HOME/.bashrc"
            fi
            ;;
        zsh)
            echo "${ZDOTDIR:-$HOME}/.zshrc"
            ;;
        powershell)
            # Cross-platform PowerShell profile detection
            if [[ "$PLATFORM" == "windows" ]]; then
                # Use localized Documents folder path on Windows
                local docs_path
                docs_path=$(get_windows_documents_path)
                echo "$docs_path/PowerShell/Microsoft.PowerShell_profile.ps1"
            else
                echo "$HOME/.config/powershell/Microsoft.PowerShell_profile.ps1"
            fi
            ;;
        cmd)
            # Windows CMD autorun (requires registry, we use batch file)
            # Use USERPROFILE on Windows for proper path resolution
            local user_home="${USERPROFILE:-$HOME}"
            echo "$user_home/cleo-aliases.cmd"
            ;;
        *)
            return 1
            ;;
    esac
}

# get_current_shell - Detect user's current shell
# Returns: shell name (bash|zsh|powershell|cmd|unknown)
get_current_shell() {
    local shell_path="${SHELL:-}"
    local shell_name

    if [[ -n "${ZSH_VERSION:-}" ]]; then
        shell_name="zsh"
    elif [[ -n "${BASH_VERSION:-}" ]]; then
        shell_name="bash"
    elif [[ -n "${PSVersionTable:-}" ]]; then
        shell_name="powershell"
    elif [[ -n "$shell_path" ]]; then
        shell_name=$(basename "$shell_path")
    else
        shell_name="unknown"
    fi

    echo "$shell_name"
}

# ============================================================================
# ALIAS CONTENT GENERATION FUNCTIONS
# ============================================================================

# get_alias_content - Generate alias definitions for shell type
# Args: shell_type
# Returns: Complete alias block with markers
get_alias_content() {
    local shell_type="$1"
    local content=""

    case "$shell_type" in
        bash|zsh)
            content=$(generate_bash_aliases)
            ;;
        powershell)
            content=$(generate_powershell_aliases)
            ;;
        cmd)
            content=$(generate_cmd_aliases)
            ;;
        *)
            echo "Error: Unsupported shell type: $shell_type" >&2
            return 1
            ;;
    esac

    echo "$content"
}

# generate_bash_aliases - Generate bash/zsh alias definitions
# Returns: Alias definitions wrapped in markers
generate_bash_aliases() {
    local env_prefix
    env_prefix=$(IFS=' '; echo "${CLAUDE_ENV_VARS[*]}")

    cat <<EOF
$CLAUDE_ALIASES_MARKER_START v$CLAUDE_ALIASES_VERSION
# Claude Code CLI Aliases - Installed by CLEO
# https://github.com/kryptobaseddev/cleo

# Interactive mode with optimized environment
alias cc='$env_prefix claude'

# Interactive + skip permissions (for trusted projects)
alias ccy='$env_prefix claude --dangerously-skip-permissions'

# Resume previous session
alias ccr='$env_prefix claude --resume'

# Resume + skip permissions
alias ccry='$env_prefix claude --resume --dangerously-skip-permissions'

# Headless mode with controlled tools
alias cc-headless='$env_prefix claude --print --allowedTools'

# Headless + skip permissions (full autonomy)
alias cc-headfull='$env_prefix claude --print --dangerously-skip-permissions'

# Headless + streaming JSON output
alias cc-headfull-stream='$env_prefix claude --print --dangerously-skip-permissions --output-format stream-json'

$CLAUDE_ALIASES_MARKER_END
EOF
}

# generate_powershell_aliases - Generate PowerShell function definitions
# Returns: Function definitions wrapped in markers
generate_powershell_aliases() {
    cat <<EOF
$CLAUDE_ALIASES_MARKER_START v$CLAUDE_ALIASES_VERSION
# Claude Code CLI Aliases - Installed by CLEO
# https://github.com/kryptobaseddev/cleo

function Set-ClaudeEnv {
    \$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "true"
    \$env:ENABLE_BACKGROUND_TASKS = "true"
    \$env:FORCE_AUTO_BACKGROUND_TASKS = "true"
    \$env:CLAUDE_CODE_ENABLE_UNIFIED_READ_TOOL = "true"
}

function cc { Set-ClaudeEnv; & claude @args }
function ccy { Set-ClaudeEnv; & claude --dangerously-skip-permissions @args }
function ccr { Set-ClaudeEnv; & claude --resume @args }
function ccry { Set-ClaudeEnv; & claude --resume --dangerously-skip-permissions @args }
function cc-headless { Set-ClaudeEnv; & claude --print --allowedTools @args }
function cc-headfull { Set-ClaudeEnv; & claude --print --dangerously-skip-permissions @args }
function cc-headfull-stream { Set-ClaudeEnv; & claude --print --dangerously-skip-permissions --output-format stream-json @args }

$CLAUDE_ALIASES_MARKER_END
EOF
}

# generate_cmd_aliases - Generate CMD DOSKEY definitions
# Returns: DOSKEY macros
generate_cmd_aliases() {
    cat <<'EOF'
@echo off
REM CLEO-CLAUDE-ALIASES:START v1.0.0
REM Claude Code CLI Aliases - Installed by CLEO
REM https://github.com/kryptobaseddev/cleo

doskey cc=set CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=true $T set ENABLE_BACKGROUND_TASKS=true $T set FORCE_AUTO_BACKGROUND_TASKS=true $T set CLAUDE_CODE_ENABLE_UNIFIED_READ_TOOL=true $T claude $*
doskey ccy=set CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=true $T set ENABLE_BACKGROUND_TASKS=true $T set FORCE_AUTO_BACKGROUND_TASKS=true $T set CLAUDE_CODE_ENABLE_UNIFIED_READ_TOOL=true $T claude --dangerously-skip-permissions $*
doskey ccr=set CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=true $T set ENABLE_BACKGROUND_TASKS=true $T set FORCE_AUTO_BACKGROUND_TASKS=true $T set CLAUDE_CODE_ENABLE_UNIFIED_READ_TOOL=true $T claude --resume $*
doskey ccry=set CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=true $T set ENABLE_BACKGROUND_TASKS=true $T set FORCE_AUTO_BACKGROUND_TASKS=true $T set CLAUDE_CODE_ENABLE_UNIFIED_READ_TOOL=true $T claude --resume --dangerously-skip-permissions $*
doskey cc-headless=set CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=true $T set ENABLE_BACKGROUND_TASKS=true $T set FORCE_AUTO_BACKGROUND_TASKS=true $T set CLAUDE_CODE_ENABLE_UNIFIED_READ_TOOL=true $T claude --print --allowedTools $*
doskey cc-headfull=set CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=true $T set ENABLE_BACKGROUND_TASKS=true $T set FORCE_AUTO_BACKGROUND_TASKS=true $T set CLAUDE_CODE_ENABLE_UNIFIED_READ_TOOL=true $T claude --print --dangerously-skip-permissions $*
doskey cc-headfull-stream=set CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=true $T set ENABLE_BACKGROUND_TASKS=true $T set FORCE_AUTO_BACKGROUND_TASKS=true $T set CLAUDE_CODE_ENABLE_UNIFIED_READ_TOOL=true $T claude --print --dangerously-skip-permissions --output-format stream-json $*

REM CLEO-CLAUDE-ALIASES:END
EOF
}

# ============================================================================
# COLLISION DETECTION AND LEGACY RECOGNITION
# ============================================================================

# Alias names we manage
readonly CLAUDE_ALIAS_NAMES=("cc" "ccy" "ccr" "ccry" "cc-headless" "cc-headfull" "cc-headfull-stream")

# detect_existing_aliases - Find existing aliases/functions with our names
# Args: rc_file
# Returns: JSON array of collisions
# Example: [{"name":"cc","type":"alias","value":"echo test","isClaudeRelated":false}]
detect_existing_aliases() {
    local rc_file="$1"
    local collisions=()

    [[ ! -f "$rc_file" ]] && { echo "[]"; return 0; }

    for alias_name in "${CLAUDE_ALIAS_NAMES[@]}"; do
        # Check for alias definitions: alias cc='...' or alias cc="..."
        local alias_match
        alias_match=$(grep -E "^[[:space:]]*(alias[[:space:]]+${alias_name}=|${alias_name}\(\)[[:space:]]*\{)" "$rc_file" 2>/dev/null | head -1)

        if [[ -n "$alias_match" ]]; then
            # Determine type (alias or function)
            local type="alias"
            if [[ "$alias_match" =~ \(\) ]]; then
                type="function"
            fi

            # Check if it's Claude-related (contains "claude" in the value)
            local is_claude_related="false"
            if echo "$alias_match" | grep -qi "claude"; then
                is_claude_related="true"
            fi

            # Extract the value (simplified - just get the line)
            local value
            value=$(echo "$alias_match" | sed "s/'/\\\\\'/g" | tr -d '\n')

            collisions+=("{\"name\":\"$alias_name\",\"type\":\"$type\",\"isClaudeRelated\":$is_claude_related}")
        fi
    done

    if [[ ${#collisions[@]} -eq 0 ]]; then
        echo "[]"
    else
        printf '[%s]' "$(IFS=,; echo "${collisions[*]}")"
    fi
}

# detect_legacy_claude_aliases - Check for function-based Claude aliases
# Args: rc_file
# Returns: JSON object with detection result
# Detects patterns like: _cc_env() function + cc() calling claude
detect_legacy_claude_aliases() {
    local rc_file="$1"

    [[ ! -f "$rc_file" ]] && { echo '{"detected":false}'; return 0; }

    local has_cc_env=false
    local has_claude_functions=false
    local has_claude_comment=false

    # Check for _cc_env function (common pattern)
    if grep -q "_cc_env()" "$rc_file" 2>/dev/null; then
        has_cc_env=true
    fi

    # Check for functions calling claude
    if grep -qE "^\s*(cc|ccy|ccr)\(\)" "$rc_file" 2>/dev/null; then
        if grep -q "claude" "$rc_file" 2>/dev/null; then
            has_claude_functions=true
        fi
    fi

    # Check for "Claude Code Aliases" or similar comment
    if grep -qi "claude.*aliases\|claude code" "$rc_file" 2>/dev/null; then
        has_claude_comment=true
    fi

    # Determine if legacy aliases are present
    local detected=false
    if [[ "$has_cc_env" == true ]] || [[ "$has_claude_functions" == true && "$has_claude_comment" == true ]]; then
        detected=true
    fi

    cat <<EOF
{"detected":$detected,"hasCcEnv":$has_cc_env,"hasClaudeFunctions":$has_claude_functions,"hasClaudeComment":$has_claude_comment}
EOF
}

# check_alias_collisions - Check for non-Claude alias collisions
# Args: rc_file
# Returns: JSON with collision info and recommendation
check_alias_collisions() {
    local rc_file="$1"

    [[ ! -f "$rc_file" ]] && { echo '{"hasCollisions":false,"collisions":[]}'; return 0; }

    # Skip if we already have CLEO block (our aliases are fine)
    if aliases_has_block "$rc_file"; then
        echo '{"hasCollisions":false,"collisions":[],"reason":"cleo_managed"}'
        return 0
    fi

    local collisions_json
    collisions_json=$(detect_existing_aliases "$rc_file")

    # Check if any collisions are non-Claude related
    local non_claude_count
    non_claude_count=$(echo "$collisions_json" | jq '[.[] | select(.isClaudeRelated == false)] | length' 2>/dev/null || echo "0")

    local has_collisions="false"
    [[ "$non_claude_count" -gt 0 ]] && has_collisions="true"

    cat <<EOF
{"hasCollisions":$has_collisions,"nonClaudeCount":$non_claude_count,"collisions":$collisions_json}
EOF
}

# ============================================================================
# INJECTION AND REMOVAL OPERATIONS
# ============================================================================

# aliases_has_block - Check if RC file has alias block
# Args: rc_file
# Returns: 0 if present, 1 if absent
aliases_has_block() {
    local rc_file="$1"
    [[ -f "$rc_file" ]] && grep -q "$CLAUDE_ALIASES_MARKER_START" "$rc_file" 2>/dev/null
}

# get_installed_aliases_version - Get version from installed block
# Args: rc_file
# Returns: version string or empty
get_installed_aliases_version() {
    local rc_file="$1"

    [[ ! -f "$rc_file" ]] && return 1

    # Extract version from marker line
    # Format: # CLEO-CLAUDE-ALIASES:START v1.0.0
    local version_line
    version_line=$(grep "$CLAUDE_ALIASES_MARKER_START" "$rc_file" 2>/dev/null | head -1)

    if [[ -n "$version_line" ]]; then
        # Extract version number (e.g., "1.0.0" from "v1.0.0")
        echo "$version_line" | sed -n 's/.*v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p'
    fi
}

# inject_aliases - Install aliases into RC file
# Args: rc_file shell_type [--force] [--no-collision-check]
# Returns: 0 on success, error code on failure
# Output: JSON result object
# Exit code 23: Collision detected (non-Claude aliases exist)
inject_aliases() {
    local rc_file="$1"
    local shell_type="$2"
    local force="${3:-}"
    local no_collision_check="${4:-}"

    # Check for collisions unless --force or --no-collision-check
    if [[ "$force" != "--force" ]] && [[ "$no_collision_check" != "--no-collision-check" ]] && [[ -f "$rc_file" ]]; then
        # Skip collision check if we already manage this file
        if ! aliases_has_block "$rc_file"; then
            local collision_result
            collision_result=$(check_alias_collisions "$rc_file")
            local has_collisions
            has_collisions=$(echo "$collision_result" | jq -r '.hasCollisions' 2>/dev/null || echo "false")

            if [[ "$has_collisions" == "true" ]]; then
                local collisions
                collisions=$(echo "$collision_result" | jq -c '.collisions' 2>/dev/null || echo "[]")

                # Check if these are legacy Claude aliases
                local legacy_result
                legacy_result=$(detect_legacy_claude_aliases "$rc_file")
                local is_legacy
                is_legacy=$(echo "$legacy_result" | jq -r '.detected' 2>/dev/null || echo "false")

                if [[ "$is_legacy" == "true" ]]; then
                    echo "{\"action\":\"blocked\",\"reason\":\"legacy_claude_aliases\",\"message\":\"Legacy Claude aliases detected. Use --force to replace them.\",\"collisions\":$collisions,\"legacy\":$legacy_result}"
                else
                    echo "{\"action\":\"blocked\",\"reason\":\"collision\",\"message\":\"Existing non-Claude aliases found. Use --force to override.\",\"collisions\":$collisions}"
                fi
                return 23  # E_COLLISION
            fi
        fi
    fi

    local content
    content=$(get_alias_content "$shell_type") || return $?

    # Create directory if needed (with Windows-specific handling for PowerShell)
    local rc_dir
    rc_dir=$(dirname "$rc_file")
    if [[ ! -d "$rc_dir" ]]; then
        if [[ "$shell_type" == "powershell" ]]; then
            # Use Windows-aware PowerShell profile directory creation
            local dir_result
            dir_result=$(ensure_powershell_profile_dir "$rc_file")
            local dir_exists
            dir_exists=$(echo "$dir_result" | jq -r '.exists' 2>/dev/null || echo "false")
            if [[ "$dir_exists" != "true" ]]; then
                echo "{\"action\":\"failed\",\"reason\":\"cannot_create_directory\",\"path\":\"$rc_dir\",\"details\":$dir_result}"
                return "$EXIT_FILE_ERROR"
            fi
        else
            mkdir -p "$rc_dir" || {
                echo "{\"action\":\"failed\",\"reason\":\"cannot_create_directory\",\"path\":\"$rc_dir\"}"
                return "$EXIT_FILE_ERROR"
            }
        fi
    fi

    local action
    if [[ ! -f "$rc_file" ]]; then
        action="created"
        echo "$content" > "$rc_file" || {
            echo "{\"action\":\"failed\",\"reason\":\"cannot_write_file\",\"path\":\"$rc_file\"}"
            return "$EXIT_FILE_ERROR"
        }
    elif aliases_has_block "$rc_file"; then
        # Check if update needed
        local installed_version
        installed_version=$(get_installed_aliases_version "$rc_file")

        if [[ "$installed_version" == "$CLAUDE_ALIASES_VERSION" ]] && [[ "$force" != "--force" ]]; then
            echo "{\"action\":\"skipped\",\"reason\":\"already_current\",\"version\":\"$installed_version\"}"
            return 0
        fi

        action="updated"
        # Replace existing block using temp file pattern
        local temp_file
        temp_file=$(mktemp) || {
            echo "{\"action\":\"failed\",\"reason\":\"cannot_create_temp_file\"}"
            return "$EXIT_FILE_ERROR"
        }

        # Remove existing block
        awk -v start="$CLAUDE_ALIASES_MARKER_START" -v end="$CLAUDE_ALIASES_MARKER_END" '
            $0 ~ start { skip = 1; next }
            $0 ~ end { skip = 0; next }
            !skip { print }
        ' "$rc_file" > "$temp_file"

        # Append new content
        echo "" >> "$temp_file"
        echo "$content" >> "$temp_file"

        mv "$temp_file" "$rc_file" || {
            rm -f "$temp_file"
            echo "{\"action\":\"failed\",\"reason\":\"cannot_update_file\",\"path\":\"$rc_file\"}"
            return "$EXIT_FILE_ERROR"
        }
    else
        action="added"
        # Append to existing file
        {
            echo ""
            echo "$content"
        } >> "$rc_file" || {
            echo "{\"action\":\"failed\",\"reason\":\"cannot_append_file\",\"path\":\"$rc_file\"}"
            return "$EXIT_FILE_ERROR"
        }
    fi

    echo "{\"action\":\"$action\",\"file\":\"$rc_file\",\"version\":\"$CLAUDE_ALIASES_VERSION\"}"
}

# remove_aliases - Remove alias block from RC file
# Args: rc_file
# Returns: 0 on success
# Output: JSON result object
remove_aliases() {
    local rc_file="$1"

    if [[ ! -f "$rc_file" ]]; then
        echo "{\"action\":\"skipped\",\"reason\":\"file_not_found\",\"file\":\"$rc_file\"}"
        return 0
    fi

    if ! aliases_has_block "$rc_file"; then
        echo "{\"action\":\"skipped\",\"reason\":\"not_installed\",\"file\":\"$rc_file\"}"
        return 0
    fi

    local temp_file
    temp_file=$(mktemp) || {
        echo "{\"action\":\"failed\",\"reason\":\"cannot_create_temp_file\"}"
        return "$EXIT_FILE_ERROR"
    }

    # Remove block
    awk -v start="$CLAUDE_ALIASES_MARKER_START" -v end="$CLAUDE_ALIASES_MARKER_END" '
        $0 ~ start { skip = 1; next }
        $0 ~ end { skip = 0; next }
        !skip { print }
    ' "$rc_file" > "$temp_file"

    mv "$temp_file" "$rc_file" || {
        rm -f "$temp_file"
        echo "{\"action\":\"failed\",\"reason\":\"cannot_update_file\",\"path\":\"$rc_file\"}"
        return "$EXIT_FILE_ERROR"
    }

    echo "{\"action\":\"removed\",\"file\":\"$rc_file\"}"
}

# ============================================================================
# STATUS FUNCTIONS
# ============================================================================

# check_aliases_status - Check installation status for all shells
# Returns: JSON object with status per shell
# Statuses: current, outdated, not_installed, legacy (function-based), collision
check_aliases_status() {
    local results=()

    for shell_type in "${SUPPORTED_SHELLS[@]}"; do
        local rc_file
        rc_file=$(get_rc_file_path "$shell_type" 2>/dev/null) || continue

        local status="not_installed"
        local version=""
        local file_exists="false"
        local has_legacy="false"
        local has_collision="false"

        if [[ -f "$rc_file" ]]; then
            file_exists="true"

            if aliases_has_block "$rc_file"; then
                # CLEO-managed aliases
                version=$(get_installed_aliases_version "$rc_file")
                if [[ "$version" == "$CLAUDE_ALIASES_VERSION" ]]; then
                    status="current"
                else
                    status="outdated"
                fi
            else
                # Check for legacy Claude aliases (function-based)
                local legacy_result
                legacy_result=$(detect_legacy_claude_aliases "$rc_file")
                local is_legacy
                is_legacy=$(echo "$legacy_result" | jq -r '.detected' 2>/dev/null || echo "false")

                if [[ "$is_legacy" == "true" ]]; then
                    status="legacy"
                    has_legacy="true"
                else
                    # Check for non-Claude collisions
                    local collision_result
                    collision_result=$(check_alias_collisions "$rc_file")
                    local collision_check
                    collision_check=$(echo "$collision_result" | jq -r '.hasCollisions' 2>/dev/null || echo "false")

                    if [[ "$collision_check" == "true" ]]; then
                        status="collision"
                        has_collision="true"
                    fi
                fi
            fi
        fi

        # Build JSON object for this shell
        local version_json="null"
        [[ -n "$version" ]] && version_json="\"$version\""

        results+=("{\"shell\":\"$shell_type\",\"rcFile\":\"$rc_file\",\"status\":\"$status\",\"version\":$version_json,\"fileExists\":$file_exists,\"hasLegacy\":$has_legacy,\"hasCollision\":$has_collision}")
    done

    # Build JSON array
    if [[ ${#results[@]} -eq 0 ]]; then
        echo "[]"
    else
        printf '[%s]' "$(IFS=,; echo "${results[*]}")"
    fi
}

# is_claude_cli_installed - Check if claude CLI is available
# Returns: 0 if installed, 1 if not
is_claude_cli_installed() {
    command_exists claude
}

# ============================================================================
# EXPORTS
# ============================================================================

# Export constants
export CLAUDE_ALIASES_MARKER_START
export CLAUDE_ALIASES_MARKER_END
export CLAUDE_ALIASES_VERSION
export SUPPORTED_SHELLS
export CLAUDE_ENV_VARS
export CLAUDE_ALIAS_NAMES

# Export shell detection functions
export -f detect_available_shells
export -f get_rc_file_path
export -f get_current_shell

# Export Windows-specific helper functions
export -f normalize_windows_path
export -f get_windows_documents_path
export -f ensure_powershell_profile_dir
export -f setup_cmd_autorun
export -f check_cmd_autorun

# Export alias content generation functions
export -f get_alias_content
export -f generate_bash_aliases
export -f generate_powershell_aliases
export -f generate_cmd_aliases

# Export collision detection functions
export -f detect_existing_aliases
export -f detect_legacy_claude_aliases
export -f check_alias_collisions

# Export injection and removal operations
export -f aliases_has_block
export -f get_installed_aliases_version
export -f inject_aliases
export -f remove_aliases

# Export status functions
export -f check_aliases_status
export -f is_claude_cli_installed
