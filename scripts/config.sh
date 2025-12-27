#!/usr/bin/env bash
# Configuration management for cleo
# Usage: cleo config <subcommand> [args] [options]
#
# Subcommands:
#   show [PATH]      Show config values (all, section, or single key)
#   set PATH VALUE   Update a config value
#   get PATH         Get a single config value (JSON output)
#   list             List all config keys with values
#   reset [SECTION]  Reset config to defaults
#   edit             Interactive config editor
#   validate         Validate config against schema
#
# Options:
#   --global         Target global config (~/.cleo/config.json)
#   --format FMT     Output format: text (default) or json
#   --json           Shorthand for --format json
#   --human          Shorthand for --format text
#   --dry-run        Preview changes without applying
#   --quiet          Suppress non-essential output
#
# Version: 0.17.0

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(dirname "$SCRIPT_DIR")/lib"

# Source version library for proper version management
if [[ -f "$LIB_DIR/version.sh" ]]; then
  # shellcheck source=../lib/version.sh
  source "$LIB_DIR/version.sh"
fi

# Source version from central location (fallback)
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"
if [[ -f "$CLEO_HOME/VERSION" ]]; then
  VERSION="$(cat "$CLEO_HOME/VERSION" | tr -d '[:space:]')"
elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
  VERSION="$(cat "$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')"
else
  VERSION="unknown"
fi

# Source libraries (with defensive checks)
if [[ -f "$LIB_DIR/platform-compat.sh" ]]; then
  source "$LIB_DIR/platform-compat.sh"
fi
if [[ -f "$LIB_DIR/output-format.sh" ]]; then
  source "$LIB_DIR/output-format.sh"
fi
if [[ -f "$LIB_DIR/exit-codes.sh" ]]; then
  source "$LIB_DIR/exit-codes.sh"
fi
if [[ -f "$LIB_DIR/error-json.sh" ]]; then
  source "$LIB_DIR/error-json.sh"
fi
if [[ -f "$LIB_DIR/config.sh" ]]; then
  source "$LIB_DIR/config.sh"
fi

# Command identification
COMMAND_NAME="config"

# ============================================================================
# DEFAULTS
# ============================================================================

FORMAT=""
QUIET=false
DRY_RUN=false
SCOPE="project"  # project or global

# ============================================================================
# USAGE
# ============================================================================

usage() {
    cat << 'EOF'
Usage: cleo config <subcommand> [args] [options]

View and modify cleo configuration settings.

Subcommands:
  show [PATH]      Show config values
                   - No args: show all settings
                   - Section: show output, show archive
                   - Full path: show output.defaultFormat

  set PATH VALUE   Update a config value
                   Examples:
                     config set output.defaultFormat json
                     config set archive.daysUntilArchive 14
                     config set validation.strictMode true

  get PATH         Get a single value (useful for scripting)
                   Example: config get output.defaultFormat

  list             List all config keys with current values

  reset [SECTION]  Reset to defaults
                   - No args: reset entire config
                   - Section: reset output, reset archive

  edit             Launch interactive config editor

  validate         Validate config against schema

Options:
  --global         Target global config (~/.cleo/config.json)
                   instead of project config (.cleo/config.json)
  -f, --format FMT Output format: text (default in TTY) or json
  --json           Shorthand for --format json
  --human          Shorthand for --format text
  --dry-run        Preview changes without applying
  -q, --quiet      Suppress non-essential output
  -h, --help       Show this help message

Priority Hierarchy:
  CLI flags > Environment vars > Project config > Global config > Defaults

Environment Variables:
  CLAUDE_TODO_FORMAT                 Output format override
  CLAUDE_TODO_OUTPUT_SHOW_COLOR      Enable/disable colors
  CLAUDE_TODO_ARCHIVE_ENABLED        Enable/disable archiving
  CLAUDE_TODO_VALIDATION_STRICT_MODE Enable strict validation
  (See docs/reference/configuration.md for full list)

Examples:
  cleo config show                    # Show all config
  cleo config show output             # Show output section
  cleo config set output.defaultFormat json
  cleo config set output.showColor false --global
  cleo config edit                    # Interactive editor
  cleo config reset output            # Reset output to defaults
  cleo config validate                # Check config validity

JSON Output Format:
  {
    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
    "_meta": {"command": "config", "timestamp": "..."},
    "success": true,
    "scope": "project",
    "config": { ... }
  }
EOF
}

