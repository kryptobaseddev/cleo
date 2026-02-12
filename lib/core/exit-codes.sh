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
#           EXIT_NEXUS_NOT_INITIALIZED, EXIT_NEXUS_PROJECT_NOT_FOUND,
#           EXIT_NEXUS_PERMISSION_DENIED, EXIT_NEXUS_INVALID_SYNTAX,
#           EXIT_NEXUS_SYNC_FAILED, EXIT_NEXUS_REGISTRY_CORRUPT,
#           EXIT_NEXUS_PROJECT_EXISTS, EXIT_NEXUS_QUERY_FAILED,
#           EXIT_NEXUS_GRAPH_ERROR, EXIT_NEXUS_RESERVED,
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
# PROTOCOL VALIDATION ERROR CODES (60-67) - CONFLICT WARNING
# Per PROTOCOL-ENFORCEMENT-SPEC.md Part 3.3 (Epic T2679)
# ============================================================================
#
# DESIGN CONFLICT: Exit codes 60-67 are ALSO used for orchestrator errors
# (see EXIT_PROTOCOL_MISSING, etc. below). This creates collision between:
#   - RCSD-IVTR protocol validation (research, consensus, spec, etc.)
#   - Orchestrator spawn protocol validation (injection, manifest, etc.)
#
# CURRENT STATE (v0.74.4):
#   - lib/validation/protocol-validation.sh uses 60-67 per PROTOCOL-ENFORCEMENT-SPEC.md
#   - lib/core/exit-codes.sh defines orchestrator codes at 60-67 (legacy)
#   - Both definitions exist simultaneously (undefined behavior)
#
# RESOLUTION NEEDED (Follow-up Epic):
#   - Move orchestrator codes to 68-74 range (preferred)
#   - Update all orchestrator code references
#   - Document migration in CHANGELOG.md
#
# CURRENT WORKAROUND:
#   - Protocol validation functions check via lib/validation/protocol-validation.sh
#   - Orchestrator functions check via lib/core/exit-codes.sh
#   - No function uses both simultaneously (isolates conflict)
#
# See: claudedocs/agent-outputs/T2697-exit-code-conflict-resolution.md
#
# Protocol validation codes (lib/validation/protocol-validation.sh):
#   60 - EXIT_PROTOCOL_RESEARCH         - Research protocol violation
#   61 - EXIT_PROTOCOL_CONSENSUS        - Consensus protocol violation
#   62 - EXIT_PROTOCOL_SPECIFICATION    - Specification protocol violation
#   63 - EXIT_PROTOCOL_DECOMPOSITION    - Decomposition protocol violation
#   64 - EXIT_PROTOCOL_IMPLEMENTATION   - Implementation protocol violation
#   65 - EXIT_PROTOCOL_CONTRIBUTION     - Contribution protocol violation
#   66 - EXIT_PROTOCOL_RELEASE          - Release protocol violation
#   67 - EXIT_PROTOCOL_GENERIC          - Generic protocol violation
#
# ============================================================================
# ORCHESTRATOR ERROR CODES (60-69) - LEGACY (conflicting with above)
# Multi-agent orchestration protocol errors
# ============================================================================

# Protocol injection block missing from spawn prompt
# Examples: spawning subagent without SUBAGENT PROTOCOL marker
readonly EXIT_PROTOCOL_MISSING=60

# Invalid subagent return message format
# Examples: subagent returned prose instead of standard completion message
readonly EXIT_INVALID_RETURN_MESSAGE=61

# Manifest entry not found after spawn
# Examples: subagent did not append to MANIFEST.jsonl
readonly EXIT_MANIFEST_ENTRY_MISSING=62

# Spawn validation failed
# Examples: skill validation failed, task not ready for spawn
readonly EXIT_SPAWN_VALIDATION_FAILED=63

# Autonomous operation boundary reached
# Examples: orchestrator reached HITL gate, architectural decision required
readonly EXIT_AUTONOMOUS_BOUNDARY=64

# Handoff required before stopping
# Examples: stopping at context threshold without generating handoff
readonly EXIT_HANDOFF_REQUIRED=65

# Resume from handoff failed
# Examples: session not found, handoff document invalid, concurrent modification
readonly EXIT_RESUME_FAILED=66

# Concurrent session on same scope
# Examples: attempting to resume when another session is active on same epic
readonly EXIT_CONCURRENT_SESSION=67

# ============================================================================
# NEXUS ERROR CODES (70-79)
# Cross-project global intelligence errors (T2231 - Nexus implementation)
# ============================================================================

# Nexus not initialized
# Examples: ~/.cleo/nexus directory missing, registry not created
readonly EXIT_NEXUS_NOT_INITIALIZED=70

# Project not found in global registry
# Examples: project name not registered, invalid project reference
readonly EXIT_NEXUS_PROJECT_NOT_FOUND=71

# Insufficient permission for cross-project operation
# Examples: write operation with read-only permission
readonly EXIT_NEXUS_PERMISSION_DENIED=72

