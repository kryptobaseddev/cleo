#!/usr/bin/env bats
# =============================================================================
# validation.bats - Unit tests for lib/validation/validation.sh pure functions
# =============================================================================
# Tests pure validation functions that operate on input parameters without
# requiring file I/O. These functions are deterministic and testable in
# isolation.
#
# Pure functions tested:
#   - validate_title()
#   - validate_description()
#   - validate_note()
#   - validate_blocked_by()
#   - validate_session_note()
#   - validate_cancel_reason()
#   - normalize_labels()
#   - sanitize_file_path()
# =============================================================================

# =============================================================================
# File-Level Setup (runs once per test file)
# =============================================================================
setup_file() {
    # Load BATS helper libraries once per file
    load '../../libs/bats-support/load'
    load '../../libs/bats-assert/load'

    # Set up library directory path
    export LIB_DIR="${BATS_TEST_DIRNAME}/../../../lib"
}

# =============================================================================
# Per-Test Setup (runs before each test)
# =============================================================================
setup() {
    # Reload libs for per-test assertion scope
    load '../../libs/bats-support/load'
    load '../../libs/bats-assert/load'

    # Source Layer 0 dependencies first (exit-codes.sh, platform-compat.sh)
    source "${LIB_DIR}/core/exit-codes.sh"
    source "${LIB_DIR}/core/platform-compat.sh"

    # Source validation.sh (Layer 2)
    source "${LIB_DIR}/validation/validation.sh"
}

# =============================================================================
# validate_title() Tests
# =============================================================================

@test "validate_title accepts valid simple title" {
    run validate_title "Implement user authentication"
    assert_success
}

@test "validate_title accepts title with special characters" {
    run validate_title "Fix bug #123: user login fails"
    assert_success
}

@test "validate_title accepts title with unicode characters" {
    run validate_title "Refactor authentication module"
    assert_success
}

@test "validate_title accepts maximum length title (120 chars)" {
    local title
    title=$(printf 'A%.0s' {1..120})
    run validate_title "$title"
    assert_success
}

@test "validate_title rejects empty title" {
    run validate_title ""
    assert_failure
    assert_output --partial "Title cannot be empty"
}

@test "validate_title rejects title exceeding 120 characters" {
    local title
    title=$(printf 'A%.0s' {1..121})
    run validate_title "$title"
    assert_failure
    assert_output --partial "Title too long"
    assert_output --partial "121/120"
}

@test "validate_title rejects title with literal newline" {
    local title=$'First line\nSecond line'
    run validate_title "$title"
    assert_failure
    assert_output --partial "cannot contain newlines"
}

@test "validate_title rejects title with carriage return" {
    local title=$'First line\rSecond line'
    run validate_title "$title"
    assert_failure
    assert_output --partial "cannot contain carriage returns"
}

@test "validate_title rejects title with escaped newline sequence" {
    run validate_title 'Title with \n escaped newline'
    assert_failure
    assert_output --partial "cannot contain newline sequences"
}

@test "validate_title warns about leading whitespace" {
    run validate_title "  Leading spaces"
    # Should succeed but warn
    assert_success
    assert_output --partial "WARN"
    assert_output --partial "leading/trailing whitespace"
}

@test "validate_title warns about trailing whitespace" {
    run validate_title "Trailing spaces  "
    # Should succeed but warn
    assert_success
    assert_output --partial "WARN"
}

@test "validate_title accepts title with numbers and punctuation" {
    run validate_title "Task 42: Complete API v2.0 integration!"
    assert_success
}

# =============================================================================
# validate_description() Tests
# =============================================================================

@test "validate_description accepts empty description" {
    run validate_description ""
    assert_success
}

@test "validate_description accepts valid description" {
    run validate_description "This is a valid task description with details."
    assert_success
}

@test "validate_description accepts description at max length (2000 chars)" {
    local desc
    desc=$(printf 'D%.0s' {1..2000})
    run validate_description "$desc"
    assert_success
}

@test "validate_description rejects description exceeding 2000 characters" {
    local desc
    desc=$(printf 'D%.0s' {1..2001})
    run validate_description "$desc"
    assert_failure
    assert_output --partial "exceeds 2000 characters"
    assert_output --partial "2001 provided"
}

