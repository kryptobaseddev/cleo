/**
 * Idempotency middleware for mutating dispatch operations.
 *
 * The middleware uses `audit_log` as the persistence ledger: a successful
 * response produced with an idempotency key is written by the audit middleware,
 * and future retries with the same domain/operation/key return the stored
 * response instead of executing the mutating handler again.
 */

import { resolve } from '../registry.js';
import type { DispatchNext, DispatchRequest, DispatchResponse, Middleware } from '../types.js';

interface PersistedIdempotentResponse {
  success: boolean;
  data?: unknown;
  page?: DispatchResponse['page'];
  partial?: boolean;
  error?: DispatchResponse['error'];
}

type IdempotencyLookupResult =
  | { kind: 'miss' }
  | { kind: 'hit'; response: PersistedIdempotentResponse }
  | { kind: 'conflict' };

function getIdempotencyKey(params?: Record<string, unknown>): string | undefined {
  const value = params?.['idempotencyKey'];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asStoredResponse(value: unknown): PersistedIdempotentResponse | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { success?: unknown };
  if (typeof candidate.success !== 'boolean') return null;
  return value as PersistedIdempotentResponse;
}

function stripIdempotencyKey(params: unknown): unknown {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
  const clone = { ...(params as Record<string, unknown>) };
  delete clone['idempotencyKey'];
  return clone;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableJson(val)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameRequestParams(
  currentParams: Record<string, unknown> | undefined,
  persistedJson: string,
): boolean {
  try {
    const persisted = JSON.parse(persistedJson) as unknown;
    return (
      stableJson(stripIdempotencyKey(currentParams ?? {})) ===
      stableJson(stripIdempotencyKey(persisted))
    );
  } catch {
    return false;
  }
}

async function findPersistedResponse(
  req: DispatchRequest,
  idempotencyKey: string,
): Promise<IdempotencyLookupResult> {
  try {
    const { getDb, getNativeDb, getProjectInfoSync } = await import('@cleocode/core/internal');

    let projectHash: string | null = null;
    try {
      projectHash = getProjectInfoSync()?.projectHash ?? null;
    } catch {
      projectHash = null;
    }

    if (!projectHash) return { kind: 'miss' };

    await getDb(process.cwd());
    const db = getNativeDb();
    if (!db) return { kind: 'miss' };

    const values = [req.domain, req.operation, idempotencyKey, projectHash];
    const rows = db
      .prepare(
        `SELECT after_json AS afterJson, details_json AS detailsJson
         FROM audit_log
         WHERE domain = ?
           AND operation = ?
           AND idempotency_key = ?
           AND success = 1
           AND project_hash = ?
         ORDER BY timestamp DESC
         LIMIT 1`,
      )
      .all(...values) as Array<{ afterJson: string | null; detailsJson: string | null }>;

    const row = rows[0];
    if (!row?.afterJson) return { kind: 'miss' };
    if (!row.detailsJson || !sameRequestParams(req.params, row.detailsJson)) {
      return { kind: 'conflict' };
    }
    const response = asStoredResponse(JSON.parse(row.afterJson));
    return response ? { kind: 'hit', response } : { kind: 'miss' };
  } catch {
    return { kind: 'miss' };
  }
}

/**
 * Create middleware that short-circuits duplicate idempotent mutate requests.
 *
 * @returns Dispatch middleware that returns persisted success responses for
 * duplicate `(project, domain, operation, idempotencyKey)` tuples.
 */
export function createIdempotency(): Middleware {
  return async (req: DispatchRequest, next: DispatchNext): Promise<DispatchResponse> => {
    if (req.gateway !== 'mutate') return next();

    const resolved = resolve(req.gateway, req.domain, req.operation);
    if (!resolved?.def.idempotent) return next();

    const idempotencyKey = getIdempotencyKey(req.params);
    if (!idempotencyKey) return next();

    const lookup = await findPersistedResponse(req, idempotencyKey);
    if (lookup.kind === 'miss') return next();

    if (lookup.kind === 'conflict') {
      return {
        meta: {
          gateway: req.gateway,
          domain: req.domain,
          operation: req.operation,
          timestamp: new Date().toISOString(),
          duration_ms: 0,
          source: req.source,
          requestId: req.requestId,
          ...(req.sessionId ? { sessionId: req.sessionId } : {}),
          idempotencyKey,
        },
        success: false,
        error: {
          code: 'E_IDEMPOTENCY_KEY_CONFLICT',
          message: 'Idempotency key was already used with different parameters',
          details: { domain: req.domain, operation: req.operation },
        },
      };
    }

    const persisted = lookup.response;

    const now = new Date().toISOString();
    return {
      meta: {
        gateway: req.gateway,
        domain: req.domain,
        operation: req.operation,
        timestamp: now,
        duration_ms: 0,
        source: req.source,
        requestId: req.requestId,
        ...(req.sessionId ? { sessionId: req.sessionId } : {}),
        idempotencyKey,
        idempotentReplay: true,
      },
      success: persisted.success,
      ...(persisted.data !== undefined ? { data: persisted.data } : {}),
      ...(persisted.page !== undefined ? { page: persisted.page } : {}),
      ...(persisted.partial !== undefined ? { partial: persisted.partial } : {}),
      ...(persisted.error !== undefined ? { error: persisted.error } : {}),
    };
  };
}
