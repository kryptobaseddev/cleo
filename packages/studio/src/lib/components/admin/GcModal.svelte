<!--
  GcModal — dry-run preview + typed-word confirm for
  `cleo nexus gc` garbage collection.

  Safety pattern:
    1. Preview (dry-run) is the default action — no side effects.
    2. Live execution requires typing the literal word `CLEAN`.

  @task T990
  @wave 1E
-->
<script lang="ts">
  import { Button, Modal } from '$lib/ui';

  interface GcResult {
    removed?: number;
    dryRun?: boolean;
    [key: string]: unknown;
  }

  interface Props {
    open?: boolean;
    onClose?: () => void;
    onSuccess?: () => void;
  }

  let { open = $bindable(true), onClose, onSuccess }: Props = $props();

  let confirmText = $state('');
  const liveConfirmed = $derived(confirmText === 'CLEAN');

  let loading = $state(false);
  let result = $state<GcResult | null>(null);
  let errorMsg = $state<string | null>(null);

  function handleClose(): void {
    open = false;
    onClose?.();
  }

  async function runGc(dryRun: boolean): Promise<void> {
    loading = true;
    errorMsg = null;
    result = null;

    try {
      const res = await fetch('/api/project/gc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun }),
      });
      const env = (await res.json()) as {
        success: boolean;
        data?: GcResult;
        error?: { message: string };
      };
      if (!env.success) {
        errorMsg = env.error?.message ?? 'GC failed';
      } else {
        result = { ...(env.data ?? {}), dryRun };
        if (!dryRun) onSuccess?.();
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : 'Unexpected error';
    } finally {
      loading = false;
    }
  }
</script>

<Modal bind:open title="Garbage Collect" maxWidth={36} onclose={handleClose}>
  <div class="body">
    <p class="description">
      Removes orphaned nexus rows (dead edges, unreferenced symbols).
      Preview first; live run requires typing
      <strong class="kw">CLEAN</strong>.
    </p>

    {#if errorMsg}
      <div class="alert" role="alert">{errorMsg}</div>
    {/if}

    {#if result}
      <div class="result" class:is-dry={result.dryRun}>
        <div class="result-head">
          {#if result.dryRun}
            <span class="tag tag-dry">DRY RUN</span>
          {:else}
            <span class="tag tag-live">REMOVED</span>
          {/if}
          {#if typeof result.removed === 'number'}
            <span class="result-summary">
              {result.removed} row{result.removed === 1 ? '' : 's'}
              {result.dryRun ? 'would be removed' : 'removed'}
            </span>
          {/if}
        </div>
      </div>
    {/if}

    <div class="confirm">
      <label class="confirm-label" for="gc-confirm-input">
        Type <strong class="kw">CLEAN</strong> to enable live run:
      </label>
      <input
        id="gc-confirm-input"
        type="text"
        class="confirm-input"
        placeholder="CLEAN"
        autocomplete="off"
        spellcheck="false"
        bind:value={confirmText}
      />
    </div>
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={handleClose}>Close</Button>
    <Button variant="secondary" onclick={() => runGc(true)} {loading}>Preview</Button>
    <Button
      variant="danger"
      disabled={!liveConfirmed || loading}
      {loading}
      onclick={() => runGc(false)}
    >
      Run GC
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

  .kw {
    font-family: var(--font-mono);
    color: var(--danger);
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
    padding: var(--space-3);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .result.is-dry {
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

  .confirm {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--danger-soft);
    border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
    border-radius: var(--radius-md);
  }

  .confirm-label {
    font-size: var(--text-sm);
    color: var(--text);
  }

  .confirm-input {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    padding: var(--space-2) var(--space-3);
    outline: none;
    transition: border-color var(--ease), box-shadow var(--ease);
  }

  .confirm-input:focus-visible {
    border-color: var(--danger);
    box-shadow: 0 0 0 3px var(--danger-soft);
  }
</style>
