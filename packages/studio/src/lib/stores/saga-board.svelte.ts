/**
 * `saga-board.svelte.ts` — the Svelte-5 RUNE store that backs the interactive
 * agent-lifecycle dispatcher board (T11789 · E2-STUDIO-DATA-LAYER).
 *
 * This is the Studio analogue of opencode's `SyncProvider`: a single live,
 * reactive board model that is
 *
 *  1. **hydrated once** through the gateway data layer
 *     ({@link import('./saga-board-client.js').BoardHydrator} → `GET /api/tasks`),
 *  2. **kept live** by ONE `EventSource` subscription to the gateway
 *     `tasks.subscribe` SSE
 *     ({@link import('./saga-board-client.js').BoardSubscriptionFactory} →
 *     `/api/tasks/subscribe`) — REPLACING the prior 2 s tasks-events + 15 s
 *     health poll loop, and
 *  3. **mutated** through the command client
 *     ({@link import('./saga-board-client.js').BoardCommandClient}), which
 *     forwards every write to the `/v1` gateway SDK client.
 *
 * The store owns ONLY reactive board state + the orchestration of the seam
 * (command vs subscription vs hydration). Lane resolution stays in the shared
 * `@cleocode/core/tasks` SSoT so Studio and the TUI bucket identically.
 *
 * ## Rune discipline (Svelte-5, NOT Svelte-4 stores)
 *
 * `$state` / `$derived` are compiler runes that only work inside `.svelte` /
 * `.svelte.ts` modules. The store is a CLASS with `$state` fields and `$derived`
 * getters — the canonical Svelte-5 pattern for a shared reactive object — so a
 * component just does `const board = createSagaBoard(...)` (in a `$effect` or at
 * module scope of a route) and reads `board.lanes` reactively. No
 * `writable()` / `$store` autosubscription, no `get()`.
 *
 * @packageDocumentation
 * @module $lib/stores/saga-board
 *
 * @task T11789 — saga-board.svelte.ts rune store (hydrate once + ONE EventSource)
 * @epic T11557 — E2-STUDIO-DATA-LAYER
 * @saga T11555
 */

import type { TaskPriority, TaskStatus } from '@cleocode/contracts';
import {
  AGENT_LIFECYCLE_LANE_HINTS,
  AGENT_LIFECYCLE_LANE_LABELS,
  AGENT_LIFECYCLE_LANES,
  type AgentLifecycleLane,
  type AgentLifecycleSignal,
  resolveAgentLifecycleLane,
} from '@cleocode/core/tasks';
import type { BoardCard, BoardLane } from '$lib/components/board/board-types.js';
import {
  type BoardCommandClient,
  type BoardEvent,
  type BoardHydrator,
  type BoardSnapshotRow,
  type BoardSubscription,
  type BoardSubscriptionFactory,
  type CommandData,
  type CommandResult,
  type CreateCommand,
  eventSourceBoardSubscriptionFactory,
  httpBoardCommandClient,
  httpBoardHydrator,
} from './saga-board-client.js';

/** A board card with its resolved lane id stamped on (the override-aware lane). */
export interface SagaBoardCard extends BoardCard {
  /** The lane the card currently resolves to (optimistic override wins). */
  lane: AgentLifecycleLane;
}

/** A lane column: the lane definition + its cards, in board order. */
export interface SagaBoardColumn {
  /** Lane definition (id/label/hint). */
  lane: BoardLane;
  /** Cards routed to this lane. */
  cards: SagaBoardCard[];
  /** Card count for the header chip. */
  count: number;
}

/** Dependency bundle the store is constructed with (DIP — all injectable). */
export interface SagaBoardDeps {
  /** Reads the board snapshot (defaults to the HTTP/gateway hydrator). */
  hydrator?: BoardHydrator;
  /** Issues mutations (defaults to the HTTP/gateway command client). */
  commands?: BoardCommandClient;
  /** Opens the live subscription (defaults to ONE EventSource → tasks.subscribe). */
  subscriptionFactory?: BoardSubscriptionFactory;
  /** Optional saga/parent scope to bound the board + its subscription to. */
  root?: string;
}

/**
 * Build the ordered, board-ready lane definitions from the shared lane taxonomy.
 *
 * @returns The seven agent-lifecycle lanes in canonical order.
 */
function buildLanes(): BoardLane[] {
  return AGENT_LIFECYCLE_LANES.map((id) => ({
    id,
    label: AGENT_LIFECYCLE_LANE_LABELS[id],
    hint: AGENT_LIFECYCLE_LANE_HINTS[id],
  }));
}

/**
 * Project a board snapshot row + the active-worker set onto the framework-free
 * {@link AgentLifecycleSignal} the shared resolver consumes.
 *
 * The lightweight `/api/tasks` snapshot does not carry gate/dep detail, so the
 * signal is derived from status + worker activity — the same conservative
 * mapping `+page.server.ts` uses for the read-only board. The resolver's
 * precedence ladder (`cancelled > done > blocked > review > running > ready >
 * backlog`) does the rest.
 *
 * @param row - The board snapshot row.
 * @param workerActive - Whether an active session claims this task.
 * @returns The normalised signal.
 */
