<!--
  /settings/vault — the READ-ONLY service-vault dashboard (T11943 · M2-W6).

  Lists the global service vault: connected services
  (`service_connections` — provider / label / status / scopes / expiry) and
  the per-agent grants (`agent_service_grants` — agent / connection / policy
  mode). Every value comes from the CORE redacted read facades via the server
  load — NO secret, NO ciphertext, NO `tokenPreview` ever reaches the browser.

  Connect / revoke / grant are NOT performed here (read-first M2). The page
  links the operator to the CLI verbs (`cleo service connect|revoke`) — the
  ratified write path. The dashboard observes; it does not mutate.

  SECURITY: this page renders ONLY non-secret identity + status fields. Adding
  any field that could carry a token is forbidden by the redacted server
  contract (`VaultConnectionRow` / `VaultGrantRow` carry no secret).

  @task T11943
  @epic T11765 — E-UNIVERSAL-SERVICE-VAULT
  @saga T10409
-->
<script lang="ts">
  import { Badge, Card } from '$lib/ui';
  import type { PageData } from './$types';
  import type { VaultGrantRow } from './+page.server.js';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  /** Group connections by provider for display (stable provider-asc order). */
  const groupedConnections = $derived.by(() => {
    const groups = new Map<string, typeof data.connections>();
    for (const conn of data.connections) {
      const list = groups.get(conn.provider);
      if (list) list.push(conn);
      else groups.set(conn.provider, [conn]);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, list]) => ({
        provider,
        connections: list.slice().sort((a, b) => a.label.localeCompare(b.label)),
      }));
  });

  /** Grants keyed by `provider:label` so they render under their connection. */
  const grantsByConnection = $derived.by(() => {
    const map = new Map<string, VaultGrantRow[]>();
    for (const g of data.grants) {
      if (g.provider === null || g.label === null) continue;
      const key = `${g.provider}:${g.label}`;
      const list = map.get(key);
      if (list) list.push(g);
      else map.set(key, [g]);
    }
    return map;
  });

  /** Grants whose connection was deleted out-of-band (orphans). */
  const orphanGrants = $derived(data.grants.filter((g) => g.provider === null || g.label === null));

  function statusTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
    if (status === 'active') return 'success';
    if (status === 'expired') return 'warning';
    if (status === 'revoked') return 'danger';
    return 'neutral';
  }

  function formatExpiry(expiresAt: string | null): string {
    if (expiresAt === null) return 'never';
    const ms = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(ms)) return expiresAt;
    if (ms < 0) return 'expired';
    const hours = Math.round(ms / 3_600_000);
    if (hours < 48) return `${hours}h`;
    return `${Math.round(hours / 24)}d`;
  }
</script>

