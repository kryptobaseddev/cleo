#!/usr/bin/env bash
###CLEO
# command: config
# category: maintenance
# synopsis: View and modify configuration (project and global)
# relevance: medium
# flags: --format,--quiet,--global
# exits: 0,2,8
# json-output: true
# subcommands: show,set,get,list,reset
###END
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
if [[ -f "$LIB_DIR/file-ops.sh" ]]; then
  source "$LIB_DIR/file-ops.sh"
fi
if [[ -f "$LIB_DIR/flags.sh" ]]; then
  source "$LIB_DIR/flags.sh"
fi

# Command identification
COMMAND_NAME="config"

# ============================================================================
# DEFAULTS
# ============================================================================

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
  CLEO_FORMAT                 Output format override
  CLEO_OUTPUT_SHOW_COLOR      Enable/disable colors
  CLEO_ARCHIVE_ENABLED        Enable/disable archiving
  CLEO_VALIDATION_STRICT_MODE Enable strict validation
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

    jq -nc \
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

    jq -nc \
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
        jq -nc \
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
            jq -nc \
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
            jq -nc --arg section "$section" '{"dryRun": true, "section": (if $section == "" then "all" else $section end), "message": "Would reset to defaults"}'
        else
            echo "[DRY RUN] Would reset ${section:-entire config} to defaults"
        fi
        return 0
    fi

    # Create backup before reset (atomic safety)
    if type -t backup_file &>/dev/null; then
        backup_file "$config_file" 2>/dev/null || true
    fi

    if [[ -z "$section" ]]; then
        # Reset entire config using atomic write pattern
        local temp_file
        temp_file=$(mktemp)
        if cp "$template_file" "$temp_file" && mv "$temp_file" "$config_file"; then
            [[ "$QUIET" != true ]] && echo "Reset entire config to defaults"
        else
            output_error "E_WRITE_FAILED" "Failed to reset config file" $EXIT_FILE_ERROR true
            exit $EXIT_FILE_ERROR
        fi
    else
        # Reset just one section
        local default_section
        default_section=$(jq ".${section}" "$template_file")

        if [[ "$default_section" == "null" ]]; then
            output_error "E_INPUT_INVALID" "Unknown section: $section" $EXIT_INVALID_INPUT true
            exit $EXIT_INVALID_INPUT
        fi

        local reset_content
        if ! reset_content=$(jq ".${section} = ${default_section}" "$config_file"); then
            output_error "E_WRITE_FAILED" "Failed to compute config reset" $EXIT_FILE_ERROR true
            exit $EXIT_FILE_ERROR
        fi
        if ! save_json "$config_file" "$reset_content"; then
            output_error "E_WRITE_FAILED" "Failed to reset config section" $EXIT_FILE_ERROR true
            exit $EXIT_FILE_ERROR
        fi
        [[ "$QUIET" != true ]] && echo "Reset '$section' section to defaults"
    fi

    # Validate config after reset
    if ! jq -e '.' "$config_file" >/dev/null 2>&1; then
        output_error "E_VALIDATION_FAILED" "Config validation failed after reset" $EXIT_VALIDATION_ERROR true
        exit $EXIT_VALIDATION_ERROR
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
    version=$(jq -r '._meta.schemaVersion' "$config_file")
    if [[ -z "$version" || "$version" == "null" ]]; then
        valid=false
        errors+=("Missing required field: ._meta.schemaVersion")
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
            jq -nc '{"valid": true, "errors": []}'
        else
            jq -nc --argjson errs "$(printf '%s\n' "${errors[@]}" | jq -R . | jq -s .)" '{"valid": false, "errors": $errs}'
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

# Get schema file for current scope
get_schema_file() {
    if [[ "$SCOPE" == "global" ]]; then
        echo "${CLEO_HOME:-$HOME/.cleo}/schemas/global-config.schema.json"
    else
        echo "${CLEO_HOME:-$HOME/.cleo}/schemas/config.schema.json"
    fi
}

