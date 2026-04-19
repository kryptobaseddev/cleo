<!--
  Pipeline — Wave 1E upgrade.

  Full-viewport stage swim-lanes for the RCASD-IVTR+C chain, keyboard
  navigable, with a right-side DetailDrawer that imports Wave 1C's
  DetailDrawer component. No SSR SQL duplication — everything derives
  from `+page.server.ts` which already reads pipeline_stage.

  @task T990
  @wave 1E
-->
<script lang="ts">
  import StageSwimLane from '$lib/components/pipeline/StageSwimLane.svelte';
  import HeroHeader from '$lib/components/shell/HeroHeader.svelte';
  import { DetailDrawer } from '$lib/components/tasks';
  import { Button } from '$lib/ui';
  import type { Task } from '@cleocode/contracts';
  import type { PageData } from './$types';
  import type { PipelineColumn, PipelineTask } from './+page.server.js';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  const columns = $derived<PipelineColumn[]>(data.columns ?? []);

  // ---- Keyboard focus ----
  let focusedCol = $state(0);
  let focusedRow = $state(0);
  let selectedTaskId = $state<string | null>(null);

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      focusedCol = Math.min(focusedCol + 1, columns.length - 1);
      focusedRow = 0;
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focusedCol = Math.max(focusedCol - 1, 0);
      focusedRow = 0;
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const maxRow = (columns[focusedCol]?.tasks.length ?? 1) - 1;
      focusedRow = Math.min(focusedRow + 1, maxRow);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusedRow = Math.max(focusedRow - 1, 0);
    } else if (e.key === 'Enter') {
      const t = columns[focusedCol]?.tasks[focusedRow];
      if (t) selectedTaskId = t.id;
    } else if (e.key === 'Escape') {
      selectedTaskId = null;
    }
  }

  // ---- Drawer task lookup ----
  const allTasks = $derived<PipelineTask[]>(columns.flatMap((c) => c.tasks));

  const KNOWN_STATUSES = new Set<Task['status']>([
    'pending',
    'active',
    'blocked',
    'done',
    'cancelled',
    'archived',
    'proposed',
  ]);
  const KNOWN_PRIORITIES = new Set<Task['priority']>(['low', 'medium', 'high', 'critical']);
  const KNOWN_TYPES = new Set<NonNullable<Task['type']>>(['epic', 'task', 'subtask']);
  const KNOWN_SIZES = new Set<NonNullable<Task['size']>>(['small', 'medium', 'large']);

  function buildDrawerTask(raw: PipelineTask): Task {
    const status = (KNOWN_STATUSES as Set<string>).has(raw.status)
      ? (raw.status as Task['status'])
      : 'pending';
    const priority = (KNOWN_PRIORITIES as Set<string>).has(raw.priority)
      ? (raw.priority as Task['priority'])
      : 'medium';
    const type = (KNOWN_TYPES as Set<string>).has(raw.type)
      ? (raw.type as NonNullable<Task['type']>)
      : undefined;
    const size =
      raw.size && (KNOWN_SIZES as Set<string>).has(raw.size)
        ? (raw.size as NonNullable<Task['size']>)
        : undefined;

    return {
      id: raw.id,
      title: raw.title,
      description: raw.title,
      status,
      priority,
      type,
      size,
      parentId: raw.parent_id,
      createdAt: new Date().toISOString(),
    };
  }

  const drawerTask = $derived<Task | null>(
    (() => {
      if (!selectedTaskId) return null;
      const raw = allTasks.find((t) => t.id === selectedTaskId);
      if (!raw) return null;
      return buildDrawerTask(raw);
    })(),
  );

  const totalTasks = $derived<number>(columns.reduce((sum, c) => sum + c.count, 0));

  function handleSelect(taskId: string): void {
    selectedTaskId = taskId;
  }

  function closeDrawer(): void {
    selectedTaskId = null;
  }
</script>

<svelte:head>
  <title>Pipeline — CLEO Studio</title>
</svelte:head>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="pipeline-view" role="main" onkeydown={handleKeydown} tabindex="-1">
  <HeroHeader
    eyebrow="PIPELINE"
    title="RCASD-IVTR+C"
    subtitle="Stage swim-lanes across every non-archived task. Arrow keys to navigate · Enter to open."
    meta={`${totalTasks} tasks · ${columns.length} stages`}
  >
    {#snippet actions()}
      <Button variant="ghost" size="sm" href="/tasks">← Tasks</Button>
      <Button variant="ghost" size="sm" href="/tasks/sessions">Sessions</Button>
    {/snippet}
  </HeroHeader>

  <div class="board-scroll">
    <div class="board">
      {#each columns as col, ci (col.id)}
        <StageSwimLane
          id={col.id}
          label={col.label}
          count={col.count}
          tasks={col.tasks}
          focused={ci === focusedCol}
          focusedRow={ci === focusedCol ? focusedRow : -1}
          onSelect={handleSelect}
        />
      {/each}
    </div>
  </div>

  <footer class="pipeline-foot">
    <span class="hint">Arrows navigate · Enter opens · Esc closes</span>
  </footer>
</div>

{#if drawerTask}
  <DetailDrawer task={drawerTask} onClose={closeDrawer} />
{/if}

<style>
  .pipeline-view {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    height: calc(100vh - 4rem);
    outline: none;
  }

  .board-scroll {
    flex: 1;
    overflow-x: auto;
    overflow-y: hidden;
    padding-bottom: var(--space-2);
  }

  .board {
    display: flex;
    gap: var(--space-3);
    height: 100%;
    min-width: max-content;
    align-items: stretch;
  }

  .board > :global(*) {
    height: 100%;
  }

  .pipeline-foot {
    display: flex;
    justify-content: center;
    padding-top: var(--space-2);
    border-top: 1px solid var(--border);
  }

  .hint {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
</style>
