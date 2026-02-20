#!/usr/bin/env bash
# mcp-config.sh - MCP server configuration library for multi-tool auto-detection
#
# LAYER: 2 (Data Layer)
# DEPENDENCIES: none (standalone library)
# PROVIDES: mcp_detect_all_tools, mcp_detect_tool, mcp_generate_entry,
#           mcp_write_config, mcp_backup_external_file, mcp_get_tool_keys,
#           mcp_get_tool_display_name, mcp_get_tool_format

#=== SOURCE GUARD ================================================
[[ -n "${_MCP_CONFIG_LOADED:-}" ]] && return 0
declare -r _MCP_CONFIG_LOADED=1

# ============================================================================
# TOOL REGISTRY
# ============================================================================
# Each tool has: key, display_name, format, config_key, global_path, project_path,
#                binary, config_dir, app_bundle (macOS)

# Tool keys (ordered)
readonly MCP_TOOL_KEYS=(
    "claude-code"
    "claude-desktop"
    "cursor"
    "gemini-cli"
    "kimi"
    "antigravity"
    "windsurf"
    "goose"
    "opencode"
    "vscode"
    "zed"
    "codex"
)

# Registry lookup functions (case-based for subshell/export compatibility)

# Get display name for a tool key
# Args: $1 = tool key
_mcp_display_name() {
    case "$1" in
        claude-code)    echo "Claude Code" ;;
        claude-desktop) echo "Claude Desktop" ;;
        cursor)         echo "Cursor" ;;
        gemini-cli)     echo "Gemini CLI" ;;
        kimi)           echo "Kimi Code" ;;
        antigravity)    echo "Antigravity" ;;
        windsurf)       echo "Windsurf" ;;
        goose)          echo "Goose" ;;
        opencode)       echo "OpenCode" ;;
        vscode)         echo "VS Code" ;;
        zed)            echo "Zed" ;;
        codex)          echo "Codex" ;;
        *)              echo "$1" ;;
    esac
}

# Get config format for a tool key
# Args: $1 = tool key
_mcp_format() {
    case "$1" in
        claude-code|claude-desktop|cursor|gemini-cli|kimi|antigravity|windsurf)
            echo "standard" ;;
        goose)     echo "goose" ;;
        opencode)  echo "opencode" ;;
        vscode)    echo "vscode" ;;
        zed)       echo "zed" ;;
        codex)     echo "codex" ;;
        *)         echo "unknown" ;;
    esac
}

# Get config key for a tool (top-level JSON key holding MCP servers)
# Args: $1 = tool key
_mcp_config_key() {
    case "$1" in
        claude-code|claude-desktop|cursor|gemini-cli|kimi|antigravity|windsurf)
            echo "mcpServers" ;;
        goose)     echo "extensions" ;;
        opencode)  echo "mcp" ;;
        vscode)    echo "servers" ;;
        zed)       echo "context_servers" ;;
        codex)     echo "mcp_servers" ;;
        *)         echo "" ;;
    esac
}

# Get binary name for detection
# Args: $1 = tool key
_mcp_binary() {
    case "$1" in
        claude-code)  echo "claude" ;;
        cursor)       echo "cursor" ;;
        gemini-cli)   echo "gemini" ;;
        kimi)         echo "kimi" ;;
        goose)        echo "goose" ;;
        opencode)     echo "opencode" ;;
        vscode)       echo "code" ;;
        zed)          echo "zed" ;;
        codex)        echo "codex" ;;
        *)            echo "" ;;
    esac
}

# Get config directories for detection (relative to HOME, newline-separated)
# Args: $1 = tool key
# Note: Returns multiple paths for tools with alternative install locations
_mcp_config_dir() {
    case "$1" in
        cursor)       echo ".cursor" ;;
        gemini-cli)   echo ".gemini" ;;
        kimi)         echo ".kimi" ;;
        antigravity)  echo ".gemini/antigravity" ;;
        windsurf)     echo ".codeium/windsurf" ;;
        goose)        printf '%s\n' ".goose" ".config/goose" ;;
        opencode)     printf '%s\n' ".config/opencode" ".opencode" ;;
        vscode)       echo ".vscode" ;;
        zed)          printf '%s\n' ".config/zed" ".var/app/dev.zed.Zed/config/zed" ;;
        codex)        echo ".codex" ;;
        *)            echo "" ;;
    esac
}

