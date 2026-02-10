/**
 * CLI Executor Wrapper
 *
 * Executes CLEO CLI commands safely with timeout handling, retry logic,
 * and proper error parsing. Captures stdout, stderr, and exit codes.
 *
 * @task T2914
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { buildCLICommand } from './command-builder.js';
import { isRetryableError, ErrorCode } from '../types/index.js';

const execAsync = promisify(exec);

/**
 * Execution options
 */
export interface ExecutorOptions {
  /** CLI command domain */
  domain: string;

  /** Operation to perform */
  operation: string;

  /** Positional arguments */
  args?: Array<string | number>;

  /** Named flags/options */
  flags?: Record<string, unknown>;

  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;

  /** Maximum retry attempts (default: 3) */
  maxRetries?: number;

  /** Session ID to bind to */
  sessionId?: string;

  /** Working directory (default: process.cwd()) */
  cwd?: string;

  /** Custom command to execute instead of building from domain/operation */
  customCommand?: string;
}

/**
 * Execution result
 */
export interface ExecutorResult<T = unknown> {
  /** Whether execution succeeded */
  success: boolean;

  /** Parsed JSON data (if success=true) */
  data?: T;

  /** Error details (if success=false) */
  error?: {
    code: string;
    exitCode?: number;
    message: string;
    details?: unknown;
    fix?: string;
    alternatives?: Array<{
      action: string;
      command: string;
    }>;
  };

  /** Exit code from CLI */
  exitCode: number;

  /** Raw stdout */
  stdout: string;

  /** Raw stderr */
  stderr: string;

  /** Execution duration in milliseconds */
  duration: number;
}

/**
 * CLI executor class
 */
export class CLIExecutor {
  constructor(
    private cliPath: string,
    private defaultTimeout: number = 30000,
    private defaultMaxRetries: number = 3
  ) {}

  /**
   * Execute CLI command with retry logic
   */
  async execute<T = unknown>(options: ExecutorOptions): Promise<ExecutorResult<T>> {
    const maxRetries = options.maxRetries ?? this.defaultMaxRetries;
    let lastError: ExecutorResult<T> | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const result = await this.executeOnce<T>(options, attempt);

      // Success - return immediately
      if (result.success) {
        return result;
      }

      // Non-retryable error - return immediately
      if (!this.shouldRetry(result.exitCode, attempt, maxRetries)) {
        return result;
      }

      // Store error for potential final return
      lastError = result;

      // Exponential backoff: 2^attempt seconds
      const backoffMs = Math.pow(2, attempt) * 1000;
      await this.sleep(backoffMs);
    }

