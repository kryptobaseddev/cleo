/**
 * Response Formatter for CLEO MCP Server
 *
 * Wraps all responses in standard _meta envelope format used by CLEO CLI.
 * Ensures consistency between CLI and MCP server outputs.
 *
 * @task T2912
 * @task T2913 - Integrated exit code mapping
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { SCHEMA_URL_OUTPUT } from './schema.js';
import {
  handleCLIError,
  formatErrorForMCP,
  createErrorContext,
  type CLIErrorContext,
} from './error-handler.js';
import { isRecoverable as isRecoverableCode } from './exit-codes.js';

/**
 * Standard CLEO response envelope with _meta wrapper
 */
export interface CleoResponse<T = unknown> {
  $schema: string;
  _meta: {
    format: 'json';
    version: string;
    command: string;
    timestamp: string;
    session?: string | null;
  };
  success: boolean;
  data?: T;
  error?: CleoError;
}

/**
 * Standard CLEO error structure
 */
export interface CleoError {
  code: string;
  message: string;
  exitCode: number;
  recoverable: boolean;
  suggestion?: string;
  fix?: string;
  alternatives?: Array<{
    action: string;
    command: string;
  }>;
  context?: Record<string, unknown>;
}

/**
 * Cache for version to avoid repeated file reads
 */
let versionCache: string | null = null;

/**
 * Get current CLEO version from VERSION file
 */
export function getCurrentVersion(): string {
  if (versionCache !== null) {
    return versionCache;
  }

  try {
    const projectRoot = process.env.CLEO_ROOT || process.cwd();
    const versionPath = join(projectRoot, 'VERSION');
    const version = readFileSync(versionPath, 'utf-8').trim();
    versionCache = version || '0.0.0';
    return versionCache;
  } catch (error) {
    // Fallback if VERSION file not found
    versionCache = '0.0.0';
    return versionCache;
  }
}

/**
 * Reset version cache (for testing)
 */
export function resetVersionCache(): void {
  versionCache = null;
}

/**
 * Generate ISO-8601 timestamp
 */
export function generateTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Add _meta envelope to response
 */
export function addMetaEnvelope<T>(
  command: string,
  data: T,
  session?: string | null
): Pick<CleoResponse<T>, '$schema' | '_meta' | 'data'> {
  return {
    $schema: SCHEMA_URL_OUTPUT,
    _meta: {
      format: 'json',
      version: getCurrentVersion(),
      command,
      timestamp: generateTimestamp(),
      ...(session !== undefined && { session }),
    },
    data,
  };
}

/**
 * Format successful response with _meta envelope
 */
export function formatSuccess<T>(
  command: string,
  data: T,
  session?: string | null
): CleoResponse<T> {
  return {
    ...addMetaEnvelope(command, data, session),
    success: true,
  };
}

/**
 * Format error response with _meta envelope
 */
export function formatError(
  command: string,
  error: CleoError,
  session?: string | null
): CleoResponse<never> {
  return {
    $schema: SCHEMA_URL_OUTPUT,
    _meta: {
      format: 'json',
      version: getCurrentVersion(),
      command,
      timestamp: generateTimestamp(),
      ...(session !== undefined && { session }),
    },
    success: false,
    error,
  };
}

/**
 * Determine if an exit code is recoverable
 * @deprecated Use isRecoverable from error-handler.ts instead
 */
export function isRecoverable(exitCode: number): boolean {
  return isRecoverableCode(exitCode);
}

/**
 * Create CleoError from basic parameters
 */
export function createError(
  code: string,
  message: string,
  exitCode: number = 1,
  options?: {
    suggestion?: string;
    fix?: string;
    alternatives?: Array<{ action: string; command: string }>;
    context?: Record<string, unknown>;
  }
): CleoError {
  return {
    code,
    message,
    exitCode,
    recoverable: isRecoverable(exitCode),
    ...options,
  };
}

/**
 * Create CleoError from exit code and CLI context
 * Uses exit code mapper for automatic error details
 *
 * @task T2913
 */
export function createErrorFromExitCode(
  exitCode: number,
  command: string,
  args: string[],
  stderr?: string,
  stdout?: string
): CleoError {
  const context = createErrorContext(command, args, stderr, stdout);
  const formatted = handleCLIError(exitCode, context);

  return {
    code: formatted.code,
    message: formatted.message,
    exitCode: formatted.exitCode,
    recoverable: isRecoverable(formatted.exitCode),
    fix: formatted.fix,
    alternatives: formatted.alternatives,
    context: formatted.context,
  };
}

/**
 * Format CLI command output as CLEO response
 *
 * Parses CLI JSON output and wraps in standard envelope if not already wrapped
 */