function toSignal(row: BoardSnapshotRow, workerActive: boolean): AgentLifecycleSignal {
  return {
    status: row.status,
    blockedBy: null,
    depends: [],
    unmetDependsCount: 0,
    gates: null,
    readyToComplete: false,
    prAwaiting: false,
    hitlPending: false,
    workerActive,
  };
}

/** Project a board snapshot row onto a presentational {@link BoardCard}. */
function toCard(row: BoardSnapshotRow, workerActive: boolean): BoardCard {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    size: row.size,
    verificationJson: row.verificationJson,
    workerActive,
  };
}

/**
 * The reactive saga-board store. Construct via {@link createSagaBoard}.
 *
 * Holds the raw snapshot rows + the active-worker set + optimistic lane
 * overrides as `$state`, and exposes `cards` / `columns` / `lanes` as `$derived`
 * getters so a component re-renders automatically on any mutation, optimistic
 * override, or live event re-hydration.
 */
export class SagaBoardStore {
  /** Lane definitions in board order (static taxonomy). */
  readonly lanes: BoardLane[] = buildLanes();

  /** Raw board snapshot rows from the last hydration. */
  #rows = $state<BoardSnapshotRow[]>([]);
  /** Task ids currently claimed by an active worker. */
  #activeWorkerIds = $state<ReadonlySet<string>>(new Set<string>());
  /** Optimistic lane overrides, keyed by task id → lane (cleared on re-hydrate). */
  #laneOverride = $state<Record<string, AgentLifecycleLane>>({});
  /** Whether the live subscription is connected (drives the `live` indicator). */
  #connected = $state(false);
  /** Whether a hydration is currently in flight. */
  #loading = $state(false);
  /** The most recent hydration error message, or null. */
  #error = $state<string | null>(null);

  readonly #deps: Required<Pick<SagaBoardDeps, 'hydrator' | 'commands' | 'subscriptionFactory'>>;
  readonly #root?: string;
  #subscription: BoardSubscription | null = null;

