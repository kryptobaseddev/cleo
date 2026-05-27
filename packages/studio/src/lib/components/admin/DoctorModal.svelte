<!--
  DoctorModal — runs `/api/project/doctor` and renders the diagnostics
  envelope. Read-only; safe to trigger freely.

  @task T990
  @wave 1E
-->
<script lang="ts">
  import { Badge, Button, Modal } from '$lib/ui';

  interface Props {
    open?: boolean;
    /** Optional project id to scope the doctor call. */
    projectId?: string | null;
    onClose?: () => void;
  }

  let { open = $bindable(true), projectId = null, onClose }: Props = $props();

  interface DiagnosticsData {
    [key: string]: unknown;
  }

  let loading = $state(false);
  let errorMsg = $state<string | null>(null);
  let data = $state<DiagnosticsData | null>(null);
  let ranAt = $state<string | null>(null);

  function handleClose(): void {
    open = false;
    onClose?.();
  }

  async function runDoctor(): Promise<void> {
    loading = true;
    errorMsg = null;
    data = null;

    try {
      const res = await fetch('/api/project/doctor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(projectId ? { projectId } : {}),
      });

      const envelope = (await res.json()) as {
        success: boolean;
        data?: DiagnosticsData;
        error?: { message: string };
      };

      if (!envelope.success) {
        errorMsg = envelope.error?.message ?? 'Doctor failed';
      } else {
        data = envelope.data ?? {};
        ranAt = new Date().toLocaleTimeString();
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : 'Unexpected error';
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (open && data === null && !loading) {
      void runDoctor();
    }
  });

  function formatValue(value: unknown): string {
    if (value === null) return 'null';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function getHealthTone(issues: unknown): 'success' | 'warning' | 'danger' | 'neutral' {
    if (!Array.isArray(issues)) return 'neutral';
    if (issues.length === 0) return 'success';
    if (issues.length < 5) return 'warning';
    return 'danger';
  }
</script>

<Modal bind:open title="Project Doctor" maxWidth={48} onclose={handleClose}>
  <div class="body">
    <p class="description">
      Runs <code>cleo nexus doctor</code> against the active project. Reports schema versions, row
      counts, orphaned references, and broken links.
    </p>

    {#if loading}
      <div class="state">
        <span class="spinner" aria-hidden="true"></span>
        <span>Running diagnostics…</span>
      </div>
    {/if}

    {#if errorMsg}
      <div class="alert" role="alert">{errorMsg}</div>
    {/if}

    {#if data}
      <div class="result">
        <div class="result-head">
          <Badge tone={getHealthTone(data['issues'])}>
            {Array.isArray(data['issues']) && data['issues'].length === 0 ? 'healthy' : 'issues'}
          </Badge>
          {#if ranAt}
            <span class="result-time">checked at {ranAt}</span>
          {/if}
        </div>

        <div class="fields">
          {#each Object.entries(data) as [key, value]}
            <div class="field">
              <span class="field-key">{key}</span>
              <pre class="field-value">{formatValue(value)}</pre>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={handleClose}>Close</Button>
    <Button variant="secondary" onclick={runDoctor} {loading}>
      {loading ? 'Running' : 'Re-run'}
    </Button>
  {/snippet}
</Modal>

<style>
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .description {
    font-size: var(--text-sm);
    color: var(--text-dim);
    line-height: var(--leading-normal);
    margin: 0;
  }

  .description code {
    font-family: var(--font-mono);
    background: var(--bg-elev-1);
    color: var(--accent);
    padding: 1px var(--space-2);
    border-radius: var(--radius-xs);
  }

  .state {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text-dim);
    font-size: var(--text-sm);
  }

  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: var(--radius-pill);
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner { animation: none; }
  }

  .alert {
    background: var(--danger-soft);
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    color: var(--danger);
    padding: var(--space-3);
    font-size: var(--text-sm);
    border-radius: var(--radius-md);
  }

  .result {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .result-head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .result-time {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
  }

  .fields {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    max-height: 420px;
    overflow-y: auto;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .field-key {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .field-value {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text);
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: var(--leading-normal);
  }
</style>
