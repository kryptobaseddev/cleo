/**
 * 5-entity provider-experience operation contracts — INPUT + OUTPUT schemas (T11700).
 *
 * The schema-first I/O contracts for the addressable provider-experience surface
 * the North-Star design needs (§2 — Provider / Alias / Account / Model / Profile).
 * They live HERE in the `contracts` leaf package — alongside `tasks.ts`,
 * `service.ts`, and the OUTPUT-contracts registry — so every consumer (CLI
 * `--describe`, the SDK `describeOperation`, REST clients) resolves the I/O shape
 * against ONE source of truth.
 *
 * ## The five entities (North-Star §2)
 *
 * - **Provider** — a declarative LLM provider definition (`anthropic`, `openai`, …)
 *   with its aliases, auth methods, and endpoint variants (`providers` table, #1039).
 * - **Alias** — a case-insensitive name resolving to a provider (carried inside the
 *   provider rows; surfaced via `provider.show`).
 * - **Account** — ONE pooled credential for a provider (the rename/successor of the
 *   secret-bearing `llm` credential pool). `account.add` is SECRET-BEARING.
 * - **Model** — a row in the models.dev catalog (`models_catalog` table, #1037).
 * - **Profile** — the named, addressable binding of `account + model (+ params + role)`,
 *   persisted in config under `llm.profiles[name]` (the resolver-consumed SSoT).
 *
 * ## Secrets never surfaced
 *
 * `account.add` accepts a SECRET token but its OUTPUT view is the same NON-SECRET
 * redacted shape `account.list` returns — `tokenPreview` (last-4) ONLY, NEVER the
 * raw key. There is no `--field` pointer that resolves to a secret, by design. The
 * secret-bearing ops are kept OFF the MCP surface (default-deny `mcpExposed`).
 *
 * @packageDocumentation
 * @module @cleocode/contracts/operations/entities
 *
 * @epic T11666
 * @task T11700 — provider/account/model/profile OperationDefs
 */

import type { JsonSchema, OperationInputContract } from './input-contract.js';
import type { OperationOutputContract } from './output-contract.js';

// ---------------------------------------------------------------------------
// Shared NON-SECRET account (credential) view schema — used by add + list.
// ---------------------------------------------------------------------------

/**
 * The redacted per-account view schema (shared by `account.add` and
 * `account.list`). Carries `tokenPreview` (last-4 redaction) ONLY — the decrypted
 * secret is NEVER present in any field.
 */
const ACCOUNT_VIEW_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['provider', 'label', 'authType', 'tokenPreview'],
  additionalProperties: true,
  properties: {
    provider: { type: 'string', description: 'LLM provider transport key.' },
    label: { type: 'string', description: 'Account label, unique within the provider.' },
    authType: { type: 'string', description: 'Storage auth scheme (api_key | oauth | aws_sdk).' },
    tokenPreview: {
      type: 'string',
      description: 'Redacted token preview (last-4 chars) — NEVER the raw secret.',
    },
    hasRefreshToken: { type: 'boolean' },
    expiresAt: { type: ['number', 'null'] },
    priority: { type: 'number' },
    source: { type: ['string', 'null'] },
    baseUrl: { type: ['string', 'null'] },
    disabled: { type: 'boolean' },
  },
};

// ---------------------------------------------------------------------------
// account.add — store a pooled credential (SECRET-BEARING, cli-only)
// ---------------------------------------------------------------------------

/** Accepted input shape for `account.add`. `token` is SECRET — never echoed. */
export const ACCOUNT_ADD_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['provider', 'token'],
  additionalProperties: false,
  properties: {
    provider: {
      type: 'string',
      minLength: 1,
      description: 'LLM provider transport key (e.g. anthropic, openai).',
    },
    token: {
      type: 'string',
      minLength: 1,
      description: 'API key or OAuth bearer token to persist. SECRET — never logged/echoed.',
    },
    label: {
      type: 'string',
      description: "Account label, unique within the provider (default: 'default').",
    },
    baseUrl: { type: 'string', description: 'Optional override for the provider base URL.' },
    authType: {
      type: 'string',
      enum: ['api_key', 'oauth', 'aws_sdk'],
      description: 'Explicit auth-type override; auto-detected from the token prefix when omitted.',
    },
    priority: { type: 'number', description: 'Optional priority override (lower wins).' },
  },
};

