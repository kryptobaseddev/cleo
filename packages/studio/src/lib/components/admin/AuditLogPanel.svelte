<!--
  AuditLogPanel — reads `.cleo/audit/studio-actions.jsonl` via
  `/api/project/audit` and renders the trailing N entries.

  Read-only. Displays timestamp, actor, action, target, and result.
  Rows can expand to show metadata / error payload when present.

  @task T990
  @wave 1E
-->
<script lang="ts">
  import { Badge, Button } from '$lib/ui';

  interface AuditEntry {
    timestamp: string;
    actor: string;
    action: string;
    target: string | null;
    result: 'success' | 'failure' | 'dry-run' | 'initiated';
    detail?: string | null;
    meta?: Record<string, unknown>;
  }

  interface Props {
    /** Initial entries from server load. Optional. */
    initial?: AuditEntry[];
    /** Extra class names. */
    class?: string;
  }

  let { initial = [], class: extraClass = '' }: Props = $props();

  const initialEntries: AuditEntry[] = initial;
  let entries = $state<AuditEntry[]>(initialEntries);
  let loading = $state(false);
  let errorMsg = $state<string | null>(null);
  let expandedIdx = $state<number | null>(null);

  async function refresh(): Promise<void> {
    loading = true;
    errorMsg = null;
    try {
      const res = await fetch('/api/project/audit');
      const env = (await res.json()) as {
        success: boolean;
        data?: { entries: AuditEntry[] };
        error?: { message: string };
      };
      if (env.success && env.data) {
        entries = env.data.entries ?? [];
      } else {
        errorMsg = env.error?.message ?? 'Unable to read audit log';
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : 'Unexpected error';
    } finally {
      loading = false;
    }
  }

  function resultTone(
    r: AuditEntry['result'],
  ): 'success' | 'warning' | 'danger' | 'neutral' | 'info' {
    if (r === 'success') return 'success';
    if (r === 'failure') return 'danger';
    if (r === 'dry-run') return 'warning';
    return 'info';
  }

  function formatTime(iso: string): string {
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return iso;
    }
  }

  function toggle(i: number): void {
    expandedIdx = expandedIdx === i ? null : i;
  }

  function hasDetails(entry: AuditEntry): boolean {
    return Boolean(entry.detail) || Boolean(entry.meta && Object.keys(entry.meta).length > 0);
  }

  $effect(() => {
    if (entries.length === 0 && !loading && initialEntries.length === 0) {
      void refresh();
    }
  });
</script>

<section class="audit-panel {extraClass}" aria-label="Admin action audit log">
  <header class="panel-head">
    <h3 class="panel-title">
      Audit log
      {#if entries.length > 0}
        <span class="panel-count">{entries.length}</span>
      {/if}
    </h3>
    <Button variant="ghost" size="sm" onclick={refresh} loading={loading}>
      Refresh
    </Button>
  </header>

  {#if errorMsg}
    <div class="alert" role="alert">{errorMsg}</div>
  {/if}

  {#if entries.length === 0 && !loading}
    <p class="empty">No recorded admin actions yet.</p>
  {:else}
    <ol class="log-list">
      {#each entries as entry, i (entry.timestamp + entry.action + i)}
        {@const expandable = hasDetails(entry)}
        <li class="log-item">
          <div class="row">
            <time class="ts">{formatTime(entry.timestamp)}</time>
            <code class="action">{entry.action}</code>
            <Badge tone={resultTone(entry.result)} size="sm">{entry.result}</Badge>
            {#if entry.target}
              <span class="target">{entry.target}</span>
            {/if}
            <span class="actor">{entry.actor}</span>
            {#if expandable}
              <button
                type="button"
                class="expand-btn"
                aria-expanded={expandedIdx === i}
                aria-label={expandedIdx === i ? 'Collapse entry' : 'Expand entry'}
                onclick={() => toggle(i)}
              >
                {expandedIdx === i ? '▾' : '▸'}
              </button>
            {/if}
          </div>
          {#if expandedIdx === i && expandable}
            <div class="details">
              {#if entry.detail}
                <p class="detail-text">{entry.detail}</p>
              {/if}
              {#if entry.meta}
                <pre class="meta">{JSON.stringify(entry.meta, null, 2)}</pre>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .audit-panel {
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }

  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .panel-title {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-weight: 600;
    margin: 0;
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .panel-count {
    font-family: var(--font-mono);
    background: var(--bg-elev-2);
    color: var(--text);
    font-size: var(--text-2xs);
    padding: 1px var(--space-2);
    border-radius: var(--radius-xs);
    font-variant-numeric: tabular-nums;
  }

  .alert {
    background: var(--danger-soft);
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    color: var(--danger);
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-xs);
    border-radius: var(--radius-sm);
  }

  .empty {
    font-size: var(--text-sm);
    color: var(--text-dim);
    margin: 0;
    font-style: italic;
  }

  .log-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 480px;
    overflow-y: auto;
  }

  .log-item {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2);
    background: var(--bg);
    border-radius: var(--radius-sm);
    border-left: 2px solid var(--border);
    transition: border-color var(--ease);
  }

  .log-item:hover {
    border-left-color: var(--accent);
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .ts {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
    min-width: 120px;
  }

  .action {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--accent);
    background: var(--accent-halo);
    padding: 1px var(--space-2);
    border-radius: var(--radius-xs);
  }

  .target {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-dim);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .actor {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
  }

  .expand-btn {
    background: transparent;
    border: none;
    color: var(--text-dim);
    font-size: var(--text-sm);
    cursor: pointer;
    padding: 0 var(--space-1);
    line-height: 1;
  }

  .expand-btn:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
    border-radius: var(--radius-xs);
  }

  .details {
    padding: var(--space-2) var(--space-3);
    background: var(--bg-elev-1);
    border-radius: var(--radius-sm);
    margin-top: var(--space-1);
  }

  .detail-text {
    font-size: var(--text-xs);
    color: var(--text-dim);
    margin: 0 0 var(--space-1) 0;
  }

  .meta {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text);
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
