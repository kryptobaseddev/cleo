#!/usr/bin/env bash
###CLEO
# command: issue
# category: system
# synopsis: File bug reports, feature requests, or questions to CLEO GitHub repo
# relevance: medium
# flags: --format,--json,--human,--quiet,--dry-run,--title,--body,--severity,--area,--open
# exits: 0,2,5,6,8
# json-output: true
# subcommands: bug,feature,help,diagnostics
###END
# ============================================================================
# scripts/issue.sh - File issues against the CLEO GitHub repository
# ============================================================================
# Allows end users (who have CLEO installed but NOT the repo) to file issues
# directly from their terminal against kryptobaseddev/cleo.
#
# Usage:
#   cleo issue bug --title "..." --body "..."
#   cleo issue feature --title "..." --body "..."
#   cleo issue help --title "..." --body "..."
#   cleo issue diagnostics
#   cleo issue bug --dry-run --title "Test" --body "Body"
#
# Exit Codes:
#   0 - Issue filed successfully
#   2 - Invalid input (missing subcommand or bad flags)
#   5 - Dependency error (gh not installed or not authenticated)
#   6 - Validation error (missing required fields)
#   8 - Config error (gh API error during issue creation)
# ============================================================================

set -euo pipefail

# ============================================================================
# INITIALIZATION
# ============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# Source required libraries
source "$LIB_DIR/core/exit-codes.sh"
source "$LIB_DIR/core/error-json.sh"
source "$LIB_DIR/core/output-format.sh"
source "$LIB_DIR/core/version.sh"
source "$LIB_DIR/ui/flags.sh"

# Command name for error reporting
COMMAND_NAME="issue"

# Constants
readonly CLEO_REPO="kryptobaseddev/cleo"

# ============================================================================
# SUBCOMMAND FLAGS
# ============================================================================
SUBCOMMAND=""
TITLE=""
BODY=""
SEVERITY=""
AREA=""
OPEN_BROWSER=false

# ============================================================================
# HELP
# ============================================================================
show_help() {
    cat <<'EOF'
Usage: cleo issue <subcommand> [OPTIONS]

File bug reports, feature requests, or questions to the CLEO GitHub repo.

SUBCOMMANDS:
    bug             File a bug report
    feature         Request a new feature
    help            Ask a question
    diagnostics     Show system diagnostics (no issue filed)

OPTIONS:
    --title TEXT    Issue title (required for bug/feature/help)
    --body TEXT     Issue body/description (required for bug/feature/help)
    --severity SEV  Severity level: low, medium, high, critical (bug only)
    --area AREA     Affected area: cli, mcp, docs, tests, other
    --open          Open the issue in browser after creation
    --dry-run       Show what would be created without filing
    -f, --format    Output format: json (default) or human
    --json          Shorthand for --format json
    --human         Shorthand for --format human
    -q, --quiet     Suppress non-essential output
    -h, --help      Show this help message

EXAMPLES:
    # File a bug report
    cleo issue bug --title "Task IDs duplicated" --body "When running..."

    # File a feature request
    cleo issue feature --title "Add CSV export" --body "It would be useful..."

    # Ask a question
    cleo issue help --title "How to configure multi-session?" --body "I'm trying to..."

    # Show diagnostics (for including in bug reports)
    cleo issue diagnostics --human

    # Dry run to preview issue
    cleo issue bug --dry-run --title "Test" --body "Testing"
EOF
}

# ============================================================================
# DEPENDENCY CHECKS
# ============================================================================

# Check that gh CLI is installed and authenticated
check_gh_cli() {
    if ! command -v gh &>/dev/null; then
        output_error "E_DEPENDENCY_MISSING" \
            "GitHub CLI (gh) is not installed" \
            "$EXIT_DEPENDENCY_ERROR" \
            "true" \
            "Install gh: https://cli.github.com/ or 'brew install gh'"
        return "$EXIT_DEPENDENCY_ERROR"
    fi

    if ! gh auth status --hostname github.com &>/dev/null 2>&1; then
        output_error "E_DEPENDENCY_MISSING" \
            "GitHub CLI is not authenticated" \
            "$EXIT_DEPENDENCY_ERROR" \
            "true" \
            "Run 'gh auth login' to authenticate"
        return "$EXIT_DEPENDENCY_ERROR"
    fi

    return 0
}

# ============================================================================
# DIAGNOSTICS
# ============================================================================

