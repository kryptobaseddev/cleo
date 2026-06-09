/**
 * Tests for the cockpit's dispatch action + live worker-stream wiring at the
 * component level (T11935 dispatch · T11936 SSE).
 *
 * Drives the exported {@link KanbanBoardComponent} directly with INJECTED
 * dispatch + subscribe functions (the same seams `runCockpit` wires) so the
 * confirm-gate, the Running-lane transition, the inline-error surface, and the
 * SSE subscribe/unsubscribe lifecycle are all exercised with NO daemon, NO
 * socket, and NO pi-tui.
 *
 * @task T11935
 * @task T11936
 * @epic T11916
 */

import type { GatewayStreamEvent } from '@cleocode/contracts/gateway';
import { describe, expect, it, vi } from 'vitest';
import { type DispatchFn, KanbanBoardComponent, type SubscribeFn } from '../cockpit.js';
import { buildKanbanBoard, type TuiTaskRow } from '../kanban-board.js';

const BASE = 'http://127.0.0.1:7777';

/** A no-op SSE subscribe (no frames). */
const noopSubscribe: SubscribeFn = () => ({ unsubscribe: () => {} });

/** A dispatch fn that always succeeds. */
const okDispatch: DispatchFn = async (_baseUrl, taskId, tier) => ({
  ok: true,
  taskId,
  tier,
  data: {},
});

/** Build a component over the given rows with injected deps. */
function makeComponent(
  rows: TuiTaskRow[],
  deps: { dispatch?: DispatchFn; subscribe?: SubscribeFn } = {},
): KanbanBoardComponent {
  return new KanbanBoardComponent(buildKanbanBoard(rows), {
    baseUrl: BASE,
    dispatch: deps.dispatch ?? okDispatch,
    subscribe: deps.subscribe ?? noopSubscribe,
  });
}

/** Rows that land in the Ready lane (pending + deps met + spawn-worker hint). */
const READY_ROW: TuiTaskRow = {
  id: 'TR1',
  title: 'ready one',
  status: 'pending',
  nextAction: 'spawn-worker',
};
/** A Running-lane row (active worker). */
const RUNNING_ROW: TuiTaskRow = { id: 'TX1', title: 'running one', status: 'active' };

