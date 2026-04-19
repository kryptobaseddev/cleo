<!--
  BrainStreamIndicator — streaming progress indicator for Phase 1/2 loads.

  Shows a dot-pulse "streaming..." badge when tier-0 data has loaded but
  tier-1+ is still streaming in. Shows a simulation warmup progress bar
  in the corner. Disappears entirely once streaming is complete.

  @task T990
  @wave 1A
-->
<script lang="ts">
  /**
   * Props for {@link BrainStreamIndicator}.
   */
  interface Props {
    /** Whether streaming is currently active. */
    streaming: boolean;
    /**
     * Simulation warmup progress [0..100].
     * Drives the corner progress bar. At 100 the bar fades out.
     */
    warmupProgress: number;
  }

  let { streaming, warmupProgress }: Props = $props();

  const warmupDone = $derived(warmupProgress >= 100);
</script>

{#if streaming || !warmupDone}
  <div class="stream-overlay" aria-live="polite" aria-label="Brain data loading status">
    {#if streaming}
      <div class="stream-badge">
        <span class="pulse-dot d1" aria-hidden="true"></span>
        <span class="pulse-dot d2" aria-hidden="true"></span>
        <span class="pulse-dot d3" aria-hidden="true"></span>
        <span class="stream-label">streaming</span>
      </div>
    {/if}

    {#if !warmupDone}
      <div class="warmup-bar-wrap" aria-label="Simulation warming up: {warmupProgress}%">
        <span class="warmup-label">simulation warming {warmupProgress}%</span>
        <div class="warmup-track" role="progressbar" aria-valuenow={warmupProgress} aria-valuemin={0} aria-valuemax={100}>
          <div class="warmup-fill" style="width: {warmupProgress}%"></div>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .stream-overlay {
    position: absolute;
    top: var(--space-3);
    right: var(--space-3);
    z-index: 10;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-2);
    pointer-events: none;
  }

  /* -----------------------------------------------------------------------
   * Streaming badge
   * --------------------------------------------------------------------- */
  .stream-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 4px var(--space-3);
    background: color-mix(in srgb, var(--bg-elev-2) 88%, transparent);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-pill);
    backdrop-filter: blur(6px);
  }

  .pulse-dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--accent);
    display: inline-block;
    animation: dot-bounce 1.2s ease-in-out infinite;
  }

  .d1 { animation-delay: 0ms; }
  .d2 { animation-delay: 200ms; }
  .d3 { animation-delay: 400ms; }

  @keyframes dot-bounce {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
    40%            { opacity: 1;   transform: scale(1.2); }
  }

  .stream-label {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-dim);
    margin-left: var(--space-1);
  }

  /* -----------------------------------------------------------------------
   * Warmup progress bar
   * --------------------------------------------------------------------- */
  .warmup-bar-wrap {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 3px;
    background: color-mix(in srgb, var(--bg-elev-2) 88%, transparent);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
    backdrop-filter: blur(6px);
    min-width: 160px;
  }

  .warmup-label {
    font-family: var(--font-mono);
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }

  .warmup-track {
    width: 100%;
    height: 2px;
    background: var(--border);
    border-radius: var(--radius-pill);
    overflow: hidden;
  }

  .warmup-fill {
    height: 100%;
    background: var(--accent);
    border-radius: var(--radius-pill);
    transition: width 200ms ease;
    max-width: 100%;
  }

  /* Reduced motion */
  @media (prefers-reduced-motion: reduce) {
    .pulse-dot {
      animation: none;
      opacity: 0.8;
    }

    .warmup-fill {
      transition: none;
    }
  }
</style>
