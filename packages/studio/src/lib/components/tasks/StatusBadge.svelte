<!--
  StatusBadge — inline pill rendering a task status with its canonical colour.

  Extracted from the duplicated `statusClass()` + `statusIcon()` helpers in
  `/tasks/+page.svelte`, `/tasks/pipeline/+page.svelte`,
  `/tasks/graph/+page.svelte`, and `/tasks/tree/[epicId]/+page.svelte` so the
  new 3-tab Task Explorer (T953/T954/T955) can share one visual language.

  Theme tokens match the dark palette in the standalone viz reference at
  `/tmp/task-viz/index.html` and the legacy Studio pages.

  @task T950
  @epic T949
-->
<script lang="ts">
  import type { TaskStatus } from '@cleocode/contracts';
  import { statusIcon } from './format.js';

  /**
   * Props for {@link StatusBadge}.
   */
  interface Props {
    /** Task status — one of the seven registry values. */
    status: TaskStatus;
    /**
     * When true, render a compact dot-only form (no label text).
     * Default `false`. Used by list rows where space is tight.
     */
    compact?: boolean;
    /**
     * Optional override for the accessible label. Defaults to the status
     * name capitalised, e.g. `"Done"`.
     */
    label?: string;
  }

  let { status, compact = false, label }: Props = $props();

  const displayLabel = $derived(label ?? status.charAt(0).toUpperCase() + status.slice(1));
  const ariaLabel = $derived(`Status: ${displayLabel}`);
</script>

<span
  class="status-badge status-{status}"
  class:compact
  role="status"
  aria-label={ariaLabel}
  title={displayLabel}
>
  <span class="glyph" aria-hidden="true">{statusIcon(status)}</span>
  {#if !compact}
    <span class="label">{displayLabel}</span>
  {/if}
</span>

<style>
  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.125rem 0.5rem;
    border-radius: 999px;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    line-height: 1.4;
    font-variant-numeric: tabular-nums;
  }

  .status-badge.compact {
    padding: 0;
    background: transparent;
    width: 1rem;
    justify-content: center;
  }

  .glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    line-height: 1;
  }

  .status-pending {
    background: rgba(245, 158, 11, 0.15);
    color: #f59e0b;
  }

  .status-active {
    background: rgba(59, 130, 246, 0.15);
    color: #3b82f6;
  }

  .status-blocked {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
  }

  .status-done {
    background: rgba(34, 197, 94, 0.15);
    color: #22c55e;
  }

  .status-cancelled {
    background: rgba(107, 114, 128, 0.15);
    color: #94a3b8;
  }

  .status-archived {
    background: rgba(71, 85, 105, 0.15);
    color: #64748b;
    opacity: 0.75;
  }

  .status-proposed {
    background: rgba(168, 85, 247, 0.15);
    color: #a855f7;
  }

  .status-badge.compact.status-pending {
    color: #f59e0b;
    background: transparent;
  }
  .status-badge.compact.status-active {
    color: #3b82f6;
    background: transparent;
  }
  .status-badge.compact.status-blocked {
    color: #ef4444;
    background: transparent;
  }
  .status-badge.compact.status-done {
    color: #22c55e;
    background: transparent;
  }
  .status-badge.compact.status-cancelled {
    color: #94a3b8;
    background: transparent;
  }
  .status-badge.compact.status-archived {
    color: #64748b;
    background: transparent;
  }
  .status-badge.compact.status-proposed {
    color: #a855f7;
    background: transparent;
  }
</style>
