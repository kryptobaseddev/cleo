/**
 * Default configuration values for CLEO MCP Server
 *
 * @task T2928
 * @task T3145
 */

/**
 * Lifecycle enforcement configuration (Section 12.2)
 */
export interface LifecycleEnforcementConfig {
  /** Enforcement mode: strict blocks, advisory warns, off skips */
  mode: 'strict' | 'advisory' | 'off';
  /** Stages that may be skipped without failing gates */
  allowSkip: string[];
  /** Emergency bypass flag - disables all gate checks */
  emergencyBypass: boolean;
}

/**
 * Protocol validation configuration (Section 12.3)
 */
export interface ProtocolValidationConfig {
  /** Enable strict protocol validation */
  strictMode: boolean;
  /** Block operations on protocol violations */
  blockOnViolation: boolean;
  /** Log protocol violations to audit trail */
  logViolations: boolean;
}

export interface MCPConfig {
  /** Path to CLEO CLI binary (default: 'cleo') */
  cliPath: string;

  /** Operation timeout in milliseconds (default: 30000) */
  timeout: number;

  /** Logging verbosity level (default: 'info') */
  logLevel: 'debug' | 'info' | 'warn' | 'error';

  /** Enable token tracking metrics (default: false) */
  enableMetrics: boolean;

  /** Retry count for failed operations (default: 3) */
  maxRetries: number;

  /** Enable query cache (default: true) */
  queryCache: boolean;

  /** Query cache TTL in milliseconds (default: 30000) */
  queryCacheTtl: number;

  /** Enable audit logging (default: true) */
  auditLog: boolean;

  /** Strict validation mode (default: true) */
  strictValidation: boolean;

  /** Lifecycle enforcement configuration (Section 12.2) */
  lifecycleEnforcement: LifecycleEnforcementConfig;

  /** Protocol validation configuration (Section 12.3) */
  protocolValidation: ProtocolValidationConfig;
}

/**
 * Default lifecycle enforcement configuration
 */
export const DEFAULT_LIFECYCLE_ENFORCEMENT: LifecycleEnforcementConfig = {
  mode: 'strict',
  allowSkip: ['consensus'],
  emergencyBypass: false,
};

/**
 * Default protocol validation configuration
 */
export const DEFAULT_PROTOCOL_VALIDATION: ProtocolValidationConfig = {
  strictMode: true,
  blockOnViolation: true,
  logViolations: true,
};

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: MCPConfig = {
  cliPath: 'cleo',
  timeout: 30000, // 30 seconds
  logLevel: 'info',
  enableMetrics: false,
  maxRetries: 3,
  queryCache: true,
  queryCacheTtl: 30000, // 30 seconds
  auditLog: true,
  strictValidation: true,
  lifecycleEnforcement: { ...DEFAULT_LIFECYCLE_ENFORCEMENT },
  protocolValidation: { ...DEFAULT_PROTOCOL_VALIDATION },
};

/**
 * Environment variable prefix for CLEO configuration
 */
export const ENV_PREFIX = 'CLEO_MCP_';

/**
 * Configuration schema for validation
 */
export const CONFIG_SCHEMA = {
  cliPath: { type: 'string', required: true },
  timeout: { type: 'number', min: 1000, max: 300000 },
  logLevel: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
  enableMetrics: { type: 'boolean' },
  maxRetries: { type: 'number', min: 0, max: 10 },
  queryCache: { type: 'boolean' },
  queryCacheTtl: { type: 'number', min: 0, max: 600000 },
  auditLog: { type: 'boolean' },
  strictValidation: { type: 'boolean' },
} as const;
