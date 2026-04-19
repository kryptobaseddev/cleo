<!--
  SubstrateLegend — enhanced substrate chip rail.

  Behaviours per spec:
    - Click   → focus that substrate (single-select radio).
    - Dbl-click → solo that substrate (hide all others). Second dbl-click restores all.
    - Shift+click → toggle individual substrate visibility.
    - Each chip shows a firing indicator dot (pulses when the substrate is currently firing).

  @task T990
  @wave 1A
-->
<script lang="ts">
  import type { SubstrateId } from '$lib/graph/types.js';

  /**
   * Props for {@link SubstrateLegend}.
   */
  interface Props {
    /** Which substrates are currently enabled (visible). */
    enabledSubstrates: Set<SubstrateId>;
    /** Node counts per substrate for the chip labels. */
    nodeCounts: Partial<Record<SubstrateId, number>>;
    /** Substrates currently firing (drives pulse dot). */
    firingSubstrates?: Set<SubstrateId>;
    /** The currently focused (solo-zoomed) substrate, or null. */
    focusSubstrate: SubstrateId | null;
    /** Which substrate is in solo mode (all others hidden). */
    soloSubstrate: SubstrateId | null;
    /** Fired on click — focus this substrate. */
    onFocus?: (s: SubstrateId) => void;
    /** Fired on shift-click — toggle visibility. */
    onToggle?: (s: SubstrateId) => void;
    /** Fired on double-click — enter or exit solo mode. */
    onSolo?: (s: SubstrateId | null) => void;
  }

  const ALL_SUBSTRATES: SubstrateId[] = ['brain', 'nexus', 'tasks', 'conduit', 'signaldock'];

  const SUBSTRATE_META: Record<SubstrateId, { label: string; colorVar: string; regionName: string }> = {
    brain:      { label: 'brain',      colorVar: 'var(--info)',    regionName: 'BRAIN' },
    nexus:      { label: 'nexus',      colorVar: 'var(--success)', regionName: 'NEXUS' },
    tasks:      { label: 'tasks',      colorVar: 'var(--warning)', regionName: 'TASKS' },
    conduit:    { label: 'conduit',    colorVar: 'var(--accent)',  regionName: 'CONDUIT' },
    signaldock: { label: 'signaldock', colorVar: 'var(--danger)',  regionName: 'SIGNALDOCK' },
  };

  let {
    enabledSubstrates,
    nodeCounts,
    firingSubstrates = new Set<SubstrateId>(),
    focusSubstrate,
    soloSubstrate,
    onFocus,
    onToggle,
    onSolo,
  }: Props = $props();

  /** Timestamp of the last click per substrate — used for double-click detection. */
  const lastClick = new Map<SubstrateId, number>();
  const DBL_CLICK_MS = 300;

  function handleClick(s: SubstrateId, e: MouseEvent): void {
    const now = Date.now();
    const last = lastClick.get(s) ?? 0;
    lastClick.set(s, now);

    if (now - last < DBL_CLICK_MS) {
      // Double-click: enter or exit solo
      onSolo?.(soloSubstrate === s ? null : s);
      return;
    }

    if (e.shiftKey) {
      onToggle?.(s);
    } else {
      onFocus?.(s);
    }
  }
</script>

