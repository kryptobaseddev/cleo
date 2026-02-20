#!/usr/bin/env bash
# command-registry.sh - Dynamic command registry from self-describing scripts
# @task T3112
#
# Provides functions to parse ###CLEO header blocks from script files
# and generate command registry data. This is the core engine that replaces
# manual command registration in COMMANDS-INDEX.json and the wrapper.
#
# LAYER: 1 (Core Library)
# DEPENDENCIES: None (standalone)
# PROVIDES: parse_command_header, scan_all_commands, validate_header,
#           get_command_script_map, rebuild_commands_index

# ============================================
# GUARD: Prevent double-sourcing
# ============================================
[[ -n "${_COMMAND_REGISTRY_LOADED:-}" ]] && return 0
readonly _COMMAND_REGISTRY_LOADED=1

# ============================================
# CONSTANTS
# ============================================
readonly CLEO_HEADER_START="###CLEO"
readonly CLEO_HEADER_END="###END"

# ============================================
# HEADER PARSING
# ============================================

# Parse ###CLEO header block from a script file
# Args: script_path
# Returns: JSON object with all metadata fields (stdout)
# Exit: 0 on success, 1 if no header found
parse_command_header() {
    local script_path="$1"

    if [[ ! -f "$script_path" ]]; then
        echo '{"error":"file_not_found"}'
        return 1
    fi

    # Extract header block between ###CLEO and ###END
    local in_header=false
    local header_lines=()

    while IFS= read -r line; do
        if [[ "$line" == "$CLEO_HEADER_START" ]]; then
            in_header=true
            continue
        fi
        if [[ "$line" == "$CLEO_HEADER_END" ]]; then
            break
        fi
        if [[ "$in_header" == true && "$line" =~ ^#\  ]]; then
            # Strip "# " prefix
            header_lines+=("${line:2}")
        fi
    done < "$script_path"

    if [[ ${#header_lines[@]} -eq 0 ]]; then
        echo '{"error":"no_header_found"}'
        return 1
    fi

    # Parse key-value pairs
    local command="" category="" synopsis="" aliases="" relevance=""
    local flags="" exits="" json_output="false" json_default="false"
    local subcommands="" note="" alias_for="" script_name=""

    script_name=$(basename "$script_path")

    for kv in "${header_lines[@]}"; do
        local key="${kv%%:*}"
        local value="${kv#*: }"
        # Trim leading space from value
        value="${value#"${value%%[![:space:]]*}"}"

        case "$key" in
            command)     command="$value" ;;
            category)    category="$value" ;;
            synopsis)    synopsis="$value" ;;
            aliases)     aliases="$value" ;;
            alias-for)   alias_for="$value" ;;
            relevance)   relevance="$value" ;;
            flags)       flags="$value" ;;
            exits)       exits="$value" ;;
            json-output) json_output="$value" ;;
            json-default) json_default="$value" ;;
            subcommands) subcommands="$value" ;;
            note)        note="$value" ;;
        esac
    done

    # Build JSON output using jq for proper escaping
    local json
    json=$(jq -n \
        --arg name "$command" \
        --arg script "$script_name" \
        --arg category "$category" \
        --arg synopsis "$synopsis" \
        --arg aliases "$aliases" \
        --arg alias_for "$alias_for" \
        --arg relevance "$relevance" \
        --arg flags "$flags" \
        --arg exits "$exits" \
        --arg json_output "$json_output" \
        --arg json_default "$json_default" \
        --arg subcommands "$subcommands" \
        --arg note "$note" \
        '{
            name: $name,
            script: $script,
            category: $category,
            synopsis: $synopsis,
            agentRelevance: $relevance,
            jsonOutput: ($json_output == "true"),
            jsonDefault: ($json_default == "true")
        }
        + (if $aliases != "" then {aliases: ($aliases | split(","))} else {} end)
        + (if $alias_for != "" then {aliasFor: $alias_for} else {} end)
        + (if $flags != "" then {flags: ($flags | split(","))} else {flags: []} end)
        + (if $exits != "" then {exitCodes: [($exits | split(","))[] | tonumber]} else {exitCodes: []} end)
        + (if $subcommands != "" then {subcommands: ($subcommands | split(","))} else {} end)
        + (if $note != "" then {note: $note} else {} end)
        ')

    echo "$json"
    return 0
}

