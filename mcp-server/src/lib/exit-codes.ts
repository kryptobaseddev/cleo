/**
 * Exit code mapping for CLEO CLI operations
 *
 * @task T2913
 * @epic T2908
 *
 * Maps all CLEO exit codes (1-100+) to error metadata with automatic
 * fix command generation and contextual suggestions.
 *
 * Reference: lib/exit-codes.sh, lib/protocol-validation.sh
 */

/**
 * Exit code enumeration (complete mapping 0-100+)
 */
export enum ExitCode {
  // Success (0)
  SUCCESS = 0,

  // General Errors (1-9)
  E_GENERAL_ERROR = 1,
  E_INVALID_INPUT = 2,
  E_FILE_ERROR = 3,
  E_NOT_FOUND = 4,
  E_DEPENDENCY_ERROR = 5,
  E_VALIDATION_ERROR = 6,
  E_LOCK_TIMEOUT = 7,
  E_CONFIG_ERROR = 8,

  // Hierarchy Errors (10-19)
  E_PARENT_NOT_FOUND = 10,
  E_DEPTH_EXCEEDED = 11,
  E_SIBLING_LIMIT = 12,
  E_INVALID_PARENT_TYPE = 13,
  E_CIRCULAR_REFERENCE = 14,
  E_ORPHAN_DETECTED = 15,
  E_HAS_CHILDREN = 16,
  E_TASK_COMPLETED = 17,
  E_CASCADE_FAILED = 18,
  E_HAS_DEPENDENTS = 19,

  // Concurrency Errors (20-29)
  E_CHECKSUM_MISMATCH = 20,
  E_CONCURRENT_MODIFICATION = 21,
  E_ID_COLLISION = 22,

  // Session Errors (30-39)
  E_SESSION_EXISTS = 30,
  E_SESSION_NOT_FOUND = 31,
  E_SCOPE_CONFLICT = 32,
  E_SCOPE_INVALID = 33,
  E_TASK_NOT_IN_SCOPE = 34,
  E_TASK_CLAIMED = 35,
  E_SESSION_REQUIRED = 36,
  E_SESSION_CLOSE_BLOCKED = 37,
  E_FOCUS_REQUIRED = 38,
  E_NOTES_REQUIRED = 39,

  // Verification Errors (40-49)
  E_VERIFICATION_INIT_FAILED = 40,
  E_GATE_UPDATE_FAILED = 41,
  E_INVALID_GATE = 42,
  E_INVALID_AGENT = 43,
  E_MAX_ROUNDS_EXCEEDED = 44,
  E_GATE_DEPENDENCY = 45,
  E_VERIFICATION_LOCKED = 46,
  E_ROUND_MISMATCH = 47,

  // Context Safeguard Errors (50-59)
  E_CONTEXT_WARNING = 50,
  E_CONTEXT_CAUTION = 51,
  E_CONTEXT_CRITICAL = 52,
  E_CONTEXT_EMERGENCY = 53,
  E_CONTEXT_STALE = 54,

  // Protocol Violations (60-70)
  E_PROTOCOL_RESEARCH = 60,
  E_PROTOCOL_CONSENSUS = 61,
  E_PROTOCOL_SPECIFICATION = 62,
  E_PROTOCOL_DECOMPOSITION = 63,
  E_PROTOCOL_IMPLEMENTATION = 64,
  E_PROTOCOL_CONTRIBUTION = 65,
  E_PROTOCOL_RELEASE = 66,
  E_PROTOCOL_GENERIC = 67,
  E_PROTOCOL_VALIDATION = 68,
  E_TESTS_SKIPPED = 69,
  E_COVERAGE_INSUFFICIENT = 70,

  // Nexus Errors (71-79)
  E_NEXUS_NOT_INITIALIZED = 71,
  E_NEXUS_PROJECT_NOT_FOUND = 72,
  E_NEXUS_PERMISSION_DENIED = 73,
  E_NEXUS_INVALID_SYNTAX = 74,
  E_NEXUS_SYNC_FAILED = 75,
  E_NEXUS_REGISTRY_CORRUPT = 76,
  E_NEXUS_PROJECT_EXISTS = 77,
  E_NEXUS_QUERY_FAILED = 78,
  E_NEXUS_GRAPH_ERROR = 79,

  // Lifecycle Enforcement Errors (80-84)
  E_LIFECYCLE_GATE_FAILED = 80,
  E_AUDIT_MISSING = 81,
  E_CIRCULAR_VALIDATION = 82,
  E_LIFECYCLE_TRANSITION_INVALID = 83,
  E_PROVENANCE_REQUIRED = 84,

  // Special Codes (100+)
  E_NO_DATA = 100,
  E_ALREADY_EXISTS = 101,
  E_NO_CHANGE = 102,
}

/**
 * Error severity levels
 */
export enum ErrorSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
}

/**
 * Error category for grouping
 */
