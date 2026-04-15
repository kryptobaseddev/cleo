<script lang="ts">
  interface CleanResult {
    removed?: number;
    paths?: string[];
    dryRun?: boolean;
  }

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  // Filter toggles
  let includeTemp = $state(true);
  let includeTests = $state(false);
  let includeUnhealthy = $state(false);
  let includeNeverIndexed = $state(false);
  let pattern = $state('');

  // Purge confirmation
  let purgeInput = $state('');
  const purgeConfirmed = $derived(purgeInput === 'PURGE');

  let loading = $state(false);
  let result = $state<CleanResult | null>(null);
  let errorMsg = $state<string | null>(null);

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }

  async function runClean(dryRun: boolean) {
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
          paths: Array.isArray(data['paths'])
            ? (data['paths'] as string[]).slice(0, 50)
            : undefined,
        };
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : 'Unexpected error';
    } finally {
      loading = false;
    }
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<div
  class="modal-backdrop"
  role="presentation"
  onclick={onClose}
  onkeydown={handleKeydown}
></div>

<div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="clean-modal-title">
  <div class="modal-header">
    <h2 id="clean-modal-title" class="modal-title">Clean Project Registry</h2>
    <button type="button" class="close-btn" onclick={onClose} aria-label="Close">&#x2715;</button>
  </div>

  <div class="modal-body">
    <p class="section-label">Target filters:</p>

    <div class="checkbox-group">
      <label class="checkbox-row">
        <input type="checkbox" class="checkbox" bind:checked={includeTemp} />
        <span class="checkbox-label">Include <code>.temp</code> paths</span>
      </label>
      <label class="checkbox-row">
        <input type="checkbox" class="checkbox" bind:checked={includeTests} />
        <span class="checkbox-label">Include test / tmp / fixture / scratch / sandbox paths</span>
      </label>
      <label class="checkbox-row">
        <input type="checkbox" class="checkbox" bind:checked={includeUnhealthy} />
        <span class="checkbox-label">Include unhealthy projects</span>
      </label>
      <label class="checkbox-row">
        <input type="checkbox" class="checkbox" bind:checked={includeNeverIndexed} />
        <span class="checkbox-label">Include never-indexed projects</span>
      </label>
    </div>

    <div class="field">
      <label class="field-label" for="clean-pattern">Pattern filter (optional regex)</label>
      <input
        id="clean-pattern"
        type="text"
        class="field-input"
        placeholder="e.g. /tmp/"
        bind:value={pattern}
      />
    </div>

    <div class="purge-section">
      <p class="section-label">Confirm destructive purge:</p>
      <p class="purge-hint">
        Type <strong class="purge-keyword">PURGE</strong> below to enable the real-delete button.
      </p>
      <input
        type="text"
        class="field-input purge-input"
        placeholder="PURGE"
        autocomplete="off"
        spellcheck="false"
        bind:value={purgeInput}
      />
    </div>

    {#if loading}
      <div class="status-row">
        <span class="spinner" aria-hidden="true"></span>
        <span class="status-text">Running…</span>
      </div>
    {/if}

    {#if errorMsg}
      <div class="error-box" role="alert">{errorMsg}</div>
    {/if}

    {#if result !== null}
      <div class="results-box" class:dry-run={result.dryRun}>
        <div class="results-header">
          {#if result.dryRun}
            <span class="tag dry-run-tag">DRY RUN</span>
          {:else}
            <span class="tag purge-tag">PURGED</span>
          {/if}
          {#if result.removed !== undefined}
            <span class="removed-count">{result.removed} project(s) would be removed</span>
          {/if}
        </div>

        {#if result.paths && result.paths.length > 0}
          <ul class="paths-list">
            {#each result.paths as p}
              <li class="path-item">{p}</li>
            {/each}
          </ul>
        {:else}
          <p class="no-results">No matching projects found.</p>
        {/if}
      </div>
    {/if}
  </div>

  <div class="modal-footer">
    <button type="button" class="btn btn-cancel" onclick={onClose}>Close</button>
    <button
      type="button"
      class="btn btn-preview"
      onclick={() => runClean(true)}
      disabled={loading}
    >
      {loading ? 'Running…' : 'Preview'}
    </button>
    <button
      type="button"
      class="btn btn-danger"
      onclick={() => runClean(false)}
      disabled={!purgeConfirmed || loading}
    >
      Purge
    </button>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 100;
  }

  .modal-dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 101;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    width: min(520px, 92vw);
    max-height: 85vh;
    display: flex;
    flex-direction: column;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.25rem;
    border-bottom: 1px solid #2d3748;
    flex-shrink: 0;
  }

  .modal-title {
    font-size: 1rem;
    font-weight: 600;
    color: #f1f5f9;
    margin: 0;
  }

  .close-btn {
    background: none;
    border: none;
    color: #64748b;
    cursor: pointer;
    font-size: 1rem;
    padding: 0.25rem;
    line-height: 1;
  }

  .close-btn:hover {
    color: #94a3b8;
  }

  .modal-body {
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    overflow-y: auto;
  }

  .section-label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: #94a3b8;
    margin: 0;
  }

  .checkbox-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
  }

  .checkbox {
    accent-color: #3b82f6;
    width: 1rem;
    height: 1rem;
    cursor: pointer;
    flex-shrink: 0;
  }

  .checkbox-label {
    font-size: 0.875rem;
    color: #cbd5e1;
  }

  .checkbox-label code {
    font-family: monospace;
    font-size: 0.8125rem;
    background: #0f1117;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    color: #94a3b8;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .field-label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: #94a3b8;
  }

  .field-input {
    background: #0f1117;
    border: 1px solid #2d3748;
    border-radius: 5px;
    padding: 0.5rem 0.75rem;
    color: #f1f5f9;
    font-size: 0.875rem;
    font-family: monospace;
    width: 100%;
    box-sizing: border-box;
    outline: none;
    transition: border-color 0.15s;
  }

  .field-input:focus {
    border-color: #3b82f6;
  }

  .purge-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.875rem;
    background: rgba(239, 68, 68, 0.06);
    border: 1px solid rgba(239, 68, 68, 0.2);
    border-radius: 5px;
  }

  .purge-hint {
    font-size: 0.8125rem;
    color: #94a3b8;
    margin: 0;
  }

  .purge-keyword {
    color: #ef4444;
    font-family: monospace;
  }

  .purge-input:focus {
    border-color: #ef4444;
  }

  .status-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .spinner {
    display: inline-block;
    width: 1rem;
    height: 1rem;
    border: 2px solid #2d3748;
    border-top-color: #3b82f6;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .status-text {
    font-size: 0.875rem;
    color: #64748b;
  }

  .error-box {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 5px;
    padding: 0.75rem;
    font-size: 0.875rem;
    color: #fca5a5;
  }

  .results-box {
    background: #0f1117;
    border: 1px solid #2d3748;
    border-radius: 5px;
    padding: 0.875rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .results-box.dry-run {
    border-color: #f59e0b;
  }

  .results-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .tag {
    font-size: 0.6875rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    padding: 0.125rem 0.5rem;
    border-radius: 3px;
    text-transform: uppercase;
  }

  .dry-run-tag {
    background: rgba(245, 158, 11, 0.15);
    color: #f59e0b;
    border: 1px solid rgba(245, 158, 11, 0.3);
  }

  .purge-tag {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
    border: 1px solid rgba(239, 68, 68, 0.3);
  }

  .removed-count {
    font-size: 0.875rem;
    color: #cbd5e1;
  }

  .paths-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    max-height: 160px;
    overflow-y: auto;
  }

  .path-item {
    font-size: 0.75rem;
    font-family: monospace;
    color: #94a3b8;
    word-break: break-all;
    padding: 0.125rem 0;
  }

  .no-results {
    font-size: 0.875rem;
    color: #64748b;
    margin: 0;
  }

  .modal-footer {
    display: flex;
    gap: 0.75rem;
    justify-content: flex-end;
    padding: 1rem 1.25rem;
    border-top: 1px solid #2d3748;
    flex-shrink: 0;
  }

  .btn {
    padding: 0.375rem 1rem;
    border-radius: 5px;
    font-size: 0.8125rem;
    font-weight: 500;
    border: 1px solid transparent;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, opacity 0.15s;
  }

  .btn-cancel {
    background: transparent;
    color: #94a3b8;
    border-color: #2d3748;
  }

  .btn-cancel:hover {
    background: #2d3748;
    color: #e2e8f0;
  }

  .btn-preview {
    background: transparent;
    color: #f59e0b;
    border-color: rgba(245, 158, 11, 0.4);
  }

  .btn-preview:hover:not(:disabled) {
    background: rgba(245, 158, 11, 0.1);
  }

  .btn-preview:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .btn-danger {
    background: #ef4444;
    color: white;
    border-color: #ef4444;
  }

  .btn-danger:hover:not(:disabled) {
    background: #dc2626;
    border-color: #dc2626;
  }

  .btn-danger:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }
</style>
