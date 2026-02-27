# CLEO Web API Specification

**Version**: 2.0.0
**Status**: Canonical Specification
**Date**: 2026-02-27
**Epic**: T4284 (CLEO Nexus Command Center WebUI)
**Supersedes**: CLEO-WEB-API-SPEC v1.0.0 (complete rewrite based on challenge findings)
**Vision**: [docs/concepts/vision.md](../concepts/vision.md)
**UI Spec**: [CLEO-WEB-DASHBOARD-UI.md](../mintlify/specs/CLEO-WEB-DASHBOARD-UI.md)

---

## 1. Vision Alignment

The Web API is the **fourth adapter** over CLEO's shared core (`src/core/`), joining MCP, CLI, and SDK. It serves the same business logic through a browser-accessible HTTP interface.

### Pillar Compliance

| Pillar | How the Web API Serves It |
|--------|---------------------------|
| **Portable Memory (BRAIN)** | The API reads from the same `.cleo/tasks.db` and `.cleo/brain.db` as every other adapter. No separate data store. Moving `.cleo/` moves the API's data with it. |
| **Agent Communication Contract (LAFS)** | Every HTTP response MUST be LAFS-compliant. By default, the response body contains only the `data` payload (success) or error detail (failure). LAFS metadata is conveyed via `X-Cleo-*` response headers. Full LAFS envelope wrapping is available on-demand via `Accept: application/vnd.lafs+json` for agent SDK consumers. The `X-Cleo-Transport` header is `"http"`. |
| **Structured Lifecycle (RCASD-IVTR+C)** | The `pipeline` domain exposes all lifecycle gate operations. Stage validation, gate pass/fail, and release operations are accessible through the same dispatch pipeline that enforces gate compliance. |
| **Deterministic Safety** | All write operations flow through `Dispatcher.dispatch()`, which executes the full middleware pipeline: sanitizer, field-filter, rate-limiter, verification-gates, protocol-enforcement, and audit. The API layer contains zero business logic. |
| **Cognitive Retrieval (BRAIN + NEXUS)** | The `memory` domain exposes pattern search, learning search, manifest reads, and contradiction detection. The `nexus` domain is reserved for cross-project queries. Three-layer retrieval (search -> timeline -> fetch) is preserved through domain operations. |

---

## 2. Architecture Overview

The Dispatcher IS the RPC layer. The HTTP adapter exposes it directly via two endpoints that mirror the MCP `cleo_query` / `cleo_mutate` tools exactly.

```
Browser (localhost:<dynamic-port>)
    |
    | POST /api/query   -- reads
    | POST /api/mutate  -- writes
    | GET  /api/poll     -- ETag-based change detection
    v
Fastify HTTP Server
    |
    | DispatchRequest { gateway, domain, operation, params }
    v
Dispatcher (existing CQRS dispatcher)
    |
    | Middleware pipeline (session-resolver, sanitizer,
    |   field-filter, rate-limiter, verification-gates,
    |   protocol-enforcement, audit)
    v
Domain Handlers -> Engine Functions -> src/core/
    |
    v
SQLite (tasks.db, brain.db) + Config JSON
```

### Dual-Process Model

Following the pattern established by claude-mem's architecture, CLEO uses a dual-process model:

1. **MCP Server** (existing) -- thin stdio-based process for agent communication
2. **HTTP Worker** (new) -- long-lived Fastify HTTP daemon for browser access

The HTTP worker is an independent process started via `cleo web start`. It imports `src/core/` directly and instantiates its own `Dispatcher` with the same middleware pipeline used by the MCP adapter (plus `source: 'http'`).

### The `/dispatch` Pattern

The HTTP adapter exposes the Dispatcher through two endpoints:

```
POST /api/query   ->  Dispatcher.dispatch({ gateway: 'query', ... })
POST /api/mutate  ->  Dispatcher.dispatch({ gateway: 'mutate', ... })
```

These mirror MCP's `cleo_query` / `cleo_mutate` tools exactly. The architecture is honest: CLEO already has a complete dispatch system with validation, routing, middleware, and error handling. The HTTP layer is a thin translation between HTTP and `DispatchRequest`/`DispatchResponse`.

### Why Not tRPC?

tRPC was evaluated thoroughly and rejected. While it offers genuine advantages (CQRS alignment, subscription support, React Query integration), its core value proposition -- automatic type inference from `typeof appRouter` -- is undermined by CLEO's dynamic operation registry.

**The type inference problem**: CLEO has 152 operations defined in `OperationRegistry` with `ParamDef[]` metadata. Generating tRPC procedures programmatically from this registry at runtime means the `typeof appRouter` resolves to procedures typed as `z.ZodUnknown` input and `unknown` output for 137 of 152 operations. Only ~15 hand-typed "hot path" operations would get real type inference. This is a two-tier type system that is confusing, not type-safe.

**tRPC's strengths, acknowledged**:
- CQRS natural fit (`query()`/`mutation()` map to CLEO gateways)
- Zero code generation for type sharing
- First-party Fastify adapter
- SSE subscription support
- React Query integration via `@trpc/react-query`

**Why these strengths are insufficient for CLEO**:

1. **Type inference is degraded**: Dynamic router generation means 90% of operations resolve to `unknown`. The research's "hybrid approach" (hand-write hot paths, auto-generate the rest) creates an inconsistent developer experience.

2. **Framework overhead for a passthrough**: Every tRPC procedure does exactly one thing: construct a `DispatchRequest` and call `ctx.dispatcher.dispatch()`. tRPC's middleware, error handling, and context are redundant with CLEO's own middleware pipeline.

3. **Error mapping is lossy**: tRPC has ~15 error codes. CLEO has 94 exit codes across 10 ranges. Mapping CLEO's error taxonomy to tRPC's coarse codes (then enriching via `errorFormatter`) means clients must dig into `data.cleoExitCode` for the real error.

4. **TypeScript performance at scale**: 152 operations means a router type with ~300+ procedure entries. Users report IDE lag and slow `tsc` with large tRPC routers.

