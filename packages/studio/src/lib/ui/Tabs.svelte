<!--
  Tabs — accessible tablist with full keyboard navigation.

  Implements the WAI-ARIA Authoring Practices tab pattern:
    - role=tablist on the bar, role=tab on triggers, role=tabpanel on bodies.
    - ArrowLeft / ArrowRight moves focus + activates between tabs.
    - Home / End jump to first / last.
    - Space / Enter activates the focused tab (redundant here because
      activation is follow-focus, but some AT users press Enter anyway).
    - Roving tabindex: only the active trigger has tabindex=0.

  Use alongside {@link TabPanel} — each panel declares its `id` which
  matches the `Tab.value`. Active tab is bindable so parents can sync
  to URL state.

  @task T990
  @wave 0
-->
<script lang="ts" module>
  /**
   * A single tab descriptor.
   */
  export interface TabItem {
    /** Opaque value. Must be unique within the tablist. */
    value: string;
    /** Visible label. */
    label: string;
    /** Optional numeric count badge. */
    count?: number;
    /** When true, the tab renders disabled and skips keyboard focus. */
    disabled?: boolean;
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * Props for {@link Tabs}.
   */
  interface Props {
    /** Tab definitions. */
    items: TabItem[];
    /** Bindable active tab value. */
    value?: string;
    /** Accessible label for the tablist. */
    label?: string;
    /** Extra class names on the tablist bar. */
    class?: string;
    /** Panel slot — typically holds {@link TabPanel} children. */
    children?: Snippet;
    /** Fires on activation with the new value. */
    onchange?: (value: string) => void;
  }

  let {
    items,
    value = $bindable(items[0]?.value ?? ''),
    label = 'Tabs',
    class: extraClass = '',
    children,
    onchange,
  }: Props = $props();

  let triggers: HTMLButtonElement[] = $state([]);

  function activate(next: string): void {
    if (next === value) return;
    value = next;
    onchange?.(next);
  }

  function indexFor(v: string): number {
    return items.findIndex((i) => i.value === v);
  }

  function moveBy(delta: number): void {
    const enabled = items
      .map((i, idx) => ({ i, idx }))
      .filter(({ i }) => !i.disabled);
    if (enabled.length === 0) return;
    const cur = enabled.findIndex(({ i }) => i.value === value);
    const at = cur === -1 ? 0 : cur;
    const next = (at + delta + enabled.length) % enabled.length;
    const { i, idx } = enabled[next];
    activate(i.value);
    triggers[idx]?.focus();
  }

  function handleKey(e: KeyboardEvent, tab: TabItem): void {
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        moveBy(1);
        return;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        moveBy(-1);
        return;
      case 'Home':
        e.preventDefault();
        {
          const firstEnabled = items.find((i) => !i.disabled);
          if (firstEnabled) {
            activate(firstEnabled.value);
            triggers[indexFor(firstEnabled.value)]?.focus();
          }
        }
        return;
      case 'End':
        e.preventDefault();
        {
          const lastEnabled = [...items].reverse().find((i) => !i.disabled);
          if (lastEnabled) {
            activate(lastEnabled.value);
            triggers[indexFor(lastEnabled.value)]?.focus();
          }
        }
        return;
      case ' ':
      case 'Enter':
        e.preventDefault();
        if (!tab.disabled) activate(tab.value);
    }
  }
</script>

<div class="tabs-root {extraClass}">
  <div class="tablist" role="tablist" aria-label={label}>
    {#each items as item, idx (item.value)}
      {@const selected = item.value === value}
      <button
        bind:this={triggers[idx]}
        type="button"
        class="tab"
        class:selected
        role="tab"
        aria-selected={selected}
        aria-controls={`panel-${item.value}`}
        id={`tab-${item.value}`}
        tabindex={selected ? 0 : -1}
        disabled={item.disabled}
        onclick={() => !item.disabled && activate(item.value)}
        onkeydown={(e) => handleKey(e, item)}
      >
        <span class="tab-label">{item.label}</span>
        {#if typeof item.count === 'number'}
          <span class="tab-count">{item.count}</span>
        {/if}
      </button>
    {/each}
  </div>

  <div class="panel-region">
    {#if children}{@render children()}{/if}
  </div>
</div>

<style>
  .tabs-root {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    width: 100%;
  }

  .tablist {
    display: inline-flex;
    gap: var(--space-1);
    padding: var(--space-1);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    width: fit-content;
    max-width: 100%;
    flex-wrap: wrap;
  }

  .tab {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-dim);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: 500;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background var(--ease), color var(--ease),
      border-color var(--ease), box-shadow var(--ease);
  }

  .tab:hover:not(:disabled):not(.selected) {
    background: var(--bg-elev-2);
    color: var(--text);
  }

  .tab.selected {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-soft);
  }

  .tab:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .tab:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .tab-count {
    font-size: var(--text-2xs);
    padding: 0 var(--space-2);
    border-radius: var(--radius-pill);
    background: var(--bg);
    color: inherit;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  .tab.selected .tab-count {
    background: var(--accent);
    color: var(--bg);
  }

  .panel-region {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
</style>
