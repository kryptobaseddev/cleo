/**
 * R3-T9 cross-transport regression smoke — the capstone of the R3 gateway
 * unification (SG-RUNTIME-UNIFICATION).
 *
 * Replays a set of GOLDEN gateway fixtures (derived from the R3-T1 baseline ops —
 * `transport-inventory.test.ts` — widened to span query + mutate across four
 * domains and all three `mcpExposed` ops) through EVERY gateway transport adapter
 * and asserts byte/semantic equality of the resulting LAFS `DispatchResponse`
 * envelopes:
 *
 *   - CLI   — the in-process {@link Dispatcher} (the production CLI path; the CLI
 *             adapter in `packages/cleo` is a thin wrapper over the SAME handler).
 *   - MCP   — `@cleocode/runtime/gateway/mcp` {@link callTool} → the LAFS envelope
 *             is serialized as the tool result's text content. Only the
 *             `mcpExposed` subset is reachable over MCP (default-deny); the
 *             non-exposed fixtures are asserted unreachable here and replayed via
 *             the other transports.
 *   - RPC   — `@cleocode/runtime/gateway/rpc` `encodeFrame`/`decodeLine` +
 *             {@link routeFrame} (the pure codec + routing path, no socket).
 *   - HTTP  — `@cleocode/runtime/gateway/http` {@link routeUnary} (unary) and the
 *             SSE `createSseStream` primitive (streaming envelope-as-frame).
 *
 * ## Why this proves "no behavior change"
 *
 * All four adapters route through ONE injected {@link GatewayHandler} (built with
 * `createGatewayHandler`) — exactly as production does. The adapters own ONLY
 * wire concerns (framing, status mapping, serialization); the dispatched envelope
 * is produced once, by the shared handler, and every transport must surface it
 * losslessly. The operation PAYLOAD (`data`, `success`, `error`, `page`,
 * `partial`) and the business `meta` MUST be byte-identical across transports.
 * The only LEGITIMATE per-transport difference is `meta.source` (each transport
 * stamps its own transport-of-origin, which the adapters FORCE for anti-spoofing)
 * and the trace-local fields (`requestId`, `duration_ms`, `timestamp`), which are
 * normalized out of the parity comparison and asserted separately.
 *
 * The handler is a deterministic stub keyed on real registered operations, so the
 * dispatcher's `resolve` + `validateRequiredParams` path is exercised faithfully
 * while the returned payload is fixed — isolating the transport layer as the
 * variable under test.
 *
 * @task T11453
 * @epic T11254
 * @saga T11243
 */

import type {
  DispatchRequest,
  DispatchResponse,
  DomainHandler,
  GatewayStreamEvent,
} from '@cleocode/contracts/gateway';
import {
  GATEWAY_RPC_PROTOCOL_VERSION,
  type GatewayRpcRequestFrame,
  type GatewayRpcResponseFrame,
} from '@cleocode/contracts/gateway/rpc';
import { describe, expect, it, vi } from 'vitest';

// The dispatcher imports `getLogger` / `getProjectRoot` from `@cleocode/core` at
// module load. Mock it (as the RPC/MCP adapter tests do) so the suite exercises
// the transport layer without spinning up the full core runtime.
vi.mock('@cleocode/core', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  getProjectRoot: () => process.cwd(),
}));

// T11640 — the RPC adapter binds connection→session via @cleocode/core/internal.
// Stub it (bind/unbind are no-ops, runWithConnectionHandle runs inline) so the
// parity suite stays off the full core runtime.
vi.mock('@cleocode/core/internal', () => ({
  bindConnectionSession: vi.fn(),
  unbindConnectionSession: vi.fn(),
  runWithConnectionHandle: <T>(_connId: string, fn: () => T): T => fn(),
}));

const { createGatewayHandler } = await import('../index.js');
type GatewayHandler = import('../index.js').GatewayHandler;
const { callTool } = await import('../mcp/server.js');
const { exposedOperations } = await import('../mcp/tools-list.js');
const { operationToToolName } = await import('../mcp/tool-naming.js');
const { decodeLine, encodeFrame } = await import('../rpc/codec.js');
const { routeFrame } = await import('../rpc/server.js');
const { routeUnary } = await import('../http/server.js');
const { createSseStream } = await import('../http/sse.js');

// ---------------------------------------------------------------------------
// Golden fixtures — real registered (gateway, domain, operation) triples
// ---------------------------------------------------------------------------