5. **Batching is unnecessary**: For localhost SQLite queries under 5ms, tRPC's batch link adds complexity for zero benefit.

**The generated typed client is MORE type-safe than tRPC's dynamic router** because the codegen script has access to the full `ParamDef[]` metadata and produces precise TypeScript interfaces for ALL 152 operations, not just the 15 hand-typed ones.

### Why Not ts-rest, Hono, or oRPC?

| Option | Why Not |
|--------|---------|
| **ts-rest** | REST semantics fight CLEO's RPC nature. No subscriptions. Verbose for 152 ops. Mapping RPC operations to REST paths is unnatural (`POST /api/tasks/relates/add`?). |
| **Hono** | Dynamic routes break type inference completely. No CQRS concept. Designed for edge workers, not localhost dispatch systems. |
| **oRPC** | Too immature (v1.0 Dec 2025, single primary maintainer). Same dynamic generation problem. Worth monitoring for v2+. |
| **Elysia** | Bun-first; Node.js is second-class. Portability risk for a tool that values stability. |
| **Raw Fastify + per-route Zod** | All the overhead of defining 152 routes without the type inference payoff. The `/dispatch` pattern achieves zero-touch growth. |

---

## 3. Why This Architecture: Defended Decisions

### 3.1 Why `/dispatch` Not tRPC

**Decision**: Two HTTP endpoints (`/api/query`, `/api/mutate`) that delegate to `Dispatcher.dispatch()`, paired with a generated typed client.

**Arguments for tRPC**:
- CQRS natural fit (query/mutation)
- Zero code generation for type sharing
- React Query integration out of the box
- Well-documented, large community

**Arguments against tRPC for CLEO**:
- Dynamic router generation destroys the core value proposition (type inference)
- Adds a redundant middleware layer on top of CLEO's existing pipeline
- Error mapping from 94 exit codes to ~15 tRPC codes is lossy
- TypeScript performance degrades with 300+ procedure router types
- Every procedure is a passthrough to `Dispatcher.dispatch()` -- tRPC adds indirection without adding value

**The decisive factor**: CLEO's `OperationRegistry` already defines all 152 operations with full metadata (`ParamDef[]`, gateway, domain, description, tier, required params). A codegen script that reads this registry and emits a fully-typed TypeScript client provides BETTER type safety than tRPC's dynamic router, because it covers ALL 152 operations with precise types, not just 15 hand-typed ones.

**Comparison**:
| Aspect | tRPC Dynamic Router | Generated Typed Client |
|--------|--------------------|-----------------------|
| Operations with precise types | ~15 (hand-typed) | 152 (all) |
| Operations with `unknown` types | ~137 | 0 |
| Zero-touch API growth | Partial (auto-generated but untyped) | Full (re-run codegen) |
| Client reactivity | React Query built-in | TanStack Query manual |
| Build step required | No | Yes (codegen script) |
| Framework overhead | tRPC middleware + error mapping | None |

### 3.2 Why Headers Not LAFS Body Envelopes

**Decision**: Default HTTP responses contain pure `data` in the body with LAFS metadata in `X-Cleo-*` headers. Full LAFS envelope available on-demand via content negotiation.

**Arguments for body envelopes on every response**:
- Consistency with MCP transport (which wraps in `DispatchResponse`)
- `_meta` is always accessible without header parsing
- Single response shape for all consumers

**Arguments against body envelopes for HTTP**:
- HTTP already has out-of-band metadata channels (status codes, headers)
- The CLI adapter already proves LAFS compliance without envelope wrapping (exit codes via `process.exit()`, formatted output without `_meta`)
- TypeScript type inference works better without envelopes (`Task` is strictly better than `LafsEnvelope<Task>` for dashboard DX)
- MVI progressive disclosure conflicts with static type systems (the return type changes shape based on a runtime `_mvi` parameter, forcing `unknown` or excessive unions)
- Response size overhead: for `tasks.find` returning 5 minimal tasks (~200 bytes), the LAFS envelope adds ~400 bytes of `_meta`

**The precedent**: The CLI adapter is already LAFS-compliant without envelope wrapping. It translates `DispatchResponse` into transport-native signals:
- Exit codes via `process.exit(exitCode)`
- Formatted output via `cliOutput(response.data)`
- Structured errors via `cliError(message, exitCode, {...})`

The HTTP adapter follows the same translation pattern:
- Exit codes via HTTP status codes + `X-Cleo-Exit-Code` header
- Metadata via `X-Cleo-*` headers
- Pure data in the response body

**LAFS compliance is about protocol guarantees, not wire format**. The guarantees (exit codes, MVI, field filtering, request tracing) are satisfied through HTTP-native mechanisms.

### 3.3 Why Svelte 5 Not React

**Decision**: Svelte 5 standalone (with Vite, NOT SvelteKit) for the dashboard frontend.

**Arguments for React**:
- Largest ecosystem; any component library works
- `@trpc/react-query` provides hooks, caching, invalidation out of the box
- D3.js + React integration is well-documented (visx, nivo, or raw D3 in useEffect)
- Safest bet for contributor findability
- Battle-tested at all scales

**Arguments for Svelte 5**:
- **Developer familiarity signal**: The developer has an existing `svelte5-sveltekit` skill. A framework they already know will always be maintained better than one learned for a single project.
- **Right-sized for the problem**: Svelte compiles away the framework. Output is surgical DOM updates without a runtime. For a localhost dashboard that renders tables and charts, this matches the problem without overhead.
- **Runes solve the React hooks problem**: `$state()` and `$derived()` are explicit, have no dependency array footguns, and read naturally after 6 months away from the code.
- **Built-in animations**: The UI spec describes slide-in panels, counter roll animations, status flash effects. Svelte's `transition:` and `animate:` directives handle these natively. React requires Framer Motion or CSS-in-JS.
- **D3 integration is solvable**: Use D3 for computation (force simulation, scales, path generators), Svelte for rendering (SVG elements with reactive bindings). This pattern works and is stable once established.
- **tRPC not needed**: Since we use a generated typed client (not tRPC), the React-specific `@trpc/react-query` advantage disappears. TanStack Query works with any framework.