# Get macOS app bundle name for detection
# Args: $1 = tool key
_mcp_app_bundle() {
    case "$1" in
        claude-desktop) echo "Claude.app" ;;
        cursor)         echo "Cursor.app" ;;
        windsurf)       echo "Windsurf.app" ;;
        vscode)         echo "Visual Studio Code.app" ;;
        zed)            echo "Zed.app" ;;
        *)              echo "" ;;
    esac
}

# Get Flatpak app ID for detection
# Args: $1 = tool key
_mcp_flatpak_id() {
    case "$1" in
        zed)    echo "dev.zed.Zed" ;;
        vscode) echo "com.visualstudio.code" ;;
        *)      echo "" ;;
    esac
}

# ============================================================================
# PATH RESOLUTION
# ============================================================================

# Get the config file path for a tool
# Args: $1 = tool key, $2 = scope (project|global)
# Output: absolute path to config file
_mcp_get_config_path() {
    local key="$1"
    local scope="${2:-project}"

    case "$key" in
        claude-code)
            if [[ "$scope" == "project" ]]; then
                echo ".mcp.json"
            else
                echo "$HOME/.claude.json"
            fi
            ;;
        claude-desktop)
            if [[ "$(uname -s)" == "Darwin" ]]; then
                echo "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
            else
                echo "$HOME/.config/Claude/claude_desktop_config.json"
            fi
            ;;
        cursor)
            if [[ "$scope" == "project" ]]; then
                echo ".cursor/mcp.json"
            else
                echo "$HOME/.cursor/mcp.json"
            fi
            ;;
        gemini-cli)
            if [[ "$scope" == "project" ]]; then
                echo ".gemini/settings.json"
            else
                echo "$HOME/.gemini/settings.json"
            fi
            ;;
        kimi)
            echo "$HOME/.kimi/mcp.json"
            ;;
        antigravity)
            echo "$HOME/.gemini/antigravity/mcp_config.json"
            ;;
        windsurf)
            echo "$HOME/.codeium/windsurf/mcp_config.json"
            ;;
        goose)
            if [[ "$scope" == "project" ]]; then
                echo ".goose/config.yaml"
            else
                echo "$HOME/.config/goose/config.yaml"
            fi
            ;;
        opencode)
            if [[ "$scope" == "project" ]]; then
                echo ".opencode.json"
            else
                echo "$HOME/.config/opencode/opencode.json"
            fi
            ;;
        vscode)
            if [[ "$scope" == "project" ]]; then
                echo ".vscode/mcp.json"
            else
                if [[ "$(uname -s)" == "Darwin" ]]; then
                    echo "$HOME/Library/Application Support/Code/User/mcp.json"
                else
                    echo "$HOME/.config/Code/User/mcp.json"
                fi
            fi
            ;;
        zed)
            if [[ "$scope" == "project" ]]; then
                echo ".zed/settings.json"
            else
                if [[ -d "$HOME/.var/app/dev.zed.Zed/config/zed" ]]; then
                    echo "$HOME/.var/app/dev.zed.Zed/config/zed/settings.json"
                elif [[ "$(uname -s)" == "Darwin" ]]; then
                    echo "$HOME/Library/Application Support/Zed/settings.json"
                else
                    echo "$HOME/.config/zed/settings.json"
                fi
            fi
            ;;
        codex)
            if [[ "$scope" == "project" ]]; then
                echo ".codex/config.toml"
            else
                echo "$HOME/.codex/config.toml"
            fi
            ;;
        *)
            echo ""
            return 1
            ;;
    esac
}

# Check if tool supports both project and global scope
# Args: $1 = tool key
# Returns: 0 if dual-scope, 1 if single-scope
_mcp_has_dual_scope() {
    local key="$1"
    case "$key" in
        claude-code|cursor|vscode|opencode|codex|goose|zed|gemini-cli) return 0 ;;
        *) return 1 ;;
    esac
}

# ============================================================================
# DETECTION
# ============================================================================

