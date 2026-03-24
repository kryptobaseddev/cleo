/**
 * Unified Error Catalog -- single source of truth for all CLEO error definitions.
 *
 * Merges previously scattered error registries (error-registry.ts, _error.ts,
 * mcp/lib/exit-codes.ts) into one canonical catalog keyed by ExitCode.
 *
 * Consumers should import from here instead of the legacy registries.
 *
 * @task T5240
 */

import { ExitCode } from '@cleocode/contracts';
import type { LAFSErrorCategory } from '@cleocode/lafs';

/**
 * A single entry in the unified error catalog.
 */
export interface ErrorDefinition {
  /** Numeric exit code from ExitCode enum. */
  code: number;
  /** Machine-readable name (matches ExitCode enum key). */
  name: string;
  /** LAFS error category for protocol conformance. */
  category: LAFSErrorCategory;
  /** Default human-readable message. */
  message: string;
  /** Default fix suggestion (copy-paste command or instruction). */
  fix?: string;
  /** HTTP status code for API/MCP responses. */
  httpStatus: number;
  /** Whether retry may succeed. */
  recoverable: boolean;
  /** LAFS-style string error code (E_CLEO_*). */
  lafsCode: string;
}

function def(
  code: ExitCode,
  name: string,
  category: LAFSErrorCategory,
  message: string,
  httpStatus: number,
  recoverable: boolean,
  lafsCode: string,
  fix?: string,
): ErrorDefinition {
  return { code, name, category, message, httpStatus, recoverable, lafsCode, fix };
}

/**
 * The unified error catalog. Keyed by numeric ExitCode value.
 */