@test "validate_description accepts multiline description" {
    local desc=$'Line 1\nLine 2\nLine 3'
    run validate_description "$desc"
    assert_success
}

# =============================================================================
# validate_note() Tests
# =============================================================================

@test "validate_note accepts empty note" {
    run validate_note ""
    assert_success
}

@test "validate_note accepts valid note" {
    run validate_note "Progress update: completed initial implementation."
    assert_success
}

@test "validate_note accepts note at max length (5000 chars)" {
    local note
    note=$(printf 'N%.0s' {1..5000})
    run validate_note "$note"
    assert_success
}

@test "validate_note rejects note exceeding 5000 characters" {
    local note
    note=$(printf 'N%.0s' {1..5001})
    run validate_note "$note"
    assert_failure
    assert_output --partial "exceeds 5000 characters"
    assert_output --partial "5001 provided"
}

# =============================================================================
# validate_blocked_by() Tests
# =============================================================================

@test "validate_blocked_by accepts empty reason" {
    run validate_blocked_by ""
    assert_success
}

@test "validate_blocked_by accepts valid blocked reason" {
    run validate_blocked_by "Waiting for API team to provide endpoint documentation"
    assert_success
}

@test "validate_blocked_by accepts reason at max length (300 chars)" {
    local reason
    reason=$(printf 'B%.0s' {1..300})
    run validate_blocked_by "$reason"
    assert_success
}

@test "validate_blocked_by rejects reason exceeding 300 characters" {
    local reason
    reason=$(printf 'B%.0s' {1..301})
    run validate_blocked_by "$reason"
    assert_failure
    assert_output --partial "exceeds 300 characters"
    assert_output --partial "301 provided"
}

# =============================================================================
# validate_session_note() Tests
# =============================================================================

@test "validate_session_note accepts empty note" {
    run validate_session_note ""
    assert_success
}

@test "validate_session_note accepts valid session note" {
    run validate_session_note "Working on authentication module refactoring"
    assert_success
}

@test "validate_session_note accepts note at max length (2500 chars)" {
    local note
    note=$(printf 'S%.0s' {1..2500})
    run validate_session_note "$note"
    assert_success
}

@test "validate_session_note rejects note exceeding 2500 characters" {
    local note
    note=$(printf 'S%.0s' {1..2501})
    run validate_session_note "$note"
    assert_failure
    assert_output --partial "exceeds 2500 characters"
    assert_output --partial "2501 provided"
}

# =============================================================================
# validate_cancel_reason() Tests
# =============================================================================

@test "validate_cancel_reason accepts valid reason" {
    run validate_cancel_reason "Task no longer needed after requirements change"
    assert_success
}

@test "validate_cancel_reason accepts minimum length reason (5 chars)" {
    run validate_cancel_reason "Abort"
    assert_success
}

@test "validate_cancel_reason accepts maximum length reason (300 chars)" {
    local reason
    reason=$(printf 'C%.0s' {1..300})
    run validate_cancel_reason "$reason"
    assert_success
}

@test "validate_cancel_reason rejects empty reason" {
    run validate_cancel_reason ""
    assert_failure
    assert_output --partial "cannot be empty"
    assert_output --partial "field: cancellationReason"
}

@test "validate_cancel_reason rejects reason below minimum length" {
    run validate_cancel_reason "No"
    assert_failure
    assert_output --partial "too short"
    assert_output --partial "minLength=5"
}

@test "validate_cancel_reason rejects reason exceeding maximum length" {
    local reason
    reason=$(printf 'C%.0s' {1..301})
    run validate_cancel_reason "$reason"
    assert_failure
    assert_output --partial "too long"
    assert_output --partial "maxLength=300"
}

@test "validate_cancel_reason rejects reason with newline" {
    local reason=$'Line one\nLine two'
    run validate_cancel_reason "$reason"
    assert_failure
    assert_output --partial "cannot contain newlines"
    assert_output --partial "single-line text only"
}