export enum ErrorCategory {
  GENERAL = 'general',
  HIERARCHY = 'hierarchy',
  CONCURRENCY = 'concurrency',
  SESSION = 'session',
  VERIFICATION = 'verification',
  CONTEXT = 'context',
  PROTOCOL = 'protocol',
  NEXUS = 'nexus',
  LIFECYCLE = 'lifecycle',
  SPECIAL = 'special',
}

/**
 * Alternative action suggestion
 */
export interface ErrorAlternative {
  action: string;
  command: string;
}

/**
 * Complete error metadata mapping
 */
export interface ErrorMapping {
  code: string;
  name: string;
  description: string;
  category: ErrorCategory;
  severity: ErrorSeverity;
  retryable: boolean;
  fixTemplate?: string;
  alternatives?: ErrorAlternative[];
  documentation?: string;
}

/**
 * Complete exit code to error mapping
 */
export const ERROR_MAP: Record<number, ErrorMapping> = {
  // Success
  [ExitCode.SUCCESS]: {
    code: 'SUCCESS',
    name: 'Success',
    description: 'Operation completed successfully',
    category: ErrorCategory.SPECIAL,
    severity: ErrorSeverity.INFO,
    retryable: false,
  },

  // General Errors (1-9)
  [ExitCode.E_GENERAL_ERROR]: {
    code: 'E_GENERAL_ERROR',
    name: 'General Error',
    description: 'Unspecified error occurred',
    category: ErrorCategory.GENERAL,
    severity: ErrorSeverity.ERROR,
    retryable: true,
    fixTemplate: 'Check command syntax and parameters',
  },

  [ExitCode.E_INVALID_INPUT]: {
    code: 'E_INVALID_INPUT',
    name: 'Invalid Input',
    description: 'Invalid user input or command-line arguments',
    category: ErrorCategory.GENERAL,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Verify command parameters: {details}',
    alternatives: [
      { action: 'Show command help', command: 'cleo help {command}' },
    ],
  },

  [ExitCode.E_FILE_ERROR]: {
    code: 'E_FILE_ERROR',
    name: 'File Error',
    description: 'File system operation failed',
    category: ErrorCategory.GENERAL,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Check file permissions and disk space',
  },

  [ExitCode.E_NOT_FOUND]: {
    code: 'E_NOT_FOUND',
    name: 'Not Found',
    description: 'Requested resource not found',
    category: ErrorCategory.GENERAL,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Verify resource exists: {resource}',
    alternatives: [
      { action: 'List available resources', command: 'cleo list' },
      { action: 'Search for resource', command: 'cleo find "{query}"' },
    ],
  },

  [ExitCode.E_DEPENDENCY_ERROR]: {
    code: 'E_DEPENDENCY_ERROR',
    name: 'Dependency Error',
    description: 'Missing required dependency',
    category: ErrorCategory.GENERAL,
    severity: ErrorSeverity.CRITICAL,
    retryable: false,
    fixTemplate: 'Install required dependency: {dependency}',
  },

  [ExitCode.E_VALIDATION_ERROR]: {
    code: 'E_VALIDATION_ERROR',
    name: 'Validation Error',
    description: 'Data validation failed',
    category: ErrorCategory.GENERAL,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Fix validation errors: {violations}',
  },

  [ExitCode.E_LOCK_TIMEOUT]: {
    code: 'E_LOCK_TIMEOUT',
    name: 'Lock Timeout',
    description: 'Failed to acquire file lock within timeout',
    category: ErrorCategory.CONCURRENCY,
    severity: ErrorSeverity.WARNING,
    retryable: true,
    fixTemplate: 'Wait for concurrent operation to complete, then retry',
  },

  [ExitCode.E_CONFIG_ERROR]: {
    code: 'E_CONFIG_ERROR',
    name: 'Configuration Error',
    description: 'Configuration error',
    category: ErrorCategory.GENERAL,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Check configuration file: .cleo/config.json',
    alternatives: [
      { action: 'Show config', command: 'cleo config show' },
      { action: 'Validate config', command: 'cleo --validate' },
    ],
  },

  // Hierarchy Errors (10-19)
  [ExitCode.E_PARENT_NOT_FOUND]: {
    code: 'E_PARENT_NOT_FOUND',
    name: 'Parent Not Found',
    description: 'Parent task does not exist',
    category: ErrorCategory.HIERARCHY,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Create parent task first or remove --parent flag',
    alternatives: [
      { action: 'List tasks', command: 'cleo list' },
      { action: 'Check task exists', command: 'cleo exists {parentId}' },
    ],
  },

  [ExitCode.E_DEPTH_EXCEEDED]: {
    code: 'E_DEPTH_EXCEEDED',
    name: 'Depth Exceeded',
    description: 'Maximum hierarchy depth (3) would be exceeded',
    category: ErrorCategory.HIERARCHY,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Create task at higher level (max depth: epic→task→subtask)',
    alternatives: [
      { action: 'View hierarchy', command: 'cleo tree {parentId}' },
      { action: 'Create as sibling', command: 'Remove --parent flag' },
    ],
  },

  [ExitCode.E_SIBLING_LIMIT]: {
    code: 'E_SIBLING_LIMIT',
    name: 'Sibling Limit',
    description: 'Maximum siblings (7) would be exceeded',
    category: ErrorCategory.HIERARCHY,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Create new parent to group related tasks',
    alternatives: [
      { action: 'List siblings', command: 'cleo list --parent {parentId}' },
      { action: 'Create new epic', command: 'cleo add "New Group" --parent {grandparentId}' },
    ],
  },

  [ExitCode.E_INVALID_PARENT_TYPE]: {
    code: 'E_INVALID_PARENT_TYPE',
    name: 'Invalid Parent Type',
    description: 'Subtask cannot have children',
    category: ErrorCategory.HIERARCHY,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Promote subtask to task first: cleo promote {parentId}',
  },

  [ExitCode.E_CIRCULAR_REFERENCE]: {
    code: 'E_CIRCULAR_REFERENCE',
    name: 'Circular Reference',
    description: 'Operation would create circular reference',
    category: ErrorCategory.HIERARCHY,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Cannot create circular dependency: {cycle}',
    alternatives: [
      { action: 'View dependencies', command: 'cleo deps {taskId}' },
    ],
  },

  [ExitCode.E_ORPHAN_DETECTED]: {
    code: 'E_ORPHAN_DETECTED',
    name: 'Orphan Detected',
    description: 'Task has invalid parentId (orphan detected)',
    category: ErrorCategory.HIERARCHY,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Remove parent reference or restore parent task',
    alternatives: [
      { action: 'Remove parent', command: 'cleo update {taskId} --no-parent' },
      { action: 'Unarchive parent', command: 'cleo unarchive {parentId}' },
    ],
  },

  [ExitCode.E_HAS_CHILDREN]: {
    code: 'E_HAS_CHILDREN',
    name: 'Has Children',
    description: 'Task has children, cannot delete without strategy',
    category: ErrorCategory.HIERARCHY,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Specify deletion strategy: --cascade, --reparent, or --orphan',
    alternatives: [
      { action: 'List children', command: 'cleo list --parent {taskId}' },
      { action: 'Cascade delete', command: 'cleo delete {taskId} --cascade' },
      { action: 'Reparent children', command: 'cleo delete {taskId} --reparent {newParentId}' },
    ],
  },

  [ExitCode.E_TASK_COMPLETED]: {
    code: 'E_TASK_COMPLETED',
    name: 'Task Completed',
    description: 'Task is completed, should use archive instead',
    category: ErrorCategory.HIERARCHY,
    severity: ErrorSeverity.WARNING,
    retryable: false,
    fixTemplate: 'Archive completed task: cleo archive {taskId}',
  },

  [ExitCode.E_CASCADE_FAILED]: {
    code: 'E_CASCADE_FAILED',
    name: 'Cascade Failed',
    description: 'Cascade deletion partially failed',
    category: ErrorCategory.HIERARCHY,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Some child tasks failed to delete: {failures}',
  },

  [ExitCode.E_HAS_DEPENDENTS]: {
    code: 'E_HAS_DEPENDENTS',
    name: 'Has Dependents',
    description: 'Task has dependents, cannot delete without --orphan flag',
    category: ErrorCategory.HIERARCHY,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Other tasks depend on this: cleo delete {taskId} --orphan',
    alternatives: [
      { action: 'List dependents', command: 'cleo deps {taskId} --reverse' },
      { action: 'Force delete', command: 'cleo delete {taskId} --orphan' },
    ],
  },

  // Concurrency Errors (20-29)
  [ExitCode.E_CHECKSUM_MISMATCH]: {
    code: 'E_CHECKSUM_MISMATCH',
    name: 'Checksum Mismatch',
    description: 'File was modified externally between read and write',
    category: ErrorCategory.CONCURRENCY,
    severity: ErrorSeverity.WARNING,
    retryable: true,
    fixTemplate: 'File modified by another process, retrying operation',
  },

  [ExitCode.E_CONCURRENT_MODIFICATION]: {
    code: 'E_CONCURRENT_MODIFICATION',
    name: 'Concurrent Modification',
    description: 'Concurrent modification detected during multi-agent operation',
    category: ErrorCategory.CONCURRENCY,
    severity: ErrorSeverity.WARNING,
    retryable: true,
    fixTemplate: 'Wait for concurrent agent to complete, then retry',
  },

  [ExitCode.E_ID_COLLISION]: {
    code: 'E_ID_COLLISION',
    name: 'ID Collision',
    description: 'ID generation collision',
    category: ErrorCategory.CONCURRENCY,
    severity: ErrorSeverity.WARNING,
    retryable: true,
    fixTemplate: 'ID collision detected, regenerating unique ID',
  },

  // Session Errors (30-39)
  [ExitCode.E_SESSION_EXISTS]: {
    code: 'E_SESSION_EXISTS',
    name: 'Session Exists',
    description: 'Session already active for this scope',
    category: ErrorCategory.SESSION,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Resume existing session: cleo session resume {sessionId}',
    alternatives: [
      { action: 'List sessions', command: 'cleo session list' },
      { action: 'Resume session', command: 'cleo session resume {sessionId}' },
    ],
  },

  [ExitCode.E_SESSION_NOT_FOUND]: {
    code: 'E_SESSION_NOT_FOUND',
    name: 'Session Not Found',
    description: 'Session ID not found',
    category: ErrorCategory.SESSION,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Start new session: cleo session start --scope epic:{epicId}',
    alternatives: [
      { action: 'List sessions', command: 'cleo session list' },
      { action: 'Start session', command: 'cleo session start --scope epic:{epicId}' },
    ],
  },

  [ExitCode.E_SCOPE_CONFLICT]: {
    code: 'E_SCOPE_CONFLICT',
    name: 'Scope Conflict',
    description: 'Session scope conflicts with existing session',
    category: ErrorCategory.SESSION,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Another session is active for this epic',
    alternatives: [
      { action: 'List active sessions', command: 'cleo session list --active' },
      { action: 'End conflicting session', command: 'cleo session end --session {conflictingId}' },
    ],
  },

  [ExitCode.E_SCOPE_INVALID]: {
    code: 'E_SCOPE_INVALID',
    name: 'Scope Invalid',
    description: 'Invalid session scope (no epic, empty, etc.)',
    category: ErrorCategory.SESSION,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Specify valid epic scope: --scope epic:{epicId}',
    alternatives: [
      { action: 'List epics', command: 'cleo list --type epic' },
    ],
  },

  [ExitCode.E_TASK_NOT_IN_SCOPE]: {
    code: 'E_TASK_NOT_IN_SCOPE',
    name: 'Task Not In Scope',
    description: 'Task is not within session scope',
    category: ErrorCategory.SESSION,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Task {taskId} is not in current session scope',
    alternatives: [
      { action: 'View session scope', command: 'cleo session status' },
      { action: 'View task tree', command: 'cleo tree {taskId}' },
    ],
  },

  [ExitCode.E_TASK_CLAIMED]: {
    code: 'E_TASK_CLAIMED',
    name: 'Task Claimed',
    description: 'Task is already claimed by another agent',
    category: ErrorCategory.SESSION,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Task claimed by another session: {claimingSession}',
    alternatives: [
      { action: 'List active sessions', command: 'cleo session list --active' },
      { action: 'Choose different task', command: 'cleo next' },
    ],
  },

  [ExitCode.E_SESSION_REQUIRED]: {
    code: 'E_SESSION_REQUIRED',
    name: 'Session Required',
    description: 'Operation requires an active session',
    category: ErrorCategory.SESSION,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Start session first: cleo session start --scope epic:{epicId} --auto-focus',
    alternatives: [
      { action: 'Start session', command: 'cleo session start --scope epic:{epicId} --auto-focus' },
      { action: 'Resume session', command: 'cleo session resume {sessionId}' },
    ],
  },

  [ExitCode.E_SESSION_CLOSE_BLOCKED]: {
    code: 'E_SESSION_CLOSE_BLOCKED',
    name: 'Session Close Blocked',
    description: 'Cannot close session with incomplete tasks',
    category: ErrorCategory.SESSION,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Complete pending tasks before closing session',
    alternatives: [
      { action: 'List pending tasks', command: 'cleo list --status pending --parent {epicId}' },
      { action: 'Suspend session', command: 'cleo session suspend --note "Reason"' },
    ],
  },

  [ExitCode.E_FOCUS_REQUIRED]: {
    code: 'E_FOCUS_REQUIRED',
    name: 'Focus Required',
    description: 'Operation requires a focused task',
    category: ErrorCategory.SESSION,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Set focus first: cleo focus set {taskId}',
    alternatives: [
      { action: 'Get next task', command: 'cleo next' },
      { action: 'Set focus', command: 'cleo focus set {taskId}' },
    ],
  },

  [ExitCode.E_NOTES_REQUIRED]: {
    code: 'E_NOTES_REQUIRED',
    name: 'Notes Required',
    description: 'Session notes required for operation',
    category: ErrorCategory.SESSION,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Add notes: --note "Session summary"',
  },

  // Verification Errors (40-49)
  [ExitCode.E_VERIFICATION_INIT_FAILED]: {
    code: 'E_VERIFICATION_INIT_FAILED',
    name: 'Verification Init Failed',
    description: 'Verification initialization failed',
    category: ErrorCategory.VERIFICATION,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Cannot initialize verification object for task {taskId}',
  },

  [ExitCode.E_GATE_UPDATE_FAILED]: {
    code: 'E_GATE_UPDATE_FAILED',
    name: 'Gate Update Failed',
    description: 'Gate update failed',
    category: ErrorCategory.VERIFICATION,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Cannot update gate {gateName}: {reason}',
  },

  [ExitCode.E_INVALID_GATE]: {
    code: 'E_INVALID_GATE',
    name: 'Invalid Gate',
    description: 'Invalid gate name',
    category: ErrorCategory.VERIFICATION,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Unknown gate: {gateName}',
    alternatives: [
      { action: 'List valid gates', command: 'cleo gate list' },
    ],
  },

  [ExitCode.E_INVALID_AGENT]: {
    code: 'E_INVALID_AGENT',
    name: 'Invalid Agent',
    description: 'Invalid agent name',
    category: ErrorCategory.VERIFICATION,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Unknown agent: {agentName}',
    alternatives: [
      { action: 'List valid agents', command: 'skill list' },
    ],
  },

  [ExitCode.E_MAX_ROUNDS_EXCEEDED]: {
    code: 'E_MAX_ROUNDS_EXCEEDED',
    name: 'Max Rounds Exceeded',
    description: 'Maximum implementation rounds exceeded',
    category: ErrorCategory.VERIFICATION,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Exceeded max rounds ({maxRounds}), escalating to HITL',
  },

  [ExitCode.E_GATE_DEPENDENCY]: {
    code: 'E_GATE_DEPENDENCY',
    name: 'Gate Dependency',
    description: 'Gate dependency not met',
    category: ErrorCategory.VERIFICATION,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Complete prerequisite gate first: {prerequisiteGate}',
    alternatives: [
      { action: 'View gate status', command: 'cleo lifecycle gates {taskId}' },
    ],
  },

  [ExitCode.E_VERIFICATION_LOCKED]: {
    code: 'E_VERIFICATION_LOCKED',
    name: 'Verification Locked',
    description: 'Verification is locked (cannot modify)',
    category: ErrorCategory.VERIFICATION,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Verification locked, cannot modify gates',
  },

  [ExitCode.E_ROUND_MISMATCH]: {
    code: 'E_ROUND_MISMATCH',
    name: 'Round Mismatch',
    description: 'Round number mismatch',
    category: ErrorCategory.VERIFICATION,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Round mismatch: expected {expectedRound}, got {actualRound}',
  },

  // Context Safeguard Errors (50-59)
  [ExitCode.E_CONTEXT_WARNING]: {
    code: 'E_CONTEXT_WARNING',
    name: 'Context Warning',
    description: 'Context warning threshold reached (70-84%)',
    category: ErrorCategory.CONTEXT,
    severity: ErrorSeverity.WARNING,
    retryable: false,
    fixTemplate: 'Context usage at {percentage}%, consider using cleo safestop',
    alternatives: [
      { action: 'Check context', command: 'cleo context' },
      { action: 'Safe stop', command: 'cleo safestop' },
    ],
  },

  [ExitCode.E_CONTEXT_CAUTION]: {
    code: 'E_CONTEXT_CAUTION',
    name: 'Context Caution',
    description: 'Context caution threshold reached (85-89%)',
    category: ErrorCategory.CONTEXT,
    severity: ErrorSeverity.WARNING,
    retryable: false,
    fixTemplate: 'Context usage at {percentage}%, recommend using cleo safestop',
    alternatives: [
      { action: 'Check context', command: 'cleo context' },
      { action: 'Safe stop', command: 'cleo safestop' },
    ],
  },

  [ExitCode.E_CONTEXT_CRITICAL]: {
    code: 'E_CONTEXT_CRITICAL',
    name: 'Context Critical',
    description: 'Context critical threshold reached (90-94%)',
    category: ErrorCategory.CONTEXT,
    severity: ErrorSeverity.CRITICAL,
    retryable: false,
    fixTemplate: 'Context usage at {percentage}%, MUST use cleo safestop now',
    alternatives: [
      { action: 'Safe stop', command: 'cleo safestop' },
    ],
  },

  [ExitCode.E_CONTEXT_EMERGENCY]: {
    code: 'E_CONTEXT_EMERGENCY',
    name: 'Context Emergency',
    description: 'Context emergency threshold reached (95%+)',
    category: ErrorCategory.CONTEXT,
    severity: ErrorSeverity.CRITICAL,
    retryable: false,
    fixTemplate: 'Context usage at {percentage}%, EMERGENCY - use cleo safestop immediately',
    alternatives: [
      { action: 'Safe stop', command: 'cleo safestop' },
    ],
  },

  [ExitCode.E_CONTEXT_STALE]: {
    code: 'E_CONTEXT_STALE',
    name: 'Context Stale',
    description: 'Context state file is stale or missing',
    category: ErrorCategory.CONTEXT,
    severity: ErrorSeverity.WARNING,
    retryable: true,
    fixTemplate: 'Context state file is stale, refresh with cleo context',
  },

  // Protocol Violations (60-70)
  [ExitCode.E_PROTOCOL_RESEARCH]: {
    code: 'E_PROTOCOL_RESEARCH',
    name: 'Research Protocol Violation',
    description: 'Research protocol requirements not met',
    category: ErrorCategory.PROTOCOL,
    severity: ErrorSeverity.ERROR,
    retryable: true,
    fixTemplate: 'Fix research protocol violations: {violations}',
    documentation: 'protocols/research.md',
  },

  [ExitCode.E_PROTOCOL_CONSENSUS]: {
    code: 'E_PROTOCOL_CONSENSUS',
    name: 'Consensus Protocol Violation',
    description: 'Consensus protocol requirements not met',
    category: ErrorCategory.PROTOCOL,
    severity: ErrorSeverity.ERROR,
    retryable: true,
    fixTemplate: 'Fix consensus protocol violations: {violations}',
    documentation: 'protocols/consensus.md',
  },

  [ExitCode.E_PROTOCOL_SPECIFICATION]: {
    code: 'E_PROTOCOL_SPECIFICATION',
    name: 'Specification Protocol Violation',
    description: 'Specification protocol requirements not met',
    category: ErrorCategory.PROTOCOL,
    severity: ErrorSeverity.ERROR,
    retryable: true,
    fixTemplate: 'Fix specification protocol violations: {violations}',
    documentation: 'protocols/specification.md',
  },

  [ExitCode.E_PROTOCOL_DECOMPOSITION]: {
    code: 'E_PROTOCOL_DECOMPOSITION',
    name: 'Decomposition Protocol Violation',
    description: 'Decomposition protocol requirements not met',
    category: ErrorCategory.PROTOCOL,
    severity: ErrorSeverity.ERROR,
    retryable: true,
    fixTemplate: 'Fix decomposition protocol violations: {violations}',
    documentation: 'protocols/decomposition.md',
  },

  [ExitCode.E_PROTOCOL_IMPLEMENTATION]: {
    code: 'E_PROTOCOL_IMPLEMENTATION',
    name: 'Implementation Protocol Violation',
    description: 'Implementation protocol requirements not met',
    category: ErrorCategory.PROTOCOL,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Fix implementation protocol violations: {violations}',
    documentation: 'protocols/implementation.md',
  },

  [ExitCode.E_PROTOCOL_CONTRIBUTION]: {
    code: 'E_PROTOCOL_CONTRIBUTION',
    name: 'Contribution Protocol Violation',
    description: 'Contribution protocol requirements not met',
    category: ErrorCategory.PROTOCOL,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Fix contribution protocol violations: {violations}',
    documentation: 'protocols/contribution.md',
  },

  [ExitCode.E_PROTOCOL_RELEASE]: {
    code: 'E_PROTOCOL_RELEASE',
    name: 'Release Protocol Violation',
    description: 'Release protocol requirements not met',
    category: ErrorCategory.PROTOCOL,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Fix release protocol violations: {violations}',
    documentation: 'protocols/release.md',
  },

  [ExitCode.E_PROTOCOL_GENERIC]: {
    code: 'E_PROTOCOL_GENERIC',
    name: 'Generic Protocol Violation',
    description: 'Generic protocol violation or unknown protocol type',
    category: ErrorCategory.PROTOCOL,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Fix protocol violations: {violations}',
  },

  [ExitCode.E_PROTOCOL_VALIDATION]: {
    code: 'E_PROTOCOL_VALIDATION',
    name: 'Validation Protocol Violation',
    description: 'Validation protocol requirements not met',
    category: ErrorCategory.PROTOCOL,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Fix validation protocol violations: {violations}',
    documentation: 'protocols/validation.md',
  },

  [ExitCode.E_TESTS_SKIPPED]: {
    code: 'E_TESTS_SKIPPED',
    name: 'Tests Skipped',
    description: 'Tests not run or incomplete',
    category: ErrorCategory.PROTOCOL,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Run complete test suite: cleo test run',
    alternatives: [
      { action: 'Run tests', command: 'cleo test run' },
      { action: 'Check test status', command: 'cleo test status' },
    ],
  },

  [ExitCode.E_COVERAGE_INSUFFICIENT]: {
    code: 'E_COVERAGE_INSUFFICIENT',
    name: 'Coverage Insufficient',
    description: 'Test coverage below threshold',
    category: ErrorCategory.PROTOCOL,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Increase test coverage to meet threshold',
    alternatives: [
      { action: 'View coverage', command: 'cleo test coverage' },
    ],
  },

  // Nexus Errors (71-79)
  [ExitCode.E_NEXUS_NOT_INITIALIZED]: {
    code: 'E_NEXUS_NOT_INITIALIZED',
    name: 'Nexus Not Initialized',
    description: 'Nexus not initialized',
    category: ErrorCategory.NEXUS,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Initialize Nexus: cleo nexus init',
  },

  [ExitCode.E_NEXUS_PROJECT_NOT_FOUND]: {
    code: 'E_NEXUS_PROJECT_NOT_FOUND',
    name: 'Nexus Project Not Found',
    description: 'Project not found in global registry',
    category: ErrorCategory.NEXUS,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Register project: cleo nexus register {projectPath}',
  },

  [ExitCode.E_NEXUS_PERMISSION_DENIED]: {
    code: 'E_NEXUS_PERMISSION_DENIED',
    name: 'Nexus Permission Denied',
    description: 'Insufficient permission for cross-project operation',
    category: ErrorCategory.NEXUS,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Check Nexus permissions for project {projectName}',
  },

  [ExitCode.E_NEXUS_INVALID_SYNTAX]: {
    code: 'E_NEXUS_INVALID_SYNTAX',
    name: 'Nexus Invalid Syntax',
    description: 'Invalid task reference syntax',
    category: ErrorCategory.NEXUS,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Use format: project:task_id (e.g., "myproject:T123")',
  },

  [ExitCode.E_NEXUS_SYNC_FAILED]: {
    code: 'E_NEXUS_SYNC_FAILED',
    name: 'Nexus Sync Failed',
    description: 'Failed to sync project metadata',
    category: ErrorCategory.NEXUS,
    severity: ErrorSeverity.ERROR,
    retryable: true,
    fixTemplate: 'Retry Nexus sync: cleo nexus sync',
  },

  [ExitCode.E_NEXUS_REGISTRY_CORRUPT]: {
    code: 'E_NEXUS_REGISTRY_CORRUPT',
    name: 'Nexus Registry Corrupt',
    description: 'Nexus registry file corrupted or invalid',
    category: ErrorCategory.NEXUS,
    severity: ErrorSeverity.CRITICAL,
    retryable: false,
    fixTemplate: 'Restore from backup: cleo nexus restore',
  },

  [ExitCode.E_NEXUS_PROJECT_EXISTS]: {
    code: 'E_NEXUS_PROJECT_EXISTS',
    name: 'Nexus Project Exists',
    description: 'Project already registered in Nexus',
    category: ErrorCategory.NEXUS,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Project already registered: {projectName}',
  },

  [ExitCode.E_NEXUS_QUERY_FAILED]: {
    code: 'E_NEXUS_QUERY_FAILED',
    name: 'Nexus Query Failed',
    description: 'Cross-project query operation failed',
    category: ErrorCategory.NEXUS,
    severity: ErrorSeverity.ERROR,
    retryable: true,
    fixTemplate: 'Retry query: {query}',
  },

  [ExitCode.E_NEXUS_GRAPH_ERROR]: {
    code: 'E_NEXUS_GRAPH_ERROR',
    name: 'Nexus Graph Error',
    description: 'Graph operation error',
    category: ErrorCategory.NEXUS,
    severity: ErrorSeverity.ERROR,
    retryable: true,
    fixTemplate: 'Rebuild Nexus graph: cleo nexus rebuild',
  },

  // Lifecycle Enforcement Errors (80-84)
  [ExitCode.E_LIFECYCLE_GATE_FAILED]: {
    code: 'E_LIFECYCLE_GATE_FAILED',
    name: 'Lifecycle Gate Failed',
    description: 'Lifecycle gate requirements not met',
    category: ErrorCategory.LIFECYCLE,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Complete prerequisite stages: {missingStages}',
    alternatives: [
      { action: 'Check lifecycle status', command: 'cleo lifecycle status {taskId}' },
      { action: 'View prerequisites', command: 'cleo lifecycle prerequisites {stage}' },
    ],
  },

  [ExitCode.E_AUDIT_MISSING]: {
    code: 'E_AUDIT_MISSING',
    name: 'Audit Missing',
    description: 'Audit object missing or incomplete',
    category: ErrorCategory.LIFECYCLE,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Add required audit fields: {missingFields}',
  },

  [ExitCode.E_CIRCULAR_VALIDATION]: {
    code: 'E_CIRCULAR_VALIDATION',
    name: 'Circular Validation',
    description: 'Circular validation detected (agent validating own work)',
    category: ErrorCategory.LIFECYCLE,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Use different agent for validation (not {creatingAgent})',
  },

  [ExitCode.E_LIFECYCLE_TRANSITION_INVALID]: {
    code: 'E_LIFECYCLE_TRANSITION_INVALID',
    name: 'Invalid Lifecycle Transition',
    description: 'Invalid lifecycle state transition',
    category: ErrorCategory.LIFECYCLE,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Cannot transition from {fromStage} to {toStage}',
  },

  [ExitCode.E_PROVENANCE_REQUIRED]: {
    code: 'E_PROVENANCE_REQUIRED',
    name: 'Provenance Required',
    description: 'Provenance fields required but missing',
    category: ErrorCategory.LIFECYCLE,
    severity: ErrorSeverity.ERROR,
    retryable: false,
    fixTemplate: 'Add provenance tags: @task {taskId} to all new code',
  },

  // Special Codes (100+)
  [ExitCode.E_NO_DATA]: {
    code: 'E_NO_DATA',
    name: 'No Data',
    description: 'No data to process (query returned empty)',
    category: ErrorCategory.SPECIAL,
    severity: ErrorSeverity.INFO,
    retryable: false,
    fixTemplate: 'No results found for query: {query}',
  },

  [ExitCode.E_ALREADY_EXISTS]: {
    code: 'E_ALREADY_EXISTS',
    name: 'Already Exists',
    description: 'Resource already exists (not an error)',
    category: ErrorCategory.SPECIAL,
    severity: ErrorSeverity.INFO,
    retryable: false,
    fixTemplate: 'Resource already exists: {resource}',
  },

  [ExitCode.E_NO_CHANGE]: {
    code: 'E_NO_CHANGE',
    name: 'No Change',
    description: 'No changes needed or made (idempotent operation)',
    category: ErrorCategory.SPECIAL,
    severity: ErrorSeverity.INFO,
    retryable: false,
    fixTemplate: 'No changes made (already in target state)',
  },
};

