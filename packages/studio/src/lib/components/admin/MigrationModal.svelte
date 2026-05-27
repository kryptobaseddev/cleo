<!--
  MigrationModal — read-only schema status display.

  Reports the current `PRAGMA user_version` for each database and
  surfaces a "migration pending" marker when the CLI cannot confirm
  the schema is current. Does NOT trigger any migration — migration
  triggers are CLI-only until a safe `cleo nexus migrate` subcommand
  with dry-run support lands.

  @task T990
  @wave 1E
-->
<script lang="ts">
  import { Badge, Button, Modal } from '$lib/ui';

  interface MigrationReport {
    schemaVersion: string | null;
    migrationPending: boolean | null;
    message: string;
  }

  interface MigrationData {
    databases: {
      nexus: MigrationReport;
      brain: MigrationReport;
      tasks: MigrationReport;
    };
    note: string;
  }

  interface Props {
    open?: boolean;
    onClose?: () => void;
  }

  let { open = $bindable(true), onClose }: Props = $props();

  let data = $state<MigrationData | null>(null);
  let loading = $state(false);
  let errorMsg = $state<string | null>(null);

  function handleClose(): void {
    open = false;
    onClose?.();
  }

  async function load(): Promise<void> {
    loading = true;
    errorMsg = null;
    try {
      const res = await fetch('/api/project/migrate');
      const env = (await res.json()) as {
        success: boolean;
        data?: MigrationData;
        error?: { message: string };
      };
      if (env.success && env.data) {
        data = env.data;
      } else {
        errorMsg = env.error?.message ?? 'Unable to read migration status';
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : 'Unexpected error';
    } finally {
      loading = false;
    }
  }

  function statusTone(
    report: MigrationReport,
  ): 'success' | 'warning' | 'danger' | 'neutral' {
    if (report.migrationPending === true) return 'warning';
    if (report.migrationPending === false) return 'success';
    if (report.schemaVersion === null) return 'neutral';
    return 'neutral';
  }

  function statusLabel(report: MigrationReport): string {
    if (report.migrationPending === true) return 'pending';
    if (report.migrationPending === false) return 'current';
    if (report.schemaVersion === null) return 'unknown';
    return 'unknown';
  }

  $effect(() => {
    if (open && data === null && !loading) {
      void load();
    }
  });
</script>

<Modal bind:open title="Schema Migrations" maxWidth={38} onclose={handleClose}>
  <div class="body">
    <p class="description">
      Read-only status for every database. Schema version is
      <code>PRAGMA user_version</code>. Pending is reported when the CLI cannot confirm
      the schema is current.
    </p>

    {#if errorMsg}
      <div class="alert" role="alert">{errorMsg}</div>
    {/if}

    {#if data}
      <table class="migration-table">
        <thead>
          <tr>
            <th scope="col">DB</th>
            <th scope="col">Schema</th>
            <th scope="col">Status</th>
            <th scope="col">Message</th>
          </tr>
        </thead>
        <tbody>
          {#each Object.entries(data.databases) as [name, report]}
            <tr>
              <td><code>{name}</code></td>
              <td class="cell-mono">{report.schemaVersion ?? '—'}</td>
              <td>
                <Badge tone={statusTone(report)} size="sm">{statusLabel(report)}</Badge>
              </td>
              <td class="cell-msg">{report.message}</td>
            </tr>
          {/each}
        </tbody>
      </table>

      <div class="note">
        <span class="note-label">NOTE</span>
        {data.note}
      </div>
    {/if}
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={handleClose}>Close</Button>
    <Button variant="secondary" onclick={load} loading={loading}>Refresh</Button>
  {/snippet}
</Modal>

<style>
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .description {
    font-size: var(--text-sm);
    color: var(--text-dim);
    line-height: var(--leading-normal);
    margin: 0;
  }

  .description code {
    font-family: var(--font-mono);
    background: var(--bg-elev-1);
    color: var(--text);
    padding: 1px var(--space-2);
    border-radius: var(--radius-xs);
    font-size: var(--text-2xs);
  }

  .alert {
    background: var(--danger-soft);
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    color: var(--danger);
    padding: var(--space-3);
    font-size: var(--text-sm);
    border-radius: var(--radius-md);
  }

  .migration-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .migration-table th,
  .migration-table td {
    padding: var(--space-2) var(--space-3);
    text-align: left;
    border-bottom: 1px solid var(--border);
  }

  .migration-table th {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    background: var(--bg-elev-1);
  }

  .migration-table tbody tr:last-child td {
    border-bottom: none;
  }

  .migration-table code {
    font-family: var(--font-mono);
    color: var(--accent);
    font-size: var(--text-xs);
  }

  .cell-mono {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }

  .cell-msg {
    color: var(--text-dim);
    font-size: var(--text-xs);
  }

  .note {
    display: flex;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--warning-soft);
    border: 1px solid color-mix(in srgb, var(--warning) 35%, transparent);
    border-radius: var(--radius-md);
    font-size: var(--text-xs);
    color: var(--text);
  }

  .note-label {
    font-family: var(--font-mono);
    color: var(--warning);
    font-weight: 700;
    letter-spacing: 0.08em;
    flex-shrink: 0;
  }
</style>
