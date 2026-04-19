# CLEO Studio HTTP Specification

**Version**: 1.0.0
**Status**: AUTHORITY (current surface + PROPOSED CRUD additions)
**Scope**: `packages/studio/src/routes/api/**` — all HTTP endpoints exposed by the Studio SvelteKit app
**Authority pointer**: `docs/specs/CLEO-API-AUTHORITY.md` §2 (row: Studio HTTP)

This document is the canonical reference for the Studio HTTP surface. It
describes (a) the 30 endpoints live today, (b) the envelope contract they use
and how it diverges from canonical LAFS, (c) the 41 PROPOSED endpoints needed
to close the CRUD gap, and (d) the proposed auth model.

> **Companion specs**:
> - `docs/specs/CLEO-API-AUTHORITY.md` — authority chain
> - `docs/specs/CLEO-TASKS-API-SPEC.md` — per-domain Tasks spec
> - `docs/specs/CLEO-TASK-DASHBOARD-SPEC.md` — Studio UI layer
>
> **Evidence base**:
> - `.cleo/agent-outputs/T910-docs-audit/http-endpoint-inventory.md`
> - `/tmp/task-viz/CRUD-API-AUDIT.md` and `/tmp/task-viz/CRUD-ARCHITECTURE-CORRECTED.md`

---

## 1. Scope and Purpose

Studio is a SvelteKit application under `packages/studio/`. It exposes an
HTTP API under `/api/**` used by both its own server-rendered UI and
(optionally) external consumers on `127.0.0.1`.

**Today (2026-04-17):** 30 endpoints, heavily skewed toward reads. **0 task
writes**, **0 BRAIN writes**, **0 orchestration exposure**.

**Architectural intent** (per
`/tmp/task-viz/CRUD-ARCHITECTURE-CORRECTED.md` §1 and
`docs/specs/CLEO-API-AUTHORITY.md` §3): HTTP is a **transport adapter**,
structurally symmetric with the CLI adapter. Every endpoint MUST translate
its request into a dispatch call and return the resulting LAFS envelope
unchanged. No business logic lives in `+server.ts` handlers.

The HTTP adapter module is PROPOSED at
`packages/cleo/src/dispatch/adapters/http.ts` (sibling of
`packages/cleo/src/dispatch/adapters/cli.ts` — already exists).

---

## 2. Current HTTP Surface (30 endpoints)

All endpoints live under `packages/studio/src/routes/api/**`. Every handler
opens `tasks.db`, `brain.db`, or `nexus.db` through
`packages/studio/src/lib/server/db/connections.ts`, with one exception
flagged in §5.

Authentication: **none today**. Project context is resolved from a cookie by
`packages/studio/src/hooks.server.ts:19-24`. §6 proposes token-based auth.

### 2.1 Full endpoint table