/** Schema-first INPUT contract for `account.add`. */
export const accountAddInputContract: OperationInputContract<Record<string, unknown>> = {
  operation: 'account.add',
  schema: ACCOUNT_ADD_INPUT_SCHEMA,
  examples: [
    {
      name: 'api-key',
      value: { provider: 'anthropic', token: 'sk-ant-xxx', label: 'work' },
      description: 'Store an API key for a provider account.',
    },
    {
      name: 'oauth',
      value: { provider: 'anthropic', token: 'sk-ant-oat-xxx', authType: 'oauth' },
      description: 'Store an OAuth bearer token (auto-detected as oauth from the prefix).',
    },
  ],
};

/** OUTPUT contract for `account.add` — the NON-SECRET redacted view. */
export const accountAddOutputContract: OperationOutputContract = {
  operation: 'account.add',
  shapeNote:
    '`account` is the redacted NON-SECRET view (tokenPreview = last-4 ONLY). The raw secret is NEVER returned. `detectedAuthType` records the resolved scheme.',
  dataSchema: {
    type: 'object',
    required: ['account', 'detectedAuthType'],
    additionalProperties: true,
    properties: {
      account: ACCOUNT_VIEW_SCHEMA,
      detectedAuthType: { type: 'string', description: 'Resolved auth scheme (api_key | oauth).' },
    },
  },
  fieldPointers: [
    '/data/account/provider',
    '/data/account/label',
    '/data/account/authType',
    '/data/account/tokenPreview',
    '/data/detectedAuthType',
  ],
};

// ---------------------------------------------------------------------------
// account.list — redacted account views (NEVER a secret)
// ---------------------------------------------------------------------------

/** Accepted input shape for `account.list`. */
export const ACCOUNT_LIST_INPUT_SCHEMA: JsonSchema = {
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

/** Schema-first INPUT contract for `account.list`. */
export const accountListInputContract: OperationInputContract<Record<string, unknown>> = {
  operation: 'account.list',
  schema: ACCOUNT_LIST_INPUT_SCHEMA,
  examples: [
    { name: 'all', value: {}, description: 'List every pooled account (redacted).' },
    {
      name: 'one-provider',
      value: { provider: 'anthropic' },
      description: 'Filter to one provider.',
    },
  ],
};

/** OUTPUT contract for `account.list` — redacted account views. */
export const accountListOutputContract: OperationOutputContract = {
  operation: 'account.list',
  shapeNote:
    'accounts[] are NON-SECRET views — provider/label/authType/tokenPreview only. No decrypted secret is present in ANY field.',
  dataSchema: {
    type: 'object',
    required: ['accounts'],
    additionalProperties: true,
    properties: {
      accounts: {
        type: 'array',
        items: ACCOUNT_VIEW_SCHEMA,
        description: 'Redacted account views.',
      },
    },
  },
  fieldPointers: [
    '/data/accounts',
    '/data/accounts/0/provider',
    '/data/accounts/0/label',
    '/data/accounts/0/tokenPreview',
  ],
};

// ---------------------------------------------------------------------------
// account.remove — delete a (provider, label) account
// ---------------------------------------------------------------------------

/** Accepted input shape for `account.remove`. */
export const ACCOUNT_REMOVE_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['provider', 'label'],
  additionalProperties: false,
  properties: {
    provider: { type: 'string', minLength: 1, description: 'LLM provider transport key.' },
    label: { type: 'string', minLength: 1, description: 'Account label to remove.' },
  },
};

/** Schema-first INPUT contract for `account.remove`. */
export const accountRemoveInputContract: OperationInputContract<Record<string, unknown>> = {
  operation: 'account.remove',
  schema: ACCOUNT_REMOVE_INPUT_SCHEMA,
  examples: [
    {
      name: 'remove',
      value: { provider: 'anthropic', label: 'work' },
      description: 'Delete the (provider, label) account from the pool.',
    },
  ],
};

