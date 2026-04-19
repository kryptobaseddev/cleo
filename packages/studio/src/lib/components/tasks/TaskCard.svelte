<!--
  TaskCard — generic card showing ID, truncated title, status badge,
  priority badge, size chip and labels.

  Consumed by the Kanban tab (T955), the Hierarchy tab (T953) row render,
  and the Recent Activity panel. A click handler is optional so the card
  can either open the shared DetailDrawer OR act as a simple anchor.

  @task T950
  @epic T949
-->
<script lang="ts">
  import type { Task } from '@cleocode/contracts';
  import PriorityBadge from './PriorityBadge.svelte';
  import StatusBadge from './StatusBadge.svelte';
  import { gatesFromJson, type GatesPassed } from './format.js';

  /**
   * Props for {@link TaskCard}.
   */
  interface Props {
    /**
     * The task to render. Must carry `id`, `title`, `status`, and `priority`
     * at minimum — the rest of the fields are rendered conditionally when
     * present.
     */
    task: Task;
    /**
     * Optional click handler. When provided, the card renders as a
     * `<button>`; when omitted, it renders as an inert card so parents can
     * wrap it in their own link (e.g. `<a href="/tasks/T123">`).
     */
    onClick?: (task: Task) => void;
    /**
     * Compact mode — 2-line clamped title, no labels row. Matches the
     * kanban / pipeline card density. Default `false`.
     */
    compact?: boolean;
    /**
     * When `true`, highlight the card as the currently focused/selected one.
     * Default `false`. Paired with the drawer `selectedId` state.
     */
    focused?: boolean;
    /**
     * Raw `verification_json` string from the tasks.db row, used to render
     * I/T/Q gate dots. When omitted, gate dots are hidden.
     */
    verificationJson?: string | null;
  }

  let {
    task,
    onClick,
    compact = false,
    focused = false,
    verificationJson,
  }: Props = $props();

  const gates: GatesPassed = $derived(
    verificationJson !== undefined ? gatesFromJson(verificationJson) : {
      implemented: false,
      testsPassed: false,
      qaPassed: false,
    },
  );
  const hasGates = $derived(verificationJson !== undefined && verificationJson !== null);
  const hasLabels = $derived(!compact && Array.isArray(task.labels) && task.labels.length > 0);
  const displayPriority = $derived(task.priority ?? 'medium');

  function handleClick(): void {
    if (onClick) onClick(task);
  }

  function handleKey(e: KeyboardEvent): void {
    if (!onClick) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick(task);
    }
  }
</script>

{#if onClick}
  <button
    type="button"
    class="task-card"
    class:compact
    class:focused
    onclick={handleClick}
    onkeydown={handleKey}
    aria-label={`Open task ${task.id}: ${task.title}`}
  >
    <div class="card-top">
      <span class="card-id">{task.id}</span>
      <StatusBadge status={task.status} compact />
    </div>
    <p class="card-title">{task.title}</p>
    <div class="card-footer">
      <PriorityBadge priority={displayPriority} compact={compact} />
      {#if task.size}
        <span class="size-chip">{task.size}</span>
      {/if}
      {#if hasGates}
        <div class="gates" aria-label="Verification gates">
          <span class="g-dot" class:g-pass={gates.implemented} title="Implemented">I</span>
          <span class="g-dot" class:g-pass={gates.testsPassed} title="Tests">T</span>
          <span class="g-dot" class:g-pass={gates.qaPassed} title="QA">Q</span>
        </div>
      {/if}
    </div>
    {#if hasLabels}
      <div class="labels-row">
        {#each task.labels ?? [] as lbl}
          <span class="label-pill">{lbl}</span>
        {/each}
      </div>
    {/if}
  </button>
{:else}
  <div
    class="task-card inert"
    class:compact
    class:focused
    role="group"
    aria-label={`Task ${task.id}`}
  >
    <div class="card-top">
      <span class="card-id">{task.id}</span>
      <StatusBadge status={task.status} compact />
    </div>
    <p class="card-title">{task.title}</p>
    <div class="card-footer">
      <PriorityBadge priority={displayPriority} compact={compact} />
      {#if task.size}
        <span class="size-chip">{task.size}</span>
      {/if}
      {#if hasGates}
        <div class="gates" aria-label="Verification gates">
          <span class="g-dot" class:g-pass={gates.implemented} title="Implemented">I</span>
          <span class="g-dot" class:g-pass={gates.testsPassed} title="Tests">T</span>
          <span class="g-dot" class:g-pass={gates.qaPassed} title="QA">Q</span>
        </div>
      {/if}
    </div>
    {#if hasLabels}
      <div class="labels-row">
        {#each task.labels ?? [] as lbl}
          <span class="label-pill">{lbl}</span>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .task-card {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.625rem;
    background: #0f1117;
    border: 1px solid #1e2435;
    border-radius: 6px;
    text-align: left;
    color: inherit;
    transition: border-color 0.15s, background 0.15s;
    font: inherit;
    cursor: pointer;
    width: 100%;
  }

  .task-card.inert {
    cursor: default;
  }

  .task-card:not(.inert):hover {
    border-color: #3d4a60;
    background: #13182a;
  }

  .task-card:not(.inert):focus-visible {
    outline: 2px solid rgba(168, 85, 247, 0.6);
    outline-offset: 1px;
  }

  .task-card.focused {
    border-color: #a855f7;
    box-shadow: 0 0 0 1px rgba(168, 85, 247, 0.3);
  }

  .card-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .card-id {
    font-size: 0.675rem;
    color: #a855f7;
    font-weight: 600;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }

  .card-title {
    font-size: 0.8125rem;
    color: #e2e8f0;
    line-height: 1.4;
    margin: 0;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .task-card:not(.compact) .card-title {
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }

  .card-footer {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex-wrap: wrap;
  }

  .size-chip {
    font-size: 0.625rem;
    color: #475569;
    background: #1e2435;
    padding: 0.1rem 0.3rem;
    border-radius: 2px;
    text-transform: lowercase;
  }

  .gates {
    display: flex;
    gap: 2px;
    margin-left: auto;
  }

  .g-dot {
    font-size: 0.55rem;
    width: 13px;
    height: 13px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 2px;
    background: #1e2435;
    color: #2d3748;
    font-weight: 700;
  }

  .g-dot.g-pass {
    background: rgba(34, 197, 94, 0.12);
    color: #22c55e;
  }

  .labels-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 2px;
  }

  .label-pill {
    font-size: 0.625rem;
    background: #1e2435;
    border: 1px solid #2d3748;
    color: #94a3b8;
    padding: 2px 7px;
    border-radius: 999px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
</style>