| # | Path | Method | Domain | Purpose | Data source | Auth | Streaming |
|---|------|--------|--------|---------|-------------|------|-----------|
| 1 | `/api/brain/decisions` | GET | BRAIN | List `brain_decisions` chronologically | Direct SQL on `brain.db` via `getBrainDb(ctx)` | none | no |
| 2 | `/api/brain/graph` | GET | BRAIN | Top-500 nodes + endpoint-bounded edges | Direct SQL on `brain.db` (`brain_page_nodes`, `brain_page_edges`) | none | no |
| 3 | `/api/brain/observations` | GET | BRAIN | Filterable observations (200-row cap) | Direct SQL on `brain.db` (`brain_observations`) | none | no |
| 4 | `/api/brain/quality` | GET | BRAIN | Quality/tier/type histogram (4 tables) | Direct SQL on `brain.db` | none | no |
| 5 | `/api/brain/tier-stats` | GET | BRAIN | Tier distribution + upcoming long-tier promotions | Direct SQL on `brain.db` (4 tables) | none | no |
| 6 | `/api/health` | GET | system | Service heartbeat + per-DB availability | Helper `getDbStatus(ctx)` | none | no |
| 7 | `/api/living-brain` | GET | LB | Unified cross-substrate graph (5 substrates) | `getAllSubstrates()` → 5 adapters | none | no |
| 8 | `/api/living-brain/node/[id]` | GET | LB | Ego network for substrate-prefixed node | `getAllSubstrates({limit:2000})` then filter | none | no |
| 9 | `/api/living-brain/stream` | GET | LB | Live stream of cross-substrate events | Polling `brain.db`, `tasks.db`, `conduit.db` @1s | none | **SSE** |
| 10 | `/api/living-brain/substrate/[name]` | GET | LB | Single-substrate filtered graph | `getAllSubstrates({substrates:[name]})` | none | no |
| 11 | `/api/nexus` | GET | NEXUS | List all communities + member counts | Direct SQL on global `nexus.db` via `getNexusDb()` | none | no |
| 12 | `/api/nexus/community/[id]` | GET | NEXUS | Community drill-down (≤500 nodes, ≤2000 edges) | Direct SQL on global `nexus.db` | none | no |
| 13 | `/api/nexus/search` | GET | NEXUS | Symbol search (LIKE on label/id) | Direct SQL on global `nexus.db` | none | no |
| 14 | `/api/nexus/symbol/[name]` | GET | NEXUS | 2-hop ego network for symbol | Direct SQL on global `nexus.db` | none | no |
| 15 | `/api/project/clean` | POST | project | Dry-run cleanup of registered projects | CLI shell-out `cleo nexus projects clean --json` via `executeCliAction()` | none | no |
| 16 | `/api/project/[id]/index` | POST | project | Trigger full nexus analyze | CLI shell-out `cleo nexus analyze <path> --json` | none | no |
| 17 | `/api/project/[id]/reindex` | POST | project | Re-index alias | CLI shell-out `cleo nexus analyze <path> --json` | none | no |
| 18 | `/api/project/[id]` | DELETE | project | Remove project from registry | CLI shell-out `cleo nexus projects remove <id> --json` | none | no |
| 19 | `/api/project/scan` | POST | project | FS scan + optional auto-register | CLI shell-out `cleo nexus projects scan --json` | none | no |
| 20 | `/api/project/switch` | POST | project | Set active-project cookie | Helper `setActiveProjectId(cookies, id)` | none | no |
| 21 | `/api/search` | GET | NEXUS | Cross-project symbol search | Direct SQL on global `nexus.db` (opens OWN `DatabaseSync` — see §5) | project cookie read if `scope=current` | no |
| 22 | `/api/tasks` | GET | tasks | List with filters | Direct SQL on `tasks.db` | none | no |
| 23 | `/api/tasks/events` | GET | tasks | MAX(updated_at) / row-count SSE | Polling `tasks.db` @2s | none | **SSE** |
| 24 | `/api/tasks/graph` | GET | tasks | Sigma-ready epic graph / 1-hop neighborhood | Direct SQL on `tasks.db` (recursive CTE + `task_dependencies`) | none | no |
| 25 | `/api/tasks/[id]` | GET | tasks | Single task + its subtasks | Direct SQL on `tasks.db` | none | no |
| 26 | `/api/tasks/[id]/deps` | GET | tasks | Upstream + downstream + `allUpstreamReady` | Direct SQL on `tasks.db` | none | no |
| 27 | `/api/tasks/pipeline` | GET | tasks | Tasks grouped by `pipeline_stage` (RCASD-IVTR+C) | Direct SQL on `tasks.db` | none | no |
| 28 | `/api/tasks/search` | GET | tasks | ID or fuzzy-title search | Direct SQL on `tasks.db` | none | no |
| 29 | `/api/tasks/sessions` | GET | session | Recent sessions enriched with tasks (≤50) | Direct SQL on `tasks.db` (`sessions`, `task_work_history`, `tasks`) | none | no |
| 30 | `/api/tasks/tree/[epicId]` | GET | tasks | Nested epic tree (3 levels) + stats | Direct SQL on `tasks.db` (recursive CTE) | none | no |

**Totals**: 30 files, 30 handlers. 24× GET, 6× POST/DELETE. 2× SSE
(`/api/tasks/events`, `/api/living-brain/stream`). 0× WebSocket.

