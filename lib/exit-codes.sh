#!/usr/bin/env bash
# exit-codes.sh - Standardized exit codes for cleo CLI
#
# LAYER: 0 (Foundation)
# DEPENDENCIES: none
# PROVIDES: EXIT_SUCCESS, EXIT_GENERAL_ERROR, EXIT_INVALID_INPUT, EXIT_FILE_ERROR,
#           EXIT_NOT_FOUND, EXIT_DEPENDENCY_ERROR, EXIT_VALIDATION_ERROR,
#           EXIT_LOCK_TIMEOUT, EXIT_CONFIG_ERROR, EXIT_PARENT_NOT_FOUND,
#           EXIT_DEPTH_EXCEEDED, EXIT_SIBLING_LIMIT, EXIT_INVALID_PARENT_TYPE,
#           EXIT_CIRCULAR_REFERENCE, EXIT_ORPHAN_DETECTED, EXIT_HAS_CHILDREN,
#           EXIT_TASK_COMPLETED, EXIT_CASCADE_FAILED, EXIT_HAS_DEPENDENTS,
#           EXIT_CHECKSUM_MISMATCH, EXIT_CONCURRENT_MODIFICATION, EXIT_ID_COLLISION,
#           EXIT_NO_DATA, EXIT_ALREADY_EXISTS, EXIT_NO_CHANGE,
#           get_exit_code_name, is_error_code, is_recoverable_code,
#           is_no_change_code, is_success_code
#
# Exit Code Ranges:
#   0      - Success
#   1-99   - Error conditions
#   100+   - Special conditions (not errors, but notable states)

#=== SOURCE GUARD ================================================
[[ -n "${_EXIT_CODES_SH_LOADED:-}" ]] && return 0
[[ -n "${EXIT_SUCCESS:-}" ]] && { _EXIT_CODES_SH_LOADED=1; return 0; }
declare -r _EXIT_CODES_SH_LOADED=1

set -euo pipefail

# ============================================================================
# SUCCESS CODES
# ============================================================================

# Operation completed successfully
readonly EXIT_SUCCESS=0

# ============================================================================
# ERROR CODES (1-99)
# ============================================================================

# General/unspecified error (backward compatibility with scripts that just use exit 1)
readonly EXIT_GENERAL_ERROR=1

# Invalid user input or command-line arguments
# Examples: missing required argument, invalid format value, malformed task ID
readonly EXIT_INVALID_INPUT=2

# File system operation failed
# Examples: cannot read/write file, permission denied, disk full
readonly EXIT_FILE_ERROR=3

# Requested resource not found
# Examples: task ID not found, file not found, phase not found
readonly EXIT_NOT_FOUND=4

# Missing required dependency
# Examples: jq not installed, required tool unavailable
readonly EXIT_DEPENDENCY_ERROR=5

# Data validation failed
# Examples: JSON schema validation error, checksum mismatch, corrupt data
readonly EXIT_VALIDATION_ERROR=6

# Failed to acquire file lock within timeout
# Examples: concurrent write attempt blocked
readonly EXIT_LOCK_TIMEOUT=7

# Configuration error
# Examples: invalid config file, missing required config
readonly EXIT_CONFIG_ERROR=8

# ============================================================================
# HIERARCHY ERROR CODES (10-19)
# See LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md Part 12 for authoritative definitions
# ============================================================================

# Parent task does not exist
# Examples: --parent T999 where T999 is not in tasks array
readonly EXIT_PARENT_NOT_FOUND=10

# Maximum hierarchy depth (3) would be exceeded
# Examples: adding child to a subtask (depth 2 → 3 not allowed)
readonly EXIT_DEPTH_EXCEEDED=11

# Maximum siblings (7) would be exceeded
# Examples: parent already has 7 children
readonly EXIT_SIBLING_LIMIT=12

# Invalid parent type (subtask cannot have children)
# Examples: --parent T005 where T005 is a subtask
readonly EXIT_INVALID_PARENT_TYPE=13

# Operation would create circular reference
# Examples: reparenting T001 to be child of its own descendant
readonly EXIT_CIRCULAR_REFERENCE=14

# Task has invalid parentId (orphan detected)
# Examples: parentId references deleted/archived task
readonly EXIT_ORPHAN_DETECTED=15

# Task has children, cannot delete without strategy
# Examples: delete T001 where T001 has child tasks
readonly EXIT_HAS_CHILDREN=16

