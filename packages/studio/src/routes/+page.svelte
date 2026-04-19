<!--
  Mission Control — root landing page.

  Three-column grid for large viewports (activity pulse · substrate
  portals · ops status), collapsing to one column below 960px. A
  bottom recent-activity strip spans the cross-feed across all 5
  substrates.

  All data arrives pre-resolved from `+page.server.ts`; the health
  card is the only client-side fetch (refreshes every 15s to show
  uptime drift).

  @task T990
  @wave 1E
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import HeroHeader from '$lib/components/shell/HeroHeader.svelte';
  import Sparkline from '$lib/components/shell/Sparkline.svelte';
  import StatBlock from '$lib/components/shell/StatBlock.svelte';
  import { Badge, Button, Card } from '$lib/ui';
  import type { PageData } from './$types';
  import type { ActivityBucket, RecentActivityRow } from './+page.server.js';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  const portals = $derived([
    {
      href: '/brain',
      title: 'Brain',
      subtitle: 'Living canvas',
      description: '5-substrate graph — observations, decisions, quality.',
      stats: data.brainStats,
      tone: 'info' as const,
    },
    {
      href: '/code',
      title: 'Code',
      subtitle: 'Symbol intelligence',
      description: 'Function calls, module graph, community clusters.',
      stats: data.nexusStats,
      tone: 'accent' as const,
    },
    {
      href: '/brain/overview',
      title: 'Memory',
      subtitle: 'BRAIN overview',
      description: 'Decisions timeline · tier stats · quality distribution.',
      stats: data.brainStats,
      tone: 'warning' as const,
    },
    {
      href: '/tasks',
      title: 'Tasks',
      subtitle: 'RCASD-IVTR pipeline',
      description: 'Explorer · hierarchy · kanban · sessions — read-only.',
      stats: data.tasksStats,
      tone: 'success' as const,
    },
  ]);

  interface HealthDb {
    available: boolean;
    rowCount: number | null;
    schemaVersion: string | null;
    path: string;
  }

  interface HealthResponse {
    ok: boolean;
    service: string;
    version: string;
    checkedAt: string;
    uptime: number;
    databases: {
      nexus: HealthDb;
      brain: HealthDb;
      tasks: HealthDb;
      conduit: HealthDb;
      signaldock: HealthDb;
    };
  }

  let health = $state<HealthResponse | null>(null);
  let healthError = $state<string | null>(null);

  async function loadHealth(): Promise<void> {
    try {
      const res = await fetch('/api/health');
      if (!res.ok) throw new Error(`status ${res.status}`);
      health = (await res.json()) as HealthResponse;
      healthError = null;
    } catch (err) {
      healthError = err instanceof Error ? err.message : 'unreachable';
    }
  }

  let healthTimer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    void loadHealth();
    healthTimer = setInterval(loadHealth, 15_000);
  });

  onDestroy(() => {
    if (healthTimer) clearInterval(healthTimer);
  });

  const activityPoints = $derived<number[]>(
    data.activity24h.map((b: ActivityBucket) => b.total),
  );

  const totalObservations24h = $derived(
    data.activity24h.reduce((a, b: ActivityBucket) => a + b.observations, 0),
  );
  const totalCompletions24h = $derived(
    data.activity24h.reduce((a, b: ActivityBucket) => a + b.completions, 0),
  );
  const totalActivity24h = $derived(totalObservations24h + totalCompletions24h);

  function formatUptime(seconds: number | undefined): string {
    if (typeof seconds !== 'number') return '—';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
    const days = Math.floor(seconds / 86_400);
    const hrs = Math.floor((seconds % 86_400) / 3600);
    return `${days}d ${hrs}h`;
  }

  function activityKindLabel(kind: RecentActivityRow['kind']): string {
    if (kind === 'observation') return 'OBS';
    if (kind === 'decision') return 'DEC';
    if (kind === 'task-done') return 'DONE';
    if (kind === 'task-created') return 'NEW';
    return 'EVT';
  }

  function activityKindTone(
    kind: RecentActivityRow['kind'],
  ): 'info' | 'accent' | 'success' | 'warning' {
    if (kind === 'observation') return 'info';
    if (kind === 'decision') return 'accent';
    if (kind === 'task-done') return 'success';
    if (kind === 'task-created') return 'warning';
    return 'info';
  }

  function activityHref(row: RecentActivityRow): string | null {
    if (row.kind === 'task-done' || row.kind === 'task-created') {
      return `/tasks/${row.id}`;
    }
    if (row.kind === 'decision') return '/brain/decisions';
    if (row.kind === 'observation') return '/brain/observations';
    return null;
  }

  function formatTime(iso: string): string {
    try {
      const d = new Date(iso);
      const now = Date.now();
      const delta = now - d.getTime();
      if (delta < 60_000) return 'just now';
      if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
      if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
      return iso;
    }
  }

  function healthTone(ok: boolean): 'success' | 'danger' {
    return ok ? 'success' : 'danger';
  }