# ============================================================================
# OUTPUT HELPERS
# ============================================================================

output_json() {
    local data="$1"
    local timestamp
    timestamp=$(get_iso_timestamp 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")

    jq -n \
        --arg version "${CLEO_VERSION:-$(get_version)}" \
        --arg scope "$SCOPE" \
        --arg ts "$timestamp" \
        --argjson data "$data" \
        '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
                "format": "json",
                "version": $version,
                "command": "config",
                "timestamp": $ts,
                "scope": $scope
            },
            "success": true,
            "config": $data
        }'
}

output_change_json() {
    local path="$1"
    local old_value="$2"
    local new_value="$3"
    local timestamp
    timestamp=$(get_iso_timestamp 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")

    jq -n \
        --arg version "${CLEO_VERSION:-$(get_version)}" \
        --arg scope "$SCOPE" \
        --arg ts "$timestamp" \
        --arg path "$path" \
        --arg old "$old_value" \
        --arg new "$new_value" \
        '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
                "format": "json",
                "version": $version,
                "command": "config set",
                "timestamp": $ts,
                "scope": $scope
            },
            "success": true,
            "path": $path,
            "previous": $old,
            "value": $new
        }'
}

get_config_file() {
    if [[ "$SCOPE" == "global" ]]; then
        echo "$GLOBAL_CONFIG_FILE"
    else
        echo "$PROJECT_CONFIG_FILE"
    fi
}

# ============================================================================
# SUBCOMMANDS
# ============================================================================

# Show config values
cmd_show() {
    local path="${1:-}"
    local config_file
    config_file=$(get_config_file)

    if ! config_file_exists "$config_file"; then
        output_error "E_FILE_NOT_FOUND" "Config file not found: $config_file" $EXIT_FILE_ERROR true \
            "Run 'cleo init' to create project config or install to create global config"
        exit $EXIT_FILE_ERROR
    fi

    local config_data

    if [[ -z "$path" ]]; then
        # Show all config
        config_data=$(cat "$config_file")
    elif [[ "$path" =~ \. ]]; then
        # Full path (e.g., output.defaultFormat)
        local jq_filter=".${path}"
        config_data=$(jq "$jq_filter // null" "$config_file")
    else
        # Section (e.g., output)
        config_data=$(jq ".${path} // null" "$config_file")
    fi

    if [[ "$FORMAT" == "json" ]]; then
        output_json "$config_data"
    else
        if [[ -z "$path" ]]; then
            echo "Configuration ($SCOPE): $config_file"
            echo ""
            jq -C '.' "$config_file"
        elif [[ "$config_data" == "null" ]]; then
            echo "Key not found: $path"
            return 1
        else
            echo "$path = $(echo "$config_data" | jq -r '.')"
        fi
    fi
}

# Get single config value
cmd_get() {
    local path="${1:-}"

    if [[ -z "$path" ]]; then
        output_error "E_INPUT_MISSING" "Config path required" $EXIT_INVALID_INPUT true \
            "Example: config get output.defaultFormat"
        exit $EXIT_INVALID_INPUT
    fi

    local value
    value=$(get_config_value "$path" "")

    if [[ "$FORMAT" == "json" ]]; then
        local timestamp
        timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        jq -n \
            --arg path "$path" \
            --arg value "$value" \
            --arg timestamp "$timestamp" \
            --arg version "${CLEO_VERSION:-$(get_version)}" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "version": $version,
                    "command": "config get",
                    "timestamp": $timestamp
                },
                "success": true,
                "path": $path,
                "value": $value
            }'
    else
        echo "$value"
    fi
}