/**
 * One golden fixture: a gateway request plus the canonical envelope its handler
 * is pinned to produce. Derived from the R3-T1 baseline op set, widened to span
 * query + mutate across four domains and all three `mcpExposed` ops.
 */
interface GoldenFixture {
  /** Stable fixture id (used in test names + the stub handler key). */
  readonly id: string;
  /** CQRS gateway the operation lives under (must match the real registry). */
  readonly gateway: 'query' | 'mutate';
  /** Canonical domain (must match the real registry so `resolve` succeeds). */
  readonly domain: string;
  /** Dotted operation name (must match the real registry). */
  readonly operation: string;
  /** Request params satisfying the operation's `requiredParams`. */
  readonly params: Record<string, unknown>;
  /** The pinned `data`/`error`/`success` payload the stub handler returns. */
  readonly payload: Pick<DispatchResponse, 'success' | 'data' | 'error'>;
}

/**
 * The R3-T1-derived golden fixture set. Every triple is a REAL registered
 * operation (verified against the operations registry), so the dispatcher's
 * resolve + param-validation path runs faithfully. `sentient.*` ops are the
 * three `mcpExposed` operations (reachable over MCP); the rest span the read
 * surface and one error case.
 */
const GOLDEN_FIXTURES: readonly GoldenFixture[] = [
  {
    id: 'tasks.show',
    gateway: 'query',
    domain: 'tasks',
    operation: 'show',
    params: { taskId: 'T1' },
    payload: { success: true, data: { task: { id: 'T1', title: 'Golden', status: 'pending' } } },
  },
  {
    id: 'tasks.list',
    gateway: 'query',
    domain: 'tasks',
    operation: 'list',
    params: {},
    payload: { success: true, data: { tasks: [], total: 0 } },
  },
  {
    id: 'tasks.find',
    gateway: 'query',
    domain: 'tasks',
    operation: 'find',
    params: { query: 'golden' },
    payload: { success: true, data: { tasks: [{ id: 'T2' }], total: 1 } },
  },
  {
    id: 'session.status',
    gateway: 'query',
    domain: 'session',
    operation: 'status',
    params: {},
    payload: { success: true, data: { session: { id: 'sess-1', status: 'active' } } },
  },
  {
    id: 'memory.llm-status',
    gateway: 'query',
    domain: 'memory',
    operation: 'llm-status',
    params: {},
    payload: { success: true, data: { provider: 'none', ready: false } },
  },
  {
    id: 'tasks.show.not-found',
    gateway: 'query',
    domain: 'tasks',
    operation: 'show',
    params: { taskId: 'T999' },
    payload: {
      success: false,
      error: { code: 'E_NOT_FOUND', message: 'Task T999 not found' },
    },
  },
  {
    id: 'sentient.status',
    gateway: 'query',
    domain: 'sentient',
    operation: 'status',
    params: {},
    payload: { success: true, data: { enabled: false, proposals: 0 } },
  },
  {
    id: 'sentient.propose.list',
    gateway: 'query',
    domain: 'sentient',
    operation: 'propose.list',
    params: { limit: 5 },
    payload: { success: true, data: { proposals: [] } },
  },
  {
    id: 'sentient.propose.enable',
    gateway: 'mutate',
    domain: 'sentient',
    operation: 'propose.enable',
    params: {},
    payload: { success: true, data: { enabled: true } },
  },
] as const;

/** Index the fixtures by `domain:operation` for the stub handler lookup. */
const FIXTURE_BY_KEY = new Map<string, GoldenFixture>(
  GOLDEN_FIXTURES.map((f) => [`${f.domain}:${f.operation}:${JSON.stringify(f.params)}`, f]),
);

/**
 * Build the deterministic stub domain-handler map: one {@link DomainHandler} per
 * fixture domain that returns the pinned golden payload for the matching
 * `(operation, params)`. This is the single handler injected into EVERY
 * transport adapter via {@link createGatewayHandler}, so the dispatched envelope
 * is identical regardless of which transport invokes it.
 *
 * @returns A `Map<domain, DomainHandler>` covering every golden fixture domain.
 */