/** OUTPUT contract for `account.remove` — the mutate envelope. */
export const accountRemoveOutputContract: OperationOutputContract = {
  operation: 'account.remove',
  shapeNote:
    'Mutate envelope: count=1 + deleted=[provider:label] when an account was removed; count=0 + [] when absent (idempotent).',
  dataSchema: {
    type: 'object',
    required: ['count', 'deleted'],
    additionalProperties: true,
    properties: {
      count: { type: 'number', description: '1 when an account was deleted, else 0.' },
      deleted: {
        type: 'array',
        items: { type: 'string' },
        description: 'The `provider:label` identifier(s) deleted.',
      },
    },
  },
  fieldPointers: ['/data/count', '/data/deleted/0'],
};

// ---------------------------------------------------------------------------
// provider.list — declarative provider rows (the providers table, #1039)
// ---------------------------------------------------------------------------

/** The NON-SECRET per-provider view schema (shared by list + show). */
const PROVIDER_VIEW_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['id', 'displayName', 'aliases', 'authMethods'],
  additionalProperties: true,
  properties: {
    id: { type: 'string', description: 'Canonical provider key (e.g. anthropic).' },
    displayName: { type: 'string' },
    aliases: { type: 'array', items: { type: 'string' }, description: 'Case-insensitive aliases.' },
    authMethods: {
      type: 'array',
      items: { type: 'string' },
      description: 'Supported auth methods (api_key | oauth | aws_sdk).',
    },
    modelsDevId: { type: 'string', description: 'models.dev catalog provider key.' },
    source: { type: 'string', description: 'Provenance (seed | plugin | import).' },
  },
};

/** Accepted input shape for `provider.list`. */
export const PROVIDER_LIST_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: [],
  additionalProperties: false,
  properties: {},
};

/** Schema-first INPUT contract for `provider.list`. */
export const providerListInputContract: OperationInputContract<Record<string, unknown>> = {
  operation: 'provider.list',
  schema: PROVIDER_LIST_INPUT_SCHEMA,
  examples: [{ name: 'all', value: {}, description: 'List every declarative provider.' }],
};

/** OUTPUT contract for `provider.list` — declarative provider views. */
export const providerListOutputContract: OperationOutputContract = {
  operation: 'provider.list',
  shapeNote: 'providers[] are declarative NON-SECRET views (id/displayName/aliases/authMethods).',
  dataSchema: {
    type: 'object',
    required: ['providers'],
    additionalProperties: true,
    properties: {
      providers: { type: 'array', items: PROVIDER_VIEW_SCHEMA, description: 'Provider views.' },
    },
  },
  fieldPointers: [
    '/data/providers',
    '/data/providers/0/id',
    '/data/providers/0/displayName',
    '/data/providers/0/aliases',
  ],
};

// ---------------------------------------------------------------------------
// provider.show — one provider resolved by id or alias
// ---------------------------------------------------------------------------

/** Accepted input shape for `provider.show`. */
export const PROVIDER_SHOW_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['provider'],
  additionalProperties: false,
  properties: {
    provider: {
      type: 'string',
      minLength: 1,
      description: 'Provider id OR a case-insensitive alias (resolved against the alias index).',
    },
  },
};

/** Schema-first INPUT contract for `provider.show`. */
export const providerShowInputContract: OperationInputContract<Record<string, unknown>> = {
  operation: 'provider.show',
  schema: PROVIDER_SHOW_INPUT_SCHEMA,
  examples: [
    { name: 'by-id', value: { provider: 'anthropic' }, description: 'Resolve by canonical id.' },
    { name: 'by-alias', value: { provider: 'claude' }, description: 'Resolve by alias.' },
  ],
};

/** OUTPUT contract for `provider.show` — the resolved provider + the alias matched. */
export const providerShowOutputContract: OperationOutputContract = {
  operation: 'provider.show',
  shapeNote:
    '`provider` is the resolved declarative view; `resolvedFrom` echoes the alias/id the lookup matched.',
  dataSchema: {
    type: 'object',
    required: ['provider', 'resolvedFrom'],
    additionalProperties: true,
    properties: {
      provider: PROVIDER_VIEW_SCHEMA,
      resolvedFrom: { type: 'string', description: 'The id/alias the lookup matched.' },
    },
  },
  fieldPointers: ['/data/provider/id', '/data/provider/displayName', '/data/resolvedFrom'],
};

