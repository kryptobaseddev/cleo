/**
 * Service-vault CLI operation contracts — INPUT + OUTPUT schemas (T11941).
 *
 * The schema-first I/O contracts for the four user-facing service-vault CLI
 * verbs (`cleo service connect|list|revoke|status`). They live HERE in the
 * `contracts` leaf package — alongside `tasks.ts` and the OUTPUT-contracts
 * registry — so every consumer (CLI `--describe`, the SDK `describeOperation`,
 * REST clients) resolves the I/O shape against ONE source of truth.
 *
 * AC4 (T11941): each new op carries an INPUT and an OUTPUT schema and appears in
 * the output-contract data. `connect`/`list`/`revoke`/`status` are registered in
 * `INPUT_CONTRACTS` (core) and `OUTPUT_CONTRACTS` (this package) so
 * `cleo service <verb> --describe` resolves a non-null contract pair.
 *
 * ## Secrets never surfaced
 *
 * Every OUTPUT schema describes a NON-SECRET view: `list`/`status` carry
 * `provider`/`label`/`status`/`scopes`/`expiresAt`/`hasCredentials` only —
 * NEVER the decrypted token. `connect` returns the non-secret connection
 * identity. `revoke` returns the `{count, deleted, grantsRemoved}` cascade
 * report. There is no `--field` pointer that resolves to a token, by design.
 *
 * @packageDocumentation
 * @module @cleocode/contracts/operations/service
 *
 * @epic T11765
 * @saga T10409
 * @task T11941 — M2-W4 service CLI verbs
 */

import type { JsonSchema, OperationInputContract } from './input-contract.js';
import type { OperationOutputContract } from './output-contract.js';

// ---------------------------------------------------------------------------
// service.connect — store a service credential (token-direct or paste-code)
// ---------------------------------------------------------------------------

/**
 * Accepted input shape for `service.connect`.
 *
 * Two non-interactive modes (v1, browser-free + testable):
 *   - token-direct: `provider` + `token` (+ optional `refreshToken`, `expiresAt`,
 *     `scopes`) — stores the token blob `encryptGlobal`-encrypted.
 *   - paste-code: `provider` + `code` + `codeVerifier` + `redirectUri` — runs the
 *     OAuth `exchangeCode` dance (the interactive flow is a thin wrapper over it).
 *
 * `additionalProperties: false` so a typo'd flag is rejected loudly (DHQ-033).
 *
 * @task T11941
 */
export const SERVICE_CONNECT_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['provider'],
  additionalProperties: false,
  properties: {
    provider: {
      type: 'string',
      minLength: 1,
      description: 'Service provider key (e.g. github, google, notion).',
    },
    label: {
      type: 'string',
      description: "Connection label, unique within the provider (default: 'default').",
    },
    token: {
      type: 'string',
      description:
        'Direct access token to store (token-direct mode). SECRET — never logged/echoed.',
    },
    refreshToken: {
      type: 'string',
      description: 'Optional refresh token paired with --token. SECRET.',
    },
    expiresAt: {
      type: 'string',
      description: 'ISO-8601 access-token expiry (token-direct mode).',
    },
    scopes: {
      type: 'array',
      items: { type: 'string' },
      description: 'Granted scope list (non-secret).',
    },
    code: {
      type: 'string',
      description: 'OAuth authorization code from the redirect callback (paste-code mode).',
    },
    codeVerifier: {
      type: 'string',
      description: 'PKCE code verifier from service.auth-url, round-tripped (paste-code mode).',
    },
    redirectUri: {
      type: 'string',
      description: 'Redirect URI used in service.auth-url; must match (paste-code mode).',
    },
  },
};

