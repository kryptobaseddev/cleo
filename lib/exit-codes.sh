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
#           EXIT_SESSION_EXISTS, EXIT_SESSION_NOT_FOUND, EXIT_SCOPE_CONFLICT,
#           EXIT_SCOPE_INVALID, EXIT_TASK_NOT_IN_SCOPE, EXIT_TASK_CLAIMED,
#           EXIT_SESSION_REQUIRED, EXIT_SESSION_CLOSE_BLOCKED, EXIT_FOCUS_REQUIRED,
#           EXIT_NOTES_REQUIRED, EXIT_VERIFICATION_INIT_FAILED, EXIT_GATE_UPDATE_FAILED,
#           EXIT_INVALID_GATE, EXIT_INVALID_AGENT, EXIT_MAX_ROUNDS_EXCEEDED,
#           EXIT_GATE_DEPENDENCY, EXIT_VERIFICATION_LOCKED, EXIT_ROUND_MISMATCH,
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
# SESSION ERROR CODES (30-39)
# Epic-Bound Session System errors (see EPIC-SESSION-SPEC.md Part 7)
# ============================================================================

# Session already active for this scope
# Examples: starting session when one exists for same epic
readonly EXIT_SESSION_EXISTS=30

# Session ID not found
# Examples: resume/end with invalid session ID
readonly EXIT_SESSION_NOT_FOUND=31

# Session scope conflicts with existing session
# Examples: two sessions trying to claim overlapping epic scope
readonly EXIT_SCOPE_CONFLICT=32

# Invalid session scope (no epic, empty, etc.)
# Examples: --epic T999 where T999 doesn't exist or isn't an epic
readonly EXIT_SCOPE_INVALID=33

# Task is not within session scope
# Examples: focus set T050 when T050 is not in session's epic tree
readonly EXIT_TASK_NOT_IN_SCOPE=34

# Task is already claimed by another agent
# Examples: focus set T001 when another session has it focused
readonly EXIT_TASK_CLAIMED=35

# Operation requires an active session
# Examples: focus set without starting session first
readonly EXIT_SESSION_REQUIRED=36

# Cannot close session with incomplete tasks
# Examples: session close when tasks in scope are still pending
readonly EXIT_SESSION_CLOSE_BLOCKED=37

# Operation requires a focused task
# Examples: complete without having focus set
readonly EXIT_FOCUS_REQUIRED=38

# Session notes required for operation
# Examples: session end without --note when notes are required
readonly EXIT_NOTES_REQUIRED=39

# ============================================================================
# VERIFICATION ERROR CODES (40-49)
# Verification gates system errors (see Implementation-Plan-Verification.txt)
# ============================================================================

# Verification initialization failed
# Examples: cannot create verification object, invalid task state
readonly EXIT_VERIFICATION_INIT_FAILED=40

# Gate update failed
# Examples: cannot update gate value, file write error during gate update
readonly EXIT_GATE_UPDATE_FAILED=41

# Invalid gate name
# Examples: --gate unknownGate, gate name not in valid enum
readonly EXIT_INVALID_GATE=42

# Invalid agent name
# Examples: --agent unknownAgent, agent name not in valid enum
readonly EXIT_INVALID_AGENT=43

# Maximum implementation rounds exceeded
# Examples: round > maxRounds config value
readonly EXIT_MAX_ROUNDS_EXCEEDED=44

# Gate dependency not met
# Examples: setting testsPassed before implemented
readonly EXIT_GATE_DEPENDENCY=45

# Verification is locked (cannot modify)
# Examples: verification.passed = true and locked
readonly EXIT_VERIFICATION_LOCKED=46

# Round number mismatch
# Examples: expected round 2, got round 1
readonly EXIT_ROUND_MISMATCH=47

# ============================================================================
# CONTEXT SAFEGUARD EXIT CODES (50-59)
# Context window monitoring and graceful shutdown (see CONTEXT-SAFEGUARD-SPEC.md)
# ============================================================================

# Context is OK (below warning threshold)
# Exit code for: cleo context check
readonly EXIT_CONTEXT_OK=0  # Uses EXIT_SUCCESS

