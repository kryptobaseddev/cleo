/**
 * Tests for the saga-board RUNE store (T11789 · E2-STUDIO-DATA-LAYER).
 *
 * Exercises the reactive store with injected in-memory seam fakes (DIP — no
 * `fetch`, no `EventSource`). `$derived` getters are read inside an
 * `$effect.root` so the rune reactivity graph is established (reading a derived
 * outside a reactive root in node is unsupported), and `flushSync` forces the
 * derived to recompute after a mutation.
 *
 * @task T11789
 * @epic T11557
 */

import { flushSync } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { createSagaBoard } from '../saga-board.svelte.js';
import type {
  BoardCommandClient,
  BoardEvent,
  BoardHydrator,
  BoardSnapshotRow,
  BoardSubscriptionFactory,
  BoardSubscriptionHandlers,
  CommandData,
  CommandResult,
} from '../saga-board-client.js';

/** A static hydrator returning a fixed snapshot. */
function staticHydrator(rows: BoardSnapshotRow[], activeWorkerIds: string[] = []): BoardHydrator {
  return { hydrate: async () => ({ rows, activeWorkerIds }) };
}

/** A command client whose methods all resolve ok with the given via. */
function okCommands(): BoardCommandClient {
  const ok = (taskId: string): CommandResult<CommandData> => ({
    ok: true,
    data: { taskId, via: 'gateway' },
  });
  return {
    move: vi.fn(async (c) => ok(c.taskId)),
    dispatch: vi.fn(async (c) => ok(c.taskId)),
    create: vi.fn(async () => ok('Tnew')),
    patch: vi.fn(async (c) => ok(c.taskId)),
    remove: vi.fn(async (id) => ok(id)),
  };
}

/** A command client whose move() always fails (drives revert). */
function failingMove(): BoardCommandClient {
  const base = okCommands();
  base.move = vi.fn(async () => ({ ok: false, code: 'E_REJECTED', message: 'nope' }));
  return base;
}

/** A subscription factory exposing the captured handlers for manual emit. */
function captureSubscription(): {
  factory: BoardSubscriptionFactory;
  emit(event: BoardEvent): void;
  setConnected(v: boolean): void;
  closed(): boolean;
} {
  let handlers: BoardSubscriptionHandlers | null = null;
  let isClosed = false;
  return {
    factory: (h) => {
      handlers = h;
      return {
        close() {
          isClosed = true;
        },
      };
    },
    emit: (event) => handlers?.onEvent(event),
    setConnected: (v) => handlers?.onConnectionChange?.(v),
    closed: () => isClosed,
  };
}

const ROW = (id: string, status: BoardSnapshotRow['status']): BoardSnapshotRow => ({
  id,
  title: `Task ${id}`,
  status,
  priority: 'medium',
  size: null,
  parentId: null,
  verificationJson: null,
});

describe('SagaBoardStore', () => {
  it('hydrates once and buckets rows into agent-lifecycle lanes', async () => {
    const board = createSagaBoard({
      hydrator: staticHydrator([ROW('T1', 'pending'), ROW('T2', 'active')], ['T2']),
      commands: okCommands(),
      subscriptionFactory: captureSubscription().factory,
    });

    await board.hydrate();

    const cleanup = $effect.root(() => {
      flushSync();
      // T1 pending → backlog/ready; T2 active+worker → running.
      const running = board.columns.find((c) => c.lane.id === 'running');
      const ids = board.cards.map((c) => c.id).sort();
      expect(ids).toEqual(['T1', 'T2']);
      expect(running?.cards.map((c) => c.id)).toContain('T2');
      expect(board.total).toBe(2);
      expect(board.runningCount).toBe(1);
    });
    cleanup();
  });

  it('excludes archived + proposed tasks from the board', async () => {
    const board = createSagaBoard({
      hydrator: staticHydrator([
        ROW('T1', 'pending'),
        ROW('T2', 'archived'),
        ROW('T3', 'proposed'),
      ]),
      commands: okCommands(),
      subscriptionFactory: captureSubscription().factory,
    });

    await board.hydrate();

    const cleanup = $effect.root(() => {
      flushSync();
      expect(board.cards.map((c) => c.id)).toEqual(['T1']);
    });
    cleanup();
  });

  it('move() optimistically overrides the lane and keeps it on success', async () => {
    const commands = okCommands();
    const board = createSagaBoard({
      hydrator: staticHydrator([ROW('T1', 'pending')]),
      commands,
      subscriptionFactory: captureSubscription().factory,
    });
    await board.hydrate();

    const result = await board.move('T1', 'ready', 'running');

    expect(result.ok).toBe(true);
    expect(commands.move).toHaveBeenCalledWith({
      taskId: 'T1',
      fromLane: 'ready',
      toLane: 'running',
    });
    const cleanup = $effect.root(() => {
      flushSync();
      const running = board.columns.find((c) => c.lane.id === 'running');
      expect(running?.cards.map((c) => c.id)).toContain('T1');
    });
    cleanup();
  });

  it('move() reverts the optimistic override on a command failure', async () => {
    const board = createSagaBoard({
      hydrator: staticHydrator([ROW('T1', 'pending')]),
      commands: failingMove(),
      subscriptionFactory: captureSubscription().factory,
    });
    await board.hydrate();

    const result = await board.move('T1', 'ready', 'running');

    expect(result.ok).toBe(false);
    const cleanup = $effect.root(() => {
      flushSync();
      const running = board.columns.find((c) => c.lane.id === 'running');
      // Reverted — T1 is no longer in running (it falls back to its resolved lane).
      expect(running?.cards.map((c) => c.id) ?? []).not.toContain('T1');
    });
    cleanup();
  });

  it('a live event re-hydrates the board (the poll replacement)', async () => {
    const hydrate = vi.fn(async () => ({ rows: [ROW('T1', 'pending')], activeWorkerIds: [] }));
    const sub = captureSubscription();
    const board = createSagaBoard({
      hydrator: { hydrate },
      commands: okCommands(),
      subscriptionFactory: sub.factory,
    });

    await board.hydrate();
    expect(hydrate).toHaveBeenCalledTimes(1);

    board.connect();
    sub.emit({ event: 'updated' });
    // The live event triggers a second hydration.
    await vi.waitFor(() => expect(hydrate).toHaveBeenCalledTimes(2));
  });

  it('connect()/disconnect() open and close exactly one subscription', () => {
    const sub = captureSubscription();
    const board = createSagaBoard({
      hydrator: staticHydrator([]),
      commands: okCommands(),
      subscriptionFactory: sub.factory,
    });

    board.connect();
    sub.setConnected(true);
    const cleanupA = $effect.root(() => {
      flushSync();
      expect(board.connected).toBe(true);
    });
    cleanupA();

    board.disconnect();
    expect(sub.closed()).toBe(true);
    const cleanupB = $effect.root(() => {
      flushSync();
      expect(board.connected).toBe(false);
    });
    cleanupB();
  });

  it('dispatch() moves the card to running on success', async () => {
    const commands = okCommands();
    const board = createSagaBoard({
      hydrator: staticHydrator([ROW('T1', 'pending')]),
      commands,
      subscriptionFactory: captureSubscription().factory,
    });
    await board.hydrate();

    const result = await board.dispatch('T1', 1);

    expect(result.ok).toBe(true);
    expect(commands.dispatch).toHaveBeenCalledWith({ taskId: 'T1', tier: 1 });
    const cleanup = $effect.root(() => {
      flushSync();
      const running = board.columns.find((c) => c.lane.id === 'running');
      expect(running?.cards.map((c) => c.id)).toContain('T1');
    });
    cleanup();
  });
});
