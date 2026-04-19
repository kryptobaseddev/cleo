<!--
  DetailDrawer — right-side slide-out panel for task inspection.

  Post-T990 Wave 1C, the 749-line monolith is decomposed into:

    - IdentitySection     — id badge + close + title + meta grid
    - BreadcrumbSection   — parent chain
    - DependenciesSection — upstream + downstream lists
    - GatesSection        — acceptance-gate visualization
    - LabelsSection       — labels + acceptance criteria

  The drawer itself orchestrates and performs the live-refresh fetch
  against `/api/tasks/[id]` + `/api/tasks/[id]/deps` when a task pins, so
  stale props from the ExplorerBundle don't leak through.

  Behaviour preserved from the previous monolith:

    - Opens on node click (graph) / row click (hierarchy) / card click (kanban)
    - Esc closes (registered only while open)
    - Dep click repins via `onSelectDep` (prevents page nav)
    - `Open full page →` anchors to `/tasks/{id}`

  @task T950
  @epic T949
  @reviewed T990 (Wave 1C)
-->
<script lang="ts" module>
  /**
   * Single dependency-link entry rendered by the Dependencies section.
   * Re-declared at module-scope so the Task Explorer barrel
   * (`./index.ts`) can re-export the type alongside the component.
   */
  export interface DependencyLink {
    id: string;
    title: string;
    status: string;
    priority?: string;
  }

  /**
   * Single parent-chain entry rendered by the Breadcrumb section.
   */
  export interface ParentChainEntry {
    id: string;
    title: string;
    type?: string;
  }
</script>

<script lang="ts">
  import type { Task } from '@cleocode/contracts';
  import { onMount } from 'svelte';

  import Modal from '$lib/ui/Modal.svelte';

  import BreadcrumbSection from './DetailDrawer/BreadcrumbSection.svelte';
  import DependenciesSection from './DetailDrawer/DependenciesSection.svelte';
  import GatesSection from './DetailDrawer/GatesSection.svelte';
  import IdentitySection from './DetailDrawer/IdentitySection.svelte';
  import LabelsSection from './DetailDrawer/LabelsSection.svelte';

  /**
   * Props for {@link DetailDrawer}. The drawer component hides itself
   * when `task` is `null`.
   */
  interface Props {
    task: Task | null;
    onClose: () => void;
    upstream?: DependencyLink[];
    downstream?: DependencyLink[];
    parentChain?: ParentChainEntry[];
    onSelectDep?: (id: string) => void;
    loading?: boolean;
    error?: string | null;
    /**
     * When true (default), the drawer fetches fresh state from
     * `/api/tasks/[id]` + `/api/tasks/[id]/deps` whenever `task.id`
     * changes.  Callers that already resolve deps in-memory can pass
     * `false` to skip the roundtrip.
     */
    liveFetch?: boolean;
  }

  let {
    task,
    onClose,
    upstream = [],
    downstream = [],
    parentChain = [],
    onSelectDep,
    loading = false,
    error,
    liveFetch = true,
  }: Props = $props();

  // Live-fetched deps override the props when available.
  let fetchedUpstream = $state<DependencyLink[] | null>(null);
  let fetchedDownstream = $state<DependencyLink[] | null>(null);
  let fetchedTask = $state<Task | null>(null);
  let fetchLoading = $state(false);
  let fetchError = $state<string | null>(null);

  // Effective values — fetched wins over props when live fetch succeeded.
  const effectiveTask = $derived(fetchedTask ?? task);
  const effectiveUpstream = $derived(fetchedUpstream ?? upstream);
  const effectiveDownstream = $derived(fetchedDownstream ?? downstream);
  const effectiveLoading = $derived(loading || fetchLoading);
  const effectiveError = $derived(error ?? fetchError);

  /**
   * When the pinned task changes, optionally re-fetch fresh state from
   * the API so the drawer never shows stale counts.
   */
  $effect(() => {
    const id = task?.id;
    if (!id || !liveFetch) {
      fetchedUpstream = null;
      fetchedDownstream = null;
      fetchedTask = null;
      fetchError = null;
      return;
    }
    const controller = new AbortController();
    fetchLoading = true;
    fetchError = null;
    const run = async (): Promise<void> => {
      try {
        const [taskRes, depsRes] = await Promise.all([
          fetch(`/api/tasks/${id}`, { signal: controller.signal }),
          fetch(`/api/tasks/${id}/deps`, { signal: controller.signal }),
        ]);
        if (!taskRes.ok) {
          // Non-fatal: fall back to props; surface a warning only.
          fetchError = `Task refresh failed (${taskRes.status})`;
          return;
        }
        const taskBody = (await taskRes.json()) as { task?: Task; error?: string };
        if (taskBody.task) {
          fetchedTask = taskBody.task;
        }
        if (depsRes.ok) {
          const depsBody = (await depsRes.json()) as {
            upstream?: DependencyLink[];
            downstream?: DependencyLink[];
          };
          if (Array.isArray(depsBody.upstream)) fetchedUpstream = depsBody.upstream;
          if (Array.isArray(depsBody.downstream)) fetchedDownstream = depsBody.downstream;
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          fetchError = `Fetch error: ${(e as Error).message}`;
        }
      } finally {
        fetchLoading = false;
      }
    };
    void run();
    return () => controller.abort();
  });

  onMount(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && task !== null) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });
