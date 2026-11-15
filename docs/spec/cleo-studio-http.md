# CLEO Studio HTTP Specification

**Status**: current surface (describes what ships; no proposed endpoints)
**Scope**: `packages/studio/src/routes/api/**/+server.ts` — every HTTP endpoint the Studio SvelteKit app exposes, plus the server code they share

Studio is a SvelteKit application under `packages/studio/`. Its `/api/**`
endpoints serve its own pages; `cleo web start|stop|restart|status|open`
runs and opens it (default host `127.0.0.1`).

---

## 1. Stores

CLEO keeps one `cleo.db` per scope; Studio reads both:

| Scope | File | What Studio reads there |
|-------|------|-------------------------|
| Project | `<project>/.cleo/cleo.db` | `tasks_*` (tasks, sessions, audit), `brain_*`, `conduit_*`, and the NEXUS code graph (`nexus_nodes`, `nexus_relations`, …) |
| Global | `<cleoHome>/cleo.db` | the NEXUS project registry (`nexus_project_registry`), `agent_registry_*` |

`<cleoHome>` is `~/.local/share/cleo` on Linux and `~/Library/Application Support/cleo`
on macOS; `CLEO_HOME` overrides it. Paths are resolved by
`packages/studio/src/lib/server/cleo-home.ts`, which delegates to core's
`resolveDualScopeDbPath('project' | 'global')`.

Store opens live in `packages/studio/src/lib/server/db/connections.ts`
(on the DB-open allowlist). Its getters keep legacy names, but each one opens a
`cleo.db`:

| Getter | Opens |
|--------|-------|
| `getTasksDb(ctx)`, `getBrainDb(ctx)` | the project `cleo.db` (both `ctx.tasksDbPath` and `ctx.brainDbPath` point at it), a fresh handle per call |
| `getNexusDb()`, `getAgentRegistryDb()` | the global `cleo.db`, cached per process |
| `getConduitDb(ctx)` | `<project>/.cleo/conduit.db` — a file that no longer exists, so this returns `null` (see §8) |
| `withStudioReadSnapshot(path, read)` | a read-only snapshot, closed after `read` (used by `/api/health`) |

Many endpoints do not open a store themselves: they call `@cleocode/core`
(task, session and memory APIs) or `@cleocode/brain` (`getAllSubstrates`), or shell
out to the `cleo` CLI.

---

## 2. Request context, guards and audit

- **Project context.** `packages/studio/src/hooks.server.ts` reads the
  `cleo_project_id` cookie and resolves it against `nexus_project_registry` in the
  global `cleo.db` (`resolveProjectContext`). With no cookie, or an unknown id, it
  falls back to the project of the Studio process (`resolveDefaultProjectContext`).
  The result is `event.locals.projectCtx`. The cookie lasts 7 days and is set by
  `POST /api/project/switch`.
- **Same-origin guard.** `POST`, `PUT`, `PATCH` and `DELETE` on paths that start with
  `/api/project` or `/api/tasks` must carry an `Origin` or `Referer` header whose
  host matches the server's. A request with neither header fails the guard. A
  failure returns `403` with
  `{ success: false, error: { code: "E_CROSS_ORIGIN", message } }`.
  The guard does not cover any other route (see §8).
- **CSRF cookie.** Every response refreshes a `cleo_csrf` cookie (a hash of a
  per-process salt and the project id). The server does not validate the `X-CSRF`
  header yet (`packages/studio/src/lib/server/csrf.ts`).
- **Authentication.** None. Studio binds to loopback by default.
- **Action audit.** `/api/project/{backup,doctor,gc,reindex-all}` append a line to
  `<projectPath>/.cleo/audit/studio-actions.jsonl`
  (`packages/studio/src/lib/server/audit-log.ts`); `GET /api/project/audit` reads it.

---

## 3. Response shapes

The surface does not use one envelope. Four shapes are in use:

| Shape | Where |
|-------|-------|
| Bare JSON (`{ tasks, rollups, total }`, `{ nodes, edges, … }`), errors as `{ error: "<message>" }` with an HTTP status | most read endpoints: `/api/tasks` GET, `/api/tasks/[id]` GET, `/api/brain/*`, `/api/nexus/*`, `/api/memory/quality` |
| `{ success, data \| error: { code, message }, meta: { at } }` from `routes/api/memory/_lafs.ts` and `routes/api/tasks/_dispatch.ts` | memory writes, `/api/credentials*`, `/api/setup/section/[name]`, the task write endpoints |
| The CLI's own LAFS envelope, passed through by `executeCliAction()` (`packages/studio/src/lib/server/cli-action.ts`); a failing CLI call returns `400` with `{ success: false, error: { code, message }, meta: { exitCode } }` | `/api/project/{[id],[id]/index,[id]/reindex,clean,scan,doctor,gc}`, `POST /api/project/backup` |
| `{ success, data, meta: { operation, duration_ms, timestamp } }` | `/api/search` |

None of these is the canonical LAFS envelope (`docs/spec/lafs-envelope-contract.md`)
except where the CLI's envelope passes through unchanged.

---

## 4. Endpoints

### 4.1 Tasks (`/api/tasks`)

Reads go through `@cleocode/core` (`listTasks`, `showTask`, `taskDeps`, `taskTree`,
`findTasks`, `listSessions`, `computeTaskRollups`, `computeTaskViews`); no raw SQL,
except the `/api/tasks/events` poll.

| Method | Path | Params / body | Response |
|--------|------|---------------|----------|
| GET | `/api/tasks` | `status` (pending, active, blocked, done, cancelled, archived, proposed), `priority` (critical, high, medium, low), `type` (epic, task, subtask), `limit` (default 200, max 1000) | `{ tasks, rollups, views, total }` |
| POST | `/api/tasks` | `{ title, acceptance (string[] or newline/pipe-separated string, required), parent?, priority? }` | `{ success, data: { taskId, via: "gateway" \| "core" } }` |
| GET | `/api/tasks/[id]` | — | task row (snake_case), `subtasks`, `view`; `404 { error: "not found" }` |
| PATCH | `/api/tasks/[id]` | any of `{ title, status, priority, assignee }` | `{ success, data: { taskId, via, changed } }`; `400 E_VALIDATION` when no field is patchable |
| DELETE | `/api/tasks/[id]` | — | `{ success, data: { taskId, via, changed: ["deleted"] } }` |
| GET | `/api/tasks/[id]/deps` | — | upstream and downstream tasks plus a readiness flag |
| POST | `/api/tasks/[id]/transition` | `{ fromLane, toLane }` | re-validates the lane move, then a `tasks.update`; an invalid move returns `422` with code `E_INVALID_TRANSITION:<reason>` |
| POST | `/api/tasks/[id]/dispatch` | `{ tier?: 0 \| 1 \| 2 }` (default 1) | spawns a worker through the gateway (`orchestrate.spawn`): `{ taskId, tier, spawn }`; `503 E_GATEWAY_UNREACHABLE` when the daemon is down |
| GET | `/api/tasks/[id]/stream` | — | SSE worker view for one task (frames `connected`, `output`, `usage`, `checkpoint`, `heartbeat`, `done`), built from the session claiming the task and its token usage |
| GET | `/api/tasks/events` | — | SSE: polls `tasks_tasks` every 2 s; events `connected`, `task-updated { latestChange, activeCount }`, `heartbeat` |
| GET | `/api/tasks/subscribe` | `root?` | SSE of `GatewayStreamEvent` frames: proxies the gateway's `GET /v1/tasks/subscribe` when the daemon answers, else a local change detector over `listTasks` |
| GET | `/api/tasks/graph` | `epic=T###` (epic subtree) or `taskId=T###` (one-hop neighbourhood) | `{ nodes, edges }` |
| GET | `/api/tasks/pipeline` | — | `{ stages: [{ id, label, count, tasks, rollups }] }`, grouped by the rollup's `pipelineStage` |
| GET | `/api/tasks/search` | `q` | `{ kind: "id", task }`, `{ kind: "title", tasks, total }` or `{ kind: "empty" }` |
| GET | `/api/tasks/sessions` | `limit` (default 50, max 200) | recent sessions; `workedTasks` is always empty |
| GET | `/api/tasks/tree/[epicId]` | — | nested epic tree, three levels |