### 2.2 Evidence files

Inventoried in
`/mnt/projects/cleocode/.cleo/agent-outputs/T910-docs-audit/http-endpoint-inventory.md`:

```
packages/studio/src/routes/api/brain/decisions/+server.ts
packages/studio/src/routes/api/brain/graph/+server.ts
packages/studio/src/routes/api/brain/observations/+server.ts
packages/studio/src/routes/api/brain/quality/+server.ts
packages/studio/src/routes/api/brain/tier-stats/+server.ts
packages/studio/src/routes/api/health/+server.ts
packages/studio/src/routes/api/living-brain/+server.ts
packages/studio/src/routes/api/living-brain/node/[id]/+server.ts
packages/studio/src/routes/api/living-brain/stream/+server.ts
packages/studio/src/routes/api/living-brain/substrate/[name]/+server.ts
packages/studio/src/routes/api/nexus/+server.ts
packages/studio/src/routes/api/nexus/community/[id]/+server.ts
packages/studio/src/routes/api/nexus/search/+server.ts
packages/studio/src/routes/api/nexus/symbol/[name]/+server.ts
packages/studio/src/routes/api/project/clean/+server.ts
packages/studio/src/routes/api/project/scan/+server.ts
packages/studio/src/routes/api/project/switch/+server.ts
packages/studio/src/routes/api/project/[id]/+server.ts
packages/studio/src/routes/api/project/[id]/index/+server.ts
packages/studio/src/routes/api/project/[id]/reindex/+server.ts
packages/studio/src/routes/api/search/+server.ts
packages/studio/src/routes/api/tasks/+server.ts
packages/studio/src/routes/api/tasks/events/+server.ts
packages/studio/src/routes/api/tasks/graph/+server.ts
packages/studio/src/routes/api/tasks/pipeline/+server.ts
packages/studio/src/routes/api/tasks/search/+server.ts
packages/studio/src/routes/api/tasks/sessions/+server.ts
packages/studio/src/routes/api/tasks/tree/[epicId]/+server.ts
packages/studio/src/routes/api/tasks/[id]/+server.ts
packages/studio/src/routes/api/tasks/[id]/deps/+server.ts
```

Supporting infra:

- `packages/studio/src/hooks.server.ts` — project-context middleware.
- `packages/studio/src/lib/server/db/connections.ts` — `getNexusDb`,
  `getSignaldockDb`, `getBrainDb`, `getTasksDb`, `getConduitDb`,
  `getDbStatus`.
- `packages/studio/src/lib/server/cli-action.ts` — `executeCliAction()`
  wraps `runCleoCli()` (`spawn-cli.ts`) and emits LAFS envelopes. Used by
  the 5 `/api/project/*` write endpoints.
- `packages/studio/src/lib/server/living-brain/adapters/{index,brain,nexus,tasks,conduit,signaldock}.ts`
  — 5 substrate adapters.

---

## 3. Envelope Contract (current vs canonical)

### 3.1 Current state (non-compliant)

Most current handlers return **non-LAFS** shapes:

```json
// success
{ "tasks": [...], "total": 42 }

// error
{ "error": "not found" }   // + HTTP 404
```

Evidence: `packages/studio/src/routes/api/tasks/+server.ts:32-82`,
`/api/tasks/[id]/+server.ts:9-45`, etc. HTTP status is set directly via
`new Response(..., { status })`.

Only the 5 CLI-backed project endpoints
(`/api/project/{scan,clean,[id],[id]/index,[id]/reindex}`) emit LAFS
envelopes, because `executeCliAction()` forwards the CLI's envelope
unchanged.

**Consequences**:

- REST callers cannot receive the same structured error as CLI callers.
- Error `code`, `fix`, `alternatives`, and `details` are dropped.
- `_meta.page`, `_meta.durationMs`, `_meta.gateway` are absent.

### 3.2 Canonical LAFS envelope

Source: `packages/contracts/src/lafs.ts:52-299` and the re-exported
`@cleocode/lafs` package.