# Task is completed, should use archive instead
# Examples: delete T001 where T001.status is "done"
readonly EXIT_TASK_COMPLETED=17

# Cascade deletion partially failed
# Examples: some child tasks failed to delete during --children=cascade
readonly EXIT_CASCADE_FAILED=18

# Task has dependents, cannot delete without --orphan flag
# Examples: delete T001 where other tasks have T001 in their depends array
readonly EXIT_HAS_DEPENDENTS=19

# ============================================================================
# CONCURRENCY ERROR CODES (20-29)
# Multi-agent coordination errors
# ============================================================================

# File was modified externally between read and write
# Examples: checksum mismatch during atomic write
readonly EXIT_CHECKSUM_MISMATCH=20

# Concurrent modification detected during multi-agent operation
# Examples: two agents tried to modify same task
readonly EXIT_CONCURRENT_MODIFICATION=21

# ID generation collision
# Examples: two agents generated same ID simultaneously
readonly EXIT_ID_COLLISION=22

# ============================================================================
# SPECIAL CODES (100+)
# These indicate notable states but are NOT errors
# ============================================================================

# No data to process (query returned empty, but operation succeeded)
# Examples: list with no matching tasks, empty log
readonly EXIT_NO_DATA=100

# Resource already exists (not an error, but notable)
# Examples: task ID collision, file already initialized
readonly EXIT_ALREADY_EXISTS=101

# No changes needed or made (operation was no-op)
#
# EXIT_NO_CHANGE (102) - Idempotency Signal for LLM Agents
# =========================================================
# See: LLM-AGENT-FIRST-SPEC.md Part 5.6 (Idempotency Requirements)
#
# SEMANTICS:
#   - The command was VALID (not an error)
#   - The operation was SUCCESSFUL (no failure occurred)
#   - State is UNCHANGED (no modifications made)
#
# AGENT RETRY BEHAVIOR:
#   - Agents SHOULD treat EXIT_NO_CHANGE as SUCCESS
#   - Agents MUST NOT retry when receiving EXIT_NO_CHANGE
#   - Retrying is safe but wasteful (state already matches intent)
#
# COMMANDS THAT RETURN EXIT_NO_CHANGE:
#   - update: Updating with identical values (no actual changes)
#   - complete: Task already has status "done"
#   - archive: Task already in archive
#   - restore: Task already in active todo.json
#
# JSON OUTPUT WHEN RETURNED:
#   {
#     "success": true,
#     "noChange": true,
#     "reason": "Task already completed",
#     "message": "No changes made (already in target state)"
#   }
#
# IMPORTANT FOR AGENTS:
#   This exit code enables safe retry loops. If an agent's previous
#   operation succeeded but the response was lost (network issue),
#   the retry will return 102 instead of creating a duplicate or
#   corrupting state. The agent can safely proceed knowing the
#   intended state has been achieved.
#
# Examples: update with same values, complete on done task, archive on archived task
readonly EXIT_NO_CHANGE=102

# ============================================================================
# ERROR CODE LOOKUP
# ============================================================================

# Get human-readable name for exit code
# Args: $1 = exit code number
# Returns: Exit code name string
get_exit_code_name() {
    local code="$1"

    case "$code" in
        # General (0-9)
        0)   echo "SUCCESS" ;;
        1)   echo "GENERAL_ERROR" ;;
        2)   echo "INVALID_INPUT" ;;
        3)   echo "FILE_ERROR" ;;
        4)   echo "NOT_FOUND" ;;
        5)   echo "DEPENDENCY_ERROR" ;;
        6)   echo "VALIDATION_ERROR" ;;
        7)   echo "LOCK_TIMEOUT" ;;
        8)   echo "CONFIG_ERROR" ;;
        # Hierarchy (10-19)
        10)  echo "PARENT_NOT_FOUND" ;;
        11)  echo "DEPTH_EXCEEDED" ;;
        12)  echo "SIBLING_LIMIT" ;;
        13)  echo "INVALID_PARENT_TYPE" ;;
        14)  echo "CIRCULAR_REFERENCE" ;;
        15)  echo "ORPHAN_DETECTED" ;;
        16)  echo "HAS_CHILDREN" ;;
        17)  echo "TASK_COMPLETED" ;;
        18)  echo "CASCADE_FAILED" ;;
        19)  echo "HAS_DEPENDENTS" ;;
        # Concurrency (20-29)
        20)  echo "CHECKSUM_MISMATCH" ;;
        21)  echo "CONCURRENT_MODIFICATION" ;;
        22)  echo "ID_COLLISION" ;;
        # Special (100+)
        100) echo "NO_DATA" ;;
        101) echo "ALREADY_EXISTS" ;;
        102) echo "NO_CHANGE" ;;
        *)   echo "UNKNOWN" ;;
    esac
}