**Write path.** `POST /api/tasks`, `PATCH`/`DELETE /api/tasks/[id]` and
`/transition` call the `/v1` gateway SDK client first (`createCleoClient`, base URL
from `CLEO_GATEWAY_URL`, default `http://127.0.0.1:7421`). When the daemon is
unreachable they fall back to the in-process `@cleocode/core` engine (`addTask`,
`updateTask`, `deleteTask`). `/dispatch` has no fallback.

### 4.2 Memory (`/api/memory`)

All read the project `cleo.db`.

| Method | Path | Params / body | Source |
|--------|------|---------------|--------|
| GET | `/api/memory/decisions` | — | `getDecisions` → `{ decisions, total }` |
| GET | `/api/memory/learnings` | `limit` | `getLearnings` |
| GET | `/api/memory/patterns` | `type` (workflow, blocker, success, failure, optimization), `limit` | `getPatterns` |
| GET | `/api/memory/observations` | `tier`, `type`, `min_quality` | `getObservations` |
| GET | `/api/memory/find` | `q`, `tables` (csv), `limit` (default 25, max 100) | `findMemoryEntries` |
| GET | `/api/memory/graph` | — | `getMemoryGraph` (aggregate counts only) |
| GET | `/api/memory/tier-stats` | — | per-table tier counts and upcoming long-tier promotions |
| GET | `/api/memory/pending-verify` | `minCitations` (default 5), `limit` (default 50, max 200) | unverified, cited entries |
| GET | `/api/memory/quality` | — | raw SQL over the `brain_*` tables |
| GET | `/api/memory/reason-why` | `taskId` | raw SQL walk of unresolved blockers over `tasks_*` and `brain_*` |
| POST | `/api/memory/observe` | `{ title, text, type?, project? }` | `observeBrain` |
| POST | `/api/memory/decision-store` | `{ decision, rationale, alternatives?, taskId?, contextEpicId?, contextPhase? }` | raw insert into `brain_decisions` |
| POST | `/api/memory/learning-store` | `{ insight, source, confidence?, actionable?, application?, applicableTypes? }` | raw insert into `brain_learnings` (dedups on insight) |
| POST | `/api/memory/pattern-store` | `{ pattern, context, type?, impact?, antiPattern?, mitigation?, examples? }` | raw insert into `brain_patterns` |
| POST | `/api/memory/verify` | `{ id, agent? }` | sets `verified` on the row; the id prefix (`O-`, `D-`, `P-`, `L-`) picks the table |

### 4.3 Brain super-graph (`/api/brain`, `/api/v1/graph`)

`/api/brain*` call `getAllSubstrates()` from `@cleocode/brain`. The substrate names
are `brain`, `nexus`, `tasks`, `conduit` and `agent-registry`.

| Method | Path | Params | Response |
|--------|------|--------|----------|
| GET | `/api/brain` | `tier` (0 = 200 nodes, 1 = 1000, 2 = 5000), `limit` (max 5000), `substrates` (csv), `min_weight` | `{ nodes, edges, counts, truncated }`; tier 0 is cached |
| GET | `/api/brain/chunks` | `tier` (1 or 2), `substrates`, `min_weight` | `application/x-ndjson`: `chunk` lines, then a `done` line |
| GET | `/api/brain/node/[id]` | substrate-prefixed id (`brain:O-…`, `tasks:T…`, …) | `{ node, neighbors, edges }`; `404` when absent |
| GET | `/api/brain/substrate/[name]` | `limit` (default 500, max 2000), `min_weight` | one substrate's graph; `400` for an unknown name |
| GET | `/api/brain/stream` | — | SSE: `hello`, `heartbeat` (30 s), `node.create`, `edge.strengthen`, `task.status`, `message.send`; polls every 1 s |
| GET | `/api/v1/graph` | `limit` (default 500, max 5000) | `{ nodes, edges, totalNodes, totalEdges }` from `brain_page_nodes` / `brain_page_edges` |