# Context warning threshold reached (70-84%)
# Examples: context check when usage is 75%
readonly EXIT_CONTEXT_WARNING=50

# Context caution threshold reached (85-89%)
# Examples: context check when usage is 87%
readonly EXIT_CONTEXT_CAUTION=51

# Context critical threshold reached (90-94%)
# Examples: context check when usage is 92%
readonly EXIT_CONTEXT_CRITICAL=52

# Context emergency threshold reached (95%+)
# Examples: context check when usage is 96%
readonly EXIT_CONTEXT_EMERGENCY=53

# Context state file is stale or missing
# Examples: no status line integration, state file too old
readonly EXIT_CONTEXT_STALE=54

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
        # Session (30-39)
        30)  echo "SESSION_EXISTS" ;;
        31)  echo "SESSION_NOT_FOUND" ;;
        32)  echo "SCOPE_CONFLICT" ;;
        33)  echo "SCOPE_INVALID" ;;
        34)  echo "TASK_NOT_IN_SCOPE" ;;
        35)  echo "TASK_CLAIMED" ;;
        36)  echo "SESSION_REQUIRED" ;;
        37)  echo "SESSION_CLOSE_BLOCKED" ;;
        38)  echo "FOCUS_REQUIRED" ;;
        39)  echo "NOTES_REQUIRED" ;;
        # Verification (40-47)
        40)  echo "VERIFICATION_INIT_FAILED" ;;
        41)  echo "GATE_UPDATE_FAILED" ;;
        42)  echo "INVALID_GATE" ;;
        43)  echo "INVALID_AGENT" ;;
        44)  echo "MAX_ROUNDS_EXCEEDED" ;;
        45)  echo "GATE_DEPENDENCY" ;;
        46)  echo "VERIFICATION_LOCKED" ;;
        47)  echo "ROUND_MISMATCH" ;;
        # Context Safeguard (50-59)
        50)  echo "CONTEXT_WARNING" ;;
        51)  echo "CONTEXT_CAUTION" ;;
        52)  echo "CONTEXT_CRITICAL" ;;
        53)  echo "CONTEXT_EMERGENCY" ;;
        54)  echo "CONTEXT_STALE" ;;
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
        # Session errors - some recoverable by user action
        30|31|32|33|34|35|36|38|39) return 0 ;;
        # Not recoverable: session close blocked (requires completing tasks first)
        37) return 1 ;;
        # Verification errors - most recoverable by user action
        40|41|42|43|44|45|47) return 0 ;;
        # Not recoverable: verification locked (requires manual unlock)
        46) return 1 ;;
        # Context safeguard - these are informational, not really errors
        # Agent should respond to them by running safestop, not retry
        50|51|52|53|54) return 1 ;;
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

# Export constants - Session (30-39)
export EXIT_SESSION_EXISTS
export EXIT_SESSION_NOT_FOUND
export EXIT_SCOPE_CONFLICT
export EXIT_SCOPE_INVALID
export EXIT_TASK_NOT_IN_SCOPE
export EXIT_TASK_CLAIMED
export EXIT_SESSION_REQUIRED
export EXIT_SESSION_CLOSE_BLOCKED
export EXIT_FOCUS_REQUIRED
export EXIT_NOTES_REQUIRED

# Export constants - Verification (40-47)
export EXIT_VERIFICATION_INIT_FAILED
export EXIT_GATE_UPDATE_FAILED
export EXIT_INVALID_GATE
export EXIT_INVALID_AGENT
export EXIT_MAX_ROUNDS_EXCEEDED
export EXIT_GATE_DEPENDENCY
export EXIT_VERIFICATION_LOCKED
export EXIT_ROUND_MISMATCH

# Export constants - Context Safeguard (50-59)
export EXIT_CONTEXT_OK
export EXIT_CONTEXT_WARNING
export EXIT_CONTEXT_CAUTION
export EXIT_CONTEXT_CRITICAL
export EXIT_CONTEXT_EMERGENCY
export EXIT_CONTEXT_STALE

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