# Detect a single tool
# Args: $1 = tool key
# Output: JSON object with detection details or empty
# Returns: 0 if detected, 1 if not
mcp_detect_tool() {
    local key="$1"
    local detected=false
    local method=""
    local binary
    binary=$(_mcp_binary "$key")
    local app_bundle
    app_bundle=$(_mcp_app_bundle "$key")
    local flatpak_id
    flatpak_id=$(_mcp_flatpak_id "$key")

    # 1. Check binary on PATH
    if [[ -n "$binary" ]] && command -v "$binary" &>/dev/null; then
        detected=true
        method="binary"
    fi

    # 2. Check config directories (may return multiple paths)
    if [[ "$detected" == "false" ]]; then
        local dir
        while IFS= read -r dir; do
            if [[ -n "$dir" && -d "$HOME/$dir" ]]; then
                detected=true
                method="config_dir"
                break
            fi
        done < <(_mcp_config_dir "$key")
    fi

    # 3. Check macOS app bundle
    if [[ "$detected" == "false" && -n "$app_bundle" && -d "/Applications/$app_bundle" ]]; then
        detected=true
        method="app_bundle"
    fi

    # 4. Check Flatpak
    if [[ "$detected" == "false" && -n "$flatpak_id" ]] && command -v flatpak &>/dev/null; then
        if flatpak info "$flatpak_id" &>/dev/null; then
            detected=true
            method="flatpak"
        fi
    fi

    if [[ "$detected" == "true" ]]; then
        local config_path
        config_path=$(_mcp_get_config_path "$key" "project")
        local has_existing=false
        if [[ -f "$config_path" ]]; then
            has_existing=true
        fi

        local dual_scope=false
        if _mcp_has_dual_scope "$key"; then
            dual_scope=true
        fi

        jq -nc \
            --arg key "$key" \
            --arg name "$(_mcp_display_name "$key")" \
            --arg format "$(_mcp_format "$key")" \
            --arg method "$method" \
            --arg config_path "$config_path" \
            --argjson has_existing "$has_existing" \
            --argjson dual_scope "$dual_scope" \
            '{
                key: $key,
                name: $name,
                format: $format,
                method: $method,
                configPath: $config_path,
                hasExisting: $has_existing,
                dualScope: $dual_scope
            }'
        return 0
    fi

    return 1
}

# Detect all installed tools
# Output: JSON array of detected tools
mcp_detect_all_tools() {
    local results="[]"
    local tool_json

    for key in "${MCP_TOOL_KEYS[@]}"; do
        if tool_json=$(mcp_detect_tool "$key"); then
            results=$(echo "$results" | jq --argjson tool "$tool_json" '. += [$tool]')
        fi
    done

    echo "$results"
}

# ============================================================================
# CONFIG GENERATION
# ============================================================================

# Generate the MCP server entry for a given mode
# Args: $1 = mode (npx|local), $2 = project root (for local mode)
# Output: JSON object for the cleo server entry
mcp_generate_entry() {
    local mode="${1:-npx}"
    local project_root="${2:-$(pwd)}"

    if [[ "$mode" == "local" ]]; then
        local dist_path="$project_root/mcp-server/dist/index.js"
        jq -nc \
            --arg path "$dist_path" \
            '{command: "node", args: [$path]}'
    else
        jq -nc '{command: "npx", args: ["-y", "@cleocode/mcp-server"]}'
    fi
}

# ============================================================================
# FORMAT-SPECIFIC MERGE FUNCTIONS
# ============================================================================

# Merge entry into standard format (mcpServers key)
# Args: $1 = existing JSON content (or empty), $2 = entry JSON, $3 = config_key
# Output: merged JSON
_mcp_merge_standard() {
    local existing="$1"
    local entry="$2"
    local config_key="${3:-mcpServers}"

    if [[ -z "$existing" || "$existing" == "{}" ]]; then
        existing="{}"
    fi

    echo "$existing" | jq \
        --arg key "$config_key" \
        --argjson entry "$entry" \
        'if has($key) then .[$key].cleo = $entry else . + {($key): {cleo: $entry}} end'
}

# Merge entry into OpenCode format
# Args: $1 = existing JSON content, $2 = entry JSON
# Output: merged JSON
_mcp_merge_opencode() {
    local existing="$1"
    local entry="$2"

    if [[ -z "$existing" || "$existing" == "{}" ]]; then
        existing="{}"
    fi

    # OpenCode uses array-style command and adds type+enabled fields
    local opencode_entry
    opencode_entry=$(echo "$entry" | jq '{
        type: "local",
        command: (if .args then [.command] + .args else [.command] end),
        enabled: true
    }')

    echo "$existing" | jq \
        --argjson entry "$opencode_entry" \
        'if has("mcp") then .mcp.cleo = $entry else . + {mcp: {cleo: $entry}} end'
}