# Check if exit code represents an error (vs special condition)
# Args: $1 = exit code number
# Returns: 0 if error, 1 if not an error
is_error_code() {
    local code="$1"
    [[ "$code" -ge 1 && "$code" -lt 100 ]]
}

# Check if exit code represents a recoverable condition
# Args: $1 = exit code number
# Returns: 0 if recoverable, 1 if not
is_recoverable_code() {
    local code="$1"

    case "$code" in
        # Not recoverable: file errors, dependency errors, circular references
        3|5|14)  return 1 ;;
        # Recoverable general errors
        1|2|4|6|7|8) return 0 ;;
        # Recoverable hierarchy errors (can be fixed by user action)
        10|11|12|13|15|16|17|19) return 0 ;;
        # Not recoverable: cascade failure (partial state, needs manual intervention)
        18) return 1 ;;
        # Recoverable concurrency errors (retry may succeed)
        20|21|22) return 0 ;;
        # Special codes are not errors, so "recoverable" doesn't apply
        *)    return 1 ;;
    esac
}

# Check if exit code indicates no change (idempotent operation)
# See: LLM-AGENT-FIRST-SPEC.md Part 5.6 (Idempotency Requirements)
#
# Args: $1 = exit code number
# Returns: 0 if exit code is EXIT_NO_CHANGE, 1 otherwise
#
# Usage:
#   if is_no_change_code "$exit_code"; then
#       # Operation succeeded but no state change occurred
#       # Agent should NOT retry - target state already achieved
#   fi
#
# Agent Guidance:
#   - Treat as success (proceed with workflow)
#   - Do NOT retry (wasteful, state already correct)
#   - Log as "success (no change)" for audit trails
is_no_change_code() {
    local code="$1"
    [[ "$code" -eq 102 ]]
}

# Check if exit code indicates success (including special success states)
# Includes EXIT_SUCCESS (0), EXIT_NO_DATA (100), EXIT_ALREADY_EXISTS (101),
# and EXIT_NO_CHANGE (102).
#
# Args: $1 = exit code number
# Returns: 0 if success/special, 1 if error
#
# Usage (for agent retry logic):
#   if is_success_code "$exit_code"; then
#       # Operation succeeded - do NOT retry
#   else
#       # Operation failed - may need retry based on is_recoverable_code
#   fi
is_success_code() {
    local code="$1"
    [[ "$code" -eq 0 || "$code" -ge 100 ]]
}

# ============================================================================
# EXPORTS
# ============================================================================

# Export constants - General (0-9)
export EXIT_SUCCESS
export EXIT_GENERAL_ERROR
export EXIT_INVALID_INPUT
export EXIT_FILE_ERROR
export EXIT_NOT_FOUND
export EXIT_DEPENDENCY_ERROR
export EXIT_VALIDATION_ERROR
export EXIT_LOCK_TIMEOUT
export EXIT_CONFIG_ERROR

# Export constants - Hierarchy (10-19)
export EXIT_PARENT_NOT_FOUND
export EXIT_DEPTH_EXCEEDED
export EXIT_SIBLING_LIMIT
export EXIT_INVALID_PARENT_TYPE
export EXIT_CIRCULAR_REFERENCE
export EXIT_ORPHAN_DETECTED
export EXIT_HAS_CHILDREN
export EXIT_TASK_COMPLETED
export EXIT_CASCADE_FAILED
export EXIT_HAS_DEPENDENTS

# Export constants - Concurrency (20-29)
export EXIT_CHECKSUM_MISMATCH
export EXIT_CONCURRENT_MODIFICATION
export EXIT_ID_COLLISION

# Export constants - Special (100+)
export EXIT_NO_DATA
export EXIT_ALREADY_EXISTS
export EXIT_NO_CHANGE

# Export functions
export -f get_exit_code_name
export -f is_error_code
export -f is_recoverable_code
export -f is_no_change_code
export -f is_success_code