// ---------------------------------------------------------------------------
// provider.connect — connect a provider (delegates to account.add or OAuth)
// ---------------------------------------------------------------------------

/** Accepted input shape for `provider.connect`. */
export const PROVIDER_CONNECT_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['provider'],
  additionalProperties: false,
  properties: {
    provider: { type: 'string', minLength: 1, description: 'Provider id or alias to connect.' },
    token: {
      type: 'string',
      description: 'Direct API key / bearer token to store (token-direct mode). SECRET.',
    },
    label: {
      type: 'string',
      description: "Account label to create (default: 'default').",
    },
    authType: {
      type: 'string',
      enum: ['api_key', 'oauth', 'aws_sdk'],
      description: 'Explicit auth-type override.',
    },
  },
};

/** Schema-first INPUT contract for `provider.connect`. */
export const providerConnectInputContract: OperationInputContract<Record<string, unknown>> = {
  operation: 'provider.connect',
  schema: PROVIDER_CONNECT_INPUT_SCHEMA,
  examples: [
    {
      name: 'token-direct',
      value: { provider: 'anthropic', token: 'sk-ant-xxx' },
      description: 'Connect a provider by storing a token as the default account.',
    },
  ],
};

/** OUTPUT contract for `provider.connect` — the NON-SECRET account identity. */
export const providerConnectOutputContract: OperationOutputContract = {
  operation: 'provider.connect',
  shapeNote:
    'Mutate envelope: count=1 + created=[provider:label]. `account` carries the redacted NON-SECRET view. The raw token is NEVER returned.',
  dataSchema: {
    type: 'object',
    required: ['count', 'created'],
    additionalProperties: true,
    properties: {
      count: { type: 'number', description: 'Number of accounts created/updated (1).' },
      created: {
        type: 'array',
        items: { type: 'string' },
        description: 'The provider:label id(s).',
      },
      account: ACCOUNT_VIEW_SCHEMA,
    },
  },
  fieldPointers: ['/data/count', '/data/created/0', '/data/account/tokenPreview'],
};

// ---------------------------------------------------------------------------
// model.query — read the models.dev catalog (the models_catalog table, #1037)
// ---------------------------------------------------------------------------

/** The per-model catalog view schema (shared by query + show). */
const MODEL_VIEW_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['id', 'providerId', 'name', 'releaseDate'],
  additionalProperties: true,
  properties: {
    id: { type: 'string', description: 'Model id (catalog key).' },
    providerId: { type: 'string', description: 'Provider key (models.dev id).' },
    name: { type: 'string', description: 'Human-readable display name.' },
    family: { type: 'string' },
    releaseDate: { type: 'string', description: 'ISO release date YYYY-MM-DD.' },
    contextLimit: { type: ['number', 'null'] },
    outputLimit: { type: ['number', 'null'] },
    status: { type: 'string', description: 'Lifecycle (stable | beta | preview | …).' },
  },
};

/** Accepted input shape for `model.query`. */
export const MODEL_QUERY_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: [],
  additionalProperties: false,
  properties: {
    provider: {
      type: 'string',
      description: 'Optional provider filter (models.dev id); queries all providers when omitted.',
    },
    limit: {
      type: 'number',
      description: 'Optional cap on the number of rows returned (newest-first).',
    },
  },
};

/** Schema-first INPUT contract for `model.query`. */
export const modelQueryInputContract: OperationInputContract<Record<string, unknown>> = {
  operation: 'model.query',
  schema: MODEL_QUERY_INPUT_SCHEMA,
  examples: [
    { name: 'all', value: {}, description: 'Query the entire models.dev catalog.' },
    {
      name: 'one-provider',
      value: { provider: 'anthropic', limit: 10 },
      description: 'Query the 10 newest models for one provider.',
    },
  ],
};