# Merge entry into VS Code format (servers key)
# Args: $1 = existing JSON content, $2 = entry JSON
# Output: merged JSON
_mcp_merge_vscode() {
    local existing="$1"
    local entry="$2"

    if [[ -z "$existing" || "$existing" == "{}" ]]; then
        existing="{}"
    fi

    echo "$existing" | jq \
        --argjson entry "$entry" \
        'if has("servers") then .servers.cleo = $entry else . + {servers: {cleo: $entry}} end'
}

# Merge entry into Zed format (context_servers key)
# Args: $1 = existing JSON content, $2 = entry JSON
# Output: merged JSON
_mcp_merge_zed() {
    local existing="$1"
    local entry="$2"

    if [[ -z "$existing" || "$existing" == "{}" ]]; then
        existing="{}"
    fi

    echo "$existing" | jq \
        --argjson entry "$entry" \
        'if has("context_servers") then .context_servers.cleo = $entry else . + {context_servers: {cleo: $entry}} end'
}

# Generate Codex TOML block for cleo MCP server
# Args: $1 = entry JSON
# Output: TOML block string
_mcp_generate_codex_toml_block() {
    local entry="$1"
    local command args_str

    command=$(echo "$entry" | jq -r '.command')
    args_str=$(echo "$entry" | jq -r '.args | map("\"" + . + "\"") | join(", ")')

    printf '[mcp_servers.cleo]\ncommand = "%s"\nargs = [%s]\n' "$command" "$args_str"
}

# Append or replace cleo block in Codex TOML config
# Args: $1 = existing TOML content (or empty), $2 = entry JSON
# Output: updated TOML content
_mcp_merge_codex_toml() {
    local existing="$1"
    local entry="$2"
    local block

    block=$(_mcp_generate_codex_toml_block "$entry")

    if [[ -z "$existing" ]]; then
        echo "$block"
        return
    fi

    # Check if [mcp_servers.cleo] section already exists
    if echo "$existing" | grep -q '^\[mcp_servers\.cleo\]'; then
        # Replace existing block: remove old section and append new
        # Remove from [mcp_servers.cleo] to next section header or EOF
        local in_cleo=false
        local result=""
        while IFS= read -r line; do
            if [[ "$line" == "[mcp_servers.cleo]" ]]; then
                in_cleo=true
                continue
            fi
            if [[ "$in_cleo" == "true" ]]; then
                # Check if we hit a new section header
                if [[ "$line" =~ ^\[.+\] ]]; then
                    in_cleo=false
                    result+="$line"$'\n'
                fi
                # Skip lines in old cleo section
                continue
            fi
            result+="$line"$'\n'
        done <<< "$existing"

        # Append new block
        printf '%s\n%s\n' "$result" "$block"
    else
        # Append new block
        if [[ -n "$existing" ]]; then
            printf '%s\n\n%s\n' "$existing" "$block"
        else
            echo "$block"
        fi
    fi
}

# Generate Goose YAML block for cleo MCP server
# Args: $1 = entry JSON
# Output: YAML block string for the cleo extension
_mcp_generate_goose_yaml_block() {
    local entry="$1"
    local command args_yaml

    command=$(echo "$entry" | jq -r '.command')
    # Build YAML args list
    args_yaml=""
    local arg_count
    arg_count=$(echo "$entry" | jq -r '.args | length')
    for i in $(seq 0 $((arg_count - 1))); do
        local arg
        arg=$(echo "$entry" | jq -r ".args[$i]")
        args_yaml+="    - ${arg}"$'\n'
    done
    # Remove trailing newline
    args_yaml="${args_yaml%$'\n'}"

    printf '  cleo:\n    args:\n%s\n    cmd: %s\n    enabled: true\n    name: cleo\n    type: stdio' "$args_yaml" "$command"
}