  /**
   * @param deps - Injectable seam dependencies (all default to the HTTP/gateway impls).
   */
  constructor(deps: SagaBoardDeps = {}) {
    this.#deps = {
      hydrator: deps.hydrator ?? httpBoardHydrator(),
      commands: deps.commands ?? httpBoardCommandClient(),
      subscriptionFactory:
        deps.subscriptionFactory ?? eventSourceBoardSubscriptionFactory(deps.root),
    };
    this.#root = deps.root;
  }

  // ---- Reactive reads ($derived getters) ----

  /** Whether the live subscription is currently connected. */
  get connected(): boolean {
    return this.#connected;
  }

  /** Whether a hydration is in flight. */
  get loading(): boolean {
    return this.#loading;
  }

  /** The last hydration error, or null. */
  get error(): string | null {
    return this.#error;
  }

  /** The scope root this board is bound to, if any. */
  get root(): string | undefined {
    return this.#root;
  }

  /** Flat card list with each card's resolved (override-aware) lane stamped on. */
  readonly cards = $derived.by<SagaBoardCard[]>(() => {
    return this.#rows
      .filter((row) => row.status !== 'archived' && row.status !== 'proposed')
      .map((row) => {
        const workerActive = this.#activeWorkerIds.has(row.id);
        const card = toCard(row, workerActive);
        const resolved = resolveAgentLifecycleLane(toSignal(row, workerActive));
        const lane = this.#laneOverride[row.id] ?? resolved;
        return { ...card, lane };
      });
  });

  /** The lane columns (lanes × bucketed cards), in board order. */
  readonly columns = $derived.by<SagaBoardColumn[]>(() => {
    const byLane = new Map<AgentLifecycleLane, SagaBoardCard[]>();
    for (const lane of AGENT_LIFECYCLE_LANES) byLane.set(lane, []);
    for (const card of this.cards) byLane.get(card.lane)?.push(card);
    return this.lanes.map((lane) => {
      const cards = byLane.get(lane.id as AgentLifecycleLane) ?? [];
      return { lane, cards, count: cards.length };
    });
  });

  /** Total surfaced cards across every lane. */
  readonly total = $derived(this.cards.length);

  /** Count of cards flagged with an active worker. */
  readonly runningCount = $derived(this.cards.filter((c) => c.workerActive).length);

  // ---- Lifecycle ----

  /**
   * Hydrate the board once from the gateway data layer. Clears any optimistic
   * overrides (a fresh snapshot is authoritative) and records the error on
   * failure (the board renders an error banner rather than throwing).
   *
   * @returns Resolves once the snapshot is applied (or the error recorded).
   */
  async hydrate(): Promise<void> {
    this.#loading = true;
    try {
      const { rows, activeWorkerIds } = await this.#deps.hydrator.hydrate();
      this.#rows = rows;
      this.#activeWorkerIds = new Set(activeWorkerIds);
      this.#laneOverride = {};
      this.#error = null;
    } catch (e) {
      this.#error = e instanceof Error ? e.message : 'Failed to load the board';
    } finally {
      this.#loading = false;
    }
  }

  /**
   * Open the SINGLE live subscription. Every board lifecycle event triggers a
   * re-hydration (debounced by the in-flight `loading` guard) — this is the one
   * channel that replaces polling. Idempotent: a second call closes the prior
   * subscription first.
   */
  connect(): void {
    this.disconnect();
    this.#subscription = this.#deps.subscriptionFactory({
      onEvent: (event: BoardEvent) => this.#onLiveEvent(event),
      onConnectionChange: (connected) => {
        this.#connected = connected;
      },
    });
  }

  /** Tear the live subscription down (idempotent). */
  disconnect(): void {
    this.#subscription?.close();
    this.#subscription = null;
    this.#connected = false;
  }

  /** React to a live board event: re-hydrate unless one is already in flight. */
  #onLiveEvent(_event: BoardEvent): void {
    if (this.#loading) return;
    void this.hydrate();
  }

  // ---- Mutations (through the command seam → gateway SDK) ----

  /**
   * Move a card to a new lane (drag→transition). Applies the move OPTIMISTICALLY,
   * then persists via the command client; on failure the optimistic override is
   * reverted. A live event (or the success) reconciles against the gateway.
   *
   * @param taskId - The card moved.
   * @param fromLane - The lane it came from.
   * @param toLane - The lane it was dropped into.
   * @returns The command result (so the caller can toast).
   */
  async move(
    taskId: string,
    fromLane: AgentLifecycleLane,
    toLane: AgentLifecycleLane,
  ): Promise<CommandResult<CommandData>> {
    // Optimistic stamp.
    this.#laneOverride = { ...this.#laneOverride, [taskId]: toLane };
    const result = await this.#deps.commands.move({ taskId, fromLane, toLane });
    if (!result.ok) {
      // Revert.
      const next = { ...this.#laneOverride };
      delete next[taskId];
      this.#laneOverride = next;
    }
    return result;
  }

  /**
   * Dispatch a worker for a card (Conductor). On success the card is
   * optimistically moved to the Running lane; the live worker stream attaches.
   *
   * @param taskId - The card to spawn a worker for.
   * @param tier - The spawn tier.
   * @returns The command result.
   */
  async dispatch(taskId: string, tier: 0 | 1 | 2): Promise<CommandResult<CommandData>> {
    const result = await this.#deps.commands.dispatch({ taskId, tier });
    if (result.ok) {
      this.#laneOverride = { ...this.#laneOverride, [taskId]: 'running' };
    }
    return result;
  }

  /**
   * Create a new task (Conductor add). On success the board re-hydrates so the
   * new card appears in its resolved lane.
   *
   * @param cmd - The create command.
   * @returns The command result.
   */
  async create(cmd: CreateCommand): Promise<CommandResult<CommandData>> {
    const result = await this.#deps.commands.create(cmd);
    if (result.ok) await this.hydrate();
    return result;
  }

  /**
   * Patch fields on a task (status / priority / assignee / title). Re-hydrates
   * on success so the change is reflected authoritatively.
   *
   * @param taskId - The task to patch.
   * @param fields - The fields to change.
   * @returns The command result.
   */
  async patch(
    taskId: string,
    fields: {
      title?: string;
      status?: TaskStatus;
      priority?: TaskPriority;
      assignee?: string | null;
    },
  ): Promise<CommandResult<CommandData>> {
    const result = await this.#deps.commands.patch({ taskId, ...fields });
    if (result.ok) await this.hydrate();
    return result;
  }

  /**
   * Delete a task. Re-hydrates on success.
   *
   * @param taskId - The task to delete.
   * @returns The command result.
   */
  async remove(taskId: string): Promise<CommandResult<CommandData>> {
    const result = await this.#deps.commands.remove(taskId);
    if (result.ok) await this.hydrate();
    return result;
  }
}

/**
 * Create a {@link SagaBoardStore}. The ergonomic entry point a route uses.
 *
 * @param deps - Optional injectable seam deps (default to the HTTP/gateway impls).
 * @returns A fresh reactive saga-board store.
 *
 * @example
 * ```ts
 * // in a +page.svelte $effect:
 * const board = createSagaBoard();
 * $effect(() => {
 *   void board.hydrate();
 *   board.connect();
 *   return () => board.disconnect();
 * });
 * ```
 */
export function createSagaBoard(deps?: SagaBoardDeps): SagaBoardStore {
  return new SagaBoardStore(deps);
}
