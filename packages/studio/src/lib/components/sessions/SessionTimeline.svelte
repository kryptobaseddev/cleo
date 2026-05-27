<!--
  SessionTimeline — vertical timeline rail + expandable session
  cards. Extracted from `/tasks/sessions/+page.svelte` so future
  mini-timelines (e.g. on a task detail drawer) can reuse it.

  Includes a small per-session token-budget sparkline (synthetic for
  now — the tasks DB does not record per-hour token spend, so the
  series is derived from `completedTasks.length` weighted over the
  session duration as a visual hint that the row has activity).

  @task T990
  @wave 1E
-->
<script lang="ts">
  import Sparkline from '$lib/components/shell/Sparkline.svelte';
  import { Badge } from '$lib/ui';
  import type { SessionEntry } from '../../../routes/tasks/sessions/+page.server.js';

  interface Props {
    sessions: SessionEntry[];
    /** Id of the expanded session, or null when all collapsed. */
    expandedId?: string | null;
    /** Toggle callback. */
    onToggle?: (id: string) => void;
  }

  let { sessions, expandedId = $bindable(null), onToggle }: Props = $props();

  function toggle(id: string): void {
    expandedId = expandedId === id ? null : id;
    onToggle?.(id);
  }

  function formatDuration(ms: number | null): string {
    if (ms === null) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

  function formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  }

  function statusTone(s: string): 'success' | 'info' | 'neutral' {
    if (s === 'active') return 'success';
    if (s === 'ended') return 'info';
    return 'neutral';
  }

  /**
   * Build a visual activity series for the session. The tasks DB does
   * not persist token spend per hour, so we synthesise a gentle ramp
   * from `workedTasks` completion timestamps distributed across the
   * session duration. This is intentional: it gives the row visual
   * weight proportional to actual work without pretending to show
   * tokens.
   */
  function synthActivity(session: SessionEntry): number[] {
    const buckets = new Array<number>(12).fill(0);
    if (!session.endedAt && session.workedTasks.length === 0) return buckets;
    const startMs = new Date(session.startedAt).getTime();
    const endMs = new Date(session.endedAt ?? new Date().toISOString()).getTime();
    const span = Math.max(1, endMs - startMs);

    for (const wt of session.workedTasks) {
      try {
        const t = new Date(wt.setAt).getTime();
        const relative = Math.min(1, Math.max(0, (t - startMs) / span));
        const idx = Math.min(11, Math.floor(relative * buckets.length));
        const b = buckets[idx];
        if (typeof b === 'number') {
          buckets[idx] = b + 1;
        }
      } catch {
        // skip unparseable
      }
    }
    return buckets;
  }

  function sessionHasTasks(s: SessionEntry): boolean {
    return (
      s.completedTasks.length > 0 ||
      s.workedTasks.length > 0 ||
      s.currentTask !== null
    );
  }
</script>