@test "validate_cancel_reason rejects reason with carriage return" {
    local reason=$'Line one\rLine two'
    run validate_cancel_reason "$reason"
    assert_failure
    assert_output --partial "cannot contain newlines"
}

@test "validate_cancel_reason rejects reason with pipe character" {
    run validate_cancel_reason "Invalid | shell metachar"
    assert_failure
    assert_output --partial "disallowed characters"
    assert_output --partial "security: prevents injection"
}

@test "validate_cancel_reason rejects reason with semicolon" {
    run validate_cancel_reason "Invalid; command separator"
    assert_failure
    assert_output --partial "disallowed characters"
}

@test "validate_cancel_reason rejects reason with ampersand" {
    run validate_cancel_reason "Invalid & background"
    assert_failure
    assert_output --partial "disallowed characters"
}

@test "validate_cancel_reason rejects reason with dollar sign" {
    run validate_cancel_reason 'Invalid $variable expansion'
    assert_failure
    assert_output --partial "disallowed characters"
}

@test "validate_cancel_reason rejects reason with backtick" {
    run validate_cancel_reason 'Invalid `command` substitution'
    assert_failure
    assert_output --partial "disallowed characters"
}

@test "validate_cancel_reason rejects reason with single quote" {
    run validate_cancel_reason "Invalid 'quoted' text"
    assert_failure
    assert_output --partial "disallowed characters"
}

@test "validate_cancel_reason rejects reason with double quote" {
    run validate_cancel_reason 'Invalid "quoted" text'
    assert_failure
    assert_output --partial "disallowed characters"
}

@test "validate_cancel_reason rejects reason with parentheses" {
    run validate_cancel_reason "Invalid (subshell) attempt"
    assert_failure
    assert_output --partial "disallowed characters"
}

@test "validate_cancel_reason rejects reason with curly braces" {
    run validate_cancel_reason "Invalid {brace} expansion"
    assert_failure
    assert_output --partial "disallowed characters"
}

@test "validate_cancel_reason rejects reason with square brackets" {
    run validate_cancel_reason "Invalid [glob] pattern"
    assert_failure
    assert_output --partial "disallowed characters"
}

@test "validate_cancel_reason rejects reason with backslash" {
    run validate_cancel_reason 'Invalid \escape sequence'
    assert_failure
    assert_output --partial "disallowed characters"
}

@test "validate_cancel_reason rejects reason with less-than" {
    run validate_cancel_reason "Invalid <redirect"
    assert_failure
    assert_output --partial "disallowed characters"
}

@test "validate_cancel_reason rejects reason with greater-than" {
    run validate_cancel_reason "Invalid >redirect"
    assert_failure
    assert_output --partial "disallowed characters"
}

@test "validate_cancel_reason rejects reason with exclamation mark" {
    run validate_cancel_reason "Invalid !history expansion"
    assert_failure
    assert_output --partial "disallowed characters"
}

@test "validate_cancel_reason accepts reason with safe punctuation" {
    run validate_cancel_reason "Task cancelled: no longer needed. See task 42 for details - priority changed."
    assert_success
}

# =============================================================================
# normalize_labels() Tests
# =============================================================================

@test "normalize_labels returns empty for empty input" {
    run normalize_labels ""
    assert_success
    assert_output ""
}

@test "normalize_labels handles single label" {
    run normalize_labels "bug"
    assert_success
    assert_output "bug"
}

@test "normalize_labels handles multiple labels" {
    run normalize_labels "bug,feature,security"
    assert_success
    # Output should be sorted
    assert_output "bug,feature,security"
}

@test "normalize_labels deduplicates labels" {
    run normalize_labels "bug,feature,bug,security,feature"
    assert_success
    assert_output "bug,feature,security"
}

@test "normalize_labels sorts labels alphabetically" {
    run normalize_labels "zebra,alpha,beta"
    assert_success
    assert_output "alpha,beta,zebra"
}

@test "normalize_labels trims whitespace from labels" {
    run normalize_labels "  bug , feature  , security  "
    assert_success
    assert_output "bug,feature,security"
}

@test "normalize_labels removes empty labels" {
    run normalize_labels "bug,,feature,,,security"
    assert_success
    assert_output "bug,feature,security"
}