# Collect system diagnostics for bug reports
collect_diagnostics() {
    local cleo_version bash_version jq_version os_info shell_name
    local cleo_home gh_version install_location

    cleo_version=$(get_version 2>/dev/null || echo "unknown")
    bash_version="${BASH_VERSION:-unknown}"
    jq_version=$(jq --version 2>/dev/null || echo "not installed")
    os_info=$(uname -srm 2>/dev/null || echo "unknown")
    shell_name=$(basename "${SHELL:-unknown}" 2>/dev/null || echo "unknown")
    cleo_home="${CLEO_HOME:-$HOME/.cleo}"
    gh_version=$(gh --version 2>/dev/null | head -1 || echo "not installed")
    install_location=$(command -v cleo 2>/dev/null || echo "not found")

    jq -n \
        --arg cleo_version "$cleo_version" \
        --arg bash_version "$bash_version" \
        --arg jq_version "$jq_version" \
        --arg os "$os_info" \
        --arg shell "$shell_name" \
        --arg cleo_home "$cleo_home" \
        --arg gh_version "$gh_version" \
        --arg install_location "$install_location" \
        '{
            cleoVersion: $cleo_version,
            bashVersion: $bash_version,
            jqVersion: $jq_version,
            os: $os,
            shell: $shell,
            cleoHome: $cleo_home,
            ghVersion: $gh_version,
            installLocation: $install_location
        }'
}

# ============================================================================
# TEMPLATE BODY BUILDER
# ============================================================================
# Structures the user-provided --body content into sections that align with
# the GitHub issue templates (.github/ISSUE_TEMPLATE/*.yml).
# Templates are the source of truth for required fields and structure.

build_template_body() {
    local issue_type="$1"
    local raw_body="$2"

    # Severity/area metadata (appended as structured fields)
    local meta=""
    [[ -n "$SEVERITY" ]] && meta="${meta}\n**Severity**: ${SEVERITY}"
    [[ -n "$AREA" ]] && meta="${meta}\n**Area**: ${AREA}"

    case "$issue_type" in
        bug)
            # Matches bug_report.yml: description, steps, expected, diagnostics
            printf '### What happened?\n\n%s' "$raw_body"
            [[ -n "$meta" ]] && printf '\n%b' "$meta"
            printf '\n\n### Are you using an AI agent?\n\nYes - AI agent filed this issue\n'
            ;;
        feature)
            # Matches feature_request.yml: problem, solution, area, scope
            printf '### Problem or use case\n\n%s' "$raw_body"
            [[ -n "$meta" ]] && printf '\n%b' "$meta"
            printf '\n\n### Are you using an AI agent?\n\nYes - AI agent filed this request\n'
            ;;
        help)
            # Matches help_question.yml: question, tried, topic
            printf '### What do you need help with?\n\n%s' "$raw_body"
            [[ -n "$meta" ]] && printf '\n%b' "$meta"
            printf '\n\n### Are you using an AI agent?\n\nYes - AI agent filed this question\n'
            ;;
        *)
            printf '%s' "$raw_body"
            [[ -n "$meta" ]] && printf '\n%b' "$meta"
            ;;
    esac
}

# ============================================================================
# ISSUE BODY BUILDER
# ============================================================================

