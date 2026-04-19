<!--
  Sessions — Wave 1E upgrade.

  HeroHeader + filter chip row + SessionTimeline. Filters are client
  only (status + duration threshold) so the page stays read-only.

  @task T990
  @wave 1E
-->
<script lang="ts">
  import SessionTimeline from '$lib/components/sessions/SessionTimeline.svelte';
  import HeroHeader from '$lib/components/shell/HeroHeader.svelte';
  import StatBlock from '$lib/components/shell/StatBlock.svelte';
  import { Badge, Button, Chip, ChipGroup } from '$lib/ui';
  import type { PageData } from './$types';
  import type { SessionEntry } from './+page.server.js';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  const sessions = $derived<SessionEntry[]>(data.sessions ?? []);

  // ---- Filters ----
  type StatusFilter = 'all' | 'active' | 'ended';
  let statusFilter = $state<StatusFilter>('all');
  let hideEmpty = $state(false);

  const filtered = $derived<SessionEntry[]>(
    sessions.filter((s) => {
      if (statusFilter === 'active' && s.status !== 'active') return false;
      if (statusFilter === 'ended' && s.status !== 'ended') return false;
      if (
        hideEmpty &&
        s.completedCount === 0 &&
        s.createdCount === 0 &&
        s.workedTasks.length === 0 &&
        s.currentTask === null
      ) {
        return false;
      }
      return true;
    }),
  );

  let expandedId = $state<string | null>(null);

  const totalCompleted = $derived(sessions.reduce((sum, s) => sum + s.completedCount, 0));
  const totalCreated = $derived(sessions.reduce((sum, s) => sum + s.createdCount, 0));
  const activeSessions = $derived(sessions.filter((s) => s.status === 'active').length);

  const statusOptions: Array<{ value: StatusFilter; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'active', label: 'Active' },
    { value: 'ended', label: 'Ended' },
  ];
</script>

<svelte:head>
  <title>Sessions — CLEO Studio</title>
</svelte:head>

<div class="sessions-view">
  <HeroHeader
    eyebrow="TASK SESSIONS"
    title="Sessions"
    subtitle="Chronological record of every CLEO session — task completions, work history, duration."
    liveIndicator={activeSessions > 0}
  >
    {#snippet actions()}
      <Button variant="ghost" size="sm" href="/tasks">← Tasks</Button>
      <Button variant="ghost" size="sm" href="/tasks/pipeline">Pipeline</Button>
    {/snippet}
  </HeroHeader>

  <div class="summary-row">
    <StatBlock label="Sessions" value={sessions.length} tone="accent" />
    <StatBlock
      label="Active"
      value={activeSessions}
      tone={activeSessions > 0 ? 'success' : 'neutral'}
      hint="right now"
    />
    <StatBlock label="Completed" value={totalCompleted} tone="success" />
    <StatBlock label="Created" value={totalCreated} tone="info" />
  </div>

  <div class="filter-bar">
    <ChipGroup label="Status">
      {#each statusOptions as opt}
        <Chip
          mode="toggle"
          active={statusFilter === opt.value}
          onclick={() => {
            statusFilter = opt.value;
          }}
        >
          {opt.label}
        </Chip>
      {/each}
    </ChipGroup>

    <ChipGroup label="Display">
      <Chip
        mode="toggle"
        active={hideEmpty}
        onclick={() => {
          hideEmpty = !hideEmpty;
        }}
      >
        Hide empty
      </Chip>
    </ChipGroup>

    {#if filtered.length !== sessions.length}
      <Badge tone="info" size="sm">{filtered.length} / {sessions.length}</Badge>
    {/if}
  </div>

  {#if filtered.length === 0}
    <div class="empty-state">
      {sessions.length === 0
        ? 'No sessions recorded in tasks.db.'
        : 'No sessions match the active filters.'}
    </div>
  {:else}
    <SessionTimeline sessions={filtered} bind:expandedId />
  {/if}
</div>

<style>
  .sessions-view {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    max-width: 1100px;
    margin: 0 auto;
  }

  .summary-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--space-2);
  }

  @media (max-width: 680px) {
    .summary-row {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  .filter-bar {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    flex-wrap: wrap;
    padding: var(--space-3);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .empty-state {
    padding: var(--space-8);
    text-align: center;
    background: var(--bg-elev-1);
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    color: var(--text-dim);
    font-size: var(--text-sm);
  }
</style>
