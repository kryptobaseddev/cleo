/**
 * CLEO error code to LAFS canonical error code mapping.
 *
 * Maps CLEO's numeric exit codes (ExitCode enum) to LAFS error registry
 * string codes for protocol conformance.
 *
 * @task T4671
 * @epic T4663
 */

import type { LAFSErrorCategory } from '@cleocode/lafs-protocol';
import { ExitCode } from '../types/exit-codes.js';

/**
 * Entry in the CLEO-to-LAFS error registry.
 *
 * @task T4671
 * @epic T4663
 */
export interface CleoRegistryEntry {
  exitCode: ExitCode;
  lafsCode: string;
  category: LAFSErrorCategory;
  description: string;
  retryable: boolean;
  httpStatus: number;
}

/**
 * Complete mapping of CLEO exit codes to LAFS canonical error codes.
 *
 * @task T4671
 * @epic T4663
 */
const CLEO_ERROR_REGISTRY: CleoRegistryEntry[] = [
  // General errors (1-9)
  { exitCode: ExitCode.GENERAL_ERROR, lafsCode: 'E_CLEO_GENERAL', category: 'INTERNAL', description: 'General error', retryable: true, httpStatus: 500 },
  { exitCode: ExitCode.INVALID_INPUT, lafsCode: 'E_CLEO_INVALID_INPUT', category: 'VALIDATION', description: 'Invalid input', retryable: false, httpStatus: 400 },
  { exitCode: ExitCode.FILE_ERROR, lafsCode: 'E_CLEO_FILE_ERROR', category: 'INTERNAL', description: 'File system error', retryable: false, httpStatus: 500 },
  { exitCode: ExitCode.NOT_FOUND, lafsCode: 'E_CLEO_NOT_FOUND', category: 'NOT_FOUND', description: 'Task or resource not found', retryable: false, httpStatus: 404 },
  { exitCode: ExitCode.DEPENDENCY_ERROR, lafsCode: 'E_CLEO_DEPENDENCY', category: 'VALIDATION', description: 'Dependency error', retryable: false, httpStatus: 422 },
  { exitCode: ExitCode.VALIDATION_ERROR, lafsCode: 'E_CLEO_VALIDATION', category: 'VALIDATION', description: 'Validation error', retryable: false, httpStatus: 422 },
  { exitCode: ExitCode.LOCK_TIMEOUT, lafsCode: 'E_CLEO_LOCK_TIMEOUT', category: 'CONFLICT', description: 'File lock timeout', retryable: true, httpStatus: 409 },
  { exitCode: ExitCode.CONFIG_ERROR, lafsCode: 'E_CLEO_CONFIG', category: 'VALIDATION', description: 'Configuration error', retryable: false, httpStatus: 422 },

  // Hierarchy errors (10-19)
  { exitCode: ExitCode.PARENT_NOT_FOUND, lafsCode: 'E_CLEO_PARENT_NOT_FOUND', category: 'NOT_FOUND', description: 'Parent task not found', retryable: false, httpStatus: 404 },
  { exitCode: ExitCode.DEPTH_EXCEEDED, lafsCode: 'E_CLEO_DEPTH_EXCEEDED', category: 'VALIDATION', description: 'Max hierarchy depth exceeded', retryable: false, httpStatus: 422 },
  { exitCode: ExitCode.SIBLING_LIMIT, lafsCode: 'E_CLEO_SIBLING_LIMIT', category: 'VALIDATION', description: 'Max sibling count exceeded', retryable: false, httpStatus: 422 },
  { exitCode: ExitCode.INVALID_PARENT_TYPE, lafsCode: 'E_CLEO_INVALID_PARENT_TYPE', category: 'VALIDATION', description: 'Invalid parent task type', retryable: false, httpStatus: 422 },
  { exitCode: ExitCode.CIRCULAR_REFERENCE, lafsCode: 'E_CLEO_CIRCULAR_REF', category: 'VALIDATION', description: 'Circular dependency detected', retryable: false, httpStatus: 422 },
  { exitCode: ExitCode.ORPHAN_DETECTED, lafsCode: 'E_CLEO_ORPHAN', category: 'VALIDATION', description: 'Orphan task detected', retryable: false, httpStatus: 422 },
  { exitCode: ExitCode.HAS_CHILDREN, lafsCode: 'E_CLEO_HAS_CHILDREN', category: 'CONFLICT', description: 'Task has children', retryable: false, httpStatus: 409 },
  { exitCode: ExitCode.TASK_COMPLETED, lafsCode: 'E_CLEO_TASK_COMPLETED', category: 'CONFLICT', description: 'Task already completed', retryable: false, httpStatus: 409 },
  { exitCode: ExitCode.CASCADE_FAILED, lafsCode: 'E_CLEO_CASCADE_FAILED', category: 'INTERNAL', description: 'Cascade operation failed', retryable: false, httpStatus: 500 },
  { exitCode: ExitCode.HAS_DEPENDENTS, lafsCode: 'E_CLEO_HAS_DEPENDENTS', category: 'CONFLICT', description: 'Task has dependents', retryable: false, httpStatus: 409 },

  // Concurrency errors (20-29)
  { exitCode: ExitCode.CHECKSUM_MISMATCH, lafsCode: 'E_CLEO_CHECKSUM_MISMATCH', category: 'CONFLICT', description: 'Checksum mismatch', retryable: true, httpStatus: 409 },
  { exitCode: ExitCode.CONCURRENT_MODIFICATION, lafsCode: 'E_CLEO_CONCURRENT_MOD', category: 'CONFLICT', description: 'Concurrent modification', retryable: true, httpStatus: 409 },
  { exitCode: ExitCode.ID_COLLISION, lafsCode: 'E_CLEO_ID_COLLISION', category: 'CONFLICT', description: 'ID collision', retryable: true, httpStatus: 409 },

  // Session errors (30-39)
  { exitCode: ExitCode.SESSION_EXISTS, lafsCode: 'E_CLEO_SESSION_EXISTS', category: 'CONFLICT', description: 'Session already exists', retryable: false, httpStatus: 409 },
  { exitCode: ExitCode.SESSION_NOT_FOUND, lafsCode: 'E_CLEO_SESSION_NOT_FOUND', category: 'NOT_FOUND', description: 'Session not found', retryable: false, httpStatus: 404 },
  { exitCode: ExitCode.SCOPE_CONFLICT, lafsCode: 'E_CLEO_SCOPE_CONFLICT', category: 'CONFLICT', description: 'Session scope conflict', retryable: false, httpStatus: 409 },
  { exitCode: ExitCode.SCOPE_INVALID, lafsCode: 'E_CLEO_SCOPE_INVALID', category: 'VALIDATION', description: 'Invalid scope', retryable: false, httpStatus: 422 },
  { exitCode: ExitCode.TASK_NOT_IN_SCOPE, lafsCode: 'E_CLEO_TASK_NOT_IN_SCOPE', category: 'VALIDATION', description: 'Task not in session scope', retryable: false, httpStatus: 422 },
  { exitCode: ExitCode.TASK_CLAIMED, lafsCode: 'E_CLEO_TASK_CLAIMED', category: 'CONFLICT', description: 'Task claimed by another session', retryable: false, httpStatus: 409 },
  { exitCode: ExitCode.SESSION_REQUIRED, lafsCode: 'E_CLEO_SESSION_REQUIRED', category: 'CONTRACT', description: 'Active session required', retryable: false, httpStatus: 428 },
  { exitCode: ExitCode.SESSION_CLOSE_BLOCKED, lafsCode: 'E_CLEO_SESSION_CLOSE_BLOCKED', category: 'CONFLICT', description: 'Session close blocked', retryable: false, httpStatus: 409 },
  { exitCode: ExitCode.FOCUS_REQUIRED, lafsCode: 'E_CLEO_FOCUS_REQUIRED', category: 'CONTRACT', description: 'Focus task required', retryable: false, httpStatus: 428 },
  { exitCode: ExitCode.NOTES_REQUIRED, lafsCode: 'E_CLEO_NOTES_REQUIRED', category: 'VALIDATION', description: 'Notes required', retryable: false, httpStatus: 422 },

  // Orchestrator errors (60-67)
  { exitCode: ExitCode.PROTOCOL_MISSING, lafsCode: 'E_CLEO_PROTOCOL_MISSING', category: 'CONTRACT', description: 'Protocol missing', retryable: false, httpStatus: 422 },
  { exitCode: ExitCode.INVALID_RETURN_MESSAGE, lafsCode: 'E_CLEO_INVALID_RETURN', category: 'CONTRACT', description: 'Invalid return message', retryable: false, httpStatus: 422 },
  { exitCode: ExitCode.MANIFEST_ENTRY_MISSING, lafsCode: 'E_CLEO_MANIFEST_MISSING', category: 'CONTRACT', description: 'Manifest entry missing', retryable: false, httpStatus: 422 },
  { exitCode: ExitCode.SPAWN_VALIDATION_FAILED, lafsCode: 'E_CLEO_SPAWN_FAILED', category: 'VALIDATION', description: 'Spawn validation failed', retryable: true, httpStatus: 422 },
  { exitCode: ExitCode.AUTONOMOUS_BOUNDARY, lafsCode: 'E_CLEO_AUTONOMOUS_BOUNDARY', category: 'CONTRACT', description: 'Autonomous boundary reached', retryable: false, httpStatus: 403 },
  { exitCode: ExitCode.HANDOFF_REQUIRED, lafsCode: 'E_CLEO_HANDOFF_REQUIRED', category: 'CONTRACT', description: 'Human handoff required', retryable: false, httpStatus: 403 },

  // Lifecycle errors (80-84)
  { exitCode: ExitCode.LIFECYCLE_GATE_FAILED, lafsCode: 'E_CLEO_LIFECYCLE_GATE', category: 'CONTRACT', description: 'Lifecycle gate failed', retryable: false, httpStatus: 422 },
  { exitCode: ExitCode.AUDIT_MISSING, lafsCode: 'E_CLEO_AUDIT_MISSING', category: 'CONTRACT', description: 'Audit trail missing', retryable: false, httpStatus: 422 },
  { exitCode: ExitCode.LIFECYCLE_TRANSITION_INVALID, lafsCode: 'E_CLEO_LIFECYCLE_INVALID', category: 'CONTRACT', description: 'Invalid lifecycle transition', retryable: false, httpStatus: 422 },
];

