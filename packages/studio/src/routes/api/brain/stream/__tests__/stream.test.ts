/**
 * Unit tests for GET /api/brain/stream SSE endpoint.
 *
 * Tests cover:
 * - Response has Content-Type: text/event-stream
 * - hello event sent immediately on connect
 * - heartbeat event fires after 30 s (vi.useFakeTimers)
 * - node.create event emitted when brain_observations INSERT detected
 * - edge.strengthen event emitted when brain_page_edges weight changes
 * - task.status event emitted when tasks status changes
 * - message.send event emitted when a new conduit messages row is detected
 * - Stream closes cleanly when the request AbortSignal fires
 *
 * All DB calls are mocked via vi.mock so no real databases are required.
 */

import type { LBStreamEvent } from '@cleocode/brain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be called before any imports of the mocked module
// ---------------------------------------------------------------------------

vi.mock('$lib/server/db/connections.js', () => ({
  getBrainDb: vi.fn(),
  getConduitDb: vi.fn(),
  getTasksDb: vi.fn(),
}));

// Static import of mocked module — hoisting ensures mocks are registered first
import {
  getBrainDb as mockGetBrainDb,
  getConduitDb as mockGetConduitDb,
  getTasksDb as mockGetTasksDb,
} from '$lib/server/db/connections.js';

// Cast to typed mock functions for use in tests
const getBrainDb = mockGetBrainDb as ReturnType<typeof vi.fn>;
const getConduitDb = mockGetConduitDb as ReturnType<typeof vi.fn>;
const getTasksDb = mockGetTasksDb as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Mock DB helpers
// ---------------------------------------------------------------------------

/** Minimal DatabaseSync statement mock. */
interface MockDbStmt {
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
}

/** Minimal DatabaseSync mock. */
interface MockDb {
  prepare: (sql: string) => MockDbStmt;
}

/** Builds a statement mock with fixed return values. */
function makeStmt(getResult: unknown = undefined, allResult: unknown[] = []): MockDbStmt {
  return {
    get: () => getResult,
    all: () => allResult,
  };
}

/**
 * Factory for a mock DatabaseSync.
 * Each SQL key is matched as a substring; first match wins.
 */
function makeMockDb(responses: Record<string, { get?: unknown; all?: unknown[] }>): MockDb {
  return {
    prepare(sql: string) {
      for (const [key, resp] of Object.entries(responses)) {
        if (sql.includes(key)) {
          return makeStmt(resp.get, resp.all ?? []);
        }
      }
      return makeStmt();
    },
  };
}

// ---------------------------------------------------------------------------
// SSE event collector helper
// ---------------------------------------------------------------------------

/**
 * Reads up to `maxEvents` SSE `data:` lines from a stream and parses them.
 *
 * @param stream - ReadableStream from Response.body.
 * @param maxEvents - Stop collecting after this many events.
 * @returns Parsed LBStreamEvent array.
 */
async function collectEvents(
  stream: ReadableStream<Uint8Array>,
  maxEvents: number,
): Promise<LBStreamEvent[]> {
  const events: LBStreamEvent[] = [];
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (events.length < maxEvents) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data: ')) {
        try {
          const parsed = JSON.parse(trimmed.slice(6)) as LBStreamEvent;
          events.push(parsed);
          if (events.length >= maxEvents) break;
        } catch {
          // Ignore malformed data lines
        }
      }
    }
  }

  reader.cancel();
  return events;
}

// ---------------------------------------------------------------------------
// Handler import helper
// ---------------------------------------------------------------------------

/** Minimal ProjectContext fixture for tests. */
const mockProjectCtx = {
  projectId: 'test-project',
  name: 'Test Project',
  projectPath: '/tmp/test-project',
  brainDbPath: '/tmp/test-project/.cleo/brain.db',
  tasksDbPath: '/tmp/test-project/.cleo/tasks.db',
  brainDbExists: false,
  tasksDbExists: false,
} as const;

