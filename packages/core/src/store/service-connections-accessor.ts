/**
 * Service-vault accessor — store-level CRUD + policy-before-decrypt egress.
 *
 * EP-UNIVERSAL-SERVICE-VAULT (epic T11765 · saga SG-VAULT-CORE T10409 · M2 W1a ·
 * task T11937 · AC3). The store layer for the universal SERVICE-credential vault
 * (`service_connections` / `service_configs` / `agent_service_grants`).
 *
 * ## DB Open Guard (Gate 3 — strict)
 *
 * EVERY open goes through {@link openDualScopeDb}`('global')` (or its path-aware
 * sibling {@link openDualScopeDbAtPath} for an injected test DB) — there is ZERO
 * raw `new DatabaseSync(`. The typed Drizzle handle drives all CRUD; the accessor
 * never constructs a native handle itself.
 *
 * ## Crypto reuse (DRY — no new crypto · T11710)
 *
 * `credentials_enc` holds the {@link encryptGlobal} ciphertext of the
 * `{access_token, refresh_token}` JSON, keyed `id = service:${provider}:${label}`.
 * The accessor calls {@link encryptGlobal}/{@link decryptGlobal} from
 * `crypto/credentials.ts` — it adds no crypto of its own. The crypto functions are
 * injectable ({@link ServiceVaultDeps}) so a test can spy on `decryptGlobal` and
 * PROVE it is never invoked on a denied access (policy-before-decrypt, AC4).
 *
 * ## Policy-before-decrypt egress (AC4)
 *
 * {@link resolveSealedConnection} evaluates the {@link evaluateServiceAccess}
 * trust gate FIRST (a pure decision from the agent's grant rows). It calls
 * `decryptGlobal` ONLY when the gate returns `allowed: true`. A denied agent
 * returns `null` BEFORE the decrypt call — the decrypt closure never runs. On
 * allow, the plaintext is not surfaced inline: it is wrapped in a
 * {@link makeSealedCredential} handle whose `resolveToken` thunk performs the
 * decrypt at the wire (the same egress the LLM credential pool uses).
 *
 * ## OAuth seam (T11939)
 *
 * The OAuth build/exchange/refresh dance is the FOLLOW-UP (T11939). This accessor
 * leaves the clean seam: {@link connectService} accepts an already-obtained token
 * blob and writes its `encryptGlobal` ciphertext into `credentials_enc`; the OAuth
 * flow simply calls `connectService` (or `updateConnectionCredentials`) with the
 * tokens it negotiates. No OAuth logic lives here.
 *
 * @module store/service-connections-accessor
 * @task T11937
 * @epic T11765
 * @saga T10409
 * @see ./schema/cleo-global/services.ts — the three tables
 * @see ./service-trust-gate.ts — the policy-before-decrypt decision
 * @see ../crypto/credentials.ts — `encryptGlobal` / `decryptGlobal` (reused, not re-implemented)
 * @see ../llm/sealed-credential.ts — `makeSealedCredential` (the shared egress handle)
 */

import type { SealedCredential } from '@cleocode/contracts';
import { and, eq } from 'drizzle-orm';
import { decryptGlobal, encryptGlobal } from '../crypto/credentials.js';
import { makeSealedCredential, tokenPreview } from '../llm/sealed-credential.js';
import { type CleoGlobalDb, openDualScopeDb, openDualScopeDbAtPath } from './dual-scope-db.js';
import {
  agentServiceGrants,
  type ServiceConnectionStatus,
  serviceConnections,
} from './schema/cleo-global/services.js';
import {
  evaluateServiceAccess,
  parseSessionPolicy,
  type ServiceGrant,
  type SessionPolicy,
} from './service-trust-gate.js';

/**
 * The token blob persisted (encrypted) in `service_connections.credentials_enc`.
 *
 * Serialized to JSON, encrypted via {@link encryptGlobal}. The OAuth flow (T11939)
 * produces this; this accessor only stores/loads it.
 *
 * @task T11937
 */
