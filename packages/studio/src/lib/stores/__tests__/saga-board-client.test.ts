/**
 * Tests for the saga-board SOLID seam (T11790 · E2-STUDIO-DATA-LAYER).
 *
 * Covers the pure, framework-free command-client / subscription / hydration
 * surface — no runes, no DOM. The rune store ({@link
 * import('../saga-board.svelte.js')}) composing these is exercised in its own
 * `$effect.root`-wrapped test.
 *
 * @task T11790
 * @epic T11557
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  eventSourceBoardSubscriptionFactory,
  httpBoardCommandClient,
  httpBoardHydrator,
} from '../saga-board-client.js';

/** Build a `fetch` stub returning a fixed JSON envelope + status. */
function fetchStub(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
}

describe('httpBoardCommandClient', () => {
  it('move() POSTs the transition route and narrows a success envelope', async () => {
    const fetchImpl = fetchStub(200, { success: true, data: { taskId: 'T1', via: 'gateway' } });
    const client = httpBoardCommandClient(fetchImpl);

    const result = await client.move({ taskId: 'T1', fromLane: 'ready', toLane: 'running' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.taskId).toBe('T1');
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/tasks/T1/transition',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('move() narrows a failure envelope to a tagged error (never throws)', async () => {
    const fetchImpl = fetchStub(422, {
      success: false,
      error: { code: 'E_INVALID_TRANSITION', message: 'Cannot drag into Done' },
    });
    const client = httpBoardCommandClient(fetchImpl);

    const result = await client.move({ taskId: 'T1', fromLane: 'ready', toLane: 'done' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('E_INVALID_TRANSITION');
      expect(result.message).toBe('Cannot drag into Done');
    }
  });

  it('dispatch() POSTs the dispatch route with the tier', async () => {
    const fetchImpl = fetchStub(200, { success: true, data: { taskId: 'T2' } });
    const client = httpBoardCommandClient(fetchImpl);

    await client.dispatch({ taskId: 'T2', tier: 2 });

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('/api/tasks/T2/dispatch');
    expect(JSON.parse(call[1].body as string)).toEqual({ tier: 2 });
  });

  it('create() POSTs the collection route', async () => {
    const fetchImpl = fetchStub(200, { success: true, data: { taskId: 'T9' } });
    const client = httpBoardCommandClient(fetchImpl);

    await client.create({ title: 'New', acceptance: ['ac1'] } as never);

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('/api/tasks');
    expect(call[1].method).toBe('POST');
  });

  it('patch() PATCHes the [id] route with only the changed fields', async () => {
    const fetchImpl = fetchStub(200, { success: true, data: { taskId: 'T3' } });
    const client = httpBoardCommandClient(fetchImpl);

    await client.patch({ taskId: 'T3', status: 'done' });

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('/api/tasks/T3');
    expect(call[1].method).toBe('PATCH');
    expect(JSON.parse(call[1].body as string)).toEqual({ status: 'done' });
  });

  it('remove() DELETEs the [id] route', async () => {
    const fetchImpl = fetchStub(200, { success: true, data: { taskId: 'T4' } });
    const client = httpBoardCommandClient(fetchImpl);

    await client.remove('T4');

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('/api/tasks/T4');
    expect(call[1].method).toBe('DELETE');
  });

  it('returns a tagged network error when fetch rejects', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const client = httpBoardCommandClient(fetchImpl);

    const result = await client.move({ taskId: 'T1', fromLane: 'a', toLane: 'b' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('E_NETWORK');
  });
});

describe('httpBoardHydrator', () => {
  it('projects /api/tasks rows + active views into a board snapshot', async () => {
    const body = {
      tasks: [
        {
          id: 'T1',
          title: 'One',
          status: 'active',
          priority: 'high',
          size: null,
          parent_id: 'E1',
          verification_json: null,
        },
        {
          id: 'T2',
          title: 'Two',
          status: 'pending',
          priority: 'low',
          size: 'small',
          parent_id: null,
          verification_json: null,
        },
      ],
      rollups: [],
      views: [
        { id: 'T1', status: 'active', nextAction: 'no-action' },
        { id: 'T2', status: 'pending', nextAction: 'spawn-worker' },
      ],
      total: 2,
    };
    const hydrator = httpBoardHydrator(fetchStub(200, body));

    const { rows, activeWorkerIds } = await hydrator.hydrate();

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'T1', parentId: 'E1', status: 'active' });
    // Only the active task surfaces as a running worker.
    expect(activeWorkerIds).toEqual(['T1']);
  });

  it('throws on a non-2xx snapshot fetch', async () => {
    const hydrator = httpBoardHydrator(fetchStub(503, { error: 'tasks.db unavailable' }));
    await expect(hydrator.hydrate()).rejects.toThrow(/Failed to hydrate/);
  });
});

describe('eventSourceBoardSubscriptionFactory', () => {
  const originalEventSource = globalThis.EventSource;

  afterEach(() => {
    // Restore whatever EventSource was (likely undefined in node).
    (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
  });

  it('returns a no-op handle when EventSource is unavailable (SSR guard)', () => {
    (globalThis as { EventSource?: unknown }).EventSource = undefined;
    const factory = eventSourceBoardSubscriptionFactory();
    const onEvent = vi.fn();
    const sub = factory({ onEvent });
    expect(onEvent).not.toHaveBeenCalled();
    expect(() => sub.close()).not.toThrow();
  });

  it('decodes a GatewayStreamEvent data frame into a board event', () => {
    // Minimal fake EventSource capturing handlers + exposing an emit helper.
    class FakeEventSource {
      onmessage: ((e: MessageEvent<string>) => void) | null = null;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readonly url: string;
      constructor(url: string) {
        this.url = url;
      }
      close(): void {}
    }
    const instances: FakeEventSource[] = [];
    (globalThis as { EventSource?: unknown }).EventSource = class extends FakeEventSource {
      constructor(url: string) {
        super(url);
        instances.push(this);
      }
    };

    const factory = eventSourceBoardSubscriptionFactory('E1');
    const onEvent = vi.fn();
    const onConnectionChange = vi.fn();
    factory({ onEvent, onConnectionChange });

    expect(instances).toHaveLength(1);
    expect(instances[0].url).toBe('/api/tasks/subscribe?root=E1');

    // Open → connected.
    instances[0].onopen?.();
    expect(onConnectionChange).toHaveBeenCalledWith(true);

    // A canonical data frame → a board event carrying the payload + seq.
    instances[0].onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify({
          kind: 'data',
          seq: 3,
          data: { scope: 'tasks.board', event: 'updated', root: 'E1' },
          requestId: 'r1',
        }),
      }),
    );
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'updated', seq: 3 }));

    // A done frame → disconnected.
    instances[0].onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify({ kind: 'done', seq: 4, data: {}, requestId: 'r1' }),
      }),
    );
    expect(onConnectionChange).toHaveBeenCalledWith(false);
  });
});