```ts
// Success
interface LafsEnvelopeSuccess<T> {
  success: true;
  data: T;
  warnings?: LAFSWarning[];
  _meta?: {
    gateway: string;            // e.g. 'studio-http'
    domain: string;             // e.g. 'tasks'
    durationMs: number;
    mvi?: 'standard' | 'minimal';
    transport?: 'http' | 'cli' | 'sse';
    page?: LAFSPageOffset;      // if paginated
    [key: string]: unknown;
  };
}

// Error
interface LafsEnvelopeError {
  success: false;
  error: {
    code: number | string;      // numeric or ExitCode name
    category: LAFSErrorCategory;
    message: string;
    fix?: string;
    alternatives?: string[];
    details?: Record<string, unknown>;
  };
  _meta?: { gateway; domain; durationMs; ... };
}
```

### 3.3 Migration path

Every current handler MUST be migrated to emit LAFS envelopes. Priority:

1. **Phase 1** (PROPOSED immediate): every new handler from §4 ships with
   LAFS from day one via `dispatchAsHttp()` — no legacy contract to preserve.
2. **Phase 2** (PROPOSED next): migrate existing read endpoints on
   `/api/tasks/*`, `/api/brain/*`, `/api/nexus/*` to LAFS. Studio UI
   components that read these endpoints MUST be updated to unwrap `data`.
3. **Phase 3** (PROPOSED): deprecate the old non-LAFS shapes with a 1-release
   overlap (both shapes returned simultaneously, guarded by an `Accept:
   application/lafs+json` header).

---

## 4. Proposed CRUD Additions (41 endpoints)

These endpoints close the write-side gap. Each ships as a thin
`+server.ts` handler that calls
`dispatchAsHttp('studio-http', '<domain>', '<op>', params)` — the helper
translates HTTP → dispatch params, forwards the LAFS envelope, and sets the
HTTP status per §3 ExitCode mapping.

Source design:
- `/tmp/task-viz/CRUD-API-AUDIT.md` §2 (original 68 CLI ops catalogued)
- `/tmp/task-viz/CRUD-ARCHITECTURE-CORRECTED.md` §2 (thin-adapter model)

> **Legend**
> Req body = TypeScript type sourced from `packages/contracts/src/operations/<domain>.ts`.
> Resp = `CleoResponse<T>` = LAFS envelope wrapping the named result type.
> Idempotent: Y iff same body → same final state; N iff each call creates new state.

### 4.1 Tasks CRUD (16 writes + 3 reads — 19 additions)

