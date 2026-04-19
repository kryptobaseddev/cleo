<!--
  BreadcrumbSection — parent-chain breadcrumb rendered above the meta grid.

  Walks from root ancestor down to the currently-pinned task. Each
  ancestor is a button (if `onSelectDep` is wired) that repins the drawer
  instead of navigating the page.

  @task T990
  @wave 1C
-->
<script lang="ts">
  import type { Task } from '@cleocode/contracts';

  import type { ParentChainEntry } from '../DetailDrawer.svelte';

  interface Props {
    task: Task;
    chain: ParentChainEntry[];
    /** When provided, clicking an entry repins the drawer instead of navigating. */
    onSelectDep?: (id: string) => void;
  }

  let { task, chain, onSelectDep }: Props = $props();
</script>

{#if chain.length > 0}
  <nav class="parent-chain" aria-label="Parent chain">
    {#each chain as entry, idx (entry.id)}
      {#if onSelectDep}
        <button
          type="button"
          class="crumb"
          onclick={() => onSelectDep?.(entry.id)}
          aria-label={`Open ${entry.id}`}
        >
          {#if entry.type}
            <span class="crumb-type">{entry.type}</span>
          {/if}
          <span class="crumb-id">{entry.id}</span>
        </button>
      {:else}
        <a href={`/tasks/${entry.id}`} class="crumb">
          {#if entry.type}
            <span class="crumb-type">{entry.type}</span>
          {/if}
          <span class="crumb-id">{entry.id}</span>
        </a>
      {/if}
      {#if idx < chain.length - 1}
        <span class="crumb-sep" aria-hidden="true">›</span>
      {:else}
        <span class="crumb-sep" aria-hidden="true">›</span>
        <span class="crumb-current">{task.id}</span>
      {/if}
    {/each}
  </nav>
{/if}

<style>
  .parent-chain {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    font-size: 0.7rem;
  }

  .crumb {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    border-radius: var(--radius-xs);
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    color: var(--text-dim);
    text-decoration: none;
    font: inherit;
    font-size: 0.7rem;
    cursor: pointer;
    transition: color var(--ease), border-color var(--ease);
  }

  .crumb:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }

  .crumb:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .crumb-type {
    font-size: 0.6rem;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .crumb-id {
    font-family: var(--font-mono);
    color: var(--accent);
  }

  .crumb-sep {
    color: var(--text-faint);
  }

  .crumb-current {
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 0.7rem;
  }
</style>