**Why NOT SvelteKit**: SvelteKit adds file-based routing, SSR, and server-side data loading -- all unnecessary for a localhost SPA with 9 views. Svelte 5 + Vite + a lightweight client-side router is sufficient.

### 3.4 Why Polling Not SSE/WebSocket

**Decision**: Smart polling with ETag-based conditional GETs. No persistent connections.

**Arguments for SSE**:
- Lower latency than polling (events arrive as they happen)
- Auto-reconnect built into browser's `EventSource` API
- Simpler than WebSocket (unidirectional, no upgrade handshake)
- claude-mem uses SSE successfully

**Arguments for WebSocket**:
- Bidirectional communication
- Lower overhead per message than HTTP
- Well-supported via `@fastify/websocket`

**Arguments against both for CLEO**:

1. **The detection problem is unsolved**: SSE and WebSocket are delivery mechanisms. They do not solve the hard problem: how does the web server know something changed? CLEO's CLI, MCP server, and web server are separate processes writing to the same SQLite database. The web server does NOT own the write path.

2. **claude-mem's pattern does not transfer**: claude-mem uses SSE because its worker service IS the single writer -- it broadcasts events at the point of mutation. CLEO's web server is a READER of a database that CLI and MCP WRITE to. There is no in-process event source.

3. **SQLite WAL mode breaks file watching**: `chokidar` watching `tasks.db` misses writes because WAL mode writes to `tasks.db-wal` first, then checkpoints later. Watching `tasks.db-wal` fires on every SQLite housekeeping operation. Neither gives reliable change detection.

4. **Persistent connections are wasted >90% of the time**: The developer is working in their terminal/IDE. The dashboard is a background tab. Every SSE connection, every heartbeat -- wasted work serving nobody.

5. **Industry precedent**: Grafana (the gold standard for local dashboards) defaults to 30-second polling intervals. Drizzle Studio, pgAdmin, TablePlus, DBeaver -- all use polling or manual refresh for local database viewing.

**The polling strategy**:
- ETag-based conditional GETs (`If-None-Match` -> `304 Not Modified` when unchanged)
- View-appropriate intervals (3-30s depending on view urgency)
- ETag generation: hash of `MAX(updatedAt)` from tasks table + record count (one cheap SQL query, microseconds on SQLite)
- Localhost round-trip: <1ms. Even 5 views polling at different intervals = 2-3 requests/second, mostly returning 304.

**Phase 3+ MAY add SSE** for an activity feed IF user demand warrants it. The REST API design is unchanged -- SSE is purely additive.

---

## 4. Server Lifecycle

### Dynamic Port Selection

The server MUST use dynamic port selection:

1. Attempt to bind to port `0` (OS assigns an available port)
2. On successful bind, write the assigned port to the portfile
3. If a preferred port is specified via `--port`, attempt that first; fall back to dynamic on `EADDRINUSE`

### Portfile

- **Location**: `.cleo/web-server.port`
- **Format**: Plain text containing the port number (e.g., `34567`)
- **Lifecycle**: Written on server start, deleted on server stop
- **Staleness detection**: Clients SHOULD verify the server is alive via `/health` before using the port

### Process Management

```bash
cleo web start              # Start server (dynamic port)
cleo web start --port 3456  # Start with preferred port
cleo web start --open       # Start + open browser
cleo web stop               # Graceful shutdown via PID
cleo web status             # Show running state + URL
cleo web open               # Open browser to running instance
```

Process artifacts:
- **PID file**: `.cleo/web-server.pid`
- **Port file**: `.cleo/web-server.port`
- **Log file**: `.cleo/logs/web-server.log`

### Health and Readiness

Following claude-mem's two-phase startup pattern:

| Endpoint | Purpose | Available |
|----------|---------|-----------|
| `GET /health` | Liveness probe. Returns `200 { status: "ok" }` immediately after HTTP bind. | Phase 1 (immediate) |
| `GET /ready` | Readiness probe. Returns `200` only after dispatcher initialization and DB connection verified. Returns `503` during init. | Phase 2 (after full init) |

### Graceful Shutdown

On `SIGTERM` or `SIGINT`:

1. Stop accepting new connections
2. Complete in-flight requests (5-second timeout)
3. Delete PID file and port file
4. Exit with code 0

### Localhost-Only Binding

The server MUST bind to `127.0.0.1`. It MUST NOT bind to `0.0.0.0` or any external interface. This is a security requirement for the MVP.

---

## 5. API Contract

### Dispatch Endpoints

Two endpoints mirror the MCP tools:

#### `POST /api/query`

Read operations. Delegates to `Dispatcher.dispatch({ gateway: 'query', ... })`.

**Request body** (Zod-validated):

```typescript
const DispatchQuerySchema = z.object({
  domain: z.enum([
    'tasks', 'session', 'memory', 'check', 'pipeline',
    'orchestrate', 'tools', 'admin', 'nexus',
  ]),
  operation: z.string().min(1),
  params: z.record(z.unknown()).optional(),
  _mvi: z.enum(['minimal', 'standard', 'full', 'custom']).optional(),
  _fields: z.array(z.string()).optional(),
});
```

**Example**:

```http
POST /api/query
Content-Type: application/json

{
  "domain": "tasks",
  "operation": "show",
  "params": { "taskId": "T1234" }
}
```

#### `POST /api/mutate`

Write operations. Delegates to `Dispatcher.dispatch({ gateway: 'mutate', ... })`.

**Request body** (Zod-validated):

```typescript
const DispatchMutateSchema = z.object({
  domain: z.enum([
    'tasks', 'session', 'memory', 'check', 'pipeline',
    'orchestrate', 'tools', 'admin', 'nexus',
  ]),
  operation: z.string().min(1),
  params: z.record(z.unknown()).optional(),
});
```

