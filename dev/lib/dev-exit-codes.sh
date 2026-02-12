#!/usr/bin/env bash
# dev-exit-codes.sh - Standardized exit codes for development scripts
# Part of claude-todo development tooling
#
# Mirrors lib/core/exit-codes.sh patterns for consistency, but uses DEV_EXIT_ prefix
# to distinguish from runtime application exit codes.
#
# This is a foundation layer - no dependencies on other dev/lib modules.
#
# Usage:
#   source "${DEV_LIB_DIR}/dev-exit-codes.sh"
#   exit $DEV_EXIT_VALIDATION_FAILED
#
# Exit Code Ranges:
#   0      - Success
#   1-9    - General errors
#   10-19  - Validation and compliance errors
#   20-29  - Dev-tool specific errors
#   100+   - Special conditions (not errors, but notable states)
#
# Version: 1.0.0

# ============================================================================
# GUARD AGAINST MULTIPLE SOURCING
# ============================================================================
[[ -n "${_DEV_EXIT_CODES_SH_LOADED:-}" ]] && return 0
_DEV_EXIT_CODES_SH_LOADED=1

# ============================================================================
# SUCCESS CODES
# ============================================================================

# Operation completed successfully
readonly DEV_EXIT_SUCCESS=0

# ============================================================================
# GENERAL ERROR CODES (1-9)
# ============================================================================

# General/unspecified error (backward compatibility)
# Use more specific codes when possible
readonly DEV_EXIT_GENERAL_ERROR=1

# Invalid command-line arguments or user input
# Examples: missing required argument, invalid option, malformed input
readonly DEV_EXIT_INVALID_INPUT=2

# File system operation failed
# Examples: cannot read/write file, permission denied, disk full
readonly DEV_EXIT_FILE_ERROR=3

# File or resource not found
# Examples: VERSION file missing, schema not found, script not found
readonly DEV_EXIT_NOT_FOUND=4

# Missing required dependency
# Examples: jq not installed, bc not available, required tool unavailable
readonly DEV_EXIT_DEPENDENCY_ERROR=5

# JSON parsing or schema error
# Examples: invalid JSON syntax, malformed schema, jq error
readonly DEV_EXIT_JSON_ERROR=6

# ============================================================================
# VALIDATION AND COMPLIANCE CODES (10-19)
# ============================================================================

# Version validation failed
# Examples: version format invalid, semver check failed
readonly DEV_EXIT_VERSION_INVALID=10

# Version drift detected (files out of sync)
# Examples: README badge doesn't match VERSION file
readonly DEV_EXIT_VERSION_DRIFT=11

# Compliance check failed (threshold not met)
# Examples: CI compliance below threshold, spec violations
readonly DEV_EXIT_COMPLIANCE_FAILED=12

# Schema validation error
# Examples: JSON doesn't match schema, missing required fields
readonly DEV_EXIT_SCHEMA_ERROR=13

# ============================================================================
# DEV-TOOL SPECIFIC CODES (20-29)
# ============================================================================

# Version bump operation failed
# Examples: post-bump validation failed, update failed
readonly DEV_EXIT_BUMP_FAILED=20

# Performance benchmark target not met
# Examples: command exceeded time limit, throughput below threshold
readonly DEV_EXIT_BENCHMARK_FAILED=21

# Test execution failed
# Examples: test case failure, test fixture error
readonly DEV_EXIT_TEST_FAILED=22

# Rollback operation failed
# Examples: cannot restore previous state, backup not found
readonly DEV_EXIT_ROLLBACK_FAILED=23

# ============================================================================
# SPECIAL CODES (100+)
# These indicate notable states but are NOT errors
# ============================================================================

# No changes needed (e.g., no files to check in incremental mode)
# Not an error - operation completed but had nothing to do
readonly DEV_EXIT_NO_CHANGE=100

# Dry-run completed successfully (no actual changes made)
readonly DEV_EXIT_DRY_RUN=101

# Discovery found items of note (informational)
# Examples: untracked scripts found, stale files detected
readonly DEV_EXIT_DISCOVERY_FOUND=102

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

# Get human-readable name for dev exit code
# Args: $1 = exit code number
# Returns: Exit code name string (echoed)
dev_get_exit_code_name() {
    local code="$1"

    case "$code" in
        # Success
        0)   echo "SUCCESS" ;;

        # General errors (1-9)
        1)   echo "GENERAL_ERROR" ;;
        2)   echo "INVALID_INPUT" ;;
        3)   echo "FILE_ERROR" ;;
        4)   echo "NOT_FOUND" ;;
        5)   echo "DEPENDENCY_ERROR" ;;
        6)   echo "JSON_ERROR" ;;

        # Validation/Compliance (10-19)
        10)  echo "VERSION_INVALID" ;;
        11)  echo "VERSION_DRIFT" ;;
        12)  echo "COMPLIANCE_FAILED" ;;
        13)  echo "SCHEMA_ERROR" ;;

        # Dev-tool specific (20-29)
        20)  echo "BUMP_FAILED" ;;
        21)  echo "BENCHMARK_FAILED" ;;
        22)  echo "TEST_FAILED" ;;
        23)  echo "ROLLBACK_FAILED" ;;

        # Special (100+)
        100) echo "NO_CHANGE" ;;
        101) echo "DRY_RUN" ;;
        102) echo "DISCOVERY_FOUND" ;;

        *)   echo "UNKNOWN" ;;
    esac
}

# Check if exit code represents an error (vs success or special condition)
# Args: $1 = exit code number
# Returns: 0 if error (codes 1-99), 1 if not an error
dev_is_error_code() {
    local code="$1"
    [[ "$code" -ge 1 && "$code" -lt 100 ]]
}

# Check if exit code represents a special condition (100+)
# Args: $1 = exit code number
# Returns: 0 if special condition, 1 if not
dev_is_special_code() {
    local code="$1"
    [[ "$code" -ge 100 ]]
}

# ============================================================================
# EXPORTS
# ============================================================================

# Export constants - Success
export DEV_EXIT_SUCCESS

# Export constants - General errors (1-9)
export DEV_EXIT_GENERAL_ERROR
export DEV_EXIT_INVALID_INPUT
export DEV_EXIT_FILE_ERROR
export DEV_EXIT_NOT_FOUND
export DEV_EXIT_DEPENDENCY_ERROR
export DEV_EXIT_JSON_ERROR

# Export constants - Validation/Compliance (10-19)
export DEV_EXIT_VERSION_INVALID
export DEV_EXIT_VERSION_DRIFT
export DEV_EXIT_COMPLIANCE_FAILED
export DEV_EXIT_SCHEMA_ERROR

# Export constants - Dev-tool specific (20-29)
export DEV_EXIT_BUMP_FAILED
export DEV_EXIT_BENCHMARK_FAILED
export DEV_EXIT_TEST_FAILED
export DEV_EXIT_ROLLBACK_FAILED

# Export constants - Special (100+)
export DEV_EXIT_NO_CHANGE
export DEV_EXIT_DRY_RUN
export DEV_EXIT_DISCOVERY_FOUND

# Export functions
export -f dev_get_exit_code_name
export -f dev_is_error_code
export -f dev_is_special_code