/** Schema-first INPUT contract for `service.connect`. */
export const serviceConnectInputContract: OperationInputContract<Record<string, unknown>> = {
  operation: 'service.connect',
  schema: SERVICE_CONNECT_INPUT_SCHEMA,
  examples: [
    {
      name: 'token-direct',
      value: { provider: 'github', token: 'gho_xxx', label: 'personal' },
      description: 'Store an already-obtained access token (browser-free v1).',
    },
    {
      name: 'paste-code',
      value: {
        provider: 'github',
        code: 'auth-code',
        codeVerifier: 'pkce-verifier',
        redirectUri: 'http://127.0.0.1:0/callback',
      },
      description: 'Exchange an OAuth code + PKCE verifier for tokens.',
    },
  ],
};

/** OUTPUT contract for `service.connect` — the non-secret mutate envelope. */
export const serviceConnectOutputContract: OperationOutputContract = {
  operation: 'service.connect',
  shapeNote:
    'Mutate envelope: count=1, created=[connectionId]. `connection` carries the NON-SECRET identity (provider/label/expiresAt). No token is ever returned.',
  dataSchema: {
    type: 'object',
    required: ['count', 'created'],
    additionalProperties: true,
    properties: {
      count: { type: 'number', description: 'Number of connections created/updated (1).' },
      created: {
        type: 'array',
        items: { type: 'string' },
        description: 'The connection id(s) created/updated, as strings.',
      },
      connection: {
        type: 'object',
        description: 'Non-secret connection identity.',
        properties: {
          connectionId: { type: 'number' },
          provider: { type: 'string' },
          label: { type: 'string' },
          expiresAt: { type: ['string', 'null'] },
        },
      },
    },
  },
  fieldPointers: [
    '/data/count',
    '/data/created/0',
    '/data/connection/provider',
    '/data/connection/label',
    '/data/connection/expiresAt',
  ],
};

// ---------------------------------------------------------------------------
// service.list — redacted connection views
// ---------------------------------------------------------------------------

/** Accepted input shape for `service.list`. */
export const SERVICE_LIST_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: [],
  additionalProperties: false,
  properties: {
    provider: {
      type: 'string',
      description: 'Optional provider filter; lists all providers when omitted.',
    },
  },
};

/** Schema-first INPUT contract for `service.list`. */
export const serviceListInputContract: OperationInputContract<Record<string, unknown>> = {
  operation: 'service.list',
  schema: SERVICE_LIST_INPUT_SCHEMA,
  examples: [
    { name: 'all', value: {}, description: 'List every service connection (redacted).' },
    { name: 'one-provider', value: { provider: 'github' }, description: 'Filter to one provider.' },
  ],
};

/** The redacted per-connection view schema (shared by list + status). */
const SERVICE_CONNECTION_VIEW_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['provider', 'label', 'status', 'scopes', 'hasCredentials'],
  additionalProperties: true,
  properties: {
    id: { type: 'number' },
    provider: { type: 'string' },
    label: { type: 'string' },
    status: { type: 'string', enum: ['active', 'expired', 'revoked'] },
    scopes: { type: 'array', items: { type: 'string' } },
    expiresAt: { type: ['string', 'null'] },
    connectedAt: { type: 'string' },
    updatedAt: { type: 'string' },
    hasCredentials: {
      type: 'boolean',
      description: 'Whether a credential blob is present — NEVER the token itself.',
    },
  },
};

/** OUTPUT contract for `service.list` — redacted connection views. */
export const serviceListOutputContract: OperationOutputContract = {
  operation: 'service.list',
  shapeNote:
    'connections[] are NON-SECRET views — provider/label/status/scopes/expiresAt/hasCredentials only. The decrypted token is NEVER present in any field.',
  dataSchema: {
    type: 'object',
    required: ['connections'],
    additionalProperties: true,
    properties: {
      connections: {
        type: 'array',
        items: SERVICE_CONNECTION_VIEW_SCHEMA,
        description: 'Redacted connection views.',
      },
    },
  },
  fieldPointers: [
    '/data/connections',
    '/data/connections/0/provider',
    '/data/connections/0/label',
    '/data/connections/0/status',
    '/data/connections/0/expiresAt',
    '/data/connections/0/hasCredentials',
  ],
};