# Append or replace cleo block in Goose YAML config
# Args: $1 = existing YAML content (or empty), $2 = entry JSON
# Output: updated YAML content
_mcp_merge_goose_yaml() {
    local existing="$1"
    local entry="$2"
    local block

    block=$(_mcp_generate_goose_yaml_block "$entry")

    if [[ -z "$existing" ]]; then
        printf 'extensions:\n%s\n' "$block"
        return
    fi

    # Check if "  cleo:" block exists under extensions
    if echo "$existing" | grep -q '^  cleo:'; then
        # Replace existing cleo block: remove old section and insert new
        local in_cleo=false
        local result=""
        while IFS= read -r line; do
            if [[ "$line" == "  cleo:" ]]; then
                in_cleo=true
                result+="$block"$'\n'
                continue
            fi
            if [[ "$in_cleo" == "true" ]]; then
                # Check if we hit a new top-level extension (2-space indent key)
                if [[ "$line" =~ ^\ \ [a-zA-Z] && ! "$line" =~ ^\ \ \ \  ]]; then
                    in_cleo=false
                    result+="$line"$'\n'
                fi
                # Skip lines in old cleo section
                continue
            fi
            result+="$line"$'\n'
        done <<< "$existing"
        printf '%s' "$result"
    elif echo "$existing" | grep -q '^extensions:'; then
        # extensions section exists but no cleo block - append under it
        local result=""
        while IFS= read -r line; do
            result+="$line"$'\n'
            if [[ "$line" == "extensions:" ]]; then
                result+="$block"$'\n'
            fi
        done <<< "$existing"
        printf '%s' "$result"
    else
        # No extensions section - append both
        printf '%s\nextensions:\n%s\n' "$existing" "$block"
    fi
}

# ============================================================================
# BACKUP
# ============================================================================

# Backup an external config file before modification
# Args: $1 = file path
# Output: backup file path
# Returns: 0 on success, 1 on failure
mcp_backup_external_file() {
    local file_path="$1"

    if [[ ! -f "$file_path" ]]; then
        return 0  # Nothing to backup
    fi

    local timestamp
    timestamp=$(date +%Y%m%d_%H%M%S)
    local backup_path="${file_path}.cleo-backup.${timestamp}"

    if cp "$file_path" "$backup_path" 2>/dev/null; then
        echo "$backup_path"
        return 0
    else
        echo "ERROR: Failed to create backup of $file_path" >&2
        return 1
    fi
}

# ============================================================================
# WRITE CONFIG
# ============================================================================