# Set config value
cmd_set() {
    local path="${1:-}"
    local value="${2:-}"

    if [[ -z "$path" ]] || [[ -z "$value" ]]; then
        output_error "E_INPUT_MISSING" "Both path and value are required" $EXIT_INVALID_INPUT true \
            "Example: config set output.defaultFormat json"
        exit $EXIT_INVALID_INPUT
    fi

    local config_file
    config_file=$(get_config_file)

    if ! config_file_exists "$config_file"; then
        output_error "E_FILE_NOT_FOUND" "Config file not found: $config_file" $EXIT_FILE_ERROR true \
            "Run 'cleo init' to create project config"
        exit $EXIT_FILE_ERROR
    fi

    # Get current value
    local old_value
    old_value=$(read_config_file "$config_file" "$path" 2>/dev/null || echo "null")

    # Determine value type
    local value_type="string"
    if [[ "$value" == "true" ]] || [[ "$value" == "false" ]]; then
        value_type="boolean"
    elif [[ "$value" =~ ^-?[0-9]+$ ]]; then
        value_type="number"
    fi

    if [[ "$DRY_RUN" == true ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            jq -n \
                --arg path "$path" \
                --arg old "$old_value" \
                --arg new "$value" \
                '{
                    "dryRun": true,
                    "path": $path,
                    "currentValue": $old,
                    "newValue": $new,
                    "message": "No changes made"
                }'
        else
            echo "[DRY RUN] Would change $path:"
            echo "  From: $old_value"
            echo "  To:   $value"
        fi
        return 0
    fi

    # Apply change
    if set_config_value "$path" "$value" "$SCOPE" "$value_type"; then
        if [[ "$FORMAT" == "json" ]]; then
            output_change_json "$path" "$old_value" "$value"
        else
            [[ "$QUIET" != true ]] && echo "Updated $path: $old_value -> $value"
        fi
    else
        output_error "E_FILE_WRITE_ERROR" "Failed to update config" $EXIT_FILE_ERROR false
        exit $EXIT_FILE_ERROR
    fi
}

# List all config keys
cmd_list() {
    local config_file
    config_file=$(get_config_file)

    if ! config_file_exists "$config_file"; then
        output_error "E_FILE_NOT_FOUND" "Config file not found: $config_file" $EXIT_FILE_ERROR true \
            "Run 'cleo init' to create project config"
        exit $EXIT_FILE_ERROR
    fi

    if [[ "$FORMAT" == "json" ]]; then
        local config_data
        config_data=$(cat "$config_file")
        output_json "$config_data"
    else
        echo "Configuration ($SCOPE): $config_file"
        echo ""
        # Flatten and list all keys
        jq -r 'paths(scalars) as $p | "\($p | join(".")) = \(getpath($p))"' "$config_file" | sort
    fi
}

# Reset config to defaults
cmd_reset() {
    local section="${1:-}"
    local config_file
    config_file=$(get_config_file)

    if ! config_file_exists "$config_file"; then
        output_error "E_FILE_NOT_FOUND" "Config file not found: $config_file" $EXIT_FILE_ERROR true
        exit $EXIT_FILE_ERROR
    fi

    local template_file
    if [[ "$SCOPE" == "global" ]]; then
        template_file="${GLOBAL_CONFIG_DIR}/templates/global-config.template.json"
    else
        template_file="${CLEO_HOME:-$HOME/.cleo}/templates/config.template.json"
    fi

    if [[ ! -f "$template_file" ]]; then
        output_error "E_FILE_NOT_FOUND" "Template file not found: $template_file" $EXIT_FILE_ERROR false
        exit $EXIT_FILE_ERROR
    fi

    if [[ "$DRY_RUN" == true ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            jq -n --arg section "$section" '{"dryRun": true, "section": (if $section == "" then "all" else $section end), "message": "Would reset to defaults"}'
        else
            echo "[DRY RUN] Would reset ${section:-entire config} to defaults"
        fi
        return 0
    fi

    if [[ -z "$section" ]]; then
        # Reset entire config
        cp "$template_file" "$config_file"
        [[ "$QUIET" != true ]] && echo "Reset entire config to defaults"
    else
        # Reset just one section
        local default_section
        default_section=$(jq ".${section}" "$template_file")

        if [[ "$default_section" == "null" ]]; then
            output_error "E_INPUT_INVALID" "Unknown section: $section" $EXIT_INVALID_INPUT true
            exit $EXIT_INVALID_INPUT
        fi

        local temp_file
        temp_file=$(mktemp)
        jq ".${section} = ${default_section}" "$config_file" > "$temp_file" && mv "$temp_file" "$config_file"
        [[ "$QUIET" != true ]] && echo "Reset '$section' section to defaults"
    fi

    if [[ "$FORMAT" == "json" ]]; then
        output_json "$(cat "$config_file")"
    fi
}

# Validate config
cmd_validate() {
    local config_file
    config_file=$(get_config_file)

    if ! config_file_exists "$config_file"; then
        output_error "E_FILE_NOT_FOUND" "Config file not found: $config_file" $EXIT_FILE_ERROR true
        exit $EXIT_FILE_ERROR
    fi

    local valid=true
    local errors=()

    # Basic JSON validation
    if ! jq -e '.' "$config_file" >/dev/null 2>&1; then
        valid=false
        errors+=("Invalid JSON syntax")
    fi

    # Check required fields
    local version
    version=$(jq -r '.version // empty' "$config_file")
    if [[ -z "$version" ]]; then
        valid=false
        errors+=("Missing required field: version")
    fi

    # Schema validation if available
    local schema_file
    if [[ "$SCOPE" == "global" ]]; then
        schema_file="${GLOBAL_CONFIG_DIR}/schemas/global-config.schema.json"
    else
        schema_file="${CLEO_HOME:-$HOME/.cleo}/schemas/config.schema.json"
    fi

    if command -v jsonschema &>/dev/null && [[ -f "$schema_file" ]]; then
        local schema_output
        if ! schema_output=$(jsonschema -i "$config_file" "$schema_file" 2>&1); then
            valid=false
            errors+=("Schema validation failed: $schema_output")
        fi
    fi

    if [[ "$FORMAT" == "json" ]]; then
        if [[ "$valid" == true ]]; then
            jq -n '{"valid": true, "errors": []}'
        else
            jq -n --argjson errs "$(printf '%s\n' "${errors[@]}" | jq -R . | jq -s .)" '{"valid": false, "errors": $errs}'
        fi
    else
        if [[ "$valid" == true ]]; then
            echo "Config is valid: $config_file"
        else
            echo "Config validation failed: $config_file"
            for err in "${errors[@]}"; do
                echo "  - $err"
            done
            exit $EXIT_VALIDATION_ERROR
        fi
    fi
}

# Interactive config editor
cmd_edit() {
    local config_file
    config_file=$(get_config_file)

    if ! config_file_exists "$config_file"; then
        output_error "E_FILE_NOT_FOUND" "Config file not found: $config_file" $EXIT_FILE_ERROR true
        exit $EXIT_FILE_ERROR
    fi

    # Define sections
    declare -A SECTIONS=(
        [1]="output:Output Settings"
        [2]="archive:Archive Settings"
        [3]="logging:Logging Settings"
        [4]="session:Session Settings"
        [5]="validation:Validation Settings"
        [6]="defaults:Default Values"
        [7]="display:Display Settings"
        [8]="cli:CLI Settings"
    )

    local changes_made=false
    local temp_config
    temp_config=$(mktemp)
    cp "$config_file" "$temp_config"

    while true; do
        clear
        echo "============================================="
        echo "   Claude-TODO Configuration Editor"
        echo "============================================="
        echo ""
        echo "Editing: $config_file ($SCOPE)"
        echo ""
        echo "Select category:"
        echo ""

        for key in $(echo "${!SECTIONS[@]}" | tr ' ' '\n' | sort -n); do
            local section_info="${SECTIONS[$key]}"
            local section_key="${section_info%%:*}"
            local section_name="${section_info#*:}"
            echo "  $key. $section_name"
        done

        echo ""
        echo "  s. Save & Exit"
        echo "  q. Quit without saving"
        echo ""
        read -rp "Choice [1-8, s, q]: " choice

        case "$choice" in
            [1-8])
                local section_info="${SECTIONS[$choice]}"
                local section_key="${section_info%%:*}"
                local section_name="${section_info#*:}"
                edit_section "$temp_config" "$section_key" "$section_name"
                changes_made=true
                ;;
            s|S)
                if [[ "$changes_made" == true ]]; then
                    cp "$temp_config" "$config_file"
                    echo ""
                    echo "Configuration saved."
                    sleep 1
                fi
                rm -f "$temp_config"
                return 0
                ;;
            q|Q)
                rm -f "$temp_config"
                echo ""
                echo "Exiting without saving."
                return 0
                ;;
            *)
                echo "Invalid choice. Press Enter to continue..."
                read -r
                ;;
        esac
    done
}

