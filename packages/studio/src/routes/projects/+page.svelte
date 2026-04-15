<script lang="ts">
  import { enhance } from '$app/forms';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }
  let { data }: Props = $props();

  function formatCount(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  function formatDate(iso: string | null): string {
    if (!iso) return 'never';
    return iso.slice(0, 10);
  }
</script>

<svelte:head>
  <title>Projects — CLEO Studio</title>
</svelte:head>

<div class="projects-view">
  <div class="view-header">
    <div class="view-icon projects-icon">P</div>
    <div>
      <h1 class="view-title">Projects</h1>
      <p class="view-subtitle">Multi-Project Registry</p>
    </div>
  </div>

  {#if data.projects.length === 0}
    <div class="empty-state">
      <p class="empty-text">No projects registered</p>
      <p class="empty-detail">
        Run <code>cleo nexus projects register</code> or <code>cleo nexus analyze</code> to register
        the current project.
      </p>
    </div>
  {:else}
    <div class="projects-list">
      {#each data.projects as project}
        {@const isActive = data.activeProjectId === project.projectId}
        <div class="project-card" class:active={isActive}>
          <div class="project-header">
            <div class="project-name-row">
              <span class="project-name">{project.name}</span>
              {#if isActive}
                <span class="active-badge">active</span>
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
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .projects-view {
    max-width: 800px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .view-header {
    display: flex;
    align-items: center;
    gap: 1rem;
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
    gap: 0.75rem;
  }

  .btn {
    padding: 0.375rem 1rem;
    border-radius: 5px;
    font-size: 0.8125rem;
    font-weight: 500;
    border: 1px solid transparent;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }

  .btn-primary {
    background: #3b82f6;
    color: white;
    border-color: #3b82f6;
  }

  .btn-primary:hover {
    background: #2563eb;
    border-color: #2563eb;
  }

  .btn-secondary {
    background: transparent;
    color: #94a3b8;
    border-color: #2d3748;
  }

  .btn-secondary:hover {
    background: #2d3748;
    color: #e2e8f0;
  }
</style>