| # | Method | Path | Req body / query | Resp | Key error codes | Idempotent |
|---|--------|------|------------------|------|-----------------|------------|
| T1 | POST | `/api/tasks` | `TasksCreateParams` | `CleoResponse<{task}>` | `VALIDATION_ERROR` (400), `PARENT_NOT_FOUND` (404), `DEPTH_EXCEEDED` (409), `SIBLING_LIMIT` (409), `INVALID_PARENT_TYPE` (409), `ID_COLLISION` (409) | N |
| T2 | PATCH | `/api/tasks/:id` | `TasksUpdateParams` (merge) | `CleoResponse<{task, changes}>` | `NOT_FOUND` (404), `VALIDATION_ERROR` (400), `TASK_COMPLETED` (409), `LIFECYCLE_GATE_FAILED` (422), `CIRCULAR_REFERENCE` (409) | Y |
| T3 | DELETE | `/api/tasks/:id?cascade=…&force=…` | — | `CleoResponse<{deletedIds}>` | `NOT_FOUND` (404), `HAS_CHILDREN` (409), `HAS_DEPENDENTS` (409) | Y |
| T4 | POST | `/api/tasks/:id/complete` | `{notes?}` | `CleoResponse<{task, gates}>` | `NOT_FOUND` (404), `E_EVIDENCE_MISSING` (422), `E_EVIDENCE_STALE` (422), `E_FLAG_REMOVED` (410) | Y |
| T5 | POST | `/api/tasks/:id/cancel` | `{reason?}` | `CleoResponse<{task}>` | `NOT_FOUND` (404), `TASK_COMPLETED` (409) | Y |
| T6 | POST | `/api/tasks/:id/archive` | `{dryRun?}` | `CleoResponse<{task}>` | `NOT_FOUND` (404), `VALIDATION_ERROR` (400) | Y |
| T7 | POST | `/api/tasks/:id/restore` | `{from?, status?, reason?, cascade?}` | `CleoResponse<{task}>` | `NOT_FOUND` (404), `VALIDATION_ERROR` (400) | Y |
| T8 | POST | `/api/tasks/:id/reparent` | `{newParentId: string\|null}` | `CleoResponse<{task}>` | `NOT_FOUND` (404), `CIRCULAR_REFERENCE` (409) | Y |
| T9 | POST | `/api/tasks/:id/reorder` | `{position: number}` | `CleoResponse<{task}>` | `NOT_FOUND` (404), `VALIDATION_ERROR` (400) | Y |
| T10 | POST | `/api/tasks/:id/start` | — | `CleoResponse<{task, sessionId}>` | `NOT_FOUND` (404), `SESSION_REQUIRED` (409), `TASK_CLAIMED` (409) | Y |
| T11 | POST | `/api/tasks/stop` | — | `CleoResponse<{previousTaskId}>` | — | Y |
| T12 | POST | `/api/tasks/:id/claim` | `{agentId}` | `CleoResponse<{task}>` | `NOT_FOUND` (404), `TASK_CLAIMED` (409) | Y |
| T13 | POST | `/api/tasks/:id/unclaim` | — | `CleoResponse<{task}>` | `NOT_FOUND` (404) | Y |
| T14 | POST | `/api/tasks/:id/relates` | `{relatedId, type, reason?}` | `CleoResponse<{relation}>` | `NOT_FOUND` (404), `VALIDATION_ERROR` (400), `ALREADY_EXISTS` (200 NO_CHANGE) | Y |
| T15 | POST | `/api/tasks/:id/verify` | `{gate, evidence, ownerOverride?}` | `CleoResponse<{gate, passed, atoms}>` | `NOT_FOUND` (404), `INVALID_GATE` (400), `E_EVIDENCE_*` (422) | Y |
| T16 | GET | `/api/tasks/:id/gates` | — | `CleoResponse<{gates, allPassed}>` | `NOT_FOUND` (404) | Y |
| T17 | POST | `/api/tasks/sync/reconcile` | `{providerId, externalTasks, …}` | `CleoResponse<{reconciled, conflicts}>` | `VALIDATION_ERROR` (400) | Y |
| T18 | DELETE | `/api/tasks/sync/links` | `{providerId}` | `CleoResponse<{removed}>` | — | Y |
| T19 | HEAD | `/api/tasks/:id` | — | 200/404 + `TasksExistsResult` | — | Y |

### 4.2 Session (9 additions)

| # | Method | Path | Req body | Resp | Key error codes | Idempotent |
|---|--------|------|----------|------|-----------------|------------|
| S1 | GET | `/api/sessions/current` | — | `CleoResponse<{session?}>` | — | Y |
| S2 | GET | `/api/sessions?status=&limit=&offset=` | — | `CleoResponse<{sessions, total}>` | — | Y |
| S3 | GET | `/api/sessions/:id` | — | `CleoResponse<{session}>` | `SESSION_NOT_FOUND` (404) | Y |
| S4 | POST | `/api/sessions` | `{scope?, agent?, name?}` | `CleoResponse<{session}>` | `SESSION_EXISTS` (409) | N |
| S5 | POST | `/api/sessions/:id/end` | `{note: string}` (required) | `CleoResponse<{session}>` / `202 Accepted` if backup runs async | `SESSION_NOT_FOUND` (404), `SESSION_CLOSE_BLOCKED` (409), `VALIDATION_ERROR` (400) | Y |
| S6 | POST | `/api/sessions/:id/resume` | — | `CleoResponse<{session}>` | `SESSION_NOT_FOUND` (404) | Y |
| S7 | POST | `/api/sessions/:id/suspend` | — | `CleoResponse<{session}>` | `SESSION_NOT_FOUND` (404) | Y |
| S8 | POST | `/api/sessions/:id/decisions` | `{text, category?}` | `CleoResponse<{decision}>` | `SESSION_NOT_FOUND` (404), `VALIDATION_ERROR` (400) | N |
| S9 | POST | `/api/sessions/:id/gc` | — | `CleoResponse<{purged}>` | `SESSION_NOT_FOUND` (404) | Y |