function buildStubHandlers(): Map<string, DomainHandler> {
  const domains = new Set(GOLDEN_FIXTURES.map((f) => f.domain));
  const handlers = new Map<string, DomainHandler>();

  for (const domain of domains) {
    const run = (
      operation: string,
      params?: Record<string, unknown>,
    ): Promise<DispatchResponse> => {
      const key = `${domain}:${operation}:${JSON.stringify(params ?? {})}`;
      const fixture = FIXTURE_BY_KEY.get(key);
      if (!fixture) {
        throw new Error(`No golden fixture for ${key}`);
      }
      const response: DispatchResponse = {
        meta: {
          // Business meta (transport-invariant). The dispatcher overwrites the
          // trace-local fields (source/requestId/duration_ms) post-handler.
          gateway: fixture.gateway,
          domain: fixture.domain,
          operation: fixture.operation,
          timestamp: '2026-05-31T00:00:00.000Z',
          duration_ms: 0,
          source: 'cli',
          requestId: 'fixed',
        },
        ...fixture.payload,
      };
      return Promise.resolve(response);
    };

    handlers.set(domain, {
      query: run,
      mutate: run,
      getSupportedOperations: (): { query: string[]; mutate: string[] } => ({
        query: GOLDEN_FIXTURES.filter((f) => f.domain === domain && f.gateway === 'query').map(
          (f) => f.operation,
        ),
        mutate: GOLDEN_FIXTURES.filter((f) => f.domain === domain && f.gateway === 'mutate').map(
          (f) => f.operation,
        ),
      }),
    });
  }

  return handlers;
}

/** The shared, transport-neutral gateway handler — built ONCE, injected everywhere. */
const HANDLER: GatewayHandler = createGatewayHandler({ handlers: buildStubHandlers() });

// ---------------------------------------------------------------------------
// Parity normalization — strip the legitimately per-transport / per-call fields
// ---------------------------------------------------------------------------

/**
 * The meta fields that legitimately differ per transport or per call and are
 * therefore excluded from the byte-parity comparison:
 *  - `source`              — each transport FORCES its own transport-of-origin.
 *  - `requestId`           — minted per call for tracing.
 *  - `duration_ms`         — wall-clock timing.
 *  - `timestamp`           — wall-clock timestamp.
 *  - `sessionId`           — bound session identity (per-call when omitted).
 *  - `originSessionId`     — root session lineage, minted per call via
 *                            `randomUUID()` by `ensureRequestSessionLineage`
 *                            when the request omits it.
 *  - `executionSessionId`  — per-execution lineage, minted the same way.
 *
 * These are trace/identity fields, NOT operation behavior — every transport
 * stamps them identically in KIND, so they are normalized out and the residual
 * business meta + payload must match byte-for-byte.
 */
const PER_CALL_META_KEYS = [
  'source',
  'requestId',
  'duration_ms',
  'timestamp',
  'sessionId',
  'originSessionId',
  'executionSessionId',
] as const;

/**
 * Produce a transport-invariant projection of a {@link DispatchResponse}: the
 * full payload (`data`/`success`/`error`/`page`/`partial`) plus the business
 * `meta` with the per-call/per-transport fields removed. Two responses are
 * "at parity" iff their canonical-JSON projections are byte-identical.
 *
 * @param response - A dispatch response recovered from a transport.
 * @returns The canonicalized parity projection.
 */
function parityProjection(response: DispatchResponse): unknown {
  const { meta, ...rest } = response;
  const businessMeta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!(PER_CALL_META_KEYS as readonly string[]).includes(k)) {
      businessMeta[k] = v;
    }
  }
  return canonicalize({ ...rest, meta: businessMeta });
}

/**
 * Deterministically order object keys so `JSON.stringify` is a stable byte
 * representation regardless of insertion order across transports.
 *
 * @param value - Any JSON-serializable value.
 * @returns A key-sorted deep clone.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** The canonical-JSON byte string of a response's parity projection. */
function parityBytes(response: DispatchResponse): string {
  return JSON.stringify(parityProjection(response));
}

// ---------------------------------------------------------------------------
// Per-transport replay drivers — each invokes the SAME handler in-process
// ---------------------------------------------------------------------------

/** Replay a fixture through the CLI transport (the in-process Dispatcher). */
async function replayCli(fixture: GoldenFixture): Promise<DispatchResponse> {
  const request: DispatchRequest = {
    gateway: fixture.gateway,
    domain: fixture.domain,
    operation: fixture.operation,
    params: fixture.params,
    source: 'cli',
    requestId: `cli-${fixture.id}`,
  };
  return HANDLER.handle(request);
}