# Build the full issue body with user content + auto-appended diagnostics
build_issue_body() {
    local user_body="$1"
    local diag_json
    diag_json=$(collect_diagnostics)

    local diag_block
    diag_block=$(echo "$diag_json" | jq -r '
        "## Environment\n" +
        "| Component | Version |\n" +
        "|-----------|----------|\n" +
        "| CLEO | " + .cleoVersion + " |\n" +
        "| Bash | " + .bashVersion + " |\n" +
        "| jq | " + .jqVersion + " |\n" +
        "| OS | " + .os + " |\n" +
        "| Shell | " + .shell + " |\n" +
        "| gh CLI | " + .ghVersion + " |\n" +
        "| Install | " + .installLocation + " |"
    ')

    printf '%s\n\n---\n\n%s\n' "$user_body" "$diag_block"
}

# ============================================================================
# ISSUE CREATION
# ============================================================================

# Create the GitHub issue via gh CLI
# Args: $1=title, $2=body, $3=labels (comma-separated)
create_issue() {
    local title="$1"
    local body="$2"
    local labels="$3"

    local gh_output
    local gh_exit=0

    gh_output=$(gh issue create \
        --repo "$CLEO_REPO" \
        --title "$title" \
        --body "$body" \
        --label "$labels" \
        2>&1) || gh_exit=$?

    if [[ $gh_exit -ne 0 ]]; then
        output_error "E_CONFIG_ERROR" \
            "Failed to create issue: $gh_output" \
            "$EXIT_CONFIG_ERROR" \
            "true" \
            "Check gh auth status and network connectivity"
        return "$EXIT_CONFIG_ERROR"
    fi

    # gh issue create outputs the issue URL
    local issue_url="$gh_output"
    local issue_number
    issue_number=$(echo "$issue_url" | grep -oE '[0-9]+$' || echo "unknown")

    # Open in browser if requested
    if [[ "$OPEN_BROWSER" == true ]] && [[ "$issue_url" =~ ^https:// ]]; then
        gh issue view "$issue_number" --repo "$CLEO_REPO" --web &>/dev/null || true
    fi

    echo "$issue_url"
}

# ============================================================================
# ARGUMENT PARSING
# ============================================================================
parse_args() {
    init_flag_defaults
    parse_common_flags "$@"
    set -- "${REMAINING_ARGS[@]}"

    # Handle help flag
    if [[ "$FLAG_HELP" == true ]]; then
        show_help
        exit 0
    fi

    # Extract subcommand
    if [[ $# -gt 0 ]]; then
        SUBCOMMAND="$1"
        shift
    fi

    # Parse command-specific flags
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --title)
                if [[ -z "${2:-}" ]]; then
                    output_error "E_INPUT_MISSING" \
                        "--title requires a value" \
                        "$EXIT_INVALID_INPUT" \
                        "true" \
                        "Provide a title: --title \"Your issue title\""
                    exit "$EXIT_INVALID_INPUT"
                fi
                TITLE="$2"
                shift 2
                ;;
            --body)
                if [[ -z "${2:-}" ]]; then
                    output_error "E_INPUT_MISSING" \
                        "--body requires a value" \
                        "$EXIT_INVALID_INPUT" \
                        "true" \
                        "Provide a body: --body \"Describe the issue\""
                    exit "$EXIT_INVALID_INPUT"
                fi
                BODY="$2"
                shift 2
                ;;
            --severity)
                if [[ -z "${2:-}" ]]; then
                    output_error "E_INPUT_MISSING" \
                        "--severity requires a value" \
                        "$EXIT_INVALID_INPUT" \
                        "true" \
                        "Provide severity: --severity low|medium|high|critical"
                    exit "$EXIT_INVALID_INPUT"
                fi
                SEVERITY="$2"
                shift 2
                ;;
            --area)
                if [[ -z "${2:-}" ]]; then
                    output_error "E_INPUT_MISSING" \
                        "--area requires a value" \
                        "$EXIT_INVALID_INPUT" \
                        "true" \
                        "Provide area: --area cli|mcp|docs|tests|other"
                    exit "$EXIT_INVALID_INPUT"
                fi
                AREA="$2"
                shift 2
                ;;
            --open)
                OPEN_BROWSER=true
                shift
                ;;
            *)
                output_error "E_INPUT_INVALID" \
                    "Unknown option: $1" \
                    "$EXIT_INVALID_INPUT" \
                    "true" \
                    "Run 'cleo issue --help' for usage"
                exit "$EXIT_INVALID_INPUT"
                ;;
        esac
    done

    # Apply common flags to globals
    apply_flags_to_globals
    FORMAT=$(resolve_format "$FORMAT")
}

# ============================================================================
# INTERACTIVE PROMPTS
# ============================================================================

# Prompt for missing fields when running in a TTY
prompt_if_tty() {
    local field="$1"
    local prompt_text="$2"
    local current_value="$3"

    if [[ -n "$current_value" ]]; then
        echo "$current_value"
        return 0
    fi

    if [[ -t 0 ]]; then
        local value
        read -r -p "$prompt_text: " value
        echo "$value"
    else
        echo ""
    fi
}

# ============================================================================
# SUBCOMMAND HANDLERS
# ============================================================================

handle_diagnostics() {
    local diag_json
    diag_json=$(collect_diagnostics)

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    if [[ "$FORMAT" == "json" ]]; then
        jq -n \
            --arg timestamp "$timestamp" \
            --arg version "$(get_version)" \
            --argjson diagnostics "$diag_json" \
            '{
                "_meta": {
                    "format": "json",
                    "command": "issue diagnostics",
                    "timestamp": $timestamp,
                    "version": $version
                },
                "success": true,
                "result": {
                    "diagnostics": $diagnostics
                }
            }'
    else
        echo "CLEO Diagnostics"
        echo "================"
        echo ""
        echo "$diag_json" | jq -r '
            "CLEO Version:    " + .cleoVersion,
            "Bash Version:    " + .bashVersion,
            "jq Version:      " + .jqVersion,
            "OS:              " + .os,
            "Shell:           " + .shell,
            "CLEO Home:       " + .cleoHome,
            "gh CLI:          " + .ghVersion,
            "Install Path:    " + .installLocation
        '
    fi
}