export const ERROR_CATALOG: ReadonlyMap<number, ErrorDefinition> = new Map<number, ErrorDefinition>(
  [
    // === SUCCESS (0) ===
    [
      ExitCode.SUCCESS,
      def(ExitCode.SUCCESS, 'SUCCESS', 'INTERNAL', 'Success', 200, false, 'E_CLEO_SUCCESS'),
    ],

    // === GENERAL ERRORS (1-9) ===
    [
      ExitCode.GENERAL_ERROR,
      def(
        ExitCode.GENERAL_ERROR,
        'GENERAL_ERROR',
        'INTERNAL',
        'General error',
        500,
        true,
        'E_CLEO_GENERAL',
        'Check command syntax and parameters',
      ),
    ],
    [
      ExitCode.INVALID_INPUT,
      def(
        ExitCode.INVALID_INPUT,
        'INVALID_INPUT',
        'VALIDATION',
        'Invalid input',
        400,
        false,
        'E_CLEO_INVALID_INPUT',
        'Verify command parameters',
      ),
    ],
    [
      ExitCode.FILE_ERROR,
      def(
        ExitCode.FILE_ERROR,
        'FILE_ERROR',
        'INTERNAL',
        'File system error',
        500,
        false,
        'E_CLEO_FILE_ERROR',
        'Check file permissions and disk space',
      ),
    ],
    [
      ExitCode.NOT_FOUND,
      def(
        ExitCode.NOT_FOUND,
        'NOT_FOUND',
        'NOT_FOUND',
        'Task or resource not found',
        404,
        false,
        'E_CLEO_NOT_FOUND',
      ),
    ],
    [
      ExitCode.DEPENDENCY_ERROR,
      def(
        ExitCode.DEPENDENCY_ERROR,
        'DEPENDENCY_ERROR',
        'VALIDATION',
        'Dependency error',
        422,
        false,
        'E_CLEO_DEPENDENCY',
      ),
    ],
    [
      ExitCode.VALIDATION_ERROR,
      def(
        ExitCode.VALIDATION_ERROR,
        'VALIDATION_ERROR',
        'VALIDATION',
        'Validation error',
        422,
        false,
        'E_CLEO_VALIDATION',
      ),
    ],
    [
      ExitCode.LOCK_TIMEOUT,
      def(
        ExitCode.LOCK_TIMEOUT,
        'LOCK_TIMEOUT',
        'CONFLICT',
        'File lock timeout',
        409,
        true,
        'E_CLEO_LOCK_TIMEOUT',
        'Wait for concurrent operation to complete, then retry',
      ),
    ],
    [
      ExitCode.CONFIG_ERROR,
      def(
        ExitCode.CONFIG_ERROR,
        'CONFIG_ERROR',
        'VALIDATION',
        'Configuration error',
        422,
        false,
        'E_CLEO_CONFIG',
        'Check configuration file: .cleo/config.json',
      ),
    ],

    // === HIERARCHY ERRORS (10-19) ===
    [
      ExitCode.PARENT_NOT_FOUND,
      def(
        ExitCode.PARENT_NOT_FOUND,
        'PARENT_NOT_FOUND',
        'NOT_FOUND',
        'Parent task not found',
        404,
        false,
        'E_CLEO_PARENT_NOT_FOUND',
        'Create parent task first or remove --parent flag',
      ),
    ],
    [
      ExitCode.DEPTH_EXCEEDED,
      def(
        ExitCode.DEPTH_EXCEEDED,
        'DEPTH_EXCEEDED',
        'VALIDATION',
        'Max hierarchy depth exceeded',
        422,
        false,
        'E_CLEO_DEPTH_EXCEEDED',
      ),
    ],
    [
      ExitCode.SIBLING_LIMIT,
      def(
        ExitCode.SIBLING_LIMIT,
        'SIBLING_LIMIT',
        'VALIDATION',
        'Max sibling count exceeded',
        422,
        false,
        'E_CLEO_SIBLING_LIMIT',
      ),
    ],
    [
      ExitCode.INVALID_PARENT_TYPE,
      def(
        ExitCode.INVALID_PARENT_TYPE,
        'INVALID_PARENT_TYPE',
        'VALIDATION',
        'Invalid parent task type',
        422,
        false,
        'E_CLEO_INVALID_PARENT_TYPE',
      ),
    ],
    [
      ExitCode.CIRCULAR_REFERENCE,
      def(
        ExitCode.CIRCULAR_REFERENCE,
        'CIRCULAR_REFERENCE',
        'VALIDATION',
        'Circular dependency detected',
        422,
        false,
        'E_CLEO_CIRCULAR_REF',
      ),
    ],
    [
      ExitCode.ORPHAN_DETECTED,
      def(
        ExitCode.ORPHAN_DETECTED,
        'ORPHAN_DETECTED',
        'VALIDATION',
        'Orphan task detected',
        422,
        false,
        'E_CLEO_ORPHAN',
      ),
    ],
    [
      ExitCode.HAS_CHILDREN,
      def(
        ExitCode.HAS_CHILDREN,
        'HAS_CHILDREN',
        'CONFLICT',
        'Task has children',
        409,
        false,
        'E_CLEO_HAS_CHILDREN',
      ),
    ],
    [
      ExitCode.TASK_COMPLETED,
      def(
        ExitCode.TASK_COMPLETED,
        'TASK_COMPLETED',
        'CONFLICT',
        'Task already completed',
        409,
        false,
        'E_CLEO_TASK_COMPLETED',
      ),
    ],
    [
      ExitCode.CASCADE_FAILED,
      def(
        ExitCode.CASCADE_FAILED,
        'CASCADE_FAILED',
        'INTERNAL',
        'Cascade operation failed',
        500,
        false,
        'E_CLEO_CASCADE_FAILED',
      ),
    ],
    [
      ExitCode.HAS_DEPENDENTS,
      def(
        ExitCode.HAS_DEPENDENTS,
        'HAS_DEPENDENTS',
        'CONFLICT',
        'Task has dependents',
        409,
        false,
        'E_CLEO_HAS_DEPENDENTS',
      ),
    ],

    // === CONCURRENCY ERRORS (20-29) ===
    [
      ExitCode.CHECKSUM_MISMATCH,
      def(
        ExitCode.CHECKSUM_MISMATCH,
        'CHECKSUM_MISMATCH',
        'CONFLICT',
        'Checksum mismatch',
        409,
        true,
        'E_CLEO_CHECKSUM_MISMATCH',
      ),
    ],
    [
      ExitCode.CONCURRENT_MODIFICATION,
      def(
        ExitCode.CONCURRENT_MODIFICATION,
        'CONCURRENT_MODIFICATION',
        'CONFLICT',
        'Concurrent modification',
        409,
        true,
        'E_CLEO_CONCURRENT_MOD',
      ),
    ],
    [
      ExitCode.ID_COLLISION,
      def(
        ExitCode.ID_COLLISION,
        'ID_COLLISION',
        'CONFLICT',
        'ID collision',
        409,
        true,
        'E_CLEO_ID_COLLISION',
      ),
    ],

    // === SESSION ERRORS (30-39) ===
    [
      ExitCode.SESSION_EXISTS,
      def(
        ExitCode.SESSION_EXISTS,
        'SESSION_EXISTS',
        'CONFLICT',
        'Session already exists',
        409,
        false,
        'E_CLEO_SESSION_EXISTS',
      ),
    ],
    [
      ExitCode.SESSION_NOT_FOUND,
      def(
        ExitCode.SESSION_NOT_FOUND,
        'SESSION_NOT_FOUND',
        'NOT_FOUND',
        'Session not found',
        404,
        false,
        'E_CLEO_SESSION_NOT_FOUND',
      ),
    ],
    [
      ExitCode.SCOPE_CONFLICT,
      def(
        ExitCode.SCOPE_CONFLICT,
        'SCOPE_CONFLICT',
        'CONFLICT',
        'Session scope conflict',
        409,
        false,
        'E_CLEO_SCOPE_CONFLICT',
      ),
    ],
    [
      ExitCode.SCOPE_INVALID,
      def(
        ExitCode.SCOPE_INVALID,
        'SCOPE_INVALID',
        'VALIDATION',
        'Invalid scope',
        422,
        false,
        'E_CLEO_SCOPE_INVALID',
      ),
    ],
    [
      ExitCode.TASK_NOT_IN_SCOPE,
      def(
        ExitCode.TASK_NOT_IN_SCOPE,
        'TASK_NOT_IN_SCOPE',
        'VALIDATION',
        'Task not in session scope',
        422,
        false,
        'E_CLEO_TASK_NOT_IN_SCOPE',
      ),
    ],
    [
      ExitCode.TASK_CLAIMED,
      def(
        ExitCode.TASK_CLAIMED,
        'TASK_CLAIMED',
        'CONFLICT',
        'Task claimed by another session',
        409,
        false,
        'E_CLEO_TASK_CLAIMED',
      ),
    ],
    [
      ExitCode.SESSION_REQUIRED,
      def(
        ExitCode.SESSION_REQUIRED,
        'SESSION_REQUIRED',
        'CONTRACT',
        'Active session required',
        428,
        false,
        'E_CLEO_SESSION_REQUIRED',
      ),
    ],
    [
      ExitCode.SESSION_CLOSE_BLOCKED,
      def(
        ExitCode.SESSION_CLOSE_BLOCKED,
        'SESSION_CLOSE_BLOCKED',
        'CONFLICT',
        'Session close blocked',
        409,
        false,
        'E_CLEO_SESSION_CLOSE_BLOCKED',
      ),
    ],
    [
      ExitCode.ACTIVE_TASK_REQUIRED,
      def(
        ExitCode.ACTIVE_TASK_REQUIRED,
        'ACTIVE_TASK_REQUIRED',
        'CONTRACT',
        'Active task required',
        428,
        false,
        'E_CLEO_ACTIVE_TASK_REQUIRED',
      ),
    ],
    [
      ExitCode.NOTES_REQUIRED,
      def(
        ExitCode.NOTES_REQUIRED,
        'NOTES_REQUIRED',
        'VALIDATION',
        'Notes required',
        422,
        false,
        'E_CLEO_NOTES_REQUIRED',
      ),
    ],

    // === VERIFICATION ERRORS (40-47) ===
    [
      ExitCode.VERIFICATION_INIT_FAILED,
      def(
        ExitCode.VERIFICATION_INIT_FAILED,
        'VERIFICATION_INIT_FAILED',
        'VALIDATION',
        'Verification initialization failed',
        422,
        false,
        'E_CLEO_VERIFICATION_INIT_FAILED',
      ),
    ],
    [
      ExitCode.GATE_UPDATE_FAILED,
      def(
        ExitCode.GATE_UPDATE_FAILED,
        'GATE_UPDATE_FAILED',
        'VALIDATION',
        'Gate update failed',
        422,
        false,
        'E_CLEO_GATE_UPDATE_FAILED',
      ),
    ],
    [
      ExitCode.INVALID_GATE,
      def(
        ExitCode.INVALID_GATE,
        'INVALID_GATE',
        'VALIDATION',
        'Invalid gate name',
        422,
        false,
        'E_CLEO_INVALID_GATE',
      ),
    ],
    [
      ExitCode.INVALID_AGENT,
      def(
        ExitCode.INVALID_AGENT,
        'INVALID_AGENT',
        'VALIDATION',
        'Invalid agent name',
        422,
        false,
        'E_CLEO_INVALID_AGENT',
      ),
    ],
    [
      ExitCode.MAX_ROUNDS_EXCEEDED,
      def(
        ExitCode.MAX_ROUNDS_EXCEEDED,
        'MAX_ROUNDS_EXCEEDED',
        'VALIDATION',
        'Maximum implementation rounds exceeded',
        422,
        false,
        'E_CLEO_MAX_ROUNDS_EXCEEDED',
      ),
    ],
    [
      ExitCode.GATE_DEPENDENCY,
      def(
        ExitCode.GATE_DEPENDENCY,
        'GATE_DEPENDENCY',
        'VALIDATION',
        'Gate dependency not met',
        422,
        false,
        'E_CLEO_GATE_DEPENDENCY',
      ),
    ],
    [
      ExitCode.VERIFICATION_LOCKED,
      def(
        ExitCode.VERIFICATION_LOCKED,
        'VERIFICATION_LOCKED',
        'CONFLICT',
        'Verification locked',
        409,
        false,
        'E_CLEO_VERIFICATION_LOCKED',
      ),
    ],
    [
      ExitCode.ROUND_MISMATCH,
      def(
        ExitCode.ROUND_MISMATCH,
        'ROUND_MISMATCH',
        'VALIDATION',
        'Round number mismatch',
        422,
        false,
        'E_CLEO_ROUND_MISMATCH',
      ),
    ],

    // === CONTEXT SAFEGUARD (50-54) ===
    [
      ExitCode.CONTEXT_WARNING,
      def(
        ExitCode.CONTEXT_WARNING,
        'CONTEXT_WARNING',
        'CONTRACT',
        'Context warning threshold reached',
        429,
        false,
        'E_CLEO_CONTEXT_WARNING',
      ),
    ],
    [
      ExitCode.CONTEXT_CAUTION,
      def(
        ExitCode.CONTEXT_CAUTION,
        'CONTEXT_CAUTION',
        'CONTRACT',
        'Context caution threshold reached',
        429,
        false,
        'E_CLEO_CONTEXT_CAUTION',
      ),
    ],
    [
      ExitCode.CONTEXT_CRITICAL,
      def(
        ExitCode.CONTEXT_CRITICAL,
        'CONTEXT_CRITICAL',
        'CONTRACT',
        'Context critical threshold reached',
        429,
        false,
        'E_CLEO_CONTEXT_CRITICAL',
      ),
    ],
    [
      ExitCode.CONTEXT_EMERGENCY,
      def(
        ExitCode.CONTEXT_EMERGENCY,
        'CONTEXT_EMERGENCY',
        'CONTRACT',
        'Context emergency threshold reached',
        429,
        false,
        'E_CLEO_CONTEXT_EMERGENCY',
      ),
    ],
    [
      ExitCode.CONTEXT_STALE,
      def(
        ExitCode.CONTEXT_STALE,
        'CONTEXT_STALE',
        'CONTRACT',
        'Context state file is stale',
        429,
        false,
        'E_CLEO_CONTEXT_STALE',
      ),
    ],

    // === ORCHESTRATOR ERRORS (60-67) ===
    [
      ExitCode.PROTOCOL_MISSING,
      def(
        ExitCode.PROTOCOL_MISSING,
        'PROTOCOL_MISSING',
        'CONTRACT',
        'Protocol missing',
        422,
        false,
        'E_CLEO_PROTOCOL_MISSING',
      ),
    ],
    [
      ExitCode.INVALID_RETURN_MESSAGE,
      def(
        ExitCode.INVALID_RETURN_MESSAGE,
        'INVALID_RETURN_MESSAGE',
        'CONTRACT',
        'Invalid return message',
        422,
        false,
        'E_CLEO_INVALID_RETURN',
      ),
    ],
    [
      ExitCode.MANIFEST_ENTRY_MISSING,
      def(
        ExitCode.MANIFEST_ENTRY_MISSING,
        'MANIFEST_ENTRY_MISSING',
        'CONTRACT',
        'Manifest entry missing',
        422,
        false,
        'E_CLEO_MANIFEST_MISSING',
      ),
    ],
    [
      ExitCode.SPAWN_VALIDATION_FAILED,
      def(
        ExitCode.SPAWN_VALIDATION_FAILED,
        'SPAWN_VALIDATION_FAILED',
        'VALIDATION',
        'Spawn validation failed',
        422,
        true,
        'E_CLEO_SPAWN_FAILED',
      ),
    ],
    [
      ExitCode.AUTONOMOUS_BOUNDARY,
      def(
        ExitCode.AUTONOMOUS_BOUNDARY,
        'AUTONOMOUS_BOUNDARY',
        'CONTRACT',
        'Autonomous boundary reached',
        403,
        false,
        'E_CLEO_AUTONOMOUS_BOUNDARY',
      ),
    ],
    [
      ExitCode.HANDOFF_REQUIRED,
      def(
        ExitCode.HANDOFF_REQUIRED,
        'HANDOFF_REQUIRED',
        'CONTRACT',
        'Human handoff required',
        403,
        false,
        'E_CLEO_HANDOFF_REQUIRED',
      ),
    ],
    [
      ExitCode.RESUME_FAILED,
      def(
        ExitCode.RESUME_FAILED,
        'RESUME_FAILED',
        'INTERNAL',
        'Session resume failed',
        500,
        true,
        'E_CLEO_RESUME_FAILED',
      ),
    ],
    [
      ExitCode.CONCURRENT_SESSION,
      def(
        ExitCode.CONCURRENT_SESSION,
        'CONCURRENT_SESSION',
        'CONFLICT',
        'Concurrent session detected',
        409,
        false,
        'E_CLEO_CONCURRENT_SESSION',
      ),
    ],

    // === NEXUS ERRORS (70-79) ===
    [
      ExitCode.NEXUS_NOT_INITIALIZED,
      def(
        ExitCode.NEXUS_NOT_INITIALIZED,
        'NEXUS_NOT_INITIALIZED',
        'INTERNAL',
        'Nexus not initialized',
        500,
        false,
        'E_CLEO_NEXUS_NOT_INITIALIZED',
        'Initialize Nexus: cleo nexus init',
      ),
    ],
    [
      ExitCode.NEXUS_PROJECT_NOT_FOUND,
      def(
        ExitCode.NEXUS_PROJECT_NOT_FOUND,
        'NEXUS_PROJECT_NOT_FOUND',
        'NOT_FOUND',
        'Project not found in global registry',
        404,
        false,
        'E_CLEO_NEXUS_PROJECT_NOT_FOUND',
      ),
    ],
    [
      ExitCode.NEXUS_PERMISSION_DENIED,
      def(
        ExitCode.NEXUS_PERMISSION_DENIED,
        'NEXUS_PERMISSION_DENIED',
        'PERMISSION',
        'Insufficient permission for cross-project operation',
        403,
        false,
        'E_CLEO_NEXUS_PERMISSION_DENIED',
      ),
    ],
    [
      ExitCode.NEXUS_INVALID_SYNTAX,
      def(
        ExitCode.NEXUS_INVALID_SYNTAX,
        'NEXUS_INVALID_SYNTAX',
        'VALIDATION',
        'Invalid task reference syntax',
        422,
        false,
        'E_CLEO_NEXUS_INVALID_SYNTAX',
      ),
    ],
    [
      ExitCode.NEXUS_SYNC_FAILED,
      def(
        ExitCode.NEXUS_SYNC_FAILED,
        'NEXUS_SYNC_FAILED',
        'TRANSIENT',
        'Failed to sync project metadata',
        503,
        true,
        'E_CLEO_NEXUS_SYNC_FAILED',
      ),
    ],
    [
      ExitCode.NEXUS_REGISTRY_CORRUPT,
      def(
        ExitCode.NEXUS_REGISTRY_CORRUPT,
        'NEXUS_REGISTRY_CORRUPT',
        'INTERNAL',
        'Nexus registry corrupted',
        500,
        false,
        'E_CLEO_NEXUS_REGISTRY_CORRUPT',
      ),
    ],
    [
      ExitCode.NEXUS_PROJECT_EXISTS,
      def(
        ExitCode.NEXUS_PROJECT_EXISTS,
        'NEXUS_PROJECT_EXISTS',
        'CONFLICT',
        'Project already registered',
        409,
        false,
        'E_CLEO_NEXUS_PROJECT_EXISTS',
      ),
    ],
    [
      ExitCode.NEXUS_QUERY_FAILED,
      def(
        ExitCode.NEXUS_QUERY_FAILED,
        'NEXUS_QUERY_FAILED',
        'TRANSIENT',
        'Cross-project query failed',
        503,
        true,
        'E_CLEO_NEXUS_QUERY_FAILED',
      ),
    ],
    [
      ExitCode.NEXUS_GRAPH_ERROR,
      def(
        ExitCode.NEXUS_GRAPH_ERROR,
        'NEXUS_GRAPH_ERROR',
        'INTERNAL',
        'Graph operation error',
        500,
        true,
        'E_CLEO_NEXUS_GRAPH_ERROR',
      ),
    ],
    [
      ExitCode.NEXUS_RESERVED,
      def(
        ExitCode.NEXUS_RESERVED,
        'NEXUS_RESERVED',
        'INTERNAL',
        'Reserved nexus code',
        500,
        false,
        'E_CLEO_NEXUS_RESERVED',
      ),
    ],

    // === LIFECYCLE ENFORCEMENT (80-84) ===
    [
      ExitCode.LIFECYCLE_GATE_FAILED,
      def(
        ExitCode.LIFECYCLE_GATE_FAILED,
        'LIFECYCLE_GATE_FAILED',
        'CONTRACT',
        'Lifecycle gate failed',
        422,
        false,
        'E_CLEO_LIFECYCLE_GATE',
      ),
    ],
    [
      ExitCode.AUDIT_MISSING,
      def(
        ExitCode.AUDIT_MISSING,
        'AUDIT_MISSING',
        'CONTRACT',
        'Audit trail missing',
        422,
        false,
        'E_CLEO_AUDIT_MISSING',
      ),
    ],
    [
      ExitCode.CIRCULAR_VALIDATION,
      def(
        ExitCode.CIRCULAR_VALIDATION,
        'CIRCULAR_VALIDATION',
        'CONTRACT',
        'Circular validation detected',
        422,
        false,
        'E_CLEO_CIRCULAR_VALIDATION',
      ),
    ],
    [
      ExitCode.LIFECYCLE_TRANSITION_INVALID,
      def(
        ExitCode.LIFECYCLE_TRANSITION_INVALID,
        'LIFECYCLE_TRANSITION_INVALID',
        'CONTRACT',
        'Invalid lifecycle transition',
        422,
        false,
        'E_CLEO_LIFECYCLE_INVALID',
      ),
    ],
    [
      ExitCode.PROVENANCE_REQUIRED,
      def(
        ExitCode.PROVENANCE_REQUIRED,
        'PROVENANCE_REQUIRED',
        'CONTRACT',
        'Provenance metadata required',
        422,
        false,
        'E_CLEO_PROVENANCE_REQUIRED',
      ),
    ],

    // === ARTIFACT PUBLISH (85-89) ===
    [
      ExitCode.ARTIFACT_TYPE_UNKNOWN,
      def(
        ExitCode.ARTIFACT_TYPE_UNKNOWN,
        'ARTIFACT_TYPE_UNKNOWN',
        'VALIDATION',
        'Unknown artifact type',
        422,
        false,
        'E_CLEO_ARTIFACT_TYPE_UNKNOWN',
      ),
    ],
    [
      ExitCode.ARTIFACT_VALIDATION_FAILED,
      def(
        ExitCode.ARTIFACT_VALIDATION_FAILED,
        'ARTIFACT_VALIDATION_FAILED',
        'VALIDATION',
        'Artifact validation failed',
        422,
        false,
        'E_CLEO_ARTIFACT_VALIDATION_FAILED',
      ),
    ],
    [
      ExitCode.ARTIFACT_BUILD_FAILED,
      def(
        ExitCode.ARTIFACT_BUILD_FAILED,
        'ARTIFACT_BUILD_FAILED',
        'INTERNAL',
        'Artifact build failed',
        500,
        true,
        'E_CLEO_ARTIFACT_BUILD_FAILED',
      ),
    ],
    [
      ExitCode.ARTIFACT_PUBLISH_FAILED,
      def(
        ExitCode.ARTIFACT_PUBLISH_FAILED,
        'ARTIFACT_PUBLISH_FAILED',
        'INTERNAL',
        'Artifact publish failed',
        500,
        true,
        'E_CLEO_ARTIFACT_PUBLISH_FAILED',
      ),
    ],
    [
      ExitCode.ARTIFACT_ROLLBACK_FAILED,
      def(
        ExitCode.ARTIFACT_ROLLBACK_FAILED,
        'ARTIFACT_ROLLBACK_FAILED',
        'INTERNAL',
        'Artifact rollback failed',
        500,
        false,
        'E_CLEO_ARTIFACT_ROLLBACK_FAILED',
      ),
    ],

    // === PROVENANCE (90-94) ===
    [
      ExitCode.PROVENANCE_CONFIG_INVALID,
      def(
        ExitCode.PROVENANCE_CONFIG_INVALID,
        'PROVENANCE_CONFIG_INVALID',
        'VALIDATION',
        'Provenance config invalid',
        422,
        false,
        'E_CLEO_PROVENANCE_CONFIG_INVALID',
      ),
    ],
    [
      ExitCode.SIGNING_KEY_MISSING,
      def(
        ExitCode.SIGNING_KEY_MISSING,
        'SIGNING_KEY_MISSING',
        'VALIDATION',
        'Signing key missing',
        422,
        false,
        'E_CLEO_SIGNING_KEY_MISSING',
      ),
    ],
    [
      ExitCode.SIGNATURE_INVALID,
      def(
        ExitCode.SIGNATURE_INVALID,
        'SIGNATURE_INVALID',
        'VALIDATION',
        'Signature invalid',
        422,
        false,
        'E_CLEO_SIGNATURE_INVALID',
      ),
    ],
    [
      ExitCode.DIGEST_MISMATCH,
      def(
        ExitCode.DIGEST_MISMATCH,
        'DIGEST_MISMATCH',
        'VALIDATION',
        'Digest mismatch',
        422,
        false,
        'E_CLEO_DIGEST_MISMATCH',
      ),
    ],
    [
      ExitCode.ATTESTATION_INVALID,
      def(
        ExitCode.ATTESTATION_INVALID,
        'ATTESTATION_INVALID',
        'VALIDATION',
        'Attestation invalid',
        422,
        false,
        'E_CLEO_ATTESTATION_INVALID',
      ),
    ],

    // === ADAPTER ERRORS (95-99) ===
    [
      ExitCode.ADAPTER_NOT_FOUND,
      def(
        ExitCode.ADAPTER_NOT_FOUND,
        'ADAPTER_NOT_FOUND',
        'NOT_FOUND',
        'Provider adapter not found',
        404,
        false,
        'E_CLEO_ADAPTER_NOT_FOUND',
      ),
    ],
    [
      ExitCode.ADAPTER_INIT_FAILED,
      def(
        ExitCode.ADAPTER_INIT_FAILED,
        'ADAPTER_INIT_FAILED',
        'INTERNAL',
        'Provider adapter initialization failed',
        500,
        true,
        'E_CLEO_ADAPTER_INIT_FAILED',
      ),
    ],
    [
      ExitCode.ADAPTER_HOOK_FAILED,
      def(
        ExitCode.ADAPTER_HOOK_FAILED,
        'ADAPTER_HOOK_FAILED',
        'INTERNAL',
        'Provider adapter hook execution failed',
        500,
        true,
        'E_CLEO_ADAPTER_HOOK_FAILED',
      ),
    ],
    [
      ExitCode.ADAPTER_SPAWN_FAILED,
      def(
        ExitCode.ADAPTER_SPAWN_FAILED,
        'ADAPTER_SPAWN_FAILED',
        'INTERNAL',
        'Provider adapter process spawn failed',
        500,
        true,
        'E_CLEO_ADAPTER_SPAWN_FAILED',
      ),
    ],
    [
      ExitCode.ADAPTER_INSTALL_FAILED,
      def(
        ExitCode.ADAPTER_INSTALL_FAILED,
        'ADAPTER_INSTALL_FAILED',
        'INTERNAL',
        'Provider adapter installation failed',
        500,
        false,
        'E_CLEO_ADAPTER_INSTALL_FAILED',
      ),
    ],

    // === SPECIAL CODES (100+) ===
    [
      ExitCode.NO_DATA,
      def(
        ExitCode.NO_DATA,
        'NO_DATA',
        'INTERNAL',
        'No data to process',
        200,
        false,
        'E_CLEO_NO_DATA',
      ),
    ],
    [
      ExitCode.ALREADY_EXISTS,
      def(
        ExitCode.ALREADY_EXISTS,
        'ALREADY_EXISTS',
        'CONFLICT',
        'Resource already exists',
        200,
        false,
        'E_CLEO_ALREADY_EXISTS',
      ),
    ],
    [
      ExitCode.NO_CHANGE,
      def(
        ExitCode.NO_CHANGE,
        'NO_CHANGE',
        'INTERNAL',
        'No changes needed',
        200,
        false,
        'E_CLEO_NO_CHANGE',
      ),
    ],
    [
      ExitCode.TESTS_SKIPPED,
      def(
        ExitCode.TESTS_SKIPPED,
        'TESTS_SKIPPED',
        'INTERNAL',
        'Tests skipped',
        200,
        false,
        'E_CLEO_TESTS_SKIPPED',
      ),
    ],
  ],
);

/**
 * Look up an error definition by exit code.
 */
export function getErrorDefinition(code: number): ErrorDefinition | undefined {
  return ERROR_CATALOG.get(code);
}

/**
 * Look up an error definition by LAFS string code.
 */
export function getErrorDefinitionByLafsCode(lafsCode: string): ErrorDefinition | undefined {
  for (const entry of ERROR_CATALOG.values()) {
    if (entry.lafsCode === lafsCode) return entry;
  }
  return undefined;
}

/**
 * Get all error definitions as an array.
 */
export function getAllErrorDefinitions(): ErrorDefinition[] {
  return [...ERROR_CATALOG.values()];
}