describe('KanbanBoardComponent dispatch — confirm gate (T11935 · AC1/AC3)', () => {
  it('first dispatch key latches a confirm prompt, does NOT spawn', async () => {
    const dispatch = vi.fn(okDispatch);
    const c = makeComponent([READY_ROW], { dispatch });
    // Focus the Ready lane (index 1 in canonical order).
    c.focusNextLane();
    expect(c.focusedLaneId()).toBe('ready');

    await c.requestDispatch();
    expect(c.isConfirming()).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    expect(c.statusLine()).toContain('Press [d] again');
  });

  it('second dispatch key spawns through the injected SDK dispatch fn', async () => {
    const dispatch = vi.fn(okDispatch);
    const c = makeComponent([READY_ROW], { dispatch });
    c.focusNextLane();
    await c.requestDispatch(); // confirm
    await c.requestDispatch(); // spawn
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(BASE, 'TR1', 1);
    expect(c.statusLine()).toContain('→ Running');
  });

  it('cycles the spawn tier and dispatches with it', async () => {
    const dispatch = vi.fn(okDispatch);
    const c = makeComponent([READY_ROW], { dispatch });
    c.focusNextLane();
    c.cycleTier(); // 1 → 2
    expect(c.currentTier()).toBe(2);
    await c.requestDispatch();
    await c.requestDispatch();
    expect(dispatch).toHaveBeenCalledWith(BASE, 'TR1', 2);
  });

  it('refuses dispatch on a non-dispatchable lane (Running) and never spawns', async () => {
    const dispatch = vi.fn(okDispatch);
    const c = makeComponent([RUNNING_ROW], { dispatch });
    c.focusNextLane();
    c.focusNextLane(); // → running
    expect(c.focusedLaneId()).toBe('running');
    await c.requestDispatch();
    expect(dispatch).not.toHaveBeenCalled();
    expect(c.statusLine()).toContain('Backlog/Ready');
  });

  it('cancelConfirm clears the latch without spawning', async () => {
    const dispatch = vi.fn(okDispatch);
    const c = makeComponent([READY_ROW], { dispatch });
    c.focusNextLane();
    await c.requestDispatch(); // confirm
    c.cancelConfirm();
    expect(c.isConfirming()).toBe(false);
    await c.requestDispatch(); // back to confirm, not spawn
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('KanbanBoardComponent dispatch — inline error surface (T11935 · AC3)', () => {
  it('renders a dispatch failure on the status line, never throws', async () => {
    const failing: DispatchFn = async (_b, taskId) => ({
      ok: false,
      taskId,
      code: 'E_GATEWAY_UNREACHABLE',
      message: 'daemon down',
    });
    const c = makeComponent([READY_ROW], { dispatch: failing });
    c.focusNextLane();
    await c.requestDispatch(); // confirm
    await expect(c.requestDispatch()).resolves.toBeUndefined(); // spawn — no throw
    expect(c.statusLine()).toContain('E_GATEWAY_UNREACHABLE');
    expect(c.statusLine()).toContain('daemon down');
  });

  it('the dispatch result + confirm prompt are rendered in the board body', async () => {
    const c = makeComponent([READY_ROW]);
    c.focusNextLane();
    await c.requestDispatch();
    const body = c.render(80).join('\n');
    expect(body).toContain('Conductor:'); // role lane for a dispatchable card
    expect(body).toContain('Press [d] again');
  });
});

describe('KanbanBoardComponent SSE worker panel (T11936)', () => {
  it('subscribes when a Running card gains focus and renders the panel', () => {
    const unsubscribe = vi.fn();
    let pushFrame: ((f: GatewayStreamEvent) => void) | null = null;
    const subscribe: SubscribeFn = (_opts, handlers) => {
      pushFrame = handlers.onFrame;
      return { unsubscribe };
    };
    const c = makeComponent([RUNNING_ROW], { subscribe });
    c.focusNextLane();
    c.focusNextLane(); // → running (subscribes)
    expect(typeof pushFrame).toBe('function');

    pushFrame?.({ kind: 'data', seq: 0, data: { line: 'building…' }, requestId: 'r' });
    const body = c.render(80).join('\n');
    expect(body).toContain('Worker TX1');
    expect(body).toContain('building…');
  });

  it('unsubscribes the previous stream when focus leaves the Running card', () => {
    const unsubscribe = vi.fn();
    const subscribe: SubscribeFn = () => ({ unsubscribe });
    const c = makeComponent([RUNNING_ROW], { subscribe });
    c.focusNextLane();
    c.focusNextLane(); // → running (subscribes)
    expect(unsubscribe).not.toHaveBeenCalled();
    c.focusNextLane(); // → review (blur → unsubscribe)
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('teardownWorkerPanel unsubscribes (used on quit)', () => {
    const unsubscribe = vi.fn();
    const subscribe: SubscribeFn = () => ({ unsubscribe });
    const c = makeComponent([RUNNING_ROW], { subscribe });
    c.focusNextLane();
    c.focusNextLane(); // → running (subscribes)
    c.teardownWorkerPanel();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does NOT subscribe for a non-Running focused card', () => {
    const subscribe = vi.fn(noopSubscribe);
    const c = makeComponent([READY_ROW], { subscribe });
    c.focusNextLane(); // → ready (not running)
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('surfaces an SSE error inline without crashing', () => {
    const subscribe: SubscribeFn = (_opts, handlers) => {
      handlers.onError?.('connection refused');
      return { unsubscribe: () => {} };
    };
    const c = makeComponent([RUNNING_ROW], { subscribe });
    c.focusNextLane();
    c.focusNextLane(); // → running (subscribes → immediate error)
    expect(c.statusLine()).toContain('connection refused');
  });
});
