/**
 * Protocol enforcement types used by the RCASD-IVTR+C protocol system.
 *
 * These types are used by protocol-enforcement.ts, protocol-rules.ts,
 * verification-gates.ts, and gate-validators.ts. Previously defined in
 * src/mcp/lib/exit-codes.ts (deprecated), now canonical in core.
 *
 * @task T5707
 * @epic T5701
 */

/**
 * Error severity levels for protocol/gate validation.
 */
export enum ErrorSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
}

/**
 * Error category for grouping protocol/gate violations.
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
 * Protocol-specific exit codes used by the RCASD-IVTR+C enforcement system.
 *
 * These map to the protocol violation range (60-70) and lifecycle enforcement
 * range (80-84) defined in the MCP server specification. The values here
 * align with the protocol enforcement layer's own exit code semantics,
 * which differ from the canonical CLI exit codes in src/types/exit-codes.ts.
 *
 * The canonical CLI ExitCode enum at src/types/exit-codes.ts maps range 60-67
 * to orchestrator errors, while this enum maps them to protocol violations.
 * Both are valid in their respective contexts — CLI vs protocol enforcement.
 */
export enum ProtocolExitCode {
  // Success
  SUCCESS = 0,

  // General Errors
  E_GENERAL_ERROR = 1,
  E_INVALID_INPUT = 2,
  E_FILE_ERROR = 3,
  E_NOT_FOUND = 4,
  E_DEPENDENCY_ERROR = 5,
  E_VALIDATION_ERROR = 6,

  // Hierarchy Errors
  E_PARENT_NOT_FOUND = 10,
  E_DEPTH_EXCEEDED = 11,
  E_SIBLING_LIMIT = 12,
  E_CIRCULAR_REFERENCE = 14,
  E_SESSION_REQUIRED = 36,

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

  // Lifecycle Enforcement (80-84)
  E_LIFECYCLE_GATE_FAILED = 80,
}

/**
 * Request shape used by the protocol enforcement system.
 * Minimal interface matching the fields needed by ProtocolEnforcer.
 */
export interface ProtocolRequest {
  gateway: 'query' | 'mutate';
  domain: string;
  operation: string;
  params?: Record<string, unknown>;
}

/**
 * Response shape used by the protocol enforcement system.
 */
export interface ProtocolResponse {
  _meta: {
    gateway: string;
    domain: string;
    operation: string;
    timestamp: string;
    duration_ms: number;
    [key: string]: unknown;
  };
  success: boolean;
  data?: unknown;
  partial?: boolean;
  error?: {
    code: string;
    exitCode?: number;
    message: string;
    details?: Record<string, unknown>;
    fix?: string;
    alternatives?: Array<{ action: string; command: string }>;
  };
}
