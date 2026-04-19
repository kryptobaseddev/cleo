<!--
  Project Registry — Wave 1E admin surface.

  Layout:
    - HeroHeader with active project chip + global action toolbar
    - Project cards grid (two-column ≥1200px) with per-project
      stats grid, health badge and Switch / Reindex / Doctor / Backup /
      Delete actions
    - Right rail (≥1200px) with AuditLogPanel

  All global modals mount at document root; per-project delete reuses
  the same primitive.

  @task T990
  @wave 1E
-->
<script lang="ts">
  import { enhance } from '$app/forms';
  import AuditLogPanel from '$lib/components/admin/AuditLogPanel.svelte';
  import BackupModal from '$lib/components/admin/BackupModal.svelte';
  import CleanModal from '$lib/components/admin/CleanModal.svelte';
  import DeleteConfirmModal from '$lib/components/admin/DeleteConfirmModal.svelte';
  import DoctorModal from '$lib/components/admin/DoctorModal.svelte';
  import GcModal from '$lib/components/admin/GcModal.svelte';
  import MigrationModal from '$lib/components/admin/MigrationModal.svelte';
  import ScanModal from '$lib/components/admin/ScanModal.svelte';
  import HeroHeader from '$lib/components/shell/HeroHeader.svelte';
  import { Badge, Button, Card } from '$lib/ui';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  // ---- Toolbar modal open-state ----
  let showScan = $state(false);
  let showClean = $state(false);
  let showBackup = $state(false);
  let showDoctor = $state(false);
  let showMigration = $state(false);
  let showGc = $state(false);

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

  const initialProjects: ProjectRow[] = data.projects;
  let projects = $state<ProjectRow[]>([...initialProjects]);

  const rowStates = $state<Record<string, RowState>>({});
  const rowErrors = $state<Record<string, string>>({});

  // ---- Bulk reindex state ----
  let bulkRunning = $state(false);
  let bulkSummary = $state<{
    succeeded: number;
    failed: number;
    skipped: number;
    total: number;
  } | null>(null);
  let bulkError = $state<string | null>(null);

  function formatCount(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  /**
   * Relative-time formatter with ISO tooltip. Audit item #1 — "Last
   * Indexed" now shows full precision rather than date-only.
   */
  function formatRelative(iso: string | null): string {
    if (!iso) return 'never';
    try {
      const t = new Date(iso).getTime();
      const delta = Date.now() - t;
      if (delta < 60_000) return 'just now';
      if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
      if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
      const days = Math.floor(delta / 86_400_000);
      if (days < 30) return `${days}d ago`;
      if (days < 365) return `${Math.floor(days / 30)}mo ago`;
      return `${Math.floor(days / 365)}y ago`;
    } catch {
      return iso;
    }
  }

  function formatIso(iso: string | null): string {
    if (!iso) return '';
    try {
      return new Date(iso).toISOString();
    } catch {
      return iso;
    }
  }

  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  function isStale(lastIndexed: string | null): boolean {
    if (!lastIndexed) return false;
    return Date.now() - new Date(lastIndexed).getTime() > SEVEN_DAYS_MS;
  }

  function healthTone(
    status: string,
    stale: boolean,
  ): 'success' | 'warning' | 'danger' | 'neutral' {
    if (status === 'unhealthy') return 'danger';
    if (stale) return 'warning';
    if (status === 'healthy') return 'success';
    return 'neutral';
  }

  function healthLabel(status: string, stale: boolean, neverIndexed: boolean): string {
    if (status === 'unhealthy') return 'unhealthy';
    if (neverIndexed) return 'unindexed';
    if (stale) return 'stale';
    if (status === 'healthy') return 'healthy';
    return status;
  }

  async function handleIndex(projectId: string, action: 'index' | 'reindex'): Promise<void> {
    rowStates[projectId] = 'loading';
    rowErrors[projectId] = '';

    try {
      const res = await fetch(`/api/project/${encodeURIComponent(projectId)}/${action}`, {
        method: 'POST',
      });
      const envelope = (await res.json()) as { success: boolean; error?: { message: string } };

      if (envelope.success) {
        rowStates[projectId] = 'success';
        const idx = projects.findIndex((p) => p.projectId === projectId);
        if (idx >= 0) {
          projects[idx] = { ...projects[idx]!, lastIndexed: new Date().toISOString() };
        }
      } else {
        rowStates[projectId] = 'error';
        rowErrors[projectId] = envelope.error?.message ?? 'Index failed';
      }
    } catch (err) {
      rowStates[projectId] = 'error';
      rowErrors[projectId] = err instanceof Error ? err.message : 'Unexpected error';
    }

    if (rowStates[projectId] === 'success') {
      setTimeout(() => {
        rowStates[projectId] = 'idle';
      }, 3000);
    }
  }

  async function confirmDelete(): Promise<void> {
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

  async function runBulkReindex(): Promise<void> {
    if (!confirm('Re-index every registered project serially? This can take a while.')) {
      return;
    }
    bulkRunning = true;
    bulkError = null;
    bulkSummary = null;
    try {
      const res = await fetch('/api/project/reindex-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const env = (await res.json()) as {
        success: boolean;
        data?: {
          total: number;
          succeeded: number;
          failed: number;
          skipped: number;
        };
        error?: { message: string };
      };
      if (env.success && env.data) {
        bulkSummary = {
          total: env.data.total,
          succeeded: env.data.succeeded,
          failed: env.data.failed,
          skipped: env.data.skipped,
        };
      } else {
        bulkError = env.error?.message ?? 'Bulk reindex failed';
      }
    } catch (err) {
      bulkError = err instanceof Error ? err.message : 'Unexpected error';
    } finally {
      bulkRunning = false;
    }
  }
</script>

<svelte:head>
  <title>Admin — CLEO Studio</title>
</svelte:head>

<!-- Global modals ----------------------------------------------- -->
{#if showScan}
  <ScanModal bind:open={showScan} onClose={() => (showScan = false)} />
{/if}

{#if showClean}
  <CleanModal bind:open={showClean} onClose={() => (showClean = false)} />
{/if}

{#if showBackup}
  <BackupModal bind:open={showBackup} onClose={() => (showBackup = false)} />
{/if}

{#if showDoctor}
  <DoctorModal bind:open={showDoctor} onClose={() => (showDoctor = false)} />
{/if}

{#if showMigration}
  <MigrationModal bind:open={showMigration} onClose={() => (showMigration = false)} />
{/if}

{#if showGc}
  <GcModal bind:open={showGc} onClose={() => (showGc = false)} />
{/if}

{#if deleteTarget}
  <DeleteConfirmModal
    projectName={deleteTarget.name}
    onConfirm={confirmDelete}
    onClose={() => (deleteTarget = null)}
  />
{/if}

<div class="admin-view">
  <HeroHeader
    eyebrow="PROJECT REGISTRY"
    title="Admin"
    subtitle="Scan · index · doctor · backup. Every mutation is audited."
    meta={data.activeProjectName}
  >
    {#snippet actions()}
      <Button variant="secondary" size="sm" onclick={() => (showScan = true)}>Scan</Button>
      <Button variant="secondary" size="sm" onclick={() => (showBackup = true)}>Backup</Button>
      <Button variant="secondary" size="sm" onclick={() => (showDoctor = true)}>Doctor</Button>
      <Button variant="secondary" size="sm" onclick={() => (showMigration = true)}>
        Schema
      </Button>
      <Button variant="secondary" size="sm" onclick={() => (showGc = true)}>GC</Button>
      <Button variant="ghost" size="sm" onclick={runBulkReindex} loading={bulkRunning}>
        Reindex all
      </Button>
      <Button variant="danger" size="sm" onclick={() => (showClean = true)}>Clean</Button>
    {/snippet}
  </HeroHeader>

  {#if bulkError}
    <div class="bulk-alert" role="alert">Bulk reindex failed: {bulkError}</div>
  {/if}

  {#if bulkSummary}
    <div class="bulk-summary" role="status">
      <Badge tone={bulkSummary.failed === 0 ? 'success' : 'warning'} size="md">
        {bulkSummary.succeeded}/{bulkSummary.total} reindexed
      </Badge>
      {#if bulkSummary.failed > 0}
        <span class="bulk-failed">{bulkSummary.failed} failed</span>
      {/if}
      {#if bulkSummary.skipped > 0}
        <span class="bulk-skipped">{bulkSummary.skipped} skipped</span>
      {/if}
    </div>
  {/if}

  <div class="admin-layout">
    <section class="admin-main">
      {#if projects.length === 0}
        <div class="empty-state">
          <p class="empty-title">No projects registered</p>
          <p class="empty-detail">
            Run <code>cleo nexus projects register</code> or use the <strong>Scan</strong> button
            above.
          </p>
        </div>
      {:else}
        <div class="project-grid">
          {#each projects as project (project.projectId)}
            {@const isActive = data.activeProjectId === project.projectId}
            {@const rowState = rowStates[project.projectId] ?? 'idle'}
            {@const rowError = rowErrors[project.projectId] ?? ''}
            {@const neverIndexed = project.lastIndexed === null}
            {@const stale = isStale(project.lastIndexed)}

            <Card padding="cozy" class={isActive ? 'project-card is-active' : 'project-card'}>
              {#snippet header()}
                <div class="card-head">
                  <div class="card-identity">
                    <span class="card-name">{project.name}</span>
                    {#if isActive}
                      <Badge tone="success" size="sm">ACTIVE</Badge>
                    {/if}
                    <Badge
                      tone={healthTone(project.healthStatus, stale)}
                      size="sm"
                    >
                      {healthLabel(project.healthStatus, stale, neverIndexed)}
                    </Badge>
                  </div>
                  <code class="card-path">{project.projectPath}</code>
                </div>
              {/snippet}

              <div class="card-stats">
                <div class="card-stat">
                  <span class="card-stat-value">{formatCount(project.taskCount)}</span>
                  <span class="card-stat-label">Tasks</span>
                </div>
                <div class="card-stat">
                  <span class="card-stat-value">{formatCount(project.nodeCount)}</span>
                  <span class="card-stat-label">Symbols</span>
                </div>
                <div class="card-stat">
                  <span class="card-stat-value">{formatCount(project.relationCount)}</span>
                  <span class="card-stat-label">Relations</span>
                </div>
                <div class="card-stat">
                  <span class="card-stat-value" title={formatIso(project.lastIndexed)}>
                    {formatRelative(project.lastIndexed)}
                  </span>
                  <span class="card-stat-label">Last indexed</span>
                </div>
              </div>

              {#snippet footer()}
                <div class="card-actions">
                  {#if !isActive}
                    <form method="POST" action="?/switchProject" use:enhance>
                      <input type="hidden" name="projectId" value={project.projectId} />
                      <Button type="submit" variant="primary" size="sm">Switch</Button>
                    </form>
                  {:else}
                    <form method="POST" action="?/clearProject" use:enhance>
                      <Button type="submit" variant="ghost" size="sm">Clear</Button>
                    </form>
                  {/if}

                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={rowState === 'loading'}
                    loading={rowState === 'loading'}
                    onclick={() =>
                      handleIndex(project.projectId, neverIndexed ? 'index' : 'reindex')}
                  >
                    {neverIndexed ? 'Index' : 'Re-index'}
                  </Button>

                  <Button
                    variant="ghost"
                    size="sm"
                    onclick={() => {
                      showDoctor = true;
                    }}
                  >
                    Doctor
                  </Button>

                  <div class="card-actions-right">
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={rowState === 'loading'}
                      onclick={() =>
                        (deleteTarget = { projectId: project.projectId, name: project.name })}
                    >
                      Delete
                    </Button>

                    {#if rowState === 'success'}
                      <Badge tone="success" size="sm">done</Badge>
                    {/if}
                    {#if rowState === 'error' && rowError}
                      <Badge tone="danger" size="sm">
                        <span title={rowError}>error</span>
                      </Badge>
                    {/if}
                  </div>
                </div>
              {/snippet}
            </Card>
          {/each}
        </div>
      {/if}
    </section>

    <aside class="admin-rail" aria-label="Audit trail">
      <AuditLogPanel initial={data.auditEntries} />
    </aside>
  </div>
</div>

<style>
  .admin-view {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    max-width: 1400px;
    margin: 0 auto;
  }

  .admin-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-5);
  }

  @media (min-width: 1200px) {
    .admin-layout {
      grid-template-columns: minmax(0, 1fr) 360px;
    }
  }

  .admin-main {
    min-width: 0;
  }

  .admin-rail {
    min-width: 0;
  }

  .project-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--space-3);
  }

  @media (min-width: 720px) and (max-width: 1199px) {
    .project-grid {
      grid-template-columns: 1fr 1fr;
    }
  }

  .admin-main :global(.project-card.is-active) {
    border-color: color-mix(in srgb, var(--success) 35%, var(--border));
    background: color-mix(in srgb, var(--success-soft) 30%, var(--bg-elev-1));
  }

  .card-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    width: 100%;
  }

  .card-identity {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .card-name {
    font-size: var(--text-md);
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.01em;
  }

  .card-path {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    word-break: break-all;
  }

  .card-stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--space-3);
    padding: var(--space-2) 0;
  }

  @media (max-width: 480px) {
    .card-stats {
      grid-template-columns: 1fr 1fr;
    }
  }

  .card-stat {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .card-stat-value {
    font-family: var(--font-mono);
    font-size: var(--text-lg);
    font-weight: 700;
    color: var(--text);
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card-stat-label {
    font-family: var(--font-mono);
    font-size: 0.625rem;
    color: var(--text-faint);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .card-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    width: 100%;
  }

  .card-actions-right {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-left: auto;
  }

  .empty-state {
    padding: var(--space-10);
    text-align: center;
    background: var(--bg-elev-1);
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
  }

  .empty-title {
    font-size: var(--text-md);
    color: var(--text);
    margin: 0 0 var(--space-2) 0;
    font-weight: 600;
  }

  .empty-detail {
    font-size: var(--text-sm);
    color: var(--text-dim);
    margin: 0;
    line-height: var(--leading-normal);
  }

  .empty-detail code {
    font-family: var(--font-mono);
    background: var(--bg);
    color: var(--accent);
    padding: 1px var(--space-2);
    border-radius: var(--radius-xs);
    font-size: var(--text-xs);
  }

  .bulk-alert {
    background: var(--danger-soft);
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    color: var(--danger);
    padding: var(--space-3);
    font-size: var(--text-sm);
    border-radius: var(--radius-md);
  }

  .bulk-summary {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    color: var(--text-dim);
  }

  .bulk-failed {
    color: var(--danger);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .bulk-skipped {
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }
</style>