### 4.4 Code graph and search (`/api/nexus`, `/api/search`)

These read `nexus_nodes` and `nexus_relations` through `getNexusDb()`, which opens
the **global** `cleo.db`. The code graph lives in the **project** `cleo.db`, so these
endpoints read the global store's empty graph tables (see §8).

| Method | Path | Params | Response |
|--------|------|--------|----------|
| GET | `/api/nexus` | `only=communities` | `{ communities, edges, totalNodes, totalRelations }` |
| GET | `/api/nexus/community/[id]` | — | community members and their edges |
| GET | `/api/nexus/search` | `q` | symbol matches |
| GET | `/api/nexus/symbol/[name]` | — | the symbol and its two-hop neighbourhood |
| GET | `/api/search` | `q` (at least 2 characters), `scope` (`all` or `current`), `limit` (default 20, max 100) | `{ success, data: { query, scope, results, totalHits }, meta }` |

### 4.5 Projects and maintenance (`/api/project`)

| Method | Path | Body | Does |
|--------|------|------|------|
| POST | `/api/project/switch` | `{ projectId }` | sets the `cleo_project_id` cookie; `{ success: true }` |
| DELETE | `/api/project/[id]` | — | `cleo nexus projects remove <id> --json` |
| POST | `/api/project/[id]/index` | — | `cleo nexus analyze <path> --json` |
| POST | `/api/project/[id]/reindex` | — | the same command as `/index` |
| POST | `/api/project/reindex-all` | `{ onlyStale?, staleDays? (default 7) }` | `cleo nexus analyze` over every registered project, one at a time |
| POST | `/api/project/scan` | `{ roots?, maxDepth?, autoRegister? }` | `cleo nexus projects scan --json` |
| POST | `/api/project/clean` | `{ includeTemp?, includeTests?, includeUnhealthy?, includeNeverIndexed?, pattern?, dryRun? }` | `cleo nexus projects clean --json`; dry run unless `dryRun: false` |
| GET | `/api/project/backup` | — | lists `<project>/.cleo/backups/sqlite/` |
| POST | `/api/project/backup` | `{ note? }` | `cleo backup add --json` |
| GET | `/api/project/migrate` | — | `PRAGMA user_version` of the global and project stores; never migrates |
| GET | `/api/project/audit` | `limit` (default 50, max 500) | newest entries of `studio-actions.jsonl` |
| POST | `/api/project/doctor` | `{ projectId?, path? }` | shells out to `cleo nexus doctor --json`, a command that does not exist (see §8) |
| POST | `/api/project/gc` | `{ dryRun? }` | shells out to `cleo nexus gc --json`, a command that does not exist (see §8) |

The CLI is spawned by `packages/studio/src/lib/server/spawn-cli.ts`
(`CLEO_BIN`, default `cleo`).

### 4.6 System, credentials and setup

| Method | Path | Body | Does |
|--------|------|------|------|
| GET | `/api/health` | — | read-only snapshot probes: `nexus_nodes`, `brain_observations`, `tasks_tasks` and `conduit_messages` in the project store; `nexus_project_registry` and `agent_registry_agents` in the global store. Returns `{ ok, okScope, service, version, checkedAt, uptime, projectId, coverage, databases }`; `version` comes from Studio's `package.json` |
| GET | `/api/credentials` | — | credential-pool entries with all secret material removed |
| POST | `/api/credentials` | `{ provider, label, apiKey }` | adds an `api_key` credential |
| DELETE | `/api/credentials/[provider]/[label]` | — | removes a credential (same steps as `cleo auth remove`); returns `cleaned[]` and `hints[]` |
| POST | `/api/setup/section/[name]` | wizard options (`nonInteractive`, `provider`, `apiKey`, `harness`, …) | runs one `@cleocode/core/setup` wizard section; `{ section, success, changes, summary }` |

