<!--
  VerifyQueuePanel — list of unverified-but-cited memory entries.

  Polls GET /api/memory/pending-verify on mount. Each row shows an entry
  with citation count, tier, and a promote button that POSTs to
  /api/memory/verify and optimistically removes the row.

  Used by the /brain/tier-stats and /brain/overview pages.

  @task T990
  @wave 1D
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Button, Card, EmptyState, Spinner } from '$lib/ui';
  import TierBadge from './TierBadge.svelte';

  /** Pending-verify entry shape — mirrors contracts.MemoryPendingEntry. */
  interface PendingEntry {
    id: string;
    title: string | null;
    sourceConfidence: string | null;
    citationCount: number;
    memoryTier: string | null;
    createdAt: string;
    table: string;
  }

  /** Response shape for GET /api/memory/pending-verify. */
  interface PendingResponse {
    count: number;
    minCitations: number;
    items: PendingEntry[];
    hint: string;
  }

  /**
   * Props for {@link VerifyQueuePanel}.
   */
  interface Props {
    /** Minimum citations threshold; passed through. Defaults to 5. */
    minCitations?: number;
    /** Max items shown. Defaults to 10. */
    limit?: number;
  }

  let { minCitations = 5, limit = 10 }: Props = $props();

  let items = $state<PendingEntry[]>([]);
  let hint = $state<string>('');
  let loading = $state(true);
  let error = $state<string | null>(null);
  let verifying = $state<Record<string, boolean>>({});

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const params = new URLSearchParams();
      params.set('minCitations', String(minCitations));
      params.set('limit', String(limit));
      const res = await fetch(`/api/memory/pending-verify?${params.toString()}`);
      const body = (await res.json()) as {
        success?: boolean;
        data?: PendingResponse;
        error?: { message?: string };
      };
      if (!res.ok || body.success === false) {
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      const payload = body.data ?? { count: 0, minCitations, items: [], hint: '' };
      items = payload.items;
      hint = payload.hint;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load verify queue';
    } finally {
      loading = false;
    }
  }

  async function promote(id: string): Promise<void> {
    if (verifying[id]) return;
    verifying = { ...verifying, [id]: true };
    try {
      const res = await fetch('/api/memory/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const body = (await res.json()) as {
        success?: boolean;
        error?: { message?: string };
      };
      if (!res.ok || body.success === false) {
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      // Optimistic remove
      items = items.filter((it) => it.id !== id);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Promotion failed';
    } finally {
      verifying = { ...verifying, [id]: false };
    }
  }

  onMount(() => {
    void load();
  });
</script>

<Card>
  {#snippet header()}
    <div class="panel-head">
      <h3 class="panel-title">Verify queue</h3>
      <span class="panel-sub">
        Unverified but frequently cited — promote to ground truth
      </span>
    </div>
  {/snippet}

  {#if loading}
    <div class="state">
      <Spinner size="md" />
      <span>Loading verify queue…</span>
    </div>
  {:else if error}
    <EmptyState
      title="Couldn't load verify queue"
      subtitle={error}
      variant="warning"
    >
      {#snippet action()}
        <Button variant="secondary" size="sm" onclick={() => { void load(); }}>Retry</Button>
      {/snippet}
    </EmptyState>
  {:else if items.length === 0}
    <EmptyState
      title="Queue is empty"
      subtitle={hint || `No entries with ≥ ${minCitations} citations await verification.`}
    />
  {:else}
    <ul class="queue">
      {#each items as it (it.id)}
        <li class="row">
          <div class="row-head">
            <code class="id">{it.id}</code>
            <span class="sep" aria-hidden="true">·</span>
            <span class="table">{it.table}</span>
            <span class="sep" aria-hidden="true">·</span>
            <TierBadge tier={it.memoryTier} />
            <span class="cites">{it.citationCount} citations</span>
          </div>
          {#if it.title}
            <p class="title">{it.title}</p>
          {/if}
          <div class="row-actions">
            <Button
              variant="primary"
              size="sm"
              loading={!!verifying[it.id]}
              onclick={() => {
                void promote(it.id);
              }}
            >
              Promote to verified
            </Button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</Card>

<style>
  .panel-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .panel-title {
    margin: 0;
    font-size: var(--text-md);
    font-weight: 600;
    color: var(--text);
    font-family: var(--font-sans);
  }

  .panel-sub {
    font-size: var(--text-xs);
    color: var(--text-dim);
  }

  .state {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-5);
    color: var(--text-dim);
    font-size: var(--text-sm);
  }

  .queue {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .row {
    padding: var(--space-3) 0;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .row:first-child {
    border-top: none;
  }

  .row-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    font-size: var(--text-xs);
    color: var(--text-dim);
  }

  .id {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text);
    background: var(--bg-elev-2);
    padding: 1px var(--space-2);
    border-radius: var(--radius-sm);
  }

  .table {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .sep {
    color: var(--text-faint);
  }

  .cites {
    margin-left: auto;
    color: var(--accent);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .title {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text);
    line-height: var(--leading-normal);
  }

  .row-actions {
    display: flex;
    justify-content: flex-end;
  }
</style>
