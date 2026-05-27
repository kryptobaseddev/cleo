<!--
  BrainSearchBar — node search input for the Brain canvas header.

  Queries `/api/brain/search?q=…` when that endpoint is available, falling
  back to client-side label filtering of the current node list. Selecting a
  result fires `onResultSelect` so the page shell can animate the camera to
  that node and select it.

  @task T990
  @wave 1A
-->
<script lang="ts">
  import type { GraphNode } from '$lib/graph/types.js';

  /**
   * Props for {@link BrainSearchBar}.
   */
  interface Props {
    /** All currently rendered nodes — used for client-side fallback filtering. */
    nodes: GraphNode[];
    /** Fired when the user selects a search result. */
    onResultSelect?: (node: GraphNode) => void;
    /** External ref to focus this input — expose via bind:searchInput. */
    searchInput?: HTMLInputElement | null;
  }

  let { nodes, onResultSelect, searchInput = $bindable(null) }: Props = $props();

  let query = $state('');
  let open = $state(false);
  let loading = $state(false);
  let results = $state<GraphNode[]>([]);
  let activeIndex = $state(-1);

  const substratePalette: Record<string, string> = {
    brain: 'var(--info)',
    nexus: 'var(--success)',
    tasks: 'var(--warning)',
    conduit: 'var(--accent)',
    signaldock: 'var(--danger)',
  };

  /**
   * Run the search. Tries the API endpoint first; falls back to client-side
   * label filtering on network errors or 404.
   */
  async function runSearch(q: string): Promise<void> {
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      results = [];
      open = false;
      return;
    }

    loading = true;
    activeIndex = -1;

    try {
      const res = await fetch(`/api/brain/search?q=${encodeURIComponent(trimmed)}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const json = (await res.json()) as { nodes?: GraphNode[] };
        results = Array.isArray(json.nodes) ? json.nodes.slice(0, 20) : [];
      } else {
        throw new Error('api-unavailable');
      }
    } catch {
      // Fallback: client-side filter.
      const lower = trimmed.toLowerCase();
      results = nodes
        .filter(
          (n) =>
            n.label.toLowerCase().includes(lower) ||
            n.id.toLowerCase().includes(lower) ||
            n.kind.toLowerCase().includes(lower),
        )
        .slice(0, 20);
    } finally {
      loading = false;
      open = results.length > 0;
    }
  }

  function handleInput(): void {
    void runSearch(query);
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, results.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const result = results[activeIndex >= 0 ? activeIndex : 0];
      if (result) selectResult(result);
    } else if (e.key === 'Escape') {
      closeDropdown();
    }
  }

  function selectResult(node: GraphNode): void {
    query = node.label;
    open = false;
    results = [];
    onResultSelect?.(node);
  }

  function closeDropdown(): void {
    open = false;
    activeIndex = -1;
  }

  function handleBlur(e: FocusEvent): void {
    // Delay close so clicks on results register first.
    const related = e.relatedTarget as Element | null;
    if (!related?.closest('[data-brain-search]')) {
      setTimeout(closeDropdown, 100);
    }
  }
</script>

<div class="search-wrap" data-brain-search>
  <div class="search-shell" class:open>
    <!-- Search icon -->
    <span class="search-icon" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" stroke-width="1.5"/>
        <line x1="10.5" y1="10.5" x2="14" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </span>

    <input
      bind:this={searchInput}
      type="search"
      class="search-input"
      placeholder="Search observations, symbols, tasks..."
      autocomplete="off"
      spellcheck={false}
      aria-label="Search brain nodes"
      aria-expanded={open}
      aria-autocomplete="list"
      aria-haspopup="listbox"
      aria-activedescendant={activeIndex >= 0 ? `brain-search-result-${activeIndex}` : undefined}
      role="combobox"
      bind:value={query}
      oninput={handleInput}
      onkeydown={handleKeyDown}
      onblur={handleBlur}
    />

    <!-- Loading spinner -->
    {#if loading}
      <span class="search-spinner" aria-hidden="true"></span>
    {/if}

    <!-- Clear button -->
    {#if query.length > 0}
      <button
        type="button"
        class="search-clear"
        onclick={() => { query = ''; results = []; open = false; }}
        aria-label="Clear search"
        tabindex="-1"
      >
        ×
      </button>
    {/if}
  </div>

  <!-- Results dropdown -->
  {#if open && results.length > 0}
    <ul
      class="search-results"
      role="listbox"
      aria-label="Search results"
      id="brain-search-results"
    >
      {#each results as result, i (result.id)}
        <li
          id="brain-search-result-{i}"
          class="result-item"
          class:active-result={activeIndex === i}
          role="option"
          aria-selected={activeIndex === i}
        >
          <button
            type="button"
            class="result-btn"
            onclick={() => selectResult(result)}
            tabindex="-1"
          >
            <span
              class="result-dot"
              style="--dot-color: {substratePalette[result.substrate] ?? 'var(--border-strong)'};"
              aria-hidden="true"
            ></span>
            <span class="result-label">{result.label}</span>
            <span class="result-meta">{result.substrate} · {result.kind}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .search-wrap {
    position: relative;
    width: 280px;
    flex-shrink: 0;
  }

  /* -----------------------------------------------------------------------
   * Input shell
   * --------------------------------------------------------------------- */
  .search-shell {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-3);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    transition: border-color var(--ease), box-shadow var(--ease), background var(--ease);
  }

  .search-shell:focus-within,
  .search-shell.open {
    border-color: var(--accent);
    box-shadow: var(--shadow-focus);
    background: var(--bg-elev-2);
  }

  .search-icon {
    display: inline-flex;
    align-items: center;
    color: var(--text-faint);
    flex-shrink: 0;
  }

  .search-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text);
    font-size: var(--text-sm);
    font-family: var(--font-sans);
    padding: var(--space-2) 0;
    min-width: 0;
  }

  .search-input::placeholder {
    color: var(--text-faint);
    font-size: var(--text-xs);
  }

  /* Remove native search clear button */
  .search-input::-webkit-search-cancel-button {
    display: none;
  }

  .search-spinner {
    width: 12px;
    height: 12px;
    border: 1.5px solid var(--border-strong);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 600ms linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .search-clear {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    background: transparent;
    border: none;
    border-radius: 50%;
    color: var(--text-faint);
    font-size: var(--text-sm);
    cursor: pointer;
    padding: 0;
    line-height: 1;
    flex-shrink: 0;
    transition: color var(--ease), background var(--ease);
  }

  .search-clear:hover {
    color: var(--text);
    background: var(--bg);
  }

  /* -----------------------------------------------------------------------
   * Results dropdown
   * --------------------------------------------------------------------- */
  .search-results {
    position: absolute;
    top: calc(100% + var(--space-1));
    left: 0;
    right: 0;
    background: var(--bg-elev-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    padding: var(--space-1) 0;
    z-index: 50;
    list-style: none;
    margin: 0;
    max-height: 320px;
    overflow-y: auto;
  }

  .result-item {
    padding: 0;
  }

  .result-item.active-result .result-btn {
    background: color-mix(in srgb, var(--accent) 12%, var(--bg-elev-2));
  }

  .result-btn {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    background: transparent;
    border: none;
    cursor: pointer;
    text-align: left;
    transition: background var(--ease);
  }

  .result-btn:hover {
    background: var(--bg-elev-1);
  }

  .result-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--dot-color, var(--border-strong));
    flex-shrink: 0;
    box-shadow: 0 0 5px var(--dot-color, transparent);
  }

  .result-label {
    font-size: var(--text-xs);
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .result-meta {
    font-family: var(--font-mono);
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* Reduced motion */
  @media (prefers-reduced-motion: reduce) {
    .search-spinner {
      animation: none;
    }
  }
</style>
