/**
 * 5-entity provider-experience Domain Handlers (Dispatch Layer · T11700 · epic T11666).
 *
 * Handles the addressable provider-experience surface the North-Star design needs
 * (§2 — Provider / Alias / Account / Model / Profile):
 *
 *   - `cleo account add|list|remove`     — the credential pool (account.add is
 *                                          SECRET-BEARING; the view is tokenPreview-only).
 *   - `cleo provider list|show|connect`  — the declarative providers table (#1039)
 *                                          + alias resolution (connect is secret-bearing).
 *   - `cleo model query|show`            — the models.dev catalog (#1037). QUERY-ONLY.
 *   - `cleo profile create|list|pin|use` — the named account+model binding persisted
 *                                          into llm.profiles[name] (the resolver SSoT).
 *
 * Each handler is a **thin delegate** (Gate-6 — no standalone helper logic > 30 LOC
 * lives here): the entire engine layer (validation, table reads, config writes,
 * secret redaction) lives in CORE (`llm/entity-ops.ts`). The handler validates the
 * gateway + operation, delegates, and wraps the `EngineResult` into the LAFS
 * envelope. NO raw secret ever crosses this boundary — every account view is the
 * already-redacted `tokenPreview` shape.
 *
 * @epic T11666
 * @task T11700
 */

import type { EngineResult, ModelTransport, StoredAuthTypeWire } from '@cleocode/contracts';
import {
  accountAdd,
  accountList,
  accountRemove,
  modelQuery,
  modelShow,
  profileCreate,
  profileList,
  profilePin,
  profileUse,
  providerConnect,
  providerList,
  providerShow,
} from '@cleocode/core/internal';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { paramNumber, paramString, unsupportedOp, wrapResult } from './_base.js';

// ---------------------------------------------------------------------------
// Shared engine-result wrapping — delegate to a CORE entity op + envelope it.
// ---------------------------------------------------------------------------

/**
 * Run a CORE entity op and wrap its {@link EngineResult} into a
 * {@link DispatchResponse}. The single delegation seam shared by every handler.
 */
async function runEntityOp<T>(
  op: () => Promise<EngineResult<T>>,
  gateway: 'query' | 'mutate',
  domain: string,
  operation: string,
  startTime: number,
): Promise<DispatchResponse> {
  try {
    return wrapResult(await op(), gateway, domain, operation, startTime);
  } catch (err) {
    return wrapResult(
      {
        success: false,
        error: { code: 'E_INTERNAL', message: err instanceof Error ? err.message : String(err) },
      },
      gateway,
      domain,
      operation,
      startTime,
    );
  }
}

/** Narrow a raw param to a {@link StoredAuthTypeWire} when valid, else `undefined`. */
function authTypeOf(params: Record<string, unknown> | undefined): StoredAuthTypeWire | undefined {
  const v = paramString(params, 'authType');
  return v === 'api_key' || v === 'oauth' || v === 'aws_sdk' ? v : undefined;
}

// ---------------------------------------------------------------------------
// AccountHandler — the credential pool (account.add is secret-bearing).
// ---------------------------------------------------------------------------

/** Dispatch domain handler for `account.*` — the pooled-credential surface. */
export class AccountHandler implements DomainHandler {
  /** Execute an `account` query (`list`). */
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    if (operation === 'list') {
      const provider = paramString(params, 'provider');
      return runEntityOp(
        () => accountList(provider !== undefined ? { provider: provider as ModelTransport } : {}),
        'query',
        'account',
        'list',
        startTime,
      );
    }
    return unsupportedOp('query', 'account', operation, startTime);
  }

  /** Execute an `account` mutation (`add` — secret-bearing — / `remove`). */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    switch (operation) {
      case 'add': {
        const provider = paramString(params, 'provider');
        const token = paramString(params, 'token');
        if (!provider || !token) {
          return runEntityOp(
            async () => ({
              success: false,
              error: { code: 'E_INVALID_INPUT', message: 'provider and token are required' },
            }),
            'mutate',
            'account',
            'add',
            startTime,
          );
        }
        const authType = authTypeOf(params);
        const baseUrl = paramString(params, 'baseUrl');
        const priority = paramNumber(params, 'priority');
        const label = paramString(params, 'label');
        return runEntityOp(
          () =>
            accountAdd({
              provider: provider as ModelTransport,
              token,
              ...(label !== undefined ? { label } : {}),
              ...(baseUrl !== undefined ? { baseUrl } : {}),
              ...(authType !== undefined ? { authType } : {}),
              ...(priority !== undefined ? { priority } : {}),
            }),
          'mutate',
          'account',
          'add',
          startTime,
        );
      }
      case 'remove': {
        const provider = paramString(params, 'provider');
        const label = paramString(params, 'label');
        if (!provider || !label) {
          return runEntityOp(
            async () => ({
              success: false,
              error: { code: 'E_INVALID_INPUT', message: 'provider and label are required' },
            }),
            'mutate',
            'account',
            'remove',
            startTime,
          );
        }
        return runEntityOp(
          () => accountRemove({ provider: provider as ModelTransport, label }),
          'mutate',
          'account',
          'remove',
          startTime,
        );
      }
      default:
        return unsupportedOp('mutate', 'account', operation, startTime);
    }
  }

  /** Declared operations for introspection and validation. */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return { query: ['list'], mutate: ['add', 'remove'] };
  }
}

// ---------------------------------------------------------------------------
// ProviderHandler — the declarative providers table + alias resolution.
// ---------------------------------------------------------------------------