# Edit a config section
edit_section() {
    local config_file="$1"
    local section="$2"
    local section_name="$3"

    while true; do
        clear
        echo "$section_name"
        echo "$(printf '─%.0s' $(seq 1 ${#section_name}))"
        echo ""

        # Get section data
        local section_data
        section_data=$(jq ".${section}" "$config_file")

        if [[ "$section_data" == "null" ]]; then
            echo "Section not found: $section"
            echo ""
            read -rp "Press Enter to go back..." dummy
            return
        fi

        # List fields with numbers
        local i=1
        declare -A FIELDS=()
        while IFS='=' read -r key value; do
            FIELDS[$i]="$key"
            printf "  %d. %s: %s\n" "$i" "$key" "$value"
            ((i++))
        done < <(echo "$section_data" | jq -r 'to_entries | .[] | "\(.key)=\(.value)"')

        echo ""
        echo "  b. Back to main menu"
        echo ""
        read -rp "Choice [1-$((i-1)), b]: " choice

        if [[ "$choice" == "b" ]] || [[ "$choice" == "B" ]]; then
            return
        fi

        if [[ "$choice" =~ ^[0-9]+$ ]] && [[ "$choice" -ge 1 ]] && [[ "$choice" -lt "$i" ]]; then
            local field="${FIELDS[$choice]}"
            local current_value
            current_value=$(echo "$section_data" | jq -r ".${field}")

            echo ""
            echo "Current value of ${section}.${field}: $current_value"
            read -rp "Enter new value (or press Enter to cancel): " new_value

            if [[ -n "$new_value" ]]; then
                # Determine type and update
                local jq_value
                if [[ "$new_value" == "true" ]] || [[ "$new_value" == "false" ]]; then
                    jq_value="$new_value"
                elif [[ "$new_value" =~ ^-?[0-9]+$ ]]; then
                    jq_value="$new_value"
                else
                    jq_value="\"$new_value\""
                fi

                local temp_file
                temp_file=$(mktemp)
                jq ".${section}.${field} = ${jq_value}" "$config_file" > "$temp_file" && mv "$temp_file" "$config_file"
                echo "Updated ${section}.${field} = $new_value"
                sleep 1
            fi
        fi
    done
}

