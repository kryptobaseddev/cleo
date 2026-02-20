#!/usr/bin/env bash
###CLEO
# library: issue/template-parser
# category: issue
# synopsis: Parse GitHub issue template YAML files into JSON config for issue.sh
# layer: 3 (Feature Layer)
# dependencies: none (standalone library, lightweight logging built-in)
# provides: parse_issue_templates, get_template_config, get_template_for_subcommand,
#           validate_labels_exist, ensure_labels_exist
###END
# ============================================================================
# lib/issue/template-parser.sh - GitHub Issue Template Parser
# ============================================================================
# Parses .github/ISSUE_TEMPLATE/*.yml files and produces a JSON config that
# scripts/issue.sh can consume. Handles three resolution strategies:
#   1. Live parse from YAML templates (if in a repo with templates)
#   2. Cached config from .cleo/issue-templates.json
#   3. Hardcoded fallback defaults (last resort)
#
# YAML parsing is done with grep/sed/awk since yq is not available.
# The templates follow a known, stable GitHub Actions issue template schema.
# ============================================================================

#=== SOURCE GUARD ================================================
[[ -n "${_TEMPLATE_PARSER_LOADED:-}" ]] && return 0
declare -r _TEMPLATE_PARSER_LOADED=1

# ============================================================================
# LOGGING HELPERS
# ============================================================================
# Lightweight logging — avoids sourcing the full logging.sh which has
# heavy dependencies (atomic-write, platform-compat). These go to stderr
# and respect FORMAT for quiet mode.

_tp_log_info() {
    local message="$1"
    [[ "${FORMAT:-}" == "json" ]] && return 0
    echo "[template-parser] $message" >&2
}

_tp_log_warn() {
    local message="$1"
    echo "[template-parser] WARNING: $message" >&2
}

_tp_log_error() {
    local message="$1"
    echo "[template-parser] ERROR: $message" >&2
}

# ============================================================================
# CONSTANTS
# ============================================================================

# Template directory relative to repo root
readonly _TP_TEMPLATE_DIR=".github/ISSUE_TEMPLATE"

# Cache file location
readonly _TP_CACHE_FILE=".cleo/issue-templates.json"

# Known filename-to-subcommand mappings
# Format: filename_stem=subcommand
readonly -a _TP_SUBCOMMAND_MAP=(
    "bug_report=bug"
    "feature_request=feature"
    "help_question=help"
)

# ============================================================================
# INTERNAL: YAML FIELD EXTRACTION
# ============================================================================
# These functions parse specific fields from the known GitHub issue template
# YAML schema. They are NOT general-purpose YAML parsers.

