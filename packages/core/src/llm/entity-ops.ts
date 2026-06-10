/**
 * 5-entity provider-experience engine ops (T11700 · epic T11666).
 *
 * The CORE engine layer behind the addressable provider-experience surface the
 * North-Star design needs (§2 — Provider / Alias / Account / Model / Profile).
 * Each function takes a single typed `params` object and returns a
 * `Promise<EngineResult<T>>` so the dispatch handlers (`packages/cleo`) stay thin
 * delegates (Gate-6) and the result is wrapped uniformly.
 *
 * ## What this module is (and is NOT)
 *
 * This is the THIN composition layer: it delegates to the ALREADY-MERGED
 * accessors rather than re-implementing storage:
 *
 *   - **Account** (the credential pool — secret-bearing): reuses the proven
 *     `cli-ops.ts` engine ops (`llmAdd` / `llmList` / `llmRemove`), which redact
 *     every secret to a `tokenPreview` (last-4) via the sealed-handle. NO raw
 *     token EVER leaves this module.
 *   - **Provider** (the `providers` table, #1039): reads the declarative provider
 *     rows + the case-insensitive alias index via `openDualScopeDb('global')`.
 *   - **Model** (the `models_catalog` table, #1037): queries the catalog rows via
 *     the SAME global chokepoint.
 *   - **Profile** (the named binding `account + model (+ params + role)`): persists
 *     into config under `llm.profiles[name]` — the resolver-consumed SSoT
 *     (`role-resolver.ts`) — via `setConfigValue` / `loadConfig`.
 *
 * ## Secrets never surfaced
 *
 * `accountAdd` accepts a SECRET token, but its result is the SAME redacted view
 * `accountList` returns — `tokenPreview` ONLY. Every error string is scrubbed via
 * `safeErrMessage` (the `cli-ops.ts` redaction). There is no code path that
 * returns a plaintext secret.
 *
 * @module llm/entity-ops
 * @epic T11666
 * @task T11700
 */

import {
  type EngineResult,
  engineError,
  engineSuccess,
  type ModelTransport,
  type StoredAuthTypeWire,
  WHOAMI_ROLE_IDS,
} from '@cleocode/contracts';
import { loadConfig, setConfigValue } from '../config.js';
import { openDualScopeDb } from '../store/dual-scope-db.js';
import { catalogKeyForProvider, validateModelForProvider } from './catalog-model-resolver.js';
import { llmAdd, llmList, llmRemove } from './cli-ops.js';

// ---------------------------------------------------------------------------
// Account ops — the credential pool (secret-bearing). Delegate to cli-ops.ts so
// every secret stays redacted to a `tokenPreview` (last-4) by construction.
// ---------------------------------------------------------------------------

/** Parameters for `account.add` — store a pooled credential (SECRET-BEARING). */
export interface AccountAddParams {
  /** LLM provider transport key. */
  provider: ModelTransport;
  /** API key / OAuth bearer token to persist. SECRET — never echoed. */
  token: string;
  /** Account label, unique within the provider (default: `'default'`). */
  label?: string;
  /** Optional override for the provider base URL. */
  baseUrl?: string;
  /** Explicit auth-type override (auto-detected from the token prefix when omitted). */
  authType?: StoredAuthTypeWire;
  /** Optional priority override (lower wins). */
  priority?: number;
}

/**
 * `account.add` — store a pooled credential, returning the redacted NON-SECRET view.
 *
 * Delegates to {@link llmAdd} (the proven pool writer) so the result is the
 * already-redacted `tokenPreview` view. NO raw token is ever surfaced.
 *
 * @task T11700
 */
export async function accountAdd(
  params: AccountAddParams,
): Promise<EngineResult<{ account: unknown; detectedAuthType: StoredAuthTypeWire }>> {
  const result = await llmAdd({
    provider: params.provider,
    apiKey: params.token,
    ...(params.label !== undefined ? { label: params.label } : {}),
    ...(params.baseUrl !== undefined ? { baseUrl: params.baseUrl } : {}),
    ...(params.authType !== undefined ? { authType: params.authType } : {}),
    ...(params.priority !== undefined ? { priority: params.priority } : {}),
  });
  if (!result.success) return result;
  return engineSuccess({
    account: result.data.credential,
    detectedAuthType: result.data.detectedAuthType,
  });
}