# Get editable sections from schema (excludes $schema, version)
get_schema_sections() {
    local schema_file="$1"
    if [[ -f "$schema_file" ]]; then
        jq -r '.properties | keys[]' "$schema_file" | grep -v '^\$schema$' | grep -v '^version$' | sort
    else
        # Fallback to hardcoded list if schema not found
        echo -e "output\narchive\nlogging\nsession\nvalidation\ndefaults\ndisplay\ncli"
    fi
}

# Get section description from schema
get_section_description() {
    local schema_file="$1"
    local section="$2"
    if [[ -f "$schema_file" ]]; then
        jq -r ".properties.${section}.description // \"${section^} Settings\"" "$schema_file"
    else
        echo "${section^} Settings"
    fi
}

# Get field type from schema
get_field_type() {
    local schema_file="$1"
    local path="$2"  # e.g., "output.defaultFormat" or "defaults.labels"
    if [[ -f "$schema_file" ]]; then
        # Convert dotted path to jq path
        local jq_path
        jq_path=$(echo "$path" | sed 's/\./".properties."/g')
        jq -r ".properties.\"${jq_path}\".type // \"string\"" "$schema_file"
    else
        echo "string"
    fi
}

# Get enum values from schema
get_field_enum() {
    local schema_file="$1"
    local path="$2"
    if [[ -f "$schema_file" ]]; then
        local jq_path
        jq_path=$(echo "$path" | sed 's/\./".properties."/g')
        jq -r ".properties.\"${jq_path}\".enum // empty | .[]" "$schema_file" 2>/dev/null
    fi
}

# Check if field has nested properties
has_nested_properties() {
    local schema_file="$1"
    local path="$2"
    if [[ -f "$schema_file" ]]; then
        local jq_path
        jq_path=$(echo "$path" | sed 's/\./".properties."/g')
        local props
        props=$(jq -r ".properties.\"${jq_path}\".properties // empty | keys | length" "$schema_file" 2>/dev/null)
        [[ -n "$props" ]] && [[ "$props" -gt 0 ]]
    else
        return 1
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

    # Get schema and sections dynamically
    local schema_file
    schema_file=$(get_schema_file)

    # Build sections array from schema
    declare -A SECTIONS=()
    local i=1
    while IFS= read -r section; do
        local desc
        desc=$(get_section_description "$schema_file" "$section")
        # Create friendly display name
        local display_name="${section^}"
        display_name="${display_name//_/ }"
        SECTIONS[$i]="${section}:${display_name} Settings"
        ((i++))
    done < <(get_schema_sections "$schema_file")

    local section_count=$((i - 1))

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
        read -rp "Choice [1-${section_count}, s, q]: " choice

        case "$choice" in
            [0-9]|[0-9][0-9])
                # Validate numeric choice is within range
                if [[ "$choice" -ge 1 ]] && [[ "$choice" -le "$section_count" ]]; then
                    local section_info="${SECTIONS[$choice]}"
                    local section_key="${section_info%%:*}"
                    local section_name="${section_info#*:}"
                    edit_section "$temp_config" "$section_key" "$section_name" "$schema_file"
                    changes_made=true
                else
                    echo "Invalid choice. Press Enter to continue..."
                    read -r
                fi
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

# Get field info from schema
get_field_info() {
    local schema_file="$1"
    local path="$2"  # e.g., "output" or "output.defaultFormat"

    if [[ ! -f "$schema_file" ]]; then
        echo '{"type":"string"}'
        return
    fi

    # Build jq path for nested properties
    local jq_path=".properties"
    IFS='.' read -ra parts <<< "$path"
    for part in "${parts[@]}"; do
        jq_path="${jq_path}.${part}.properties"
    done
    # Remove trailing .properties to get the field itself
    jq_path="${jq_path%.properties}"

    jq "$jq_path // {\"type\":\"string\"}" "$schema_file" 2>/dev/null || echo '{"type":"string"}'
}