/**
 * Get error mapping for exit code
 */
export function getErrorMapping(exitCode: number): ErrorMapping {
  return ERROR_MAP[exitCode] || {
    code: 'E_UNKNOWN',
    name: 'Unknown Error',
    description: `Unknown exit code: ${exitCode}`,
    category: ErrorCategory.GENERAL,
    severity: ErrorSeverity.ERROR,
    retryable: false,
  };
}

/**
 * Check if exit code represents an error
 */
export function isError(exitCode: number): boolean {
  return exitCode >= 1 && exitCode < 100;
}

/**
 * Check if exit code is retryable
 */
export function isRetryable(exitCode: number): boolean {
  const mapping = getErrorMapping(exitCode);
  return mapping.retryable;
}

/**
 * Check if exit code represents success
 */
export function isSuccess(exitCode: number): boolean {
  return exitCode === 0 || exitCode >= 100;
}

/**
 * Generate fix command from template
 */
export function generateFixCommand(
  exitCode: number,
  context: Record<string, string>
): string | undefined {
  const mapping = getErrorMapping(exitCode);
  if (!mapping.fixTemplate) {
    return undefined;
  }

  let fix = mapping.fixTemplate;
  for (const [key, value] of Object.entries(context)) {
    fix = fix.replace(`{${key}}`, value);
  }

  return fix;
}

