<script lang="ts">
  import { enhance } from '$app/forms';
  import DeleteConfirmModal from '$lib/components/admin/DeleteConfirmModal.svelte';
  import ScanModal from '$lib/components/admin/ScanModal.svelte';
  import CleanModal from '$lib/components/admin/CleanModal.svelte';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }
  let { data }: Props = $props();

  // ---- Toolbar modals ----
  let showScan = $state(false);
  let showClean = $state(false);

  // ---- Per-row delete modal ----
  let deleteTarget = $state<{ projectId: string; name: string } | null>(null);

  // ---- Per-row action state ----
  type RowState = 'idle' | 'loading' | 'success' | 'error';

  interface ProjectRow {
    projectId: string;
    name: string;
    projectPath: string;
    lastIndexed: string | null;
    taskCount: number;
    nodeCount: number;
    relationCount: number;
    fileCount: number;
    lastSeen: string;
    healthStatus: string;
  }

  let projects = $state<ProjectRow[]>(data.projects as ProjectRow[]);

  const rowStates = $state<Record<string, RowState>>({});
  const rowErrors = $state<Record<string, string>>({});

  // ----- helpers -----

  function formatCount(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  function formatDate(iso: string | null): string {
    if (!iso) return 'never';
    return iso.slice(0, 10);
  }

  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  /** Returns true when lastIndexed is more than 7 days old. */
  function isStale(lastIndexed: string | null): boolean {
    if (!lastIndexed) return false;
    return Date.now() - new Date(lastIndexed).getTime() > SEVEN_DAYS_MS;
  }

  // ----- index / re-index -----

  async function handleIndex(projectId: string, action: 'index' | 'reindex') {
    rowStates[projectId] = 'loading';
    rowErrors[projectId] = '';

    try {
      const res = await fetch(`/api/project/${encodeURIComponent(projectId)}/${action}`, {
        method: 'POST',
      });
      const envelope = (await res.json()) as { success: boolean; error?: { message: string } };

      if (envelope.success) {
        rowStates[projectId] = 'success';
        // Refresh lastIndexed optimistically
        const idx = projects.findIndex((p) => p.projectId === projectId);
        if (idx >= 0) {
          projects[idx] = { ...projects[idx], lastIndexed: new Date().toISOString() };
        }
      } else {
        rowStates[projectId] = 'error';
        rowErrors[projectId] = envelope.error?.message ?? 'Index failed';
      }
    } catch (err) {
      rowStates[projectId] = 'error';
      rowErrors[projectId] = err instanceof Error ? err.message : 'Unexpected error';
    }

    // Clear success badge after 3s
    if (rowStates[projectId] === 'success') {
      setTimeout(() => {
        rowStates[projectId] = 'idle';
      }, 3000);
    }
  }

  // ----- delete -----

  async function confirmDelete() {
    if (!deleteTarget) return;

    const { projectId } = deleteTarget;
    deleteTarget = null;

    rowStates[projectId] = 'loading';
    rowErrors[projectId] = '';

    try {
      const res = await fetch(`/api/project/${encodeURIComponent(projectId)}`, {
        method: 'DELETE',
      });
      const envelope = (await res.json()) as { success: boolean; error?: { message: string } };

      if (envelope.success) {
        // Remove row from local state — no full page reload needed
        projects = projects.filter((p) => p.projectId !== projectId);
      } else {
        rowStates[projectId] = 'error';
        rowErrors[projectId] = envelope.error?.message ?? 'Delete failed';
      }
    } catch (err) {
      rowStates[projectId] = 'error';
      rowErrors[projectId] = err instanceof Error ? err.message : 'Unexpected error';
    }
  }
</script>

<svelte:head>
  <title>Projects — CLEO Studio</title>
</svelte:head>

<!-- Global modals (outside the card list) -->
{#if showScan}
  <ScanModal onClose={() => (showScan = false)} />
{/if}

{#if showClean}
  <CleanModal onClose={() => (showClean = false)} />
{/if}

{#if deleteTarget}
  <DeleteConfirmModal
    projectName={deleteTarget.name}
    onConfirm={confirmDelete}
    onClose={() => (deleteTarget = null)}
  />
{/if}

<div class="projects-view">
  <div class="view-header">
    <div class="view-icon projects-icon">P</div>
    <div class="view-header-text">
      <h1 class="view-title">Projects</h1>
      <p class="view-subtitle">Multi-Project Registry</p>
    </div>

    <div class="toolbar">
      <button type="button" class="btn btn-toolbar" onclick={() => (showScan = true)}>
        Scan
      </button>
      <button type="button" class="btn btn-toolbar btn-toolbar-danger" onclick={() => (showClean = true)}>
        Clean&hellip;
      </button>
    </div>
  </div>

  {#if projects.length === 0}
    <div class="empty-state">
      <p class="empty-text">No projects registered</p>
      <p class="empty-detail">
        Run <code>cleo nexus projects register</code> or <code>cleo nexus analyze</code> to
        register the current project, or use the <strong>Scan</strong> button above.
      </p>
    </div>
  {:else}
    <div class="projects-list">
      {#each projects as project (project.projectId)}
        {@const isActive = data.activeProjectId === project.projectId}
        {@const rowState = rowStates[project.projectId] ?? 'idle'}
        {@const rowError = rowErrors[project.projectId] ?? ''}
        {@const neverIndexed = project.lastIndexed === null}
        {@const stale = isStale(project.lastIndexed)}

        <div class="project-card" class:active={isActive}>
          <div class="project-header">
            <div class="project-name-row">
              <span class="project-name">{project.name}</span>
              {#if isActive}
                <span class="active-badge">active</span>
              {/if}
              {#if stale && !neverIndexed}
                <span class="stale-dot" title="Index is older than 7 days"></span>
              {/if}
            </div>
            <span class="project-path">{project.projectPath}</span>
          </div>

          <div class="project-stats">
            <div class="stat">
              <span class="stat-value">{formatCount(project.taskCount)}</span>
              <span class="stat-label">Tasks</span>
            </div>
            <div class="stat">
              <span class="stat-value">{formatCount(project.nodeCount)}</span>
              <span class="stat-label">Symbols</span>
            </div>
            <div class="stat">
              <span class="stat-value">{formatCount(project.relationCount)}</span>
              <span class="stat-label">Relations</span>
            </div>
            <div class="stat">
              <span class="stat-value">{formatDate(project.lastIndexed)}</span>
              <span class="stat-label">Last Indexed</span>
            </div>
          </div>

          <div class="project-actions">
            <!-- Switch / Clear -->
            {#if !isActive}
              <form method="POST" action="?/switchProject" use:enhance>
                <input type="hidden" name="projectId" value={project.projectId} />
                <button type="submit" class="btn btn-primary">Switch to Project</button>
              </form>
            {:else}
              <form method="POST" action="?/clearProject" use:enhance>
                <button type="submit" class="btn btn-secondary">Clear Selection</button>
              </form>
            {/if}

            <!-- Index (only when never indexed) -->
            {#if neverIndexed}
              <button
                type="button"
                class="btn btn-action"
                disabled={rowState === 'loading'}
                onclick={() => handleIndex(project.projectId, 'index')}
              >
                {rowState === 'loading' ? '' : 'Index'}
                {#if rowState === 'loading'}
                  <span class="spinner" aria-hidden="true"></span>
                {/if}
              </button>
            {:else}
              <!-- Re-Index (when already indexed) -->
              <button
                type="button"
                class="btn btn-action"
                class:stale-btn={stale}
                disabled={rowState === 'loading'}
                onclick={() => handleIndex(project.projectId, 'reindex')}
              >
                {rowState === 'loading' ? '' : 'Re-Index'}
                {#if rowState === 'loading'}
                  <span class="spinner" aria-hidden="true"></span>
                {/if}
              </button>
            {/if}

            <!-- Delete -->
            <button
              type="button"
              class="btn btn-delete"
              disabled={rowState === 'loading'}
              onclick={() => (deleteTarget = { projectId: project.projectId, name: project.name })}
            >
              Delete
            </button>

            <!-- Inline status feedback -->
            {#if rowState === 'success'}
              <span class="status-badge success" role="status">Done</span>
            {/if}
            {#if rowState === 'error' && rowError}
              <span class="status-badge error" title={rowError} role="alert">Error</span>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .projects-view {
    max-width: 900px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .view-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .view-header-text {
    flex: 1;
    min-width: 0;
  }

  .toolbar {
    display: flex;
    gap: 0.5rem;
    margin-left: auto;
  }

  .view-icon {
    width: 3rem;
    height: 3rem;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 1.25rem;
    flex-shrink: 0;
  }

  .projects-icon {
    background: rgba(16, 185, 129, 0.15);
    color: #10b981;
  }

  .view-title {
    font-size: 1.5rem;
    font-weight: 700;
    color: #f1f5f9;
  }

  .view-subtitle {
    font-size: 0.875rem;
    color: #64748b;
  }

  .empty-state {
    padding: 2rem;
    background: #1a1f2e;
    border: 1px dashed #2d3748;
    border-radius: 8px;
    text-align: center;
  }

  .empty-text {
    font-size: 1.125rem;
    font-weight: 600;
    color: #64748b;
    margin-bottom: 0.75rem;
  }

  .empty-detail {
    font-size: 0.875rem;
    color: #475569;
    line-height: 1.6;
  }

  .empty-detail code {
    font-family: monospace;
    background: #2d3748;
    padding: 0.125rem 0.375rem;
    border-radius: 3px;
    color: #94a3b8;
    font-size: 0.8125rem;
  }

  .projects-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .project-card {
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    transition: border-color 0.15s;
  }

  .project-card.active {
    border-color: #10b981;
    background: rgba(16, 185, 129, 0.05);
  }

  .project-card:not(.active):hover {
    border-color: #3d4f6a;
  }

  .project-header {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .project-name-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .project-name {
    font-size: 1rem;
    font-weight: 600;
    color: #f1f5f9;
  }

  .active-badge {
    font-size: 0.6875rem;
    font-weight: 600;
    color: #10b981;
    background: rgba(16, 185, 129, 0.15);
    border: 1px solid rgba(16, 185, 129, 0.3);
    border-radius: 3px;
    padding: 0.125rem 0.5rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .stale-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #f97316;
    flex-shrink: 0;
    display: inline-block;
  }

  .project-path {
    font-size: 0.75rem;
    color: #475569;
    font-family: monospace;
    word-break: break-all;
  }

  .project-stats {
    display: flex;
    gap: 1.5rem;
    flex-wrap: wrap;
  }

  .stat {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 80px;
  }

  .stat-value {
    font-size: 1.125rem;
    font-weight: 600;
    color: #e2e8f0;
    font-variant-numeric: tabular-nums;
  }

  .stat-label {
    font-size: 0.6875rem;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .project-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .btn {
    padding: 0.375rem 1rem;
    border-radius: 5px;
    font-size: 0.8125rem;
    font-weight: 500;
    border: 1px solid transparent;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, opacity 0.15s;
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
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

  .btn-secondary {
    background: transparent;
    color: #94a3b8;
    border-color: #2d3748;
  }

  .btn-secondary:hover:not(:disabled) {
    background: #2d3748;
    color: #e2e8f0;
  }

  .btn-action {
    background: transparent;
    color: #60a5fa;
    border-color: rgba(96, 165, 250, 0.3);
  }

  .btn-action:hover:not(:disabled) {
    background: rgba(96, 165, 250, 0.1);
    border-color: rgba(96, 165, 250, 0.5);
  }

  .btn-action.stale-btn {
    color: #f97316;
    border-color: rgba(249, 115, 22, 0.35);
  }

  .btn-action.stale-btn:hover:not(:disabled) {
    background: rgba(249, 115, 22, 0.1);
    border-color: rgba(249, 115, 22, 0.55);
  }

  .btn-delete {
    background: transparent;
    color: #f87171;
    border-color: rgba(248, 113, 113, 0.3);
    margin-left: auto;
  }

  .btn-delete:hover:not(:disabled) {
    background: rgba(248, 113, 113, 0.1);
    border-color: rgba(248, 113, 113, 0.5);
  }

  .btn-toolbar {
    background: #1a1f2e;
    color: #94a3b8;
    border-color: #2d3748;
    font-size: 0.8125rem;
  }

  .btn-toolbar:hover {
    background: #2d3748;
    color: #e2e8f0;
  }

  .btn-toolbar-danger {
    color: #fca5a5;
    border-color: rgba(248, 113, 113, 0.3);
  }

  .btn-toolbar-danger:hover {
    background: rgba(248, 113, 113, 0.08);
  }

  .spinner {
    display: inline-block;
    width: 0.875rem;
    height: 0.875rem;
    border: 2px solid rgba(255, 255, 255, 0.2);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.65s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .status-badge {
    font-size: 0.6875rem;
    font-weight: 600;
    padding: 0.125rem 0.5rem;
    border-radius: 3px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .status-badge.success {
    background: rgba(16, 185, 129, 0.15);
    color: #10b981;
    border: 1px solid rgba(16, 185, 129, 0.3);
  }

  .status-badge.error {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
    border: 1px solid rgba(239, 68, 68, 0.3);
    cursor: help;
  }
</style>