**Example**:

```http
POST /api/mutate
Content-Type: application/json

{
  "domain": "tasks",
  "operation": "add",
  "params": {
    "title": "Implement login flow",
    "description": "Add OAuth2 login with Google provider",
    "priority": "high"
  }
}
```

### Dispatch Endpoint Handler

```typescript
// src/web/routes/dispatch.ts
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Dispatcher } from '../../dispatch/dispatcher.js';

export function registerDispatchRoutes(
  server: FastifyInstance,
  dispatcher: Dispatcher,
): void {
  // Query endpoint
  server.post('/api/query', async (req, reply) => {
    const { domain, operation, params, _mvi, _fields } = req.body as any;

    const response = await dispatcher.dispatch({
      gateway: 'query',
      domain,
      operation,
      params: { ...params, _mvi, _fields },
      source: 'http',
      requestId: randomUUID(),
      sessionId: req.headers['x-cleo-session'] as string | undefined,
    });

    return sendDispatchResponse(reply, response);
  });

  // Mutate endpoint
  server.post('/api/mutate', async (req, reply) => {
    const { domain, operation, params } = req.body as any;

    const response = await dispatcher.dispatch({
      gateway: 'mutate',
      domain,
      operation,
      params,
      source: 'http',
      requestId: randomUUID(),
      sessionId: req.headers['x-cleo-session'] as string | undefined,
    });

    return sendDispatchResponse(reply, response);
  });
}
```

### Response Translation

The `sendDispatchResponse` function translates `DispatchResponse` into HTTP-native signals:

```typescript
import type { FastifyReply } from 'fastify';
import type { DispatchResponse } from '../../dispatch/types.js';

function sendDispatchResponse(
  reply: FastifyReply,
  response: DispatchResponse,
): void {
  // Set LAFS metadata headers
  reply.header('X-Cleo-Request-Id', response._meta.requestId);
  reply.header('X-Cleo-Gateway', response._meta.gateway);
  reply.header('X-Cleo-Domain', response._meta.domain);
  reply.header('X-Cleo-Operation', response._meta.operation);
  reply.header('X-Cleo-Duration-Ms', String(response._meta.duration_ms));
  reply.header('X-Cleo-Transport', 'http');

  if (response._meta.sessionId) {
    reply.header('X-Cleo-Session-Id', response._meta.sessionId);
  }
  if (response._meta.mvi) {
    reply.header('X-Cleo-MVI', response._meta.mvi);
  }
  if (response._meta.rateLimit) {
    reply.header('X-RateLimit-Limit', String(response._meta.rateLimit.limit));
    reply.header('X-RateLimit-Remaining', String(response._meta.rateLimit.remaining));
    reply.header('X-RateLimit-Reset', String(response._meta.rateLimit.resetMs));
  }

  // Check if client requested full LAFS envelope
  const wantsLafs =
    reply.request.headers.accept?.includes('application/vnd.lafs+json') ||
    (reply.request.body as any)?._lafs === true;

  if (wantsLafs) {
    // Full LAFS envelope mode
    reply.header('Content-Type', 'application/vnd.lafs+json');
    const httpStatus = response.success ? 200 : mapExitCodeToHttpStatus(response.error?.exitCode);
    reply.code(httpStatus).send(response);
    return;
  }

  // Default mode: unwrapped data + headers
  if (response.success) {
    reply.header('X-Cleo-Exit-Code', '0');
    reply.code(200).send(response.data ?? null);
  } else {
    const exitCode = response.error?.exitCode ?? 1;
    reply.header('X-Cleo-Exit-Code', String(exitCode));
    reply.code(mapExitCodeToHttpStatus(exitCode)).send({
      code: response.error?.code,
      exitCode,
      message: response.error?.message,
      details: response.error?.details,
      fix: response.error?.fix,
      alternatives: response.error?.alternatives,
    });
  }
}
```

### Exit Code to HTTP Status Mapping

| CLEO Exit Code Range | HTTP Status | Description |
|---|---|---|
| 0 (SUCCESS) | 200 | OK |
| 2 (INVALID_INPUT) | 400 | Bad Request |
| 4 (NOT_FOUND) | 404 | Not Found |
| 6 (VALIDATION_ERROR) | 400 | Bad Request |
| 7 (LOCK_TIMEOUT) | 408 | Request Timeout |
| 10-19 (hierarchy) | 400 | Bad Request |
| 20-22 (concurrency) | 409 | Conflict |
| 30-39 (session) | 412 | Precondition Failed |
| 40-47 (verification) | 403 | Forbidden |
| 50-54 (context) | 412 | Precondition Failed |
| 60-67 (protocol) | 400 | Bad Request |
| 70-79 (nexus) | 500 | Internal Server Error |
| 80-84 (lifecycle) | 403 | Forbidden |
| 85-94 (artifact/provenance) | 500 | Internal Server Error |
| 100+ (special) | 200 | OK (not errors) |

---

## 6. Generated Typed Client

### How Codegen Works

A build script reads the `OperationRegistry` from `src/dispatch/registry.ts` and generates a fully-typed TypeScript client module.

```bash
npm run generate-client    # Reads registry, emits src/web/client/api.generated.ts
```

The script:

1. Imports `OperationRegistry` from the compiled dispatch module
2. Iterates all 152 operations
3. For each operation, reads `ParamDef[]` metadata (name, type, required, enum values)
4. Emits TypeScript interfaces for input params
5. Emits typed wrapper functions that call `fetch('/api/query')` or `fetch('/api/mutate')`
6. Groups functions by domain namespace

### Generated Output

