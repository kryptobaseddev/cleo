#!/usr/bin/env bash
###CLEO
# command: mcp-install
# category: maintenance
# synopsis: Auto-detect AI tools and configure CLEO MCP server integration
# relevance: medium
# flags: --tool,--mode,--global,--project,--all,--dry-run,--force,--json,--human,--list-tools,--format
# exits: 0,1,2
# json-output: true
###END
# @task T4248
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LIB_DIR="$PROJECT_ROOT/lib"

# Source libraries
source "$LIB_DIR/mcp-config.sh"

# ============================================================================
# DEFAULTS
# ============================================================================

TOOL=""
MODE="npx"
SCOPE=""
ALL=false
DRY_RUN=false
FORCE=false
FORMAT="${FORMAT:-text}"
LIST_TOOLS=false

# ============================================================================
# USAGE
# ============================================================================

show_usage() {
    cat <<'EOF'
Usage: cleo mcp-install [OPTIONS]

Auto-detect installed AI tools and configure CLEO MCP server integration.

Options:
  --tool <name>    Configure a single tool (e.g., claude-code, cursor, vscode)
  --mode <mode>    Install mode: npx (default) or local
  --global         Use global/user config scope
  --project        Use project-level config scope (default for dual-scope tools)
  --all            Configure all detected tools without prompting
  --dry-run        Preview changes without writing files
  --force          Skip confirmation prompts
  --list-tools     Show all supported tools and exit
  --json           Output in JSON format
  --human          Output in human-readable format (default)
  -h, --help       Show this help message

Examples:
  cleo mcp-install                                    # Interactive: detect and configure
  cleo mcp-install --all                              # Configure all detected tools
  cleo mcp-install --tool claude-code --mode npx      # Configure Claude Code with npx
  cleo mcp-install --tool vscode --project --dry-run  # Preview VS Code project config
  cleo mcp-install --list-tools --json                # List supported tools as JSON

Supported Tools:
  claude-code, claude-desktop, cursor, gemini-cli, kimi, antigravity,
  windsurf, goose, opencode, vscode, zed, codex
EOF
}

# ============================================================================
# FLAG PARSING
# ============================================================================

while [[ $# -gt 0 ]]; do
    case "$1" in
        --tool)
            TOOL="$2"
            shift 2
            ;;
        --mode)
            MODE="$2"
            shift 2
            ;;
        --global)
            SCOPE="global"
            shift
            ;;
        --project)
            SCOPE="project"
            shift
            ;;
        --all)
            ALL=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --force)
            FORCE=true
            shift
            ;;
        --json|--format=json)
            FORMAT="json"
            shift
            ;;
        --human|--format=human|--format=text)
            FORMAT="text"
            shift
            ;;
        --format)
            FORMAT="$2"
            shift 2
            ;;
        --list-tools)
            LIST_TOOLS=true
            shift
            ;;
        -h|--help)
            show_usage
            exit 0
            ;;
        *)
            echo "ERROR: Unknown option: $1" >&2
            echo "Run 'cleo mcp-install --help' for usage." >&2
            exit 2
            ;;
    esac
done

# Validate mode
if [[ "$MODE" != "npx" && "$MODE" != "local" ]]; then
    echo "ERROR: Invalid mode '$MODE'. Use 'npx' or 'local'." >&2
    exit 2
fi

# If local mode, verify the MCP server is built
if [[ "$MODE" == "local" ]]; then
    local_dist="$PROJECT_ROOT/mcp-server/dist/index.js"
    if [[ ! -f "$local_dist" ]]; then
        echo "Building MCP server for local mode..." >&2
        if (cd "$PROJECT_ROOT/mcp-server" && npm install --silent && npm run build --silent) 2>/dev/null; then
            echo "Build complete." >&2
        else
            echo "ERROR: Failed to build MCP server. Run: cd mcp-server && npm install && npm run build" >&2
            exit 1
        fi
    fi
fi

# ============================================================================
# LIST TOOLS
# ============================================================================

