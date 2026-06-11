/**
 * `/settings/vault` — server load for the read-only service-vault dashboard
 * (T11943 · M2-W6 · E-UNIVERSAL-SERVICE-VAULT).
 *
 * Surfaces the global service vault — `service_connections` + per-agent
 * `agent_service_grants` — through the CORE read facades
 * ({@link listConnections} / {@link listAllGrants}). Both return REDACTED,
 * non-secret views: provider / label / status / scopes / expiry /
 * hasCredentials and, for grants, the agent + policy mode. NO ciphertext, NO
 * plaintext, NO `tokenPreview`-able material ever reaches this load — the
 * decrypted token never leaves core (AC1).
 *
 * Studio holds NO second store and opens NO DB directly (AC3): this load calls
 * the same core accessors the `cleo service list|status` CLI verbs use, so the
 * dashboard and the CLI agree on one source of truth. Connect / revoke are NOT
 * exposed here (read-first M2) — they route through the CLI (`cleo service
 * connect|revoke`), linked from the page.
 *
 * @task T11943
 * @epic T11765 — E-UNIVERSAL-SERVICE-VAULT
 * @saga T10409
 */

import {
  type AgentGrantView,
  listAllGrants,
  listConnections,
  type ServiceConnectionView,
} from '@cleocode/core/store/service-connections-accessor.js';
import type { PageServerLoad } from './$types';

/** A redacted connection row for the dashboard (NEVER carries a token). */
export interface VaultConnectionRow {
  /** Service provider key (e.g. `github`). */
  provider: string;
  /** Connection label, unique within the provider. */
  label: string;
  /** Health status (`active` | `expired` | `revoked`). */
  status: string;
  /** Granted scopes (non-secret). */
  scopes: string[];
  /** ISO-8601 access-token expiry, or null. */
  expiresAt: string | null;
  /** Whether a credential blob has been written (the OAuth flow ran). */
  hasCredentials: boolean;
  /** ISO-8601 connected-at instant. */
  connectedAt: string;
}

/** A redacted per-agent grant row for the dashboard. */
export interface VaultGrantRow {
  /** The granted agent's id. */
  agentId: string;
  /** Connection provider, or null when the connection was deleted. */
  provider: string | null;
  /** Connection label, or null when the connection was deleted. */
  label: string | null;
  /** Session policy mode (`allow` | `block`). */
  mode: string;
  /** Whether the grant requires an out-of-band manual approval per session. */
  manualApproval: boolean;
}

/** The payload the vault dashboard renders. */
export interface VaultDashboardData {
  /** Redacted connection rows, grouped+sorted client-side. */
  connections: VaultConnectionRow[];
  /** Redacted per-agent grant rows. */
  grants: VaultGrantRow[];
  /** Set when the vault could not be read (e.g. no global cleo.db yet). */
  error?: string;
}

/** Project a core {@link ServiceConnectionView} onto the redacted dashboard row. */
function toConnectionRow(v: ServiceConnectionView): VaultConnectionRow {
  return {
    provider: v.provider,
    label: v.label,
    status: v.status,
    scopes: [...v.scopes],
    expiresAt: v.expiresAt,
    hasCredentials: v.hasCredentials,
    connectedAt: v.connectedAt,
  };
}

/** Project a core {@link AgentGrantView} onto the redacted dashboard row. */
function toGrantRow(v: AgentGrantView): VaultGrantRow {
  return {
    agentId: v.agentId,
    provider: v.provider,
    label: v.label,
    mode: v.mode,
    manualApproval: v.manualApproval,
  };
}

export const load: PageServerLoad = async (): Promise<VaultDashboardData> => {
  try {
    // Both reads go through the CORE redacted facades — one source of truth
    // shared with `cleo service list|status`. Neither decrypts.
    const [connections, grants] = await Promise.all([listConnections(), listAllGrants()]);
    return {
      connections: connections.map(toConnectionRow),
      grants: grants.map(toGrantRow),
    };
  } catch (e) {
    return {
      connections: [],
      grants: [],
      error: e instanceof Error ? e.message : 'Failed to read the service vault.',
    };
  }
};