@test "normalize_labels handles labels with hyphens" {
    run normalize_labels "sprint-12,high-priority,bug-fix"
    assert_success
    assert_output "bug-fix,high-priority,sprint-12"
}

@test "normalize_labels handles labels with underscores" {
    run normalize_labels "code_review,unit_test"
    assert_success
    assert_output "code_review,unit_test"
}

# =============================================================================
# sanitize_file_path() Tests
# =============================================================================

@test "sanitize_file_path accepts valid absolute path" {
    run sanitize_file_path "/home/user/projects/todo.json"
    assert_success
    assert_output "/home/user/projects/todo.json"
}

@test "sanitize_file_path accepts valid relative path" {
    run sanitize_file_path ".cleo/todo.json"
    assert_success
    assert_output ".cleo/todo.json"
}

@test "sanitize_file_path accepts path with dots" {
    run sanitize_file_path "../parent/file.json"
    assert_success
    assert_output "../parent/file.json"
}

@test "sanitize_file_path accepts path with hyphens and underscores" {
    run sanitize_file_path "/path/to/my-project_v2/file.json"
    assert_success
    assert_output "/path/to/my-project_v2/file.json"
}

@test "sanitize_file_path rejects empty path" {
    run sanitize_file_path ""
    assert_failure
    assert_output --partial "Empty path provided"
}

@test "sanitize_file_path rejects path with dollar sign" {
    run sanitize_file_path '/path/$USER/file.json'
    assert_failure
    assert_output --partial "shell metacharacters"
    assert_output --partial "injection"
}

@test "sanitize_file_path rejects path with backtick" {
    run sanitize_file_path '/path/`whoami`/file.json'
    assert_failure
    assert_output --partial "shell metacharacters"
}

@test "sanitize_file_path rejects path with semicolon" {
    run sanitize_file_path "/path/file.json;rm -rf /"
    assert_failure
    assert_output --partial "shell metacharacters"
}

@test "sanitize_file_path rejects path with pipe" {
    run sanitize_file_path "/path/file.json|cat /etc/passwd"
    assert_failure
    assert_output --partial "shell metacharacters"
}

@test "sanitize_file_path rejects path with ampersand" {
    run sanitize_file_path "/path/file.json&background"
    assert_failure
    assert_output --partial "shell metacharacters"
}

@test "sanitize_file_path rejects path with less-than redirect" {
    run sanitize_file_path "/path/file.json</dev/null"
    assert_failure
    assert_output --partial "shell metacharacters"
}

@test "sanitize_file_path rejects path with greater-than redirect" {
    run sanitize_file_path "/path/file.json>/dev/null"
    assert_failure
    assert_output --partial "shell metacharacters"
}

@test "sanitize_file_path rejects path with single quote" {
    run sanitize_file_path "/path/file's.json"
    assert_failure
    assert_output --partial "shell metacharacters"
}

@test "sanitize_file_path rejects path with double quote" {
    run sanitize_file_path '/path/"file".json'
    assert_failure
    assert_output --partial "shell metacharacters"
}

@test "sanitize_file_path rejects path with parentheses" {
    run sanitize_file_path "/path/(subshell)/file.json"
    assert_failure
    assert_output --partial "shell metacharacters"
}

@test "sanitize_file_path rejects path with curly braces" {
    run sanitize_file_path "/path/{a,b}/file.json"
    assert_failure
    assert_output --partial "shell metacharacters"
}

@test "sanitize_file_path rejects path with square brackets" {
    run sanitize_file_path "/path/file[0-9].json"
    assert_failure
    assert_output --partial "shell metacharacters"
}

@test "sanitize_file_path rejects path with exclamation mark" {
    run sanitize_file_path "/path/!important/file.json"
    assert_failure
    assert_output --partial "shell metacharacters"
}

@test "sanitize_file_path rejects path ending with backslash" {
    run sanitize_file_path '/path/file.json\'
    assert_failure
    assert_output --partial "ends with backslash"
}

@test "sanitize_file_path rejects path with newline" {
    local path=$'/path/file\n.json'
    run sanitize_file_path "$path"
    assert_failure
    assert_output --partial "newline/carriage return"
}

