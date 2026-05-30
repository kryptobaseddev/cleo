/**
 * Attention Domain Handler (Dispatch Layer).
 *
 * Routes `cleo attention add` (alias `jot`) and `cleo attention show/list`
 * through `dispatchFromCli` to the core attention module
 * (`packages/core/src/memory/attention.ts`). The writing agent's session +
 * agent identity and current task are resolved SERVER-SIDE from the
 * environment (E0) — the CLI never passes session/agent/task flags by default,
 * so scope keying cannot be spoofed by "whoever touched the DB last".
 *
 * Package boundary (AGENTS.md): this handler is a thin dispatch wrapper; ALL
 * scope-resolution, persistence, and json_each filtering logic lives in core.
 * Param extraction uses the typed `param*` helpers from `_base` (no casts).
 *
 * @task T11373 — Attention CLI + dispatch op
 * @epic T11288 EP-TIER2-ATTENTION
 * @saga T11283 SG-COGNITIVE-SUBSTRATE
 */

import type { AttentionItem, AttentionScopeKind } from '@cleocode/contracts/operations/attention';
import { getLogger, getProjectRoot } from '@cleocode/core';
import { addAttention, listAttention } from '@cleocode/core/internal';
import type { DispatchResponse, DomainHandler } from '../types.js';
import {
  handleErrorResult,
  paramBool,
  paramNumber,
  paramString,
  paramStringArray,
  paramStringRequired,
  unsupportedOp,
} from './_base.js';
import { dispatchMeta } from './_meta.js';

const log = getLogger('domain:attention');

const QUERY_OPS = new Set<string>(['list', 'show']);
const MUTATE_OPS = new Set<string>(['add']);

/** Valid scope-kind values for the optional `--scope` override. */
const SCOPE_KINDS: ReadonlySet<string> = new Set<AttentionScopeKind>([
  'agent',
  'task',
  'epic',
  'saga',
  'session',
  'global',
]);

/**
 * Narrow a raw `scope` param to an {@link AttentionScopeKind}, or `undefined`
 * when absent / invalid (an invalid kind degrades to the narrowest default
 * rather than erroring — the core resolver treats unknown kinds as "no
 * escalation").
 *
 * @internal
 */
function parseScope(params: Record<string, unknown> | undefined): AttentionScopeKind | undefined {
  const raw = paramString(params, 'scope');
  return raw !== undefined && SCOPE_KINDS.has(raw) ? (raw as AttentionScopeKind) : undefined;
}

/**
 * Dispatch handler for the attention domain.
 *
 * @task T11373
 */
export class AttentionHandler implements DomainHandler {
  /**
   * Read-only attention queries (`list`, `show`).
   *
   * @param operation - `'list'` or `'show'` (synonyms — both emit open items).
   * @param params - Optional `scope` / `tags` / `includeAll` / `limit` filters.
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    if (!QUERY_OPS.has(operation)) {
      return unsupportedOp('query', 'attention', operation, startTime);
    }
    try {
      const result = await listAttention(getProjectRoot(), {
        scope: parseScope(params),
        tags: paramStringArray(params, 'tags'),
        includeAll: paramBool(params, 'includeAll') === true,
        limit: paramNumber(params, 'limit'),
      });
      const data: {
        items: AttentionItem[];
        total: number;
        resolvedScopes: Array<{ kind: string; id: string }>;
      } = {
        items: result.items,
        total: result.items.length,
        resolvedScopes: result.resolvedScopes,
      };
      return {
        meta: dispatchMeta('query', 'attention', operation, startTime),
        success: true,
        data,
      };
    } catch (error) {
      log.error({ gateway: 'query', domain: 'attention', operation, err: error }, String(error));
      return handleErrorResult('query', 'attention', operation, error, startTime);
    }
  }

  /**
   * Attention mutations (`add`).
   *
   * @param operation - `'add'`.
   * @param params - `content` (required) plus optional `tags` / `scope` / `ttlSeconds`.
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    if (!MUTATE_OPS.has(operation)) {
      return unsupportedOp('mutate', 'attention', operation, startTime);
    }
    try {
      const content = paramStringRequired(params, 'content').trim();
      if (!content) {
        return {
          meta: dispatchMeta('mutate', 'attention', operation, startTime),
          success: false,
          error: { code: 'E_INVALID_INPUT', message: 'content is required' },
        };
      }
      const ttlSeconds = paramNumber(params, 'ttlSeconds');
      const item = await addAttention(getProjectRoot(), {
        content,
        tags: paramStringArray(params, 'tags'),
        scope: parseScope(params),
        ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
      });
      return {
        meta: dispatchMeta('mutate', 'attention', operation, startTime),
        success: true,
        data: { item },
      };
    } catch (error) {
      log.error({ gateway: 'mutate', domain: 'attention', operation, err: error }, String(error));
      return handleErrorResult('mutate', 'attention', operation, error, startTime);
    }
  }

  /** Declared operations for introspection. */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return { query: ['list', 'show'], mutate: ['add'] };
  }
}
