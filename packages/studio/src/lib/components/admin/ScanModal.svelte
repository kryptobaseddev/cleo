<script lang="ts">
  interface ScanResult {
    registered?: number;
    unregistered?: number;
    paths?: string[];
    total?: number;
  }

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  let roots = $state('~/code,~/projects,/mnt/projects');
  let maxDepth = $state(4);
  let autoRegister = $state(false);

  let loading = $state(false);
  let result = $state<ScanResult | null>(null);
  let errorMsg = $state<string | null>(null);

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }

  async function runScan() {
    loading = true;
    result = null;
    errorMsg = null;

    try {
      const res = await fetch('/api/project/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roots, maxDepth, autoRegister }),
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

<div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="scan-modal-title">
  <div class="modal-header">
    <h2 id="scan-modal-title" class="modal-title">Scan for Projects</h2>
    <button type="button" class="close-btn" onclick={onClose} aria-label="Close">&#x2715;</button>
  </div>

  <div class="modal-body">
    <div class="field">
      <label class="field-label" for="scan-roots">Root Paths (comma-separated)</label>
      <textarea
        id="scan-roots"
        class="field-textarea"
        rows="3"
        placeholder="~/code,~/projects,/mnt/projects"
        bind:value={roots}
      ></textarea>
    </div>

    <div class="field">
      <label class="field-label" for="scan-depth">Max Depth</label>
      <input
        id="scan-depth"
        type="number"
        class="field-input"
        min="1"
        max="10"
        bind:value={maxDepth}
      />
    </div>

    <div class="checkbox-field">
      <input
        id="scan-auto-register"
        type="checkbox"
        class="checkbox"
        bind:checked={autoRegister}
      />
      <label for="scan-auto-register" class="checkbox-label">
        Auto-register discovered projects
      </label>
    </div>

    {#if loading}
      <div class="status-row">
        <span class="spinner" aria-hidden="true"></span>
        <span class="status-text">Scanning…</span>
      </div>
    {/if}

    {#if errorMsg}
      <div class="error-box" role="alert">{errorMsg}</div>
    {/if}

    {#if result}
      <div class="results-box">
        <div class="results-counts">
          {#if result.total !== undefined}
            <span class="count-item">
              <span class="count-value">{result.total}</span>
              <span class="count-label">Found</span>
            </span>
          {/if}
          {#if result.registered !== undefined}
            <span class="count-item">
              <span class="count-value registered">{result.registered}</span>
              <span class="count-label">Registered</span>
            </span>
          {/if}
          {#if result.unregistered !== undefined}
            <span class="count-item">
              <span class="count-value unregistered">{result.unregistered}</span>
              <span class="count-label">Unregistered</span>
            </span>
          {/if}
        </div>

        {#if result.paths && result.paths.length > 0}
          <ul class="paths-list">
            {#each result.paths as p}
              <li class="path-item">{p}</li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  </div>

  <div class="modal-footer">
    <button type="button" class="btn btn-cancel" onclick={onClose}>Close</button>
    <button type="button" class="btn btn-primary" onclick={runScan} disabled={loading}>
      {loading ? 'Scanning…' : 'Run Scan'}
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
    max-height: 80vh;
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

  .field-textarea,
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
    resize: vertical;
    transition: border-color 0.15s;
  }

  .field-textarea:focus,
  .field-input:focus {
    border-color: #3b82f6;
  }

  .field-input {
    width: 6rem;
    font-family: inherit;
  }

  .checkbox-field {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .checkbox {
    accent-color: #3b82f6;
    width: 1rem;
    height: 1rem;
    cursor: pointer;
  }

  .checkbox-label {
    font-size: 0.875rem;
    color: #cbd5e1;
    cursor: pointer;
  }

  .status-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: #64748b;
    font-size: 0.875rem;
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

  .results-counts {
    display: flex;
    gap: 1.5rem;
    flex-wrap: wrap;
  }

  .count-item {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .count-value {
    font-size: 1.25rem;
    font-weight: 700;
    color: #e2e8f0;
    font-variant-numeric: tabular-nums;
  }

  .count-value.registered {
    color: #10b981;
  }

  .count-value.unregistered {
    color: #f59e0b;
  }

  .count-label {
    font-size: 0.6875rem;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.04em;
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
    padding: 0.125rem 0;
    word-break: break-all;
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
    transition: background 0.15s, border-color 0.15s;
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

  .btn-primary {
    background: #3b82f6;
    color: white;
    border-color: #3b82f6;
  }

  .btn-primary:hover:not(:disabled) {
    background: #2563eb;
    border-color: #2563eb;
  }

  .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