/** Parameters for `account.list`. */
export interface AccountListParams {
  /** Optional provider filter; lists all providers when omitted. */
  provider?: ModelTransport;
}

/**
 * `account.list` — list redacted accounts, optionally filtered by provider.
 *
 * Delegates to {@link llmList}; the view carries `tokenPreview` ONLY — the
 * decrypted secret is NEVER present in any field.
 *
 * @task T11700
 */
export async function accountList(
  params: AccountListParams,
): Promise<EngineResult<{ accounts: unknown[] }>> {
  const result = await llmList(params.provider !== undefined ? { provider: params.provider } : {});
  if (!result.success) return result;
  return engineSuccess({ accounts: result.data.credentials });
}

/** Parameters for `account.remove`. */
export interface AccountRemoveParams {
  /** LLM provider transport key. */
  provider: ModelTransport;
  /** Account label to remove. */
  label: string;
}

/**
 * `account.remove` — delete a `(provider, label)` account from the pool.
 *
 * Returns the canonical `{count, deleted}` mutate envelope.
 *
 * @task T11700
 */
export async function accountRemove(
  params: AccountRemoveParams,
): Promise<EngineResult<{ count: number; deleted: string[] }>> {
  const result = await llmRemove({ provider: params.provider, label: params.label });
  if (!result.success) return result;
  const removed = result.data.removed;
  return engineSuccess({
    count: removed ? 1 : 0,
    deleted: removed ? [`${params.provider}:${params.label}`] : [],
  });
}

// ---------------------------------------------------------------------------
// Provider ops — the declarative `providers` table (#1039).
// ---------------------------------------------------------------------------

/** The NON-SECRET declarative provider view returned by list/show. */
interface ProviderView {
  id: string;
  displayName: string;
  aliases: string[];
  authMethods: string[];
  modelsDevId: string;
  source: string;
}

/** Parse a JSON-string array column to `string[]`, tolerating malformed input. */
function parseStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Map a `providers` row to the NON-SECRET {@link ProviderView}. */
function providerRowToView(row: {
  id: string;
  displayName: string;
  aliases: string;
  authMethods: string;
  modelsDevId: string;
  source: string;
}): ProviderView {
  return {
    id: row.id,
    displayName: row.displayName,
    aliases: parseStringArray(row.aliases),
    authMethods: parseStringArray(row.authMethods),
    modelsDevId: row.modelsDevId,
    source: row.source,
  };
}

/** Read every declarative provider row as a NON-SECRET view. */
async function readProviderViews(): Promise<ProviderView[]> {
  const { providers } = await import('../store/schema/cleo-global/providers.js');
  const handle = await openDualScopeDb('global');
  const rows = await handle.db
    .select({
      id: providers.id,
      displayName: providers.displayName,
      aliases: providers.aliases,
      authMethods: providers.authMethods,
      modelsDevId: providers.modelsDevId,
      source: providers.source,
    })
    .from(providers);
  return rows.map(providerRowToView);
}

/** Parameters for `provider.list` (no declared params). */
export type ProviderListParams = Record<string, never>;

/**
 * `provider.list` — list every declarative provider as a NON-SECRET view.
 *
 * @task T11700
 */
export async function providerList(
  _params: ProviderListParams,
): Promise<EngineResult<{ providers: ProviderView[] }>> {
  try {
    return engineSuccess({ providers: await readProviderViews() });
  } catch (err) {
    return engineError('E_PROVIDER_READ_FAILED', err instanceof Error ? err.message : String(err));
  }
}

/** Parameters for `provider.show`. */
export interface ProviderShowParams {
  /** Provider id OR a case-insensitive alias. */
  provider: string;
}

/**
 * `provider.show` — resolve ONE provider by id or case-insensitive alias.
 *
 * The alias index is the declarative `aliases` JSON column on each row; the
 * lookup matches the id first, then any alias (case-insensitive).
 *
 * @task T11700
 */
export async function providerShow(
  params: ProviderShowParams,
): Promise<EngineResult<{ provider: ProviderView; resolvedFrom: string }>> {
  const query = params.provider.trim();
  if (!query) return engineError('E_INVALID_INPUT', 'provider is required');
  try {
    const views = await readProviderViews();
    const needle = query.toLowerCase();
    const match = views.find(
      (v) => v.id.toLowerCase() === needle || v.aliases.some((a) => a.toLowerCase() === needle),
    );
    if (!match) {
      return engineError('E_NOT_FOUND', `No provider matches '${query}' (by id or alias)`);
    }
    return engineSuccess({ provider: match, resolvedFrom: query });
  } catch (err) {
    return engineError('E_PROVIDER_READ_FAILED', err instanceof Error ? err.message : String(err));
  }
}