<ol class="timeline" aria-label="Session timeline">
  {#each sessions as sess (sess.id)}
    {@const expanded = expandedId === sess.id}
    <li class="timeline-item">
      <div class="rail">
        <div class="rail-dot rail-dot-{sess.status}"></div>
        <div class="rail-line"></div>
      </div>

      <article class="session" class:expanded>
        <button
          type="button"
          class="session-head"
          aria-expanded={expanded}
          onclick={() => toggle(sess.id)}
        >
          <div class="head-top">
            <Badge tone={statusTone(sess.status)} size="sm">{sess.status}</Badge>
            <span class="head-name">{sess.name ?? sess.id}</span>
            {#if sess.agent}
              <code class="head-agent">{sess.agent}</code>
            {/if}
          </div>

          <div class="head-meta">
            <time class="head-time">{formatDate(sess.startedAt)}</time>
            {#if sess.endedAt}
              <span class="head-sep">→</span>
              <time class="head-time">{formatDate(sess.endedAt)}</time>
              <span class="head-dur">{formatDuration(sess.durationMs)}</span>
            {:else}
              <span class="head-dur head-dur-active">running</span>
            {/if}
          </div>

          <div class="head-stats">
            <div class="stats-inline">
              {#if sess.currentTask}
                <Badge tone="accent" size="sm">active: {sess.currentTask.id}</Badge>
              {/if}
              {#if sess.completedCount > 0}
                <Badge tone="success" size="sm">{sess.completedCount} done</Badge>
              {/if}
              {#if sess.createdCount > 0}
                <Badge tone="info" size="sm">{sess.createdCount} new</Badge>
              {/if}
              {#if sess.workedTasks.length > 0}
                <Badge tone="warning" size="sm">{sess.workedTasks.length} worked</Badge>
              {/if}
              {#if !sessionHasTasks(sess)}
                <Badge tone="neutral" size="sm">no tasks</Badge>
              {/if}
            </div>

            <Sparkline
              points={synthActivity(sess)}
              width={80}
              height={20}
              tone={sess.status === 'active' ? 'success' : 'accent'}
              strokeWidth={1}
              fill={false}
              ariaLabel="Session activity"
            />
          </div>
        </button>

        {#if expanded}
          <div class="session-body">
            {#if sess.currentTask}
              <section class="expand-section">
                <h3 class="expand-label">Active task</h3>
                <a class="expand-row expand-row-active" href={`/tasks/${sess.currentTask.id}`}>
                  <span class="row-id">{sess.currentTask.id}</span>
                  <span class="row-title">{sess.currentTask.title}</span>
                  <Badge tone="accent" size="sm">in progress</Badge>
                </a>
              </section>
            {/if}

            {#if sess.workedTasks.length > 0}
              <section class="expand-section">
                <h3 class="expand-label">Work history</h3>
                <div class="expand-list">
                  {#each sess.workedTasks as t (t.id + t.setAt)}
                    <a class="expand-row" href={`/tasks/${t.id}`}>
                      <span class="row-id">{t.id}</span>
                      <span class="row-title">{t.title}</span>
                      <time class="row-time">{formatDate(t.setAt)}</time>
                      <Badge tone={t.clearedAt ? 'success' : 'info'} size="sm">
                        {t.clearedAt ? 'done' : 'active'}
                      </Badge>
                    </a>
                  {/each}
                </div>
              </section>
            {/if}

            {#if sess.completedTasks.length > 0}
              <section class="expand-section">
                <h3 class="expand-label">Completed</h3>
                <div class="expand-list">
                  {#each sess.completedTasks as t}
                    <a class="expand-row" href={`/tasks/${t.id}`}>
                      <span class="row-id">{t.id}</span>
                      <span class="row-title">{t.title}</span>
                      <Badge tone="success" size="sm">{t.status}</Badge>
                    </a>
                  {/each}
                </div>
              </section>
            {/if}
          </div>
        {/if}
      </article>
    </li>
  {/each}
</ol>

<style>
  .timeline {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .timeline-item {
    display: flex;
    gap: var(--space-3);
    align-items: stretch;
  }

  .rail {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex-shrink: 0;
    width: 14px;
    padding-top: 0.75rem;
  }

  .rail-dot {
    width: 10px;
    height: 10px;
    border-radius: var(--radius-pill);
    background: var(--border);
    flex-shrink: 0;
    box-shadow: 0 0 0 2px var(--bg);
  }

  .rail-dot-active {
    background: var(--success);
    box-shadow: 0 0 0 2px var(--bg), 0 0 8px var(--success);
    animation: rail-pulse var(--ease-pulse);
  }

  @keyframes rail-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }

  .rail-dot-ended {
    background: var(--info);
  }

  .rail-line {
    width: 1px;
    flex: 1;
    background: var(--border);
    margin-top: 2px;
    min-height: 1rem;
  }

  .timeline-item:last-child .rail-line {
    display: none;
  }

  .session {
    flex: 1;
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    margin-bottom: var(--space-3);
    overflow: hidden;
    transition: border-color var(--ease);
    min-width: 0;
  }

  .session.expanded {
    border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
  }

  .session:hover {
    border-color: var(--border-strong);
  }

  .session-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    width: 100%;
    padding: var(--space-3) var(--space-4);
    background: transparent;
    border: none;
    cursor: pointer;
    text-align: left;
    color: inherit;
    font: inherit;
  }

  .session-head:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .head-top {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .head-name {
    font-size: var(--text-md);
    font-weight: 600;
    color: var(--text);
  }

  .head-agent {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--accent);
  }

  .head-meta {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-dim);
  }

  .head-time {
    font-variant-numeric: tabular-nums;
  }

  .head-sep {
    color: var(--border-strong);
  }

  .head-dur {
    background: var(--bg);
    color: var(--text);
    padding: 1px var(--space-2);
    border-radius: var(--radius-xs);
    font-variant-numeric: tabular-nums;
  }

  .head-dur-active {
    color: var(--success);
    background: var(--success-soft);
    animation: head-pulse var(--ease-pulse);
  }

  @keyframes head-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }

  .head-stats {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    justify-content: space-between;
    flex-wrap: wrap;
  }

  .stats-inline {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .session-body {
    padding: 0 var(--space-4) var(--space-4) var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    border-top: 1px solid var(--border);
  }

  .expand-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-top: var(--space-3);
  }

  .expand-label {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 0;
    font-weight: 600;
  }

  .expand-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .expand-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    background: var(--bg);
    border-radius: var(--radius-sm);
    text-decoration: none;
    color: inherit;
    transition: background var(--ease);
  }

  .expand-row:hover {
    background: var(--bg-elev-2);
  }

  .expand-row-active {
    border-left: 2px solid var(--accent);
  }

  .row-id {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--accent);
    font-weight: 600;
    flex-shrink: 0;
  }

  .row-title {
    font-size: var(--text-sm);
    color: var(--text);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-time {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }
</style>