// ---------------------------------------------------------------------------
// service.revoke — hard delete + cascade grants
// ---------------------------------------------------------------------------

/** Accepted input shape for `service.revoke`. */
export const SERVICE_REVOKE_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['provider', 'label'],
  additionalProperties: false,
  properties: {
    provider: { type: 'string', minLength: 1, description: 'Service provider key.' },
    label: { type: 'string', minLength: 1, description: 'Connection label to revoke.' },
  },
};

/** Schema-first INPUT contract for `service.revoke`. */
export const serviceRevokeInputContract: OperationInputContract<Record<string, unknown>> = {
  operation: 'service.revoke',
  schema: SERVICE_REVOKE_INPUT_SCHEMA,
  examples: [
    {
      name: 'revoke',
      value: { provider: 'github', label: 'personal' },
      description: 'Delete the connection and cascade its agent grants.',
    },
  ],
};

/** OUTPUT contract for `service.revoke` — the cascade-delete report. */
export const serviceRevokeOutputContract: OperationOutputContract = {
  operation: 'service.revoke',
  shapeNote:
    'Mutate envelope: count=1 + deleted=[provider:label] on success (0 + [] when no such connection). `grantsRemoved` counts the cascaded agent_service_grants rows.',
  dataSchema: {
    type: 'object',
    required: ['count', 'deleted'],
    additionalProperties: true,
    properties: {
      count: { type: 'number', description: '1 when a connection was deleted, else 0.' },
      deleted: {
        type: 'array',
        items: { type: 'string' },
        description: 'The `provider:label` identifier(s) deleted.',
      },
      grantsRemoved: {
        type: 'number',
        description: 'How many agent_service_grants rows were cascaded-deleted.',
      },
    },
  },
  fieldPointers: ['/data/count', '/data/deleted/0', '/data/grantsRemoved'],
};

// ---------------------------------------------------------------------------
// service.status — connection health (expired? needs refresh?)
// ---------------------------------------------------------------------------

/** Accepted input shape for `service.status`. */
export const SERVICE_STATUS_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: [],
  additionalProperties: false,
  properties: {
    provider: {
      type: 'string',
      description: 'Optional provider filter; reports all connections when omitted.',
    },
  },
};

/** Schema-first INPUT contract for `service.status`. */
export const serviceStatusInputContract: OperationInputContract<Record<string, unknown>> = {
  operation: 'service.status',
  schema: SERVICE_STATUS_INPUT_SCHEMA,
  examples: [
    { name: 'all', value: {}, description: 'Health of every connection.' },
    {
      name: 'one-provider',
      value: { provider: 'github' },
      description: 'Health for one provider.',
    },
  ],
};

/** OUTPUT contract for `service.status` — per-connection health. */
export const serviceStatusOutputContract: OperationOutputContract = {
  operation: 'service.status',
  shapeNote:
    'connections[] are NON-SECRET health views: each adds `expired` + `needsRefresh` booleans computed from expiresAt. No token is ever present.',
  dataSchema: {
    type: 'object',
    required: ['connections'],
    additionalProperties: true,
    properties: {
      connections: {
        type: 'array',
        items: {
          type: 'object',
          required: ['provider', 'label', 'status', 'expired', 'needsRefresh'],
          additionalProperties: true,
          properties: {
            provider: { type: 'string' },
            label: { type: 'string' },
            status: { type: 'string', enum: ['active', 'expired', 'revoked'] },
            expiresAt: { type: ['string', 'null'] },
            expired: {
              type: 'boolean',
              description: 'True when expiresAt is in the past (or status=expired).',
            },
            needsRefresh: {
              type: 'boolean',
              description: 'True when the connection is expired and has stored credentials.',
            },
            hasCredentials: { type: 'boolean' },
          },
        },
      },
    },
  },
  fieldPointers: [
    '/data/connections',
    '/data/connections/0/provider',
    '/data/connections/0/label',
    '/data/connections/0/status',
    '/data/connections/0/expired',
    '/data/connections/0/needsRefresh',
  ],
};
