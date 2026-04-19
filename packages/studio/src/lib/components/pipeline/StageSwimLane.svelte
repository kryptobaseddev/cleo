<!--
  StageSwimLane — single column of the RCASD-IVTR+C pipeline board.

  Renders a fixed-height scrollable column with a sticky header,
  stage progress bar, and a vertical stack of TaskCards in compact
  mode. Keyboard focus is driven by the parent's `focusedIndex`
  prop; clicks emit `onSelect(taskId)` rather than navigating
  directly so the parent can open a DetailDrawer.

  @task T990
  @wave 1E
-->
<script lang="ts">
  import { PriorityBadge, StatusBadge, gatesFromJson } from '$lib/components/tasks';
  import { Badge } from '$lib/ui';
  import type { TaskPriority, TaskStatus } from '@cleocode/contracts';
  import type { PipelineTask } from '../../../routes/tasks/pipeline/+page.server.js';

  const KNOWN_STATUSES = new Set<TaskStatus>([
    'pending',
    'active',
    'blocked',
    'done',
    'cancelled',
    'archived',
    'proposed',
  ]);
  const KNOWN_PRIORITIES = new Set<TaskPriority>(['low', 'medium', 'high', 'critical']);

  function toStatus(s: string): TaskStatus {
    return (KNOWN_STATUSES as Set<string>).has(s) ? (s as TaskStatus) : 'pending';
  }

  function toPriority(p: string): TaskPriority {
    return (KNOWN_PRIORITIES as Set<string>).has(p) ? (p as TaskPriority) : 'medium';
  }

  interface Props {
    /** Column id (`research`, `implementation`, …). */
    id: string;
    /** Human-readable column label. */
    label: string;
    /** Total tasks in this column. */
    count: number;
    /** Tasks rendered as cards. */
    tasks: PipelineTask[];
    /** When true, highlight the column as focused. */
    focused?: boolean;
    /** Row index of the currently-focused card, or -1 when none. */
    focusedRow?: number;
    /** Called when a card is clicked / activated. */
    onSelect?: (taskId: string) => void;
  }

  let {
    id,
    label,
    count,
    tasks,
    focused = false,
    focusedRow = -1,
    onSelect,
  }: Props = $props();

  /**
   * Fraction of tasks in this column whose `done` gate is set. Used
   * for the header progress bar. Terminal columns (`done`,
   * `cancelled`) always show as 100% / 0% respectively so the bar
   * reads as a finish line.
   */
  const progressPct = $derived<number>(
    (() => {
      if (id === 'done') return 100;
      if (id === 'cancelled') return 0;
      if (tasks.length === 0) return 0;
      let done = 0;
      for (const t of tasks) {
        const gates = gatesFromJson(t.verification_json ?? null);
        if (gates.implemented && gates.testsPassed && gates.qaPassed) {
          done++;
        }
      }
      return Math.round((done / tasks.length) * 100);
    })(),
  );
</script>

<section class="swimlane" class:is-focused={focused} data-stage={id} aria-label={label}>
  <header class="lane-head">
    <div class="head-row">
      <span class="head-label">{label}</span>
      <Badge tone={count > 0 ? 'accent' : 'neutral'} size="sm">{count}</Badge>
    </div>
    <div class="progress-track" aria-hidden="true">
      <div class="progress-fill" style={`width: ${progressPct}%`}></div>
    </div>
    <div class="progress-label">
      <span class="progress-pct">{progressPct}%</span>
      <span class="progress-hint">gates passed</span>
    </div>
  </header>

  <div class="lane-body">
    {#if tasks.length === 0}
      <p class="lane-empty">—</p>
    {:else}
      {#each tasks as task, i (task.id)}
        {@const gates = gatesFromJson(task.verification_json ?? null)}
        <button
          type="button"
          class="lane-card"
          class:is-focused={focused && focusedRow === i}
          onclick={() => onSelect?.(task.id)}
        >
          <div class="card-head">
            <span class="card-id">{task.id}</span>
            <StatusBadge status={toStatus(task.status)} compact />
          </div>
          <p class="card-title">{task.title}</p>
          <div class="card-foot">
            <PriorityBadge priority={toPriority(task.priority)} compact />
            {#if task.size}
              <span class="card-size">{task.size}</span>
            {/if}
            <div class="card-gates" aria-label="Verification gates">
              <span class="g-dot" class:g-pass={gates.implemented} title="Implemented">I</span>
              <span class="g-dot" class:g-pass={gates.testsPassed} title="Tests">T</span>
              <span class="g-dot" class:g-pass={gates.qaPassed} title="QA">Q</span>
              <span class="g-dot" title="Documented">D</span>
              <span class="g-dot" title="Security">S</span>
              <span class="g-dot" title="Cleanup">C</span>
            </div>
          </div>
        </button>
      {/each}
    {/if}
  </div>
</section>

<style>
  .swimlane {
    display: flex;
    flex-direction: column;
    width: 260px;
    flex-shrink: 0;
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
    transition: border-color var(--ease), box-shadow var(--ease);
  }

  .swimlane.is-focused {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-soft);
  }

  .lane-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-3);
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .head-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .head-label {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
  }

  .progress-track {
    height: 3px;
    background: var(--bg-elev-2);
    border-radius: var(--radius-pill);
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--accent);
    border-radius: var(--radius-pill);
    transition: width var(--ease-slow);
  }

  @media (prefers-reduced-motion: reduce) {
    .progress-fill { transition: none; }
  }

  .progress-label {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }

  .progress-pct {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text);
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  .progress-hint {
    font-family: var(--font-mono);
    font-size: 0.625rem;
    color: var(--text-faint);
    letter-spacing: 0.06em;
  }

  .lane-body {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-2);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .lane-empty {
    text-align: center;
    padding: var(--space-6);
    font-family: var(--font-mono);
    font-size: var(--text-md);
    color: var(--border-strong);
    margin: 0;
  }

  .lane-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    text-align: left;
    color: inherit;
    font: inherit;
    cursor: pointer;
    transition: border-color var(--ease), background var(--ease);
  }

  .lane-card:hover {
    background: var(--bg-elev-2);
    border-color: var(--border-strong);
  }

  .lane-card:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: var(--shadow-focus);
  }

  .lane-card.is-focused {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-soft);
  }

  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .card-id {
    font-family: var(--font-mono);
    font-size: 0.675rem;
    color: var(--accent);
    font-weight: 600;
  }

  .card-title {
    font-size: var(--text-xs);
    color: var(--text);
    line-height: var(--leading-tight);
    margin: 0;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .card-foot {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    flex-wrap: wrap;
  }

  .card-size {
    font-family: var(--font-mono);
    font-size: 0.625rem;
    color: var(--text-faint);
    background: var(--bg-elev-1);
    padding: 1px 4px;
    border-radius: var(--radius-xs);
    text-transform: lowercase;
  }

  .card-gates {
    display: flex;
    gap: 1px;
    margin-left: auto;
  }

  .g-dot {
    font-family: var(--font-mono);
    font-size: 0.5rem;
    width: 11px;
    height: 11px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-xs);
    background: var(--bg-elev-2);
    color: var(--border-strong);
    font-weight: 700;
  }

  .g-dot.g-pass {
    background: var(--success-soft);
    color: var(--success);
  }
</style>
