<!--
  DependenciesSection — upstream (blockers) + downstream (dependents) lists.

  Each list item is a button / anchor; clicking repins the drawer to the
  linked task (or navigates full-page when `onSelectDep` is unwired).
  A left-edge dot encodes the linked task's status via `--status-*`
  tokens.

  @task T990
  @wave 1C
-->
<script lang="ts">
  import type { DependencyLink } from '../DetailDrawer.svelte';

  interface Props {
    /** Blockers — tasks the focal task depends on. */
    upstream: DependencyLink[];
    /** Dependents — tasks that depend on the focal task. */
    downstream: DependencyLink[];
    /** Drawer-repin callback. When absent, rows render as plain anchors. */
    onSelectDep?: (id: string) => void;
    /** Loading indicator for both panels. */
    loading?: boolean;
    /** Error message rendered in both panels when non-empty. */
    error?: string | null;
  }

  let {
    upstream,
    downstream,
    onSelectDep,
    loading = false,
    error,
  }: Props = $props();

  function statusDotColor(s: string): string {
    if (s === 'done') return 'var(--status-done)';
    if (s === 'active') return 'var(--status-active)';
    if (s === 'blocked') return 'var(--status-blocked)';
    if (s === 'cancelled') return 'var(--text-dim)';
    if (s === 'archived') return 'var(--status-archived)';
    if (s === 'proposed') return 'var(--status-proposed)';
    return 'var(--status-pending)';
  }

  function handleDepClick(e: Event, id: string): void {
    if (!onSelectDep) return;
    e.preventDefault();
    onSelectDep(id);
  }
</script>

<section class="deps-section">
  <h4 class="section-h">
    Depends on
    {#if upstream.length > 0}
      <span class="count-badge">↑{upstream.length}</span>
    {/if}
  </h4>
  {#if loading}
    <div class="empty">Loading…</div>
  {:else if error}
    <div class="empty error">{error}</div>
  {:else if upstream.length === 0}
    <div class="empty">None.</div>
  {:else}
    <ul class="dep-list">
      {#each upstream as dep (dep.id)}
        <li>
          {#if onSelectDep}
            <button
              type="button"
              class="dep-btn"
              onclick={(e) => handleDepClick(e, dep.id)}
            >
              <span
                class="dep-dot"
                style="background:{statusDotColor(dep.status)}"
                aria-hidden="true"
              ></span>
              <span class="iid">{dep.id}</span>
              <span class="ititle">{dep.title}</span>
            </button>
          {:else}
            <a href={`/tasks/${dep.id}`} class="dep-btn">
              <span
                class="dep-dot"
                style="background:{statusDotColor(dep.status)}"
                aria-hidden="true"
              ></span>
              <span class="iid">{dep.id}</span>
              <span class="ititle">{dep.title}</span>
            </a>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<section class="deps-section">
  <h4 class="section-h">
    Depended on by
    {#if downstream.length > 0}
      <span class="count-badge">↓{downstream.length}</span>
    {/if}
  </h4>
  {#if loading}
    <div class="empty">Loading…</div>
  {:else if downstream.length === 0}
    <div class="empty">None.</div>
  {:else}
    <ul class="dep-list">
      {#each downstream as dep (dep.id)}
        <li>
          {#if onSelectDep}
            <button
              type="button"
              class="dep-btn"
              onclick={(e) => handleDepClick(e, dep.id)}
            >
              <span
                class="dep-dot"
                style="background:{statusDotColor(dep.status)}"
                aria-hidden="true"
              ></span>
              <span class="iid">{dep.id}</span>
              <span class="ititle">{dep.title}</span>
            </button>
          {:else}
            <a href={`/tasks/${dep.id}`} class="dep-btn">
              <span
                class="dep-dot"
                style="background:{statusDotColor(dep.status)}"
                aria-hidden="true"
              ></span>
              <span class="iid">{dep.id}</span>
              <span class="ititle">{dep.title}</span>
            </a>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .deps-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .section-h {
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-faint);
    margin: 0;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .count-badge {
    font-size: 0.625rem;
    color: var(--text-dim);
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: var(--radius-pill);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0;
    text-transform: none;
  }

  .empty {
    font-size: var(--text-xs);
    color: var(--text-faint);
    padding: 4px 2px;
  }

  .empty.error {
    color: var(--danger);
  }

  .dep-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .dep-btn {
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px var(--space-2);
    font-size: var(--text-xs);
    display: flex;
    align-items: center;
    gap: var(--space-2);
    transition: background var(--ease), border-color var(--ease);
    cursor: pointer;
    width: 100%;
    text-align: left;
    color: inherit;
    text-decoration: none;
    font-family: inherit;
  }

  .dep-btn:hover {
    border-color: var(--border-strong);
    background: color-mix(in srgb, var(--bg-elev-2) 70%, var(--bg-elev-1));
  }

  .dep-btn:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .dep-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .iid {
    font-family: var(--font-mono);
    color: var(--accent);
    font-size: var(--text-2xs);
    flex-shrink: 0;
  }

  .ititle {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-dim);
  }
</style>