handle_issue_type() {
    local issue_type="$1"
    local labels="$2"

    # Interactive prompts for TTY when flags are missing
    TITLE=$(prompt_if_tty "title" "Issue title" "$TITLE")
    BODY=$(prompt_if_tty "body" "Description" "$BODY")

    # Validate required fields
    if [[ -z "$TITLE" ]]; then
        output_error "E_INPUT_MISSING" \
            "Missing required field: --title" \
            "$EXIT_VALIDATION_ERROR" \
            "true" \
            "Provide --title \"Your issue title\""
        exit "$EXIT_VALIDATION_ERROR"
    fi

    if [[ -z "$BODY" ]]; then
        output_error "E_INPUT_MISSING" \
            "Missing required field: --body" \
            "$EXIT_VALIDATION_ERROR" \
            "true" \
            "Provide --body \"Describe the issue\""
        exit "$EXIT_VALIDATION_ERROR"
    fi

    # Apply template title prefix (matches .github/ISSUE_TEMPLATE/*.yml)
    local prefixed_title
    case "$issue_type" in
        bug)     prefixed_title="[Bug]: $TITLE" ;;
        feature) prefixed_title="[Feature]: $TITLE" ;;
        help)    prefixed_title="[Question]: $TITLE" ;;
        *)       prefixed_title="$TITLE" ;;
    esac
    TITLE="$prefixed_title"

    # Build structured body matching template sections
    local user_body
    user_body=$(build_template_body "$issue_type" "$BODY")

    # Build full body with auto-appended diagnostics
    local full_body
    full_body=$(build_issue_body "$user_body")

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Dry run mode
    if [[ "$FLAG_DRY_RUN" == true ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            jq -n \
                --arg timestamp "$timestamp" \
                --arg version "$(get_version)" \
                --arg title "$TITLE" \
                --arg body "$full_body" \
                --arg labels "$labels" \
                --arg repo "$CLEO_REPO" \
                --arg type "$issue_type" \
                '{
                    "_meta": {
                        "format": "json",
                        "command": "issue",
                        "timestamp": $timestamp,
                        "version": $version
                    },
                    "success": true,
                    "dryRun": true,
                    "result": {
                        "type": $type,
                        "repo": $repo,
                        "title": $title,
                        "labels": ($labels | split(",")),
                        "body": $body
                    }
                }'
        else
            echo "DRY RUN - Issue Preview"
            echo "======================="
            echo ""
            echo "Type:   $issue_type"
            echo "Repo:   $CLEO_REPO"
            echo "Title:  $TITLE"
            echo "Labels: $labels"
            echo ""
            echo "--- Body ---"
            echo "$full_body"
            echo "--- End ---"
        fi
        return 0
    fi

    # Check gh CLI before attempting to create
    check_gh_cli || exit $?

    # Create the issue
    local issue_url
    issue_url=$(create_issue "$TITLE" "$full_body" "$labels") || exit $?

    local issue_number
    issue_number=$(echo "$issue_url" | grep -oE '[0-9]+$' || echo "unknown")

    if [[ "$FORMAT" == "json" ]]; then
        jq -n \
            --arg timestamp "$timestamp" \
            --arg version "$(get_version)" \
            --arg url "$issue_url" \
            --arg number "$issue_number" \
            --arg title "$TITLE" \
            --arg labels "$labels" \
            --arg type "$issue_type" \
            '{
                "_meta": {
                    "format": "json",
                    "command": "issue",
                    "timestamp": $timestamp,
                    "version": $version
                },
                "success": true,
                "result": {
                    "type": $type,
                    "url": $url,
                    "number": ($number | tonumber? // $number),
                    "title": $title,
                    "labels": ($labels | split(","))
                }
            }'
    else
        echo "Issue created: $issue_url"
    fi
}

# ============================================================================
# MAIN
# ============================================================================
main() {
    parse_args "$@"

    # Validate subcommand
    case "$SUBCOMMAND" in
        bug)
            handle_issue_type "bug" "bug,triage"
            ;;
        feature)
            handle_issue_type "feature" "enhancement,triage"
            ;;
        help)
            handle_issue_type "help" "question,help"
            ;;
        diagnostics)
            handle_diagnostics
            ;;
        "")
            if [[ "$FORMAT" == "json" ]]; then
                output_error "E_INPUT_MISSING" \
                    "Missing subcommand" \
                    "$EXIT_INVALID_INPUT" \
                    "true" \
                    "Use: cleo issue bug|feature|help|diagnostics"
            else
                show_help
            fi
            exit "$EXIT_INVALID_INPUT"
            ;;
        *)
            output_error "E_INPUT_INVALID" \
                "Unknown subcommand: $SUBCOMMAND" \
                "$EXIT_INVALID_INPUT" \
                "true" \
                "Use: cleo issue bug|feature|help|diagnostics"
            exit "$EXIT_INVALID_INPUT"
            ;;
    esac
}

main "$@"
