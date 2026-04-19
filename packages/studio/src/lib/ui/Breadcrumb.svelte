<!--
  Breadcrumb — ordered list of navigational crumbs with chevron
  separators.

  Uses `<nav aria-label="Breadcrumb">` + `<ol>` per the WAI-ARIA
  Authoring Practices pattern. The last item is rendered as plain text
  with `aria-current="page"` (the viewer is already there — don't make
  it a link).

  @task T990
  @wave 0
-->
<script lang="ts" module>
  /**
   * A single breadcrumb node.
   */
  export interface BreadcrumbItem {
    /** Visible label. */
    label: string;
    /** Target href. Omit on the final item. */
    href?: string;
  }
</script>

<script lang="ts">
  /**
   * Props for {@link Breadcrumb}.
   */
  interface Props {
    /** Ordered list of crumbs from root → current page. */
    items: BreadcrumbItem[];
    /** Extra class names. */
    class?: string;
  }

  let { items, class: extraClass = '' }: Props = $props();
</script>

<nav class="crumbs {extraClass}" aria-label="Breadcrumb">
  <ol>
    {#each items as item, idx (idx)}
      {@const isLast = idx === items.length - 1}
      <li>
        {#if isLast || !item.href}
          <span class="crumb current" aria-current={isLast ? 'page' : undefined}>
            {item.label}
          </span>
        {:else}
          <a class="crumb link" href={item.href}>{item.label}</a>
        {/if}
        {#if !isLast}
          <span class="sep" aria-hidden="true">›</span>
        {/if}
      </li>
    {/each}
  </ol>
</nav>

<style>
  .crumbs {
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    color: var(--text-dim);
  }

  ol {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    list-style: none;
    margin: 0;
    padding: 0;
    flex-wrap: wrap;
  }

  li {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
  }

  .crumb {
    padding: 2px var(--space-1);
    border-radius: var(--radius-xs);
    transition: color var(--ease), background var(--ease);
  }

  .crumb.link {
    color: var(--text-dim);
    text-decoration: none;
  }

  .crumb.link:hover {
    color: var(--accent);
    background: var(--accent-halo);
  }

  .crumb.link:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .crumb.current {
    color: var(--text);
    font-weight: 600;
  }

  .sep {
    color: var(--text-faint);
    user-select: none;
    font-size: var(--text-sm);
    line-height: 1;
  }
</style>
