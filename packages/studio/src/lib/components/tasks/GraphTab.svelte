<!--
  GraphTab — d3-force dependency graph with ported viz UX.

  Wave 1B of the T949 Task Explorer merge (T954). Keeps Studio's proven
  d3-force engine and the 3 distinct edge kinds (`parent`, `blocks`,
  `depends`) with their existing dash patterns. PORTS these UX wins from
  the standalone viz at `/tmp/task-viz/index.html`:

    - Filter chips header (status / priority / labels / cancelled)
    - Shared `TaskSearchBox` with `/` keyboard shortcut
    - Shared `DetailDrawer` that slides in when a node is clicked
    - Blocked halo: red drop-shadow on pending tasks with unmet inbound deps
    - Epic nodes render as rectangles; tasks render as rounded rectangles
    - Physics auto-disable once simulation stabilises (no jitter)
    - Pan + zoom (mouse wheel zooms, drag-background pans)
    - Release-layout + Reset-view control buttons

  Reference UX: `/tmp/task-viz/index.html`.

  Rules followed:
    - Svelte 5 runes
    - Types from `@cleocode/contracts` (no `any`, no `unknown` shortcuts)
    - TSDoc on every exported helper
    - Re-uses the Wave 0A shelf (`StatusBadge`, `FilterChipGroup`,
      `TaskSearchBox`, `DetailDrawer`) via the barrel at `./index.js`
    - 3 edge kinds preserved with distinct dash patterns

  @task T954
  @epic T949
