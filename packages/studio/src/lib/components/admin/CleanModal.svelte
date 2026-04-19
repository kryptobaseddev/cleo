<!--
  CleanModal — runs `cleo nexus projects clean` via `/api/project/clean`.

  Refactored onto `$lib/ui/Modal` in Wave 1E. Preserves the safety flow:
  Preview (dry-run) first; destructive Purge requires typing the literal
  word `PURGE`.

  @task T990
  @wave 1E
-->
<script lang="ts">
  import { Button, Input, Modal } from '$lib/ui';

  interface CleanResult {
    removed?: number;
    paths?: string[];
    dryRun?: boolean;
  }

  interface Props {
    open?: boolean;
    onClose?: () => void;
    onSuccess?: () => void;
  }

  let { open = $bindable(true), onClose, onSuccess }: Props = $props();

  let includeTemp = $state(true);
  let includeTests = $state(false);
  let includeUnhealthy = $state(false);
  let includeNeverIndexed = $state(false);
  let pattern = $state('');

  let purgeInput = $state('');
  const purgeConfirmed = $derived(purgeInput === 'PURGE');

  let loading = $state(false);
  let result = $state<CleanResult | null>(null);
  let errorMsg = $state<string | null>(null);

  function handleClose(): void {
    open = false;
    onClose?.();
  }

  async function runClean(dryRun: boolean): Promise<void> {
    loading = true;
    result = null;
    errorMsg = null;

    try {
      const res = await fetch('/api/project/clean', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          includeTemp,
          includeTests,
          includeUnhealthy,
          includeNeverIndexed,
          pattern: pattern.trim() || undefined,
          dryRun,
        }),
      });

      const envelope = (await res.json()) as {
        success: boolean;
        data?: Record<string, unknown>;
        error?: { message: string };
      };

      if (!envelope.success) {
        errorMsg = envelope.error?.message ?? 'Clean failed';
      } else {
        const data = envelope.data ?? {};
        result = {
          removed: typeof data['removed'] === 'number' ? data['removed'] : undefined,
          dryRun: typeof data['dryRun'] === 'boolean' ? data['dryRun'] : dryRun,
          paths: Array.isArray(data['paths']) ? (data['paths'] as string[]).slice(0, 50) : undefined,
        };
        if (!dryRun) onSuccess?.();
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : 'Unexpected error';
    } finally {
      loading = false;
    }
  }
</script>

<Modal bind:open title="Clean Project Registry" maxWidth={34} onclose={handleClose}>
  <div class="clean-body">
    <fieldset class="filters">
      <legend class="legend">Target filters</legend>
      <label class="row">
        <input type="checkbox" bind:checked={includeTemp} class="check" />
        <span>Include <code>.temp</code> paths</span>
      </label>
      <label class="row">
        <input type="checkbox" bind:checked={includeTests} class="check" />
        <span>Include test / tmp / fixture / scratch / sandbox paths</span>
      </label>
      <label class="row">
        <input type="checkbox" bind:checked={includeUnhealthy} class="check" />
        <span>Include unhealthy projects</span>
      </label>
      <label class="row">
        <input type="checkbox" bind:checked={includeNeverIndexed} class="check" />
        <span>Include never-indexed projects</span>
      </label>
    </fieldset>

    <Input
      label="Pattern filter"
      description="Optional regex applied to project paths."
      placeholder="e.g. /tmp/"
      bind:value={pattern}
    />

    <div class="purge-section">
      <p class="purge-label">Confirm destructive purge</p>
      <p class="purge-hint">
        Type <strong class="purge-keyword">PURGE</strong> to enable the red button.
      </p>
      <input
        type="text"
        class="purge-input"
        placeholder="PURGE"
        autocomplete="off"
        spellcheck="false"
        bind:value={purgeInput}
      />
    </div>

    {#if errorMsg}
      <div class="alert" role="alert">{errorMsg}</div>
    {/if}

    {#if result !== null}
      <div class="result" class:is-dry-run={result.dryRun}>
        <div class="result-head">
          {#if result.dryRun}
            <span class="tag tag-dry">DRY RUN</span>
          {:else}
            <span class="tag tag-live">PURGED</span>
          {/if}
          {#if result.removed !== undefined}
            <span class="result-summary">
              {result.removed} project{result.removed === 1 ? '' : 's'}
              {result.dryRun ? 'would be' : ''} removed
            </span>
          {/if}
        </div>
        {#if result.paths && result.paths.length > 0}
          <ul class="paths">
            {#each result.paths as p}
              <li class="path">{p}</li>
            {/each}
          </ul>
        {:else}
          <p class="empty">No matching projects.</p>
        {/if}
      </div>
    {/if}
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={handleClose}>Close</Button>
    <Button variant="secondary" {loading} onclick={() => runClean(true)}>
      Preview
    </Button>
    <Button
      variant="danger"
      disabled={!purgeConfirmed || loading}
      {loading}
      onclick={() => runClean(false)}
    >
      Purge
    </Button>
  {/snippet}
</Modal>

<style>
  .clean-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .filters {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    background: var(--bg);
  }

  .legend {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 0 var(--space-2);
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text);
    cursor: pointer;
  }

  .check {
    accent-color: var(--accent);
    width: 16px;
    height: 16px;
  }

  code {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    background: var(--bg-elev-1);
    color: var(--text-dim);
    padding: 1px 4px;
    border-radius: var(--radius-xs);
  }

  .purge-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4);
    background: var(--danger-soft);
    border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
    border-radius: var(--radius-md);
  }

  .purge-label {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--danger);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin: 0;
  }

  .purge-hint {
    font-size: var(--text-xs);
    color: var(--text-dim);
    margin: 0;
  }

  .purge-keyword {
    font-family: var(--font-mono);
    color: var(--danger);
  }

  .purge-input {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    padding: var(--space-2) var(--space-3);
    outline: none;
  }

  .purge-input:focus-visible {
    border-color: var(--danger);
    box-shadow: 0 0 0 3px var(--danger-soft);
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
    padding: var(--space-3) var(--space-4);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .result.is-dry-run {
    border-color: color-mix(in srgb, var(--warning) 40%, transparent);
  }

  .result-head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .tag {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    padding: 2px var(--space-2);
    border-radius: var(--radius-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 700;
  }

  .tag-dry {
    background: var(--warning-soft);
    color: var(--warning);
  }

  .tag-live {
    background: var(--danger-soft);
    color: var(--danger);
  }

  .result-summary {
    font-size: var(--text-sm);
    color: var(--text-dim);
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
    word-break: break-all;
  }

  .empty {
    font-size: var(--text-sm);
    color: var(--text-dim);
    margin: 0;
  }
</style>