# Edit a value based on its type
edit_value() {
    local config_file="$1"
    local path="$2"           # Full dotted path like "output.defaultFormat"
    local schema_file="$3"
    local current_value="$4"

    local field_info
    field_info=$(get_field_info "$schema_file" "$path")

    local field_type
    field_type=$(echo "$field_info" | jq -r '.type // "string"')

    local enum_values
    enum_values=$(echo "$field_info" | jq -r '.enum // empty | .[]' 2>/dev/null)

    local min_val max_val
    min_val=$(echo "$field_info" | jq -r '.minimum // empty' 2>/dev/null)
    max_val=$(echo "$field_info" | jq -r '.maximum // empty' 2>/dev/null)

    echo ""
    echo "Current value of ${path}: $current_value"
    echo "Type: $field_type"

    local new_value=""

    # Handle enum types
    if [[ -n "$enum_values" ]]; then
        echo ""
        echo "Valid options:"
        local opt_num=1
        declare -A ENUM_OPTIONS=()
        while IFS= read -r opt; do
            if [[ "$opt" == "$current_value" ]]; then
                echo "  $opt_num. $opt (current)"
            else
                echo "  $opt_num. $opt"
            fi
            ENUM_OPTIONS[$opt_num]="$opt"
            ((opt_num++))
        done <<< "$enum_values"
        echo ""
        read -rp "Select option [1-$((opt_num-1))] or Enter to cancel: " enum_choice

        if [[ -n "$enum_choice" ]] && [[ "$enum_choice" =~ ^[0-9]+$ ]]; then
            if [[ "$enum_choice" -ge 1 ]] && [[ "$enum_choice" -lt "$opt_num" ]]; then
                new_value="${ENUM_OPTIONS[$enum_choice]}"
            fi
        fi
    # Handle boolean types
    elif [[ "$field_type" == "boolean" ]]; then
        echo ""
        if [[ "$current_value" == "true" ]]; then
            echo "  1. true (current)"
            echo "  2. false"
        else
            echo "  1. true"
            echo "  2. false (current)"
        fi
        echo ""
        read -rp "Select [1-2] or Enter to cancel: " bool_choice
        case "$bool_choice" in
            1) new_value="true" ;;
            2) new_value="false" ;;
        esac
    # Handle array types
    elif [[ "$field_type" == "array" ]]; then
        echo ""
        echo "Current items: $current_value"
        echo ""
        echo "  a. Add item"
        echo "  r. Remove item"
        echo "  c. Clear all"
        echo "  Enter to cancel"
        echo ""
        read -rp "Action [a/r/c]: " array_action

        case "$array_action" in
            a|A)
                read -rp "Enter new item: " new_item
                if [[ -n "$new_item" ]]; then
                    local add_content
                    add_content=$(jq ".${path} += [\"${new_item}\"]" "$config_file") && \
                        save_json "$config_file" "$add_content"
                    echo "Added: $new_item"
                    sleep 1
                fi
                return 0
                ;;
            r|R)
                read -rp "Enter item to remove: " remove_item
                if [[ -n "$remove_item" ]]; then
                    local rm_content
                    rm_content=$(jq ".${path} -= [\"${remove_item}\"]" "$config_file") && \
                        save_json "$config_file" "$rm_content"
                    echo "Removed: $remove_item"
                    sleep 1
                fi
                return 0
                ;;
            c|C)
                read -rp "Clear all items? [y/N]: " confirm
                if [[ "$confirm" == "y" ]] || [[ "$confirm" == "Y" ]]; then
                    local clear_content
                    clear_content=$(jq ".${path} = []" "$config_file") && \
                        save_json "$config_file" "$clear_content"
                    echo "Cleared all items"
                    sleep 1
                fi
                return 0
                ;;
        esac
        return 0
    # Handle integer/number with range
    elif [[ "$field_type" == "integer" ]] || [[ "$field_type" == "number" ]]; then
        local range_hint=""
        if [[ -n "$min_val" ]] && [[ -n "$max_val" ]]; then
            range_hint=" (range: $min_val-$max_val)"
        elif [[ -n "$min_val" ]]; then
            range_hint=" (min: $min_val)"
        elif [[ -n "$max_val" ]]; then
            range_hint=" (max: $max_val)"
        fi
        echo ""
        read -rp "Enter new value${range_hint} or Enter to cancel: " new_value

        if [[ -n "$new_value" ]]; then
            # Validate range
            if [[ -n "$min_val" ]] && (( $(echo "$new_value < $min_val" | bc -l) )); then
                echo "Error: Value must be >= $min_val"
                sleep 1
                return 1
            fi
            if [[ -n "$max_val" ]] && (( $(echo "$new_value > $max_val" | bc -l) )); then
                echo "Error: Value must be <= $max_val"
                sleep 1
                return 1
            fi
        fi
    # Handle string types
    else
        echo ""
        read -rp "Enter new value or Enter to cancel: " new_value
    fi

    # Apply the change if we have a new value
    if [[ -n "$new_value" ]]; then
        local jq_value
        if [[ "$new_value" == "true" ]] || [[ "$new_value" == "false" ]]; then
            jq_value="$new_value"
        elif [[ "$new_value" =~ ^-?[0-9]+\.?[0-9]*$ ]]; then
            jq_value="$new_value"
        else
            jq_value="\"$new_value\""
        fi

        local set_content
        set_content=$(jq ".${path} = ${jq_value}" "$config_file") && \
            save_json "$config_file" "$set_content"
        echo "Updated ${path} = $new_value"
        sleep 1
    fi
}

