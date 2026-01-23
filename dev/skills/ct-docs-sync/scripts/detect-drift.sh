#!/usr/bin/env bash
#
# detect-drift.sh - Detect documentation drift in CLEO
#
# Usage: ./detect-drift.sh [--quick|--full|--strict] [--recommend] [--json]
#
# Exit codes:
#   0 - No drift detected
#   1 - Drift detected (warnings only in non-strict mode)
#   2 - Critical drift detected (missing commands in index)

set -uo pipefail
# Note: -e removed to allow script to continue on individual command failures

# Colors
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
DRIFT_CONFIG="$SCRIPT_DIR/../drift-config.json"
COMMANDS_INDEX="$PROJECT_ROOT/docs/commands/COMMANDS-INDEX.json"
SCRIPTS_DIR="$PROJECT_ROOT/scripts"
README="$PROJECT_ROOT/README.md"
VERSION_FILE="$PROJECT_ROOT/VERSION"

# Config helper functions
get_config_array() {
    local key="$1"
    if [[ -f "$DRIFT_CONFIG" ]]; then
        jq -r "$key[]" "$DRIFT_CONFIG" 2>/dev/null
    fi
}

get_config() {
    local key="$1"
    local default="${2:-}"
    if [[ -f "$DRIFT_CONFIG" ]]; then
        jq -r "$key // \"$default\"" "$DRIFT_CONFIG" 2>/dev/null || echo "$default"
    else
        echo "$default"
    fi
}

# Paths from config
TODO_MGMT="$CLEO_HOME/docs/$(get_config '.agentInjectionDoc' 'TODO_Task_Management.md')"

# Options
MODE="full"
RECOMMEND=false
JSON_OUTPUT=false
STRICT=false

# Counters
WARNINGS=0
ERRORS=0

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --quick) MODE="quick"; shift ;;
        --full) MODE="full"; shift ;;
        --strict) STRICT=true; shift ;;
        --recommend) RECOMMEND=true; shift ;;
        --json) JSON_OUTPUT=true; shift ;;
        -h|--help)
            echo "Usage: $0 [--quick|--full|--strict] [--recommend] [--json]"
            echo ""
            echo "Options:"
            echo "  --quick      Check only commands index vs scripts"
            echo "  --full       Full check including docs and versions (default)"
            echo "  --strict     Exit with error on any drift"
            echo "  --recommend  Include fix recommendations"
            echo "  --json       Output in JSON format"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# Helper functions
log_header() {
    if [[ "$JSON_OUTPUT" == "false" ]]; then
        echo -e "\n${BLUE}[$1]${NC} $2"
    fi
}

log_ok() {
    if [[ "$JSON_OUTPUT" == "false" ]]; then
        echo -e "  ${GREEN}✓${NC} $1"
    fi
}

log_warn() {
    ((WARNINGS++))
    if [[ "$JSON_OUTPUT" == "false" ]]; then
        echo -e "  ${YELLOW}⚠${NC} $1"
    fi
}

log_error() {
    ((ERRORS++))
    if [[ "$JSON_OUTPUT" == "false" ]]; then
        echo -e "  ${RED}✗${NC} $1"
    fi
}

log_recommend() {
    if [[ "$RECOMMEND" == "true" && "$JSON_OUTPUT" == "false" ]]; then
        echo -e "    ${BLUE}→${NC} $1"
    fi
}