# ============================================================================
# MAIN
# ============================================================================

main() {
    # Collect all arguments, separating flags from subcommand and its args
    local subcommand=""
    local subcommand_args=()

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --global)
                SCOPE="global"
                shift
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
            -q|--quiet)
                QUIET=true
                shift
                ;;
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            -h|--help|help)
                usage
                exit 0
                ;;
            -*)
                # Unknown flag - pass to subcommand
                subcommand_args+=("$1")
                shift
                ;;
            *)
                # First non-flag is the subcommand
                if [[ -z "$subcommand" ]]; then
                    subcommand="$1"
                else
                    subcommand_args+=("$1")
                fi
                shift
                ;;
        esac
    done

    # Resolve format (TTY-aware)
    FORMAT=$(resolve_format "$FORMAT")

    # Check for subcommand
    if [[ -z "$subcommand" ]]; then
        usage
        exit $EXIT_INVALID_INPUT
    fi

    case "$subcommand" in
        show)
            cmd_show "${subcommand_args[@]+"${subcommand_args[@]}"}"
            ;;
        get)
            cmd_get "${subcommand_args[@]+"${subcommand_args[@]}"}"
            ;;
        set)
            cmd_set "${subcommand_args[@]+"${subcommand_args[@]}"}"
            ;;
        list)
            cmd_list "${subcommand_args[@]+"${subcommand_args[@]}"}"
            ;;
        reset)
            cmd_reset "${subcommand_args[@]+"${subcommand_args[@]}"}"
            ;;
        edit)
            cmd_edit "${subcommand_args[@]+"${subcommand_args[@]}"}"
            ;;
        validate)
            cmd_validate "${subcommand_args[@]+"${subcommand_args[@]}"}"
            ;;
        *)
            echo "Unknown subcommand: $subcommand"
            echo ""
            echo "Available subcommands: show, get, set, list, reset, edit, validate"
            echo ""
            echo "Run 'cleo config --help' for usage."
            exit $EXIT_INVALID_INPUT
            ;;
    esac
}

main "$@"
