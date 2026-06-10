/**
 * Service-Vault OAuth Domain Handler (Dispatch Layer · T11939 · epic T11765).
 *
 * Handles `cleo service <verb>` dispatch operations for the universal
 * service-credential vault OAuth flow:
 *
 * QUERY operations:
 *   auth-url   — build a PKCE OAuth authorization URL for a provider.
 *
 * MUTATE operations:
 *   exchange   — exchange an authorization code for tokens and PERSIST them
 *                encryptGlobal-encrypted into service_connections.
 *   refresh    — refresh a connection's access token honoring the per-provider
 *                RefreshConfig; re-encrypt + persist.
 *   self-heal  — resolve a connection, transparently refreshing a past-expiry
 *                token; returns a NON-SECRET reference (never the plaintext).
 *
 * This handler is a **thin delegate** (Gate-6 — no standalone helper logic
 * > 30 LOC lives here): the entire OAuth engine (buildAuthUrl / exchangeCode /
 * refreshAccessToken / selfHealConnection, plus crypto + persistence) lives in
 * CORE (`store/service-oauth.ts`), driven by the declarative SERVICE_PROVIDERS
 * registry in contracts. The handler validates params, delegates, and shapes the
 * NON-SECRET result envelope — it NEVER surfaces a plaintext token.
 *
 * @epic T11765
 * @task T11939
 */

import {
  type BuildAuthUrlOptions,
  buildAuthUrl,
  type ExchangeCodeOptions,
  exchangeCode,
  selfHealConnection,
} from '@cleocode/core/internal';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { errorResult, unsupportedOp, wrapResult } from './_base.js';

/**
 * Dispatch domain handler for the service-vault OAuth flow (`service.*`).
 *
 * Registered under the `service` domain key. Pure delegate to the CORE
 * `store/service-oauth.ts` functions.
 *
 * @task T11939
 */
export class ServiceHandler implements DomainHandler {
  /**
   * Handle service queries.
   *
   * Supported: `auth-url` — build a PKCE OAuth authorization URL. The result
   * carries the `codeVerifier` + `state` the caller round-trips into `exchange`;
   * these are NOT persisted secrets (they are short-lived flow material the user
   * already controls), so returning them is the contract of the verb.
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    switch (operation) {
      case 'auth-url': {
        const provider = typeof params?.provider === 'string' ? params.provider : undefined;
        if (!provider) {
          return errorResult(
            'query',
            'service',
            operation,
            'E_INVALID_INPUT',
            'provider is required',
            startTime,
          );
        }
        const opts: BuildAuthUrlOptions = {
          ...(typeof params?.state === 'string' ? { state: params.state } : {}),
          ...(typeof params?.scope === 'string' ? { scope: params.scope } : {}),
          ...(typeof params?.redirectUri === 'string' ? { redirectUri: params.redirectUri } : {}),
        };
        try {
          const result = await buildAuthUrl(provider, opts);
          return wrapResult(
            { success: true, data: result },
            'query',
            'service',
            operation,
            startTime,
          );
        } catch (err) {
          return errorResult(
            'query',
            'service',
            operation,
            'E_INTERNAL',
            messageOf(err),
            startTime,
          );
        }
      }
      default:
        return unsupportedOp('query', 'service', operation, startTime);
    }
  }

  /**
   * Handle service mutations.
   *
   * Supported: `exchange` (persist tokens), `refresh` (renew tokens),
   * `self-heal` (resolve + transparent refresh). All delegate to CORE and return
   * the NON-SECRET result — the plaintext token NEVER crosses this boundary.
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    switch (operation) {
      case 'exchange':
        return this.exchange(params, startTime);
      case 'refresh':
        return this.refresh(params, startTime);
      case 'self-heal':
        return this.selfHeal(params, startTime);
      default:
        return unsupportedOp('mutate', 'service', operation, startTime);
    }
  }

  /** Delegate `service.exchange` to CORE `exchangeCode`. */
  private async exchange(
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    const provider = typeof params?.provider === 'string' ? params.provider : undefined;
    const code = typeof params?.code === 'string' ? params.code : undefined;
    const codeVerifier = typeof params?.codeVerifier === 'string' ? params.codeVerifier : undefined;
    const redirectUri = typeof params?.redirectUri === 'string' ? params.redirectUri : undefined;
    if (!provider || !code || !codeVerifier || !redirectUri) {
      return errorResult(
        'mutate',
        'service',
        'exchange',
        'E_INVALID_INPUT',
        'provider, code, codeVerifier, redirectUri are required',
        startTime,
      );
    }
    const opts: ExchangeCodeOptions = {
      code,
      codeVerifier,
      redirectUri,
      ...(typeof params?.label === 'string' ? { label: params.label } : {}),
    };
    try {
      const result = await exchangeCode(provider, opts);
      // Shape a mutate envelope: the connection was created/updated.
      return wrapResult(
        {
          success: true,
          data: { count: 1, created: [String(result.connectionId)], connection: result },
        },
        'mutate',
        'service',
        'exchange',
        startTime,
      );
    } catch (err) {
      return errorResult('mutate', 'service', 'exchange', 'E_INTERNAL', messageOf(err), startTime);
    }
  }

