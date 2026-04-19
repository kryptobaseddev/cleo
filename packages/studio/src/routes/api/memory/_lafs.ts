/**
 * Shared LAFS-envelope helpers for the /api/memory/* write surfaces.
 *
 * LAFS (Language-Aware Fix-Surface) is CLEO's canonical response
 * envelope — `{ success, data?, error?, meta }`. These helpers keep
 * the five memory-write endpoints (observe / decision-store / pattern-
 * store / learning-store / verify) perfectly aligned without duplicating
 * the shape logic.
 *
 * @task T990
 * @wave 1D
 */

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
  return {
    success: true,
    data,
    meta: { at: new Date().toISOString() },
  };
}

/** Build an error envelope. */
export function err(code: string, message: string): LafsErr {
  return {
    success: false,
    error: { code, message },
    meta: { at: new Date().toISOString() },
  };
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
 * `ParseError` carrier so callers can branch without try/catch.
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
  max = 10_000,
): { ok: true; value: string } | { ok: false; message: string } {
  const v = body[key];
  if (typeof v !== 'string') {
    return { ok: false, message: `Missing or non-string field: ${key}` };
  }
  if (v.trim().length < 1) {
    return { ok: false, message: `Field ${key} cannot be empty` };
  }
  if (v.length > max) {
    return { ok: false, message: `Field ${key} exceeds ${max} chars` };
  }
  return { ok: true, value: v };
}

/** Optional string field. */
export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Optional string array. */
export function optionalStringArray(
  body: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const v = body[key];
  if (!Array.isArray(v)) return undefined;
  const clean = v
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.trim());
  return clean.length > 0 ? clean : undefined;
}

/** Optional number in [0..1]. */
export function optionalUnit(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.max(0, Math.min(1, v));
}

/** Optional boolean. */
export function optionalBool(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key];
  if (typeof v !== 'boolean') return undefined;
  return v;
}

/** Generate a short id suffix. */
export function shortId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  }
  return Math.random().toString(36).slice(2, 14);
}
