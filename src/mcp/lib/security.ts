/**
 * Security Hardening and Input Sanitization for CLEO MCP Server
 *
 * Provides input validation, path sanitization, content filtering,
 * enum checking, and rate limiting for all MCP operations.
 *
 * @task T3144
 * @epic T3125
 */

import { resolve, normalize, relative, isAbsolute } from 'path';

/**
 * Security validation error thrown when input fails sanitization
 */
export class SecurityError extends Error {
  constructor(
    message: string,
    public code: string = 'E_SECURITY_VIOLATION',
    public field?: string
  ) {
    super(message);
    this.name = 'SecurityError';
  }
}

/**
 * Task ID pattern: T followed by one or more digits
 */
const TASK_ID_PATTERN = /^T[0-9]+$/;

/**
 * Maximum task ID numeric value (prevent absurdly large IDs)
 */
const MAX_TASK_ID_NUMBER = 999999;

/**
 * Control character pattern (C0 and C1 control chars, excluding newline/tab/cr)
 */
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

/**
 * Default maximum content length (64KB)
 */
const DEFAULT_MAX_CONTENT_LENGTH = 64 * 1024;

/**
 * Sanitize and validate a task ID
 *
 * Validates format: ^T[0-9]+$
 * Rejects empty, malformed, or excessively large IDs
 *
 * @param id - Raw task ID input
 * @returns Sanitized task ID
 * @throws SecurityError if ID is invalid
 */
export function sanitizeTaskId(id: string): string {
  if (typeof id !== 'string') {
    throw new SecurityError(
      'Task ID must be a string',
      'E_INVALID_TASK_ID',
      'taskId'
    );
  }

  // Trim whitespace
  const trimmed = id.trim();

  if (trimmed.length === 0) {
    throw new SecurityError(
      'Task ID cannot be empty',
      'E_INVALID_TASK_ID',
      'taskId'
    );
  }

  if (!TASK_ID_PATTERN.test(trimmed)) {
    throw new SecurityError(
      `Invalid task ID format: "${trimmed}". Must match pattern T[0-9]+ (e.g., T123)`,
      'E_INVALID_TASK_ID',
      'taskId'
    );
  }

  // Check numeric portion isn't absurdly large
  const numericPart = parseInt(trimmed.slice(1), 10);
  if (numericPart > MAX_TASK_ID_NUMBER) {
    throw new SecurityError(
      `Task ID numeric value exceeds maximum (${MAX_TASK_ID_NUMBER}): ${trimmed}`,
      'E_INVALID_TASK_ID',
      'taskId'
    );
  }

  return trimmed;
}

/**
 * Sanitize and validate a file path
 *
 * Prevents path traversal attacks by ensuring the resolved path
 * stays within the project root directory.
 *
 * @param path - Raw path input
 * @param projectRoot - Project root directory (absolute path)
 * @returns Sanitized absolute path within project root
 * @throws SecurityError if path escapes project root or is invalid
 */
export function sanitizePath(path: string, projectRoot: string): string {
  if (typeof path !== 'string') {
    throw new SecurityError(
      'Path must be a string',
      'E_INVALID_PATH',
      'path'
    );
  }

  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new SecurityError(
      'Project root must be a non-empty string',
      'E_INVALID_PATH',
      'projectRoot'
    );
  }

  const trimmedPath = path.trim();

  if (trimmedPath.length === 0) {
    throw new SecurityError(
      'Path cannot be empty',
      'E_INVALID_PATH',
      'path'
    );
  }

  // Check for null bytes (common injection vector)
  if (trimmedPath.includes('\0')) {
    throw new SecurityError(
      'Path contains null bytes',
      'E_PATH_TRAVERSAL',
      'path'
    );
  }

  // Normalize the project root
  const normalizedRoot = resolve(projectRoot);

  // Resolve the path relative to project root
  let resolvedPath: string;
  if (isAbsolute(trimmedPath)) {
    resolvedPath = normalize(trimmedPath);
  } else {
    resolvedPath = resolve(normalizedRoot, trimmedPath);
  }

  // Ensure the resolved path is within the project root
  const relativePath = relative(normalizedRoot, resolvedPath);

  // If relative path starts with '..' or is absolute, it escapes the root
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new SecurityError(
      `Path traversal detected: "${path}" resolves outside project root`,
      'E_PATH_TRAVERSAL',
      'path'
    );
  }

  return resolvedPath;
}