# Invalid task reference syntax
# Examples: malformed "project:task_id" format, multiple colons
readonly EXIT_NEXUS_INVALID_SYNTAX=73

# Failed to sync project metadata
# Examples: global graph rebuild failed, cache update error
readonly EXIT_NEXUS_SYNC_FAILED=74

# Nexus registry file corrupted or invalid
# Examples: JSON parse error, missing required fields
readonly EXIT_NEXUS_REGISTRY_CORRUPT=75

# Project already registered in Nexus
# Examples: attempting to register duplicate project
readonly EXIT_NEXUS_PROJECT_EXISTS=76

# Cross-project query operation failed
# Examples: global search failed, discovery error
readonly EXIT_NEXUS_QUERY_FAILED=77

# Graph operation error
# Examples: dependency traversal error, relationship discovery failed
readonly EXIT_NEXUS_GRAPH_ERROR=78

# Reserved for future Nexus features
readonly EXIT_NEXUS_RESERVED=79

# ============================================================================
# LIFECYCLE ENFORCEMENT ERROR CODES (80-84) - MOVED FROM 75-79
# Provenance and lifecycle validation errors (T2569 - v2.10.0)
# NOTE: Moved to 80-84 to avoid conflict with Nexus codes
# ============================================================================

# Lifecycle gate requirements not met
# Examples: attempting to enter implementation without specification approval
readonly EXIT_LIFECYCLE_GATE_FAILED=80

# Audit object missing or incomplete
# Examples: MANIFEST entry missing required audit.created_by field
readonly EXIT_AUDIT_MISSING=81

# Circular validation detected (agent validating own work)
# Examples: validated_by == created_by, or N-hop cycle in provenance chain
readonly EXIT_CIRCULAR_VALIDATION=82

# Invalid lifecycle state transition
# Examples: attempting to move backward in RCSD→IVTR pipeline
readonly EXIT_LIFECYCLE_TRANSITION_INVALID=83

# Provenance fields required but missing
# Examples: task missing createdBy field in enforcement mode
readonly EXIT_PROVENANCE_REQUIRED=84

# ============================================================================
# ARTIFACT PUBLISH ERROR CODES (85-89)
# Per protocols/artifact-publish.md
# ============================================================================

# Artifact type not registered or handler not found
# Examples: unknown type in config, missing handler prefix
readonly EXIT_ARTIFACT_TYPE_UNKNOWN=85

# Pre-build validation failed for artifact
# Examples: invalid package manifest, missing build tool
readonly EXIT_ARTIFACT_VALIDATION_FAILED=86

# Artifact build command returned non-zero
# Examples: compilation failure, missing dependencies
readonly EXIT_ARTIFACT_BUILD_FAILED=87

# Artifact publish to registry failed (rollback attempted)
# Examples: auth failure, network error, version conflict
readonly EXIT_ARTIFACT_PUBLISH_FAILED=88

# Rollback of previously published artifacts failed
# Examples: registry API error during unpublish, manual intervention required
readonly EXIT_ARTIFACT_ROLLBACK_FAILED=89

# ============================================================================
# PROVENANCE ERROR CODES (90-94)
# Per protocols/provenance.md
# ============================================================================

# Invalid provenance or signing configuration
# Examples: bad signing method, missing security config section
readonly EXIT_PROVENANCE_CONFIG_INVALID=90

# Signing key not found or not accessible
# Examples: GPG_KEY_ID not set, key expired, keyring not available
readonly EXIT_SIGNING_KEY_MISSING=91

# Signature verification failed or signature not produced
# Examples: cosign verify-blob fails, gpg --verify fails, .sig missing
readonly EXIT_SIGNATURE_INVALID=92

# Computed digest does not match recorded digest
# Examples: artifact tampered, rebuild produced different output
readonly EXIT_DIGEST_MISMATCH=93