if [[ "$LIST_TOOLS" == "true" ]]; then
    if [[ "$FORMAT" == "json" ]]; then
        tools_json="[]"
        for key in $(mcp_get_tool_keys); do
            config_path=$(mcp_get_config_path "$key" "project")
            dual_scope=false
            if mcp_has_dual_scope "$key"; then
                dual_scope=true
            fi
            tools_json=$(echo "$tools_json" | jq \
                --arg key "$key" \
                --arg name "$(mcp_get_tool_display_name "$key")" \
                --arg format "$(mcp_get_tool_format "$key")" \
                --arg config_key "$(mcp_get_tool_config_key "$key")" \
                --arg config_path "$config_path" \
                --argjson dual_scope "$dual_scope" \
                '. += [{key: $key, name: $name, format: $format, configKey: $config_key, configPath: $config_path, dualScope: $dual_scope}]')
        done
        echo "$tools_json" | jq '.'
    else
        printf "%-16s %-16s %-10s %s\n" "KEY" "NAME" "FORMAT" "CONFIG PATH"
        printf "%-16s %-16s %-10s %s\n" "---" "----" "------" "-----------"
        for key in $(mcp_get_tool_keys); do
            printf "%-16s %-16s %-10s %s\n" \
                "$key" \
                "$(mcp_get_tool_display_name "$key")" \
                "$(mcp_get_tool_format "$key")" \
                "$(mcp_get_config_path "$key" "project")"
        done
    fi
    exit 0
fi

# ============================================================================
# SINGLE TOOL MODE
# ============================================================================

if [[ -n "$TOOL" ]]; then
    # Validate tool key
    valid=false
    for key in $(mcp_get_tool_keys); do
        if [[ "$key" == "$TOOL" ]]; then
            valid=true
            break
        fi
    done

    if [[ "$valid" == "false" ]]; then
        echo "ERROR: Unknown tool '$TOOL'. Run 'cleo mcp-install --list-tools' to see supported tools." >&2
        exit 2
    fi

    # Determine scope
    if [[ -z "$SCOPE" ]]; then
        if mcp_has_dual_scope "$TOOL"; then
            SCOPE="project"
        else
            SCOPE="global"
        fi
    fi

    config_path=$(mcp_get_config_path "$TOOL" "$SCOPE")

    # Confirmation
    if [[ "$FORCE" == "false" && "$DRY_RUN" == "false" ]]; then
        echo "Will configure $(mcp_get_tool_display_name "$TOOL") ($SCOPE scope)"
        echo "  Mode: $MODE"
        echo "  Config: $config_path"
        if [[ -f "$config_path" ]]; then
            echo "  Note: Existing config will be backed up before modification"
        fi
        echo ""
        read -r -p "Proceed? [Y/n] " confirm
        if [[ "$confirm" =~ ^[Nn] ]]; then
            echo "Aborted."
            exit 0
        fi
    fi

    result=$(mcp_write_config "$TOOL" "$SCOPE" "$MODE" "$PROJECT_ROOT" "$DRY_RUN")
    exit_code=$?

    if [[ $exit_code -ne 0 ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            jq -nc --arg tool "$TOOL" --arg error "Configuration failed" \
                '{success: false, tool: $tool, error: $error}'
        else
            echo "ERROR: Failed to configure $(mcp_get_tool_display_name "$TOOL")" >&2
        fi
        exit 1
    fi

    if [[ "$FORMAT" == "json" ]]; then
        echo "$result" | jq '{success: true} + .'
    else
        action=$(echo "$result" | jq -r '.action')
        path=$(echo "$result" | jq -r '.path')
        backup=$(echo "$result" | jq -r '.backup // empty')

        if [[ "$action" == "dry_run" ]]; then
            echo "[DRY RUN] Would write to: $path"
            echo ""
            echo "Content:"
            echo "$result" | jq -r '.content'
        else
            echo "Configured $(mcp_get_tool_display_name "$TOOL") ($SCOPE scope)"
            echo "  Written: $path"
            if [[ -n "$backup" ]]; then
                echo "  Backup: $backup"
            fi
        fi
    fi
    exit 0
fi

# ============================================================================
# DETECTION PHASE
# ============================================================================

detected_json=$(mcp_detect_all_tools)
detected_count=$(echo "$detected_json" | jq 'length')

if [[ "$detected_count" -eq 0 ]]; then
    if [[ "$FORMAT" == "json" ]]; then
        jq -nc '{success: true, detected: 0, tools: [], message: "No supported AI tools detected"}'
    else
        echo "No supported AI tools detected on this system."
        echo "Run 'cleo mcp-install --list-tools' to see supported tools."
        echo "Run 'cleo mcp-install --tool <name>' to configure a specific tool manually."
    fi
    exit 0
fi

# ============================================================================
# INTERACTIVE / AUTO MODE
# ============================================================================

if [[ "$ALL" == "true" || "$FORCE" == "true" ]]; then
    # Non-interactive: configure all detected tools
    selected_json="$detected_json"
else
    # Interactive: show detected tools and let user select
    echo "Detected AI tools:"
    echo ""
    for i in $(seq 0 $((detected_count - 1))); do
        tool_key=$(echo "$detected_json" | jq -r ".[$i].key")
        tool_name=$(echo "$detected_json" | jq -r ".[$i].name")
        tool_method=$(echo "$detected_json" | jq -r ".[$i].method")
        tool_existing=$(echo "$detected_json" | jq -r ".[$i].hasExisting")

        status=""
        if [[ "$tool_existing" == "true" ]]; then
            status=" (config exists)"
        fi

        printf "  [%d] %-16s  detected via: %s%s\n" "$((i + 1))" "$tool_name" "$tool_method" "$status"
    done
    echo ""

    read -r -p "Configure all? [Y/n/select] " answer
    case "$answer" in
        [Nn])
            echo "Aborted."
            exit 0
            ;;
        [Ss]|select)
            echo "Enter tool numbers (comma-separated, e.g., 1,3,5):"
            read -r selections
            selected_json="[]"
            IFS=',' read -ra nums <<< "$selections"
            for num in "${nums[@]}"; do
                num=$(echo "$num" | tr -d ' ')
                idx=$((num - 1))
                if [[ $idx -ge 0 && $idx -lt $detected_count ]]; then
                    tool_entry=$(echo "$detected_json" | jq ".[$idx]")
                    selected_json=$(echo "$selected_json" | jq --argjson t "$tool_entry" '. += [$t]')
                fi
            done
            ;;
        *)
            selected_json="$detected_json"
            ;;
    esac
