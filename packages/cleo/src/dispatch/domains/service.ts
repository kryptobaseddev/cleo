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
  type ConnectServiceParams,
  connectService,
  deleteConnectionCascade,
  listConnections,
  type ServiceConnectionView,
} from '@cleocode/core';
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
      case 'list':
        return this.list(params, startTime);
      case 'status':
        return this.status(params, startTime);
      default:
        return unsupportedOp('query', 'service', operation, startTime);
    }
  }

  /** Delegate `service.list` to CORE `listConnections` — redacted views only. */
  private async list(
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    const provider = typeof params?.provider === 'string' ? params.provider : undefined;
    try {
      const connections = await listConnections(provider);
      // `ServiceConnectionView` is secret-free by construction (no token field).
      return wrapResult(
        { success: true, data: { connections } },
        'query',
        'service',
        'list',
        startTime,
      );
    } catch (err) {
      return errorResult('query', 'service', 'list', 'E_INTERNAL', messageOf(err), startTime);
    }
  }

  /** Delegate `service.status` to CORE `listConnections` + map to health views. */
  private async status(
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    const provider = typeof params?.provider === 'string' ? params.provider : undefined;
    try {
      const views = await listConnections(provider);
      const connections = views.map((v) => toHealthView(v));
      return wrapResult(
        { success: true, data: { connections } },
        'query',
        'service',
        'status',
        startTime,
      );
    } catch (err) {
      return errorResult('query', 'service', 'status', 'E_INTERNAL', messageOf(err), startTime);
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
      case 'connect':
        return this.connect(params, startTime);
      case 'exchange':
        return this.exchange(params, startTime);
      case 'refresh':
        return this.refresh(params, startTime);
      case 'revoke':
        return this.revoke(params, startTime);
      case 'self-heal':
        return this.selfHeal(params, startTime);
      default:
        return unsupportedOp('mutate', 'service', operation, startTime);
    }
  }

  /**
   * Delegate `service.connect` — store a credential. Two modes:
   *   - token-direct: `token` (+ optional refreshToken/expiresAt/scopes) →
   *     CORE `connectService` encrypts + persists the blob.
   *   - paste-code: `code` + `codeVerifier` + `redirectUri` → CORE `exchangeCode`
   *     runs the OAuth dance. The plaintext token NEVER crosses this boundary.
   */
  private async connect(
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    const provider = typeof params?.provider === 'string' ? params.provider : undefined;
    if (!provider) {
      return errorResult(
        'mutate',
        'service',
        'connect',
        'E_INVALID_INPUT',
        'provider is required',
        startTime,
      );
    }
    const label = typeof params?.label === 'string' ? params.label : 'default';
    const token = typeof params?.token === 'string' ? params.token : undefined;
    const code = typeof params?.code === 'string' ? params.code : undefined;
    try {
      if (token !== undefined) {
        const connectionId = await connectService(
          buildConnectParams(provider, label, params, token),
        );
        return wrapResult(
          {
            success: true,
            data: {
              count: 1,
              created: [String(connectionId)],
              connection: { connectionId, provider, label, expiresAt: expiryOf(params) },
            },
          },
          'mutate',
          'service',
          'connect',
          startTime,
        );
      }
      if (code !== undefined) {
        const opts = buildExchangeOpts(params, code, label);
        if (opts === null) {
          return errorResult(
            'mutate',
            'service',
            'connect',
            'E_INVALID_INPUT',
            'paste-code mode requires --code, --code-verifier, and --redirect-uri',
            startTime,
          );
        }
        const result = await exchangeCode(provider, opts);
        return wrapResult(
          {
            success: true,
            data: { count: 1, created: [String(result.connectionId)], connection: result },
          },
          'mutate',
          'service',
          'connect',
          startTime,
        );
      }
      return errorResult(
        'mutate',
        'service',
        'connect',
        'E_INVALID_INPUT',
        'connect requires either --token (token-direct) or --code + --code-verifier + --redirect-uri (paste-code)',
        startTime,
      );
    } catch (err) {
      return errorResult('mutate', 'service', 'connect', 'E_INTERNAL', messageOf(err), startTime);
    }
  }

  /** Delegate `service.revoke` to CORE `deleteConnectionCascade` (hard delete + cascade). */
  private async revoke(
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    const provider = typeof params?.provider === 'string' ? params.provider : undefined;
    const label = typeof params?.label === 'string' ? params.label : undefined;
    if (!provider || !label) {
      return errorResult(
        'mutate',
        'service',
        'revoke',
        'E_INVALID_INPUT',
        'provider and label are required',
        startTime,
      );
    }
    try {
      const result = await deleteConnectionCascade(provider, label);
      return wrapResult(
        {
          success: true,
          data: {
            count: result.deleted ? 1 : 0,
            deleted: result.deleted ? [`${provider}:${label}`] : [],
            grantsRemoved: result.grantsRemoved,
          },
        },
        'mutate',
        'service',
        'revoke',
        startTime,
      );
    } catch (err) {
      return errorResult('mutate', 'service', 'revoke', 'E_INTERNAL', messageOf(err), startTime);
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
      query: ['auth-url', 'list', 'status'],
      mutate: ['connect', 'exchange', 'refresh', 'revoke', 'self-heal'],
    };
  }
}

/** Extract a human-readable message from a thrown value. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Read the ISO-8601 `expiresAt` param when present (token-direct connect). */
function expiryOf(params: Record<string, unknown> | undefined): string | null {
  return typeof params?.expiresAt === 'string' ? params.expiresAt : null;
}

/** Build {@link ConnectServiceParams} for token-direct `service.connect`. */
function buildConnectParams(
  provider: string,
  label: string,
  params: Record<string, unknown> | undefined,
  token: string,
): ConnectServiceParams {
  const refreshToken = typeof params?.refreshToken === 'string' ? params.refreshToken : undefined;
  const scopes = Array.isArray(params?.scopes)
    ? params.scopes.filter((s): s is string => typeof s === 'string')
    : undefined;
  return {
    provider,
    label,
    tokens: { accessToken: token, ...(refreshToken !== undefined ? { refreshToken } : {}) },
    ...(scopes !== undefined ? { scopes } : {}),
    ...(typeof params?.expiresAt === 'string' ? { expiresAt: params.expiresAt } : {}),
  };
}

/** Build {@link ExchangeCodeOptions} for paste-code `service.connect`; null when incomplete. */
function buildExchangeOpts(
  params: Record<string, unknown> | undefined,
  code: string,
  label: string,
): ExchangeCodeOptions | null {
  const codeVerifier = typeof params?.codeVerifier === 'string' ? params.codeVerifier : undefined;
  const redirectUri = typeof params?.redirectUri === 'string' ? params.redirectUri : undefined;
  if (codeVerifier === undefined || redirectUri === undefined) return null;
  return { code, codeVerifier, redirectUri, label };
}

/** Map a redacted {@link ServiceConnectionView} to a health view (expired? needsRefresh?). */
function toHealthView(v: ServiceConnectionView): {
  provider: string;
  label: string;
  status: ServiceConnectionView['status'];
  expiresAt: string | null;
  expired: boolean;
  needsRefresh: boolean;
  hasCredentials: boolean;
} {
  const expired =
    v.status === 'expired' ||
    (v.expiresAt !== null &&
      Number.isFinite(Date.parse(v.expiresAt)) &&
      Date.parse(v.expiresAt) <= Date.now());
  return {
    provider: v.provider,
    label: v.label,
    status: v.status,
    expiresAt: v.expiresAt,
    expired,
    needsRefresh: expired && v.hasCredentials,
    hasCredentials: v.hasCredentials,
  };
}
