<!--
  /brain/causal — causal blocker trace for a task.

  Input accepts a task id; result is a depth-ordered tree of unresolved
  blockers, with any decisions referencing each node attached. Root
  causes (leaves) are highlighted. Accessible alternative: the same
  content is rendered as a nested list below the visual tree.

  @task T990
  @wave 1D
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Badge, Button, Card, EmptyState, Input, Spinner } from '$lib/ui';
  import type {
    ReasonBlockerNode,
    ReasonWhyResponse,
  } from '$lib/../routes/api/memory/reason-why/+server.js';
  import type { CausalPageData } from './+page.server.js';

  interface Props {
    data: CausalPageData;
  }

  let { data }: Props = $props();

  const initialTaskId: string = data.initialTaskId;
  let taskId = $state(initialTaskId);
  let result = $state<ReasonWhyResponse | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  async function runTrace(id: string): Promise<void> {
    if (!id.trim()) {
      result = null;
      return;
    }
    loading = true;
    error = null;
    try {
      const res = await fetch(`/api/memory/reason-why?taskId=${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      result = (await res.json()) as ReasonWhyResponse;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Trace failed';
    } finally {
      loading = false;
    }
  }

  function onSubmit(e: SubmitEvent): void {
    e.preventDefault();
    void runTrace(taskId);
    try {
      const url = new URL(window.location.href);
      if (taskId.trim()) url.searchParams.set('taskId', taskId);
      else url.searchParams.delete('taskId');
      window.history.replaceState({}, '', url);
    } catch {
      // SSR / missing window
    }
  }

  /** Group blockers by depth so we can render a horizontally-stacked tier layout. */
  const byDepth = $derived.by(() => {
    if (!result) return new Map<number, ReasonBlockerNode[]>();
    const m = new Map<number, ReasonBlockerNode[]>();
    for (const b of result.blockers) {
      if (!m.has(b.depth)) m.set(b.depth, []);
      m.get(b.depth)?.push(b);
    }
    return m;
  });

  const depths = $derived([...byDepth.keys()].sort((a, b) => a - b));

  function isRootCause(taskId: string): boolean {
    return result?.rootCauses.includes(taskId) ?? false;
  }

  onMount(() => {
    if (initialTaskId) {
      void runTrace(initialTaskId);
    }
  });
</script>

<svelte:head>
  <title>BRAIN Causal Trace — CLEO Studio</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <div class="head-left">
      <a class="back" href="/brain/overview">← Overview</a>
      <h1 class="title">Causal reasoning</h1>
      <span class="subtitle">
        Walk the blocker chain for a task — find the root cause that's gating progress
      </span>
    </div>
  </header>

  <form class="query-form" onsubmit={onSubmit}>
    <div class="query-input">
      <Input
        value={taskId}
        label="Task ID"
        placeholder="Enter a task ID — e.g. T123"
        oninput={(e) => (taskId = (e.target as HTMLInputElement).value)}
      />
    </div>
    <Button variant="primary" type="submit" loading={loading}>
      Trace causes
    </Button>
  </form>

  {#if error}
    <EmptyState
      title="Trace failed"
      subtitle={error}
      variant="warning"
    >
      {#snippet action()}
        <Button
          variant="secondary"
          size="sm"
          onclick={() => {
            void runTrace(taskId);
          }}
        >
          Retry
        </Button>
      {/snippet}
    </EmptyState>
  {:else if !result}
    <EmptyState
      title="Ready to trace"
      subtitle="Paste a task ID above. We'll walk its unresolved dependencies and surface the root cause."
    />
  {:else if result.blockers.length === 0}
    <EmptyState
      title={`${result.taskId} has no unresolved blockers`}
      subtitle="Either the task has no dependencies, all dependencies are completed, or the task doesn't exist."
    />
  {:else}
    <!-- Summary card -->
    {@const r = result}
    <Card>
      {#snippet header()}
        <div class="summary-head">
          <div class="summary-block">
            <span class="summary-label">Task</span>
            <code class="summary-val">{r.taskId}</code>
          </div>
          <div class="summary-block">
            <span class="summary-label">Depth</span>
            <span class="summary-val">{r.depth}</span>
          </div>
          <div class="summary-block">
            <span class="summary-label">Blockers</span>
            <span class="summary-val">{r.blockers.length}</span>
          </div>
          <div class="summary-block">
            <span class="summary-label">Root causes</span>
            <span class="summary-val highlight">{r.rootCauses.length}</span>
          </div>
        </div>
      {/snippet}

      {#if r.rootCauses.length > 0}
        <div class="root-causes">
          <span class="root-label">Root causes</span>
          {#each r.rootCauses as rc (rc)}
            <code class="rc-id">{rc}</code>
          {/each}
        </div>
      {/if}
    </Card>

    <!-- Visual tree (depth-tiered) -->
    <div class="tree" aria-hidden="true">
      {#each depths as d (d)}
        {@const layer = byDepth.get(d) ?? []}
        <div class="tier">
          <div class="tier-label">
            <span class="tier-num">{d}</span>
            <span class="tier-word">depth</span>
          </div>
          <div class="tier-nodes">
            {#each layer as b (b.taskId)}
              <div class="node" class:root={isRootCause(b.taskId)}>
                <code class="node-id">{b.taskId}</code>
                <Badge tone={b.status === 'blocked' ? 'danger' : b.status === 'pending' ? 'warning' : 'info'} size="sm">
                  {b.status}
                </Badge>
                <span class="node-title">{b.title}</span>
                {#if b.decisions.length > 0}
                  <span class="node-dec">{b.decisions.length} dec</span>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/each}
    </div>

    <!-- Accessible / textual cascade -->
    <section class="list-fallback" aria-label="Causal chain (textual view)">
      <h2 class="fallback-title">Causal chain</h2>
      <ol class="chain">
        {#each result.blockers as b (b.taskId)}
          <li class="chain-item" class:root={isRootCause(b.taskId)} style="--indent:{b.depth - 1}">
            <div class="chain-head">
              <code class="chain-id">{b.taskId}</code>
              <Badge tone={b.status === 'blocked' ? 'danger' : b.status === 'pending' ? 'warning' : 'info'} size="sm">
                {b.status}
              </Badge>
              {#if isRootCause(b.taskId)}
                <Badge tone="accent" size="sm">root cause</Badge>
              {/if}
              <span class="chain-depth">depth {b.depth}</span>
            </div>
            <p class="chain-title">{b.title}</p>
            {#if b.decisions.length > 0}
              <ul class="chain-decisions">
                {#each b.decisions as d (d.id)}
                  <li>
                    <code class="dec-id">{d.id}</code>
                    <span class="dec-text">{d.title}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ol>
    </section>
  {/if}
</section>

<style>
  .page {
    max-width: 1100px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    font-family: var(--font-sans);
  }

  .page-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .back {
    font-size: var(--text-xs);
    color: var(--text-faint);
    text-decoration: none;
    font-family: var(--font-mono);
    letter-spacing: 0.04em;
  }

  .back:hover {
    color: var(--accent);
  }

  .title {
    font-size: var(--text-2xl);
    font-weight: 700;
    color: var(--text);
    margin: 0;
    letter-spacing: -0.01em;
  }

  .subtitle {
    font-size: var(--text-sm);
    color: var(--text-dim);
    max-width: 64ch;
  }

  .query-form {
    display: flex;
    align-items: stretch;
    gap: var(--space-3);
  }

  .query-input {
    flex: 1;
  }

  .summary-head {
    display: flex;
    gap: var(--space-5);
    flex-wrap: wrap;
  }

  .summary-block {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .summary-label {
    font-size: var(--text-2xs);
    font-weight: 700;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .summary-val {
    font-family: var(--font-mono);
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .summary-val.highlight {
    color: var(--accent);
  }

  .root-causes {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .root-label {
    font-size: var(--text-2xs);
    font-weight: 700;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .rc-id {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--accent);
    background: var(--accent-halo);
    padding: 2px var(--space-2);
    border-radius: var(--radius-sm);
    border: 1px solid var(--accent);
  }

  /* Visual tree */
  .tree {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-5);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow-x: auto;
  }

  .tier {
    display: flex;
    gap: var(--space-4);
    align-items: stretch;
  }

  .tier-label {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 60px;
    padding-top: var(--space-2);
    border-right: 1px dashed var(--border);
    padding-right: var(--space-3);
  }

  .tier-num {
    font-family: var(--font-mono);
    font-size: var(--text-xl);
    font-weight: 700;
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }

  .tier-word {
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-faint);
  }

  .tier-nodes {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    flex: 1;
  }

  .node {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    font-size: var(--text-xs);
    color: var(--text-dim);
  }

  .node.root {
    border-color: var(--accent);
    background: var(--accent-halo);
    color: var(--text);
  }

  .node-id {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
  }

  .node.root .node-id {
    color: var(--accent);
  }

  .node-title {
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .node-dec {
    font-size: var(--text-2xs);
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }

  /* Textual fallback */
  .list-fallback {
    padding: var(--space-4);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }

  .fallback-title {
    margin: 0 0 var(--space-3);
    font-size: var(--text-2xs);
    font-weight: 700;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .chain {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .chain-item {
    padding: var(--space-3) var(--space-3) var(--space-3) calc(var(--space-4) * var(--indent, 0) + var(--space-3));
    border-left: 2px solid var(--border);
    position: relative;
  }

  .chain-item.root {
    border-left-color: var(--accent);
    background: var(--accent-halo);
    border-radius: var(--radius-md);
  }

  .chain-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .chain-id {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text);
    background: var(--bg);
    padding: 1px var(--space-2);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }

  .chain-depth {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .chain-title {
    margin: var(--space-1) 0 0;
    font-size: var(--text-sm);
    color: var(--text);
    line-height: var(--leading-normal);
  }

  .chain-decisions {
    list-style: none;
    margin: var(--space-2) 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .chain-decisions li {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-dim);
  }

  .dec-id {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--accent);
  }
</style>