fi

selected_count=$(echo "$selected_json" | jq 'length')

if [[ "$selected_count" -eq 0 ]]; then
    echo "No tools selected."
    exit 0
fi

# ============================================================================
# CONFIGURATION PHASE
# ============================================================================

results="[]"
errors=0

for i in $(seq 0 $((selected_count - 1))); do
    tool_key=$(echo "$selected_json" | jq -r ".[$i].key")
    tool_name=$(echo "$selected_json" | jq -r ".[$i].name")
    tool_dual=$(echo "$selected_json" | jq -r ".[$i].dualScope")

    # Determine scope for this tool
    tool_scope="$SCOPE"
    if [[ -z "$tool_scope" ]]; then
        if [[ "$tool_dual" == "true" ]]; then
            tool_scope="project"
        else
            tool_scope="global"
        fi
    fi

    config_path=$(mcp_get_config_path "$tool_key" "$tool_scope")

    if [[ "$FORMAT" != "json" && "$DRY_RUN" == "false" ]]; then
        printf "Configuring %-16s ... " "$tool_name"
    fi

    result=$(mcp_write_config "$tool_key" "$tool_scope" "$MODE" "$PROJECT_ROOT" "$DRY_RUN" 2>&1) || {
        if [[ "$FORMAT" != "json" ]]; then
            echo "FAILED"
            echo "  Error: $result" >&2
        fi
        results=$(echo "$results" | jq \
            --arg key "$tool_key" \
            --arg error "$result" \
            '. += [{tool: $key, success: false, error: $error}]')
        ((errors++))
        continue
    }

    if [[ "$FORMAT" != "json" ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            echo "[DRY RUN]"
            echo "  Would write: $config_path"
        else
            echo "OK"
            backup=$(echo "$result" | jq -r '.backup // empty' 2>/dev/null)
            echo "  Written: $config_path"
            if [[ -n "$backup" ]]; then
                echo "  Backup: $backup"
            fi
        fi
    fi

    results=$(echo "$results" | jq --argjson r "$result" '. += [$r + {success: true}]')
done

# ============================================================================
# SUMMARY
# ============================================================================

if [[ "$FORMAT" == "json" ]]; then
    jq -nc \
        --argjson detected "$detected_json" \
        --argjson results "$results" \
        --argjson errors "$errors" \
        --arg mode "$MODE" \
        --argjson dry_run "$DRY_RUN" \
        '{
            success: ($errors == 0),
            mode: $mode,
            dryRun: $dry_run,
            detected: ($detected | length),
            configured: ([$results[] | select(.success == true)] | length),
            errors: $errors,
            tools: $results
        }'
else
    echo ""
    configured=$((selected_count - errors))
    if [[ "$DRY_RUN" == "true" ]]; then
        echo "Dry run complete: $configured tool(s) would be configured"
    else
        echo "Done: $configured tool(s) configured"
    fi
    if [[ $errors -gt 0 ]]; then
        echo "Errors: $errors tool(s) failed"
    fi
fi

if [[ $errors -gt 0 ]]; then
    exit 1
fi
exit 0
