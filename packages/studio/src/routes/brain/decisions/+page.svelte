<script lang="ts">
  import { onMount } from 'svelte';

  interface BrainDecision {
    id: string;
    type: string;
    decision: string;
    rationale: string;
    confidence: string;
    outcome: string | null;
    context_epic_id: string | null;
    context_task_id: string | null;
    context_phase: string | null;
    quality_score: number | null;
    memory_tier: string | null;
    verified: number;
    valid_at: string | null;
    invalid_at: string | null;
    prune_candidate: number;
    created_at: string;
  }

  let decisions: BrainDecision[] = $state([]);
  let total = $state(0);
  let loading = $state(true);
  let error: string | null = $state(null);
  let expandedId: string | null = $state(null);

  const CONFIDENCE_COLORS: Record<string, string> = {
    high: '#22c55e',
    medium: '#f59e0b',
    low: '#ef4444',
    unknown: '#64748b',
  };

  const TIER_COLORS: Record<string, string> = {
    short: '#64748b',
    medium: '#3b82f6',
    long: '#22c55e',
  };

  function confidenceColor(c: string): string {
    return CONFIDENCE_COLORS[c?.toLowerCase()] ?? '#64748b';
  }

  function tierColor(t: string | null): string {
    return TIER_COLORS[t ?? 'short'] ?? '#64748b';
  }

  async function loadDecisions(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await fetch('/api/brain/decisions');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { decisions: BrainDecision[]; total: number };
      decisions = data.decisions;
      total = data.total;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load decisions';
    } finally {
      loading = false;
    }
  }

  function toggle(id: string): void {
    expandedId = expandedId === id ? null : id;
  }

  onMount(() => {
    loadDecisions();
  });
</script>

<svelte:head>
  <title>BRAIN Decisions — CLEO Studio</title>
</svelte:head>

