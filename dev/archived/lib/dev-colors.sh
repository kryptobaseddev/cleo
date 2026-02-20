#!/usr/bin/env bash
# dev-colors.sh - Color and symbol definitions for development scripts
# Part of claude-todo development tooling
#
# Provides terminal color codes and Unicode symbols with proper NO_COLOR support.
# This is the foundation layer - no dependencies on other dev/lib modules.
#
# Usage:
#   source "${DEV_LIB_DIR}/dev-colors.sh"
#   echo -e "${DEV_GREEN}Success${DEV_NC}"
#
# Environment Variables:
#   NO_COLOR   - If set, disables all colors (https://no-color.org)
#   FORCE_COLOR - If set, forces colors even without TTY
#
# Version: 1.0.0

# ============================================================================
# GUARD AGAINST MULTIPLE SOURCING
# ============================================================================
[[ -n "${_DEV_COLORS_SH_LOADED:-}" ]] && return 0
_DEV_COLORS_SH_LOADED=1

# ============================================================================
# COLOR SUPPORT DETECTION
# ============================================================================

# Check if colors should be used
# Returns: 0 if colors should be used, 1 if not
dev_should_use_color() {
    # NO_COLOR takes precedence (standard: https://no-color.org)
    [[ -n "${NO_COLOR:-}" ]] && return 1

    # FORCE_COLOR overrides TTY detection
    [[ -n "${FORCE_COLOR:-}" ]] && return 0

    # Check if stdout is a terminal and supports colors
    if [[ -t 1 ]]; then
        # Check if terminal supports at least 8 colors
        if command -v tput &>/dev/null; then
            [[ $(tput colors 2>/dev/null || echo 0) -ge 8 ]] && return 0
        else
            # Assume color support if tput unavailable but is TTY
            return 0
        fi
    fi

    return 1
}

# Check if Unicode should be used
# Returns: 0 if Unicode should be used, 1 if not
dev_should_use_unicode() {
    # Check locale settings for UTF-8 support
    [[ "${LC_ALL:-}" =~ UTF-8 ]] && return 0
    [[ "${LC_CTYPE:-}" =~ UTF-8 ]] && return 0
    [[ "${LANG:-}" =~ UTF-8 ]] && return 0

    # POSIX/C locale typically means no Unicode
    [[ "${LANG:-}" == "C" ]] && return 1
    [[ "${LANG:-}" == "POSIX" ]] && return 1

    # Default to checking if LANG contains utf8 (case insensitive)
    [[ "${LANG:-}" =~ [Uu][Tt][Ff]-?8 ]] && return 0

    return 1
}

# ============================================================================
# COLOR DEFINITIONS
# ============================================================================

if dev_should_use_color; then
    # Standard colors
    readonly DEV_RED='\033[0;31m'
    readonly DEV_GREEN='\033[0;32m'
    readonly DEV_YELLOW='\033[0;33m'
    readonly DEV_BLUE='\033[0;34m'
    readonly DEV_MAGENTA='\033[0;35m'
    readonly DEV_CYAN='\033[0;36m'
    readonly DEV_WHITE='\033[0;37m'

    # Formatting
    readonly DEV_BOLD='\033[1m'
    readonly DEV_DIM='\033[2m'
    readonly DEV_ITALIC='\033[3m'
    readonly DEV_UNDERLINE='\033[4m'

    # Reset
    readonly DEV_NC='\033[0m'

    # Semantic aliases
    readonly DEV_SUCCESS="${DEV_GREEN}"
    readonly DEV_ERROR="${DEV_RED}"
    readonly DEV_WARNING="${DEV_YELLOW}"
    readonly DEV_INFO="${DEV_BLUE}"
    readonly DEV_MUTED="${DEV_DIM}"
else
    # No color mode - all empty strings
    readonly DEV_RED=''
    readonly DEV_GREEN=''
    readonly DEV_YELLOW=''
    readonly DEV_BLUE=''
    readonly DEV_MAGENTA=''
    readonly DEV_CYAN=''
    readonly DEV_WHITE=''
    readonly DEV_BOLD=''
    readonly DEV_DIM=''
    readonly DEV_ITALIC=''
    readonly DEV_UNDERLINE=''
    readonly DEV_NC=''
    readonly DEV_SUCCESS=''
    readonly DEV_ERROR=''
    readonly DEV_WARNING=''
    readonly DEV_INFO=''
    readonly DEV_MUTED=''
fi