### 4.3 Orchestrate (13 additions)

| # | Method | Path | Req body / query | Resp | Key error codes | Idempotent |
|---|--------|------|------------------|------|-----------------|------------|
| O1 | GET | `/api/orchestrate/ready?epic=T###` | — | `CleoResponse<{wave}>` | `NOT_FOUND` (404) | Y |
| O2 | GET | `/api/orchestrate/waves/:epicId` | — | `CleoResponse<{waves}>` | `NOT_FOUND` (404) | Y |
| O3 | GET | `/api/orchestrate/plan/:epicId` | — | `CleoResponse<{plan}>` | `NOT_FOUND` (404) | Y |
| O4 | GET | `/api/orchestrate/status/:taskId` | — | `CleoResponse<{status, ivtr}>` | `NOT_FOUND` (404) | Y |
| O5 | GET | `/api/orchestrate/pending` | — | `CleoResponse<{pending}>` | — | Y |
| O6 | POST | `/api/orchestrate/start/:epicId` | — | `CleoResponse<{pipeline}>` | `NOT_FOUND` (404), `LIFECYCLE_GATE_FAILED` (422), `SESSION_EXISTS` (409) | N |
| O7 | POST | `/api/orchestrate/spawn/:taskId` | `{tier?: 0\|1\|2}` | `CleoResponse<{spawnPayload}>` | `NOT_FOUND` (404), `SPAWN_VALIDATION_FAILED` (422) | Y |
| O8 | POST | `/api/orchestrate/spawn/:taskId/execute` | `{adapter?}` | `CleoResponse<{spawnResult}>` | `THIN_AGENT_VIOLATION` (403), `ATOMICITY_VIOLATION` (422) | N |
| O9 | POST | `/api/orchestrate/approve/:token` | — | `CleoResponse<{token, approved: true}>` | `NOT_FOUND` (404) | Y |
| O10 | POST | `/api/orchestrate/reject/:token` | `{reason?}` | `CleoResponse<{token, rejected: true}>` | `NOT_FOUND` (404) | Y |
| O11 | POST | `/api/orchestrate/ivtr/:taskId/start` | — | `CleoResponse<{phase}>` | `NOT_FOUND` (404) | N |
| O12 | POST | `/api/orchestrate/ivtr/:taskId/next` | — | `CleoResponse<{phase}>` | `NOT_FOUND` (404), `E_IVTR_INCOMPLETE` (422) | N |
| O13 | POST | `/api/orchestrate/ivtr/:taskId/release` | `{note?}` | `CleoResponse<{phase}>` | `NOT_FOUND` (404) | Y |

### Summary counts

- Tasks: 19 new (16 writes + 3 reads)
- Session: 9 new
- Orchestrate: 13 new
- **Total: 41 new endpoints**

Plus migration of the 30 existing endpoints to LAFS envelope format (§3.3).

BRAIN and NEXUS writes are **deferred** pending contract SSoT work (see
`docs/specs/CLEO-API-AUTHORITY.md` §2 "Open gaps" and the
`docs/specs/memory-architecture-spec.md` roadmap).

---

## 5. Known Drift and Inconsistencies (MUST FIX)

Flagged during the T910 audit. Each is a SHOULD-fix in the CRUD rollout.

### 5.1 Hardcoded version in `/api/health`

`packages/studio/src/routes/api/health/+server.ts` embeds a literal version
string `"2026.4.47"`. Current package version at audit time is `2026.4.96`.

**Fix** (PROPOSED): replace with a dynamic read from the cleocode `package.json`
at startup, or call `dispatch.query('admin', 'system.version', {})` and
surface the result. A test MUST assert the embedded string does not drift.

