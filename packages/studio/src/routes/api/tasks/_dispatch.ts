/**
 * Shared server-side helpers for the interactive dispatcher board write paths
 * (T11928 drag→transition · T11930 dispatch→spawn).
 *
 * Provides the LAFS envelope helpers (aligned with the `/api/memory/_lafs.ts`
 * shape) plus the GATEWAY-SDK resolution + reachability fallback the board's
 * mutations route through.
 *
 * ## Why a fallback (gateway-first, core-direct fallback)
 *
 * The ratified North-Star path is "every surface mutates THROUGH the `/v1`
 * gateway SDK client" (T11920). That requires a running `cleo daemon serve`.
 * For Studio dev — and for any deployment where the daemon listener is not up —
 * requiring a live daemon to drag a card would make the board unusable. So the
 * drag write path tries the gateway client first (real `tasks.update` envelope
 * over `/v1`), and falls back to a direct in-process `@cleocode/core` engine
 * call (which produces the SAME mutation envelope — it is the engine the
 * gateway itself dispatches into, never a raw DB write or local state).
 *
 * Dispatch→spawn (T11930) is gateway-ONLY (no core fallback): spawning is real,
 * expensive, and provisions a worktree — it must go through the daemon's
 * orchestrate surface, so when the daemon is unreachable the route returns a
 * typed `E_GATEWAY_UNREACHABLE` the UI surfaces as "start the daemon" rather
 * than silently spawning in-process from a web request.
 *
 * @task T11928
 * @task T11930
 * @epic T11559
 */

import { createCleoClient } from '@cleocode/core/gateway-client';

/** Successful LAFS envelope. */
export interface LafsOk<T> {
  success: true;
  data: T;
  meta: { at: string };
}

/** Failed LAFS envelope. */
export interface LafsErr {
  success: false;
  error: { code: string; message: string };
  meta: { at: string };
}

/** Build an ok envelope. */
export function ok<T>(data: T): LafsOk<T> {
  return { success: true, data, meta: { at: new Date().toISOString() } };
}

/** Build an error envelope. */
export function err(code: string, message: string): LafsErr {
  return { success: false, error: { code, message }, meta: { at: new Date().toISOString() } };
}

/** Tagged parse-failure carrier. */
export interface ParseError {
  /** Human-readable reason the JSON body failed to parse or narrow. */
  _parseError: string;
}

/** Type guard: was a parse error returned? */
export function isParseError(v: Record<string, unknown> | ParseError): v is ParseError {
  return '_parseError' in v && typeof v._parseError === 'string';
}

/**
 * Parse a JSON body defensively. Returns the parsed value or a tagged
 * {@link ParseError} carrier so callers can branch without try/catch.
 *
 * @param request - The incoming request.
 * @returns The parsed object or a parse-error carrier.
 */
export async function parseJsonBody(
  request: Request,
): Promise<Record<string, unknown> | ParseError> {
  try {
    const body = await request.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return { _parseError: 'Request body must be a JSON object' };
    }
    return body as Record<string, unknown>;
  } catch {
    return { _parseError: 'Invalid JSON body' };
  }
}

/** Require a non-empty string field. */
export function requireString(
  body: Record<string, unknown>,
  key: string,
  max = 2000,
): { ok: true; value: string } | { ok: false; message: string } {
  const v = body[key];
  if (typeof v !== 'string') return { ok: false, message: `Missing or non-string field: ${key}` };
  if (v.trim().length < 1) return { ok: false, message: `Field ${key} cannot be empty` };
  if (v.length > max) return { ok: false, message: `Field ${key} exceeds ${max} chars` };
  return { ok: true, value: v.trim() };
}

/** Optional string field. */
export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the base URL of the `/v1` gateway the daemon serves.
 *
 * Reads `CLEO_GATEWAY_URL` (set by the operator / supervisor) and falls back to
 * the canonical loopback default. Never embeds a credential — auth, if any, is
 * a header the caller injects at request time.
 *
 * @returns The gateway base URL (no trailing slash).
 */
export function resolveGatewayBaseUrl(): string {
  const fromEnv = process.env.CLEO_GATEWAY_URL?.trim();
  return (fromEnv && fromEnv.length > 0 ? fromEnv : 'http://127.0.0.1:7421').replace(/\/+$/, '');
}

/**
 * Build a gateway SDK client pointed at the resolved daemon `/v1` base URL.
 *
 * @returns A {@link import('@cleocode/core/gateway-client').CleoClient}.
 */
export function gatewayClient(): ReturnType<typeof createCleoClient> {
  return createCleoClient({ baseUrl: resolveGatewayBaseUrl() });
}

/**
 * Is an error one raised because the gateway daemon is not listening (so a
 * gateway-only operation should surface `E_GATEWAY_UNREACHABLE`, and a
 * fallback-capable operation should fall back to core)?
 *
 * Node's fetch raises a `TypeError` with a `cause` of `ECONNREFUSED` /
 * `ENOTFOUND` / `EAI_AGAIN` when the listener is down.
 *
 * @param e - The thrown value.
 * @returns `true` when the failure looks like an unreachable listener.
 */
export function isGatewayUnreachable(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const cause = (e as { cause?: unknown }).cause;
  const code =
    cause && typeof cause === 'object' && 'code' in cause
      ? String((cause as { code: unknown }).code)
      : '';
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return true;
  }
  return /fetch failed|ECONNREFUSED|ENOTFOUND|network|connect/i.test(e.message);
}