/** OUTPUT contract for `model.query` — catalog model views. */
export const modelQueryOutputContract: OperationOutputContract = {
  operation: 'model.query',
  shapeNote:
    'models[] are catalog views ordered newest-first by release_date. `count` is the number returned.',
  dataSchema: {
    type: 'object',
    required: ['models', 'count'],
    additionalProperties: true,
    properties: {
      models: { type: 'array', items: MODEL_VIEW_SCHEMA, description: 'Catalog model views.' },
      count: { type: 'number', description: 'Number of models returned.' },
    },
  },
  fieldPointers: ['/data/models', '/data/models/0/id', '/data/models/0/providerId', '/data/count'],
};

// ---------------------------------------------------------------------------
// model.show — one catalog model resolved by id
// ---------------------------------------------------------------------------

/** Accepted input shape for `model.show`. */
export const MODEL_SHOW_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['model'],
  additionalProperties: false,
  properties: {
    model: { type: 'string', minLength: 1, description: 'Model id (catalog key) to resolve.' },
  },
};

/** Schema-first INPUT contract for `model.show`. */
export const modelShowInputContract: OperationInputContract<Record<string, unknown>> = {
  operation: 'model.show',
  schema: MODEL_SHOW_INPUT_SCHEMA,
  examples: [
    {
      name: 'by-id',
      value: { model: 'claude-3-5-haiku-latest' },
      description: 'Resolve a single catalog model by id.',
    },
  ],
};

/** OUTPUT contract for `model.show` — one catalog model. */
export const modelShowOutputContract: OperationOutputContract = {
  operation: 'model.show',
  shapeNote: '`model` is the resolved catalog view; `found` is false when the id is absent.',
  dataSchema: {
    type: 'object',
    required: ['found'],
    additionalProperties: true,
    properties: {
      found: { type: 'boolean', description: 'True IFF the model id resolved to a catalog row.' },
      model: { ...MODEL_VIEW_SCHEMA, type: ['object', 'null'] },
    },
  },
  fieldPointers: ['/data/found', '/data/model/id', '/data/model/providerId'],
};

// ---------------------------------------------------------------------------
// profile.create — bind an account + model into a named profile
// ---------------------------------------------------------------------------

/** Accepted input shape for `profile.create`. */
export const PROFILE_CREATE_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['name', 'provider', 'model'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, description: 'Profile name (the addressable handle).' },
    provider: {
      type: 'string',
      minLength: 1,
      description: 'Provider transport the bound account belongs to.',
    },
    model: {
      type: 'string',
      minLength: 1,
      description: 'Model id to bind (validated vs catalog).',
    },
    label: {
      type: 'string',
      description: 'Account label to pin (the credential binding). Validated to exist.',
    },
    role: {
      type: 'string',
      description: 'Optional role this profile occupies (extraction | consolidation | …).',
    },
  },
};

/** Schema-first INPUT contract for `profile.create`. */
export const profileCreateInputContract: OperationInputContract<Record<string, unknown>> = {
  operation: 'profile.create',
  schema: PROFILE_CREATE_INPUT_SCHEMA,
  examples: [
    {
      name: 'create',
      value: {
        name: 'fast',
        provider: 'anthropic',
        model: 'claude-3-5-haiku-latest',
        label: 'work',
      },
      description: 'Bind an account + model into a named, addressable profile.',
    },
  ],
};

/** OUTPUT contract for `profile.create` — the persisted binding. */
export const profileCreateOutputContract: OperationOutputContract = {
  operation: 'profile.create',
  shapeNote:
    'Mutate envelope: count=1 + created=[name]. `profile` echoes the persisted binding {name, provider, model, credentialLabel?, role?}.',
  dataSchema: {
    type: 'object',
    required: ['count', 'created'],
    additionalProperties: true,
    properties: {
      count: { type: 'number' },
      created: { type: 'array', items: { type: 'string' } },
      profile: {
        type: 'object',
        additionalProperties: true,
        properties: {
          name: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
          credentialLabel: { type: ['string', 'null'] },
          role: { type: ['string', 'null'] },
        },
      },
    },
  },
  fieldPointers: [
    '/data/count',
    '/data/created/0',
    '/data/profile/name',
    '/data/profile/provider',
    '/data/profile/model',
  ],
};

// ---------------------------------------------------------------------------
// profile.list — named profiles from config (llm.profiles)
// ---------------------------------------------------------------------------