### 5.2 Second `nexus.db` connection in `/api/search`

`packages/studio/src/routes/api/search/+server.ts` constructs its own
`DatabaseSync` instead of reusing the cached `getNexusDb()` from
`packages/studio/src/lib/server/db/connections.ts`. This bypasses the
connection helper and risks lock contention.

**Fix** (PROPOSED): route all nexus reads through `getNexusDb()`.

### 5.3 Non-LAFS envelopes on 25 of 30 endpoints

See §3.1. Migration plan in §3.3.

### 5.4 Zero authentication

See §6. Today any local process on localhost can write via POST/DELETE on
the 5 CLI-backed routes. With the 41 new write endpoints from §4, this
becomes a material risk.

### 5.5 Two SSE endpoints use 1s and 2s poll intervals

`/api/living-brain/stream` polls at 1s
(`packages/studio/src/routes/api/living-brain/stream/+server.ts`).
`/api/tasks/events` polls at 2s
(`packages/studio/src/routes/api/tasks/events/+server.ts:15-86`). This is
acceptable for local development but NOT for multi-client load.

**Fix** (PROPOSED): unify behind a per-DB watermark notifier and
bias toward WebSocket or Server-Sent-Events with proper backpressure
before enabling multi-client use.

---

## 6. Auth Model (PROPOSED)

### 6.1 Current state

Zero authentication. Cookie-based project context only.

### 6.2 Phase 1 — Token header (Jupyter-style)

All `POST / PATCH / DELETE` endpoints MUST require:

```
X-CLEO-Token: <hex>
```

- The token is auto-generated on `cleo studio start` into
  `~/.cleo/studio-token` with `0600` perms.
- Studio UI reads it server-side and injects it on the first page load as
  an HTTP-only cookie for XHR calls.
- Absence or mismatch returns `401 Unauthorized` + LAFS error envelope.

### 6.3 Phase 1 — Localhost bind

Studio dev server SHOULD bind to `127.0.0.1` by default. Exposing beyond
localhost requires explicit `--host 0.0.0.0` flag + token as above.

### 6.4 Phase 1 — Owner override header

Maps to the existing `CLEO_OWNER_OVERRIDE=1` env var:

```
X-CLEO-Owner-Override: 1
X-CLEO-Override-Reason: <non-empty string>
```

Each request with these headers writes a line to
`.cleo/audit/force-bypass.jsonl`. Rejecting with `400` when
`X-CLEO-Owner-Override: 1` is present without a reason header.

### 6.5 Phase 1 — Rate limiting

Writes capped at 60/min per token to prevent runaway agent loops.
Exceeded → `429 Too Many Requests` + LAFS envelope with
`error.category: 'rate_limit'`.

### 6.6 Phase 2 (PROPOSED — out of scope for T910)

If Studio ever exposes beyond localhost, Better-Auth session cookies with
RBAC (`admin` / `orchestrator` / `read-only`). Not in this spec.

---

## 7. Implementation Plan

Per `/tmp/task-viz/CRUD-ARCHITECTURE-CORRECTED.md` §1 and
`docs/specs/CLEO-API-AUTHORITY.md` §3:

1. **Create HTTP adapter module** at
   `packages/cleo/src/dispatch/adapters/http.ts` (sibling of `cli.ts`).
   Exports `dispatchAsHttp(gateway, domain, op, params)`.
2. **Create `+server.ts` per endpoint** (~41 new files), each ≤ 40 lines,
   each calling `dispatchAsHttp()`.
3. **Migrate existing handlers** to use the same helper (Phase 2 of §3.3).
4. **Add auth middleware** in `packages/studio/src/hooks.server.ts` per §6.
5. **Fix drift** from §5 in the same PR wave.
6. **Add tests**:
   - Each new endpoint: one happy-path + one error-path integration test.
   - Envelope compliance: snapshot every response.
   - ExitCode → HTTP status mapping: unit test of `dispatchAsHttp()`.
7. **Document** in `docs/specs/CLEO-TASKS-API-SPEC.md` §5 (flip PROPOSED
   rows to "live").