/** Dispatch domain handler for `provider.*` — declarative provider rows. */
export class ProviderHandler implements DomainHandler {
  /** Execute a `provider` query (`list` / `show`). */
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    switch (operation) {
      case 'list':
        return runEntityOp(() => providerList({}), 'query', 'provider', 'list', startTime);
      case 'show': {
        const provider = paramString(params, 'provider');
        if (!provider) {
          return runEntityOp(
            async () => ({
              success: false,
              error: { code: 'E_INVALID_INPUT', message: 'provider is required' },
            }),
            'query',
            'provider',
            'show',
            startTime,
          );
        }
        return runEntityOp(
          () => providerShow({ provider }),
          'query',
          'provider',
          'show',
          startTime,
        );
      }
      default:
        return unsupportedOp('query', 'provider', operation, startTime);
    }
  }

  /** Execute a `provider` mutation (`connect` — secret-bearing). */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    if (operation === 'connect') {
      const provider = paramString(params, 'provider');
      if (!provider) {
        return runEntityOp(
          async () => ({
            success: false,
            error: { code: 'E_INVALID_INPUT', message: 'provider is required' },
          }),
          'mutate',
          'provider',
          'connect',
          startTime,
        );
      }
      const token = paramString(params, 'token');
      const label = paramString(params, 'label');
      const authType = authTypeOf(params);
      return runEntityOp(
        () =>
          providerConnect({
            provider,
            ...(token !== undefined ? { token } : {}),
            ...(label !== undefined ? { label } : {}),
            ...(authType !== undefined ? { authType } : {}),
          }),
        'mutate',
        'provider',
        'connect',
        startTime,
      );
    }
    return unsupportedOp('mutate', 'provider', operation, startTime);
  }

  /** Declared operations for introspection and validation. */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return { query: ['list', 'show'], mutate: ['connect'] };
  }
}

// ---------------------------------------------------------------------------
// ModelHandler — the models.dev catalog (QUERY-ONLY).
// ---------------------------------------------------------------------------

/** Dispatch domain handler for `model.*` — the models.dev catalog (query-only). */
export class ModelHandler implements DomainHandler {
  /** Execute a `model` query (`query` / `show`). */
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    switch (operation) {
      case 'query': {
        const provider = paramString(params, 'provider');
        const limit = paramNumber(params, 'limit');
        return runEntityOp(
          () =>
            modelQuery({
              ...(provider !== undefined ? { provider } : {}),
              ...(limit !== undefined ? { limit } : {}),
            }),
          'query',
          'model',
          'query',
          startTime,
        );
      }
      case 'show': {
        const model = paramString(params, 'model');
        if (!model) {
          return runEntityOp(
            async () => ({
              success: false,
              error: { code: 'E_INVALID_INPUT', message: 'model is required' },
            }),
            'query',
            'model',
            'show',
            startTime,
          );
        }
        return runEntityOp(() => modelShow({ model }), 'query', 'model', 'show', startTime);
      }
      default:
        return unsupportedOp('query', 'model', operation, startTime);
    }
  }

  /** `model` is query-only — every mutation is unsupported. */
  async mutate(operation: string, _params?: Record<string, unknown>): Promise<DispatchResponse> {
    return unsupportedOp('mutate', 'model', operation, Date.now());
  }

  /** Declared operations for introspection and validation. */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return { query: ['query', 'show'], mutate: [] };
  }
}

// ---------------------------------------------------------------------------
// ProfileHandler — the named account+model binding (llm.profiles).
// ---------------------------------------------------------------------------

/** Dispatch domain handler for `profile.*` — named provider bindings. */
export class ProfileHandler implements DomainHandler {
  /** Execute a `profile` query (`list`). */
  async query(operation: string, _params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    if (operation === 'list') {
      return runEntityOp(() => profileList({}), 'query', 'profile', 'list', startTime);
    }
    return unsupportedOp('query', 'profile', operation, startTime);
  }

  /** Execute a `profile` mutation (`create` / `pin` / `use`). */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    switch (operation) {
      case 'create': {
        const name = paramString(params, 'name');
        const provider = paramString(params, 'provider');
        const model = paramString(params, 'model');
        if (!name || !provider || !model) {
          return runEntityOp(
            async () => ({
              success: false,
              error: {
                code: 'E_INVALID_INPUT',
                message: 'name, provider, and model are required',
              },
            }),
            'mutate',
            'profile',
            'create',
            startTime,
          );
        }
        const label = paramString(params, 'label');
        const role = paramString(params, 'role');
        return runEntityOp(
          () =>
            profileCreate({
              name,
              provider: provider as ModelTransport,
              model,
              ...(label !== undefined ? { label } : {}),
              ...(role !== undefined ? { role } : {}),
            }),
          'mutate',
          'profile',
          'create',
          startTime,
        );
      }
      case 'pin': {
        const name = paramString(params, 'name');
        const role = paramString(params, 'role');
        if (!name || !role) {
          return runEntityOp(
            async () => ({
              success: false,
              error: { code: 'E_INVALID_INPUT', message: 'name and role are required' },
            }),
            'mutate',
            'profile',
            'pin',
            startTime,
          );
        }
        return runEntityOp(() => profilePin({ name, role }), 'mutate', 'profile', 'pin', startTime);
      }
      case 'use': {
        const name = paramString(params, 'name');
        if (!name) {
          return runEntityOp(
            async () => ({
              success: false,
              error: { code: 'E_INVALID_INPUT', message: 'name is required' },
            }),
            'mutate',
            'profile',
            'use',
            startTime,
          );
        }
        return runEntityOp(() => profileUse({ name }), 'mutate', 'profile', 'use', startTime);
      }
      default:
        return unsupportedOp('mutate', 'profile', operation, startTime);
    }
  }

  /** Declared operations for introspection and validation. */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return { query: ['list'], mutate: ['create', 'pin', 'use'] };
  }
}