<div class="decisions-page">
  <div class="page-header">
    <a href="/brain/overview" class="back-link">← Overview</a>
    <h1 class="page-title">Decisions Timeline</h1>
    {#if !loading && !error}
      <span class="count-badge">{total} decisions</span>
    {/if}
    <a href="/brain?scope=brain&type=decision" class="canvas-pill">Open in Canvas &rarr;</a>
  </div>

  {#if loading}
    <div class="loading">Loading decisions…</div>
  {:else if error}
    <div class="error">{error}</div>
  {:else if decisions.length === 0}
    <div class="empty">No decisions found in brain.db.</div>
  {:else}
    <div class="timeline">
      {#each decisions as dec}
        <div class="timeline-item" class:expanded={expandedId === dec.id} class:invalidated={!!dec.invalid_at}>
          <div class="timeline-connector">
            <div class="timeline-dot" style="background:{tierColor(dec.memory_tier)}"></div>
            <div class="timeline-line"></div>
          </div>

          <div class="timeline-content">
            <button class="timeline-header" onclick={() => toggle(dec.id)}>
              <div class="timeline-meta">
                <span class="decision-date">{dec.created_at.slice(0, 10)}</span>
                <span class="decision-type">{dec.type}</span>
                <span class="confidence-badge" style="color:{confidenceColor(dec.confidence)}">
                  {dec.confidence}
                </span>
                {#if dec.memory_tier}
                  <span class="tier-badge" style="border-color:{tierColor(dec.memory_tier)};color:{tierColor(dec.memory_tier)}"
                    >{dec.memory_tier}</span
                  >
                {/if}
                {#if dec.verified}
                  <span class="status-badge verified">verified</span>
                {/if}
                {#if dec.prune_candidate}
                  <span class="status-badge prune">prune</span>
                {/if}
                {#if dec.invalid_at}
                  <span class="status-badge invalid">invalidated</span>
                {/if}
              </div>
              <p class="decision-text">{dec.decision}</p>
            </button>

            {#if expandedId === dec.id}
              <div class="decision-detail">
                <div class="detail-section">
                  <span class="detail-label">Rationale</span>
                  <p class="detail-text">{dec.rationale}</p>
                </div>
                {#if dec.outcome}
                  <div class="detail-section">
                    <span class="detail-label">Outcome</span>
                    <p class="detail-text">{dec.outcome}</p>
                  </div>
                {/if}
                <div class="detail-footer">
                  <span class="detail-id">{dec.id}</span>
                  {#if dec.context_task_id}
                    <span class="detail-ctx">Task: {dec.context_task_id}</span>
                  {/if}
                  {#if dec.context_epic_id}
                    <span class="detail-ctx">Epic: {dec.context_epic_id}</span>
                  {/if}
                  {#if dec.quality_score !== null && dec.quality_score !== undefined}
                    <span class="detail-ctx">Quality: {dec.quality_score.toFixed(2)}</span>
                  {/if}
                </div>
              </div>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .decisions-page {
    max-width: 780px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .page-header {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .back-link {
    font-size: 0.8125rem;
    color: #64748b;
    text-decoration: none;
  }

  .back-link:hover {
    color: #22c55e;
  }

  .canvas-pill {
    margin-left: auto;
    padding: 0.25rem 0.875rem;
    border-radius: 999px;
    font-size: 0.8125rem;
    font-weight: 500;
    color: #3b82f6;
    text-decoration: none;
    border: 1px solid rgba(59, 130, 246, 0.4);
    background: rgba(59, 130, 246, 0.08);
    transition:
      background 0.15s,
      border-color 0.15s;
    white-space: nowrap;
  }

  .canvas-pill:hover {
    background: rgba(59, 130, 246, 0.18);
    border-color: #3b82f6;
  }

  .page-title {
    font-size: 1.25rem;
    font-weight: 700;
    color: #f1f5f9;
  }

  .count-badge {
    font-size: 0.75rem;
    color: #64748b;
    padding: 0.125rem 0.5rem;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 999px;
  }

  .loading,
  .error,
  .empty {
    text-align: center;
    padding: 3rem;
    font-size: 0.875rem;
    color: #64748b;
  }

  .error {
    color: #ef4444;
  }

  .timeline {
    display: flex;
    flex-direction: column;
  }

  .timeline-item {
    display: flex;
    gap: 1rem;
  }

  .timeline-item.invalidated {
    opacity: 0.45;
  }

  .timeline-connector {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex-shrink: 0;
    width: 20px;
  }

  .timeline-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
    margin-top: 1rem;
  }

  .timeline-line {
    flex: 1;
    width: 1px;
    background: #2d3748;
    margin: 4px 0;
    min-height: 16px;
  }

  .timeline-item:last-child .timeline-line {
    display: none;
  }

  .timeline-content {
    flex: 1;
    min-width: 0;
    padding: 0.625rem 0 0.875rem;
  }

  .timeline-header {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-align: left;
    width: 100%;
  }

  .timeline-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .decision-date {
    font-size: 0.6875rem;
    color: #475569;
    font-variant-numeric: tabular-nums;
  }

  .decision-type {
    font-size: 0.6875rem;
    color: #64748b;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    padding: 0 0.3rem;
    border-radius: 3px;
  }

  .confidence-badge {
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
  }

  .tier-badge {
    font-size: 0.6875rem;
    padding: 0 0.3rem;
    border-radius: 3px;
    border: 1px solid;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .status-badge {
    font-size: 0.6875rem;
    padding: 0.1rem 0.375rem;
    border-radius: 3px;
  }

  .status-badge.verified {
    background: rgba(34, 197, 94, 0.15);
    color: #22c55e;
  }

  .status-badge.prune {
    background: rgba(245, 158, 11, 0.15);
    color: #f59e0b;
  }

  .status-badge.invalid {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
  }

  .decision-text {
    font-size: 0.875rem;
    color: #e2e8f0;
    font-weight: 500;
    line-height: 1.4;
  }

  .decision-detail {
    margin-top: 0.625rem;
    padding: 0.75rem;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .detail-section {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .detail-label {
    font-size: 0.6875rem;
    font-weight: 600;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .detail-text {
    font-size: 0.8125rem;
    color: #94a3b8;
    line-height: 1.5;
  }

  .detail-footer {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    padding-top: 0.375rem;
    border-top: 1px solid #2d3748;
  }

  .detail-id {
    font-size: 0.6875rem;
    color: #475569;
    font-family: monospace;
  }

  .detail-ctx {
    font-size: 0.6875rem;
    color: #64748b;
  }
</style>