```typescript
// src/web/client/api.generated.ts  (auto-generated, do not edit)

// --- Input types ---

export interface TasksShowParams {
  taskId: string;
}

export interface TasksFindParams {
  query?: string;
  limit?: number;
}

export interface TasksAddParams {
  title: string;
  description?: string;
  parent?: string;
  depends?: string[];
  priority?: 'critical' | 'high' | 'medium' | 'low';
  labels?: string[];
  type?: 'epic' | 'task' | 'subtask';
}

export interface TasksUpdateParams {
  taskId: string;
  title?: string;
  description?: string;
  status?: 'pending' | 'active' | 'blocked' | 'done' | 'cancelled';
  priority?: 'critical' | 'high' | 'medium' | 'low';
  notes?: string;
  labels?: string[];
  addLabels?: string[];
  removeLabels?: string[];
  depends?: string[];
  addDepends?: string[];
  removeDepends?: string[];
  acceptance?: string;
  parent?: string | null;
  type?: 'epic' | 'task' | 'subtask';
  size?: 'small' | 'medium' | 'large';
}

// ... (interfaces for all 152 operations)

// --- API client ---

function createCleoClient(baseUrl: string) {
  async function query<T>(domain: string, operation: string, params?: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${baseUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, operation, params }),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new CleoApiError(error, res.status, res.headers);
    }
    return res.json();
  }

  async function mutate<T>(domain: string, operation: string, params?: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${baseUrl}/api/mutate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, operation, params }),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new CleoApiError(error, res.status, res.headers);
    }
    return res.json();
  }

  return {
    tasks: {
      show: (params: TasksShowParams) => query('tasks', 'show', params),
      list: (params?: TasksListParams) => query('tasks', 'list', params),
      find: (params?: TasksFindParams) => query('tasks', 'find', params),
      add: (params: TasksAddParams) => mutate('tasks', 'add', params),
      update: (params: TasksUpdateParams) => mutate('tasks', 'update', params),
      complete: (params: TasksCompleteParams) => mutate('tasks', 'complete', params),
      start: (params: TasksStartParams) => mutate('tasks', 'start', params),
      stop: () => mutate('tasks', 'stop'),
      current: () => query('tasks', 'current'),
      // ... all 26 task operations
    },
    session: {
      status: () => query('session', 'status'),
      list: (params?: SessionListParams) => query('session', 'list', params),
      start: (params: SessionStartParams) => mutate('session', 'start', params),
      end: (params?: SessionEndParams) => mutate('session', 'end', params),
      // ... all 17 session operations
    },
    // ... all 9 domains, all 152 operations
  };
}

export type CleoClient = ReturnType<typeof createCleoClient>;
export { createCleoClient };
```

### The Type Safety Guarantee

The generated client provides precise types for ALL 152 operations because:

1. **Input types** are derived from `ParamDef[]` metadata: required params become required fields, optional params become optional fields, enum constraints become union types.
2. **Domain grouping** mirrors the canonical domain structure (`client.tasks.show()`, `client.session.start()`).
3. **Gateway routing** is automatic: query operations call `/api/query`, mutate operations call `/api/mutate`.
4. **Re-generation** is required when the registry changes: `npm run generate-client` in the build pipeline.

### TanStack Query Integration

The generated client integrates with TanStack Query for reactive data fetching in the Svelte frontend:

```typescript
// src/web/client/hooks.ts
import { createQuery, createMutation } from '@tanstack/svelte-query';
import { createCleoClient } from './api.generated.js';

const api = createCleoClient(`http://localhost:${port}`);

// Typed query hook
export function useTaskShow(taskId: string) {
  return createQuery({
    queryKey: ['tasks', 'show', taskId],
    queryFn: () => api.tasks.show({ taskId }),
  });
}

