#!/usr/bin/env bash
# dev-output.sh - Output formatting and logging functions for development scripts
# Part of claude-todo development tooling
#
# Provides standardized logging functions (dev_log_info, dev_log_error, etc.)
# and output formatting utilities (headers, summaries, check results).
#
# Dependencies:
#   - dev-colors.sh (required)
#   - dev-exit-codes.sh (required)
#
# Usage:
#   source "${DEV_LIB_DIR}/dev-output.sh"
#   dev_log_info "Operation successful"
#   dev_log_error "Something went wrong"
#
# Version: 1.0.0

# ============================================================================
# GUARD AGAINST MULTIPLE SOURCING
# ============================================================================
[[ -n "${_DEV_OUTPUT_SH_LOADED:-}" ]] && return 0
_DEV_OUTPUT_SH_LOADED=1

# ============================================================================
# DEPENDENCIES
# ============================================================================

_DEV_OUTPUT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source required dependencies
if [[ -f "$_DEV_OUTPUT_LIB_DIR/dev-colors.sh" ]]; then
    source "$_DEV_OUTPUT_LIB_DIR/dev-colors.sh"
else
    echo "ERROR: dev-output.sh requires dev-colors.sh" >&2
    exit 1
fi

if [[ -f "$_DEV_OUTPUT_LIB_DIR/dev-exit-codes.sh" ]]; then
    source "$_DEV_OUTPUT_LIB_DIR/dev-exit-codes.sh"
else
    echo "ERROR: dev-output.sh requires dev-exit-codes.sh" >&2
    exit 1
fi

# ============================================================================
# LOGGING FUNCTIONS
# ============================================================================

# Log success/info message
# Args: $@ = message
dev_log_info() {
    echo -e "${DEV_GREEN}${DEV_SYM_CHECK}${DEV_NC} $*"
}

# Log warning message
# Args: $@ = message
dev_log_warn() {
    echo -e "${DEV_YELLOW}${DEV_SYM_WARN}${DEV_NC} $*"
}

# Log error message (to stderr)
# Args: $@ = message
dev_log_error() {
    echo -e "${DEV_RED}${DEV_SYM_CROSS}${DEV_NC} $*" >&2
}

# Log step/action message
# Args: $@ = message
dev_log_step() {
    echo -e "${DEV_BLUE}${DEV_SYM_ARROW}${DEV_NC} $*"
}

# Log skip message (dimmed)
# Args: $@ = message
dev_log_skip() {
    echo -e "${DEV_DIM}${DEV_SYM_SKIP} $* (skipped)${DEV_NC}"
}

# Log debug message (only if DEV_DEBUG is set)
# Args: $@ = message
dev_log_debug() {
    [[ -n "${DEV_DEBUG:-}" ]] && echo -e "${DEV_DIM}[DEBUG]${DEV_NC} $*" >&2 || true
}

# ============================================================================
# LEGACY COMPATIBILITY ALIASES
# ============================================================================
# These allow existing scripts to work without the dev_ prefix

log_info() { dev_log_info "$@"; }
log_warn() { dev_log_warn "$@"; }
log_error() { dev_log_error "$@"; }
log_step() { dev_log_step "$@"; }
log_check() { dev_log_step "$@"; }  # Alias used in validate-version.sh

# ============================================================================
# CHECK RESULT OUTPUT
# ============================================================================

# Print check result with status
# Args: $1 = status (pass|fail|skip|warn|info)
#       $2 = message
#       $3 = details (optional)
dev_print_check() {
    local status="$1"
    local message="$2"
    local details="${3:-}"

    case "$status" in
        pass)
            echo -e "  ${DEV_GREEN}${DEV_SYM_CHECK}${DEV_NC} $message"
            ;;
        fail)
            echo -e "  ${DEV_RED}${DEV_SYM_CROSS}${DEV_NC} $message"
            [[ -n "$details" ]] && echo -e "    ${DEV_DIM}$details${DEV_NC}"
            ;;
        skip)
            echo -e "  ${DEV_DIM}${DEV_SYM_SKIP} $message (skipped)${DEV_NC}"
            ;;
        warn)
            echo -e "  ${DEV_YELLOW}${DEV_SYM_WARN}${DEV_NC} $message"
            [[ -n "$details" ]] && echo -e "    ${DEV_DIM}$details${DEV_NC}"
            ;;
        info)
            echo -e "  ${DEV_BLUE}${DEV_SYM_INFO}${DEV_NC} $message"
            ;;
        *)
            echo -e "  $message"
            ;;
    esac
}

# Legacy alias
print_check() { dev_print_check "$@"; }

# ============================================================================
# SECTION HEADERS
# ============================================================================