-->
<script lang="ts" module>
  import type { Task, TaskPriority, TaskStatus } from '@cleocode/contracts';

  import type { TaskDependencyEdge } from '$lib/server/tasks/explorer-loader.js';
  import type { TaskFilterState } from '$lib/stores/task-filters.svelte.js';

  // ---------------------------------------------------------------------------
  // Pure helpers (exported for unit tests, no DOM dependencies)
  // ---------------------------------------------------------------------------

  /**
   * Three edge kinds rendered by the graph tab — mirrors the contract
   * established by the previous Studio `/tasks/graph` implementation.
   *
   * - `parent` — hierarchy edge (solid line)
   * - `blocks` — the `blocked_by` overlay (heavy dashed `4 4`)
   * - `depends` — the `task_dependencies` overlay (dotted `2 3`)
   */
  export type GraphEdgeKind = 'parent' | 'blocks' | 'depends';

  /**
   * Render-ready graph node projected from a {@link Task}. Kept as a distinct
   * shape so the d3 simulation can decorate it with `x` / `y` / `fx` / `fy`
   * without leaking `Task` semantics into the force layer.
   */
  export interface GraphNode {
    /** Task ID (stable across ticks). */
    id: string;
    /** Task title (used in the drawer, not rendered inline). */
    title: string;
    /** Task status — drives fill colour and halo eligibility. */
    status: TaskStatus;
    /** Task priority — used for optional styling by consumers. */
    priority: TaskPriority;
    /**
     * Task type — `epic` is rendered as a rectangle; all others render as a
     * rounded-rect task node.
     */
    type: Task['type'];
    /** Parent ID for the hierarchy lookup. `null` / absent means root. */
    parentId: string | null;
    /** Pre-computed: is this node pending with at least one unmet inbound dep? */
    blocked: boolean;
  }

  /**
   * Render-ready graph edge. `source` / `target` are stored as string IDs
   * pre-force-layout and may be rewritten by d3 to the resolved node object
   * during `forceLink.id(...)`.
   */
  export interface GraphEdge {
    /** Source node ID (or resolved node once d3 has linked). */
    source: string;
    /** Target node ID (or resolved node once d3 has linked). */
    target: string;
    /** Edge kind — drives stroke colour and dash pattern. */
    kind: GraphEdgeKind;
  }

  /**
   * Pure predicate that determines whether a task deserves the "blocked halo"
   * visual treatment.
   *
   * Semantics (matches the standalone viz at
   * `/tmp/task-viz/index.html:907-914`):
   *
   *   A task is blocked iff its status is `pending` AND at least one of its
   *   declared inbound dependencies (`t.id` appears on the left side of a
   *   `task_dependencies` row) is not yet `done`.
   *
   * In the {@link TaskDependencyEdge} contract, `taskId` is the "blocked side"
   * and `dependsOn` is the "blocker side". So for a task `t`, we enumerate
   * every edge where `e.taskId === t.id` and check whether the blocker task's
   * status is anything other than `done`.
   *
   * @param task - The candidate task.
   * @param deps - All dependency edges (full set, not pre-filtered).
   * @param tasksById - Lookup map of every task in the bundle.
   * @returns `true` if the task should render with the red halo.
   *
   * @example
   * ```ts
   * const blocked = isBlocked(task, deps, new Map(tasks.map((t) => [t.id, t])));
   * ```
   */
  export function isBlocked(
    task: Task,
    deps: readonly TaskDependencyEdge[],
    tasksById: ReadonlyMap<string, Task>,
  ): boolean {
    if (task.status !== 'pending') return false;
    for (const edge of deps) {
      if (edge.taskId !== task.id) continue;
      const blocker = tasksById.get(edge.dependsOn);
      if (!blocker) continue;
      if (blocker.status !== 'done') return true;
    }
    return false;
  }

  /**
   * Pure predicate that applies the shared {@link TaskFilterState} to a single
   * task. Used to compute node visibility without side-effects.
   *
   * Filter semantics:
   *
   * - `query` — case-insensitive substring match on ID and title.
   * - `status` — empty array means "show all"; non-empty means "in the set".
   * - `priority` — same semantics as `status`.
   * - `labels` — empty array means "show all"; non-empty means "task has at
   *   least one of these labels".
   * - `cancelled` — when `false` (default), cancelled epics (and only epics;
   *   cancelled tasks/subtasks continue to render with the cancelled colour)
   *   are hidden.
   *
   * @param task - The candidate task.
   * @param filters - The current filter state from `createTaskFilters`.
   * @returns `true` if the task should remain visible in the graph.
   */
  export function passesFilter(task: Task, filters: TaskFilterState): boolean {
    const q = filters.query.trim().toLowerCase();
    if (q.length > 0) {
      const idHit = task.id.toLowerCase().includes(q);
      const titleHit = (task.title ?? '').toLowerCase().includes(q);
      if (!idHit && !titleHit) return false;
    }

    if (filters.status.length > 0 && !filters.status.includes(task.status)) {
      return false;
    }

    if (filters.priority.length > 0 && !filters.priority.includes(task.priority)) {
      return false;
    }

    if (filters.labels.length > 0) {
      const labels = task.labels ?? [];
      const hit = labels.some((l) => filters.labels.includes(l));
      if (!hit) return false;
    }

    if (!filters.cancelled && task.type === 'epic' && task.status === 'cancelled') {
      return false;
    }

    return true;
  }

  /**
   * Pure projection: tasks → {@link GraphNode} array, with pre-computed
   * blocked-halo flags.
   *
   * The output order matches the input `tasks` order for deterministic
   * rendering. The blocked flag is evaluated eagerly against the FULL `deps`
   * set (not a filtered view) so that hiding a blocker via a filter does not
   * accidentally un-block a task in the visible set.
   *
   * @param tasks - Task set to project.
   * @param deps - All dependency edges (full set).
   * @returns An array of graph nodes.
   */
  export function buildGraphNodes(
    tasks: readonly Task[],
    deps: readonly TaskDependencyEdge[],
  ): GraphNode[] {
    // De-dupe on task id — the `#each` block keys by `n.id`, so duplicate
    // rows from the loader (e.g. if two pages streamed the same id into the
    // ExplorerBundle) would throw Svelte's each_key_duplicate at runtime.
    // Deterministic: keep the first occurrence of each id.
    const byId = new Map<string, Task>();
    for (const t of tasks) {
      if (!byId.has(t.id)) byId.set(t.id, t);
    }
    const out: GraphNode[] = [];
    for (const t of byId.values()) {
      out.push({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        type: t.type,
        parentId: t.parentId ?? null,
        blocked: isBlocked(t, deps, byId),
      });
    }
    return out;
  }

  /**
   * Pure projection: tasks + deps → {@link GraphEdge} array with all three
   * edge kinds preserved.
   *
   * Edge sources:
   *
   * 1. **parent** — `t.parentId` → `t.id` (if both present in `visibleIds`).
   * 2. **blocks** — `t.blockedBy` free-form CSV / JSON array of blocker IDs.
   * 3. **depends** — `task_dependencies` rows via the `deps` array.
   *
   * Every edge is filtered to ensure both endpoints are in `visibleIds`.
   *
   * @param tasks - The task set (pre-filtered is fine — we only read blockedBy
   *   and parentId off tasks whose IDs are in `visibleIds`).
   * @param deps - All dependency edges.
   * @param visibleIds - Set of node IDs that remain in the visible graph.
   * @returns An array of graph edges, parent first for stable z-ordering.
   */
  export function buildGraphEdges(
    tasks: readonly Task[],
    deps: readonly TaskDependencyEdge[],
    visibleIds: ReadonlySet<string>,
  ): GraphEdge[] {
    const parentEdges: GraphEdge[] = [];
    const blocksEdges: GraphEdge[] = [];
    const dependsEdges: GraphEdge[] = [];

    for (const t of tasks) {
      if (!visibleIds.has(t.id)) continue;

      // 1. parent (hierarchy)
      if (t.parentId && visibleIds.has(t.parentId)) {
        parentEdges.push({ source: t.parentId, target: t.id, kind: 'parent' });
      }

      // 2. blocks (blockedBy overlay)
      if (t.blockedBy) {
        const raw = t.blockedBy.trim();
        let ids: string[] = [];
        if (raw.startsWith('[')) {
          try {
            const parsed: unknown = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              ids = parsed.filter((x): x is string => typeof x === 'string');
            }
          } catch {
            // fall through to CSV
          }
        }
        if (ids.length === 0) {
          ids = raw
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        }
        for (const blocker of ids) {
          if (visibleIds.has(blocker)) {
            blocksEdges.push({ source: blocker, target: t.id, kind: 'blocks' });
          }
        }
      }
    }

    // 3. depends (task_dependencies overlay)
    for (const d of deps) {
      if (visibleIds.has(d.taskId) && visibleIds.has(d.dependsOn)) {
        dependsEdges.push({ source: d.dependsOn, target: d.taskId, kind: 'depends' });
      }
    }

    return [...parentEdges, ...blocksEdges, ...dependsEdges];
  }

  // ---------------------------------------------------------------------------
  // Visual encoding helpers (pure, no DOM)
  // ---------------------------------------------------------------------------

  /**
   * Status → node-fill colour mapping. Mirrors the palette tokens in
   * `./format.ts` and the standalone viz at `/tmp/task-viz/index.html`.
   *
   * @param status - Task status.
   * @returns Hex colour string.
   */
  export function nodeFill(status: TaskStatus): string {
    switch (status) {
      case 'done':
        return '#22c55e';
      case 'active':
        return '#3b82f6';
      case 'blocked':
        return '#ef4444';
      case 'cancelled':
        return '#6b7280';
      case 'archived':
        return '#475569';
      case 'proposed':
        return '#a855f7';
      default:
        return '#f59e0b';
    }
  }

  /**
   * Edge → stroke colour mapping.
   *
   * @param kind - One of the 3 {@link GraphEdgeKind} values.
   * @returns Hex colour string.
   */
  export function edgeStroke(kind: GraphEdgeKind): string {
    if (kind === 'parent') return '#334155';
    if (kind === 'blocks') return '#ef4444';
    return '#f59e0b';
  }

  /**
   * Edge → SVG `stroke-dasharray` mapping. `null` for solid edges.
   *
   * - `parent` — solid (`null`)
   * - `blocks` — heavy dashed (`4 4`)
   * - `depends` — dotted (`2 3`)
   *
   * @param kind - One of the 3 {@link GraphEdgeKind} values.
   * @returns Dash-array string or `null` for solid.
   */
  export function edgeDash(kind: GraphEdgeKind): string | null {
    if (kind === 'blocks') return '4 4';
    if (kind === 'depends') return '2 3';
    return null;
  }

  /**
   * Invoke the filter store's `setSelected` with the clicked node's ID. Pure
   * for testability: the only side-effect is the setter call. Declared at
   * module scope so it is reachable from unit tests without mounting the
   * component.
   *
   * @param filtersHandle - The filter store handle.
   * @param nodeId - The clicked node's ID.
   */
  export function clickNode(
    filtersHandle: { setSelected: (id: string | null) => void },
    nodeId: string,
  ): void {
    filtersHandle.setSelected(nodeId);
  }