// Typed mutation hook
export function useTaskComplete() {
  return createMutation({
    mutationFn: (params: { taskId: string; notes?: string }) =>
      api.tasks.complete(params),
  });
}
```

---

## 7. LAFS Compliance

### Transport-Specific Compliance

LAFS defines protocol guarantees (exit codes, MVI, field filtering, request tracing). These guarantees are satisfied through transport-native mechanisms. The wire format varies by transport.

### LAFS Transport Compliance Matrix

| Transport | Envelope in Body | Exit Code Channel | Metadata Channel | MVI Support | Field Filtering |
|---|---|---|---|---|---|
| **MCP** (stdio) | Always | `_meta.exitCode` in body | `_meta` in body | `_mvi` param | `_fields` param |
| **CLI** (process) | Never | `process.exit(code)` | N/A (formatted output) | N/A | `--field` flag |
| **HTTP** (default) | Never | HTTP status + `X-Cleo-Exit-Code` | `X-Cleo-*` headers | `_mvi` param (filters data) | `_fields` param (filters data) |
| **HTTP** (LAFS mode) | Always | `_meta.exitCode` + HTTP status | `_meta` in body + headers | `_mvi` in body + param | `_fields` in body + param |

### Header-Based Metadata (Default Mode)

All LAFS metadata is conveyed via response headers:

| LAFS Field | HTTP Header |
|---|---|
| `_meta.requestId` | `X-Cleo-Request-Id` |
| `_meta.sessionId` | `X-Cleo-Session-Id` |
| `_meta.duration_ms` | `X-Cleo-Duration-Ms` |
| `_meta.gateway` | `X-Cleo-Gateway` |
| `_meta.domain` | `X-Cleo-Domain` |
| `_meta.operation` | `X-Cleo-Operation` |
| `_meta.mvi` | `X-Cleo-MVI` |
| `_meta.transport` | `X-Cleo-Transport` (always `"http"`) |
| `error.exitCode` | `X-Cleo-Exit-Code` |
| `_meta.rateLimit.limit` | `X-RateLimit-Limit` |
| `_meta.rateLimit.remaining` | `X-RateLimit-Remaining` |
| `_meta.rateLimit.resetMs` | `X-RateLimit-Reset` |

### On-Demand LAFS Envelope Mode

Clients MAY request full LAFS envelope wrapping via content negotiation:

- `Accept: application/vnd.lafs+json` header
- `_lafs: true` parameter in the request body

When LAFS mode is active, the response body contains the complete `DispatchResponse` with `_meta`, `success`, `data`/`error`. The `Content-Type` is `application/vnd.lafs+json`.

This mode is intended for:
- HTTP-based agent SDKs that need structured metadata for programmatic branching
- NEXUS cross-project federation queries that need provenance metadata
- Debugging/inspection tools

### MVI and Field Filtering

MVI progressive disclosure and `_fields` filtering work in both modes:

1. Client passes `_mvi` and/or `_fields` in the request body
2. The Dispatcher's field-filter middleware extracts these before domain handler execution
3. After execution, `applyFieldFilter()` from `@cleocode/lafs-protocol` projects the response
4. In default mode, the filtered `data` is returned bare; `X-Cleo-MVI` header records the applied level
5. In LAFS mode, the filtered `data` is wrapped in the envelope with `_meta.mvi` set

---

## 8. Domain Operation Mapping

All 152 operations across 9 canonical domains are accessible via the dispatch endpoints. The domain and operation names used in HTTP requests match the MCP operation names exactly.

### Domain: `tasks` (26 operations)

**Purpose**: Task CRUD, hierarchy management, dependency tracking, active task work.

**Queries (13)**: `show`, `list`, `find`, `exists`, `tree`, `blockers`, `depends`, `analyze`, `next`, `plan`, `relates`, `complexity.estimate`, `current`

**Mutations (13)**: `add`, `update`, `complete`, `delete`, `archive`, `restore`, `reparent`, `promote`, `reorder`, `reopen`, `relates.add`, `start`, `stop`

### Domain: `session` (17 operations)

**Purpose**: Session lifecycle, handoffs, briefings, decision logging.

**Queries (10)**: `status`, `list`, `show`, `history`, `decision.log`, `context.drift`, `handoff.show`, `briefing.show`, `debrief.show`, `chain.show`

**Mutations (7)**: `start`, `end`, `resume`, `suspend`, `gc`, `record.decision`, `record.assumption`

### Domain: `memory` (18 operations)

**Purpose**: Research management, BRAIN pattern/learning storage and retrieval, manifest operations.

**Queries (12)**: `show`, `list`, `find`, `pending`, `stats`, `manifest.read`, `contradictions`, `superseded`, `pattern.search`, `pattern.stats`, `learning.search`, `learning.stats`

**Mutations (6)**: `inject`, `link`, `manifest.append`, `manifest.archive`, `pattern.store`, `learning.store`

### Domain: `check` (12 operations)

**Purpose**: Validation, compliance, testing.

**Queries (10)**: `schema`, `protocol`, `task`, `manifest`, `output`, `compliance.summary`, `compliance.violations`, `test.status`, `test.coverage`, `coherence.check`

**Mutations (2)**: `compliance.record`, `test.run`

### Domain: `pipeline` (17 operations)

**Purpose**: RCASD-IVTR+C lifecycle management, release operations.

**Queries (5)**: `stage.validate`, `stage.status`, `stage.history`, `stage.gates`, `stage.prerequisites`

**Mutations (12)**: `stage.record`, `stage.skip`, `stage.reset`, `stage.gate.pass`, `stage.gate.fail`, `release.prepare`, `release.changelog`, `release.commit`, `release.tag`, `release.push`, `release.gates.run`, `release.rollback`

### Domain: `orchestrate` (16 operations)

**Purpose**: Multi-agent orchestration, wave computation, spawn management.

**Queries (10)**: `status`, `next`, `ready`, `analyze`, `context`, `waves`, `skill.list`, `bootstrap`, `unblock.opportunities`, `critical.path`

**Mutations (6)**: `start`, `spawn`, `validate`, `parallel.start`, `parallel.end`, `verify`

### Domain: `tools` (27 operations)

**Purpose**: Issue management, skill ecosystem, provider management.

**Queries (16)**: `issue.diagnostics`, `issue.templates`, `issue.validate.labels`, `skill.list`, `skill.show`, `skill.find`, `skill.dispatch`, `skill.verify`, `skill.dependencies`, `skill.catalog.protocols`, `skill.catalog.profiles`, `skill.catalog.resources`, `skill.catalog.info`, `provider.list`, `provider.detect`, `provider.inject.status`

**Mutations (11)**: `issue.add.bug`, `issue.add.feature`, `issue.add.help`, `issue.generate.config`, `skill.install`, `skill.uninstall`, `skill.enable`, `skill.disable`, `skill.configure`, `skill.refresh`, `provider.inject`

### Domain: `admin` (26 operations)

**Purpose**: System administration, configuration, diagnostics, ADR management.

**Queries (14+)**: `version`, `health`, `config.show`, `config.get`, `stats`, `context`, `runtime`, `job.status`, `job.list`, `dash`, `log`, `sequence`, `help`, `adr.list`, `adr.show`, `adr.find`, `grade`, `grade.list`

**Mutations (12)**: `init`, `config.set`, `backup`, `restore`, `migrate`, `sync`, `cleanup`, `job.cancel`, `safestop`, `inject.generate`, `sequence`, `adr.sync`, `adr.validate`, `install.global`

### Domain: `nexus` (2 operations, placeholder)

**Purpose**: Cross-project network (future).

**Queries (1)**: `nexus.status`
**Mutations (1)**: `nexus.register`

---

## 9. Polling and Freshness

### ETag Strategy

All GET-like endpoints support conditional requests via ETags:

```
Client:  POST /api/query   (with If-None-Match header)
Server:  304 Not Modified  (when data unchanged)
         200 OK + ETag     (when data changed)