/**
 * Sanitize content string
 *
 * Enforces size limits and strips control characters (except newline, tab, CR).
 *
 * @param content - Raw content string
 * @param maxLength - Maximum allowed length (default: 64KB)
 * @returns Sanitized content string
 * @throws SecurityError if content exceeds size limit
 */
export function sanitizeContent(
  content: string,
  maxLength: number = DEFAULT_MAX_CONTENT_LENGTH
): string {
  if (typeof content !== 'string') {
    throw new SecurityError(
      'Content must be a string',
      'E_INVALID_CONTENT',
      'content'
    );
  }

  if (content.length > maxLength) {
    throw new SecurityError(
      `Content exceeds maximum length (${maxLength} characters): got ${content.length}`,
      'E_CONTENT_TOO_LARGE',
      'content'
    );
  }

  // Strip control characters (preserve \n, \t, \r)
  return content.replace(CONTROL_CHAR_PATTERN, '');
}

/**
 * Validate that a value is in an allowed enum set
 *
 * @param value - Value to validate
 * @param allowed - Array of allowed values
 * @param fieldName - Name of the field (for error messages)
 * @returns The validated value
 * @throws SecurityError if value is not in allowed set
 */
export function validateEnum(
  value: string,
  allowed: string[],
  fieldName: string
): string {
  if (typeof value !== 'string') {
    throw new SecurityError(
      `${fieldName} must be a string`,
      'E_INVALID_ENUM',
      fieldName
    );
  }

  const trimmed = value.trim();

  if (!allowed.includes(trimmed)) {
    throw new SecurityError(
      `Invalid ${fieldName}: "${trimmed}". Allowed values: ${allowed.join(', ')}`,
      'E_INVALID_ENUM',
      fieldName
    );
  }

  return trimmed;
}

/**
 * Known enum values for CLEO domains
 */
export const VALID_DOMAINS = [
  'tasks', 'session', 'orchestrate', 'research',
  'lifecycle', 'validate', 'release', 'system',
] as const;

export const VALID_GATEWAYS = ['cleo_query', 'cleo_mutate'] as const;

export const VALID_STATUSES = ['pending', 'active', 'blocked', 'done'] as const;

export const VALID_MANIFEST_STATUSES = ['complete', 'partial', 'blocked'] as const;

export const ALL_VALID_STATUSES = [...VALID_STATUSES, 'complete', 'partial'] as const;

export const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;

/**
 * Rate limiter configuration
 */
export interface RateLimitConfig {
  /** Maximum requests allowed in the window */
  maxRequests: number;
  /** Time window in milliseconds */
  windowMs: number;
}

/**
 * Rate limit check result
 */
export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Remaining requests in current window */
  remaining: number;
  /** Milliseconds until window resets */
  resetMs: number;
  /** Total limit for the window */
  limit: number;
}

/**
 * Default rate limit configurations per operation type
 */
export const DEFAULT_RATE_LIMITS: Record<string, RateLimitConfig> = {
  query: { maxRequests: 100, windowMs: 60_000 },
  mutate: { maxRequests: 30, windowMs: 60_000 },
  spawn: { maxRequests: 10, windowMs: 60_000 },
};

/**
 * In-memory sliding window rate limiter
 *
 * Tracks request timestamps per key and enforces configurable limits.
 */
export class RateLimiter {
  private windows: Map<string, number[]> = new Map();
  private configs: Map<string, RateLimitConfig> = new Map();

  constructor(configs?: Record<string, RateLimitConfig>) {
    // Initialize with provided or default configs
    const effectiveConfigs = configs ?? DEFAULT_RATE_LIMITS;
    for (const [key, config] of Object.entries(effectiveConfigs)) {
      this.configs.set(key, config);
    }
  }

  /**
   * Check if a request is allowed under rate limits
   *
   * @param key - Rate limit bucket key (e.g., 'query', 'mutate', 'spawn')
   * @returns Rate limit check result
   */
  check(key: string): RateLimitResult {
    const config = this.configs.get(key);
    if (!config) {
      // No config for this key - allow by default
      return { allowed: true, remaining: Infinity, resetMs: 0, limit: Infinity };
    }

    const now = Date.now();
    const windowStart = now - config.windowMs;

    // Get or create window
    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }

    // Prune expired timestamps
    const validTimestamps = timestamps.filter(t => t > windowStart);
    this.windows.set(key, validTimestamps);