/**
 * Generate suggestions from alternatives
 */
export function generateSuggestions(
  exitCode: number,
  context: Record<string, string>
): ErrorAlternative[] {
  const mapping = getErrorMapping(exitCode);
  if (!mapping.alternatives) {
    return [];
  }

  return mapping.alternatives.map((alt) => {
    let command = alt.command;
    for (const [key, value] of Object.entries(context)) {
      command = command.replace(`{${key}}`, value);
    }
    return {
      action: alt.action,
      command,
    };
  });
}

/**
 * Exit codes that support automatic retry with exponential backoff.
 * Per MCP-SERVER-SPECIFICATION Section 9.1.
 *
 * @task T3142
 */
export const RETRYABLE_EXIT_CODES: ReadonlySet<number> = new Set([
  ExitCode.E_LOCK_TIMEOUT,              // 7
  ExitCode.E_CHECKSUM_MISMATCH,         // 20
  ExitCode.E_CONCURRENT_MODIFICATION,   // 21
  ExitCode.E_ID_COLLISION,              // 22
  ExitCode.E_PROTOCOL_RESEARCH,         // 60
  ExitCode.E_PROTOCOL_CONSENSUS,        // 61
  ExitCode.E_PROTOCOL_SPECIFICATION,    // 62
  ExitCode.E_PROTOCOL_DECOMPOSITION,    // 63
]);

/**
 * Exit codes that require human intervention and must NEVER be retried.
 * Per MCP-SERVER-SPECIFICATION Section 9.2.
 *
 * @task T3142
 */
export const NON_RECOVERABLE_EXIT_CODES: ReadonlySet<number> = new Set([
  ExitCode.E_LIFECYCLE_GATE_FAILED,         // 80
  ExitCode.E_CIRCULAR_VALIDATION,           // 82
  ExitCode.E_LIFECYCLE_TRANSITION_INVALID,  // 83
  ExitCode.E_PROVENANCE_REQUIRED,           // 84
]);

/**
 * Check if an exit code represents a non-recoverable error
 * requiring human intervention. These must NEVER be retried.
 *
 * @task T3142
 */
export function isNonRecoverable(exitCode: number): boolean {
  return NON_RECOVERABLE_EXIT_CODES.has(exitCode);
}

/**
 * Check if an exit code represents a recoverable error
 * @param exitCode The exit code to check
 * @returns true if the error is retryable
 */
export function isRecoverable(exitCode: number): boolean {
  // Retry codes: 7 (lock timeout), 20-22 (concurrency), 60-63 (protocol)
  return RETRYABLE_EXIT_CODES.has(exitCode);
}
