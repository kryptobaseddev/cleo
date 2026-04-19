<!--
  TabPanel — single panel body paired with a {@link Tabs} trigger.

  Pairs 1:1 with a `TabItem.value` in the parent Tabs component. The
  panel is always rendered but hidden via `hidden` attribute when the
  corresponding tab is inactive — this preserves scroll + form state
  across tab switches (and avoids flashing on CSR remount). Use
  `unmount={true}` if the panel content is heavy and should tear down
  when hidden.

  @task T990
  @wave 0
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * Props for {@link TabPanel}.
   */
  interface Props {
    /** Must match the `TabItem.value` of the corresponding trigger. */
    value: string;
    /** The currently active tab — compared against `value`. */
    active: string;
    /**
     * When true, the panel DOM is torn down when inactive instead of
     * being hidden. Defaults to `false`.
     */
    unmount?: boolean;
    /** Extra class names. */
    class?: string;
    /** Panel content. */
    children?: Snippet;
  }

  let {
    value,
    active,
    unmount = false,
    class: extraClass = '',
    children,
  }: Props = $props();

  const selected = $derived(value === active);
</script>

{#if selected || !unmount}
  <div
    class="tab-panel {extraClass}"
    role="tabpanel"
    id={`panel-${value}`}
    aria-labelledby={`tab-${value}`}
    hidden={!selected}
    tabindex={selected ? 0 : -1}
  >
    {#if children}{@render children()}{/if}
  </div>
{/if}

<style>
  .tab-panel {
    display: flex;
    flex-direction: column;
    outline: none;
    width: 100%;
  }

  .tab-panel:focus-visible {
    box-shadow: var(--shadow-focus);
    border-radius: var(--radius-md);
  }

  .tab-panel[hidden] {
    display: none;
  }
</style>