# Extract a simple top-level scalar field (name, title, description)
# Args: $1 = field name, $2 = file path
# Output: field value (quotes stripped)
_tp_extract_field() {
    local field="$1"
    local file="$2"
    local value

    # Match "field: value" or "field: 'value'" or 'field: "value"'
    # Only match top-level (no leading whitespace)
    value=$(sed -n "s/^${field}:[[:space:]]*//p" "$file" | head -1)

    # Strip surrounding quotes (single or double)
    value="${value#\"}"
    value="${value%\"}"
    value="${value#\'}"
    value="${value%\'}"

    # Trim trailing whitespace/carriage return
    value="${value%"${value##*[![:space:]]}"}"

    echo "$value"
}

# Extract labels array from a line like: labels: ["bug", "triage"]
# Args: $1 = file path
# Output: JSON array of labels
_tp_extract_labels() {
    local file="$1"
    local labels_line

    # Get the labels: line (top-level only — no leading whitespace)
    labels_line=$(sed -n 's/^labels:[[:space:]]*//p' "$file" | head -1)

    if [[ -z "$labels_line" ]]; then
        echo '[]'
        return 0
    fi

    # The labels line is typically a JSON array: ["bug", "triage"]
    # Validate and normalize with jq
    if echo "$labels_line" | jq -e 'type == "array"' &>/dev/null; then
        echo "$labels_line" | jq -c '.'
    else
        # Fallback: try to parse as a single label string
        echo "$labels_line" | jq -Rc '[.]'
    fi
}

# Extract body sections from the YAML body: array
# Args: $1 = file path
# Output: JSON array of section objects with id, label, type, required
_tp_extract_sections() {
    local file="$1"
    local sections_json="[]"

    # Use awk to extract body blocks
    # Each block starts with "  - type:" and ends before the next "  - type:" or EOF
    # We extract: type, id, attributes.label, validations.required
    local awk_output
    awk_output=$(awk '
    BEGIN { in_body = 0; block = ""; block_count = 0 }

    # Detect the start of the body: section
    /^body:/ { in_body = 1; next }

    # Stop if we hit another top-level key (no leading whitespace)
    in_body && /^[a-zA-Z]/ { in_body = 0 }

    # Inside body section
    in_body {
        # New block starts with "  - type:"
        if ($0 ~ /^[[:space:]]*- type:/) {
            # Output previous block if any
            if (block_count > 0 && block != "") {
                print "---BLOCK---"
                print block
            }
            block = $0
            block_count++
        } else if (block_count > 0) {
            block = block "\n" $0
        }
    }

    END {
        # Output the last block
        if (block_count > 0 && block != "") {
            print "---BLOCK---"
            print block
        }
    }
    ' "$file")

    # Parse each block
    local current_type="" current_id="" current_label="" current_required="false"

    while IFS= read -r line; do
        if [[ "$line" == "---BLOCK---" ]]; then
            # Emit previous section (if we have one with an id)
            if [[ -n "$current_id" ]]; then
                sections_json=$(echo "$sections_json" | jq -c \
                    --arg type "$current_type" \
                    --arg id "$current_id" \
                    --arg label "$current_label" \
                    --argjson required "$current_required" \
                    '. + [{type: $type, id: $id, label: $label, required: $required}]')
            fi
            # Reset for new block
            current_type=""
            current_id=""
            current_label=""
            current_required="false"
            continue
        fi

        # Extract type from "  - type: textarea"
        if [[ "$line" =~ ^[[:space:]]*-[[:space:]]*type:[[:space:]]*(.+) ]]; then
            current_type="${BASH_REMATCH[1]}"
            current_type="${current_type%"${current_type##*[![:space:]]}"}"
        fi

        # Extract id from "    id: description"
        if [[ "$line" =~ ^[[:space:]]+id:[[:space:]]*(.+) ]]; then
            current_id="${BASH_REMATCH[1]}"
            current_id="${current_id%"${current_id##*[![:space:]]}"}"
        fi

        # Extract label from "      label: What happened?"
        # Match label with or without quotes
        if [[ "$line" =~ ^[[:space:]]+label:[[:space:]]*(.+) ]]; then
            current_label="${BASH_REMATCH[1]}"
            # Strip quotes
            current_label="${current_label#\"}"
            current_label="${current_label%\"}"
            current_label="${current_label#\'}"
            current_label="${current_label%\'}"
            current_label="${current_label%"${current_label##*[![:space:]]}"}"
        fi

        # Extract required from "      required: true"
        if [[ "$line" =~ ^[[:space:]]+required:[[:space:]]*(true|false) ]]; then
            current_required="${BASH_REMATCH[1]}"
        fi

    done <<< "$awk_output"

    # Emit the last section
    if [[ -n "$current_id" ]]; then
        sections_json=$(echo "$sections_json" | jq -c \
            --arg type "$current_type" \
            --arg id "$current_id" \
            --arg label "$current_label" \
            --argjson required "$current_required" \
            '. + [{type: $type, id: $id, label: $label, required: $required}]')
    fi

    echo "$sections_json"
}

# Derive subcommand from template filename
# Args: $1 = filename (e.g., bug_report.yml)
# Output: subcommand name (e.g., bug)
_tp_filename_to_subcommand() {
    local filename="$1"
    local stem="${filename%.yml}"
    stem="${stem%.yaml}"
    local mapping

    for mapping in "${_TP_SUBCOMMAND_MAP[@]}"; do
        local map_stem="${mapping%%=*}"
        local map_cmd="${mapping#*=}"
        if [[ "$stem" == "$map_stem" ]]; then
            echo "$map_cmd"
            return 0
        fi
    done

    # Fallback: use filename stem with underscores replaced by hyphens
    echo "${stem//_/-}"
}

# ============================================================================
# PUBLIC: PARSE SINGLE TEMPLATE
# ============================================================================

# Parse one YAML template file into a JSON object
# Args: $1 = path to YAML file
# Output: JSON object with template config
# Returns: 0 on success, 1 on parse failure
_parse_single_template() {
    local file="$1"

    if [[ ! -f "$file" ]]; then
        _tp_log_error "Template file not found: $file"
        return 1
    fi

    local filename
    filename=$(basename "$file")

    # Skip config.yml (GitHub issue template chooser config, not an issue template)
    if [[ "$filename" == "config.yml" || "$filename" == "config.yaml" ]]; then
        return 1
    fi

    local name title_prefix labels sections subcommand

    name=$(_tp_extract_field "name" "$file") || name=""
    title_prefix=$(_tp_extract_field "title" "$file") || title_prefix=""
    labels=$(_tp_extract_labels "$file") || labels="[]"
    sections=$(_tp_extract_sections "$file") || sections="[]"
    subcommand=$(_tp_filename_to_subcommand "$filename")

    # Validate we got at least a name
    if [[ -z "$name" ]]; then
        _tp_log_warn "Could not extract name from $filename, skipping"
        return 1
    fi

    # Build JSON object
    jq -nc \
        --arg name "$name" \
        --arg titlePrefix "$title_prefix" \
        --argjson labels "$labels" \
        --argjson sections "$sections" \
        --arg subcommand "$subcommand" \
        --arg sourceFile "$filename" \
        '{
            name: $name,
            titlePrefix: $titlePrefix,
            labels: $labels,
            sections: $sections,
            subcommand: $subcommand,
            sourceFile: $sourceFile
        }'
}

# ============================================================================
# PUBLIC: PARSE ALL TEMPLATES
# ============================================================================

# Discover and parse all .github/ISSUE_TEMPLATE/*.yml files
# Args: $1 = (optional) repo root directory (defaults to pwd)
# Output: JSON object mapping subcommand -> template config
# Returns: 0 on success (even if no templates found — returns empty object)
parse_issue_templates() {
    local repo_root="${1:-.}"
    local template_dir="${repo_root}/${_TP_TEMPLATE_DIR}"
    local result="{}"

    if [[ ! -d "$template_dir" ]]; then
        _tp_log_warn "Template directory not found: $template_dir"
        echo "{}"
        return 0
    fi

    local yml_file
    for yml_file in "$template_dir"/*.yml "$template_dir"/*.yaml; do
        # Skip glob patterns that didn't match (no files)
        [[ -e "$yml_file" ]] || continue

        local template_json
        template_json=$(_parse_single_template "$yml_file") || continue

        local subcommand
        subcommand=$(echo "$template_json" | jq -r '.subcommand')

        result=$(echo "$result" | jq -c \
            --arg key "$subcommand" \
            --argjson val "$template_json" \
            '. + {($key): $val}')
    done

    echo "$result"
}

# ============================================================================
# PUBLIC: GET TEMPLATE CONFIG (with resolution strategy)
# ============================================================================

# Returns the full JSON config using the resolution strategy:
#   1. Live parse from YAML templates (if in a repo with templates)
#   2. Cached config from .cleo/issue-templates.json
#   3. Hardcoded fallback defaults
#
# Args: $1 = (optional) repo root directory (defaults to pwd)
# Output: JSON object mapping subcommand -> template config
get_template_config() {
    local repo_root="${1:-.}"
    local template_dir="${repo_root}/${_TP_TEMPLATE_DIR}"
    local cache_file="${repo_root}/${_TP_CACHE_FILE}"
    local config

    # Strategy 1: Live parse from YAML templates
    if [[ -d "$template_dir" ]]; then
        config=$(parse_issue_templates "$repo_root")
        if [[ -n "$config" && "$config" != "{}" ]]; then
            _tp_log_info "Loaded templates from ${_TP_TEMPLATE_DIR}/"
            echo "$config"
            return 0
        fi
    fi

    # Strategy 2: Cached config
    if [[ -f "$cache_file" ]]; then
        if jq -e 'type == "object"' "$cache_file" &>/dev/null; then
            _tp_log_info "Loaded templates from cache: ${_TP_CACHE_FILE}"
            jq -c '.' "$cache_file"
            return 0
        else
            _tp_log_warn "Cache file is invalid JSON: $cache_file"
        fi
    fi

    # Strategy 3: Hardcoded fallback defaults
    _tp_log_warn "No templates found, using hardcoded defaults"
    _tp_fallback_defaults
}

# Hardcoded fallback defaults matching the current issue.sh behavior
_tp_fallback_defaults() {
    jq -nc '{
        "bug": {
            "name": "Bug Report",
            "titlePrefix": "[Bug]: ",
            "labels": ["bug", "triage"],
            "sections": [
                {"type": "textarea", "id": "description", "label": "What happened?", "required": true},
                {"type": "textarea", "id": "steps", "label": "Steps to reproduce", "required": true},
                {"type": "textarea", "id": "error-output", "label": "Error output", "required": true},
                {"type": "textarea", "id": "expected", "label": "Expected behavior", "required": true},
                {"type": "textarea", "id": "diagnostics", "label": "Environment diagnostics", "required": true},
                {"type": "dropdown", "id": "install-method", "label": "Installation method", "required": true},
                {"type": "dropdown", "id": "severity", "label": "Severity", "required": true},
                {"type": "dropdown", "id": "agent-usage", "label": "Are you using an AI agent?", "required": true},
                {"type": "textarea", "id": "additional", "label": "Additional context", "required": false}
            ],
            "subcommand": "bug",
            "sourceFile": "bug_report.yml"
        },
        "feature": {
            "name": "Feature Request",
            "titlePrefix": "[Feature]: ",
            "labels": ["enhancement", "triage"],
            "sections": [
                {"type": "textarea", "id": "problem", "label": "Problem or use case", "required": true},
                {"type": "textarea", "id": "solution", "label": "Proposed solution", "required": true},
                {"type": "textarea", "id": "alternatives", "label": "Alternatives considered", "required": false},
                {"type": "dropdown", "id": "area", "label": "Feature area", "required": true},
                {"type": "dropdown", "id": "scope", "label": "Scope", "required": true},
                {"type": "textarea", "id": "diagnostics", "label": "Your environment (optional)", "required": false},
                {"type": "dropdown", "id": "agent-usage", "label": "Are you using an AI agent?", "required": true},
                {"type": "textarea", "id": "additional", "label": "Additional context", "required": false}
            ],
            "subcommand": "feature",
            "sourceFile": "feature_request.yml"
        },
        "help": {
            "name": "Help / Question",
            "titlePrefix": "[Question]: ",
            "labels": ["question", "help"],
            "sections": [
                {"type": "textarea", "id": "question", "label": "What do you need help with?", "required": true},
                {"type": "textarea", "id": "tried", "label": "What have you tried?", "required": true},
                {"type": "textarea", "id": "error-output", "label": "Relevant output (if any)", "required": false},
                {"type": "dropdown", "id": "topic", "label": "Topic area", "required": true},
                {"type": "textarea", "id": "diagnostics", "label": "Your environment", "required": false},
                {"type": "dropdown", "id": "agent-usage", "label": "Are you using an AI agent?", "required": true}
            ],
            "subcommand": "help",
            "sourceFile": "help_question.yml"
        }
    }'
}

# ============================================================================
# PUBLIC: GET TEMPLATE FOR SUBCOMMAND
# ============================================================================

# Given a subcommand name (bug/feature/help), return that template's JSON config
# Args: $1 = subcommand name
#        $2 = (optional) repo root directory (defaults to pwd)
# Output: JSON object with the template config, or empty object if not found
get_template_for_subcommand() {
    local subcommand="$1"
    local repo_root="${2:-.}"
    local config

    config=$(get_template_config "$repo_root")

    local template
    template=$(echo "$config" | jq -c --arg cmd "$subcommand" '.[$cmd] // empty')

    if [[ -z "$template" ]]; then
        _tp_log_warn "No template found for subcommand: $subcommand"
        echo "{}"
        return 1
    fi

    echo "$template"
}

# ============================================================================
# PUBLIC: LABEL VALIDATION
# ============================================================================

# Check which labels exist in a GitHub repo
# Args: $1 = repo (owner/name format)
#        $2 = comma-separated label list
# Output: JSON with "existing" and "missing" arrays
# Returns: 0 always (missing labels is not an error condition)
validate_labels_exist() {
    local repo="$1"
    local label_list="$2"

    if [[ -z "$repo" || -z "$label_list" ]]; then
        _tp_log_error "validate_labels_exist requires repo and label_list"
        echo '{"existing":[],"missing":[]}'
        return 1
    fi

    # Check gh CLI availability
    if ! command -v gh &>/dev/null; then
        _tp_log_warn "gh CLI not available, cannot validate labels"
        # Return all as missing since we can't check
        local all_labels
        all_labels=$(echo "$label_list" | jq -Rc '[split(",")[] | ltrimstr(" ") | rtrimstr(" ")]')
        jq -nc --argjson missing "$all_labels" '{"existing":[],"missing":$missing}'
        return 0
    fi

    # Fetch existing labels from the repo
    local repo_labels
    repo_labels=$(gh label list --repo "$repo" --json name --limit 200 2>/dev/null) || {
        _tp_log_warn "Failed to fetch labels from $repo"
        local all_labels
        all_labels=$(echo "$label_list" | jq -Rc '[split(",")[] | ltrimstr(" ") | rtrimstr(" ")]')
        jq -nc --argjson missing "$all_labels" '{"existing":[],"missing":$missing}'
        return 0
    }

    # Compare requested labels against existing
    local requested_labels
    requested_labels=$(echo "$label_list" | jq -Rc '[split(",")[] | ltrimstr(" ") | rtrimstr(" ")]')

    jq -nc \
        --argjson requested "$requested_labels" \
        --argjson repoLabels "$repo_labels" \
        '{
            existing: [
                $requested[] |
                . as $req |
                select([$repoLabels[].name] | map(ascii_downcase) | index($req | ascii_downcase))
            ],
            missing: [
                $requested[] |
                . as $req |
                select([$repoLabels[].name] | map(ascii_downcase) | index($req | ascii_downcase) | not)
            ]
        }'
}

# ============================================================================
# PUBLIC: ENSURE LABELS EXIST
# ============================================================================

# Create any missing labels in the repo with sensible defaults
# Args: $1 = repo (owner/name format)
#        $2 = comma-separated label list
# Output: JSON with "created" and "existing" arrays
# Returns: 0 on success, 1 on error
ensure_labels_exist() {
    local repo="$1"
    local label_list="$2"

    if [[ -z "$repo" || -z "$label_list" ]]; then
        _tp_log_error "ensure_labels_exist requires repo and label_list"
        return 1
    fi

    # Check gh CLI availability
    if ! command -v gh &>/dev/null; then
        _tp_log_error "gh CLI is required to create labels"
        return 1
    fi

    # First check which labels exist
    local validation
    validation=$(validate_labels_exist "$repo" "$label_list")

    local existing missing
    existing=$(echo "$validation" | jq -c '.existing')
    missing=$(echo "$validation" | jq -c '.missing')

    local missing_count
    missing_count=$(echo "$missing" | jq 'length')

    if [[ "$missing_count" -eq 0 ]]; then
        jq -nc \
            --argjson existing "$existing" \
            '{"created":[],"existing":$existing}'
        return 0
    fi

    # Default colors for common label types
    local created="[]"
    local label color description

    while IFS= read -r label; do
        # Assign sensible defaults based on label name
        color=$(_tp_label_color "$label")
        description=$(_tp_label_description "$label")

        _tp_log_warn "Creating missing label '$label' in $repo"

        if gh label create "$label" \
            --repo "$repo" \
            --color "$color" \
            --description "$description" \
            &>/dev/null 2>&1; then
            created=$(echo "$created" | jq -c --arg l "$label" '. + [$l]')
        else
            _tp_log_warn "Failed to create label '$label' (may require write access)"
        fi
    done < <(echo "$missing" | jq -r '.[]')

    jq -nc \
        --argjson created "$created" \
        --argjson existing "$existing" \
        '{"created":$created,"existing":$existing}'
}

# Map label names to sensible hex colors
_tp_label_color() {
    local label="$1"
    case "$label" in
        bug)          echo "d73a4a" ;;
        enhancement)  echo "a2eeef" ;;
        question)     echo "d876e3" ;;
        help)         echo "0075ca" ;;
        triage)       echo "fbca04" ;;
        documentation) echo "0075ca" ;;
        duplicate)    echo "cfd3d7" ;;
        invalid)      echo "e4e669" ;;
        wontfix)      echo "ffffff" ;;
        *)            echo "ededed" ;;
    esac
}

# Map label names to sensible descriptions
_tp_label_description() {
    local label="$1"
    case "$label" in
        bug)          echo "Something isn't working" ;;
        enhancement)  echo "New feature or request" ;;
        question)     echo "Further information is requested" ;;
        help)         echo "Help wanted" ;;
        triage)       echo "Needs triage and categorization" ;;
        documentation) echo "Improvements or additions to documentation" ;;
        duplicate)    echo "This issue or pull request already exists" ;;
        invalid)      echo "This doesn't seem right" ;;
        wontfix)      echo "This will not be worked on" ;;
        *)            echo "Auto-created by CLEO issue template parser" ;;
    esac
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f parse_issue_templates
export -f _parse_single_template
export -f get_template_config
export -f get_template_for_subcommand
export -f validate_labels_exist
export -f ensure_labels_exist
