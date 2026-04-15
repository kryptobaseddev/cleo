<script lang="ts">
  /**
   * ProjectSelector — header dropdown for switching the active CLEO project.
   *
   * Displays the current project name with a colored chip and chevron.
   * Opens a searchable, filterable dropdown panel.  Switching POSTs to
   * /api/project/switch and reloads the page on success.
   *
   * @task T646
   */

  import { onMount } from 'svelte';

  /** Shape returned by listRegisteredProjects(). */
  export interface ProjectSummary {
    projectId: string;
    name: string;
    projectPath: string;
    taskCount: number;
    nodeCount: number;
    healthStatus: string;
  }

  interface Props {
    projects: ProjectSummary[];
    activeProjectId: string | null;
  }

  let { projects, activeProjectId }: Props = $props();

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let isOpen = $state(false);
  let searchQuery = $state('');
  let showTestProjects = $state(false);
  let highlightedIndex = $state(0);
  let isSwitching = $state(false);

  /** Root wrapper — used for click-outside detection. */
  let wrapperEl: HTMLDivElement | undefined = $state(undefined);
  /** Search input — autofocused when dropdown opens. */
  let searchInputEl: HTMLInputElement | undefined = $state(undefined);

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const TEST_PATH_RE = /\/(tmp|test|fixture|scratch|sandbox)\b/i;

  const activeProject = $derived(
    projects.find((p) => p.projectId === activeProjectId) ?? null,
  );

  /** Chip colour based on project name initial. */
  const CHIP_COLORS = [
    '#3b82f6',
    '#10b981',
    '#f59e0b',
    '#8b5cf6',
    '#ec4899',
    '#06b6d4',
    '#84cc16',
    '#f97316',
  ];

  function chipColor(name: string): string {
    const code = name.charCodeAt(0) || 0;
    return CHIP_COLORS[code % CHIP_COLORS.length];
  }

  function chipLetter(name: string): string {
    return (name[0] ?? '?').toUpperCase();
  }

  /** Projects after search + test-project filter. */
  const filteredProjects = $derived.by(() => {
    let list = projects;

    if (!showTestProjects) {
      list = list.filter((p) => !TEST_PATH_RE.test(p.projectPath));
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.projectPath.toLowerCase().includes(q),
      );
    }

    return list;
  });

  const highlightedProject = $derived(
    filteredProjects[highlightedIndex] ?? null,
  );

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function formatCount(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  function open() {
    isOpen = true;
    highlightedIndex = 0;
    // Autofocus search after the DOM tick
    setTimeout(() => searchInputEl?.focus(), 0);
  }

  function close() {
    isOpen = false;
    searchQuery = '';
  }

  function toggle() {
    if (isOpen) {
      close();
    } else {
      open();
    }
  }

  async function switchProject(projectId: string) {
    if (projectId === activeProjectId || isSwitching) return;
    isSwitching = true;
    try {
      const res = await fetch('/api/project/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });
      if (res.ok) {
        close();
        window.location.reload();
      }
    } finally {
      isSwitching = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Keyboard navigation
  // ---------------------------------------------------------------------------

  function handleSearchKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      close();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlightedIndex = Math.min(highlightedIndex + 1, filteredProjects.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlightedIndex = Math.max(highlightedIndex - 1, 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightedProject) {
        switchProject(highlightedProject.projectId);
      }
    }
  }

  // Reset highlight when filtered list changes
  $effect(() => {
    // Touch filteredProjects to subscribe
    const _ = filteredProjects;
    highlightedIndex = 0;
  });

  // ---------------------------------------------------------------------------
  // Click outside
  // ---------------------------------------------------------------------------

  onMount(() => {
    function handleMouseDown(e: MouseEvent) {
      if (wrapperEl && !wrapperEl.contains(e.target as Node)) {
        close();
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  });
</script>

<div class="project-selector" bind:this={wrapperEl}>
  <!-- Trigger button -->
  <button
    type="button"
    class="trigger"
    class:open={isOpen}
    onclick={toggle}
    aria-haspopup="listbox"
    aria-expanded={isOpen}
    title={activeProject ? activeProject.projectPath : 'Select project'}
  >
    {#if activeProject}
      <span
        class="chip"
        style="background: {chipColor(activeProject.name)}"
        aria-hidden="true"
      >{chipLetter(activeProject.name)}</span>
      <span class="trigger-name">{activeProject.name}</span>
    {:else}
      <span class="chip placeholder" aria-hidden="true">?</span>
      <span class="trigger-name muted">Select project</span>
    {/if}
    <svg
      class="chevron"
      class:rotated={isOpen}
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2 3.5L5 6.5L8 3.5"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </button>

  <!-- Dropdown panel -->
  {#if isOpen}
    <div class="dropdown" role="listbox" aria-label="Projects">
      <!-- Search + toggle header -->
      <div class="dropdown-header">
        <div class="search-wrap">
          <svg
            class="search-icon"
            width="13"
            height="13"
            viewBox="0 0 13 13"
            fill="none"
            aria-hidden="true"
          >
            <circle cx="5.5" cy="5.5" r="4" stroke="currentColor" stroke-width="1.3" />
            <path
              d="M8.5 8.5L11 11"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
            />
          </svg>
          <input
            bind:this={searchInputEl}
            bind:value={searchQuery}
            type="text"
            class="search-input"
            placeholder="Filter projects..."
            onkeydown={handleSearchKeydown}
            autocomplete="off"
            spellcheck={false}
          />
        </div>
        <label class="toggle-label" title="Show test / scratch projects">
          <input
            type="checkbox"
            bind:checked={showTestProjects}
            class="toggle-checkbox"
          />
          <span class="toggle-text">Show test</span>
        </label>
      </div>

      <!-- Project list -->
      <div class="project-list">
        {#if filteredProjects.length === 0}
          <div class="empty-msg">
            {searchQuery ? `No projects match "${searchQuery}"` : 'No projects'}
          </div>
        {:else}
          {#each filteredProjects as project, idx (project.projectId)}
            {@const isActive = project.projectId === activeProjectId}
            {@const isUnhealthy = project.healthStatus === 'unhealthy'}
            {@const isHighlighted = idx === highlightedIndex}
            <button
              type="button"
              class="project-row"
              class:active={isActive}
              class:unhealthy={isUnhealthy}
              class:highlighted={isHighlighted}
              onclick={() => switchProject(project.projectId)}
              onmouseenter={() => { highlightedIndex = idx; }}
              role="option"
              aria-selected={isActive}
              disabled={isSwitching}
            >
              <span
                class="row-chip"
                style="background: {chipColor(project.name)}"
                aria-hidden="true"
              >{chipLetter(project.name)}</span>

              <div class="row-info">
                <div class="row-name-row">
                  <span class="row-name">{project.name}</span>
                  {#if isActive}
                    <span class="active-dot" aria-label="active" title="active"></span>
                  {/if}
                  {#if isUnhealthy}
                    <span class="unhealthy-dot" aria-label="unhealthy" title="unhealthy"></span>
                  {/if}
                </div>
                <span class="row-path">{project.projectPath}</span>
              </div>

              <div class="row-stats" aria-hidden="true">
                <span class="stat-pill">{formatCount(project.taskCount)}t</span>
                <span class="stat-pill">{formatCount(project.nodeCount)}s</span>
              </div>
            </button>
          {/each}
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .project-selector {
    position: relative;
  }

  /* ---- Trigger ---- */
  .trigger {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.25rem 0.625rem;
    border-radius: 6px;
    border: 1px solid #2d3748;
    background: #1a1f2e;
    color: #e2e8f0;
    cursor: pointer;
    font-size: 0.8125rem;
    font-weight: 500;
    line-height: 1;
    transition:
      border-color 0.15s,
      background 0.15s;
    max-width: 220px;
  }

  .trigger:hover,
  .trigger.open {
    border-color: #4a5568;
    background: #232a3a;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 3px;
    font-size: 0.625rem;
    font-weight: 700;
    color: #fff;
    flex-shrink: 0;
  }

  .chip.placeholder {
    background: #4a5568 !important;
  }

  .trigger-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #e2e8f0;
  }

  .trigger-name.muted {
    color: #718096;
  }

  .chevron {
    color: #718096;
    flex-shrink: 0;
    transition: transform 0.2s;
  }

  .chevron.rotated {
    transform: rotate(180deg);
  }

  /* ---- Dropdown ---- */
  .dropdown {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 200;
    width: 320px;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    box-shadow:
      0 8px 24px rgba(0, 0, 0, 0.4),
      0 2px 6px rgba(0, 0, 0, 0.2);
    overflow: hidden;
  }

  /* ---- Header ---- */
  .dropdown-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.625rem;
    border-bottom: 1px solid #2d3748;
  }

  .search-wrap {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    background: #0f1117;
    border: 1px solid #2d3748;
    border-radius: 5px;
    padding: 0.3125rem 0.5rem;
  }

  .search-icon {
    color: #718096;
    flex-shrink: 0;
  }

  .search-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: #e2e8f0;
    font-size: 0.75rem;
    font-family: inherit;
  }

  .search-input::placeholder {
    color: #4a5568;
  }

  .toggle-label {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .toggle-checkbox {
    accent-color: #3b82f6;
    width: 13px;
    height: 13px;
    cursor: pointer;
  }

  .toggle-text {
    font-size: 0.6875rem;
    color: #718096;
  }

  /* ---- Project list ---- */
  .project-list {
    max-height: 280px;
    overflow-y: auto;
    padding: 0.25rem 0;
  }

  .empty-msg {
    padding: 0.75rem 1rem;
    font-size: 0.75rem;
    color: #718096;
    text-align: center;
  }

  .project-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.4375rem 0.625rem;
    background: transparent;
    border: none;
    cursor: pointer;
    text-align: left;
    color: #e2e8f0;
    transition: background 0.12s;
  }

  .project-row:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .project-row.highlighted {
    background: #232a3a;
  }

  .project-row.active {
    border-left: 2px solid #3b82f6;
    padding-left: calc(0.625rem - 2px);
  }

  .project-row.unhealthy {
    opacity: 0.55;
  }

  .row-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.375rem;
    height: 1.375rem;
    border-radius: 3px;
    font-size: 0.625rem;
    font-weight: 700;
    color: #fff;
    flex-shrink: 0;
  }

  .row-info {
    flex: 1;
    min-width: 0;
  }

  .row-name-row {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .row-name {
    font-size: 0.8125rem;
    font-weight: 500;
    color: #e2e8f0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 160px;
  }

  .row-path {
    font-size: 0.6875rem;
    color: #4a5568;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 200px;
  }

  .active-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #3b82f6;
    flex-shrink: 0;
  }

  .unhealthy-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #ef4444;
    flex-shrink: 0;
  }

  .row-stats {
    display: flex;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .stat-pill {
    font-size: 0.625rem;
    color: #4a5568;
    background: #0f1117;
    border: 1px solid #2d3748;
    border-radius: 3px;
    padding: 1px 4px;
    font-family: monospace;
  }

  /* ---- Scrollbar ---- */
  .project-list::-webkit-scrollbar {
    width: 4px;
  }

  .project-list::-webkit-scrollbar-track {
    background: transparent;
  }

  .project-list::-webkit-scrollbar-thumb {
    background: #2d3748;
    border-radius: 2px;
  }
</style>
