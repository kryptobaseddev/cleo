<!--
  HoverLabel — floating hover card surfaced over a graph canvas when
  the user pointer is on a node.

  The Wave 1A contract: renderers must NOT draw node labels on the
  canvas (see `no-face-up.ts`). Instead, hovered nodes expose their
  label through this component, which the renderer positions via
  absolute coordinates relative to the canvas container.

  @task T990
  @wave 1a
-->
<script lang="ts">
  import type { GraphNode } from './types.js';

  /**
   * Props for {@link HoverLabel}.
   */
  interface Props {
    /** Node under the pointer, or null to hide. */
    node: GraphNode | null;
    /** Pointer x, relative to the canvas container (in pixels). */
    x: number;
    /** Pointer y, relative to the canvas container (in pixels). */
    y: number;
    /** Optional secondary line. */
    secondary?: string | null;
    /** Optional accent colour (CSS variable reference). */
    accent?: string;
  }

  let { node, x, y, secondary = null, accent = 'var(--accent)' }: Props = $props();
</script>

{#if node}
  <div
    class="hover-label"
    role="tooltip"
    aria-hidden="true"
    style="left: {x + 14}px; top: {y + 14}px; --hover-accent: {accent};"
  >
    <span class="dot" aria-hidden="true"></span>
    <span class="content">
      <span class="label">{node.label}</span>
      <span class="meta">
        <span class="kind">{node.kind}</span>
        {#if secondary}
          <span class="sep" aria-hidden="true">·</span>
          <span class="secondary">{secondary}</span>
        {/if}
      </span>
    </span>
  </div>
{/if}

<style>
  .hover-label {
    position: absolute;
    pointer-events: none;
    z-index: 40;
    display: inline-flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    max-width: 320px;
    background: var(--bg-elev-2);
    border: 1px solid var(--border-strong);
    border-left: 2px solid var(--hover-accent);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
    font-family: var(--font-sans);
    color: var(--text);
  }

  .dot {
    width: 6px;
    height: 6px;
    margin-top: 5px;
    flex-shrink: 0;
    background: var(--hover-accent);
    border-radius: 50%;
    box-shadow: 0 0 10px var(--hover-accent);
  }

  .content {
    display: inline-flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .label {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-2xs);
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .kind {
    font-weight: 600;
    color: var(--hover-accent);
  }

  .sep {
    color: var(--text-faint);
  }

  .secondary {
    color: var(--text-dim);
    font-family: var(--font-mono);
    text-transform: none;
    letter-spacing: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 180px;
  }
</style>