/** Accepted input shape for `profile.list`. */
export const PROFILE_LIST_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: [],
  additionalProperties: false,
  properties: {},
};

/** Schema-first INPUT contract for `profile.list`. */
export const profileListInputContract: OperationInputContract<Record<string, unknown>> = {
  operation: 'profile.list',
  schema: PROFILE_LIST_INPUT_SCHEMA,
  examples: [{ name: 'all', value: {}, description: 'List every named profile.' }],
};

/** OUTPUT contract for `profile.list` — named binding views. */
export const profileListOutputContract: OperationOutputContract = {
  operation: 'profile.list',
  shapeNote:
    'profiles[] are the named bindings from llm.profiles (name + provider + model + optional credentialLabel/role).',
  dataSchema: {
    type: 'object',
    required: ['profiles'],
    additionalProperties: true,
    properties: {
      profiles: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'provider', 'model'],
          additionalProperties: true,
          properties: {
            name: { type: 'string' },
            provider: { type: 'string' },
            model: { type: 'string' },
            credentialLabel: { type: ['string', 'null'] },
          },
        },
      },
    },
  },
  fieldPointers: [
    '/data/profiles',
    '/data/profiles/0/name',
    '/data/profiles/0/provider',
    '/data/profiles/0/model',
  ],
};

// ---------------------------------------------------------------------------
// profile.pin — pin a role/system to a named profile
// ---------------------------------------------------------------------------

/** Accepted input shape for `profile.pin`. */
export const PROFILE_PIN_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['name', 'role'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, description: 'Profile name to pin (must exist).' },
    role: {
      type: 'string',
      minLength: 1,
      description: 'Role to pin to this profile (extraction | consolidation | derivation | …).',
    },
  },
};

/** Schema-first INPUT contract for `profile.pin`. */
export const profilePinInputContract: OperationInputContract<Record<string, unknown>> = {
  operation: 'profile.pin',
  schema: PROFILE_PIN_INPUT_SCHEMA,
  examples: [
    {
      name: 'pin',
      value: { name: 'fast', role: 'extraction' },
      description: 'Pin the extraction role to the `fast` profile.',
    },
  ],
};

/** OUTPUT contract for `profile.pin` — the role→profile binding. */
export const profilePinOutputContract: OperationOutputContract = {
  operation: 'profile.pin',
  shapeNote: 'Mutate envelope: count=1 + updated=[role]. `role` + `profile` echo the binding.',
  dataSchema: {
    type: 'object',
    required: ['count', 'updated'],
    additionalProperties: true,
    properties: {
      count: { type: 'number' },
      updated: { type: 'array', items: { type: 'string' } },
      role: { type: 'string' },
      profile: { type: 'string' },
    },
  },
  fieldPointers: ['/data/count', '/data/updated/0', '/data/role', '/data/profile'],
};

// ---------------------------------------------------------------------------
// profile.use — set a named profile as the global default binding
// ---------------------------------------------------------------------------

/** Accepted input shape for `profile.use`. */
export const PROFILE_USE_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: {
      type: 'string',
      minLength: 1,
      description: 'Profile name to mark as default (must exist).',
    },
  },
};

/** Schema-first INPUT contract for `profile.use`. */
export const profileUseInputContract: OperationInputContract<Record<string, unknown>> = {
  operation: 'profile.use',
  schema: PROFILE_USE_INPUT_SCHEMA,
  examples: [
    { name: 'use', value: { name: 'fast' }, description: 'Make `fast` the default profile.' },
  ],
};

/** OUTPUT contract for `profile.use` — the default-profile binding. */
export const profileUseOutputContract: OperationOutputContract = {
  operation: 'profile.use',
  shapeNote:
    'Mutate envelope: count=1 + updated=[defaultProfile]. `profile` echoes the new default.',
  dataSchema: {
    type: 'object',
    required: ['count', 'updated'],
    additionalProperties: true,
    properties: {
      count: { type: 'number' },
      updated: { type: 'array', items: { type: 'string' } },
      profile: { type: 'string', description: 'The profile name set as default.' },
      scope: { type: 'string', enum: ['global'] },
    },
  },
  fieldPointers: ['/data/count', '/data/updated/0', '/data/profile'],
};
