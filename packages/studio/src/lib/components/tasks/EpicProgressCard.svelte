<!--
  EpicProgressCard — direct-children rollup panel extracted verbatim from
  `packages/studio/src/routes/tasks/+page.svelte:371-409`.

  Preservation contract per `docs/specs/CLEO-TASK-DASHBOARD-SPEC.md` §9:
    - Direct-children basis per T874 (numerator + denominator symmetric).
    - Per-epic progress bar shows `done / total` on direct children only.
    - Row click navigates to `/tasks/tree/{epic.id}` (existing deep-link).
    - `includeCancelled` toggle via `?cancelled=1` is honoured at the
      data-loader level (T958 rename from the legacy `?deferred=1`); this
      component just renders whatever rows it receives.

  This component is presentational — no API calls. Data shape matches the
  `EpicProgress` server-shape returned by `_computeEpicProgressViaRollup`.

  @task T950 | T958
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
    /** Epic's own status (used to render the `cancelled` badge). */
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
   *
   * T958: `includingDeferred` renamed to `includingCancelled` to match the
   * canonical URL param (`?cancelled=1`). The deprecated prop name is still
   * accepted for one release so external consumers do not break.
   */
  interface Props {
    /** One row per epic, already filtered by the server load. */
    epics: EpicProgressRow[];
    /**
     * When true, show the `(including cancelled)` subtitle and render
     * cancelled epics with reduced opacity + a `cancelled` badge.
     *
     * T958 — canonical name. Prefer this over {@link Props.includingDeferred}.
     */
    includingCancelled?: boolean;
    /**
     * @deprecated T958 — use {@link Props.includingCancelled}. Still honoured
     * for one release to keep pre-rename callers working.
     */
    includingDeferred?: boolean;
    /**
     * Override the default deep-link target. When omitted, clicks navigate
     * to `/tasks/tree/{id}`. Exposed so the Hybrid Explorer can also route
     * through `/tasks?view=hierarchy&epic=<id>` if the operator prefers.
     */
    hrefFor?: (epic: EpicProgressRow) => string;
  }

  let {
    epics,
    includingCancelled = false,
    includingDeferred = false,
    hrefFor,
  }: Props = $props();

  // T958 back-compat: if only the deprecated prop was passed, honour it.
  const showingCancelled = $derived(includingCancelled || includingDeferred);

  function defaultHref(ep: EpicProgressRow): string {
    return `/tasks/tree/${ep.id}`;
  }

  const resolveHref = $derived(hrefFor ?? defaultHref);
</script>

{#if epics.length > 0}
  <section class="epic-progress panel">
    <h2 class="panel-title">
      Epic Progress
      {#if showingCancelled}
        <span class="panel-sub">(including cancelled)</span>
      {/if}
    </h2>
    <div class="epic-list">
      {#each epics as ep (ep.id)}
        {@const pct = progressPct(ep.done, ep.total)}
        <a
          href={resolveHref(ep)}
          class="epic-row"
          class:epic-cancelled={ep.status === 'cancelled'}
        >
          <div class="epic-header-row">
            <span class="epic-id">{ep.id}</span>
            <span class="epic-title">{ep.title}</span>
            {#if ep.status === 'cancelled'}
              <!-- T958: badge renamed from 'deferred' to 'cancelled' -->
              <span class="epic-status-badge badge-cancelled">cancelled</span>
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
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  .panel-title {
    padding: 0.75rem 1rem;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--border);
    margin: 0;
  }

  .panel-sub {
    font-size: 0.7rem;
    color: var(--text-faint);
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
    border-bottom: 1px solid var(--border);
    text-decoration: none;
    color: inherit;
    transition: background var(--ease);
  }

  .epic-row:hover {
    background: var(--bg-elev-2);
  }

  .epic-row:last-child {
    border-bottom: none;
  }

  /* T958: cancelled epic styling (was .epic-deferred). */
  .epic-row.epic-cancelled {
    opacity: 0.7;
  }

  .epic-row.epic-cancelled .epic-title {
    color: var(--text-dim);
  }

  .epic-header-row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }

  .epic-id {
    font-size: 0.7rem;
    color: var(--accent);
    font-weight: 600;
    flex-shrink: 0;
  }

  .epic-title {
    font-size: var(--text-sm);
    color: var(--text);
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
    border-radius: var(--radius-xs);
    flex-shrink: 0;
  }

  .badge-cancelled {
    background: var(--danger-soft);
    color: var(--danger);
  }

  .epic-counts {
    font-size: var(--text-xs);
    color: var(--success);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  .epic-pct {
    font-size: var(--text-xs);
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  .epic-progress-bar {
    height: 4px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
  }

  .epic-done-bar {
    height: 100%;
    background: var(--success);
    border-radius: 2px;
    transition: width 0.3s ease;
  }

  .epic-sub-counts {
    display: flex;
    gap: 0.75rem;
    font-size: 0.7rem;
  }

  .sub-done {
    color: var(--success);
  }
  .sub-active {
    color: var(--info);
  }
  .sub-pending {
    color: var(--text-faint);
  }
  .sub-cancelled {
    color: var(--danger);
  }
</style>