# Attestation subject does not match artifact or format invalid
# Examples: wrong digest in attestation subject, invalid in-toto statement
readonly EXIT_ATTESTATION_INVALID=94

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
        # Orchestrator (60-69)
        60)  echo "PROTOCOL_MISSING" ;;
        61)  echo "INVALID_RETURN_MESSAGE" ;;
        62)  echo "MANIFEST_ENTRY_MISSING" ;;
        63)  echo "SPAWN_VALIDATION_FAILED" ;;
        64)  echo "AUTONOMOUS_BOUNDARY" ;;
        65)  echo "HANDOFF_REQUIRED" ;;
        66)  echo "RESUME_FAILED" ;;
        67)  echo "CONCURRENT_SESSION" ;;
        # Nexus (70-79)
        70)  echo "NEXUS_NOT_INITIALIZED" ;;
        71)  echo "NEXUS_PROJECT_NOT_FOUND" ;;
        72)  echo "NEXUS_PERMISSION_DENIED" ;;
        73)  echo "NEXUS_INVALID_SYNTAX" ;;
        74)  echo "NEXUS_SYNC_FAILED" ;;
        75)  echo "NEXUS_REGISTRY_CORRUPT" ;;
        76)  echo "NEXUS_PROJECT_EXISTS" ;;
        77)  echo "NEXUS_QUERY_FAILED" ;;
        78)  echo "NEXUS_GRAPH_ERROR" ;;
        79)  echo "NEXUS_RESERVED" ;;
        # Lifecycle Enforcement (80-84)
        80)  echo "LIFECYCLE_GATE_FAILED" ;;
        81)  echo "AUDIT_MISSING" ;;
        82)  echo "CIRCULAR_VALIDATION" ;;
        83)  echo "LIFECYCLE_TRANSITION_INVALID" ;;
        84)  echo "PROVENANCE_REQUIRED" ;;
        # Artifact Publish (85-89)
        85)  echo "ARTIFACT_TYPE_UNKNOWN" ;;
        86)  echo "ARTIFACT_VALIDATION_FAILED" ;;
        87)  echo "ARTIFACT_BUILD_FAILED" ;;
        88)  echo "ARTIFACT_PUBLISH_FAILED" ;;
        89)  echo "ARTIFACT_ROLLBACK_FAILED" ;;
        # Provenance (90-94)
        90)  echo "PROVENANCE_CONFIG_INVALID" ;;
        91)  echo "SIGNING_KEY_MISSING" ;;
        92)  echo "SIGNATURE_INVALID" ;;
        93)  echo "DIGEST_MISMATCH" ;;
        94)  echo "ATTESTATION_INVALID" ;;
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
        # Orchestrator errors - recoverable by fixing prompt and respawning
        60|61|62|63) return 0 ;;
        # Autonomous orchestration - boundary/handoff require HITL, resume/concurrent may be retryable
        64|65) return 1 ;;  # Need HITL decision
        66|67) return 0 ;;  # May be retryable
        # Nexus errors - most recoverable by registration/permission changes
        70|71|73|74|76) return 0 ;;  # Recoverable by user action
        # Not recoverable: invalid syntax (requires fixing query)
        72) return 1 ;;
        # Not recoverable: registry corrupt (requires manual intervention)
        75) return 1 ;;
        # Nexus query/graph errors may be retryable
        77|78) return 0 ;;
        # Lifecycle enforcement errors - most recoverable by fixing audit/provenance
        80|81|84) return 0 ;;
        # Not recoverable: circular validation (requires different agent)
        82) return 1 ;;
        # Not recoverable: invalid lifecycle transition (requires proper sequence)
        83) return 1 ;;
        # Artifact publish errors - most recoverable by fixing config/build/auth
        85) return 1 ;;  # Not recoverable: unknown type (requires config fix)
        86|87|88) return 0 ;;  # Recoverable: validation/build/publish can be retried
        89) return 1 ;;  # Not recoverable: rollback failed (manual intervention)
        # Provenance errors - most recoverable by fixing config/keys
        90|91|92|94) return 0 ;;  # Recoverable: config/key/signing/attestation fixable
        93) return 1 ;;  # Not recoverable: digest mismatch (possible tampering)
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

# Export constants - Orchestrator (60-69)
export EXIT_PROTOCOL_MISSING
export EXIT_INVALID_RETURN_MESSAGE
export EXIT_MANIFEST_ENTRY_MISSING
export EXIT_SPAWN_VALIDATION_FAILED
export EXIT_AUTONOMOUS_BOUNDARY
export EXIT_HANDOFF_REQUIRED
export EXIT_RESUME_FAILED
export EXIT_CONCURRENT_SESSION

# Export constants - Nexus (70-79)
export EXIT_NEXUS_NOT_INITIALIZED
export EXIT_NEXUS_PROJECT_NOT_FOUND
export EXIT_NEXUS_PERMISSION_DENIED
export EXIT_NEXUS_INVALID_SYNTAX
export EXIT_NEXUS_SYNC_FAILED
export EXIT_NEXUS_REGISTRY_CORRUPT
export EXIT_NEXUS_PROJECT_EXISTS
export EXIT_NEXUS_QUERY_FAILED
export EXIT_NEXUS_GRAPH_ERROR
export EXIT_NEXUS_RESERVED

# Export constants - Lifecycle Enforcement (80-84)
export EXIT_LIFECYCLE_GATE_FAILED
export EXIT_AUDIT_MISSING
export EXIT_CIRCULAR_VALIDATION
export EXIT_LIFECYCLE_TRANSITION_INVALID
export EXIT_PROVENANCE_REQUIRED

# Export constants - Artifact Publish (85-89)
export EXIT_ARTIFACT_TYPE_UNKNOWN
export EXIT_ARTIFACT_VALIDATION_FAILED
export EXIT_ARTIFACT_BUILD_FAILED
export EXIT_ARTIFACT_PUBLISH_FAILED
export EXIT_ARTIFACT_ROLLBACK_FAILED

# Export constants - Provenance (90-94)
export EXIT_PROVENANCE_CONFIG_INVALID
export EXIT_SIGNING_KEY_MISSING
export EXIT_SIGNATURE_INVALID
export EXIT_DIGEST_MISMATCH
export EXIT_ATTESTATION_INVALID

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