  /** Delegate `service.refresh` to CORE `refreshAccessToken` via the self-heal persist path. */
  private async refresh(
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    const agentId = typeof params?.agentId === 'string' ? params.agentId : undefined;
    const provider = typeof params?.provider === 'string' ? params.provider : undefined;
    const label = typeof params?.label === 'string' ? params.label : undefined;
    if (!agentId || !provider || !label) {
      return errorResult(
        'mutate',
        'service',
        'refresh',
        'E_INVALID_INPUT',
        'agentId, provider, label are required',
        startTime,
      );
    }
    try {
      // A `refresh` is a forced self-heal (skew large enough to always renew).
      const result = await selfHealConnection({
        agentId,
        provider,
        label,
        skewSeconds: Number.MAX_SAFE_INTEGER / 1000,
        ...(params?.approved === true ? { approved: true } : {}),
      });
      if (result.sealed === null) {
        return errorResult(
          'mutate',
          'service',
          'refresh',
          'E_NOT_FOUND',
          'connection not found, not active, or access denied',
          startTime,
        );
      }
      return wrapResult(
        {
          success: true,
          data: {
            count: 1,
            updated: [`${provider}:${label}`],
            refreshed: result.refreshed,
            expiresAt: result.expiresAt,
          },
        },
        'mutate',
        'service',
        'refresh',
        startTime,
      );
    } catch (err) {
      return errorResult('mutate', 'service', 'refresh', 'E_INTERNAL', messageOf(err), startTime);
    }
  }

  /** Delegate `service.self-heal` to CORE `selfHealConnection`. */
  private async selfHeal(
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    const agentId = typeof params?.agentId === 'string' ? params.agentId : undefined;
    const provider = typeof params?.provider === 'string' ? params.provider : undefined;
    const label = typeof params?.label === 'string' ? params.label : undefined;
    if (!agentId || !provider || !label) {
      return errorResult(
        'mutate',
        'service',
        'self-heal',
        'E_INVALID_INPUT',
        'agentId, provider, label are required',
        startTime,
      );
    }
    try {
      const result = await selfHealConnection({
        agentId,
        provider,
        label,
        ...(params?.approved === true ? { approved: true } : {}),
      });
      // NON-SECRET reference only — never the plaintext token.
      return wrapResult(
        {
          success: true,
          data: {
            count: result.refreshed ? 1 : 0,
            updated: result.refreshed ? [`${provider}:${label}`] : [],
            resolved: result.sealed !== null,
            refreshed: result.refreshed,
            expiresAt: result.expiresAt,
          },
        },
        'mutate',
        'service',
        'self-heal',
        startTime,
      );
    } catch (err) {
      return errorResult('mutate', 'service', 'self-heal', 'E_INTERNAL', messageOf(err), startTime);
    }
  }

  /** Return declared operations for introspection and registry validation. */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['auth-url'],
      mutate: ['exchange', 'refresh', 'self-heal'],
    };
  }
}

/** Extract a human-readable message from a thrown value. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