export interface ServiceTokenBlob {
  /** The bearer access token. */
  readonly accessToken: string;
  /** The refresh token, when the provider issued one. */
  readonly refreshToken?: string;
}

/**
 * Injectable crypto + DB dependencies — defaults bind the real implementations.
 *
 * The crypto functions are injectable so a test can supply a SPY for
 * `decryptGlobal` and assert it is never called on a denied access (AC4
 * policy-before-decrypt proof).
 *
 * @task T11937
 */
export interface ServiceVaultDeps {
  /** Encrypt a plaintext with the global KDF keyed by `id`. Defaults to {@link encryptGlobal}. */
  readonly encrypt?: (plaintext: string, id: string) => Promise<string>;
  /** Decrypt ciphertext with the global KDF keyed by `id`. Defaults to {@link decryptGlobal}. */
  readonly decrypt?: (ciphertext: string, id: string) => Promise<string>;
  /**
   * An already-open global Drizzle handle. When omitted the accessor opens via
   * {@link openDualScopeDb}`('global')`. Tests pass a temp-DB handle (opened via
   * {@link openServiceVaultAtPath}) to stay off `.cleo/*.db`.
   */
  readonly db?: CleoGlobalDb;
}

/** Parameters for {@link connectService}. */
export interface ConnectServiceParams {
  /** Stable provider key (e.g. `github`). */
  readonly provider: string;
  /** Connection label, unique within the provider (e.g. `personal`). */
  readonly label: string;
  /** The token blob to encrypt + store (from the OAuth flow, T11939). */
  readonly tokens: ServiceTokenBlob;
  /** Granted scopes (non-secret) — stored as JSON. */
  readonly scopes?: readonly string[];
  /** ISO-8601 access-token expiry, if known. */
  readonly expiresAt?: string;
  /** Non-secret metadata (e.g. `{ username, email }`) — stored as JSON. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A non-secret view of a `service_connections` row (NEVER carries the token). */
export interface ServiceConnectionView {
  readonly id: number;
  readonly provider: string;
  readonly label: string;
  readonly status: ServiceConnectionStatus;
  readonly scopes: readonly string[];
  readonly expiresAt: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly connectedAt: string;
  readonly updatedAt: string;
  /** Whether a credential blob has been written (the OAuth flow ran). */
  readonly hasCredentials: boolean;
}

/** The `encryptGlobal`/`decryptGlobal` id for a connection's token blob. */
function credentialId(provider: string, label: string): string {
  return `service:${provider}:${label}`;
}

/**
 * Open the global service-vault handle at an EXPLICIT path (test seam).
 *
 * Production callers MUST use {@link openDualScopeDb}`('global')` (resolved
 * canonical path). This path-aware variant exists so tests open a temp-dir
 * `cleo.db` — never `.cleo/*.db`. Returns the typed global Drizzle handle.
 *
 * @param dbPath - Absolute path to the temp `cleo.db`.
 * @returns The typed {@link CleoGlobalDb} handle.
 * @task T11937
 */
export async function openServiceVaultAtPath(dbPath: string): Promise<CleoGlobalDb> {
  const handle = await openDualScopeDbAtPath('global', dbPath);
  return handle.db;
}

/** Resolve the global Drizzle handle — injected, else canonical open. */
async function resolveDb(deps?: ServiceVaultDeps): Promise<CleoGlobalDb> {
  if (deps?.db !== undefined) return deps.db;
  const handle = await openDualScopeDb('global');
  return handle.db;
}

/**
 * CONNECT a service: encrypt the token blob and upsert the connection row.
 *
 * The token blob is JSON-serialized and {@link encryptGlobal}-encrypted under
 * `id = service:${provider}:${label}` — only the ciphertext is written. On a
 * repeat `connect` for the same `(provider, label)` the row's credentials/scopes/
 * metadata/expiry are REFRESHED in place and `status` is reset to `active` (an
 * expired/revoked connection is re-activated by re-connecting).
 *
 * @returns The connection id.
 * @task T11937
 */
export async function connectService(
  params: ConnectServiceParams,
  deps?: ServiceVaultDeps,
): Promise<number> {
  const db = await resolveDb(deps);
  const encrypt = deps?.encrypt ?? encryptGlobal;
  const id = credentialId(params.provider, params.label);
  const credentialsEnc = await encrypt(JSON.stringify(params.tokens), id);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const scopesJson = JSON.stringify(params.scopes ?? []);
  const metadataJson = JSON.stringify(params.metadata ?? {});

  const existing = await db
    .select({ id: serviceConnections.id })
    .from(serviceConnections)
    .where(
      and(
        eq(serviceConnections.provider, params.provider),
        eq(serviceConnections.label, params.label),
      ),
    )
    .limit(1);

  if (existing.length > 0 && existing[0] !== undefined) {
    const connId = existing[0].id;
    await db
      .update(serviceConnections)
      .set({
        status: 'active',
        credentialsEnc,
        scopes: scopesJson,
        expiresAt: params.expiresAt ?? null,
        metadata: metadataJson,
        updatedAt: now,
      })
      .where(eq(serviceConnections.id, connId));
    return connId;
  }

  const inserted = await db
    .insert(serviceConnections)
    .values({
      provider: params.provider,
      label: params.label,
      status: 'active',
      credentialsEnc,
      scopes: scopesJson,
      expiresAt: params.expiresAt ?? null,
      metadata: metadataJson,
    })
    .returning({ id: serviceConnections.id });
  const row = inserted[0];
  if (row === undefined) {
    throw new Error('service connect: insert returned no id');
  }
  return row.id;
}

/**
 * UPDATE a connection's encrypted token blob + expiry in place (OAuth refresh
 * persistence seam — T11939).
 *
 * The self-heal path ({@link import('./service-oauth.js').selfHealConnection})
 * calls this after a refresh: the new `{accessToken, refreshToken}` blob is
 * {@link encryptGlobal}-encrypted under the SAME `id = service:${provider}:${label}`
 * and written back, with `expires_at` bumped and `status` kept `active`. Only the
 * ciphertext is persisted — exactly like {@link connectService}.
 *
 * @returns `true` if a row was updated, `false` when no such `(provider, label)`.
 * @task T11939
 */
export async function updateConnectionTokens(
  params: {
    readonly provider: string;
    readonly label: string;
    readonly tokens: ServiceTokenBlob;
    readonly expiresAt?: string | null;
  },
  deps?: ServiceVaultDeps,
): Promise<boolean> {
  const db = await resolveDb(deps);
  const encrypt = deps?.encrypt ?? encryptGlobal;
  const id = credentialId(params.provider, params.label);
  const credentialsEnc = await encrypt(JSON.stringify(params.tokens), id);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const updated = await db
    .update(serviceConnections)
    .set({
      credentialsEnc,
      ...(params.expiresAt !== undefined ? { expiresAt: params.expiresAt } : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(serviceConnections.provider, params.provider),
        eq(serviceConnections.label, params.label),
      ),
    )
    .returning({ id: serviceConnections.id });
  return updated.length > 0;
}

/** The decrypted token blob + expiry returned by {@link loadDecryptedTokenBlob}. */
export interface DecryptedConnection {
  /** The connection id. */
  readonly id: number;
  /** The decrypted `{accessToken, refreshToken}` blob (SECRET — never log/serialize). */
  readonly blob: ServiceTokenBlob;
  /** ISO-8601 access-token expiry, or `null` when non-expiring/unknown. */
  readonly expiresAt: string | null;
}

/**
 * RESOLVE a connection's DECRYPTED token blob — **policy-before-decrypt** (T11939).
 *
 * The self-heal seam: the OAuth flow needs the REFRESH token (inside the encrypted
 * blob) plus `expires_at` to decide whether to refresh. Like
 * {@link resolveSealedConnection}, the trust gate runs FIRST and `decryptGlobal`
 * is invoked ONLY on allow — a denied agent gets `null` with NO decrypt. Unlike
 * the sealed resolve, this returns the plaintext blob inline (the caller is the
 * refresh machinery, which re-encrypts immediately) so it MUST NOT cross a
 * logging/serialization boundary.
 *
 * @returns The decrypted blob + expiry on allow; `null` when denied / missing /
 *   not `active` / no stored credential.
 * @task T11939
 */
export async function loadDecryptedTokenBlob(
  params: ResolveServiceParams,
  deps?: ServiceVaultDeps,
): Promise<DecryptedConnection | null> {
  const db = await resolveDb(deps);
  const decrypt = deps?.decrypt ?? decryptGlobal;

  const rows = await db
    .select()
    .from(serviceConnections)
    .where(
      and(
        eq(serviceConnections.provider, params.provider),
        eq(serviceConnections.label, params.label),
      ),
    )
    .limit(1);
  const conn = rows[0];
  if (conn === undefined || conn.status !== 'active' || conn.credentialsEnc === null) {
    return null;
  }

  // POLICY BEFORE DECRYPT — no crypto has run yet.
  const grants = await loadAgentGrants(db, params.agentId);
  const decision = evaluateServiceAccess(grants, {
    agentId: params.agentId,
    serviceConnectionId: conn.id,
    approved: params.approved,
  });
  if (!decision.allowed) {
    return null;
  }

  const id = credentialId(params.provider, params.label);
  const plaintext = await decrypt(conn.credentialsEnc, id);
  const blob = JSON.parse(plaintext) as ServiceTokenBlob;
  return { id: conn.id, blob, expiresAt: conn.expiresAt };
}

/** Map a raw connection row to a non-secret {@link ServiceConnectionView}. */
function toView(row: typeof serviceConnections.$inferSelect): ServiceConnectionView {
  let scopes: string[] = [];
  let metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.scopes);
    if (Array.isArray(parsed)) scopes = parsed.filter((s): s is string => typeof s === 'string');
  } catch {
    // malformed scopes JSON → empty list (non-secret display only)
  }
  try {
    const parsed = JSON.parse(row.metadata);
    if (typeof parsed === 'object' && parsed !== null) {
      metadata = parsed as Record<string, unknown>;
    }
  } catch {
    // malformed metadata JSON → empty object
  }
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    status: row.status,
    scopes,
    expiresAt: row.expiresAt,
    metadata,
    connectedAt: row.connectedAt,
    updatedAt: row.updatedAt,
    hasCredentials: row.credentialsEnc !== null && row.credentialsEnc !== '',
  };
}