    const remaining = Math.max(0, config.maxRequests - validTimestamps.length);
    const oldestInWindow = validTimestamps.length > 0 ? validTimestamps[0] : now;
    const resetMs = Math.max(0, oldestInWindow + config.windowMs - now);

    return {
      allowed: validTimestamps.length < config.maxRequests,
      remaining,
      resetMs,
      limit: config.maxRequests,
    };
  }

  /**
   * Record a request (call after check returns allowed: true)
   *
   * @param key - Rate limit bucket key
   */
  record(key: string): void {
    const timestamps = this.windows.get(key) ?? [];
    timestamps.push(Date.now());
    this.windows.set(key, timestamps);
  }

  /**
   * Check and record in one step
   *
   * @param key - Rate limit bucket key
   * @returns Rate limit check result (recorded if allowed)
   */
  consume(key: string): RateLimitResult {
    const result = this.check(key);
    if (result.allowed) {
      this.record(key);
      // Adjust remaining after recording
      result.remaining = Math.max(0, result.remaining - 1);
    }
    return result;
  }

  /**
   * Reset rate limit state for a specific key or all keys
   *
   * @param key - Optional key to reset (resets all if omitted)
   */
  reset(key?: string): void {
    if (key) {
      this.windows.delete(key);
    } else {
      this.windows.clear();
    }
  }

  /**
   * Get current configuration for a key
   */
  getConfig(key: string): RateLimitConfig | undefined {
    return this.configs.get(key);
  }

  /**
   * Update configuration for a key
   */
  setConfig(key: string, config: RateLimitConfig): void {
    this.configs.set(key, config);
  }
}

/**
 * Sanitize all params in a DomainRequest before routing
 *
 * Applies appropriate sanitization based on known field names:
 * - taskId, parent, epicId -> sanitizeTaskId
 * - path, file -> sanitizePath (if projectRoot provided)
 * - title, description, notes, content -> sanitizeContent
 * - status -> validateEnum(VALID_STATUSES)
 * - priority -> validateEnum(VALID_PRIORITIES)
 * - domain -> validateEnum(VALID_DOMAINS)
 *
 * @param params - Raw request parameters
 * @param projectRoot - Project root for path sanitization
 * @returns Sanitized parameters
 * @throws SecurityError on validation failure
 */
export function sanitizeParams(
  params: Record<string, unknown> | undefined,
  projectRoot?: string
): Record<string, unknown> | undefined {
  if (!params) {
    return params;
  }

  const sanitized: Record<string, unknown> = { ...params };

  for (const [key, value] of Object.entries(sanitized)) {
    if (value === undefined || value === null) {
      continue;
    }

    // Task ID fields
    if (
      typeof value === 'string' &&
      (key === 'taskId' || key === 'parent' || key === 'epicId')
    ) {
      sanitized[key] = sanitizeTaskId(value);
      continue;
    }

    // Task ID arrays (depends)
    if (key === 'depends' && Array.isArray(value)) {
      sanitized[key] = value.map((v) => {
        if (typeof v === 'string') {
          return sanitizeTaskId(v);
        }
        return v;
      });
      continue;
    }

    // Path fields
    if (
      typeof value === 'string' &&
      (key === 'path' || key === 'file') &&
      projectRoot
    ) {
      sanitized[key] = sanitizePath(value, projectRoot);
      continue;
    }

    // Content fields (with size limits)
    if (
      typeof value === 'string' &&
      (key === 'title' || key === 'description' || key === 'content')
    ) {
      const maxLen = key === 'title' ? 200 : DEFAULT_MAX_CONTENT_LENGTH;
      sanitized[key] = sanitizeContent(value, maxLen);
      continue;
    }

    // Notes can be string or array of strings
    if (key === 'notes') {
      if (typeof value === 'string') {
        sanitized[key] = sanitizeContent(value);
      } else if (Array.isArray(value)) {
        sanitized[key] = value.map((v) =>
          typeof v === 'string' ? sanitizeContent(v) : v
        );
      }
      continue;
    }

    // Status enum - accept both task statuses and manifest statuses
    if (typeof value === 'string' && key === 'status') {
      sanitized[key] = validateEnum(value, [...ALL_VALID_STATUSES], 'status');
      continue;
    }

    // Priority enum
    if (typeof value === 'string' && key === 'priority') {
      sanitized[key] = validateEnum(value, [...VALID_PRIORITIES], 'priority');
      continue;
    }
  }

  return sanitized;
}