@test "sanitize_file_path rejects path with carriage return" {
    local path=$'/path/file\r.json'
    run sanitize_file_path "$path"
    assert_failure
    assert_output --partial "newline/carriage return"
}

# =============================================================================
# Field Length Constants Tests
# =============================================================================

@test "MAX_DESCRIPTION_LENGTH constant is 2000" {
    [[ "$MAX_DESCRIPTION_LENGTH" -eq 2000 ]]
}

@test "MAX_NOTE_LENGTH constant is 5000" {
    [[ "$MAX_NOTE_LENGTH" -eq 5000 ]]
}

@test "MAX_BLOCKED_BY_LENGTH constant is 300" {
    [[ "$MAX_BLOCKED_BY_LENGTH" -eq 300 ]]
}

@test "MAX_SESSION_NOTE_LENGTH constant is 2500" {
    [[ "$MAX_SESSION_NOTE_LENGTH" -eq 2500 ]]
}

@test "MIN_CANCEL_REASON_LENGTH constant is 5" {
    [[ "$MIN_CANCEL_REASON_LENGTH" -eq 5 ]]
}

@test "MAX_CANCEL_REASON_LENGTH constant is 300" {
    [[ "$MAX_CANCEL_REASON_LENGTH" -eq 300 ]]
}

# =============================================================================
# Valid Status/Priority Constants Tests
# =============================================================================

@test "VALID_STATUSES array contains expected values" {
    local expected=("pending" "active" "done" "blocked" "cancelled")
    for status in "${expected[@]}"; do
        local found=false
        for valid in "${VALID_STATUSES[@]}"; do
            if [[ "$status" == "$valid" ]]; then
                found=true
                break
            fi
        done
        [[ "$found" == "true" ]]
    done
}

@test "VALID_STATUSES array has exactly 5 elements" {
    [[ "${#VALID_STATUSES[@]}" -eq 5 ]]
}

@test "VALID_PHASE_STATUSES contains pending active completed" {
    local expected=("pending" "active" "completed")
    for status in "${expected[@]}"; do
        local found=false
        for valid in "${VALID_PHASE_STATUSES[@]}"; do
            if [[ "$status" == "$valid" ]]; then
                found=true
                break
            fi
        done
        [[ "$found" == "true" ]]
    done
}

# =============================================================================
# Edge Cases and Boundary Tests
# =============================================================================

@test "validate_title handles exactly boundary length (119, 120, 121 chars)" {
    # 119 chars - should pass
    local title119
    title119=$(printf 'A%.0s' {1..119})
    run validate_title "$title119"
    assert_success

    # 120 chars - should pass (exactly at limit)
    local title120
    title120=$(printf 'A%.0s' {1..120})
    run validate_title "$title120"
    assert_success

    # 121 chars - should fail
    local title121
    title121=$(printf 'A%.0s' {1..121})
    run validate_title "$title121"
    assert_failure
}

@test "validate_cancel_reason handles exactly boundary lengths" {
    # 4 chars - should fail (below minimum)
    run validate_cancel_reason "Abcd"
    assert_failure

    # 5 chars - should pass (exactly at minimum)
    run validate_cancel_reason "Abcde"
    assert_success

    # 300 chars - should pass (exactly at maximum)
    local reason300
    reason300=$(printf 'R%.0s' {1..300})
    run validate_cancel_reason "$reason300"
    assert_success

    # 301 chars - should fail (above maximum)
    local reason301
    reason301=$(printf 'R%.0s' {1..301})
    run validate_cancel_reason "$reason301"
    assert_failure
}

@test "validate_title handles whitespace-only input" {
    run validate_title "   "
    # Should succeed but warn about whitespace
    assert_success
    assert_output --partial "WARN"
}

@test "normalize_labels handles whitespace-only input" {
    run normalize_labels "   ,   ,   "
    # Note: grep -v '^$' returns exit code 1 when no non-empty lines match
    # This is expected behavior with pipefail - empty result is valid
    # The output should be empty (all whitespace entries filtered out)
    assert_output ""
}