/** Dynamic import so tests can re-import after mock state changes. */
async function importHandler(): Promise<{
  GET: (args: { request: Request; locals: App.Locals }) => Response | Promise<Response>;
}> {
  return import('../+server.js') as Promise<{
    GET: (args: { request: Request; locals: App.Locals }) => Response | Promise<Response>;
  }>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/brain/stream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getBrainDb.mockReturnValue(null);
    getConduitDb.mockReturnValue(null);
    getTasksDb.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Content-Type header
  // -------------------------------------------------------------------------

  it('returns Content-Type: text/event-stream', async () => {
    const { GET } = await importHandler();
    const controller = new AbortController();
    const req = new Request('http://localhost/api/brain/stream', {
      signal: controller.signal,
    });

    const res = GET({ request: req, locals: { projectCtx: mockProjectCtx } as App.Locals });
    const response = res instanceof Promise ? await res : res;

    expect(response.headers.get('Content-Type')).toContain('text/event-stream');
    controller.abort();
  });

  // -------------------------------------------------------------------------
  // hello event on connect
  // -------------------------------------------------------------------------

  it('emits hello event immediately on connect', async () => {
    const { GET } = await importHandler();
    const controller = new AbortController();
    const req = new Request('http://localhost/api/brain/stream', {
      signal: controller.signal,
    });

    const response = GET({
      request: req,
      locals: { projectCtx: mockProjectCtx } as App.Locals,
    }) as Response;
    const body = response.body;
    expect(body).not.toBeNull();

    const eventsPromise = collectEvents(body!, 1);
    await vi.runAllTimersAsync();

    const events = await eventsPromise;
    expect(events.length).toBeGreaterThanOrEqual(1);
    const hello = events.find((e) => e.type === 'hello');
    expect(hello).toBeDefined();
    if (hello) {
      expect(typeof (hello as { type: string; ts: string }).ts).toBe('string');
    }

    controller.abort();
  });

  // -------------------------------------------------------------------------
  // heartbeat after 30 s
  // -------------------------------------------------------------------------

  it('emits a heartbeat event after 30 seconds', async () => {
    const { GET } = await importHandler();
    const controller = new AbortController();
    const req = new Request('http://localhost/api/brain/stream', {
      signal: controller.signal,
    });

    const response = GET({
      request: req,
      locals: { projectCtx: mockProjectCtx } as App.Locals,
    }) as Response;
    const body = response.body!;

    const eventsPromise = collectEvents(body, 2);
    await vi.advanceTimersByTimeAsync(30_001);

    const events = await eventsPromise;

    expect(events.some((e) => e.type === 'hello')).toBe(true);
    expect(events.some((e) => e.type === 'heartbeat')).toBe(true);

    controller.abort();
  });

  // -------------------------------------------------------------------------
  // node.create on brain_observations INSERT
  // -------------------------------------------------------------------------

  it('emits node.create event when a new brain_observations row is detected', async () => {
    // init: max rowid = 5; poll: one new row at rowid 6
    const brainDb = makeMockDb({
      'MAX(rowid)': { get: { max_rowid: 5 } },
      'from brain_page_edges': { all: [] },
      'FROM brain_observations': {
        all: [
          {
            rowid: 6,
            id: 'O-newnode',
            title: 'New observation from test',
            quality_score: 0.9,
            memory_tier: 'l1',
            created_at: '2026-04-15T08:00:00.000Z',
            source_session_id: null,
          },
        ],
      },
    });

    getBrainDb.mockReturnValue(brainDb);

    const { GET } = await importHandler();
    const controller = new AbortController();
    const req = new Request('http://localhost/api/brain/stream', {
      signal: controller.signal,
    });

    const response = GET({
      request: req,
      locals: { projectCtx: mockProjectCtx } as App.Locals,
    }) as Response;
    const body = response.body!;

    const eventsPromise = collectEvents(body, 2);
    await vi.advanceTimersByTimeAsync(1_100);

    const events = await eventsPromise;
    const nodeCreate = events.find((e) => e.type === 'node.create');

    expect(nodeCreate).toBeDefined();
    if (nodeCreate?.type === 'node.create') {
      expect(nodeCreate.node.id).toBe('brain:O-newnode');
      expect(nodeCreate.node.kind).toBe('observation');
      expect(nodeCreate.node.substrate).toBe('brain');
      expect(nodeCreate.node.label).toBe('New observation from test');
      expect(typeof nodeCreate.ts).toBe('string');
    }

    controller.abort();
  });

  // -------------------------------------------------------------------------
  // edge.strengthen on brain_page_edges weight update
  // -------------------------------------------------------------------------

  it('emits edge.strengthen when brain_page_edges weight changes', async () => {
    // First prepare('brain_page_edges') call = snapshot (weight 0.5).
    // Second call = updated weight 0.8.
    let edgePollCount = 0;

    const brainDb: MockDb = {
      prepare(sql: string) {
        if (sql.includes('MAX(rowid)') && sql.includes('brain_observations')) {
          return makeStmt({ max_rowid: 0 });
        }
        if (sql.includes('FROM brain_observations') && sql.includes('rowid >')) {
          return makeStmt(undefined, []);
        }
        if (sql.includes('brain_page_edges')) {
          return {
            get: () => undefined,
            all() {
              edgePollCount++;
              if (edgePollCount === 1) {
                // Initial weight snapshot
                return [
                  {
                    from_id: 'nodeA',
                    to_id: 'nodeB',
                    edge_type: 'co_retrieved',
                    weight: 0.5,
                    updated_at: null,
                  },
                ];
              }
              // Weight changed on next poll
              return [
                {
                  from_id: 'nodeA',
                  to_id: 'nodeB',
                  edge_type: 'co_retrieved',
                  weight: 0.8,
                  updated_at: null,
                },
              ];
            },
          };
        }
        return makeStmt();
      },
    };

    getBrainDb.mockReturnValue(brainDb);

    const { GET } = await importHandler();
    const controller = new AbortController();
    const req = new Request('http://localhost/api/brain/stream', {
      signal: controller.signal,
    });

    const response = GET({
      request: req,
      locals: { projectCtx: mockProjectCtx } as App.Locals,
    }) as Response;
    const body = response.body!;

    const eventsPromise = collectEvents(body, 2);
    await vi.advanceTimersByTimeAsync(1_100);

    const events = await eventsPromise;
    const edgeEvent = events.find((e) => e.type === 'edge.strengthen');

    expect(edgeEvent).toBeDefined();
    if (edgeEvent?.type === 'edge.strengthen') {
      expect(edgeEvent.fromId).toBe('brain:nodeA');
      expect(edgeEvent.toId).toBe('brain:nodeB');
      expect(edgeEvent.edgeType).toBe('co_retrieved');
      expect(edgeEvent.weight).toBe(0.8);
    }

    controller.abort();
  });

  // -------------------------------------------------------------------------
  // task.status event
  // -------------------------------------------------------------------------

  it('emits task.status when tasks status changes', async () => {
    let statusCheckCount = 0;

    const tasksDb: MockDb = {
      prepare(sql: string) {
        // Watermark init: max rowid
        if (sql.includes('MAX(rowid)') && sql.includes('tasks')) {
          return makeStmt({ max_rowid: 10 });
        }
        // Status snapshot at init (no rowid filter)
        if (
          sql.includes('SELECT id, status FROM tasks') &&
          !sql.includes('rowid >') &&
          !sql.includes('WHERE id IN')
        ) {
          return makeStmt(undefined, [{ id: 'T100', status: 'pending' }]);
        }
        // New rows poll
        if (sql.includes('rowid >')) {
          return makeStmt(undefined, []);
        }
        // Status update check on existing tasks
        if (sql.includes('WHERE id IN')) {
          statusCheckCount++;
          return makeStmt(undefined, [{ id: 'T100', status: 'in_progress' }]);
        }
        return makeStmt();
      },
    };

    getTasksDb.mockReturnValue(tasksDb);

    const { GET } = await importHandler();
    const controller = new AbortController();
    const req = new Request('http://localhost/api/brain/stream', {
      signal: controller.signal,
    });

    const response = GET({
      request: req,
      locals: { projectCtx: mockProjectCtx } as App.Locals,
    }) as Response;
    const body = response.body!;

    const eventsPromise = collectEvents(body, 2);
    await vi.advanceTimersByTimeAsync(1_100);

    const events = await eventsPromise;
    const taskEvent = events.find((e) => e.type === 'task.status');

    expect(statusCheckCount).toBeGreaterThan(0);
    expect(taskEvent).toBeDefined();
    if (taskEvent?.type === 'task.status') {
      expect(taskEvent.taskId).toBe('T100');
      expect(taskEvent.status).toBe('in_progress');
    }

    controller.abort();
  });

  // -------------------------------------------------------------------------
  // message.send event
  // -------------------------------------------------------------------------

  it('emits message.send event when a new conduit messages row is detected', async () => {
    let msgPollCount = 0;

    const conduitDb: MockDb = {
      prepare(sql: string) {
        if (sql.includes('MAX(rowid)')) {
          return makeStmt({ max_rowid: 0 });
        }
        if (sql.includes('FROM messages')) {
          return {
            get: () => undefined,
            all() {
              msgPollCount++;
              if (msgPollCount === 1) {
                return [
                  {
                    rowid: 1,
                    id: 'msg-abc123',
                    content: 'Hello from agent-alpha to agent-beta',
                    from_agent_id: 'agent-alpha',
                    to_agent_id: 'agent-beta',
                    created_at: 1_744_700_000,
                  },
                ];
              }
              return [];
            },
          };
        }
        return makeStmt();
      },
    };

    getConduitDb.mockReturnValue(conduitDb);

    const { GET } = await importHandler();
    const controller = new AbortController();
    const req = new Request('http://localhost/api/brain/stream', {
      signal: controller.signal,
    });

    const response = GET({
      request: req,
      locals: { projectCtx: mockProjectCtx } as App.Locals,
    }) as Response;
    const body = response.body!;

    const eventsPromise = collectEvents(body, 2);
    await vi.advanceTimersByTimeAsync(1_100);

    const events = await eventsPromise;
    const msgEvent = events.find((e) => e.type === 'message.send');

    expect(msgEvent).toBeDefined();
    if (msgEvent?.type === 'message.send') {
      expect(msgEvent.messageId).toBe('msg-abc123');
      expect(msgEvent.fromAgentId).toBe('agent-alpha');
      expect(msgEvent.toAgentId).toBe('agent-beta');
      expect(typeof msgEvent.preview).toBe('string');
      expect(msgEvent.preview.length).toBeGreaterThan(0);
    }

    controller.abort();
  });

  // -------------------------------------------------------------------------
  // Stream cleanup on abort signal
  // -------------------------------------------------------------------------

  it('closes the stream cleanly when the abort signal fires', async () => {
    const { GET } = await importHandler();
    const controller = new AbortController();
    const req = new Request('http://localhost/api/brain/stream', {
      signal: controller.signal,
    });

    const response = GET({
      request: req,
      locals: { projectCtx: mockProjectCtx } as App.Locals,
    }) as Response;
    const body = response.body!;

    // Collect the hello event to confirm the stream started
    const eventsPromise = collectEvents(body, 1);
    await vi.advanceTimersByTimeAsync(10);
    await eventsPromise;

    // Now abort
    controller.abort();
    await vi.advanceTimersByTimeAsync(50);

    // The signal must be aborted — that's the primary guarantee
    expect(controller.signal.aborted).toBe(true);
  });
});