</script>

{#if effectiveTask}
  {@const modalOpen = true}
  <Modal
    open={modalOpen}
    title={`Task ${effectiveTask.id}`}
    maxWidth={44}
    onclose={onClose}
    class="task-detail-modal"
  >
    {#snippet children()}
      <div class="detail-body" aria-label={`Task ${effectiveTask.id} details`}>
        <IdentitySection task={effectiveTask} {onClose} />

        <BreadcrumbSection task={effectiveTask} chain={parentChain} {onSelectDep} />

        {#if effectiveTask.parentId}
          <div class="parent-row">
            <span class="parent-label">Parent</span>
            {#if onSelectDep}
              <button
                type="button"
                class="inline-link"
                onclick={() => onSelectDep?.(effectiveTask.parentId ?? '')}
              >{effectiveTask.parentId}</button>
            {:else}
              <a href={`/tasks/${effectiveTask.parentId}`} class="inline-link">
                {effectiveTask.parentId}
              </a>
            {/if}
          </div>
        {/if}

        <LabelsSection task={effectiveTask} />

        <GatesSection task={effectiveTask} />

        <DependenciesSection
          upstream={effectiveUpstream}
          downstream={effectiveDownstream}
          {onSelectDep}
          loading={effectiveLoading}
          error={effectiveError}
        />
      </div>
    {/snippet}

    {#snippet footer()}
      <div class="drawer-actions">
        <a href={`/tasks/${effectiveTask.id}`} class="btn btn-secondary">Open full page →</a>
        <button
          type="button"
          class="btn btn-primary"
          disabled
          title="Wire in T952"
        >
          Start working
        </button>
      </div>
    {/snippet}
  </Modal>
{/if}

<style>
  /* Inside the Modal primitive — body content scrolls vertically when long. */
  .detail-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    font-size: var(--text-base);
  }

  .parent-row {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    font-size: var(--text-xs);
  }

  .parent-label {
    color: var(--text-faint);
    text-transform: uppercase;
    font-size: 0.625rem;
    letter-spacing: 0.06em;
    font-weight: 600;
  }

  .inline-link {
    background: transparent;
    border: none;
    padding: 0;
    font-family: var(--font-mono);
    color: var(--accent);
    cursor: pointer;
    text-decoration: none;
    font-size: var(--text-xs);
  }

  .inline-link:hover {
    text-decoration: underline;
  }

  .drawer-actions {
    display: flex;
    gap: var(--space-2);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
    margin-top: var(--space-2);
  }

  .btn {
    flex: 1;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    font-weight: 500;
    text-align: center;
    cursor: pointer;
    border: 1px solid transparent;
    font-family: inherit;
    transition: background var(--ease), border-color var(--ease), color var(--ease);
    text-decoration: none;
  }

  .btn-primary {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  }

  .btn-primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 25%, transparent);
    border-color: color-mix(in srgb, var(--accent) 70%, transparent);
  }

  .btn-primary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .btn-secondary {
    background: var(--bg-elev-2);
    color: var(--text);
    border-color: var(--border);
  }

  .btn-secondary:hover {
    background: color-mix(in srgb, var(--bg-elev-2) 70%, var(--bg-elev-1));
    border-color: var(--border-strong);
  }

  .btn-secondary:focus-visible,
  .btn-primary:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }
</style>
