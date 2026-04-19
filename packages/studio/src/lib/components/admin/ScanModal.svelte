<!--
  ScanModal — runs `cleo nexus projects scan` via `/api/project/scan`.

  Refactored onto `$lib/ui/Modal` in Wave 1E so focus trap, backdrop
  blur, and Esc handling are all handled by the native `<dialog>` shell
  that the Wave 0 primitive ships. Preserves prior behaviour:
  comma-separated roots, max depth slider, optional auto-register.

  @task T990
  @wave 1E
-->
<script lang="ts">
  import { Button, Input, Modal } from '$lib/ui';

  interface ScanResult {
    registered?: number;
    unregistered?: number;
    paths?: string[];
    total?: number;
  }

  interface Props {
    /** Bindable open state. */
    open?: boolean;
    /** Close callback — fires after user dismisses. */
    onClose?: () => void;
    /** Callback fired when a scan completes successfully (refresh list). */
    onSuccess?: () => void;
  }

  let { open = $bindable(true), onClose, onSuccess }: Props = $props();

  let roots = $state('~/code,~/projects,/mnt/projects');
  let maxDepth = $state('4');
  let autoRegister = $state(false);

  let loading = $state(false);
  let result = $state<ScanResult | null>(null);
  let errorMsg = $state<string | null>(null);

  function handleClose(): void {
    open = false;
    onClose?.();
  }

  async function runScan(): Promise<void> {
    loading = true;
    result = null;
    errorMsg = null;

    const depth = Number.parseInt(maxDepth, 10);

    try {
      const res = await fetch('/api/project/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roots,
          maxDepth: Number.isFinite(depth) ? depth : undefined,
          autoRegister,
        }),
      });

      const envelope = (await res.json()) as {
        success: boolean;
        data?: Record<string, unknown>;
        error?: { message: string };
      };

      if (!envelope.success) {
        errorMsg = envelope.error?.message ?? 'Scan failed';
      } else {
        const data = envelope.data ?? {};
        result = {
          registered: typeof data['registered'] === 'number' ? data['registered'] : undefined,
          unregistered: typeof data['unregistered'] === 'number' ? data['unregistered'] : undefined,
          total: typeof data['total'] === 'number' ? data['total'] : undefined,
          paths: Array.isArray(data['paths']) ? (data['paths'] as string[]).slice(0, 50) : undefined,
        };
        onSuccess?.();
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : 'Unexpected error';
    } finally {
      loading = false;
    }
  }
</script>

<Modal bind:open title="Scan for Projects" maxWidth={34} onclose={handleClose}>
  <div class="scan-body">
    <Input
      label="Root paths (comma-separated)"
      description="Absolute or home-relative directories to crawl. `~` is expanded server-side."
      bind:value={roots}
      placeholder="~/code,~/projects,/mnt/projects"
    />

    <Input
      type="number"
      label="Max depth"
      description="Directory levels to descend before stopping."
      bind:value={maxDepth}
      placeholder="4"
    />

    <label class="auto-row">
      <input type="checkbox" bind:checked={autoRegister} class="auto-check" />
      <span class="auto-label">Auto-register discovered projects</span>
    </label>

    {#if errorMsg}
      <div class="alert" role="alert">{errorMsg}</div>
    {/if}

    {#if result}
      <div class="result-panel" role="status">
        <div class="counts">
          {#if result.total !== undefined}
            <div class="count-chip">
              <span class="count-num">{result.total}</span>
              <span class="count-lbl">Found</span>
            </div>
          {/if}
          {#if result.registered !== undefined}
            <div class="count-chip t-success">
              <span class="count-num">{result.registered}</span>
              <span class="count-lbl">Registered</span>
            </div>
          {/if}
          {#if result.unregistered !== undefined}
            <div class="count-chip t-warning">
              <span class="count-num">{result.unregistered}</span>
              <span class="count-lbl">Unregistered</span>
            </div>
          {/if}
        </div>

        {#if result.paths && result.paths.length > 0}
          <ul class="paths">
            {#each result.paths as p}
              <li class="path">{p}</li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={handleClose}>Close</Button>
    <Button variant="primary" {loading} onclick={runScan}>
      {loading ? 'Scanning' : 'Run scan'}
    </Button>
  {/snippet}
</Modal>

<style>
  .scan-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .auto-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    cursor: pointer;
  }

  .auto-check {
    accent-color: var(--accent);
    width: 16px;
    height: 16px;
    cursor: pointer;
  }

  .auto-label {
    font-size: var(--text-sm);
    color: var(--text);
  }

  .alert {
    background: var(--danger-soft);
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    color: var(--danger);
    padding: var(--space-3);
    font-size: var(--text-sm);
    border-radius: var(--radius-md);
  }

  .result-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .counts {
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .count-chip {
    display: flex;
    flex-direction: column;
    padding: var(--space-2) var(--space-3);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-left: 2px solid var(--text-faint);
    border-radius: var(--radius-sm);
    min-width: 96px;
  }

  .count-chip.t-success {
    border-left-color: var(--success);
  }

  .count-chip.t-warning {
    border-left-color: var(--warning);
  }

  .count-num {
    font-family: var(--font-mono);
    font-size: var(--text-lg);
    font-weight: 700;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .count-lbl {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .paths {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 180px;
    overflow-y: auto;
  }

  .path {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-dim);
    padding: 2px 0;
    word-break: break-all;
  }
</style>