Estimated scope: ~1500 LoC across 41 new handlers + 1 adapter module + 1
auth middleware + ~150 tests.

---

## 8. Relationship to CLEO-API-AUTHORITY

This spec is a **Layer-3 narrative** (per the authority chain in
`docs/specs/CLEO-API-AUTHORITY.md` §1). It describes ONE transport
(HTTP) of the CLEO dispatch API. The CLI transport
(`packages/cleo/src/dispatch/adapters/cli.ts`) is the only other
currently-shipping transport.

When an operation moves from PROPOSED to live, this spec's §2 tables MUST
be updated, the per-domain spec (e.g. `CLEO-TASKS-API-SPEC.md`) MUST flip
the PROPOSED marker, and `CLEO-OPERATION-CONSTITUTION.md` MUST be
re-synced with the registry.

---

## 9. Open Questions (HITL)

- **Q1 — DELETE cascade default** (`@HITL`). CLI defaults to REJECT
  (`HAS_CHILDREN 16`). Mirror on HTTP? Recommended: YES, require
  explicit `?cascade=true`. From `/tmp/task-viz/CRUD-API-AUDIT.md` §Open Q1.
- **Q2 — Evidence body format** (`@HITL`). Structured
  `evidence: EvidenceAtom[]` array vs CLI string format
  (`"commit:sha;files:a.ts,b.ts"`). Recommended: structured.
  From `/tmp/task-viz/CRUD-API-AUDIT.md` §Open Q3.
- **Q3 — Idempotency keys** (`@HITL`). `Idempotency-Key: <uuid>` header
  (Stripe-style) vs body-based idempotency? Recommended: body-based for v1.
- **Q4 — `POST /api/sessions/:id/end` sync vs async** (`@HITL`).
  `session.end` triggers auto-backup (slow). Sync response vs `202
  Accepted` + `jobId`? Recommended: `202` when backup queue empty.
- **Q5 — Unknown PATCH fields** (`@HITL`). 400 with `details.unknownFields`
  vs silent drop? Recommended: 400.
- **Q6 — Graph/tree pagination** (`@HITL`). Current endpoints hard-limit
  to 1000 nodes. Cursor pagination needed?
- **Q7 — SSE vs WebSocket** (`@HITL`). Unify on WebSocket for multi-domain
  events or keep per-domain SSE?

---

## 10. Backward Compatibility

The 30 existing endpoints MUST keep working during the Phase-2 envelope
migration. The `Accept` header gate:

- `Accept: application/json` → legacy shape (for now).
- `Accept: application/lafs+json` → canonical LAFS envelope.

After one full release cycle with `Accept: application/lafs+json` working,
the default flips and the legacy shape is retired.

---

## References

- `packages/studio/src/routes/api/**/+server.ts` — 30 current handlers
- `packages/studio/src/hooks.server.ts` — middleware
- `packages/studio/src/lib/server/db/connections.ts` — DB helpers
- `packages/studio/src/lib/server/cli-action.ts` — CLI passthrough wrapper
- `packages/studio/src/lib/server/spawn-cli.ts` — subprocess wrapper
- `packages/contracts/src/lafs.ts` — envelope contract
- `packages/contracts/src/exit-codes.ts` — error code enum
- `packages/cleo/src/dispatch/registry.ts` — op registration
- `packages/cleo/src/dispatch/adapters/cli.ts` — CLI adapter (sibling model)
- PROPOSED: `packages/cleo/src/dispatch/adapters/http.ts` — HTTP adapter
- `.cleo/agent-outputs/T910-docs-audit/http-endpoint-inventory.md`
- `/tmp/task-viz/CRUD-API-AUDIT.md`
- `/tmp/task-viz/CRUD-ARCHITECTURE-CORRECTED.md`
- `/tmp/task-viz/CRUD-CONTRACT.json`
- `docs/specs/CLEO-API-AUTHORITY.md`
- `docs/specs/CLEO-TASKS-API-SPEC.md`
- `.cleo/adrs/ADR-051-programmatic-gate-integrity.md`

---

**End.**
