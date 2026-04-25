/**
 * Shared base helpers for domain handlers.
 * DRY utility -- extracts the 4 common patterns found in all domain handlers.
 *
 * All functions are standalone (not a class) to match the function-based helper style.
 * Handlers call these instead of re-implementing wrapEngineResult, errorResponse, etc.
 *
 * @epic T5671
 * @task T1427 — typed param narrowing helpers (Wave D · T962)
 */

import type { ProblemDetails } from '@cleocode/core';
import type { DispatchResponse } from '../types.js';
import { dispatchMeta } from './_meta.js';

/**
 * Engine result shape accepted by wrapResult.
 * Matches the union of what all engine functions return.
 */
export interface EngineResult {
  success: boolean;
  data?: unknown;
  page?: import('@cleocode/lafs').LAFSPage;
  error?: {
    code: string;
    message: string;
    details?: unknown;
    exitCode?: number;
    fix?: string;
    alternatives?: Array<{ action: string; command: string }>;
    problemDetails?: ProblemDetails;
  };
}

/**
 * Wrap a native engine result into a DispatchResponse.
 * Handles success data, page metadata, and structured errors.
 */
export function wrapResult(
  result: EngineResult,
  gateway: string,
  domain: string,
  operation: string,
  startTime: number,
): DispatchResponse {
  return {
    meta: dispatchMeta(gateway, domain, operation, startTime),
    success: result.success,
    ...(result.success ? { data: result.data } : {}),
    ...(result.page ? { page: result.page } : {}),
    ...(result.error
      ? {
          error: {
            code: result.error.code,
            message: result.error.message,
            details: result.error.details as Record<string, unknown> | undefined,
            exitCode: result.error.exitCode,
            fix: result.error.fix,
            alternatives: result.error.alternatives,
            ...(result.error.problemDetails ? { problemDetails: result.error.problemDetails } : {}),
          },
        }
      : {}),
  };
}

/**
 * Return a standard error response.
 */
export function errorResult(
  gateway: string,
  domain: string,
  operation: string,
  code: string,
  message: string,
  startTime: number,
): DispatchResponse {
  return {
    meta: dispatchMeta(gateway, domain, operation, startTime),
    success: false,
    error: { code, message },
  };
}

/**
 * Return a standard "unsupported operation" error response.
 */
export function unsupportedOp(
  gateway: string,
  domain: string,
  operation: string,
  startTime: number,
): DispatchResponse {
  return {
    meta: dispatchMeta(gateway, domain, operation, startTime),
    success: false,
    error: { code: 'E_INVALID_OPERATION', message: `Unknown ${domain} ${gateway}: ${operation}` },
  };
}

/**
 * Extract limit and offset pagination params from a params dict.
 */
export function getListParams(params?: Record<string, unknown>): {
  limit?: number;
  offset?: number;
} {
  const limit = typeof params?.limit === 'number' && params.limit > 0 ? params.limit : undefined;
  const offset =
    typeof params?.offset === 'number' && params.offset > 0 ? params.offset : undefined;
  return { limit, offset };
}

// ---------------------------------------------------------------------------
// Param narrowing helpers (T1427 — typed-dispatch cast reduction)
//
// Replace `params?.x as string` call-site casts with these typed extractors.
// Each function narrows from `unknown` using a runtime typeof / Array.isArray
// check so the TypeScript compiler accepts the result without a cast at the
// handler call site.
// ---------------------------------------------------------------------------

/**
 * Extract a string param from a raw `Record<string, unknown>` params dict.
 *
 * @param params - Raw params object (may be undefined).
 * @param key    - Param key to extract.
 * @returns The string value, or `undefined` when absent or not a string.
 */
export function paramString(
  params: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const v = params?.[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Extract a required string param. Returns an empty string when missing so the
 * caller's `if (!value)` guard still fires naturally.
 *
 * @param params - Raw params object (may be undefined).
 * @param key    - Param key to extract.
 * @returns The string value, or `''` when absent or not a string.
 */
export function paramStringRequired(
  params: Record<string, unknown> | undefined,
  key: string,
): string {
  const v = params?.[key];
  return typeof v === 'string' ? v : '';
}

/**
 * Extract a number param from a raw `Record<string, unknown>` params dict.
 *
 * @param params - Raw params object (may be undefined).
 * @param key    - Param key to extract.
 * @returns The number value, or `undefined` when absent or not a number.
 */
export function paramNumber(
  params: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const v = params?.[key];
  return typeof v === 'number' ? v : undefined;
}

/**
 * Extract a boolean param from a raw `Record<string, unknown>` params dict.
 *
 * @param params - Raw params object (may be undefined).
 * @param key    - Param key to extract.
 * @returns The boolean value, or `undefined` when absent or not a boolean.
 */
export function paramBool(
  params: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const v = params?.[key];
  return typeof v === 'boolean' ? v : undefined;
}

/**
 * Extract a string-array param from a raw `Record<string, unknown>` params dict.
 *
 * @param params - Raw params object (may be undefined).
 * @param key    - Param key to extract.
 * @returns The string array, or `undefined` when absent or not an array.
 *
 * @remarks
 * Items are assumed to be strings; non-string array elements are filtered out.
 */
export function paramStringArray(
  params: Record<string, unknown> | undefined,
  key: string,
): string[] | undefined {
  const v = params?.[key];
  if (!Array.isArray(v)) return undefined;
  return v.filter((item): item is string => typeof item === 'string');
}

/**
 * Handle a caught error: extract message and return an internal error response.
 * Callers should log the error themselves (with their domain-specific logger)
 * before or after calling this.
 */
export function handleErrorResult(
  gateway: string,
  domain: string,
  operation: string,
  error: unknown,
  startTime: number,
): DispatchResponse {
  const message = error instanceof Error ? error.message : String(error);
  return {
    meta: dispatchMeta(gateway, domain, operation, startTime),
    success: false,
    error: { code: 'E_INTERNAL', message },
  };
}