# Write MCP config for a specific tool
# Args: $1 = tool key, $2 = scope (project|global), $3 = mode (npx|local),
#        $4 = project_root, $5 = dry_run (true|false)
# Output: JSON result object
# Returns: 0 on success, 1 on failure
mcp_write_config() {
    local key="$1"
    local scope="${2:-project}"
    local mode="${3:-npx}"
    local project_root="${4:-$(pwd)}"
    local dry_run="${5:-false}"

    local config_path
    config_path=$(_mcp_get_config_path "$key" "$scope")

    if [[ -z "$config_path" ]]; then
        echo "ERROR: Unknown tool key: $key" >&2
        return 1
    fi

    local format
    format=$(_mcp_format "$key")
    local config_key
    config_key=$(_mcp_config_key "$key")

    # Generate the entry
    local entry
    entry=$(mcp_generate_entry "$mode" "$project_root")

    # Handle Goose YAML format separately
    if [[ "$format" == "goose" ]]; then
        local existing_content=""
        if [[ -f "$config_path" ]]; then
            existing_content=$(cat "$config_path")
        fi

        local new_content
        new_content=$(_mcp_merge_goose_yaml "$existing_content" "$entry")

        if [[ "$dry_run" == "true" ]]; then
            jq -nc \
                --arg key "$key" \
                --arg path "$config_path" \
                --arg content "$new_content" \
                '{tool: $key, path: $path, action: "dry_run", content: $content}'
            return 0
        fi

        # Backup existing file
        local backup_path=""
        if [[ -f "$config_path" ]]; then
            backup_path=$(mcp_backup_external_file "$config_path") || return 1
        fi

        # Create parent directory if needed
        local parent_dir
        parent_dir=$(dirname "$config_path")
        mkdir -p "$parent_dir" 2>/dev/null || {
            echo "ERROR: Cannot create directory: $parent_dir" >&2
            return 1
        }

        # Write the file
        printf '%s\n' "$new_content" > "$config_path" || {
            echo "ERROR: Failed to write $config_path" >&2
            return 1
        }

        jq -nc \
            --arg key "$key" \
            --arg path "$config_path" \
            --arg backup "${backup_path:-}" \
            '{tool: $key, path: $path, action: "written", backup: $backup}'
        return 0
    fi

    # Handle Codex TOML format separately
    if [[ "$format" == "codex" ]]; then
        local existing_content=""
        if [[ -f "$config_path" ]]; then
            existing_content=$(cat "$config_path")
        fi

        local new_content
        new_content=$(_mcp_merge_codex_toml "$existing_content" "$entry")

        if [[ "$dry_run" == "true" ]]; then
            jq -nc \
                --arg key "$key" \
                --arg path "$config_path" \
                --arg content "$new_content" \
                '{tool: $key, path: $path, action: "dry_run", content: $content}'
            return 0
        fi

        # Backup existing file
        local backup_path=""
        if [[ -f "$config_path" ]]; then
            backup_path=$(mcp_backup_external_file "$config_path") || return 1
        fi

        # Create parent directory if needed
        local parent_dir
        parent_dir=$(dirname "$config_path")
        mkdir -p "$parent_dir" 2>/dev/null || {
            echo "ERROR: Cannot create directory: $parent_dir" >&2
            return 1
        }

        # Write the file
        printf '%s\n' "$new_content" > "$config_path" || {
            echo "ERROR: Failed to write $config_path" >&2
            return 1
        }

        jq -nc \
            --arg key "$key" \
            --arg path "$config_path" \
            --arg backup "${backup_path:-}" \
            '{tool: $key, path: $path, action: "written", backup: $backup}'
        return 0
    fi

    # JSON formats: read existing, validate, merge, write
    local existing_content=""
    local is_jsonc=false
    local jsonc_header=""
    if [[ -f "$config_path" ]]; then
        existing_content=$(cat "$config_path")
        # Try plain JSON first
        if ! echo "$existing_content" | jq empty 2>/dev/null; then
            # JSONC handling: strip comments safely
            # 1. Capture leading comment lines (// at start of line) as header
            # 2. Strip all whole-line // comments
            # 3. Strip trailing commas before } or ]
            # SAFETY: never strip // from mid-line (would break URLs in strings)
            local stripped
            stripped=$(
                sed 's|^\s*//.*$||' "$config_path" |    # Remove whole-line // comments
                sed 's|^\s*/\*.*\*/\s*$||' |            # Remove single-line /* */ comments
                sed '/^$/d' |                            # Remove blank lines
                sed 's/,\(\s*[}\]]\)/\1/g'              # Remove trailing commas
            )
            if echo "$stripped" | jq empty 2>/dev/null; then
                is_jsonc=true
                # Capture the comment header (consecutive // lines at top of file)
                jsonc_header=$(sed -n '/^\s*\/\//p; /^\s*\/\//!q' "$config_path")
                existing_content="$stripped"
            else
                echo "ERROR: Existing config is not valid JSON or JSONC: $config_path" >&2
                echo "Please fix the file manually before running mcp-install." >&2
                return 1
            fi
        fi
    fi

    # Merge based on format
    local merged
    case "$format" in
        standard)
            merged=$(_mcp_merge_standard "$existing_content" "$entry" "$config_key")
            ;;
        opencode)
            merged=$(_mcp_merge_opencode "$existing_content" "$entry")
            ;;
        vscode)
            merged=$(_mcp_merge_vscode "$existing_content" "$entry")
            ;;
        zed)
            merged=$(_mcp_merge_zed "$existing_content" "$entry")
            ;;
        *)
            echo "ERROR: Unknown format: $format" >&2
            return 1
            ;;
    esac

    # Validate merged output
    if ! echo "$merged" | jq empty 2>/dev/null; then
        echo "ERROR: Merge produced invalid JSON for $key" >&2
        return 1
    fi

    # Idempotency safety: verify we only added/updated the cleo key
    if [[ -n "$existing_content" && "$existing_content" != "{}" ]]; then
        # Count top-level keys before and after
        local keys_before keys_after
        keys_before=$(echo "$existing_content" | jq 'keys | length' 2>/dev/null || echo 0)
        keys_after=$(echo "$merged" | jq 'keys | length' 2>/dev/null || echo 0)
        # After merge should have same or +1 top-level keys (if config_key was new)
        if [[ "$keys_after" -lt "$keys_before" ]]; then
            echo "ERROR: Merge lost top-level keys for $key ($keys_before -> $keys_after). Aborting." >&2
            return 1
        fi
        # Verify the config section preserved all non-cleo entries
        local section_keys_before section_keys_after
        section_keys_before=$(echo "$existing_content" | jq --arg k "$config_key" 'if has($k) then .[$k] | del(.cleo) | keys | length else 0 end' 2>/dev/null || echo 0)
        section_keys_after=$(echo "$merged" | jq --arg k "$config_key" 'if has($k) then .[$k] | del(.cleo) | keys | length else 0 end' 2>/dev/null || echo 0)
        if [[ "$section_keys_after" -lt "$section_keys_before" ]]; then
            echo "ERROR: Merge lost entries in $config_key for $key. Aborting." >&2
            return 1
        fi
    fi

    # Pretty-print
    merged=$(echo "$merged" | jq '.')

    # Re-attach JSONC comment header if present
    local write_content="$merged"
    if [[ "$is_jsonc" == "true" && -n "$jsonc_header" ]]; then
        write_content=$(printf '%s\n%s' "$jsonc_header" "$merged")
    fi

    if [[ "$dry_run" == "true" ]]; then
        jq -nc \
            --arg key "$key" \
            --arg path "$config_path" \
            --arg content "$write_content" \
            '{tool: $key, path: $path, action: "dry_run", content: $content}'
        return 0
    fi

    # Backup existing file
    local backup_path=""
    if [[ -f "$config_path" ]]; then
        backup_path=$(mcp_backup_external_file "$config_path") || return 1
    fi

    # Create parent directory if needed
    local parent_dir
    parent_dir=$(dirname "$config_path")
    mkdir -p "$parent_dir" 2>/dev/null || {
        echo "ERROR: Cannot create directory: $parent_dir" >&2
        return 1
    }

    # Write the file
    printf '%s\n' "$write_content" > "$config_path" || {
        echo "ERROR: Failed to write $config_path" >&2
        return 1
    }

    jq -nc \
        --arg key "$key" \
        --arg path "$config_path" \
        --arg backup "${backup_path:-}" \
        '{tool: $key, path: $path, action: "written", backup: $backup}'
    return 0
}