```

Since CLEO uses POST for dispatch (not GET), ETag behavior is implemented at the application level:

1. The server computes a lightweight fingerprint after each dispatch response:
   ```sql
   SELECT MAX(updatedAt) as maxUpdate, COUNT(*) as total FROM tasks;
   ```
2. The fingerprint is hashed to produce an ETag value
3. The ETag is returned in the `ETag` response header
4. The client sends `If-None-Match` on subsequent requests
5. The server compares and returns `304 Not Modified` with zero body when unchanged

### Poll Endpoint

A dedicated lightweight endpoint for change detection:

```http
GET /api/poll
If-None-Match: "abc123"
```

Returns:
- `304 Not Modified` when nothing changed (zero body, ~200 bytes total)
- `200 OK` with `{ changed: true, domains: ["tasks", "session"] }` when data changed

The poll endpoint is a single cheap SQL query (~0.1ms on SQLite). It does NOT return entity data -- only whether a change occurred and which domains are affected. The client then re-fetches only the relevant data.

### Client-Side Polling Intervals

| View | Interval | Rationale |
|------|----------|-----------|
| Dashboard overview | 10s | Summary stats, low urgency |
| Task list | 5s | May be watching active work |
| Task detail | 10s | Single task, rarely changes while viewing |
| Session list | 10s | Sessions change infrequently |
| Dependency graph | 30s | Graph structure changes rarely |
| Activity feed | 3s | Most "real-time-like" view |
| System health | 30s | Rarely changes |

### Cache Headers

All responses include standard cache headers:

```
Cache-Control: no-cache
ETag: "fingerprint-hash"
X-Cleo-Exit-Code: 0
```

`no-cache` ensures the browser always validates with the server (conditional request), while the ETag enables 304 responses when data is unchanged.

---

## 10. Frontend Architecture

### Stack

- **Framework**: Svelte 5 (standalone, NOT SvelteKit)
- **Build**: Vite + `@sveltejs/vite-plugin-svelte`
- **Routing**: Lightweight client-side router (svelte-spa-router or equivalent)
- **API Client**: Generated typed client (from `npm run generate-client`)
- **Data Fetching**: TanStack Query for Svelte (`@tanstack/svelte-query`)
- **Charts**: D3.js for computation, Svelte for reactive SVG rendering
- **Theme**: CSS custom properties (dark-first, monospace data)

### D3 Integration Pattern

D3 handles math (force simulation, scales, path generators). Svelte handles rendering (SVG elements with reactive bindings):

```svelte
<!-- Graph.svelte -->
<script>
  import { forceSimulation, forceLink, forceManyBody, forceCenter } from 'd3-force';

  let { nodes, edges } = $props();
  let simulatedNodes = $state([]);

  $effect(() => {
    const sim = forceSimulation(nodes)
      .force('link', forceLink(edges).id(d => d.id))
      .force('charge', forceManyBody().strength(-100))
      .force('center', forceCenter(400, 300));

    sim.on('tick', () => {
      simulatedNodes = [...sim.nodes()];
    });

    return () => sim.stop();
  });
</script>