# Edit a config section (supports nested navigation)
edit_section() {
    local config_file="$1"
    local section="$2"
    local section_name="$3"
    local schema_file="${4:-}"

    while true; do
        clear
        echo "$section_name"
        echo "$(printf '─%.0s' $(seq 1 ${#section_name}))"
        echo ""

        # Get section data
        local section_data
        section_data=$(jq ".${section}" "$config_file")

        if [[ "$section_data" == "null" ]]; then
            echo "Section not found in config: $section"
            echo "(This section may not be initialized yet)"
            echo ""
            read -rp "Press Enter to go back..." dummy
            return
        fi

        # List fields with numbers, marking nested objects
        local i=1
        declare -A FIELDS=()
        declare -A FIELD_TYPES=()

        while IFS=$'\t' read -r key value ftype; do
            FIELDS[$i]="$key"
            FIELD_TYPES[$i]="$ftype"

            if [[ "$ftype" == "object" ]]; then
                printf "  %d. %s: {...} [nested]\n" "$i" "$key"
            elif [[ "$ftype" == "array" ]]; then
                local arr_len
                arr_len=$(echo "$section_data" | jq -r ".${key} | length")
                printf "  %d. %s: [%d items]\n" "$i" "$key" "$arr_len"
            else
                printf "  %d. %s: %s\n" "$i" "$key" "$value"
            fi
            ((i++))
        done < <(echo "$section_data" | jq -r 'to_entries | .[] | [.key, (.value | tostring), (.value | type)] | @tsv')

        local field_count=$((i - 1))
        echo ""
        echo "  b. Back to main menu"
        echo ""
        read -rp "Choice [1-${field_count}, b]: " choice

        if [[ "$choice" == "b" ]] || [[ "$choice" == "B" ]]; then
            return
        fi

        if [[ "$choice" =~ ^[0-9]+$ ]] && [[ "$choice" -ge 1 ]] && [[ "$choice" -le "$field_count" ]]; then
            local field="${FIELDS[$choice]}"
            local field_type="${FIELD_TYPES[$choice]}"
            local current_value
            current_value=$(echo "$section_data" | jq -r ".${field}")

            # Handle nested objects by recursing
            if [[ "$field_type" == "object" ]]; then
                edit_section "$config_file" "${section}.${field}" "${section_name} > ${field^}" "$schema_file"
            else
                edit_value "$config_file" "${section}.${field}" "$schema_file" "$current_value"
            fi
        fi
    done
}

# ============================================================================
# MAIN
# ============================================================================

main() {
    # Parse common flags first (--format, --json, --human, --quiet, --dry-run, --help, etc.)
    init_flag_defaults
    parse_common_flags "$@"
    set -- "${REMAINING_ARGS[@]}"

    # Handle help flag
    if [[ "$FLAG_HELP" == true ]]; then
        usage
        exit 0
    fi

    # Collect command-specific args, separating flags from subcommand and its args
    local subcommand=""
    local subcommand_args=()

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --global)
                SCOPE="global"
                shift
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

    # Apply common flags to globals
    apply_flags_to_globals
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
        help)
            usage
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