/**
 * GET one connection as a non-secret view (NEVER decrypts the token).
 *
 * @returns The view, or `null` when no such `(provider, label)` exists.
 * @task T11937
 */
export async function getConnection(
  provider: string,
  label: string,
  deps?: ServiceVaultDeps,
): Promise<ServiceConnectionView | null> {
  const db = await resolveDb(deps);
  const rows = await db
    .select()
    .from(serviceConnections)
    .where(and(eq(serviceConnections.provider, provider), eq(serviceConnections.label, label)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toView(row);
}

/**
 * LIST connections as non-secret views (NEVER decrypts), optionally by provider.
 *
 * @param provider - When set, restrict to one provider; otherwise all.
 * @task T11937
 */
export async function listConnections(
  provider?: string,
  deps?: ServiceVaultDeps,
): Promise<ServiceConnectionView[]> {
  const db = await resolveDb(deps);
  const rows =
    provider === undefined
      ? await db.select().from(serviceConnections)
      : await db.select().from(serviceConnections).where(eq(serviceConnections.provider, provider));
  return rows.map(toView);
}

/**
 * REVOKE a connection: flip `status` to `revoked` and CLEAR the credential blob.
 *
 * Clearing `credentials_enc` makes the secret unrecoverable (the ciphertext is
 * gone) — a revoke is permanent until a fresh `connect`. The row is kept (not
 * deleted) so grants/audit referencing it remain coherent.
 *
 * @returns `true` if a row was revoked, `false` if no such connection.
 * @task T11937
 */
export async function revokeConnection(
  provider: string,
  label: string,
  deps?: ServiceVaultDeps,
): Promise<boolean> {
  const db = await resolveDb(deps);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const updated = await db
    .update(serviceConnections)
    .set({ status: 'revoked', credentialsEnc: null, updatedAt: now })
    .where(and(eq(serviceConnections.provider, provider), eq(serviceConnections.label, label)))
    .returning({ id: serviceConnections.id });
  return updated.length > 0;
}

/** The non-secret result of {@link deleteConnectionCascade}. */
export interface DeleteConnectionResult {
  /** Whether a `service_connections` row was deleted (`false` ⇒ no such connection). */
  readonly deleted: boolean;
  /** The deleted connection id, or `null` when no row matched. */
  readonly connectionId: number | null;
  /** How many `agent_service_grants` rows were cascaded-deleted alongside it. */
  readonly grantsRemoved: number;
}

/**
 * DELETE a connection and CASCADE its agent grants (the hard `service revoke`).
 *
 * Unlike {@link revokeConnection} (a soft status flip that keeps the row), this
 * REMOVES the `service_connections` row entirely and first deletes every
 * `agent_service_grants` row that references it. The cascade is performed
 * EXPLICITLY in application code — the in-file FK on `service_connection_id` is
 * declared without `ON DELETE CASCADE`, and `foreign_keys` is not assumed ON —
 * so grants are deleted FIRST, then the connection, leaving no dangling grant.
 *
 * @returns A {@link DeleteConnectionResult} reporting the cascade outcome.
 * @task T11941
 */
export async function deleteConnectionCascade(
  provider: string,
  label: string,
  deps?: ServiceVaultDeps,
): Promise<DeleteConnectionResult> {
  const db = await resolveDb(deps);
  const rows = await db
    .select({ id: serviceConnections.id })
    .from(serviceConnections)
    .where(and(eq(serviceConnections.provider, provider), eq(serviceConnections.label, label)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return { deleted: false, connectionId: null, grantsRemoved: 0 };
  }
  const connectionId = row.id;
  // Cascade grants FIRST (no ON DELETE CASCADE on the FK), then the connection.
  const removedGrants = await db
    .delete(agentServiceGrants)
    .where(eq(agentServiceGrants.serviceConnectionId, connectionId))
    .returning({ agentId: agentServiceGrants.agentId });
  await db.delete(serviceConnections).where(eq(serviceConnections.id, connectionId));
  return { deleted: true, connectionId, grantsRemoved: removedGrants.length };
}

/**
 * GRANT an agent access to a connection with a session policy.
 *
 * @param agentId - The agent to grant.
 * @param serviceConnectionId - The connection id (from {@link connectService}).
 * @param policy - The {@link SessionPolicy}; defaults to a bare allow.
 * @task T11937
 */
export async function grantAgentAccess(
  agentId: string,
  serviceConnectionId: number,
  policy: SessionPolicy = { mode: 'allow' },
  deps?: ServiceVaultDeps,
): Promise<void> {
  const db = await resolveDb(deps);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const policyJson = JSON.stringify(policy);
  const existing = await db
    .select({ agentId: agentServiceGrants.agentId })
    .from(agentServiceGrants)
    .where(
      and(
        eq(agentServiceGrants.agentId, agentId),
        eq(agentServiceGrants.serviceConnectionId, serviceConnectionId),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    await db
      .update(agentServiceGrants)
      .set({ sessionPolicy: policyJson, updatedAt: now })
      .where(
        and(
          eq(agentServiceGrants.agentId, agentId),
          eq(agentServiceGrants.serviceConnectionId, serviceConnectionId),
        ),
      );
    return;
  }
  await db
    .insert(agentServiceGrants)
    .values({ agentId, serviceConnectionId, sessionPolicy: policyJson });
}

/** Load an agent's grants as the gate-shaped {@link ServiceGrant} projection. */
async function loadAgentGrants(db: CleoGlobalDb, agentId: string): Promise<ServiceGrant[]> {
  const rows = await db
    .select()
    .from(agentServiceGrants)
    .where(eq(agentServiceGrants.agentId, agentId));
  return rows.map((r) => ({
    agentId: r.agentId,
    serviceConnectionId: r.serviceConnectionId,
    sessionPolicy: parseSessionPolicy(r.sessionPolicy),
  }));
}

/** Parameters for {@link resolveSealedConnection}. */
export interface ResolveServiceParams {
  /** The agent requesting access (trust-gated). */
  readonly agentId: string;
  /** The provider key. */
  readonly provider: string;
  /** The connection label. */
  readonly label: string;
  /** Whether an out-of-band manual approval was granted for this session. */
  readonly approved?: boolean;
}

/**
 * RESOLVE a connection to a sealed credential — **policy-before-decrypt** egress.
 *
 * The trust gate runs FIRST (a pure {@link evaluateServiceAccess} decision over
 * the agent's grants). `decryptGlobal` is invoked ONLY when the gate returns
 * `allowed: true` — and even then NOT inline: the plaintext is materialized lazily
 * inside the {@link makeSealedCredential} `resolveToken` thunk at the wire. A
 * denied agent returns `null` BEFORE the decrypt closure is ever built or run, so
 * a spy on `decryptGlobal` records ZERO calls on a deny (AC4 proof).
 *
 * @returns A {@link SealedCredential} on allow; `null` when denied or when the
 *   connection is missing / not `active` / has no stored credential.
 * @task T11937
 */
export async function resolveSealedConnection(
  params: ResolveServiceParams,
  deps?: ServiceVaultDeps,
): Promise<SealedCredential | null> {
  const db = await resolveDb(deps);
  const decrypt = deps?.decrypt ?? decryptGlobal;

  // 1. Load the connection (non-secret) — needed for the gate's connection id.
  const rows = await db
    .select()
    .from(serviceConnections)
    .where(
      and(
        eq(serviceConnections.provider, params.provider),
        eq(serviceConnections.label, params.label),
      ),
    )
    .limit(1);
  const conn = rows[0];
  if (conn === undefined || conn.status !== 'active' || conn.credentialsEnc === null) {
    return null;
  }

  // 2. POLICY BEFORE DECRYPT — evaluate the trust gate. No crypto has run yet.
  const grants = await loadAgentGrants(db, params.agentId);
  const decision = evaluateServiceAccess(grants, {
    agentId: params.agentId,
    serviceConnectionId: conn.id,
    approved: params.approved,
  });
  if (!decision.allowed) {
    // Denied — return BEFORE building/running the decrypt thunk. `decrypt`
    // (the spied `decryptGlobal`) is never called on this path (AC4).
    return null;
  }

  // 3. Allowed — wrap in a sealed handle whose resolveToken decrypts AT THE WIRE.
  const ciphertext = conn.credentialsEnc;
  const id = credentialId(params.provider, params.label);
  return makeSealedCredential({
    provider: params.provider,
    account: params.label,
    // Non-secret preview: we have not decrypted, so name the credential by id.
    tokenPreview: tokenPreview('', 'oauth'),
    resolveToken: async (): Promise<string> => {
      // The SOLE decrypt point — runs only when the wire calls fetch(). Returns
      // the access token (the wire-bound bearer); refresh stays in the blob.
      const plaintext = await decrypt(ciphertext, id);
      const blob = JSON.parse(plaintext) as ServiceTokenBlob;
      return blob.accessToken;
    },
  });
}
