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
    background: var(--warning-soft);
    color: var(--status-pending);
  }

  .status-active {
    background: var(--info-soft);
    color: var(--status-active);
  }

  .status-blocked {
    background: var(--danger-soft);
    color: var(--status-blocked);
  }

  .status-done {
    background: var(--success-soft);
    color: var(--status-done);
  }

  .status-cancelled {
    background: var(--neutral-soft);
    color: var(--text-dim);
  }

  .status-archived {
    background: var(--neutral-soft);
    color: var(--status-archived);
    opacity: 0.75;
  }

  .status-proposed {
    background: var(--accent-soft);
    color: var(--status-proposed);
  }

  .status-badge.compact.status-pending {
    color: var(--status-pending);
    background: transparent;
  }
  .status-badge.compact.status-active {
    color: var(--status-active);
    background: transparent;
  }
  .status-badge.compact.status-blocked {
    color: var(--status-blocked);
    background: transparent;
  }
  .status-badge.compact.status-done {
    color: var(--status-done);
    background: transparent;
  }
  .status-badge.compact.status-cancelled {
    color: var(--text-dim);
    background: transparent;
  }
  .status-badge.compact.status-archived {
    color: var(--status-archived);
    background: transparent;
  }
  .status-badge.compact.status-proposed {
    color: var(--status-proposed);
    background: transparent;
  }
</style>