</script>

<svelte:head>
  <title>CLEO Studio</title>
</svelte:head>

<div class="mission-control">
  <HeroHeader
    eyebrow="MISSION CONTROL"
    title="CLEO Studio"
    subtitle="Unified observability portal for the CLEO agent platform — read-only views over live project data."
    meta={data.projectPath}
    liveIndicator={data.activeSessions > 0}
  >
    {#snippet actions()}
      <Badge tone={data.activeSessions > 0 ? 'success' : 'neutral'} size="md">
        {data.activeSessions} active session{data.activeSessions === 1 ? '' : 's'}
      </Badge>
      <Button variant="ghost" size="sm" href="/projects">Admin →</Button>
    {/snippet}
  </HeroHeader>

  <div class="grid">
    <!-- Activity pulse (col 1) ------------------------------------- -->
    <section class="col col-activity" aria-label="Activity pulse">
      <Card padding="cozy" elevation={1}>
        {#snippet header()}
          <div class="card-label-row">
            <span class="card-label">Activity pulse</span>
            <span class="card-sub">last 24 hours</span>
          </div>
        {/snippet}
        <div class="activity-body">
          <div class="pulse-row">
            <StatBlock
              label="Total"
              value={totalActivity24h}
              hint="events recorded"
              tone="accent"
            />
            <StatBlock
              label="Observations"
              value={totalObservations24h}
              tone="info"
            />
            <StatBlock
              label="Completed"
              value={totalCompletions24h}
              tone="success"
            />
          </div>

          <div class="sparkline-block">
            <Sparkline
              points={activityPoints}
              width={320}
              height={56}
              tone="accent"
              ariaLabel="24-hour activity trend"
            />
            <div class="sparkline-axis">
              <span>24h ago</span>
              <span>now</span>
            </div>
          </div>

          <div class="pulse-footnote">
            <StatBlock
              label="Active sessions"
              value={data.activeSessions}
              tone={data.activeSessions > 0 ? 'success' : 'neutral'}
              hint="right now"
            />
          </div>
        </div>
      </Card>
    </section>

    <!-- Substrate portals (col 2) ---------------------------------- -->
    <section class="col col-portals" aria-label="Substrate portals">
      <Card padding="cozy" elevation={1}>
        {#snippet header()}
          <div class="card-label-row">
            <span class="card-label">Substrates</span>
            <span class="card-sub">click to explore</span>
          </div>
        {/snippet}
        <div class="portal-stack">
          {#each portals as portal}
            <a class="portal" href={portal.href} data-tone={portal.tone}>
              <div class="portal-head">
                <span class="portal-title">{portal.title}</span>
                <span class="portal-subtitle">{portal.subtitle}</span>
              </div>
              <p class="portal-desc">{portal.description}</p>
              {#if portal.stats}
                <div class="portal-stats">
                  {#each portal.stats as stat}
                    <div class="portal-stat">
                      <span class="portal-stat-value">{stat.value}</span>
                      <span class="portal-stat-label">{stat.label}</span>
                    </div>
                  {/each}
                </div>
              {:else}
                <span class="portal-unavailable">database not found</span>
              {/if}
              <span class="portal-arrow" aria-hidden="true">→</span>
            </a>
          {/each}
        </div>
      </Card>
    </section>

    <!-- Ops status (col 3) ----------------------------------------- -->
    <section class="col col-ops" aria-label="Operations status">
      <Card padding="cozy" elevation={1}>
        {#snippet header()}
          <div class="card-label-row">
            <span class="card-label">Ops status</span>
            {#if health}
              <span class="card-sub">v{health.version}</span>
            {/if}
          </div>
        {/snippet}

        <div class="ops-body">
          {#if healthError}
            <div class="alert">health endpoint: {healthError}</div>
          {/if}

          {#if health}
            <div class="ops-stats">
              <StatBlock
                label="Uptime"
                value={formatUptime(health.uptime)}
                tone="success"
              />
              <StatBlock
                label="Checked"
                value={new Date(health.checkedAt).toLocaleTimeString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
                tone="neutral"
              />
            </div>

            <dl class="ops-dbs">
              {#each Object.entries(health.databases) as [name, db]}
                <div class="ops-db">
                  <dt>
                    <Badge tone={healthTone(db.available)} size="sm">
                      {db.available ? 'online' : 'missing'}
                    </Badge>
                    <span class="ops-db-name">{name}</span>
                  </dt>
                  <dd class="ops-db-meta">
                    {#if db.available && db.rowCount !== null}
                      <span class="ops-db-count">{db.rowCount.toLocaleString()} rows</span>
                    {/if}
                    {#if db.schemaVersion}
                      <span class="ops-db-schema">v{db.schemaVersion}</span>
                    {/if}
                  </dd>
                </div>
              {/each}
            </dl>
          {/if}

          <div class="ops-project">
            <div class="ops-project-label">Active project</div>
            <div class="ops-project-name">{data.projectName}</div>
            <code class="ops-project-path">{data.projectPath}</code>
          </div>

          <div class="ops-actions">
            <Button variant="secondary" size="sm" href="/projects">Scan</Button>
            <Button variant="ghost" size="sm" href="/projects">Backup</Button>
            <Button variant="ghost" size="sm" href="/projects">Doctor</Button>
          </div>
        </div>
      </Card>
    </section>
  </div>

  <!-- Recent activity strip ---------------------------------------- -->
  <section class="recent-strip" aria-label="Recent activity">
    <header class="recent-head">
      <h2 class="recent-title">
        <span class="recent-label">Cross-feed</span>
        <span class="recent-sub">Brain · Nexus · Tasks · Conduit · SignalDock</span>
      </h2>
      <span class="recent-count">{data.recentActivity.length} events</span>
    </header>

    {#if data.recentActivity.length === 0}
      <p class="recent-empty">Nothing recorded in the last 24 hours.</p>
    {:else}
      <ol class="recent-list">
        {#each data.recentActivity as row (row.kind + row.id + row.timestamp)}
          {@const href = activityHref(row)}
          {#if href}
            <li class="recent-row">
              <a class="recent-link" href={href}>
                <Badge tone={activityKindTone(row.kind)} size="sm">
                  {activityKindLabel(row.kind)}
                </Badge>
                <span class="recent-id">{row.id}</span>
                <span class="recent-title-text">{row.title}</span>
                <time class="recent-time">{formatTime(row.timestamp)}</time>
              </a>
            </li>
          {:else}
            <li class="recent-row recent-row-inert">
              <Badge tone={activityKindTone(row.kind)} size="sm">
                {activityKindLabel(row.kind)}
              </Badge>
              <span class="recent-id">{row.id}</span>
              <span class="recent-title-text">{row.title}</span>
              <time class="recent-time">{formatTime(row.timestamp)}</time>
            </li>
          {/if}
        {/each}
      </ol>
    {/if}
  </section>
</div>

<style>
  .mission-control {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    max-width: 1400px;
    margin: 0 auto;
  }

  .grid {
    display: grid;
    grid-template-columns: 1.1fr 1fr 1fr;
    gap: var(--space-4);
  }

  @media (max-width: 960px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }

  .col > :global(.card) {
    height: 100%;
  }

  .card-label-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    width: 100%;
  }

  .card-label {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-weight: 600;
  }

  .card-sub {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    letter-spacing: 0.04em;
  }

  /* ------------- activity column ------------- */
  .activity-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .pulse-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-2);
  }

  .sparkline-block {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .sparkline-block :global(svg) {
    width: 100%;
    height: auto;
  }

  .sparkline-axis {
    display: flex;
    justify-content: space-between;
    font-family: var(--font-mono);
    font-size: 0.625rem;
    color: var(--text-faint);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  /* ------------- portal column ------------- */
  .portal-stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .portal {
    --portal-accent: var(--accent);
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-3) var(--space-4);
    background: var(--bg);
    border: 1px solid var(--border);
    border-left: 3px solid var(--portal-accent);
    border-radius: var(--radius-md);
    text-decoration: none;
    color: inherit;
    transition: border-color var(--ease), background var(--ease),
      transform var(--ease);
  }

  .portal[data-tone='info']    { --portal-accent: var(--info); }
  .portal[data-tone='success'] { --portal-accent: var(--success); }
  .portal[data-tone='warning'] { --portal-accent: var(--warning); }
  .portal[data-tone='accent']  { --portal-accent: var(--accent); }

  .portal:hover,
  .portal:focus-visible {
    background: var(--bg-elev-1);
    border-color: var(--border-strong);
    transform: translateX(2px);
  }

  .portal:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .portal-head {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }

  .portal-title {
    font-size: var(--text-md);
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.01em;
  }

  .portal-subtitle {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--portal-accent);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .portal-desc {
    font-size: var(--text-xs);
    color: var(--text-dim);
    line-height: var(--leading-normal);
    margin: 0;
  }

  .portal-stats {
    display: flex;
    gap: var(--space-4);
    margin-top: var(--space-1);
  }

  .portal-stat {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .portal-stat-value {
    font-family: var(--font-mono);
    font-size: var(--text-base);
    font-weight: 700;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .portal-stat-label {
    font-family: var(--font-mono);
    font-size: 0.625rem;
    color: var(--text-faint);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .portal-unavailable {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--danger);
    margin-top: var(--space-1);
  }

  .portal-arrow {
    position: absolute;
    right: var(--space-3);
    top: var(--space-3);
    font-size: var(--text-md);
    color: var(--portal-accent);
    opacity: 0;
    transition: opacity var(--ease), transform var(--ease);
  }

  .portal:hover .portal-arrow,
  .portal:focus-visible .portal-arrow {
    opacity: 1;
    transform: translateX(2px);
  }

  /* ------------- ops column ------------- */
  .ops-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .ops-stats {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-2);
  }

  .alert {
    background: var(--danger-soft);
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    color: var(--danger);
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-xs);
    border-radius: var(--radius-sm);
  }

  .ops-dbs {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin: 0;
  }

  .ops-db {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .ops-db dt {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
  }

  .ops-db-name {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text);
  }

  .ops-db-meta {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-dim);
    margin: 0;
  }

  .ops-db-count {
    font-variant-numeric: tabular-nums;
  }

  .ops-db-schema {
    color: var(--accent);
  }

  .ops-project {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-3);
    background: var(--bg);
    border: 1px solid var(--border);
    border-left: 2px solid var(--accent);
    border-radius: var(--radius-sm);
  }

  .ops-project-label {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .ops-project-name {
    font-size: var(--text-base);
    color: var(--text);
    font-weight: 600;
  }

  .ops-project-path {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-dim);
    word-break: break-all;
  }

  .ops-actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  /* ------------- recent strip ------------- */
  .recent-strip {
    padding: var(--space-4);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .recent-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .recent-title {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    margin: 0;
  }

  .recent-label {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-weight: 600;
  }

  .recent-sub {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
  }

  .recent-count {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }

  .recent-empty {
    font-size: var(--text-sm);
    color: var(--text-dim);
    margin: 0;
    font-style: italic;
  }

  .recent-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .recent-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2);
    background: var(--bg);
    border-radius: var(--radius-sm);
    border-left: 2px solid var(--border);
  }

  .recent-link {
    display: contents;
    color: inherit;
    text-decoration: none;
  }

  .recent-row:hover {
    background: var(--bg-elev-2);
  }

  .recent-id {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--accent);
    font-weight: 600;
  }

  .recent-title-text {
    font-size: var(--text-xs);
    color: var(--text);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .recent-time {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    flex-shrink: 0;
  }
</style>