export function formatCliOutput<T = unknown>(
  command: string,
  cliOutput: string,
  session?: string | null
): CleoResponse<T> {
  try {
    const parsed = JSON.parse(cliOutput);

    // If already has _meta, return as-is
    if (parsed._meta) {
      return parsed as CleoResponse<T>;
    }

    // If has success field, assume it's structured output
    if ('success' in parsed) {
      return {
        $schema: SCHEMA_URL_OUTPUT,
        _meta: {
          format: 'json',
          version: getCurrentVersion(),
          command,
          timestamp: generateTimestamp(),
          ...(session !== undefined && { session }),
        },
        ...parsed,
      };
    }

    // Otherwise, wrap raw data
    return formatSuccess(command, parsed as T, session);
  } catch (error) {
    // If not JSON, treat as error message
    return formatError(
      command,
      createError(
        'E_CLI_PARSE_ERROR',
        `Failed to parse CLI output: ${error instanceof Error ? error.message : String(error)}`,
        1,
        { context: { output: cliOutput } }
      ),
      session
    );
  }
}

/**
 * Convert CleoResponse to DomainResponse
 * Adapts CLI-style response format to MCP domain response format
 *
 * @param startTime - Optional start time (ms) for duration_ms calculation
 */
export function toDomainResponse<T>(
  cleoResponse: CleoResponse<T>,
  gateway: string,
  domain: string,
  operation: string,
  startTime?: number
): {
  _meta: {
    gateway: string;
    domain: string;
    operation: string;
    version: string;
    timestamp: string;
    duration_ms: number;
  };
  success: boolean;
  data?: T;
  error?: {
    code: string;
    exitCode?: number;
    message: string;
    details?: Record<string, unknown>;
    fix?: string;
    alternatives?: Array<{ action: string; command: string }>;
  };
} {
  return {
    _meta: {
      gateway,
      domain,
      operation,
      version: cleoResponse._meta.version,
      timestamp: cleoResponse._meta.timestamp,
      duration_ms: startTime !== undefined ? Date.now() - startTime : 0,
    },
    success: cleoResponse.success,
    ...(cleoResponse.data !== undefined && { data: cleoResponse.data }),
    ...(cleoResponse.error && { error: cleoResponse.error }),
  };
}

/**
 * Format successful domain response (for MCP domains)
 *
 * @param startTime - Optional start time (ms) for duration_ms calculation
 */
export function formatDomainSuccess<T>(
  gateway: string,
  domain: string,
  operation: string,
  data: T,
  startTime?: number
): {
  _meta: {
    gateway: string;
    domain: string;
    operation: string;
    version: string;
    timestamp: string;
    duration_ms: number;
  };
  success: boolean;
  data: T;
} {
  return {
    _meta: {
      gateway,
      domain,
      operation,
      version: getCurrentVersion(),
      timestamp: generateTimestamp(),
      duration_ms: startTime !== undefined ? Date.now() - startTime : 0,
    },
    success: true,
    data,
  };
}

/**
 * Format domain error response (for MCP domains)
 *
 * Per MCP-SERVER-SPECIFICATION Section 3.2, error responses MUST include:
 * code, exitCode, message, details, fix, alternatives
 *
 * @param startTime - Optional start time (ms) for duration_ms calculation
 */
export function formatDomainError(
  gateway: string,
  domain: string,
  operation: string,
  error: CleoError,
  startTime?: number
): {
  _meta: {
    gateway: string;
    domain: string;
    operation: string;
    version: string;
    timestamp: string;
    duration_ms: number;
  };
  success: false;
  error: {
    code: string;
    exitCode: number;
    message: string;
    details?: Record<string, unknown>;
    fix?: string;
    alternatives?: Array<{ action: string; command: string }>;
  };
} {
  return {
    _meta: {
      gateway,
      domain,
      operation,
      version: getCurrentVersion(),
      timestamp: generateTimestamp(),
      duration_ms: startTime !== undefined ? Date.now() - startTime : 0,
    },
    success: false,
    error: {
      code: error.code,
      exitCode: error.exitCode,
      message: error.message,
      ...(error.context && { details: error.context }),
      ...(error.fix && { fix: error.fix }),
      ...(error.alternatives && { alternatives: error.alternatives }),
    },
  };
}

/**
 * Format partial success domain response (for batch operations)
 *
 * Per MCP-SERVER-SPECIFICATION Section 3.3, partial success responses
 * have success=true, partial=true, and data with succeeded/failed arrays.
 *
 * @param startTime - Optional start time (ms) for duration_ms calculation
 */
export function formatPartialSuccess<TSucceeded = unknown, TFailed = unknown>(
  gateway: string,
  domain: string,
  operation: string,
  succeeded: TSucceeded[],
  failed: TFailed[],
  startTime?: number
): {
  _meta: {
    gateway: string;
    domain: string;
    operation: string;
    version: string;
    timestamp: string;
    duration_ms: number;
  };
  success: true;
  partial: true;
  data: {
    succeeded: TSucceeded[];
    failed: TFailed[];
  };
} {
  return {
    _meta: {
      gateway,
      domain,
      operation,
      version: getCurrentVersion(),
      timestamp: generateTimestamp(),
      duration_ms: startTime !== undefined ? Date.now() - startTime : 0,
    },
    success: true,
    partial: true,
    data: {
      succeeded,
      failed,
    },
  };
}