/** Parameters for `provider.connect`. */
export interface ProviderConnectParams {
  /** Provider id or alias to connect. */
  provider: string;
  /** Direct API key / bearer token to store (token-direct mode). SECRET. */
  token?: string;
  /** Account label to create (default: `'default'`). */
  label?: string;
  /** Explicit auth-type override. */
  authType?: StoredAuthTypeWire;
}

/**
 * `provider.connect` — connect a provider by storing a token as one of its accounts.
 *
 * Resolves the provider (id or alias), then delegates to {@link accountAdd} for
 * the secret-bearing write. The result is the NON-SECRET account identity — the
 * raw token NEVER crosses this boundary.
 *
 * @task T11700
 */
export async function providerConnect(
  params: ProviderConnectParams,
): Promise<EngineResult<{ count: number; created: string[]; account: unknown }>> {
  if (!params.token) {
    return engineError(
      'E_INVALID_INPUT',
      'provider.connect requires --token (token-direct). OAuth flows route through `cleo service`.',
    );
  }
  // Resolve the provider so an alias maps to its canonical id before we store.
  const resolved = await providerShow({ provider: params.provider });
  if (!resolved.success) return resolved;
  const providerId = resolved.data.provider.id;
  const label = params.label?.trim() ? params.label.trim() : 'default';
  const added = await accountAdd({
    provider: providerId as ModelTransport,
    token: params.token,
    label,
    ...(params.authType !== undefined ? { authType: params.authType } : {}),
  });
  if (!added.success) return added;
  return engineSuccess({
    count: 1,
    created: [`${providerId}:${label}`],
    account: added.data.account,
  });
}

// ---------------------------------------------------------------------------
// Model ops — the models.dev catalog (`models_catalog` table, #1037).
// ---------------------------------------------------------------------------

/** A NON-SECRET catalog model view returned by query/show. */
interface ModelView {
  id: string;
  providerId: string;
  name: string;
  family: string;
  releaseDate: string;
  contextLimit: number | null;
  outputLimit: number | null;
  status: string;
}

/** Parameters for `model.query`. */
export interface ModelQueryParams {
  /** Optional provider filter (models.dev id). */
  provider?: string;
  /** Optional cap on the number of rows returned (newest-first). */
  limit?: number;
}

/**
 * `model.query` — read the `models_catalog` table, newest-first by release date.
 *
 * Optionally filtered by provider (models.dev id) and capped by `limit`. Reads
 * through the global chokepoint (`openDualScopeDb('global')`).
 *
 * @task T11700
 */
export async function modelQuery(
  params: ModelQueryParams,
): Promise<EngineResult<{ models: ModelView[]; count: number }>> {
  try {
    const { desc, eq } = await import('drizzle-orm');
    const { modelsCatalog } = await import('../store/schema/cleo-global/models-catalog.js');
    const handle = await openDualScopeDb('global');
    const select = handle.db
      .select({
        id: modelsCatalog.id,
        providerId: modelsCatalog.providerId,
        name: modelsCatalog.name,
        family: modelsCatalog.family,
        releaseDate: modelsCatalog.releaseDate,
        contextLimit: modelsCatalog.contextLimit,
        outputLimit: modelsCatalog.outputLimit,
        status: modelsCatalog.status,
      })
      .from(modelsCatalog)
      .orderBy(desc(modelsCatalog.releaseDate), desc(modelsCatalog.id))
      .$dynamic();
    const filtered =
      params.provider !== undefined
        ? select.where(eq(modelsCatalog.providerId, params.provider))
        : select;
    const limited =
      typeof params.limit === 'number' && params.limit > 0
        ? filtered.limit(params.limit)
        : filtered;
    const rows = await limited;
    const models: ModelView[] = rows.map((r) => ({
      id: r.id,
      providerId: r.providerId,
      name: r.name,
      family: r.family,
      releaseDate: r.releaseDate,
      contextLimit: r.contextLimit ?? null,
      outputLimit: r.outputLimit ?? null,
      status: r.status,
    }));
    return engineSuccess({ models, count: models.length });
  } catch (err) {
    return engineError('E_MODEL_READ_FAILED', err instanceof Error ? err.message : String(err));
  }
}