/**
 * Replay a fixture through the MCP transport (`callTool`). Returns the LAFS
 * envelope decoded from the tool result's JSON text content, or `undefined`
 * when the operation is not in the `mcpExposed` subset (unreachable over MCP).
 */
async function replayMcp(fixture: GoldenFixture): Promise<DispatchResponse | undefined> {
  const exposed = exposedOperations();
  const match = exposed.find(
    (op) => op.domain === fixture.domain && op.operation === fixture.operation,
  );
  if (!match) return undefined;
  const toolName = operationToToolName(match);
  const result = await callTool(HANDLER, toolName, fixture.params);
  return JSON.parse(result.content[0].text) as DispatchResponse;
}

/**
 * Replay a fixture through the RPC transport using the FULL wire codec + routing
 * path (no socket — the codec is socket-agnostic by design):
 *
 *   build request frame → `decodeLine` (the inbound NDJSON line the server reads)
 *     → `routeFrame` (dispatch through the handler) → `encodeFrame` (the outbound
 *     NDJSON line the server writes) → `decodeLine`-equivalent parse of that line
 *     → recover the LAFS envelope from the response frame.
 *
 * Exercising both `encodeFrame` and `decodeLine` proves the NDJSON framing is
 * lossless end-to-end, exactly as the live unix-socket server does on the wire.
 */
async function replayRpc(fixture: GoldenFixture): Promise<DispatchResponse> {
  const requestFrame: GatewayRpcRequestFrame = {
    protocol_version: GATEWAY_RPC_PROTOCOL_VERSION,
    id: `rpc-${fixture.id}`,
    direction: 'request',
    request: {
      gateway: fixture.gateway,
      domain: fixture.domain,
      operation: fixture.operation,
      params: fixture.params,
      source: 'rpc',
      requestId: `rpc-${fixture.id}`,
    },
  };

  // Inbound: serialize to an NDJSON line and decode it exactly as the server does.
  const inboundLine = `${JSON.stringify(requestFrame)}\n`.trim();
  const decoded = decodeLine(inboundLine);
  if (decoded.kind !== 'request') {
    throw new Error(`RPC decode failed for ${fixture.id}: ${decoded.frame.error.code}`);
  }

  // Route through the shared gateway handler.
  const out = await routeFrame(HANDLER, decoded.frame);
  if (out.direction !== 'response') {
    throw new Error(`RPC routing produced a ${out.direction} frame for ${fixture.id}`);
  }

  // Outbound: encode the response to its NDJSON wire line and parse it back,
  // proving the response frame survives the wire byte-for-byte.
  const outboundLine = encodeFrame(out).trim();
  const reparsed = decodeLine(outboundLine);
  // A response frame reaching decodeLine is rejected as a wrong-direction frame
  // (servers never read response frames) — so parse the wire line directly to
  // recover the round-tripped envelope, which is what a CLIENT does.
  expect(reparsed.kind).toBe('error');
  const wireFrame = JSON.parse(outboundLine) as GatewayRpcResponseFrame;
  return wireFrame.response;
}

/** Replay a fixture through the HTTP transport (unary `routeUnary`). */
async function replayHttp(fixture: GoldenFixture): Promise<DispatchResponse> {
  const result = await routeUnary(HANDLER, {
    gateway: fixture.gateway,
    domain: fixture.domain,
    operation: fixture.operation,
    params: fixture.params,
    requestId: `http-${fixture.id}`,
  });
  return result.body;
}

/**
 * Drain a `text/event-stream` ReadableStream to its full UTF-8 text.
 *
 * @param stream - The SSE stream to read to completion.
 * @returns The concatenated UTF-8 text of every emitted frame.
 */
