/**
 * Security Hardening and Input Sanitization
 *
 * Canonical location for dispatch layer security utilities.
 * Copied from src/mcp/lib/security.ts (self-contained, no MCP dependencies).
 *
 * @task T3144
 * @epic T3125
 */

import { resolve, normalize, relative, isAbsolute } from 'path';
import {
  TASK_PRIORITIES,
} from '../../store/schema.js';
import {
  TASK_STATUSES,
  MANIFEST_STATUSES,
  LIFECYCLE_STAGE_STATUSES,
} from '../../store/status-registry.js';

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
 */
export function sanitizeTaskId(id: string): string {
  if (typeof id !== 'string') {
    throw new SecurityError(
      'Task ID must be a string',
      'E_INVALID_TASK_ID',
      'taskId'
    );
  }

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

  if (trimmedPath.includes('\0')) {
    throw new SecurityError(
      'Path contains null bytes',
      'E_PATH_TRAVERSAL',
      'path'
    );
  }

  const normalizedRoot = resolve(projectRoot);

  let resolvedPath: string;
  if (isAbsolute(trimmedPath)) {
    resolvedPath = normalize(trimmedPath);
  } else {
    resolvedPath = resolve(normalizedRoot, trimmedPath);
  }

  const relativePath = relative(normalizedRoot, resolvedPath);

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

  return content.replace(CONTROL_CHAR_PATTERN, '');
}

/**
 * Validate that a value is in an allowed enum set
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

export const VALID_MANIFEST_STATUSES = MANIFEST_STATUSES;

export const VALID_LIFECYCLE_STAGE_STATUSES = LIFECYCLE_STAGE_STATUSES;

export const ALL_VALID_STATUSES = [...TASK_STATUSES, ...MANIFEST_STATUSES] as const;

export const VALID_PRIORITIES = TASK_PRIORITIES;

/**
 * Rate limiter configuration
 */
export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

/**
 * Rate limit check result
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
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
 */
export class RateLimiter {
  private windows: Map<string, number[]> = new Map();
  private configs: Map<string, RateLimitConfig> = new Map();

  constructor(configs?: Record<string, RateLimitConfig>) {
    const effectiveConfigs = configs ?? DEFAULT_RATE_LIMITS;
    for (const [key, config] of Object.entries(effectiveConfigs)) {
      this.configs.set(key, config);
    }
  }

  check(key: string): RateLimitResult {
    const config = this.configs.get(key);
    if (!config) {
      return { allowed: true, remaining: Infinity, resetMs: 0, limit: Infinity };
    }

    const now = Date.now();
    const windowStart = now - config.windowMs;

    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }

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

  record(key: string): void {
    const timestamps = this.windows.get(key) ?? [];
    timestamps.push(Date.now());
    this.windows.set(key, timestamps);
  }

  consume(key: string): RateLimitResult {
    const result = this.check(key);
    if (result.allowed) {
      this.record(key);
      result.remaining = Math.max(0, result.remaining - 1);
    }
    return result;
  }

  reset(key?: string): void {
    if (key) {
      this.windows.delete(key);
    } else {
      this.windows.clear();
    }
  }

  getConfig(key: string): RateLimitConfig | undefined {
    return this.configs.get(key);
  }

  setConfig(key: string, config: RateLimitConfig): void {
    this.configs.set(key, config);
  }
}

/**
 * Sanitize all params in a request before routing
 */
export function sanitizeParams(
  params: Record<string, unknown> | undefined,
  projectRoot?: string,
  context?: { domain?: string; operation?: string },
): Record<string, unknown> | undefined {
  if (!params) {
    return params;
  }

  const sanitized: Record<string, unknown> = { ...params };

  for (const [key, value] of Object.entries(sanitized)) {
    if (value === undefined || value === null) {
      continue;
    }

    if (
      typeof value === 'string' &&
      (key === 'taskId' || key === 'parent' || key === 'epicId')
    ) {
      if (key === 'parent' && value === '') {
        continue;
      }
      sanitized[key] = sanitizeTaskId(value);
      continue;
    }

    if (key === 'depends' && Array.isArray(value)) {
      sanitized[key] = value.map((v) => {
        if (typeof v === 'string') {
          return sanitizeTaskId(v);
        }
        return v;
      });
      continue;
    }

    if (
      typeof value === 'string' &&
      (key === 'path' || key === 'file') &&
      projectRoot
    ) {
      sanitized[key] = sanitizePath(value, projectRoot);
      continue;
    }

    if (
      typeof value === 'string' &&
      (key === 'title' || key === 'description' || key === 'content')
    ) {
      const maxLen = key === 'title' ? 200 : DEFAULT_MAX_CONTENT_LENGTH;
      sanitized[key] = sanitizeContent(value, maxLen);
      continue;
    }

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

    if (typeof value === 'string' && key === 'status') {
      const isLifecycleStageStatus =
        context?.domain === 'pipeline' && context?.operation === 'stage.record';
      const isAdrStatus =
        context?.domain === 'admin' && context?.operation?.startsWith('adr.');

      sanitized[key] = validateEnum(
        value,
        isLifecycleStageStatus
          ? [...LIFECYCLE_STAGE_STATUSES]
          : isAdrStatus
          ? ['proposed', 'accepted', 'superseded', 'deprecated']
          : [...TASK_STATUSES, ...MANIFEST_STATUSES],
        'status',
      );
      continue;
    }

    if (typeof value === 'string' && key === 'priority') {
      sanitized[key] = validateEnum(value, [...VALID_PRIORITIES], 'priority');
      continue;
    }
  }

  return sanitized;
}