<svelte:head>
  <title>Service Vault — CLEO Studio</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<section class="vault-page">
  <header class="page-header">
    <div>
      <span class="eyebrow">SERVICE VAULT</span>
      <h1>Connected services</h1>
      <p class="muted">
        Read-only view of the global service vault — connections + per-agent grants. Secrets never
        leave core; this dashboard shows identity, scopes, and status only. Manage connections via
        <code>cleo service connect</code> / <code>cleo service revoke</code>.
      </p>
    </div>
  </header>

  {#if data.error}
    <Card padding="cozy">
      <div class="error" role="alert">Failed to load the vault: {data.error}</div>
    </Card>
  {:else if data.connections.length === 0}
    <Card padding="cozy">
      <p class="muted">
        No service connections yet. Connect one with
        <code>cleo service connect &lt;provider&gt;</code> from the CLI.
      </p>
    </Card>
  {:else}
    <div class="groups">
      {#each groupedConnections as group (group.provider)}
        <Card padding="cozy">
          {#snippet header()}
            <h2 class="group-title">
              {group.provider}
              <span class="muted">
                · {group.connections.length}
                {group.connections.length === 1 ? 'connection' : 'connections'}
              </span>
            </h2>
          {/snippet}

          <table class="conns">
            <thead>
              <tr>
                <th scope="col">Label</th>
                <th scope="col">Status</th>
                <th scope="col">Scopes</th>
                <th scope="col">Expiry</th>
                <th scope="col">Credential</th>
                <th scope="col">Agent grants</th>
              </tr>
            </thead>
            <tbody>
              {#each group.connections as conn (conn.label)}
                {@const grants = grantsByConnection.get(`${conn.provider}:${conn.label}`) ?? []}
                <tr>
                  <td><code>{conn.label}</code></td>
                  <td><Badge tone={statusTone(conn.status)} size="sm">{conn.status}</Badge></td>
                  <td class="scopes">
                    {#if conn.scopes.length === 0}
                      <span class="muted">—</span>
                    {:else}
                      {#each conn.scopes as scope (scope)}
                        <Badge tone="neutral" size="sm">{scope}</Badge>
                      {/each}
                    {/if}
                  </td>
                  <td>{formatExpiry(conn.expiresAt)}</td>
                  <td>
                    {#if conn.hasCredentials}
                      <Badge tone="info" size="sm">stored</Badge>
                    {:else}
                      <span class="muted">none</span>
                    {/if}
                  </td>
                  <td class="grants">
                    {#if grants.length === 0}
                      <span class="muted">no grants</span>
                    {:else}
                      {#each grants as grant (grant.agentId)}
                        <span class="grant" title={`policy: ${grant.mode}`}>
                          <code>{grant.agentId}</code>
                          <Badge tone={grant.mode === 'block' ? 'danger' : 'success'} size="sm">
                            {grant.mode}
                          </Badge>
                          {#if grant.manualApproval}
                            <Badge tone="warning" size="sm">manual</Badge>
                          {/if}
                        </span>
                      {/each}
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </Card>
      {/each}
    </div>

    {#if orphanGrants.length > 0}
      <Card padding="cozy">
        {#snippet header()}
          <h2 class="group-title">
            Orphan grants
            <span class="muted">· {orphanGrants.length} (connection deleted)</span>
          </h2>
        {/snippet}
        <ul class="orphans">
          {#each orphanGrants as grant, i (i)}
            <li>
              <code>{grant.agentId}</code> → connection #{grant.provider === null
                ? '(deleted)'
                : `${grant.provider}:${grant.label}`}
              <Badge tone={grant.mode === 'block' ? 'danger' : 'neutral'} size="sm">
                {grant.mode}
              </Badge>
            </li>
          {/each}
        </ul>
      </Card>
    {/if}
  {/if}
</section>

<style>
  .vault-page {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    max-width: 72rem;
    margin: 0 auto;
  }

  .eyebrow {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: 0.12em;
    color: var(--text-faint);
    text-transform: uppercase;
  }

  .page-header h1 {
    font-size: var(--text-2xl);
    margin: var(--space-1) 0;
  }

  .muted {
    color: var(--text-dim);
    font-size: var(--text-sm);
    margin: 0;
  }

  .muted code,
  .error {
    font-family: var(--font-mono);
  }

  .error {
    color: var(--danger);
  }

  .groups {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .group-title {
    font-size: var(--text-md);
    margin: 0;
    font-weight: 600;
  }

  table.conns {
    width: 100%;
    border-collapse: collapse;
  }

  table.conns th,
  table.conns td {
    text-align: left;
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border);
    font-size: var(--text-sm);
    vertical-align: top;
  }

  table.conns th {
    font-weight: 600;
    color: var(--text-dim);
    font-size: var(--text-xs);
  }

  td code,
  .grant code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--accent);
  }

  .scopes,
  .grants {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .grant {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
  }

  .orphans {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-size: var(--text-sm);
    color: var(--text-dim);
  }

  .orphans code {
    font-family: var(--font-mono);
    color: var(--accent);
  }
</style>