/** Parameters for `model.show`. */
export interface ModelShowParams {
  /** Model id (catalog key) to resolve. */
  model: string;
}

/**
 * `model.show` — resolve ONE catalog model by id.
 *
 * Returns `{ found: false, model: null }` (not an error) when the id is absent,
 * mirroring the `admin.config.get` "found" convention.
 *
 * @task T11700
 */
export async function modelShow(
  params: ModelShowParams,
): Promise<EngineResult<{ found: boolean; model: ModelView | null }>> {
  const id = params.model.trim();
  if (!id) return engineError('E_INVALID_INPUT', 'model is required');
  try {
    const { eq } = await import('drizzle-orm');
    const { modelsCatalog } = await import('../store/schema/cleo-global/models-catalog.js');
    const handle = await openDualScopeDb('global');
    const rows = await handle.db
      .select({
        id: modelsCatalog.id,
        providerId: modelsCatalog.providerId,
        name: modelsCatalog.name,
        family: modelsCatalog.family,
        releaseDate: modelsCatalog.releaseDate,
        contextLimit: modelsCatalog.contextLimit,
        outputLimit: modelsCatalog.outputLimit,
        status: modelsCatalog.status,
      })
      .from(modelsCatalog)
      .where(eq(modelsCatalog.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return engineSuccess({ found: false, model: null });
    return engineSuccess({
      found: true,
      model: {
        id: row.id,
        providerId: row.providerId,
        name: row.name,
        family: row.family,
        releaseDate: row.releaseDate,
        contextLimit: row.contextLimit ?? null,
        outputLimit: row.outputLimit ?? null,
        status: row.status,
      },
    });
  } catch (err) {
    return engineError('E_MODEL_READ_FAILED', err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Profile ops — the named binding `account + model (+ params + role)`, persisted
// into config under `llm.profiles[name]` (the resolver-consumed SSoT).
// ---------------------------------------------------------------------------

/** The persisted profile binding echoed back to callers. */
interface ProfileView {
  name: string;
  provider: string;
  model: string;
  credentialLabel: string | null;
  role: string | null;
}

/** Parameters for `profile.create`. */
export interface ProfileCreateParams {
  /** Profile name (the addressable handle). */
  name: string;
  /** Provider transport the bound account belongs to. */
  provider: ModelTransport;
  /** Model id to bind (validated against the catalog). */
  model: string;
  /** Account label to pin (the credential binding). Validated to exist. */
  label?: string;
  /** Optional role this profile occupies. */
  role?: string;
}

/**
 * `profile.create` — bind an account + model into a named profile.
 *
 * Validates the binding: (1) when a `label` is supplied, the account
 * `(provider, label)` MUST exist; (2) the `model` MUST be in the catalog for the
 * provider (soft-passes when the catalog snapshot is absent). Persists into
 * `llm.profiles[name]` — the resolver-consumed SSoT.
 *
 * @task T11700
 */
export async function profileCreate(
  params: ProfileCreateParams,
): Promise<EngineResult<{ count: number; created: string[]; profile: ProfileView }>> {
  const name = params.name.trim();
  if (!name) return engineError('E_INVALID_INPUT', 'profile name is required');

  // (1) Validate the account binding when a label is pinned.
  if (params.label) {
    const accounts = await accountList({ provider: params.provider });
    if (!accounts.success) return accounts;
    const has = accounts.data.accounts.some(
      (a) => (a as { label?: string }).label === params.label,
    );
    if (!has) {
      return engineError(
        'E_ACCOUNT_NOT_FOUND',
        `No account '${params.provider}:${params.label}'. Add one with \`cleo account add\` first.`,
      );
    }
  }

  // (2) Validate the model against the catalog for the provider.
  const catalogKey = catalogKeyForProvider(params.provider);
  const validation = validateModelForProvider(params.model, catalogKey);
  if (!validation.valid && validation.reason === 'not-found') {
    return engineError(
      'E_MODEL_NOT_IN_CATALOG',
      `Model '${params.model}' is not in the catalog for provider '${params.provider}'. ` +
        'Run `cleo llm refresh-catalog` to update the catalog.',
    );
  }

  try {
    await setConfigValue(`llm.profiles.${name}.provider`, params.provider, undefined, {
      global: true,
    });
    await setConfigValue(`llm.profiles.${name}.model`, params.model, undefined, { global: true });
    if (params.label) {
      await setConfigValue(`llm.profiles.${name}.credentialLabel`, params.label, undefined, {
        global: true,
      });
    }
    const profile: ProfileView = {
      name,
      provider: params.provider,
      model: params.model,
      credentialLabel: params.label ?? null,
      role: params.role ?? null,
    };
    return engineSuccess({ count: 1, created: [name], profile });
  } catch (err) {
    return engineError('E_CONFIG_WRITE_FAILED', err instanceof Error ? err.message : String(err));
  }
}

/** Parameters for `profile.list` (no declared params). */
export type ProfileListParams = Record<string, never>;

/**
 * `profile.list` — list every named profile from `llm.profiles`.
 *
 * @task T11700
 */
export async function profileList(_params: ProfileListParams): Promise<
  EngineResult<{
    profiles: Array<{
      name: string;
      provider: string;
      model: string;
      credentialLabel: string | null;
    }>;
  }>
> {
  try {
    const config = await loadConfig();
    const profilesBlock = config.llm?.profiles ?? {};
    const profiles = Object.entries(profilesBlock).map(([name, p]) => ({
      name,
      provider: p.provider,
      model: p.model,
      credentialLabel: p.credentialLabel ?? null,
    }));
    return engineSuccess({ profiles });
  } catch (err) {
    return engineError('E_CONFIG_READ_FAILED', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Resolve whether a named profile exists in `llm.profiles`.
 *
 * @internal
 */
async function profileExists(name: string): Promise<boolean> {
  const config = await loadConfig();
  return Object.hasOwn(config.llm?.profiles ?? {}, name);
}

/** Parameters for `profile.pin`. */
export interface ProfilePinParams {
  /** Profile name to pin (must exist). */
  name: string;
  /** Role to pin to this profile. */
  role: string;
}

/**
 * `profile.pin` — pin a role to a named profile (`llm.roles[role].profile`).
 *
 * The role MUST be a valid background role; the profile MUST already exist.
 *
 * @task T11700
 */
export async function profilePin(
  params: ProfilePinParams,
): Promise<EngineResult<{ count: number; updated: string[]; role: string; profile: string }>> {
  const name = params.name.trim();
  const role = params.role.trim();
  if (!name) return engineError('E_INVALID_INPUT', 'profile name is required');
  const validRoles: readonly string[] = WHOAMI_ROLE_IDS;
  if (!validRoles.includes(role)) {
    return engineError(
      'E_INVALID_INPUT',
      `Invalid role '${role}'. Valid roles: ${WHOAMI_ROLE_IDS.join(', ')}`,
    );
  }
  if (!(await profileExists(name))) {
    return engineError(
      'E_NOT_FOUND',
      `No profile '${name}'. Create it with \`cleo profile create\`.`,
    );
  }
  try {
    await setConfigValue(`llm.roles.${role}.profile`, name, undefined, { global: true });
    return engineSuccess({ count: 1, updated: [role], role, profile: name });
  } catch (err) {
    return engineError('E_CONFIG_WRITE_FAILED', err instanceof Error ? err.message : String(err));
  }
}

/** Parameters for `profile.use`. */
export interface ProfileUseParams {
  /** Profile name to mark as default (must exist). */
  name: string;
}

/**
 * `profile.use` — set a named profile as the global default binding
 * (`llm.defaultProfile`).
 *
 * The profile MUST already exist.
 *
 * @task T11700
 */
export async function profileUse(
  params: ProfileUseParams,
): Promise<EngineResult<{ count: number; updated: string[]; profile: string; scope: 'global' }>> {
  const name = params.name.trim();
  if (!name) return engineError('E_INVALID_INPUT', 'profile name is required');
  if (!(await profileExists(name))) {
    return engineError(
      'E_NOT_FOUND',
      `No profile '${name}'. Create it with \`cleo profile create\`.`,
    );
  }
  try {
    await setConfigValue('llm.defaultProfile', name, undefined, { global: true });
    return engineSuccess({ count: 1, updated: [name], profile: name, scope: 'global' });
  } catch (err) {
    return engineError('E_CONFIG_WRITE_FAILED', err instanceof Error ? err.message : String(err));
  }
}
