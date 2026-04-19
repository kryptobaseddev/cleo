<!--
  PriorityBadge — colour stripe + label rendering a task priority.

  Extracted from the duplicated `priorityClass()` helpers in the four
  `/tasks/*` pages so the new Task Explorer tabs share one visual language.
  The colour stripe on the left edge gives the card/row a quick-scan
  priority signal even when the label is clipped.

  Theme tokens match the viz reference dark palette.

  @task T950
  @epic T949
-->
<script lang="ts">
  import type { TaskPriority } from '@cleocode/contracts';

  /**
   * Props for {@link PriorityBadge}.
   */
  interface Props {
    /** Task priority — one of `critical | high | medium | low`. */
    priority: TaskPriority;
    /**
     * When true, render an ultra-compact stripe-only form (no label).
     * Useful on dense kanban cards. Default `false`.
     */
    compact?: boolean;
  }

  let { priority, compact = false }: Props = $props();

  const displayLabel = $derived(priority.charAt(0).toUpperCase() + priority.slice(1));
</script>

<span
  class="priority-badge priority-{priority}"
  class:compact
  role="img"
  aria-label={`Priority: ${displayLabel}`}
  title={displayLabel}
>
  <span class="stripe" aria-hidden="true"></span>
  {#if !compact}
    <span class="label">{displayLabel}</span>
  {/if}
</span>

<style>
  .priority-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.125rem 0.375rem 0.125rem 0;
    border-radius: 3px;
    font-size: 0.625rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    line-height: 1.4;
    background: transparent;
  }

  .priority-badge.compact {
    padding: 0;
    background: transparent;
  }

  .stripe {
    display: inline-block;
    width: 3px;
    height: 0.875rem;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .priority-badge.compact .stripe {
    width: 2px;
    height: 0.75rem;
  }

  .priority-critical .stripe {
    background: #f43f5e;
    box-shadow: 0 0 4px rgba(244, 63, 94, 0.5);
  }
  .priority-critical {
    color: #fca5a5;
  }

  .priority-high .stripe {
    background: #ef4444;
  }
  .priority-high {
    color: #fca5a5;
  }

  .priority-medium .stripe {
    background: #f59e0b;
  }
  .priority-medium {
    color: #f59e0b;
  }

  .priority-low .stripe {
    background: #6b7280;
  }
  .priority-low {
    color: #9ca3af;
  }
</style>