<div class="substrate-legend" role="group" aria-label="Substrate filters">
  {#each ALL_SUBSTRATES as s (s)}
    {@const meta = SUBSTRATE_META[s]}
    {@const enabled = enabledSubstrates.has(s)}
    {@const firing = firingSubstrates.has(s)}
    {@const isFocused = focusSubstrate === s}
    {@const isSolo = soloSubstrate === s}
    {@const count = nodeCounts[s] ?? 0}
    <button
      type="button"
      class="substrate-chip"
      class:enabled
      class:focused={isFocused}
      class:solo={isSolo}
      class:firing
      style="--chip-color: {meta.colorVar};"
      onclick={(e) => handleClick(s, e)}
      aria-pressed={enabled}
      aria-label="{meta.label}: {count} nodes{isSolo ? ', solo mode' : ''}{firing ? ', firing' : ''}"
      title="Click to focus · Shift+click to toggle · Double-click to solo"
      data-substrate={s}
    >
      <!-- Firing indicator dot -->
      <span class="fire-dot" class:firing aria-hidden="true"></span>

      <!-- Label + count -->
      <span class="chip-label">{meta.label}</span>
      <span class="chip-count">{count.toLocaleString()}</span>

      <!-- Solo badge -->
      {#if isSolo}
        <span class="solo-badge" aria-hidden="true">solo</span>
      {/if}
    </button>
  {/each}

  <!-- Clear-all / restore hint when in solo mode -->
  {#if soloSubstrate !== null}
    <button
      type="button"
      class="restore-btn"
      onclick={() => onSolo?.(null)}
      title="Restore all substrates"
      aria-label="Exit solo mode, restore all substrates"
    >
      restore all
    </button>
  {/if}
</div>

<style>
  .substrate-legend {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    flex-wrap: wrap;
  }

  /* -----------------------------------------------------------------------
   * Chip base
   * --------------------------------------------------------------------- */
  .substrate-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px var(--space-3);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-dim);
    cursor: pointer;
    transition:
      background var(--ease),
      border-color var(--ease),
      color var(--ease),
      box-shadow var(--ease),
      opacity var(--ease);
    user-select: none;
  }

  .substrate-chip:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .substrate-chip:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--border-strong);
    background: var(--bg-elev-2);
  }

  /* Enabled state */
  .substrate-chip.enabled {
    color: var(--chip-color);
    border-color: color-mix(in srgb, var(--chip-color) 40%, transparent);
    background: color-mix(in srgb, var(--chip-color) 10%, transparent);
  }

  /* Focused (camera drilled) */
  .substrate-chip.focused {
    border-color: var(--chip-color);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--chip-color) 30%, transparent);
  }

  /* Solo */
  .substrate-chip.solo {
    border-color: var(--chip-color);
    background: color-mix(in srgb, var(--chip-color) 18%, transparent);
    box-shadow:
      0 0 0 1px var(--chip-color),
      0 0 12px color-mix(in srgb, var(--chip-color) 25%, transparent);
  }

  /* Disabled (not enabled, not solo) */
  .substrate-chip:not(.enabled) {
    opacity: 0.5;
    color: var(--text-faint);
    border-color: var(--border);
    background: transparent;
  }

  /* -----------------------------------------------------------------------
   * Firing dot
   * --------------------------------------------------------------------- */
  .fire-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--border-strong);
    flex-shrink: 0;
    transition: background var(--ease);
  }

  .fire-dot.firing {
    background: var(--chip-color);
    animation: fire-pulse 1.2s ease-in-out infinite;
  }

  @keyframes fire-pulse {
    0%, 100% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--chip-color) 60%, transparent);
    }
    50% {
      box-shadow: 0 0 0 3px transparent;
    }
  }

  /* -----------------------------------------------------------------------
   * Count
   * --------------------------------------------------------------------- */
  .chip-count {
    font-size: 0.6rem;
    font-variant-numeric: tabular-nums;
    opacity: 0.7;
    background: rgba(255, 255, 255, 0.04);
    padding: 0 var(--space-1);
    border-radius: var(--radius-pill);
    font-weight: 600;
  }

  .chip-label {
    line-height: 1;
    white-space: nowrap;
  }

  /* -----------------------------------------------------------------------
   * Solo badge
   * --------------------------------------------------------------------- */
  .solo-badge {
    font-size: 0.55rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    background: var(--chip-color);
    color: var(--bg);
    border-radius: var(--radius-pill);
    padding: 0 4px;
    font-weight: 700;
    line-height: 1.4;
    margin-left: 2px;
  }

  /* -----------------------------------------------------------------------
   * Restore button
   * --------------------------------------------------------------------- */
  .restore-btn {
    display: inline-flex;
    align-items: center;
    padding: 3px var(--space-3);
    background: var(--bg-elev-2);
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-pill);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    cursor: pointer;
    transition: border-color var(--ease), color var(--ease), background var(--ease);
    margin-left: var(--space-1);
  }

  .restore-btn:hover,
  .restore-btn:focus-visible {
    color: var(--text);
    border-color: var(--border-strong);
    background: var(--bg-elev-2);
    outline: none;
  }

  /* Reduced motion */
  @media (prefers-reduced-motion: reduce) {
    .fire-dot.firing {
      animation: none;
    }
  }
</style>