# Print section header
# Args: $1 = title
dev_print_header() {
    local title="$1"
    local len=${#title}

    echo ""
    echo -e "${DEV_BOLD}${DEV_CYAN}$title${DEV_NC}"
    printf '%0.s─' $(seq 1 $((len > 60 ? 60 : len)))
    echo ""
}

# Print subsection header (less prominent)
# Args: $1 = title
dev_print_subheader() {
    local title="$1"
    echo ""
    echo -e "${DEV_CYAN}$title${DEV_NC}"
}

# Legacy alias
print_header() { dev_print_header "$@"; }

# ============================================================================
# SUMMARY OUTPUT
# ============================================================================

# Print summary statistics
# Args: $1 = passed count
#       $2 = failed count
#       $3 = skipped count (optional)
#       $4 = total count (optional, calculated if not provided)
dev_print_summary() {
    local passed="${1:-0}"
    local failed="${2:-0}"
    local skipped="${3:-0}"
    local total="${4:-$((passed + failed))}"

    local score=0
    if [[ "$total" -gt 0 ]]; then
        score=$((passed * 100 / total))
    fi

    echo ""
    echo -e "${DEV_BOLD}Summary${DEV_NC}"
    printf '%0.s─' {1..40}
    echo ""
    echo -e "Total checks: ${DEV_BOLD}$total${DEV_NC}"
    echo -e "Passed:       ${DEV_GREEN}$passed${DEV_NC}"
    echo -e "Failed:       ${DEV_RED}$failed${DEV_NC}"
    [[ "$skipped" -gt 0 ]] && echo -e "Skipped:      ${DEV_DIM}$skipped${DEV_NC}"
    echo -e "Score:        ${DEV_BOLD}${score}%${DEV_NC}"
}

# Legacy alias
print_summary() { dev_print_summary "$@"; }

# ============================================================================
# TABLE OUTPUT
# ============================================================================

# Print table header separator
# Args: $1 = width (default 60)
dev_print_table_separator() {
    local width="${1:-60}"
    printf '%0.s─' $(seq 1 "$width")
    echo ""
}

# Print table row
# Args: variable number of columns
dev_print_table_row() {
    local IFS='|'
    echo "$*"
}

# ============================================================================
# BOX OUTPUT
# ============================================================================

# Print text in a box
# Args: $1 = title
#       $2+ = content lines
dev_print_box() {
    local title="$1"
    shift
    local content=("$@")

    # Calculate max width
    local max_width=${#title}
    for line in "${content[@]}"; do
        [[ ${#line} -gt $max_width ]] && max_width=${#line}
    done

    local inner_width=$((max_width + 2))

    # Top border
    echo -n "${DEV_SYM_BOX_TL}"
    printf "${DEV_SYM_BOX_H}%.0s" $(seq 1 $inner_width)
    echo "${DEV_SYM_BOX_TR}"

    # Title
    printf "${DEV_SYM_BOX_V} ${DEV_BOLD}%-*s${DEV_NC} ${DEV_SYM_BOX_V}\n" "$max_width" "$title"

    # Separator
    echo -n "${DEV_SYM_BOX_V}"
    printf "${DEV_SYM_BOX_H}%.0s" $(seq 1 $inner_width)
    echo "${DEV_SYM_BOX_V}"

    # Content
    for line in "${content[@]}"; do
        printf "${DEV_SYM_BOX_V} %-*s ${DEV_SYM_BOX_V}\n" "$max_width" "$line"
    done

    # Bottom border
    echo -n "${DEV_SYM_BOX_BL}"
    printf "${DEV_SYM_BOX_H}%.0s" $(seq 1 $inner_width)
    echo "${DEV_SYM_BOX_BR}"
}

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

# Die with error message and exit code
# Args: $1 = message
#       $2 = exit code (default: DEV_EXIT_GENERAL_ERROR)
dev_die() {
    local message="$1"
    local exit_code="${2:-$DEV_EXIT_GENERAL_ERROR}"
    dev_log_error "$message"
    exit "$exit_code"
}

# Print next steps after successful operation
# Args: $@ = step descriptions (numbered automatically)
dev_print_next_steps() {
    echo ""
    echo "Next steps:"
    local i=1
    for step in "$@"; do
        echo "  $i. $step"
        ((i++))
    done
}

# ============================================================================
# EXPORTS
# ============================================================================

# Export logging functions
export -f dev_log_info
export -f dev_log_warn
export -f dev_log_error
export -f dev_log_step
export -f dev_log_skip
export -f dev_log_debug

# Export legacy aliases
export -f log_info
export -f log_warn
export -f log_error
export -f log_step
export -f log_check

# Export check/header/summary functions
export -f dev_print_check
export -f dev_print_header
export -f dev_print_subheader
export -f dev_print_summary
export -f dev_print_table_separator
export -f dev_print_table_row
export -f dev_print_box

# Export legacy aliases
export -f print_check
export -f print_header
export -f print_summary

# Export utility functions
export -f dev_die
export -f dev_print_next_steps