# ============================================================================
# UTILITY ACCESSORS
# ============================================================================

# Get all tool keys
mcp_get_tool_keys() {
    printf '%s\n' "${MCP_TOOL_KEYS[@]}"
}

# Get display name for a tool
# Args: $1 = tool key
mcp_get_tool_display_name() {
    _mcp_display_name "$1"
}

# Get format for a tool
# Args: $1 = tool key
mcp_get_tool_format() {
    _mcp_format "$1"
}

# Get config key for a tool
# Args: $1 = tool key
mcp_get_tool_config_key() {
    _mcp_config_key "$1"
}

# Get config path for a tool
# Args: $1 = tool key, $2 = scope
mcp_get_config_path() {
    _mcp_get_config_path "$1" "${2:-project}"
}

# Check if tool has dual scope
# Args: $1 = tool key
mcp_has_dual_scope() {
    _mcp_has_dual_scope "$1"
}

# ============================================================================
# EXPORTS
# ============================================================================

# Internal registry lookups (must be exported for subshell use)
export -f _mcp_display_name
export -f _mcp_format
export -f _mcp_config_key
export -f _mcp_binary
export -f _mcp_config_dir
export -f _mcp_app_bundle
export -f _mcp_flatpak_id
export -f _mcp_get_config_path
export -f _mcp_has_dual_scope
export -f _mcp_merge_standard
export -f _mcp_merge_opencode
export -f _mcp_merge_vscode
export -f _mcp_merge_zed
export -f _mcp_generate_codex_toml_block
export -f _mcp_merge_codex_toml
export -f _mcp_generate_goose_yaml_block
export -f _mcp_merge_goose_yaml

# Public API
export -f mcp_detect_tool
export -f mcp_detect_all_tools
export -f mcp_generate_entry
export -f mcp_write_config
export -f mcp_backup_external_file
export -f mcp_get_tool_keys
export -f mcp_get_tool_display_name
export -f mcp_get_tool_format
export -f mcp_get_tool_config_key
export -f mcp_get_config_path
export -f mcp_has_dual_scope