</script>

<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import * as d3 from 'd3';

  import {
    DetailDrawer,
    type DependencyLink,
    FilterChipGroup,
    type FilterChipOption,
    type ParentChainEntry,
    TaskSearchBox,
  } from './index.js';

  /**
   * d3 simulation augmentation of {@link GraphNode} — adds the position and
   * drag pin fields written in place by `forceSimulation`.
   */
  interface SimNode extends GraphNode {
    x?: number;
    y?: number;
    vx?: number;
    vy?: number;
    fx?: number | null;
    fy?: number | null;
  }

  /**
   * d3 simulation augmentation of {@link GraphEdge} — `source` and `target`
   * are rewritten to the resolved `SimNode` by d3's `forceLink`.
   */
  interface SimLink extends Omit<GraphEdge, 'source' | 'target'> {
    source: string | SimNode;
    target: string | SimNode;
  }

  /**
   * Minimal filter handle surface required by {@link GraphTab}. Matches the
   * public shape of `createTaskFilters(url)` from `task-filters.svelte.ts`
   * but is re-declared here so the component contract is explicit for
   * consumers and unit tests.
   */
  interface GraphFiltersHandle {
    readonly state: TaskFilterState;
    setQuery(q: string): void;
    toggleStatus(s: TaskStatus): void;
    togglePriority(p: TaskPriority): void;
    toggleLabel(l: string): void;
    setSelected(id: string | null): void;
    setCancelled(v: boolean): void;
  }

  /**
   * Props for {@link GraphTab}.
   */
  interface Props {
    /** Full task set from {@link ExplorerBundle}. */
    tasks: Task[];
    /** All dependency edges from {@link ExplorerBundle}. */
    deps: TaskDependencyEdge[];
    /** Shared filter store — drives visibility and selection. */
    filters: GraphFiltersHandle;
    /** Distinct labels across the bundle (drives the labels chip group). */
    labels?: string[];
  }

  let { tasks, deps, filters, labels = [] }: Props = $props();

  // ---------------------------------------------------------------------------
  // Derived: visible node set + projected nodes/edges
  // ---------------------------------------------------------------------------

  const allNodes: GraphNode[] = $derived(buildGraphNodes(tasks, deps));

  const visibleIds: Set<string> = $derived.by(() => {
    const set = new Set<string>();
    for (const t of tasks) {
      if (passesFilter(t, filters.state)) set.add(t.id);
    }
    return set;
  });

  const visibleNodes: GraphNode[] = $derived(allNodes.filter((n) => visibleIds.has(n.id)));
  const visibleEdges: GraphEdge[] = $derived(buildGraphEdges(tasks, deps, visibleIds));

  // ---------------------------------------------------------------------------
  // Selected task for the drawer (driven by the filter store)
  // ---------------------------------------------------------------------------

  const selectedTask: Task | null = $derived(
    filters.state.selected
      ? (tasks.find((t) => t.id === filters.state.selected) ?? null)
      : null,
  );

  const tasksById: Map<string, Task> = $derived(new Map(tasks.map((t) => [t.id, t])));

  const upstreamLinks: DependencyLink[] = $derived.by(() => {
    if (!selectedTask) return [];
    const out: DependencyLink[] = [];
    for (const d of deps) {
      if (d.taskId !== selectedTask.id) continue;
      const blocker = tasksById.get(d.dependsOn);
      if (!blocker) continue;
      out.push({
        id: blocker.id,
        title: blocker.title,
        status: blocker.status,
        priority: blocker.priority,
      });
    }
    return out;
  });

  const downstreamLinks: DependencyLink[] = $derived.by(() => {
    if (!selectedTask) return [];
    const out: DependencyLink[] = [];
    for (const d of deps) {
      if (d.dependsOn !== selectedTask.id) continue;
      const dependent = tasksById.get(d.taskId);
      if (!dependent) continue;
      out.push({
        id: dependent.id,
        title: dependent.title,
        status: dependent.status,
        priority: dependent.priority,
      });
    }
    return out;
  });

  const parentChain: ParentChainEntry[] = $derived.by(() => {
    if (!selectedTask) return [];
    const chain: ParentChainEntry[] = [];
    let current = selectedTask.parentId ? tasksById.get(selectedTask.parentId) : undefined;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      chain.unshift({ id: current.id, title: current.title, type: current.type });
      current = current.parentId ? tasksById.get(current.parentId) : undefined;
    }
    return chain;
  });

  // ---------------------------------------------------------------------------
  // d3-force simulation lifecycle
  // ---------------------------------------------------------------------------

  let svgEl: SVGSVGElement | null = $state(null);
  let simNodes: SimNode[] = $state([]);
  let simLinks: SimLink[] = $state([]);
  let simulation: d3.Simulation<SimNode, SimLink> | null = null;
  let physicsPaused: boolean = $state(false);
  let viewBoxX: number = $state(0);
  let viewBoxY: number = $state(0);
  let viewBoxW: number = $state(1200);
  let viewBoxH: number = $state(700);
  let isPanning = false;
  let panStart: { x: number; y: number; vbX: number; vbY: number } | null = null;

  /**
   * Build a fresh simulation over the visible node/edge set. Called on mount
   * and whenever the visible set changes shape (add/remove node).
   */
  function startSimulation(nodes: GraphNode[], edges: GraphEdge[]): void {
    // Preserve existing positions where possible so filter toggles don't
    // completely re-shuffle the layout.
    const priorPositions = new Map(simNodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    simNodes = nodes.map((n) => {
      const prior = priorPositions.get(n.id);
      return { ...n, x: prior?.x, y: prior?.y };
    });
    simLinks = edges.map((e) => ({ ...e }));

    if (simulation) simulation.stop();

    const width = svgEl?.clientWidth ?? viewBoxW;
    const height = svgEl?.clientHeight ?? viewBoxH;

    simulation = d3
      .forceSimulation<SimNode>(simNodes)
      .force(
        'link',
        d3
          .forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance(60)
          .strength((l) => (l.kind === 'parent' ? 1 : 0.2)),
      )
      .force('charge', d3.forceManyBody().strength(-300))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide<SimNode>(40))
      .on('tick', () => {
        // Trigger Svelte re-render by re-assigning the arrays.
        simNodes = [...simNodes];
        simLinks = [...simLinks];
      })
      .on('end', () => {
        physicsPaused = true;
      });

    // Cheap heuristic: stop once alpha drops below the threshold.
    const interval = setInterval(() => {
      if (!simulation) {
        clearInterval(interval);
        return;
      }
      if (simulation.alpha() < 0.01) {
        simulation.stop();
        physicsPaused = true;
        clearInterval(interval);
      }
    }, 250);
    physicsPaused = false;
  }

  onMount(() => {
    startSimulation(visibleNodes, visibleEdges);
  });

  onDestroy(() => {
    if (simulation) simulation.stop();
  });

  // Restart when the visible id set changes shape (add or remove).
  $effect(() => {
    const ids = [...visibleIds].sort().join('|');
    // Read once to establish the dep.
    void ids;
    if (!svgEl) return;
    startSimulation(visibleNodes, visibleEdges);
  });

  // ---------------------------------------------------------------------------
  // Interactions — click / drag / pan / zoom
  // ---------------------------------------------------------------------------

  function onNodeClick(id: string): void {
    clickNode(filters, id);
  }

  function onDrawerClose(): void {
    filters.setSelected(null);
  }

  function onDrawerSelectDep(id: string): void {
    filters.setSelected(id);
  }

  /**
   * Release the simulation — pins every node at its current position so the
   * layout stops moving. Useful once the user has a layout they like.
   */
  function releaseLayout(): void {
    if (!simulation) return;
    for (const n of simNodes) {
      n.fx = n.x ?? 0;
      n.fy = n.y ?? 0;
    }
    simulation.stop();
    physicsPaused = true;
    simNodes = [...simNodes];
  }

  /**
   * Un-pin every node and restart the simulation so the user can iterate on
   * the layout again after clicking "Release layout".
   */
  function resumeLayout(): void {
    for (const n of simNodes) {
      n.fx = null;
      n.fy = null;
    }
    if (simulation) {
      simulation.alpha(0.6).restart();
    } else {
      startSimulation(visibleNodes, visibleEdges);
    }
    physicsPaused = false;
  }

  /**
   * Reset the viewport to fit the full node set, recentering at (0, 0) in
   * viewBox coordinates.
   */
  function resetView(): void {
    if (simNodes.length === 0) {
      viewBoxX = 0;
      viewBoxY = 0;
      viewBoxW = 1200;
      viewBoxH = 700;
      return;
    }
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const n of simNodes) {
      if (n.x === undefined || n.y === undefined) continue;
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
    if (!Number.isFinite(minX)) {
      viewBoxX = 0;
      viewBoxY = 0;
      viewBoxW = 1200;
      viewBoxH = 700;
      return;
    }
    const pad = 80;
    viewBoxX = minX - pad;
    viewBoxY = minY - pad;
    viewBoxW = Math.max(300, maxX - minX + pad * 2);
    viewBoxH = Math.max(300, maxY - minY + pad * 2);
  }

  function onSvgWheel(e: WheelEvent): void {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.1 : 0.9;
    const cx = viewBoxX + viewBoxW / 2;
    const cy = viewBoxY + viewBoxH / 2;
    viewBoxW = Math.max(200, Math.min(6000, viewBoxW * factor));
    viewBoxH = Math.max(200, Math.min(6000, viewBoxH * factor));
    viewBoxX = cx - viewBoxW / 2;
    viewBoxY = cy - viewBoxH / 2;
  }

  function onSvgMouseDown(e: MouseEvent): void {
    // Only start a pan on plain left-button on the background (target=svg).
    if (e.button !== 0) return;
    if (e.target !== svgEl) return;
    isPanning = true;
    panStart = { x: e.clientX, y: e.clientY, vbX: viewBoxX, vbY: viewBoxY };
  }

  function onSvgMouseMove(e: MouseEvent): void {
    if (!isPanning || !panStart || !svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const scaleX = viewBoxW / rect.width;
    const scaleY = viewBoxH / rect.height;
    viewBoxX = panStart.vbX - (e.clientX - panStart.x) * scaleX;
    viewBoxY = panStart.vbY - (e.clientY - panStart.y) * scaleY;
  }

  function onSvgMouseUp(): void {
    isPanning = false;
    panStart = null;
  }

  // Node drag (starts physics so the layout responds to the drag)
  let draggingId: string | null = null;
  let dragOffset: { dx: number; dy: number } | null = null;

  function clientToViewBox(ex: number, ey: number): { x: number; y: number } {
    if (!svgEl) return { x: 0, y: 0 };
    const rect = svgEl.getBoundingClientRect();
    return {
      x: viewBoxX + ((ex - rect.left) / rect.width) * viewBoxW,
      y: viewBoxY + ((ey - rect.top) / rect.height) * viewBoxH,
    };
  }

  function onNodeMouseDown(e: MouseEvent, n: SimNode): void {
    e.stopPropagation();
    if (e.button !== 0) return;
    draggingId = n.id;
    const vb = clientToViewBox(e.clientX, e.clientY);
    dragOffset = { dx: vb.x - (n.x ?? 0), dy: vb.y - (n.y ?? 0) };
    n.fx = n.x ?? 0;
    n.fy = n.y ?? 0;
    if (simulation) simulation.alphaTarget(0.3).restart();
    physicsPaused = false;
  }

  function onSvgMouseMoveDrag(e: MouseEvent): void {
    if (!draggingId || !dragOffset) return;
    const node = simNodes.find((nn) => nn.id === draggingId);
    if (!node) return;
    const vb = clientToViewBox(e.clientX, e.clientY);
    node.fx = vb.x - dragOffset.dx;
    node.fy = vb.y - dragOffset.dy;
    simNodes = [...simNodes];
  }

  function onSvgMouseUpDrag(): void {
    if (!draggingId) return;
    if (simulation) simulation.alphaTarget(0);
    draggingId = null;
    dragOffset = null;
  }

  function resolveEnd(link: SimLink, end: 'source' | 'target'): SimNode | null {
    const v = link[end];
    if (typeof v === 'string') return simNodes.find((n) => n.id === v) ?? null;
    return v;
  }

  // ---------------------------------------------------------------------------
  // Filter chip options
  // ---------------------------------------------------------------------------

  const statusOptions: FilterChipOption[] = [
    { value: 'pending', label: 'Pending', tint: '#f59e0b' },
    { value: 'active', label: 'Active', tint: '#3b82f6' },
    { value: 'blocked', label: 'Blocked', tint: '#ef4444' },
    { value: 'done', label: 'Done', tint: '#22c55e' },
    { value: 'cancelled', label: 'Cancelled', tint: '#6b7280' },
  ];

  const priorityOptions: FilterChipOption[] = [
    { value: 'critical', label: 'Critical', tint: '#ef4444' },
    { value: 'high', label: 'High', tint: '#f97316' },
    { value: 'medium', label: 'Medium', tint: '#f59e0b' },
    { value: 'low', label: 'Low', tint: '#6b7280' },
  ];

  const labelOptions: FilterChipOption[] = $derived(labels.map((l) => ({ value: l, label: l })));

  function onStatusChange(next: string[]): void {
    const cur = new Set(filters.state.status);
    for (const s of next) if (!cur.has(s as TaskStatus)) filters.toggleStatus(s as TaskStatus);
    for (const s of filters.state.status)
      if (!next.includes(s)) filters.toggleStatus(s);
  }

  function onPriorityChange(next: string[]): void {
    const cur = new Set(filters.state.priority);
    for (const p of next)
      if (!cur.has(p as TaskPriority)) filters.togglePriority(p as TaskPriority);
    for (const p of filters.state.priority)
      if (!next.includes(p)) filters.togglePriority(p);
  }

  function onLabelsChange(next: string[]): void {
    const cur = new Set(filters.state.labels);
    for (const l of next) if (!cur.has(l)) filters.toggleLabel(l);
    for (const l of filters.state.labels) if (!next.includes(l)) filters.toggleLabel(l);
  }

  function onSearchChange(q: string): void {
    filters.setQuery(q);
  }
</script>

<svelte:window
  onmousemove={(e) => {
    onSvgMouseMove(e);
    onSvgMouseMoveDrag(e);
  }}
  onmouseup={() => {
    onSvgMouseUp();
    onSvgMouseUpDrag();
  }}
/>

<div class="graph-tab">
  <!-- ------------------------------------------------------------------ -->
  <!-- Controls bar -->
  <!-- ------------------------------------------------------------------ -->
  <div class="controls-bar">
    <div class="controls-row">
      <TaskSearchBox value={filters.state.query} onChange={onSearchChange} />
      <FilterChipGroup
        label="Status"
        options={statusOptions}
        selected={filters.state.status}
        onChange={onStatusChange}
      />
      <FilterChipGroup
        label="Priority"
        options={priorityOptions}
        selected={filters.state.priority}
        onChange={onPriorityChange}
      />
      {#if labelOptions.length > 0}
        <FilterChipGroup
          label="Labels"
          options={labelOptions}
          selected={filters.state.labels}
          onChange={onLabelsChange}
        />
      {/if}
    </div>
    <div class="controls-row">
      <label class="cancelled-toggle">
        <input
          type="checkbox"
          checked={filters.state.cancelled}
          onchange={(e) =>
            filters.setCancelled((e.currentTarget as HTMLInputElement).checked)}
        />
        <span>Include cancelled epics</span>
      </label>
      <span class="visible-count">
        Showing <strong>{visibleNodes.length}</strong> of <strong>{tasks.length}</strong>
        tasks
      </span>
      <div class="controls-actions">
        {#if physicsPaused}
          <button type="button" class="btn" onclick={resumeLayout}>Resume physics</button>
        {:else}
          <button type="button" class="btn" onclick={releaseLayout}>Release layout</button>
        {/if}
        <button type="button" class="btn" onclick={resetView}>Reset view</button>
      </div>
      <div class="legend">
        <span class="legend-item"><span class="swatch swatch-parent"></span>parent</span>
        <span class="legend-item"><span class="swatch swatch-blocks"></span>blocks</span>
        <span class="legend-item"><span class="swatch swatch-depends"></span>depends</span>
      </div>
    </div>
  </div>

  <!-- ------------------------------------------------------------------ -->
  <!-- Graph + drawer -->
  <!-- ------------------------------------------------------------------ -->
  <div class="graph-body">
    <div class="graph-wrap">
      {#if simNodes.length === 0}
        <div class="empty-state">
          <p>No tasks match the current filters.</p>
        </div>
      {:else}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <svg
          bind:this={svgEl}
          role="img"
          aria-label="Task relations graph"
          class="graph-svg"
          viewBox="{viewBoxX} {viewBoxY} {viewBoxW} {viewBoxH}"
          preserveAspectRatio="xMidYMid meet"
          onwheel={onSvgWheel}
          onmousedown={onSvgMouseDown}
        >
          <defs>
            <marker
              id="arrow-head"
              viewBox="0 -4 8 8"
              refX="8"
              refY="0"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M0,-4L8,0L0,4" fill="#64748b" />
            </marker>
          </defs>

          <!-- Edges first so nodes render on top -->
          <g class="edges">
            {#each simLinks as link (link.source.toString() + '->' + link.target.toString() + ':' + link.kind)}
              {@const s = resolveEnd(link, 'source')}
              {@const t = resolveEnd(link, 'target')}
              {#if s && t && s.x !== undefined && s.y !== undefined && t.x !== undefined && t.y !== undefined}
                <line
                  x1={s.x}
                  y1={s.y}
                  x2={t.x}
                  y2={t.y}
                  stroke={edgeStroke(link.kind)}
                  stroke-width={link.kind === 'parent' ? 1.5 : 1.2}
                  stroke-dasharray={edgeDash(link.kind)}
                  marker-end="url(#arrow-head)"
                  opacity="0.7"
                />
              {/if}
            {/each}
          </g>

          <!-- Nodes -->
          <g class="nodes">
            {#each simNodes as n (n.id)}
              {#if n.x !== undefined && n.y !== undefined}
                {@const isEpic = n.type === 'epic'}
                {@const w = isEpic ? 64 : 52}
                {@const h = isEpic ? 28 : 22}
                <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                <g
                  role="button"
                  tabindex="0"
                  class="node"
                  class:selected={filters.state.selected === n.id}
                  class:blocked-halo={n.blocked}
                  transform="translate({n.x},{n.y})"
                  onclick={() => onNodeClick(n.id)}
                  onkeydown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onNodeClick(n.id);
                    }
                  }}
                  onmousedown={(e) => onNodeMouseDown(e, n)}
                  aria-label="{n.id} — {n.title}"
                >
                  <rect
                    x={-w / 2}
                    y={-h / 2}
                    width={w}
                    height={h}
                    rx={isEpic ? 2 : 8}
                    ry={isEpic ? 2 : 8}
                    fill={nodeFill(n.status)}
                    stroke={isEpic ? '#a78bfa' : '#111827'}
                    stroke-width={isEpic ? 2 : 1}
                  />
                  <text
                    text-anchor="middle"
                    dominant-baseline="middle"
                    fill={isEpic ? '#ffffff' : '#111827'}
                    font-size="10"
                    font-family="ui-monospace, SF Mono, Menlo, monospace"
                    font-weight="600"
                    pointer-events="none"
                  >
                    {n.id}
                  </text>
                </g>
              {/if}
            {/each}
          </g>
        </svg>
      {/if}
    </div>

    {#if selectedTask}
      <DetailDrawer
        task={selectedTask}
        upstream={upstreamLinks}
        downstream={downstreamLinks}
        {parentChain}
        onClose={onDrawerClose}
        onSelectDep={onDrawerSelectDep}
      />
    {/if}
  </div>
</div>

<style>
  .graph-tab {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    height: 100%;
    min-height: 0;
  }

  .controls-bar {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .controls-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
  }

  .cancelled-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    color: #94a3b8;
    cursor: pointer;
    user-select: none;
  }

  .cancelled-toggle input {
    accent-color: #a855f7;
    cursor: pointer;
  }

  .visible-count {
    font-size: 0.75rem;
    color: #94a3b8;
  }

  .visible-count strong {
    color: #e2e8f0;
    font-variant-numeric: tabular-nums;
  }

  .controls-actions {
    display: inline-flex;
    gap: 0.375rem;
  }

  .btn {
    background: #1a1f2e;
    color: #94a3b8;
    border: 1px solid #2d3748;
    border-radius: 4px;
    padding: 0.3rem 0.625rem;
    font-size: 0.75rem;
    font-family: inherit;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
  }

  .btn:hover {
    color: #e2e8f0;
    border-color: #3a4055;
  }

  .btn:focus-visible {
    outline: 2px solid rgba(168, 85, 247, 0.5);
    outline-offset: 1px;
  }

  .legend {
    display: inline-flex;
    gap: 0.75rem;
    margin-left: auto;
    font-size: 0.7rem;
    color: #64748b;
  }

  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }

  .swatch {
    width: 14px;
    height: 2px;
    display: inline-block;
  }

  .swatch-parent {
    background: #334155;
  }

  .swatch-blocks {
    background: #ef4444;
    border-top: 1px dashed transparent;
    height: 3px;
    border-top-style: dashed;
  }

  .swatch-depends {
    border-top: 1px dotted #f59e0b;
    background: transparent;
    height: 3px;
  }

  .graph-body {
    display: flex;
    flex: 1;
    min-height: 600px;
    gap: 0;
  }

  .graph-wrap {
    position: relative;
    flex: 1;
    min-width: 0;
    background: #0f1419;
    border: 1px solid #2d3748;
    border-radius: 8px;
    overflow: hidden;
  }

  .graph-svg {
    width: 100%;
    height: 100%;
    display: block;
    cursor: grab;
  }

  .graph-svg:active {
    cursor: grabbing;
  }

  .node {
    cursor: pointer;
    transition: transform 0.15s;
  }

  .node:focus-visible rect {
    outline: 2px solid rgba(168, 85, 247, 0.8);
    outline-offset: 2px;
  }

  .node.selected rect {
    stroke: #a855f7;
    stroke-width: 3;
  }

  .node.blocked-halo rect {
    filter: drop-shadow(0 0 6px #ef4444);
  }

  .empty-state {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #64748b;
    font-size: 0.875rem;
  }
</style>