# ============================================================================
# SYMBOL DEFINITIONS
# ============================================================================

if dev_should_use_unicode; then
    # Status symbols
    readonly DEV_SYM_CHECK='✓'
    readonly DEV_SYM_CROSS='✗'
    readonly DEV_SYM_WARN='⚠'
    readonly DEV_SYM_INFO='ℹ'
    readonly DEV_SYM_SKIP='○'
    readonly DEV_SYM_ARROW='→'
    readonly DEV_SYM_BULLET='•'
    readonly DEV_SYM_ELLIPSIS='…'

    # Progress bar characters
    readonly DEV_SYM_BAR_FULL='█'
    readonly DEV_SYM_BAR_EMPTY='░'
    readonly DEV_SYM_BAR_HALF='▒'

    # Box drawing
    readonly DEV_SYM_BOX_H='─'
    readonly DEV_SYM_BOX_V='│'
    readonly DEV_SYM_BOX_TL='╭'
    readonly DEV_SYM_BOX_TR='╮'
    readonly DEV_SYM_BOX_BL='╰'
    readonly DEV_SYM_BOX_BR='╯'
else
    # ASCII fallbacks
    readonly DEV_SYM_CHECK='+'
    readonly DEV_SYM_CROSS='x'
    readonly DEV_SYM_WARN='!'
    readonly DEV_SYM_INFO='i'
    readonly DEV_SYM_SKIP='o'
    readonly DEV_SYM_ARROW='->'
    readonly DEV_SYM_BULLET='*'
    readonly DEV_SYM_ELLIPSIS='...'

    # Progress bar characters (ASCII)
    readonly DEV_SYM_BAR_FULL='='
    readonly DEV_SYM_BAR_EMPTY='-'
    readonly DEV_SYM_BAR_HALF='#'

    # Box drawing (ASCII)
    readonly DEV_SYM_BOX_H='-'
    readonly DEV_SYM_BOX_V='|'
    readonly DEV_SYM_BOX_TL='+'
    readonly DEV_SYM_BOX_TR='+'
    readonly DEV_SYM_BOX_BL='+'
    readonly DEV_SYM_BOX_BR='+'
fi

# ============================================================================
# LEGACY COMPATIBILITY ALIASES
# ============================================================================
# These allow existing scripts to work without the DEV_ prefix
# Consider removing these after full migration

readonly RED="${DEV_RED}"
readonly GREEN="${DEV_GREEN}"
readonly YELLOW="${DEV_YELLOW}"
readonly BLUE="${DEV_BLUE}"
readonly CYAN="${DEV_CYAN}"
readonly BOLD="${DEV_BOLD}"
readonly DIM="${DEV_DIM}"
readonly NC="${DEV_NC}"

readonly PASS_SYM="${DEV_SYM_CHECK}"
readonly FAIL_SYM="${DEV_SYM_CROSS}"
readonly WARN_SYM="${DEV_SYM_WARN}"
readonly SKIP_SYM="${DEV_SYM_SKIP}"
readonly INFO_SYM="${DEV_SYM_INFO}"

# ============================================================================
# EXPORTS
# ============================================================================

# Export detection functions
export -f dev_should_use_color
export -f dev_should_use_unicode

# Note: readonly variables are automatically available to child processes
# when the script is sourced, but explicit export ensures availability
export DEV_RED DEV_GREEN DEV_YELLOW DEV_BLUE DEV_MAGENTA DEV_CYAN DEV_WHITE
export DEV_BOLD DEV_DIM DEV_ITALIC DEV_UNDERLINE DEV_NC
export DEV_SUCCESS DEV_ERROR DEV_WARNING DEV_INFO DEV_MUTED
export DEV_SYM_CHECK DEV_SYM_CROSS DEV_SYM_WARN DEV_SYM_INFO DEV_SYM_SKIP
export DEV_SYM_ARROW DEV_SYM_BULLET DEV_SYM_ELLIPSIS
export DEV_SYM_BAR_FULL DEV_SYM_BAR_EMPTY DEV_SYM_BAR_HALF
export DEV_SYM_BOX_H DEV_SYM_BOX_V DEV_SYM_BOX_TL DEV_SYM_BOX_TR DEV_SYM_BOX_BL DEV_SYM_BOX_BR
# Legacy aliases
export RED GREEN YELLOW BLUE CYAN BOLD DIM NC
export PASS_SYM FAIL_SYM WARN_SYM SKIP_SYM INFO_SYM