async function drainSse(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

// ---------------------------------------------------------------------------
// AC1 — replay ALL golden fixtures through CLI + MCP + RPC + HTTP, assert parity
// ---------------------------------------------------------------------------

describe('R3-T9 cross-transport parity — golden fixtures × {CLI, MCP, RPC, HTTP}', () => {
  it('every fixture targets a REAL registered operation (resolve succeeds)', async () => {
    // A missing fixture op would make the dispatcher return E_INVALID_OPERATION
    // rather than the golden payload, which the per-transport assertions below
    // would surface — this guard fails fast with a clear message.
    for (const fixture of GOLDEN_FIXTURES) {
      const cli = await replayCli(fixture);
      expect(cli.meta.operation, `${fixture.id}: handler must resolve`).toBe(fixture.operation);
      // The dispatcher must have routed to the stub (not E_INVALID_OPERATION /
      // E_NO_HANDLER), so the payload's success matches the fixture.
      expect(cli.success, `${fixture.id}: payload success`).toBe(fixture.payload.success);
    }
  });

  for (const fixture of GOLDEN_FIXTURES) {
    describe(`fixture ${fixture.id} (${fixture.gateway}/${fixture.domain}.${fixture.operation})`, () => {
      it('CLI is the baseline truth', async () => {
        const cli = await replayCli(fixture);
        expect(cli.meta.source).toBe('cli');
        expect(cli.success).toBe(fixture.payload.success);
      });

      it('RPC envelope is at parity with CLI', async () => {
        const cli = await replayCli(fixture);
        const rpc = await replayRpc(fixture);
        expect(rpc.meta.source).toBe('rpc');
        expect(parityBytes(rpc)).toBe(parityBytes(cli));
      });

      it('HTTP envelope is at parity with CLI', async () => {
        const cli = await replayCli(fixture);
        const http = await replayHttp(fixture);
        expect(http.meta.source).toBe('http');
        expect(parityBytes(http)).toBe(parityBytes(cli));
      });

      it('MCP envelope is at parity with CLI (mcpExposed subset) or correctly unreachable', async () => {
        const cli = await replayCli(fixture);
        const mcp = await replayMcp(fixture);
        const exposed = exposedOperations().some(
          (op) => op.domain === fixture.domain && op.operation === fixture.operation,
        );
        if (exposed) {
          expect(mcp, `${fixture.id} is mcpExposed → must replay`).toBeDefined();
          // Non-null assertion is safe: `exposed` guarantees a defined envelope.
          const envelope = mcp as DispatchResponse;
          expect(envelope.meta.source).toBe('mcp');
          expect(parityBytes(envelope)).toBe(parityBytes(cli));
        } else {
          // Default-deny: the operation is NOT in the MCP tool surface, so the
          // MCP transport cannot replay it. The other three transports carry it.
          expect(mcp, `${fixture.id} is not mcpExposed → unreachable over MCP`).toBeUndefined();
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// MCP subset coverage — the mcpExposed fixtures match the live exposed surface
// ---------------------------------------------------------------------------

describe('R3-T9 MCP subset coverage', () => {
  it('exactly the sentient fixtures are mcpExposed (matches the live tool surface)', () => {
    const exposedKeys = new Set(exposedOperations().map((op) => `${op.domain}:${op.operation}`));
    const fixtureExposed = GOLDEN_FIXTURES.filter((f) =>
      exposedKeys.has(`${f.domain}:${f.operation}`),
    ).map((f) => f.id);
    // The three sentient fixtures (status, propose.list, propose.enable) are the
    // mcpExposed subset; the rest (tasks/session/memory) are default-deny.
    expect(fixtureExposed.sort()).toEqual(
      ['sentient.propose.enable', 'sentient.propose.list', 'sentient.status'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// HTTP SSE parity — the envelope survives the streaming wire byte-for-byte
// ---------------------------------------------------------------------------

describe('R3-T9 HTTP SSE — envelope-as-stream-frame parity', () => {
  it('a DispatchResponse carried as an SSE done-frame round-trips at parity with CLI', async () => {
    const fixture = GOLDEN_FIXTURES[0]; // tasks.show
    const cli = await replayCli(fixture);

    // Emit the unary envelope as the terminal `done` frame of an SSE stream
    // (the streaming transport's envelope carrier), then recover it from the
    // wire bytes and assert parity.
    const streamEvent: GatewayStreamEvent = {
      kind: 'done',
      seq: 0,
      data: cli,
      requestId: cli.meta.requestId,
    };
    const stream = createSseStream((emitter) => {
      emitter.sendStreamEvent(streamEvent);
      emitter.close();
      return undefined;
    });

    const wire = await drainSse(stream);
    // SSE record: `id: 0\ndata: <json>\n\n`. Recover the JSON `data:` line.
    const dataLine = wire.split('\n').find((l) => l.startsWith('data: '));
    expect(dataLine, 'SSE wire must carry a data: frame').toBeDefined();
    const recovered = JSON.parse((dataLine as string).slice('data: '.length)) as GatewayStreamEvent;
    expect(recovered.kind).toBe('done');
    expect(parityBytes(recovered.data as DispatchResponse)).toBe(parityBytes(cli));
  });
});
