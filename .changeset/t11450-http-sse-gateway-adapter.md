---
id: t11450-http-sse-gateway-adapter
tasks: [T11450]
kind: feat
summary: Build @cleocode/runtime/gateway/http as the fourth and final gateway transport adapter — framework-agnostic unary (POST → JSON LAFS) + SSE (GatewayStreamEvent) over the unified gateway — and route the two Studio SSE endpoints through its shared abort-safe stream builder with a byte-identical wire
---

Add `@cleocode/runtime/gateway/http` — the HTTP transport adapter over the unified gateway (R3-T6), completing the four-transport set (CLI · MCP · RPC · HTTP). It serves two modes:

- **Unary**: `routeUnary(handler, req)` builds a `source: 'http'` `DispatchRequest` from the embedder-resolved `(gateway, domain, operation, params)` triple, routes it through an injected `GatewayHandler` (built via `createGatewayHandler`), and returns `{ status, body }` — the LAFS envelope plus an HTTP status mapped from the LAFS error code (`statusForResponse`). The request `source` is always forced to `'http'`; thrown handler errors are trapped as a `500 E_HTTP_INTERNAL` envelope (no throw, no `process.exit`).
- **SSE**: `createSseStream(source, signal?)` is a shared, abort-safe `ReadableStream` builder that streams `GatewayStreamEvent` frames (the streaming type from `@cleocode/contracts/gateway`) for long-running/subscription ops. Frames are dropped (never throw) after close, the source teardown runs exactly once, and the request `AbortSignal` closes the stream on client disconnect. `encodeStreamEvent` / `encodeSseFrame` own the SSE wire bytes.

Unlike the connection-oriented MCP/RPC adapters, the HTTP adapter is **framework-agnostic**: it binds no port and owns no `Request`/`Response` lifecycle, so the embedder (a SvelteKit route, the daemon HTTP server, a test harness) supplies the operation coordinates and serializes the result. `@cleocode/runtime` retains NO `@cleocode/cleo` dependency, NO SvelteKit dependency, and NO drizzle-orm.

The two live Studio SSE endpoints (`/api/brain/stream`, `/api/tasks/events`) now route their stream lifecycle through `createSseStream`, sharing one tested abort-safe builder while preserving their exact observable wire (brain/stream stays `data: <json>\n\n` via its own `sseEncode`; tasks/events keeps named `event:` frames). Event ordering and shape are unchanged — the existing brain/stream SSE handler test suite stays green.