# Scan all scripts in a directory and build full registry
# Args: scripts_dir
# Returns: JSON array of command metadata (stdout)
scan_all_commands() {
    local scripts_dir="${1:-.}"
    local commands=()
    local count=0

    for script in "$scripts_dir"/*.sh; do
        [[ -f "$script" ]] || continue

        local result
        result=$(parse_command_header "$script" 2>/dev/null) || continue

        # Skip if parsing returned an error
        if echo "$result" | jq -e '.error' &>/dev/null; then
            continue
        fi

        commands+=("$result")
        ((count++))
    done

    # Combine into JSON array
    if [[ ${#commands[@]} -eq 0 ]]; then
        echo '[]'
        return 0
    fi

    printf '%s\n' "${commands[@]}" | jq -s 'sort_by(.name)'
}

# Validate a script's ###CLEO header for completeness
# Args: script_path
# Returns: JSON with validation results (stdout)
# Exit: 0 if valid, 1 if invalid
validate_header() {
    local script_path="$1"
    local errors=()

    local result
    result=$(parse_command_header "$script_path" 2>/dev/null)

    if [[ $? -ne 0 ]]; then
        jq -n --arg file "$(basename "$script_path")" \
            '{valid: false, file: $file, errors: ["No ###CLEO header found"]}'
        return 1
    fi

    # Check required fields
    local name category synopsis relevance
    name=$(echo "$result" | jq -r '.name')
    category=$(echo "$result" | jq -r '.category')
    synopsis=$(echo "$result" | jq -r '.synopsis')
    relevance=$(echo "$result" | jq -r '.agentRelevance')

    [[ -z "$name" || "$name" == "null" ]] && errors+=("missing: command")
    [[ -z "$category" || "$category" == "null" ]] && errors+=("missing: category")
    [[ -z "$synopsis" || "$synopsis" == "null" ]] && errors+=("missing: synopsis")
    [[ -z "$relevance" || "$relevance" == "null" ]] && errors+=("missing: relevance")

    if [[ ${#errors[@]} -gt 0 ]]; then
        printf '%s\n' "${errors[@]}" | jq -R -s --arg file "$(basename "$script_path")" \
            'split("\n") | map(select(length > 0)) | {valid: false, file: $file, errors: .}'
        return 1
    fi

    jq -n --arg file "$(basename "$script_path")" --arg name "$name" \
        '{valid: true, file: $file, command: $name, errors: []}'
    return 0
}

# Get command-name → script-path mapping
# Args: scripts_dir
# Returns: JSON object mapping command names to script paths (stdout)
get_command_script_map() {
    local scripts_dir="${1:-.}"

    scan_all_commands "$scripts_dir" | \
        jq 'map({(.name): .script}) | add // {}'
}

# Get alias → command mapping
# Args: scripts_dir
# Returns: JSON object mapping alias names to command names (stdout)
get_alias_map() {
    local scripts_dir="${1:-.}"

    scan_all_commands "$scripts_dir" | \
        jq '[.[] | select(.aliases) | .aliases[] as $alias | {($alias): .name}] | add // {}'
}

# Rebuild COMMANDS-INDEX.json from script headers
# Args: scripts_dir index_path [--dry-run]
# Returns: 0 on success, writes INDEX file
rebuild_commands_index() {
    local scripts_dir="${1:-.}"
    local index_path="${2:-docs/commands/COMMANDS-INDEX.json}"
    local dry_run="${3:-}"

    local commands_json
    commands_json=$(scan_all_commands "$scripts_dir")

    local count
    count=$(echo "$commands_json" | jq 'length')

    # Read existing INDEX to preserve agentWorkflows, quickLookup, and alias-only entries
    # Look for existing INDEX at the output path, or find it relative to scripts dir
    local existing_index="$index_path"
    if [[ ! -f "$existing_index" ]]; then
        # Try relative to scripts dir (common layout: scripts/../docs/commands/COMMANDS-INDEX.json)
        local project_root
        project_root=$(cd "$scripts_dir/.." && pwd)
        existing_index="$project_root/docs/commands/COMMANDS-INDEX.json"
    fi

    local workflows="{}" quick_lookup="{}" alias_entries="[]"
    if [[ -f "$existing_index" ]]; then
        workflows=$(jq '.agentWorkflows // {}' "$existing_index")
        quick_lookup=$(jq '.quickLookup // {}' "$existing_index")
        # Preserve entries that have aliasFor but no script (e.g., "tree")
        alias_entries=$(jq '[.commands[] | select(.aliasFor and (.script == null or .script == "N/A"))]' "$existing_index")
    fi

    # Merge script-based commands with alias-only entries
    local all_commands
    all_commands=$(echo "$commands_json" | jq --argjson aliases "$alias_entries" '. + $aliases | sort_by(.name)')
    count=$(echo "$all_commands" | jq 'length')

    # Build categories from all commands
    local categories
    categories=$(echo "$all_commands" | jq '
        group_by(.category) |
        map({(.[0].category): [.[].name]}) |
        add // {}
    ')

    # Build full INDEX
    local full_index
    full_index=$(jq -n \
        --argjson commands "$all_commands" \
        --argjson categories "$categories" \
        --argjson workflows "$workflows" \
        --argjson quickLookup "$quick_lookup" \
        --arg count "$count" \
        --arg date "$(date -u +%Y-%m-%d)" \
        '{
            "$schema": "https://cleo-dev.com/schemas/v1/commands-index.schema.json",
            "_meta": {
                "version": "2.0.0",
                "lastUpdated": $date,
                "totalCommands": ($count | tonumber),
                "specCompliance": "LLM-AGENT-FIRST-SPEC v3.0",
                "generatedFrom": "script-headers"
            },
            categories: $categories,
            commands: $commands,
            agentWorkflows: $workflows,
            quickLookup: $quickLookup
        }')

    if [[ "$dry_run" == "--dry-run" ]]; then
        echo "$full_index"
        return 0
    fi

    # Atomic write
    local tmp_file="${index_path}.tmp.$$"
    echo "$full_index" > "$tmp_file"

    # Validate JSON
    if ! jq empty "$tmp_file" 2>/dev/null; then
        rm -f "$tmp_file"
        echo "ERROR: Generated invalid JSON" >&2
        return 1
    fi

    mv "$tmp_file" "$index_path"
    echo "Rebuilt $index_path with $count commands" >&2
    return 0
}

# Generate wrapper case statement from script headers
# Args: scripts_dir
# Returns: Bash case statement (stdout)
generate_wrapper_case() {
    local scripts_dir="${1:-.}"

    echo '_get_cmd_script() {'
    echo '    case "$1" in'

    scan_all_commands "$scripts_dir" | jq -r '.[] | "        \(.name)) echo \"\(.script)\" ;;"'

    echo '        *) echo "" ;;'
    echo '    esac'
    echo '}'
}

# Generate alias resolution from script headers
# Args: scripts_dir
# Returns: Bash case statement (stdout)
generate_alias_case() {
    local scripts_dir="${1:-.}"

    echo '_resolve_alias() {'
    echo '    case "$1" in'

    scan_all_commands "$scripts_dir" | jq -r '
        [.[] | select(.aliases) | .aliases[] as $alias | "\($alias)|\(.name)"] |
        .[] | split("|") | "        \(.[0])) echo \"\(.[1])\" ;;"
    '

    echo '        *) echo "$1" ;;'
    echo '    esac'
    echo '}'
}

# Generate flat command list from script headers
# Args: scripts_dir
# Returns: space-separated command names (stdout)
generate_all_commands_list() {
    local scripts_dir="${1:-.}"

    scan_all_commands "$scripts_dir" | jq -r '[.[].name] | join(" ")'
}

# ============================================
# EXPORT PUBLIC API
# ============================================
export -f parse_command_header 2>/dev/null || true
export -f scan_all_commands 2>/dev/null || true
export -f validate_header 2>/dev/null || true
export -f get_command_script_map 2>/dev/null || true
export -f get_alias_map 2>/dev/null || true
export -f rebuild_commands_index 2>/dev/null || true
export -f generate_wrapper_case 2>/dev/null || true
export -f generate_alias_case 2>/dev/null || true
export -f generate_all_commands_list 2>/dev/null || true
