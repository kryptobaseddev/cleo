<!--
  BackupModal — lists on-disk snapshots + creates new ones.

  GET  /api/project/backup → backup list (read from
       `.cleo/backups/sqlite/` filesystem, no CLI).
  POST /api/project/backup → creates a new snapshot via `cleo backup add`.

  Restore is intentionally NOT wired in this wave — the typed-word
  confirmation ritual + CLI surface for restore will land alongside a
  future `cleo restore --from <file>` flag. For now, operators are
  directed to run the CLI command shown in the footer.

  @task T990
  @wave 1E
-->
<script lang="ts">
  import { Badge, Button, Input, Modal } from '$lib/ui';

  interface BackupFile {
    filename: string;
    path: string;
    sizeBytes: number;
    createdAt: string;
    kind: 'tasks' | 'brain' | 'config' | 'project-info' | 'other';
  }

  interface Props {
    open?: boolean;
    onClose?: () => void;
  }

  let { open = $bindable(true), onClose }: Props = $props();

  let files = $state<BackupFile[]>([]);
  let loading = $state(false);
  let creating = $state(false);
  let note = $state('');
  let errorMsg = $state<string | null>(null);
  let successMsg = $state<string | null>(null);
  let dir = $state<string>('');

  function handleClose(): void {
    open = false;
    onClose?.();
  }

  async function loadList(): Promise<void> {
    loading = true;
    errorMsg = null;
    try {
      const res = await fetch('/api/project/backup');
      const env = (await res.json()) as {
        success: boolean;
        data?: { backups: BackupFile[]; dir: string };
        error?: { message: string };
      };
      if (env.success && env.data) {
        files = env.data.backups ?? [];
        dir = env.data.dir ?? '';
      } else {
        errorMsg = env.error?.message ?? 'Unable to list backups';
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : 'Unexpected error';
    } finally {
      loading = false;
    }
  }

  async function createSnapshot(): Promise<void> {
    creating = true;
    errorMsg = null;
    successMsg = null;
    try {
      const res = await fetch('/api/project/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: note.trim() || undefined }),
      });
      const env = (await res.json()) as {
        success: boolean;
        error?: { message: string };
      };
      if (env.success) {
        successMsg = 'Snapshot created';
        note = '';
        await loadList();
      } else {
        errorMsg = env.error?.message ?? 'Snapshot failed';
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : 'Unexpected error';
    } finally {
      creating = false;
    }
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function formatTime(iso: string): string {
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  }

  function kindTone(kind: BackupFile['kind']): 'accent' | 'info' | 'warning' | 'neutral' {
    if (kind === 'tasks') return 'accent';
    if (kind === 'brain') return 'info';
    if (kind === 'config' || kind === 'project-info') return 'warning';
    return 'neutral';
  }

  $effect(() => {
    if (open && files.length === 0 && !loading) {
      void loadList();
    }
  });
</script>

<Modal bind:open title="Project Backups" maxWidth={44} onclose={handleClose}>
  <div class="body">
    <section class="create">
      <h3 class="section-title">New snapshot</h3>
      <p class="description">
        Captures <code>tasks.db</code>, <code>brain.db</code>, <code>config.json</code>, and
        <code>project-info.json</code> via <code>cleo backup add</code>. Vacuums into a
        timestamped <code>.cleo/backups/sqlite/</code> file.
      </p>
      <div class="create-row">
        <Input
          label="Note"
          placeholder="e.g. pre-migration checkpoint"
          bind:value={note}
        />
        <Button variant="primary" onclick={createSnapshot} loading={creating}>
          {creating ? 'Creating' : 'Create snapshot'}
        </Button>
      </div>
      {#if successMsg}
        <div class="success" role="status">{successMsg}</div>
      {/if}
      {#if errorMsg}
        <div class="alert" role="alert">{errorMsg}</div>
      {/if}
    </section>

    <section class="list-section">
      <div class="list-head">
        <h3 class="section-title">Existing snapshots</h3>
        {#if dir}
          <code class="list-dir">{dir}</code>
        {/if}
      </div>

      {#if loading}
        <p class="hint">Loading…</p>
      {:else if files.length === 0}
        <p class="hint">No snapshots yet. Create one above.</p>
      {:else}
        <ul class="list">
          {#each files as file}
            <li class="list-item">
              <Badge tone={kindTone(file.kind)} size="sm">{file.kind}</Badge>
              <code class="list-name">{file.filename}</code>
              <span class="list-size">{formatSize(file.sizeBytes)}</span>
              <time class="list-time">{formatTime(file.createdAt)}</time>
            </li>
          {/each}
        </ul>
      {/if}

      <p class="restore-hint">
        Restore via CLI: <code>cleo restore backup --file &lt;filename&gt;</code>.
      </p>
    </section>
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={handleClose}>Close</Button>
    <Button variant="secondary" onclick={loadList} loading={loading}>Refresh</Button>
  {/snippet}
</Modal>

<style>
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  .section-title {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-weight: 600;
    margin: 0 0 var(--space-2) 0;
  }

  .description {
    font-size: var(--text-sm);
    color: var(--text-dim);
    line-height: var(--leading-normal);
    margin: 0 0 var(--space-3) 0;
  }

  .description code,
  .list-dir,
  .list-name,
  .restore-hint code {
    font-family: var(--font-mono);
    background: var(--bg-elev-1);
    color: var(--text);
    padding: 1px var(--space-2);
    border-radius: var(--radius-xs);
    font-size: var(--text-2xs);
  }

  .create-row {
    display: flex;
    gap: var(--space-3);
    align-items: flex-end;
  }

  .create-row :global(.field) {
    flex: 1;
  }

  .success {
    background: var(--success-soft);
    border: 1px solid color-mix(in srgb, var(--success) 40%, transparent);
    color: var(--success);
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
    border-radius: var(--radius-sm);
    margin-top: var(--space-2);
  }

  .alert {
    background: var(--danger-soft);
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    color: var(--danger);
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
    border-radius: var(--radius-sm);
    margin-top: var(--space-2);
  }

  .list-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .list-dir {
    color: var(--text-dim);
    word-break: break-all;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 260px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg);
  }

  .list-item {
    display: grid;
    grid-template-columns: auto 1fr auto auto;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border);
  }

  .list-item:last-child {
    border-bottom: none;
  }

  .list-size {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }

  .list-time {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
  }

  .hint {
    font-size: var(--text-sm);
    color: var(--text-dim);
    font-style: italic;
  }

  .restore-hint {
    font-size: var(--text-xs);
    color: var(--text-dim);
    margin: var(--space-2) 0 0 0;
  }
</style>
