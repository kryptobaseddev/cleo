#!/usr/bin/env bats
# =============================================================================
# output-format.bats - Unit tests for lib/core/output-format.sh
# =============================================================================
# Tests output formatting utilities including:
# - Color and Unicode feature detection
# - Status and priority formatting
# - Progress bars and box drawing
# - Terminal width detection
# - Format resolution
# =============================================================================

# =============================================================================
# File-Level Setup (runs once per test file)
# =============================================================================
setup_file() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_file
}

# =============================================================================
# Per-Test Setup (runs before each test)
# =============================================================================
setup() {
    load '../test_helper/common_setup'
    common_setup_per_test

    # Source the library under test
    source "$PROJECT_ROOT/lib/core/output-format.sh"

    # Save original environment
    export SAVED_NO_COLOR="${NO_COLOR:-}"
    export SAVED_FORCE_COLOR="${FORCE_COLOR:-}"
    export SAVED_LANG="${LANG:-}"
    export SAVED_LC_ALL="${LC_ALL:-}"
    export SAVED_COLUMNS="${COLUMNS:-}"
    export SAVED_CLEO_FORMAT="${CLEO_FORMAT:-}"

    # Clear environment for clean test state
    unset NO_COLOR
    unset FORCE_COLOR
    unset CLEO_FORMAT
}