/** Lookup by exit code number. */
const byExitCode = new Map<number, CleoRegistryEntry>();
/** Lookup by LAFS string code. */
const byLafsCode = new Map<string, CleoRegistryEntry>();

for (const entry of CLEO_ERROR_REGISTRY) {
  byExitCode.set(entry.exitCode, entry);
  byLafsCode.set(entry.lafsCode, entry);
}

/**
 * Look up a registry entry by CLEO exit code.
 *
 * @task T4671
 * @epic T4663
 */
export function getRegistryEntry(exitCode: ExitCode): CleoRegistryEntry | undefined {
  return byExitCode.get(exitCode);
}

/**
 * Look up a registry entry by LAFS string code.
 *
 * @task T4671
 * @epic T4663
 */
export function getRegistryEntryByLafsCode(lafsCode: string): CleoRegistryEntry | undefined {
  return byLafsCode.get(lafsCode);
}

/**
 * Get the full CLEO error registry for conformance testing.
 *
 * @task T4671
 * @epic T4663
 */
export function getCleoErrorRegistry(): CleoRegistryEntry[] {
  return [...CLEO_ERROR_REGISTRY];
}

/**
 * Check if a LAFS code is registered in the CLEO error registry.
 *
 * @task T4671
 * @epic T4663
 */
export function isCleoRegisteredCode(lafsCode: string): boolean {
  return byLafsCode.has(lafsCode);
}
