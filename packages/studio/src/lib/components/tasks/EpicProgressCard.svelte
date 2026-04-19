<!--
  EpicProgressCard — direct-children rollup panel extracted verbatim from
  `packages/studio/src/routes/tasks/+page.svelte:371-409`.

  Preservation contract per `docs/specs/CLEO-TASK-DASHBOARD-SPEC.md` §9:
    - Direct-children basis per T874 (numerator + denominator symmetric).
    - Per-epic progress bar shows `done / total` on direct children only.
    - Row click navigates to `/tasks/tree/{epic.id}` (existing deep-link).
    - `includeDeferred` toggle via `?deferred=1` is honoured at data-loader
      level; this component just renders whatever rows it receives.

  This component is presentational — no API calls. Data shape matches the
  `EpicProgress` server-shape returned by `_computeEpicProgressViaRollup`.

  @task T950
  @epic T949
-->
<script lang="ts">
  import { progressPct } from './format.js';

  /**
   * A single direct-children rollup row rendered by the card.
   *
   * Matches the server-shape returned by
   * `_computeEpicProgressViaRollup` in `routes/tasks/+page.server.ts`.
   */
  export interface EpicProgressRow {
    /** Epic task ID. */
    id: string;
    /** Epic title. */
    title: string;
    /** Epic's own status (used to render the `deferred` badge). */
    status: string;
    /** Total count of direct non-archived children. */
    total: number;
    /** Count of direct children with `status='done'`. */
    done: number;
    /** Count of direct children with `status='active'`. */
    active: number;
    /** Count of direct children with `status='pending'`. */
    pending: number;
    /** Count of direct children with `status='cancelled'`. */
    cancelled: number;
  }

  /**
   * Props for {@link EpicProgressCard}.
   */
  interface Props {
    /** One row per epic, already filtered by the server load. */
    epics: EpicProgressRow[];
    /**
     * When true, show the `(including deferred)` subtitle and render
     * cancelled epics with reduced opacity + a `deferred` badge.
     */
    includingDeferred?: boolean;
    /**
     * Override the default deep-link target. When omitted, clicks navigate
     * to `/tasks/tree/{id}`. Exposed so the Hybrid Explorer can also route
     * through `/tasks?view=hierarchy&epic=<id>` if the operator prefers.
     */
    hrefFor?: (epic: EpicProgressRow) => string;
  }

  let { epics, includingDeferred = false, hrefFor }: Props = $props();

  function defaultHref(ep: EpicProgressRow): string {
    return `/tasks/tree/${ep.id}`;
  }

  const resolveHref = $derived(hrefFor ?? defaultHref);
</script>

{#if epics.length > 0}
  <section class="epic-progress panel">
    <h2 class="panel-title">
      Epic Progress
      {#if includingDeferred}
        <span class="panel-sub">(including deferred)</span>
      {/if}
    </h2>
    <div class="epic-list">
      {#each epics as ep (ep.id)}
        {@const pct = progressPct(ep.done, ep.total)}
        <a
          href={resolveHref(ep)}
          class="epic-row"
          class:epic-deferred={ep.status === 'cancelled'}
        >
          <div class="epic-header-row">
            <span class="epic-id">{ep.id}</span>
            <span class="epic-title">{ep.title}</span>
            {#if ep.status === 'cancelled'}
              <span class="epic-status-badge badge-cancelled">deferred</span>
            {/if}
            <span class="epic-counts">{ep.done}/{ep.total}</span>
            <span class="epic-pct">{pct}%</span>
          </div>
          <div class="epic-progress-bar">
            <div class="epic-done-bar" style="width:{pct}%"></div>
          </div>
          <div class="epic-sub-counts">
            <span class="sub-done">{ep.done} done</span>
            <span class="sub-active">{ep.active} active</span>
            <span class="sub-pending">{ep.pending} pending</span>
            {#if ep.cancelled > 0}
              <span class="sub-cancelled">{ep.cancelled} cancelled</span>
            {/if}
          </div>
        </a>
      {/each}
    </div>
  </section>
{/if}

<style>
  .panel {
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    overflow: hidden;
  }

  .panel-title {
    padding: 0.75rem 1rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid #2d3748;
    margin: 0;
  }

  .panel-sub {
    font-size: 0.7rem;
    color: #64748b;
    font-weight: 400;
    margin-left: 0.5rem;
    text-transform: none;
    letter-spacing: 0;
  }

  .epic-list {
    display: flex;
    flex-direction: column;
  }

  .epic-row {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid #1e2435;
    text-decoration: none;
    color: inherit;
    transition: background 0.15s;
  }

  .epic-row:hover {
    background: #21273a;
  }

  .epic-row:last-child {
    border-bottom: none;
  }

  .epic-row.epic-deferred {
    opacity: 0.7;
  }

  .epic-row.epic-deferred .epic-title {
    color: #94a3b8;
  }

  .epic-header-row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }

  .epic-id {
    font-size: 0.7rem;
    color: #a855f7;
    font-weight: 600;
    flex-shrink: 0;
  }

  .epic-title {
    font-size: 0.8125rem;
    color: #e2e8f0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .epic-status-badge {
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0.1rem 0.375rem;
    border-radius: 3px;
    flex-shrink: 0;
  }

  .badge-cancelled {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
  }

  .epic-counts {
    font-size: 0.75rem;
    color: #22c55e;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  .epic-pct {
    font-size: 0.75rem;
    color: #94a3b8;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  .epic-progress-bar {
    height: 4px;
    background: #2d3748;
    border-radius: 2px;
    overflow: hidden;
  }

  .epic-done-bar {
    height: 100%;
    background: #22c55e;
    border-radius: 2px;
    transition: width 0.3s ease;
  }

  .epic-sub-counts {
    display: flex;
    gap: 0.75rem;
    font-size: 0.7rem;
  }

  .sub-done {
    color: #22c55e;
  }
  .sub-active {
    color: #3b82f6;
  }
  .sub-pending {
    color: #64748b;
  }
  .sub-cancelled {
    color: #ef4444;
  }
</style>