<svg viewBox="0 0 800 600">
  {#each edges as edge}
    <line x1={edge.source.x} y1={edge.source.y}
          x2={edge.target.x} y2={edge.target.y}
          stroke="var(--edge-color)" />
  {/each}
  {#each simulatedNodes as node}
    <circle cx={node.x} cy={node.y} r="6"
            fill="var(--node-color-{node.status})" />
  {/each}
</svg>
```

### Polling Hook

```typescript
// src/web/client/use-poll.ts
import { createQuery } from '@tanstack/svelte-query';
import { api } from './api.generated.js';

export function usePolledQuery(
  domain: string,
  operation: string,
  params: Record<string, unknown>,
  intervalMs: number = 5000,
) {
  return createQuery({
    queryKey: [domain, operation, params],
    queryFn: () => api[domain][operation](params),
    refetchInterval: intervalMs,
  });
}
```

### File Structure

```
src/web/
  client/                     # Svelte 5 SPA
    App.svelte               # Root component + router
    routes/
      Dashboard.svelte       # /
      Tasks.svelte           # /tasks
      Graph.svelte           # /graph (D3 integration)
      Sessions.svelte        # /sessions
      Releases.svelte        # /releases
      Health.svelte          # /health
      Analytics.svelte       # /analytics (Phase 2)
      Brain.svelte           # /brain (Phase 2)
    components/
      MetricCard.svelte
      StatusBadge.svelte
      TaskRow.svelte
      TaskDetailPanel.svelte
      ProgressBar.svelte
      FilterPill.svelte
      Panel.svelte
    lib/
      api.generated.ts       # Generated typed client (do not edit)
      api-error.ts           # CleoApiError class
      use-poll.ts            # TanStack Query polling wrapper
      keyboard.ts            # Vim-style keyboard handler
    stores/
      filters.svelte.ts      # Filter state (runes)
      ui.svelte.ts           # UI state (selected task, open panel)
    app.css                  # CSS custom properties
    vite.config.ts           # Vite config for SPA build
  server/
    index.ts                 # Entry point (startServer)
    server.ts                # Fastify setup
    port-manager.ts          # Dynamic port + portfile read/write
    routes/
      dispatch.ts            # POST /api/query, POST /api/mutate
      poll.ts                # GET /api/poll (ETag change detection)
      health.ts              # GET /health, GET /ready
      static.ts              # Serve built SPA files
    lib/
      response.ts            # sendDispatchResponse + header mapping
      etag.ts                # ETag computation from DB fingerprint
      exit-code-map.ts       # Exit code -> HTTP status mapping
  codegen/
    generate-client.ts       # Registry -> typed client generator
  cli/
    web-command.ts           # cleo web start|stop|status|open
```

---

## 11. Security Model

### Localhost-Only

The server MUST bind to `127.0.0.1`. Network-level isolation is the primary security boundary for the MVP.

### No Authentication (MVP)

For the MVP phase, no authentication is required. The localhost binding provides sufficient access control for a solo-developer tool.

### CORS

CORS MUST be restricted to localhost origins only:

```typescript
await server.register(cors, {
  origin: [
    /^http:\/\/localhost(:\d+)?$/,
    /^http:\/\/127\.0\.0\.1(:\d+)?$/,
  ],
  credentials: true,
});
```

### Input Validation

All dispatch requests are validated by Zod schemas (`DispatchQuerySchema`, `DispatchMutateSchema`) before reaching the Dispatcher. Malformed requests are rejected with HTTP 400 before any dispatch occurs.

The existing dispatch sanitizer (`src/dispatch/lib/security.ts`) provides additional runtime validation:
- Task ID format validation (`T###`)
- Path traversal character stripping
- String length limits (64KB)
- Control character removal

### Future: Token Authentication

For remote access (non-localhost), a token-based authentication scheme MAY be added:

```
Authorization: Bearer <cleo-web-token>
```

Token generation and management would be handled via `cleo web token generate`. This is out of scope for the MVP.

---

## 12. Implementation Phases

### Phase 1: Server + Dispatch + Polling

- Fastify server with dynamic port + portfile
- Health (`/health`) and readiness (`/ready`) endpoints
- `POST /api/query` and `POST /api/mutate` dispatch endpoints
- `GET /api/poll` ETag-based change detection
- Zod validation for dispatch request envelope
- Response translation (data in body, metadata in headers)
- LAFS on-demand mode (`Accept: application/vnd.lafs+json`)
- Exit code -> HTTP status mapping
- `cleo web start|stop|status|open` CLI commands
- Client codegen script (`npm run generate-client`)

### Phase 2: Frontend + Generated Client

- Svelte 5 SPA scaffold (Vite build, client-side routing)
- Generated typed client integrated with TanStack Query
- Dashboard view (task list, metric cards, session status)
- ETag-based polling for data freshness
- Dark-first theme with CSS custom properties

### Phase 3: Visualization + Analytics

- D3 dependency graph view (force-directed layout)
- Chart panels (velocity, cycle time, phase progress)
- Task detail slide-out panel
- Activity feed with 3-second polling
- Keyboard navigation (vim-style j/k)

### Phase 4: Write Operations + Real-Time (if needed)

- All mutation operations enabled for browser clients
- Optimistic update patterns for task status changes
- Confirmation dialogs for destructive operations
- Phase 3+ MAY add SSE for activity feed IF user demand warrants it

---

## 13. Success Criteria

| Criterion | Target |
|-----------|--------|
| All dispatch operations accessible via HTTP | 152 / 152 |
| Hand-written route handlers | 0 (two dispatch endpoints + codegen) |
| Full type coverage in generated client | 152 / 152 operations with precise types |
| LAFS compliance on every response | 100% (headers + status codes by default; full envelope on-demand) |
| Cold start time | < 2 seconds |
| Query p95 latency | < 50ms |
| Port published to portfile | < 1 second after startup |
| Dashboard data freshness | Within polling interval (default 5s) after any CLEO operation |
| Localhost-only binding enforced | 127.0.0.1 only |

---

## 14. File Structure (Complete)

```
src/web/
  client/                     # Svelte 5 SPA (Phase 2+)
    App.svelte
    routes/                   # View components
    components/               # Reusable UI components
    lib/
      api.generated.ts        # Generated typed client
      api-error.ts            # Error handling
      use-poll.ts             # Polling integration
      keyboard.ts             # Keyboard navigation
    stores/                   # Svelte rune-based state
    app.css                   # Theme + global styles
    vite.config.ts
  server/                     # Fastify HTTP server (Phase 1)
    index.ts                  # Entry point
    server.ts                 # Fastify + plugin registration
    port-manager.ts           # Port + portfile lifecycle
    routes/
      dispatch.ts             # POST /api/query, POST /api/mutate
      poll.ts                 # GET /api/poll
      health.ts               # GET /health, GET /ready
      static.ts               # Static file serving
    lib/
      response.ts             # DispatchResponse -> HTTP translation
      etag.ts                 # ETag computation
      exit-code-map.ts        # CLEO exit code -> HTTP status
  codegen/
    generate-client.ts        # OperationRegistry -> typed client
  cli/
    web-command.ts            # cleo web start|stop|status|open
```

---

## Appendix A: Dispatch Adapter Comparison

| Aspect | MCP Adapter | CLI Adapter | Web Adapter (this spec) |
|--------|-------------|-------------|-------------------------|
| Transport | stdio | process | HTTP |
| Source | `'mcp'` | `'cli'` | `'http'` |
| Middleware count | 7 | 4 | 7 (same as MCP) |
| LAFS envelope in body | Always | Never | On-demand |
| LAFS metadata channel | `_meta` in body | `process.exit()` | `X-Cleo-*` headers |
| Subscriptions | No | No | No (polling; Phase 4 MAY add SSE) |
| Type safety | MCP SDK types | Commander.js | Generated typed client + Zod |
| Entry point | `src/dispatch/adapters/mcp.ts` | `src/dispatch/adapters/cli.ts` | `src/web/server/index.ts` |

## Appendix B: Research References

- **claude-mem Webapp Analysis** (`.cleo/research/claude-mem-webapp-analysis.md`): Dual-process model, SSE broadcaster pattern, health/readiness separation, route handler architecture
- **CLEO Dispatch Architecture Map** (`.cleo/research/cleo-dispatch-architecture-map.md`): Complete 152-operation registry, LAFS envelope types, middleware pipeline, exit code registry
- **tRPC Typesafe API Patterns** (`.cleo/research/trpc-typesafe-api-patterns.md`): Dynamic router generation analysis, Fastify adapter evaluation, Zod schema patterns
- **Challenge: LAFS Envelope Strategy** (`.cleo/research/challenge-lafs-envelope-strategy.md`): Transport-specific LAFS compliance, header-based metadata, on-demand envelope mode
- **Challenge: tRPC vs Alternatives** (`.cleo/research/challenge-trpc-vs-alternatives.md`): `/dispatch` pattern recommendation, comparison matrix, generated client analysis
- **Challenge: Frontend Framework** (`.cleo/research/challenge-frontend-framework.md`): Svelte 5 recommendation, D3 integration strategy, SvelteKit rejection
- **Challenge: Real-Time Strategy** (`.cleo/research/challenge-realtime-strategy.md`): Smart polling recommendation, file watching rejection, SQLite WAL analysis
