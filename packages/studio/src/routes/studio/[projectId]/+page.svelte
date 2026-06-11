<!--
  /studio/[projectId] — the SAGA PICKER for the operator-console shell
  (T11558 · E3-WORKGRAPH-VIEW).

  Lists the project's sagas + standalone epics so an operator drills
  project ▸ saga ▸ workgraph. Each row links to the saga's
  `/studio/[projectId]/[sagaId]` shell. Pure presentation over the
  gateway-backed server bundle.

  @task T11558
  @epic T11558
  @saga T11555
-->
<script lang="ts">
  import { Badge, Card } from '$lib/ui';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  /** Status → badge tone. */
  function statusTone(status: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
    if (status === 'done') return 'success';
    if (status === 'active') return 'info';
    if (status === 'blocked') return 'danger';
    if (status === 'pending') return 'warning';
    return 'neutral';
  }
</script>

<svelte:head>
  <title>{data.projectName} sagas — CLEO Studio</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<section class="picker">
  <header class="picker-head">
    <div>
      <span class="eyebrow">OPERATOR CONSOLE</span>
      <h1>{data.projectName} — Sagas</h1>
      <p class="muted">Pick a saga to open its workgraph + live dispatcher board.</p>
    </div>
  </header>

  {#if data.error}
    <Card padding="cozy">
      <div class="error" role="alert">{data.error}</div>
    </Card>
  {:else if data.roots.length === 0}
    <Card padding="cozy">
      <p class="muted">
        No sagas or standalone epics in this project yet. Create one with
        <code>cleo saga create</code>.
      </p>
    </Card>
  {:else}
    <ul class="roots">
      {#each data.roots as root (root.id)}
        <li>
          <a class="root" href={`/studio/${data.projectId}/${root.id}`}>
            <span class="root-id"><code>{root.id}</code></span>
            <span class="root-title">{root.title}</span>
            <span class="root-meta">
              <Badge tone="info" size="sm">{root.type}</Badge>
              <Badge tone={statusTone(root.status)} size="sm">{root.status}</Badge>
              <span class="count">{root.descendantCount} tasks</span>
            </span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    max-width: 60rem;
    margin: 0 auto;
  }

  .eyebrow {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: 0.12em;
    color: var(--text-faint);
    text-transform: uppercase;
  }

  .picker-head h1 {
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

  .roots {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .root {
    display: grid;
    grid-template-columns: minmax(6rem, auto) 1fr auto;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    text-decoration: none;
    color: var(--text);
    transition: border-color var(--ease), background var(--ease);
  }

  .root:hover {
    border-color: var(--accent);
    background: var(--bg-elev-2);
  }

  .root:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .root-id code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--accent);
  }

  .root-title {
    font-size: var(--text-sm);
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .root-meta {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .count {
    font-size: var(--text-2xs);
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }
</style>
