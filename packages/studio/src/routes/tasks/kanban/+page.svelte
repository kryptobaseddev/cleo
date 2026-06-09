<!--
  /tasks/kanban — read-only agent-lifecycle dispatcher board route (T11925).

  Thin route shell: forwards the server-resolved lane columns to the reusable
  `KanbanView` component (which composes the generic Board). All data work
  happens in `+page.server.ts` over the existing Studio data layer.

  @task T11925
  @epic T11559
-->
<script lang="ts">
  import KanbanView from '$lib/components/tasks/KanbanView.svelte';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
</script>

<KanbanView columns={data.columns} total={data.total} error={data.error} />