---

## 5. Streams

| Endpoint | Transport | Cadence |
|----------|-----------|---------|
| `/api/tasks/events` | SSE | 2 s poll |
| `/api/tasks/[id]/stream` | SSE | 2 s poll |
| `/api/tasks/subscribe` | SSE | gateway proxy, else local poll |
| `/api/brain/stream` | SSE | 1 s poll, 30 s heartbeat |
| `/api/brain/chunks` | NDJSON | one response per tier |

No endpoint uses WebSocket.

---

## 6. Page routes

Pages (`+page.svelte`, most with a `+page.server.ts` load): `/`, `/brain` and
`/brain/{3d,causal,decisions,graph,learnings,observations,overview,patterns,quality,search,tier-stats}`,
`/code`, `/code/community/[id]`, `/code/flows`, `/code/symbol/[name]`, `/keys`,
`/projects`, `/settings/vault`, `/setup`, `/studio/[projectId]`,
`/studio/[projectId]/[sagaId]`, `/tasks`, `/tasks/[id]`, `/tasks/graph`,
`/tasks/kanban`, `/tasks/pipeline`, `/tasks/sessions`, `/tasks/tree/[epicId]`.

---

## 7. Renamed endpoints

Earlier versions of this spec listed `/api/brain/{decisions,graph,observations,quality,tier-stats}`
and `/api/living-brain/*`. They are gone: the memory reads are under `/api/memory/*`
and the super-graph is under `/api/brain/*`.

---

## 8. Known defects

These are tracked in T14606.

1. **Code-graph endpoints read the wrong store.** `/api/nexus/*` and `/api/search`
   query `nexus_nodes` through `getNexusDb()`, which opens the global `cleo.db`.
   The graph is in the project `cleo.db` (`packages/core/src/store/nexus-sqlite.ts`
   header; `/api/health` probes it there). The global store holds only empty graph tables.
2. **Conduit is never read.** `getConduitDb()` and `getDbStatus()` look for
   `<project>/.cleo/conduit.db`. `conduit_messages` is in the project `cleo.db`,
   so `/api/brain/stream` never emits `message.send`.
3. **Two maintenance endpoints call missing commands.** `cleo nexus doctor` and
   `cleo nexus gc` do not exist, so `/api/project/doctor` and `/api/project/gc`
   always fail with `400 CLI_FAILURE`.
4. **Write routes outside the guard.** The same-origin guard covers only `/api/project`
   and `/api/tasks`. `POST`/`DELETE /api/credentials*`, `POST /api/setup/section/*`
   and the `POST /api/memory/*` writes are unguarded.
5. **Unclosed handles.** `getTasksDb`/`getBrainDb` open a fresh handle on every call.
   `/api/tasks/events`, `/api/brain/stream` and several memory reads never close
   them; the two streams open a new one on every tick.
6. **Substrate error text.** `/api/brain/substrate/[name]` accepts `agent-registry`,
   but its 400 message lists `signaldock`.

---

## References

- `packages/studio/src/routes/api/**/+server.ts` — handlers
- `packages/studio/src/hooks.server.ts` — project context and same-origin guard
- `packages/studio/src/lib/server/db/connections.ts` — store opens
- `packages/studio/src/lib/server/project-context.ts` — cookie and registry lookup
- `packages/studio/src/lib/server/cleo-home.ts` — store paths
- `packages/studio/src/lib/server/csrf.ts`, `audit-log.ts`, `cli-action.ts`, `spawn-cli.ts`
- `packages/studio/src/routes/api/memory/_lafs.ts`, `packages/studio/src/routes/api/tasks/_dispatch.ts` — envelope helpers and gateway client
- `docs/spec/lafs-envelope-contract.md` — canonical envelope
- `docs/spec/cleo-tasks-api.md` — tasks API
- `docs/spec/cleo-task-dashboard.md` — Studio task UI