# Check if required files exist
check_prerequisites() {
    local missing=()

    [[ ! -f "$COMMANDS_INDEX" ]] && missing+=("COMMANDS-INDEX.json")
    [[ ! -d "$SCRIPTS_DIR" ]] && missing+=("scripts/")
    [[ ! -f "$README" ]] && missing+=("README.md")

    if [[ ${#missing[@]} -gt 0 ]]; then
        echo -e "${RED}ERROR: Missing required files:${NC}"
        printf '  - %s\n' "${missing[@]}"
        exit 2
    fi
}

# Get commands from scripts directory
get_script_commands() {
    ls "$SCRIPTS_DIR"/*.sh 2>/dev/null | xargs -n1 basename | sed 's/\.sh$//' | sort
}

# Get commands from COMMANDS-INDEX.json
get_index_commands() {
    jq -r '.commands[].name' "$COMMANDS_INDEX" 2>/dev/null | sort
}

# Get script names from COMMANDS-INDEX.json (for matching with scripts/)
get_index_scripts() {
    jq -r '.commands[].script // empty' "$COMMANDS_INDEX" 2>/dev/null | sed 's/\.sh$//' | grep -v '^$' | sort
}

# Get commands mentioned in README
get_readme_commands() {
    grep -oE 'cleo [a-z-]+' "$README" 2>/dev/null | sed 's/cleo //' | sort -u
}

# Check commands index vs scripts
check_commands_sync() {
    log_header "COMMANDS" "Checking scripts/ vs COMMANDS-INDEX.json"

    local scripts_cmds
    local index_scripts
    local index_cmds
    scripts_cmds=$(get_script_commands)
    index_scripts=$(get_index_scripts)
    index_cmds=$(get_index_commands)

    # Find scripts not in index (comparing script names, not command names)
    local missing_from_index
    missing_from_index=$(comm -23 <(echo "$scripts_cmds") <(echo "$index_scripts"))

    if [[ -n "$missing_from_index" ]]; then
        log_error "Scripts NOT in COMMANDS-INDEX.json:"
        while IFS= read -r script; do
            echo "    - ${script}.sh"
            log_recommend "Add entry with 'script: ${script}.sh' to docs/commands/COMMANDS-INDEX.json"
        done <<< "$missing_from_index"
    else
        log_ok "All scripts are registered in COMMANDS-INDEX.json"
    fi

    # Find index entries without scripts
    local orphaned_index
    orphaned_index=$(comm -13 <(echo "$scripts_cmds") <(echo "$index_scripts"))

    if [[ -n "$orphaned_index" ]]; then
        log_warn "Index script entries WITHOUT actual scripts:"
        while IFS= read -r script; do
            # Find the command name for this script
            local cmd_name
            cmd_name=$(jq -r ".commands[] | select(.script == \"${script}.sh\") | .name" "$COMMANDS_INDEX" 2>/dev/null)
            echo "    - ${script}.sh (command: ${cmd_name:-unknown})"
        done <<< "$orphaned_index"
    else
        log_ok "All index entries have corresponding scripts"
    fi

    # Count comparison (accounting for aliases)
    local script_count index_count alias_count
    script_count=$(echo "$scripts_cmds" | grep -c . || echo 0)
    index_count=$(echo "$index_cmds" | grep -c . || echo 0)
    alias_count=$(jq '[.commands[] | select(.aliasFor)] | length' "$COMMANDS_INDEX" 2>/dev/null || echo 0)

    echo "    Scripts: $script_count | Index entries: $index_count (including $alias_count aliases)"

    # Only warn if mismatch isn't explained by aliases
    local expected_with_aliases=$((script_count + alias_count))
    if [[ "$expected_with_aliases" != "$index_count" ]]; then
        log_warn "Unexpected count mismatch: expected $expected_with_aliases (scripts + aliases), got $index_count"
    fi
}

# Check command documentation files
check_command_docs() {
    log_header "DOCS" "Checking docs/commands/*.md coverage"

    local index_cmds
    index_cmds=$(get_index_commands)
    local missing_docs=()

    while IFS= read -r cmd; do
        if [[ ! -f "$PROJECT_ROOT/docs/commands/$cmd.md" ]]; then
            missing_docs+=("$cmd")
        fi
    done <<< "$index_cmds"

    if [[ ${#missing_docs[@]} -gt 0 ]]; then
        log_warn "Commands without individual docs (${#missing_docs[@]}):"
        for cmd in "${missing_docs[@]}"; do
            echo "    - $cmd"
            log_recommend "Create docs/commands/$cmd.md"
        done
    else
        log_ok "All commands have documentation files"
    fi
}

# Check version consistency
check_version_sync() {
    log_header "VERSION" "Checking version consistency"

    local version_file_ver=""
    local readme_ver=""
    local vision_ver=""

    # Get version from VERSION file
    if [[ -f "$VERSION_FILE" ]]; then
        version_file_ver=$(cat "$VERSION_FILE" | tr -d '\n')
    fi

    # Get version from README badge
    if [[ -f "$README" ]]; then
        readme_ver=$(grep -oE 'version-[0-9]+\.[0-9]+\.[0-9]+' "$README" | head -1 | sed 's/version-//')
    fi

    # Get version from primary VISION doc (first in config)
    local primary_vision
    primary_vision=$(get_config_array '.visionDocs' | head -1)
    if [[ -n "$primary_vision" && -f "$PROJECT_ROOT/$primary_vision" ]]; then
        vision_ver=$(grep -oE 'Version [0-9]+\.[0-9]+\.[0-9]+' "$PROJECT_ROOT/$primary_vision" | head -1 | sed 's/Version //')
    fi

    echo "    VERSION file: ${version_file_ver:-'(not found)'}"
    echo "    README badge: ${readme_ver:-'(not found)'}"
    echo "    VISION doc:   ${vision_ver:-'(not found)'}"

    if [[ -n "$version_file_ver" && -n "$readme_ver" && "$version_file_ver" != "$readme_ver" ]]; then
        log_warn "VERSION file ($version_file_ver) != README ($readme_ver)"
        log_recommend "Run ./dev/bump-version.sh $version_file_ver"
    else
        log_ok "VERSION and README are in sync"
    fi
}

# Check README command coverage
check_readme_commands() {
    log_header "README" "Checking README command mentions"

    local index_cmds readme_cmds
    index_cmds=$(get_index_commands)
    readme_cmds=$(get_readme_commands)

    # Critical commands that MUST be in README
    local critical_cmds=("list" "add" "complete" "find" "show" "analyze" "session" "focus" "dash")
    local missing_critical=()

    for cmd in "${critical_cmds[@]}"; do
        if ! echo "$readme_cmds" | grep -q "^${cmd}$"; then
            missing_critical+=("$cmd")
        fi
    done

    if [[ ${#missing_critical[@]} -gt 0 ]]; then
        log_warn "Critical commands missing from README:"
        for cmd in "${missing_critical[@]}"; do
            echo "    - $cmd"
        done
    else
        log_ok "All critical commands are mentioned in README"
    fi
}

# Check vision document currency
check_vision_docs() {
    log_header "VISION" "Checking vision document currency"

    # Get vision docs from config
    local vision_doc
    local first_doc=true

    while IFS= read -r vision_doc; do
        [[ -z "$vision_doc" ]] && continue
        local full_path="$PROJECT_ROOT/$vision_doc"
        local doc_name=$(basename "$vision_doc")

        if [[ -f "$full_path" ]]; then
            # Only check age/sections for primary vision doc
            if [[ "$first_doc" == "true" ]]; then
                local vision_date
                vision_date=$(stat -c %Y "$full_path" 2>/dev/null || stat -f %m "$full_path" 2>/dev/null)
                local now=$(date +%s)
                local age_days=$(( (now - vision_date) / 86400 ))

                if [[ $age_days -gt 30 ]]; then
                    log_warn "$doc_name is $age_days days old"
                    log_recommend "Review and update $vision_doc"
                else
                    log_ok "$doc_name updated within last 30 days"
                fi

                if grep -q "## Command System Architecture" "$full_path"; then
                    log_ok "Command System Architecture section present"
                else
                    log_warn "Missing Command System Architecture section"
                    log_recommend "Add Command System Architecture section to VISION doc"
                fi
                first_doc=false
            else
                log_ok "$doc_name exists"
            fi
        else
            log_warn "$doc_name not found"
        fi
    done < <(get_config_array '.visionDocs')

    # Fallback if no config
    if [[ "$first_doc" == "true" ]]; then
        log_warn "No vision docs configured in drift-config.json"
    fi
}

# Check TODO_Task_Management.md
check_agent_injection() {
    log_header "INJECTION" "Checking TODO_Task_Management.md"

    if [[ -f "$TODO_MGMT" ]]; then
        log_ok "TODO_Task_Management.md exists at $TODO_MGMT"

        # Check for critical sections from config
        local section pattern
        local sections_checked=0

        while IFS= read -r section; do
            [[ -z "$section" ]] && continue
            pattern=$(jq -r ".requiredSections[\"$section\"]" "$DRIFT_CONFIG" 2>/dev/null)
            if [[ -n "$pattern" && "$pattern" != "null" ]]; then
                ((sections_checked++))
                if grep -qE "$pattern" "$TODO_MGMT"; then
                    log_ok "Section '$section' present"
                else
                    log_warn "Section '$section' missing"
                fi
            fi
        done < <(jq -r '.requiredSections | keys[]' "$DRIFT_CONFIG" 2>/dev/null)

        # Fallback to defaults if no config
        if [[ $sections_checked -eq 0 ]]; then
            local -A fallback_sections=(
                ["Command Reference"]="^## Command Reference"
                ["Session Management"]="^### Focus & Session|^### Multi-Session|^## Session Protocol"
                ["Core Operations"]="^### Core Operations"
            )
            for section in "${!fallback_sections[@]}"; do
                if grep -qE "${fallback_sections[$section]}" "$TODO_MGMT"; then
                    log_ok "Section '$section' present"
                else
                    log_warn "Section '$section' missing"
                fi
            done
        fi
    else
        log_error "TODO_Task_Management.md not found at $TODO_MGMT"
        log_recommend "Run cleo upgrade to regenerate agent injection docs"
    fi
}

# Main execution
main() {
    if [[ "$JSON_OUTPUT" == "false" ]]; then
        echo "========================================"
        echo "  CLEO Documentation Drift Detection"
        echo "========================================"
        echo "Mode: $MODE"
        echo "Project: $PROJECT_ROOT"
    fi

    check_prerequisites

    # Always check commands sync
    check_commands_sync

    if [[ "$MODE" == "full" ]]; then
        check_command_docs
        check_version_sync
        check_readme_commands
        check_vision_docs
        check_agent_injection
    fi

    # Summary
    if [[ "$JSON_OUTPUT" == "false" ]]; then
        echo ""
        echo "========================================"
        echo "  Summary"
        echo "========================================"
        echo -e "  Errors:   ${RED}$ERRORS${NC}"
        echo -e "  Warnings: ${YELLOW}$WARNINGS${NC}"

        if [[ $ERRORS -gt 0 ]]; then
            echo -e "\n${RED}Critical drift detected. Fix errors before release.${NC}"
        elif [[ $WARNINGS -gt 0 ]]; then
            echo -e "\n${YELLOW}Drift detected. Review warnings.${NC}"
        else
            echo -e "\n${GREEN}No drift detected. Documentation is in sync.${NC}"
        fi
    fi

    # Exit codes
    if [[ $ERRORS -gt 0 ]]; then
        exit 2
    elif [[ "$STRICT" == "true" && $WARNINGS -gt 0 ]]; then
        exit 1
    fi

    exit 0
}

main "$@"