    // All retries exhausted
    return lastError!;
  }

  /**
   * Execute CLI command once (no retry)
   */
  private async executeOnce<T = unknown>(
    options: ExecutorOptions,
    attempt: number
  ): Promise<ExecutorResult<T>> {
    const startTime = Date.now();
    const timeout = options.timeout ?? this.defaultTimeout;

    try {
      // Build command
      const command = this.buildCommand(options);

      // Prepare environment
      const env = this.buildEnvironment(options);

      // Execute with timeout
      const { stdout, stderr } = await execAsync(command, {
        timeout,
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, ...env },
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });

      const duration = Date.now() - startTime;

      // Parse output
      return this.parseOutput<T>(stdout, stderr, 0, duration);
    } catch (error: any) {
      const duration = Date.now() - startTime;

      // Handle exec errors (exit code, timeout, etc.)
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return {
          success: false,
          error: {
            code: 'E_OUTPUT_TOO_LARGE',
            message: 'Command output exceeded buffer size',
            fix: 'Add --limit flag to reduce output size',
          },
          exitCode: 1,
          stdout: error.stdout || '',
          stderr: error.stderr || '',
          duration,
        };
      }

      if (error.killed) {
        return {
          success: false,
          error: {
            code: 'E_TIMEOUT',
            message: `Command timed out after ${timeout}ms`,
            fix: `Increase timeout or optimize query`,
          },
          exitCode: 124,
          stdout: error.stdout || '',
          stderr: error.stderr || '',
          duration,
        };
      }

      // Command executed but returned non-zero exit code
      const exitCode = error.code || 1;
      return this.parseOutput<T>(
        error.stdout || '',
        error.stderr || '',
        exitCode,
        duration
      );
    }
  }

  /**
   * Build CLI command string
   */
  private buildCommand(options: ExecutorOptions): string {
    // If customCommand is provided, use it directly
    if (options.customCommand) {
      return options.customCommand;
    }

    // Otherwise build from domain/operation
    return buildCLICommand(
      this.cliPath,
      options.domain,
      options.operation,
      options.args || [],
      options.flags || {}
    );
  }

  /**
   * Build environment variables
   */
  private buildEnvironment(options: ExecutorOptions): Record<string, string> {
    const env: Record<string, string> = {};

    // Bind to session if specified
    if (options.sessionId) {
      env.CLEO_SESSION = options.sessionId;
    }

    return env;
  }

  /**
   * Parse command output
   */
  private parseOutput<T = unknown>(
    stdout: string,
    stderr: string,
    exitCode: number,
    duration: number
  ): ExecutorResult<T> {
    // Try to parse stdout as JSON, fall back to stderr if stdout is empty
    // Some CLI commands (e.g., orchestrator context) output JSON to stderr
    // with non-zero exit codes that still contain success:true
    const rawOutput = stdout.trim() || stderr.trim();
    try {
      const trimmed = rawOutput;
      if (!trimmed) {
        // Empty output with zero exit = success
        if (exitCode === 0) {
          return {
            success: true,
            data: undefined as T,
            exitCode,
            stdout,
            stderr,
            duration,
          };
        }

        // Empty output with non-zero exit = error
        return {
          success: false,
          error: {
            code: 'E_UNKNOWN',
            exitCode,
            message: stderr.trim() || 'Command failed with no output',
          },
          exitCode,
          stdout,
          stderr,
          duration,
        };
      }

      const parsed = JSON.parse(trimmed);

      // CLI returned structured JSON response
      if (typeof parsed === 'object' && parsed !== null) {
        // Check for success field
        if ('success' in parsed) {
          if (parsed.success === true) {
            // Extract payload data from CLI response.
            // CLEO CLI returns payload fields directly on the response object
            // (e.g., "task", "tasks", "session", "sessionId") rather than
            // wrapping them in a "data" field. Extract by removing envelope fields.
            let data: T;
            if (parsed.data !== undefined) {
              data = parsed.data as T;
            } else {
              // CLEO CLI returns payload fields at the top level rather than
              // wrapping in a "data" field. Look for well-known primary payload
              // fields and unwrap them, falling back to the full parsed object.
              const primaryPayloadFields = [
                'task', 'tasks', 'session', 'sessions', 'matches',
                'result', 'focus', 'entries', 'stages', 'summary',
              ];
              const found = primaryPayloadFields.find(
                (f) => parsed[f] !== undefined
              );
              if (found) {
                data = parsed[found] as T;
              } else {
                // No recognized primary field - strip standard envelope
                // and return remaining fields as data
                const envelope = new Set([
                  '$schema', '_meta', 'success', 'error', 'warnings',
                ]);
                const payload: Record<string, unknown> = {};
                for (const [key, value] of Object.entries(parsed)) {
                  if (!envelope.has(key)) {
                    payload[key] = value;
                  }
                }
                const payloadKeys = Object.keys(payload);
                if (payloadKeys.length === 1) {
                  data = payload[payloadKeys[0]] as T;
                } else if (payloadKeys.length === 0) {
                  data = parsed as T;
                } else {
                  data = payload as T;
                }
              }
            }

            return {
              success: true,
              data,
              exitCode,
              stdout,
              stderr,
              duration,
            };
          }

          // Structured error response
          return {
            success: false,
            error: {
              code: parsed.error?.code || 'E_UNKNOWN',
              exitCode: parsed.error?.exitCode || exitCode,
              message: parsed.error?.message || 'Command failed',
              details: parsed.error?.details,
              fix: parsed.error?.fix,
              alternatives: parsed.error?.alternatives,
            },
            exitCode,
            stdout,
            stderr,
            duration,
          };
        }

        // JSON without success field - treat as data
        return {
          success: exitCode === 0,
          data: parsed as T,
          exitCode,
          stdout,
          stderr,
          duration,
        };
      }
    } catch (parseError) {
      // Not valid JSON - treat as plain text
      if (exitCode === 0) {
        // Success with non-JSON output
        return {
          success: true,
          data: stdout.trim() as T,
          exitCode,
          stdout,
          stderr,
          duration,
        };
      }

      // Error with non-JSON output
      return {
        success: false,
        error: {
          code: 'E_UNKNOWN',
          exitCode,
          message: stderr.trim() || stdout.trim() || 'Command failed',
        },
        exitCode,
        stdout,
        stderr,
        duration,
      };
    }

    // Shouldn't reach here, but TypeScript needs it
    return {
      success: false,
      error: {
        code: 'E_UNKNOWN',
        exitCode,
        message: 'Unexpected execution result',
      },
      exitCode,
      stdout,
      stderr,
      duration,
    };
  }

  /**
   * Determine if error is retryable
   */
  private shouldRetry(exitCode: number, attempt: number, maxRetries: number): boolean {
    // Max retries exhausted
    if (attempt >= maxRetries) {
      return false;
    }

    // Check if error code is retryable
    return isRetryableError(exitCode as ErrorCode);
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get CLI version
   */
  async getVersion(): Promise<string> {
    const result = await this.execute<{ version: string }>({
      domain: 'system',
      operation: 'version',
      customCommand: `${this.cliPath} version --json`,
      maxRetries: 1,
    });

    if (result.success) {
      // Try data field first (already parsed by execute)
      if (result.data && typeof result.data === 'object' && 'version' in result.data) {
        return (result.data as { version: string }).version;
      }

      // Fallback: parse version from raw stdout JSON
      try {
        const parsed = JSON.parse(result.stdout.trim());
        if (parsed.version) {
          return parsed.version;
        }
        if (parsed.data?.version) {
          return parsed.data.version;
        }
      } catch (e) {
        // Not valid JSON, continue to error
      }
    }

    throw new Error(`Failed to get CLI version: ${result.error?.message || 'Unknown error'}`);
  }

  /**
   * Test CLI connection
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.getVersion();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Create executor instance from config
 */
export function createExecutor(
  cliPath: string,
  timeout?: number,
  maxRetries?: number
): CLIExecutor {
  return new CLIExecutor(cliPath, timeout, maxRetries);
}
