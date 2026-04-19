<!--
  IdentitySection — task ID badge + close button + title + status/priority meta.

  Extracted from the monolithic DetailDrawer in Wave 1C of T990 so each
  section owns its own layout concerns.  Keeps the visual contract from
  `docs/specs/CLEO-TASK-DASHBOARD-SPEC.md` §5.5 identical.

  @task T990
  @wave 1C
-->
<script lang="ts">
  import type { Task } from '@cleocode/contracts';
  import PriorityBadge from '../PriorityBadge.svelte';
  import StatusBadge from '../StatusBadge.svelte';
  import { formatTime } from '../format.js';

  interface Props {
    /** Task being inspected. */
    task: Task;
    /** Close callback invoked when the × button is pressed. */
    onClose: () => void;
  }

  let { task, onClose }: Props = $props();
</script>

<header class="identity">
  <div class="id-row">
    <span class="id-badge">{task.id}</span>
    <button
      type="button"
      class="close-btn"
      onclick={onClose}
      aria-label="Close detail drawer"
    >×</button>
  </div>
  <h3 class="title">{task.title}</h3>
  <dl class="meta">
    <dt>Status</dt>
    <dd><StatusBadge status={task.status} /></dd>
    <dt>Priority</dt>
    <dd><PriorityBadge priority={task.priority ?? 'medium'} /></dd>
    {#if task.type}
      <dt>Type</dt>
      <dd>{task.type}</dd>
    {/if}
    {#if task.size}
      <dt>Size</dt>
      <dd>{task.size}</dd>
    {/if}
    {#if task.pipelineStage}
      <dt>Pipeline</dt>
      <dd>{task.pipelineStage}</dd>
    {/if}
    {#if task.updatedAt}
      <dt>Updated</dt>
      <dd>{formatTime(task.updatedAt)}</dd>
    {/if}
  </dl>
</header>

<style>
  .identity {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .id-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .id-badge {
    font-family: var(--font-mono);
    color: var(--accent);
    font-size: var(--text-sm);
    background: var(--accent-soft);
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    font-weight: 600;
  }

  .close-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-dim);
    cursor: pointer;
    width: 28px;
    height: 28px;
    border-radius: var(--radius-sm);
    font-size: var(--text-md);
    line-height: 1;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: color var(--ease), border-color var(--ease);
    font-family: inherit;
  }

  .close-btn:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }

  .close-btn:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .title {
    font-size: var(--text-md);
    line-height: 1.35;
    margin: 0;
    color: var(--text);
    font-weight: 600;
  }

  .meta {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px var(--space-4);
    font-size: var(--text-xs);
    margin: 0;
    padding: var(--space-3);
    background: var(--bg-elev-2);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }

  .meta dt {
    color: var(--text-faint);
    text-transform: uppercase;
    font-size: 0.625rem;
    letter-spacing: 0.06em;
    padding-top: 2px;
    font-weight: 600;
  }

  .meta dd {
    margin: 0;
    color: var(--text);
    font-size: var(--text-xs);
  }
</style>