teardown() {
    # Restore original environment
    [[ -n "$SAVED_NO_COLOR" ]] && export NO_COLOR="$SAVED_NO_COLOR" || unset NO_COLOR
    [[ -n "$SAVED_FORCE_COLOR" ]] && export FORCE_COLOR="$SAVED_FORCE_COLOR" || unset FORCE_COLOR
    [[ -n "$SAVED_LANG" ]] && export LANG="$SAVED_LANG" || unset LANG
    [[ -n "$SAVED_LC_ALL" ]] && export LC_ALL="$SAVED_LC_ALL" || unset LC_ALL
    [[ -n "$SAVED_COLUMNS" ]] && export COLUMNS="$SAVED_COLUMNS" || unset COLUMNS
    [[ -n "$SAVED_CLEO_FORMAT" ]] && export CLEO_FORMAT="$SAVED_CLEO_FORMAT" || unset CLEO_FORMAT

    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Color Detection Tests
# =============================================================================

@test "detect_color_support returns 1 when NO_COLOR set" {
    NO_COLOR=1
    run detect_color_support
    assert_failure
}

@test "detect_color_support returns 1 when NO_COLOR is any value" {
    NO_COLOR=true
    run detect_color_support
    assert_failure

    NO_COLOR=0
    run detect_color_support
    assert_failure
}

@test "detect_color_support returns 0 when FORCE_COLOR set" {
    FORCE_COLOR=1
    run detect_color_support
    assert_success
}

@test "detect_color_support returns 0 when FORCE_COLOR is any value" {
    FORCE_COLOR=true
    run detect_color_support
    assert_success
}

@test "NO_COLOR takes precedence over FORCE_COLOR" {
    NO_COLOR=1
    FORCE_COLOR=1
    run detect_color_support
    assert_failure
}

# =============================================================================
# Unicode Detection Tests
# =============================================================================

@test "detect_unicode_support returns 0 for UTF-8 LANG" {
    LANG=en_US.UTF-8
    unset LC_ALL
    run detect_unicode_support
    assert_success
}

@test "detect_unicode_support returns 0 for UTF-8 LC_ALL" {
    unset LANG
    LC_ALL=en_US.UTF-8
    run detect_unicode_support
    assert_success
}

@test "detect_unicode_support returns 1 for C locale" {
    LANG=C
    unset LC_ALL
    run detect_unicode_support
    assert_failure
}

@test "detect_unicode_support returns 1 for POSIX locale" {
    LANG=POSIX
    unset LC_ALL
    run detect_unicode_support
    assert_failure
}

@test "detect_unicode_support returns 1 when no UTF-8 in locale" {
    LANG=en_US.ISO-8859-1
    unset LC_ALL
    run detect_unicode_support
    assert_failure
}

@test "detect_unicode_support LC_ALL overrides LANG" {
    LANG=C
    LC_ALL=en_US.UTF-8
    run detect_unicode_support
    assert_success
}

# =============================================================================
# Terminal Width Tests
# =============================================================================

@test "get_terminal_width returns COLUMNS value when set" {
    COLUMNS=120
    run get_terminal_width
    assert_success
    assert_output "120"
}

@test "get_terminal_width returns default 80 when COLUMNS unset" {
    unset COLUMNS
    run get_terminal_width
    assert_success
    assert_output "80"
}

@test "get_terminal_width uses COLUMNS over tput" {
    COLUMNS=100
    run get_terminal_width
    assert_success
    assert_output "100"
}

# =============================================================================
# Format Resolution Tests
# =============================================================================

@test "resolve_format returns CLI argument when provided" {
    CLEO_FORMAT=markdown
    run resolve_format json
    assert_success
    assert_output "json"
}

@test "resolve_format returns env variable when CLI not provided" {
    CLEO_FORMAT=markdown
    run resolve_format
    assert_success
    assert_output "markdown"
}

@test "resolve_format returns 'json' in non-TTY when nothing set" {
    # LLM-Agent-First: non-TTY defaults to JSON for agent compatibility
    # TTY would default to 'text' but tests run in non-TTY (bats/CI)
    unset CLEO_FORMAT
    run resolve_format
    assert_success
    assert_output "json"
}

@test "resolve_format CLI takes precedence over env" {
    CLEO_FORMAT=json
    run resolve_format markdown
    assert_success
    assert_output "markdown"
}

# =============================================================================
# Status Symbol Tests
# =============================================================================

@test "status_symbol returns Unicode symbols by default" {
    run status_symbol pending
    assert_success
    assert_output "○"

    run status_symbol active
    assert_output "◉"

    run status_symbol blocked
    assert_output "⊗"

    run status_symbol done
    assert_output "✓"
}

@test "status_symbol returns ASCII symbols when unicode=false" {
    run status_symbol pending false
    assert_success
    # Use -- to prevent "-" from being interpreted as stdin option
    assert_output -- "-"

    run status_symbol active false
    assert_output "*"

    run status_symbol blocked false
    assert_output "x"

    run status_symbol done false
    assert_output "+"
}

@test "status_symbol returns ? for unknown status" {
    run status_symbol unknown
    assert_success
    assert_output "?"

    run status_symbol unknown false
    assert_output "?"
}

# =============================================================================
# Status Color Tests
# =============================================================================

@test "status_color returns correct ANSI codes" {
    run status_color pending
    assert_success
    assert_output "37"

    run status_color active
    assert_output "96"

    run status_color blocked
    assert_output "33"

    run status_color done
    assert_output "32"
}

@test "status_color returns 0 for unknown status" {
    run status_color unknown
    assert_success
    assert_output "0"
}

# =============================================================================
# Priority Symbol Tests
# =============================================================================

@test "priority_symbol returns Unicode symbols by default" {
    run priority_symbol critical
    assert_success
    assert_output "🔴"

    run priority_symbol high
    assert_output "🟡"

    run priority_symbol medium
    assert_output "🔵"

    run priority_symbol low
    assert_output "⚪"
}

@test "priority_symbol returns ASCII symbols when unicode=false" {
    run priority_symbol critical false
    assert_success
    assert_output "!"

    run priority_symbol high false
    assert_output "H"

    run priority_symbol medium false
    assert_output "M"

    run priority_symbol low false
    assert_output "L"
}

@test "priority_symbol returns default for unknown priority" {
    run priority_symbol unknown
    assert_success
    assert_output "⚫"

    run priority_symbol unknown false
    assert_output "?"
}

# =============================================================================
# Priority Color Tests
# =============================================================================

@test "priority_color returns correct ANSI codes" {
    run priority_color critical
    assert_success
    assert_output "91"

    run priority_color high
    assert_output "93"

    run priority_color medium
    assert_output "94"

    run priority_color low
    assert_output "90"
}

@test "priority_color returns 0 for unknown priority" {
    run priority_color unknown
    assert_success
    assert_output "0"
}

# =============================================================================
# Progress Bar Tests
# =============================================================================

@test "progress_bar returns empty bar for 0/0" {
    run progress_bar 0 0 10
    assert_success
    assert_output "[░░░░░░░░░░]   0%"
}

@test "progress_bar returns empty bar for 0% (0/100)" {
    run progress_bar 0 100 10
    assert_success
    assert_output "[░░░░░░░░░░]   0%"
}

@test "progress_bar returns half-filled bar for 50% (50/100)" {
    run progress_bar 50 100 10
    assert_success
    assert_output "[█████░░░░░]  50%"
}

@test "progress_bar returns full bar for 100% (100/100)" {
    run progress_bar 100 100 10
    assert_success
    assert_output "[██████████] 100%"
}

@test "progress_bar returns ASCII when unicode=false" {
    run progress_bar 0 100 10 false
    assert_success
    assert_output "[----------]   0%"

    run progress_bar 50 100 10 false
    assert_output "[=====-----]  50%"

    run progress_bar 100 100 10 false
    assert_output "[==========] 100%"
}

@test "progress_bar handles custom width" {
    run progress_bar 50 100 20
    assert_success
    assert_output "[██████████░░░░░░░░░░]  50%"
}

@test "progress_bar handles edge case: 0/0 ASCII" {
    run progress_bar 0 0 10 false
    assert_success
    assert_output "[----------]   0%"
}

@test "progress_bar handles 1/3 (33%)" {
    run progress_bar 1 3 9
    assert_success
    assert_output "[███░░░░░░]  33%"
}

@test "progress_bar handles 2/3 (66%)" {
    run progress_bar 2 3 9
    assert_success
    assert_output "[██████░░░]  66%"
}

# =============================================================================
# Box Drawing Tests
# =============================================================================

@test "draw_box returns Unicode box characters by default" {
    run draw_box TL
    assert_success
    assert_output "╭"

    run draw_box TR
    assert_output "╮"

    run draw_box BL
    assert_output "╰"

    run draw_box BR
    assert_output "╯"

    run draw_box H
    assert_output "─"

    run draw_box V
    assert_output "│"
}

@test "draw_box returns ASCII characters when unicode=false" {
    run draw_box TL false
    assert_success
    assert_output "+"

    run draw_box TR false
    assert_output "+"

    run draw_box BL false
    assert_output "+"

    run draw_box BR false
    assert_output "+"

    run draw_box H false
    # Use -- to prevent "-" from being interpreted as stdin option
    assert_output -- "-"

    run draw_box V false
    assert_output "|"
}

@test "draw_box returns ? for unknown type" {
    run draw_box UNKNOWN
    assert_success
    assert_output "?"

    run draw_box UNKNOWN false
    assert_output "?"
}

# =============================================================================
# Print Colored Tests
# =============================================================================

@test "print_colored outputs plain text when colors disabled" {
    NO_COLOR=1
    run print_colored 32 "Success"
    assert_success
    assert_output "Success"
}

@test "print_colored outputs colored text when FORCE_COLOR set" {
    FORCE_COLOR=1
    run print_colored 32 "Success"
    assert_success
    [[ "$output" == *"32m"* ]]
    [[ "$output" == *"Success"* ]]
}

@test "print_colored respects newline parameter" {
    NO_COLOR=1
    run print_colored 32 "Test" false
    assert_success
    assert_output "Test"
}

# =============================================================================
# Print Header Tests
# =============================================================================

@test "print_header generates box with Unicode by default" {
    LANG=en_US.UTF-8
    run print_header "Test Header" 30
    assert_success
    [[ "$output" == *"╭"* ]]
    [[ "$output" == *"╮"* ]]
    [[ "$output" == *"╰"* ]]
    [[ "$output" == *"╯"* ]]
    [[ "$output" == *"Test Header"* ]]
}

@test "print_header generates ASCII box when unicode=false" {
    run print_header "Test Header" 30 false
    assert_success
    [[ "$output" == *"+"* ]]
    [[ "$output" == *"-"* ]]
    [[ "$output" == *"|"* ]]
    [[ "$output" == *"Test Header"* ]]
}

@test "print_header uses terminal width when not specified" {
    COLUMNS=60
    LANG=en_US.UTF-8
    run print_header "Test"
    assert_success
    [[ "$output" == *"Test"* ]]
}

# =============================================================================
# Print Task Line Tests
# =============================================================================

@test "print_task_line formats task with status symbol" {
    NO_COLOR=1
    LANG=en_US.UTF-8
    run print_task_line T001 pending medium "Test task"
    assert_success
    [[ "$output" == *"○"* ]]
    [[ "$output" == *"T001"* ]]
    [[ "$output" == *"Test task"* ]]
    [[ "$output" == *"medium"* ]]
}

@test "print_task_line uses ASCII when unicode=false" {
    NO_COLOR=1
    run print_task_line T001 pending medium "Test task" false
    assert_success
    [[ "$output" == *"-"* ]]
    [[ "$output" == *"T001"* ]]
    [[ "$output" == *"Test task"* ]]
}

@test "print_task_line shows different status symbols" {
    NO_COLOR=1
    LANG=en_US.UTF-8

    run print_task_line T001 pending medium "Test"
    [[ "$output" == *"○"* ]]

    run print_task_line T002 active high "Test"
    [[ "$output" == *"◉"* ]]

    run print_task_line T003 blocked critical "Test"
    [[ "$output" == *"⊗"* ]]

    run print_task_line T004 done low "Test"
    [[ "$output" == *"✓"* ]]
}

# =============================================================================
# Integration Tests
# =============================================================================

@test "detect_unicode_support integrates with status_symbol" {
    LANG=en_US.UTF-8
    if detect_unicode_support; then
        run status_symbol pending true
    else
        run status_symbol pending false
    fi
    assert_success
}

@test "detect_color_support integrates with print_colored" {
    FORCE_COLOR=1
    run print_colored 32 "Test"
    assert_success
    [[ "$output" == *"Test"* ]]

    NO_COLOR=1
    unset FORCE_COLOR
    run print_colored 32 "Test"
    assert_output "Test"
}

@test "progress_bar handles rounding edge cases" {
    run progress_bar 1 3 10
    assert_success
    [[ "$output" == *" 33%"* ]]

    run progress_bar 2 3 10
    [[ "$output" == *" 66%"* ]]
}

# =============================================================================
# Error Handling Tests
# =============================================================================

@test "status_symbol handles empty status gracefully" {
    run status_symbol ""
    assert_success
    assert_output "?"
}

@test "priority_symbol handles empty priority gracefully" {
    run priority_symbol ""
    assert_success
}

@test "progress_bar handles negative values gracefully" {
    run progress_bar -5 100 10
    assert_success
    [[ "$output" == *"  0%"* ]]
}

@test "progress_bar handles values exceeding total" {
    run progress_bar 150 100 10
    assert_success
    [[ "$output" == *"150%"* ]]
}
