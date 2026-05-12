# Studio HTTP Endpoint Inventory

> **Task**: T910 — full Studio HTTP surface audit (companion to tasks-only audit).
> **Scope**: `packages/studio/src/routes/api/**` + DB connection/middleware context.
> **Date**: 2026-04-17.
> **Source base**: `/mnt/projects/cleocode/packages/studio/src/`.
>
> Every row cites a file path. Where a data source is ambiguous, it is flagged.

---

## Section 1 — Existing HTTP endpoints (30 files, 30 routes)

| # | Path | Methods | Purpose | Request params | Response shape | Data source | Auth required? | Streaming? | File |
|---|------|---------|---------|----------------|----------------|-------------|----------------|------------|------|
| 1 | `/api/brain/decisions` | GET | List all `brain_decisions` ordered chronologically | none | `BrainDecisionsResponse { decisions: BrainDecision[]; total: number }` | **Direct SQL** on `brain.db` via `getBrainDb(locals.projectCtx)` | No (project cookie only) | No | `routes/api/brain/decisions/+server.ts` |
| 2 | `/api/brain/graph` | GET | Return top-500 nodes by quality + endpoint-bounded edges for force-directed graph | none | `BrainGraphResponse { nodes: BrainNode[]; edges: BrainEdge[]; total_nodes; total_edges }` | **Direct SQL** on `brain.db` (`brain_page_nodes`, `brain_page_edges`) | No | No | `routes/api/brain/graph/+server.ts` |
| 3 | `/api/brain/observations` | GET | Filterable observation list, 200-row cap | query: `tier`, `type`, `min_quality` | `BrainObservationsResponse { observations: BrainObservation[]; total; filtered }` | **Direct SQL** on `brain.db` (`brain_observations`) | No | No | `routes/api/brain/observations/+server.ts` |
| 4 | `/api/brain/quality` | GET | Quality bucket/tier/type histogram across all 4 brain tables | none | `BrainQualityResponse` (observations/decisions/patterns/learnings buckets) | **Direct SQL** on `brain.db` (`brain_observations`, `brain_decisions`, `brain_patterns`, `brain_learnings`) | No | No | `routes/api/brain/quality/+server.ts` |
| 5 | `/api/brain/tier-stats` | GET | Tier distribution + top-5 upcoming long-tier promotions (T748) | none | `TierStatsResponse { tables: TableTierCounts[]; upcomingLongPromotions }` | **Direct SQL** on `brain.db` (4 tables) | No | No | `routes/api/brain/tier-stats/+server.ts` |
| 6 | `/api/health` | GET | Service heartbeat + per-database availability | none | `{ ok; service; version; databases{nexus,brain,tasks}; paths{...} }` | **Helper** `getDbStatus(locals.projectCtx)` (inspects fs for each DB) | No | No | `routes/api/health/+server.ts` |
| 7 | `/api/living-brain` | GET | Unified cross-substrate graph (BRAIN+NEXUS+TASKS+CONDUIT+SIGNALDOCK) | query: `limit` (1-2000, default 500), `substrates` (csv), `min_weight` | `LBGraph { nodes, edges, counts, truncated }` | **Helper** `getAllSubstrates()` — fans out to 5 per-substrate adapters (`living-brain/adapters/index.ts`) | No | No | `routes/api/living-brain/+server.ts` |
| 8 | `/api/living-brain/node/:id` | GET | Ego network for a substrate-prefixed node id (loads full graph, filters to touched edges) | path: `id` (substrate-prefixed); | `NodeNeighborsResponse { node, neighbors, edges }` or 400/404 | **Helper** `getAllSubstrates({ limit: 2000 })` then filter in-memory | No | No | `routes/api/living-brain/node/[id]/+server.ts` |
| 9 | `/api/living-brain/stream` | GET | **SSE** live stream: hello, heartbeat (30s), node.create, edge.strengthen, task.status, message.send | none | `text/event-stream` of `LBStreamEvent` | **Polling direct SQL** on `brain.db` + `tasks.db` + `conduit.db` every 1s (rowid watermarks) | No | **SSE** | `routes/api/living-brain/stream/+server.ts` |
| 10 | `/api/living-brain/substrate/:name` | GET | Single-substrate filtered graph | path: `name` (brain\|nexus\|tasks\|conduit\|signaldock); query: `limit`, `min_weight` | `LBGraph` or 400 on bad name | **Helper** `getAllSubstrates({ substrates: [name] })` | No | No | `routes/api/living-brain/substrate/[name]/+server.ts` |
| 11 | `/api/nexus` | GET | List all communities with member counts + deterministic color palette | none | `CommunityRecord[]` or 503 when nexus.db absent | **Direct SQL** on global `nexus.db` via `getNexusDb()` | No | No | `routes/api/nexus/+server.ts` |
| 12 | `/api/nexus/community/:id` | GET | Community drill-down: member nodes + internal edges (≤500 nodes, ≤2000 edges) | path: `id` (community_id) | `CommunityDetail { communityId, nodes, edges }` or 404 | **Direct SQL** on global `nexus.db` | No | No | `routes/api/nexus/community/[id]/+server.ts` |
| 13 | `/api/nexus/search` | GET | Symbol search (LIKE on label/id), 20 results | query: `q` (min 2 chars) | `SearchResult[]` | **Direct SQL** on global `nexus.db` | No | No | `routes/api/nexus/search/+server.ts` |
| 14 | `/api/nexus/symbol/:name` | GET | 2-hop ego network for named symbol (hop 0 center + hop 1 + hop 2 + edges) | path: `name` (url-decoded) | `EgoNetwork { center, nodes, edges }` or 404 | **Direct SQL** on global `nexus.db` (multi-hop recursive queries) | No | No | `routes/api/nexus/symbol/[name]/+server.ts` |
| 15 | `/api/project/clean` | POST | Dry-run-by-default cleanup of registered projects | body: `{ includeTemp?; includeTests?; includeUnhealthy?; includeNeverIndexed?; pattern?; dryRun? }` | LAFS envelope (CLI passthrough) or 4xx | **CLI shell-out** `cleo nexus projects clean --json …` via `executeCliAction()` | No | No | `routes/api/project/clean/+server.ts` |
| 16 | `/api/project/:id/index` | POST | Trigger full nexus analyze for a project | path: `id` | LAFS envelope or 400/404 | **CLI shell-out** `cleo nexus analyze <path> --json` | No | No | `routes/api/project/[id]/index/+server.ts` |
| 17 | `/api/project/:id/reindex` | POST | Re-index alias (same command as `/index` — `analyze` handles both) | path: `id` | LAFS envelope or 400/404 | **CLI shell-out** `cleo nexus analyze <path> --json` | No | No | `routes/api/project/[id]/reindex/+server.ts` |
| 18 | `/api/project/:id` | DELETE | Remove project from registry | path: `id` | LAFS envelope or 400 | **CLI shell-out** `cleo nexus projects remove <id> --json` | No | No | `routes/api/project/[id]/+server.ts` |
| 19 | `/api/project/scan` | POST | FS scan + optional auto-register | body: `{ roots?; maxDepth?; autoRegister? }` | LAFS envelope | **CLI shell-out** `cleo nexus projects scan --json …` | No | No | `routes/api/project/scan/+server.ts` |
| 20 | `/api/project/switch` | POST | Set active-project cookie (client switcher) | body: `{ projectId: string }` | `{ success: true }` or 400 | **Helper** `setActiveProjectId(cookies, projectId)` (cookie only) | No | No | `routes/api/project/switch/+server.ts` |
| 21 | `/api/search` | GET | Cross-project symbol search on `nexus.db` (all projects or current) | query: `q` (min 2), `scope=all\|current` (default all), `limit` (1-100, default 20) | LAFS envelope `{ data: { query, scope, results: SymbolHit[], totalHits } }` | **Direct SQL** against global `nexus.db` (opens own `DatabaseSync` connection — bypasses the connections helper) | Reads project cookie if `scope=current` | No | `routes/api/search/+server.ts` |
| 22 | `/api/tasks` | GET | List tasks with filters, max 1000 rows | query: `status`, `priority`, `type` (all csv), `limit` | `{ tasks: TaskRow[]; total }` or 503 | **Direct SQL** on `tasks.db` | No | No | `routes/api/tasks/+server.ts` |
| 23 | `/api/tasks/events` | GET | **SSE** notifying on MAX(updated_at) / row-count change; 2s poll, heartbeat when idle | none | `text/event-stream` with `connected`, `task-updated`, `heartbeat` events | **Polling direct SQL** on `tasks.db` every 2s | No | **SSE** | `routes/api/tasks/events/+server.ts` |
| 24 | `/api/tasks/graph` | GET | sigma-ready epic graph or 1-hop neighborhood | query: `epic` (epic id) OR `taskId` (required) | `GraphResponse { nodes: GraphNode[]; edges: GraphEdge[] }` | **Direct SQL** on `tasks.db` (recursive CTE + `task_dependencies`) | No | No | `routes/api/tasks/graph/+server.ts` |
| 25 | `/api/tasks/:id` | GET | Single task + its subtasks | path: `id` | `{ task; subtasks }` or 404 | **Direct SQL** on `tasks.db` | No | No | `routes/api/tasks/[id]/+server.ts` |
| 26 | `/api/tasks/:id/deps` | GET | Upstream (blockers) + downstream (dependents) + `allUpstreamReady` flag | path: `id` | `DepsResponse` or 404 | **Direct SQL** on `tasks.db` | No | No | `routes/api/tasks/[id]/deps/+server.ts` |
| 27 | `/api/tasks/pipeline` | GET | Tasks grouped by `pipeline_stage` (RCASD-IVTR+C) | none | `{ stages: [{ id, label, count, tasks }] }` | **Direct SQL** on `tasks.db` | No | No | `routes/api/tasks/pipeline/+server.ts` |
| 28 | `/api/tasks/search` | GET | ID or fuzzy-title task search (via shared `normalizeSearch()`) | query: `q` | `{ kind: 'id'\|'title'\|'empty'; task?; tasks?; total? }` | **Direct SQL** on `tasks.db` | No | No | `routes/api/tasks/search/+server.ts` |
| 29 | `/api/tasks/sessions` | GET | Recent sessions enriched with completed/current tasks + per-session work history (≤50) | query: `limit` (max 200) | `{ sessions: EnrichedSession[]; total }` | **Direct SQL** on `tasks.db` (`sessions`, `task_work_history`, `tasks`) | No | No | `routes/api/tasks/sessions/+server.ts` |
| 30 | `/api/tasks/tree/:epicId` | GET | Nested epic tree (3 levels deep) + status stats | path: `epicId` | `{ epic: {...children: TreeNode[]}; stats }` or 404 | **Direct SQL** on `tasks.db` (recursive CTE) | No | No | `routes/api/tasks/tree/[epicId]/+server.ts` |

**Totals**: 30 files, 30 handlers. Methods: 24× GET, 6× POST/DELETE. 2× SSE. 0× WebSocket.

### Middleware / cross-cutting

- `hooks.server.ts` (`src/hooks.server.ts`): resolves `event.locals.projectCtx` from project cookie on every request; falls back to default context. **There is no authentication middleware.** Only `project/switch` writes the cookie; all other routes only read it via `locals.projectCtx`.
- `src/lib/server/db/connections.ts`:
  - Globals (cached per process): `getNexusDb()`, `getSignaldockDb()`.
  - Per-project (opened fresh each call): `getBrainDb(ctx)`, `getTasksDb(ctx)`, `getConduitDb(ctx)` — last derives from `dirname(ctx.brainDbPath) + /conduit.db`.
  - `getDbStatus(ctx)` — existence check for all 5 DBs (nexus, brain, tasks, conduit, signaldock).
- `src/lib/server/cli-action.ts`: `executeCliAction(args, opts)` — wraps `runCleoCli()` (from `spawn-cli.ts`) and emits LAFS envelopes. Used only by the 5 `/api/project/*` endpoints.

---

## Section 2 — Coverage matrix by domain

Contract op names extracted from `packages/contracts/src/operations/*.ts` and sibling files. Only `Params` types enumerated (each has a matching `Result`). Cross-reference: does a Studio HTTP endpoint exist for this op?

### TASKS (source: `packages/contracts/src/operations/tasks.ts`, 22 ops)

| Contract op | CLI verb | HTTP exposed? | HTTP path | Gap |
|-------------|----------|---------------|-----------|-----|
| TasksGet | `cleo show` | YES (read) | GET `/api/tasks/:id` | — |
| TasksList | `cleo list --parent …` | YES (read) | GET `/api/tasks` | Query shape differs; no `--parent` equivalent |
| TasksFind | `cleo find` | YES (read) | GET `/api/tasks/search` | Differently shaped (id vs title union) |
| TasksExists | `cleo exists` | NO | — | missing |
| TasksTree | `cleo tree` | YES (read) | GET `/api/tasks/tree/:epicId` | — |
| TasksBlockers | `cleo blockers` | PARTIAL | GET `/api/tasks/:id/deps` | Deps returns upstream + downstream combined |
| TasksDeps | `cleo deps` | YES (read) | GET `/api/tasks/:id/deps` | — |
| TasksAnalyze | `cleo analyze` | NO | — | missing |
| TasksNext | `cleo next` | NO | — | missing (Studio UI has to compute itself) |
| TasksCreate | `cleo add` | NO | — | **missing write** |
| TasksUpdate | `cleo update` | NO | — | **missing write** |
| TasksComplete | `cleo complete` | NO | — | **missing write** |
| TasksDelete | `cleo delete` | NO | — | **missing write** |
| TasksArchive | `cleo archive` | NO | — | **missing write** |
| TasksUnarchive | `cleo unarchive` | NO | — | **missing write** |
| TasksReparent | `cleo reparent` | NO | — | **missing write** |
| TasksPromote | `cleo promote` | NO | — | **missing write** |
| TasksReorder | `cleo reorder` | NO | — | **missing write** |
| TasksReopen | `cleo reopen` | NO | — | **missing write** |
| TasksStart | `cleo start` | NO | — | **missing write** |
| TasksStop | `cleo stop` | NO | — | **missing write** |
| TasksCurrent | `cleo current` | NO | — | missing |
| (extra) pipeline kanban | — | YES (read) | GET `/api/tasks/pipeline` | Not a contract op; Studio-specific view |
| (extra) task graph | — | YES (read) | GET `/api/tasks/graph` | Not a contract op |
| (extra) events stream | — | YES (read) | GET `/api/tasks/events` (SSE) | Not a contract op |
| (extra) sessions list | — | YES (read) | GET `/api/tasks/sessions` | Lives under /tasks but is session-scoped |

### BRAIN (source: `packages/contracts/src/brain.ts` + `memory.ts`; there is **no** `operations/brain.ts`)

Contract types available: `BrainMemoryTier`, `BrainCognitiveType`, `BrainSourceConfidence`, `BrainEntryRef`, `BrainEntrySummary`, `ContradictionDetail`, `SupersededEntry`. These are shape types, not op pairs — CLI verbs under `cleo memory {observe|find|fetch|timeline|llm-status|verify}` are not encoded as `*Params`/`*Result` contract ops.

| CLI verb | HTTP exposed? | HTTP path | Gap |
|----------|---------------|-----------|-----|
| `cleo memory observe` | NO | — | **missing write** |
| `cleo memory find` | NO | — | missing (indirect via `/api/brain/observations` direct-SQL list) |
| `cleo memory fetch` | NO | — | missing single-entry-by-id |
| `cleo memory timeline` | NO | — | missing |
| `cleo memory llm-status` | NO | — | missing |
| `cleo memory verify` | NO | — | **missing write** |
| (visualization) decisions timeline | YES (read) | GET `/api/brain/decisions` | direct SQL |
| (visualization) graph viz | YES (read) | GET `/api/brain/graph` | direct SQL |
| (visualization) observations list | YES (read) | GET `/api/brain/observations` | direct SQL |
| (visualization) quality histogram | YES (read) | GET `/api/brain/quality` | direct SQL |
| (visualization) tier distribution | YES (read) | GET `/api/brain/tier-stats` | direct SQL |

**Note**: No BRAIN contract op surface exists. All Studio BRAIN endpoints bypass contracts and read `brain_*` tables directly. No write path at all.

### CONDUIT (source: `packages/contracts/src/conduit.ts`)

Exposed types: `ConduitMessage`, `ConduitSendOptions`, `ConduitSendResult`, `ConduitUnsubscribe`, `ConduitState`, `ConduitStateChange`, `Conduit`, `ConduitConfig`. These are runtime API shapes, not `*Params`/`*Result` op pairs.

| CLI verb / contract method | HTTP exposed? | HTTP path | Gap |
|----------------------------|---------------|-----------|-----|
| `Conduit.send()` | NO | — | **missing write** |
| `Conduit.subscribe()` | PARTIAL | GET `/api/living-brain/stream` emits `message.send` events | Read-only via SSE |
| `Conduit.history()` / list messages | NO | — | missing |
| `Conduit.state()` | NO | — | missing |
| `cleo conduit send` | NO | — | **missing write** |

**CONDUIT has no dedicated HTTP surface**. The only read-path is the `message.send` event inside the Living Brain SSE stream.

### NEXUS (source: `packages/contracts/src/code-symbol.ts`, `graph.ts`; no `operations/nexus.ts`)

No contract op pairs for nexus at all — code-symbol.ts and graph.ts define shapes (`CodeSymbol`, `GraphNode`, `NexusEdge`, etc.).

| CLI verb | HTTP exposed? | HTTP path | Gap |
|----------|---------------|-----------|-----|
| `cleo nexus context <symbol>` | PARTIAL | GET `/api/nexus/symbol/:name` | 2-hop ego; no raw `context` command parity |
| `cleo nexus impact <symbol>` | NO | — | **missing read** |
| `cleo nexus clusters` | PARTIAL | GET `/api/nexus` | Communities list |
| `cleo nexus flows` | NO | — | **missing read** |
| `cleo nexus analyze <path>` | YES (write) | POST `/api/project/:id/index`, POST `/api/project/:id/reindex` | via CLI shell-out |
| `cleo nexus projects scan` | YES (write) | POST `/api/project/scan` | via CLI shell-out |
| `cleo nexus projects clean` | YES (write) | POST `/api/project/clean` | via CLI shell-out |
| `cleo nexus projects remove` | YES (write) | DELETE `/api/project/:id` | via CLI shell-out |
| `cleo nexus status` | NO | — | missing |
| Cross-project symbol search | YES (read) | GET `/api/search` | direct SQL |
| Community drill-down | YES (read) | GET `/api/nexus/community/:id` | — |
| Single-symbol search | YES (read) | GET `/api/nexus/search` | — |

### SESSION (source: `packages/contracts/src/operations/session.ts`, 9 ops)

| Contract op | CLI verb | HTTP exposed? | HTTP path | Gap |
|-------------|----------|---------------|-----------|-----|
| SessionStatus | `cleo session status` | NO | — | missing |
| SessionList | `cleo session list` | PARTIAL | GET `/api/tasks/sessions` | Shape differs; returns enriched |
| SessionShow | `cleo session show` | NO | — | missing |
| SessionHistory | `cleo session history` | NO | — | missing (similar data in `/api/tasks/sessions`) |
| SessionStart | `cleo session start` | NO | — | **missing write** |
| SessionEnd | `cleo session end` | NO | — | **missing write** |
| SessionResume | `cleo session resume` | NO | — | **missing write** |
| SessionSuspend | `cleo session suspend` | NO | — | **missing write** |
| SessionGc | `cleo session gc` | NO | — | **missing write** |

### ORCHESTRATE (source: `packages/contracts/src/operations/orchestrate.ts`, 13 ops)

| Contract op | CLI verb | HTTP exposed? | HTTP path | Gap |
|-------------|----------|---------------|-----------|-----|
| OrchestrateStatus | `cleo orchestrate status` | NO | — | missing |
| OrchestrateNext | (implicit) | NO | — | missing |
| OrchestrateReady | `cleo orchestrate ready` | NO | — | missing |
| OrchestrateAnalyze | `cleo orchestrate analyze` | NO | — | missing |
| OrchestrateContext | `cleo orchestrate context` | NO | — | missing |
| OrchestrateWaves | `cleo orchestrate waves` | NO | — | missing |
| OrchestrateSkillList | — | NO | — | missing |
| OrchestrateBootstrap | — | NO | — | missing |
| OrchestrateStartup | `cleo orchestrate start` | NO | — | **missing write** |
| OrchestrateSpawn | `cleo orchestrate spawn` | NO | — | **missing write** |
| OrchestrateHandoff | `cleo orchestrate handoff` | NO | — | **missing write** |
| OrchestrateValidate | — | NO | — | missing |
| OrchestrateParallelStart / End | — | NO | — | **missing write** |

**ORCHESTRATE has zero HTTP exposure**.

### LIFECYCLE (source: `packages/contracts/src/operations/lifecycle.ts`, 11 ops)

| Contract op | CLI verb | HTTP exposed? | HTTP path | Gap |
|-------------|----------|---------------|-----------|-----|
| LifecycleCheck | `cleo lifecycle check` | NO | — | missing |
| LifecycleStatus | `cleo lifecycle status` | NO | — | missing |
| LifecycleHistory | `cleo lifecycle history` | NO | — | missing |
| LifecycleGates | `cleo lifecycle gates` | NO | — | missing |
| LifecyclePrerequisites | `cleo lifecycle prereqs` | NO | — | missing |
| LifecycleProgress | `cleo lifecycle progress` | NO | — | missing |
| LifecycleSkip | — | NO | — | **missing write** |
| LifecycleReset | — | NO | — | **missing write** |
| LifecycleGatePass | `cleo lifecycle complete` | NO | — | **missing write** |
| LifecycleGateFail | — | NO | — | **missing write** |

**LIFECYCLE has zero HTTP exposure**.

### RELEASE (source: `packages/contracts/src/operations/release.ts`, 8 ops)

| Contract op | CLI verb | HTTP exposed? | HTTP path | Gap |
|-------------|----------|---------------|-----------|-----|
| ReleasePrepare / Changelog / Commit / Tag / Push / GatesRun / Rollback | `cleo release *` | NO | — | **All missing** |

### RESEARCH (source: `packages/contracts/src/operations/research.ts`, 10 ops)

| Contract op | CLI verb | HTTP exposed? | HTTP path | Gap |
|-------------|----------|---------------|-----------|-----|
| ResearchShow / List / Query / Pending / Stats / ManifestRead / Inject / Link / ManifestAppend / ManifestArchive | `cleo research *` | NO | — | **All missing** |

### SKILLS (source: `packages/contracts/src/operations/skills.ts`, 13 ops)

| Contract op | HTTP exposed? | Gap |
|-------------|---------------|-----|
| SkillsList / Show / Find / Dispatch / Verify / Dependencies / Install / Uninstall / Enable / Disable / Configure / Refresh | NO | **All missing** |

### SYSTEM (source: `packages/contracts/src/operations/system.ts`, 11 ops)

| Contract op | HTTP exposed? | HTTP path | Gap |
|-------------|---------------|-----------|-----|
| SystemVersion | PARTIAL | GET `/api/health` (embeds version string) | hardcoded `2026.4.47` in route; drift risk |
| SystemDoctor | NO | — | missing |
| SystemConfigGet / Set | NO | — | missing |
| SystemStats | NO | — | missing |
| SystemContext | NO | — | missing |
| SystemInit / Backup / Restore / Migrate / Sync / Cleanup | NO | — | **missing writes** |

### VALIDATE (source: `packages/contracts/src/operations/validate.ts`, 13 ops)

| Contract op | HTTP exposed? | Gap |
|-------------|---------------|-----|
| ValidateSchema / Protocol / Task / Manifest / Output / ComplianceSummary / ComplianceViolations / ComplianceRecord / TestStatus / TestCoverage / TestRun | NO | **All missing** |

### ISSUES (source: `packages/contracts/src/operations/issues.ts`, 4 ops)

| Contract op | HTTP exposed? | Gap |
|-------------|---------------|-----|
| IssuesDiagnostics / CreateBug / CreateFeature / CreateHelp | NO | **All missing** |

### PLAYBOOK (source: `packages/contracts/src/playbook.ts`)

Runtime types only (no `*Params`/`*Result`). No CLI verbs exposed via Studio HTTP; no playbook-specific routes.

### SIGNALDOCK / AGENTS (source: `packages/contracts/src/agent-registry*.ts`)

No dedicated HTTP routes. Data flows exclusively through the `signaldock` branch of `/api/living-brain`.

---

## Section 3 — Domain summaries

- **TASKS** — 22 contract ops; **~7 HTTP-exposed reads** (`/api/tasks`, `/:id`, `/:id/deps`, `/search`, `/tree/:epicId`, `/pipeline`, `/graph`) plus 1 SSE (`/events`). **0 writes exposed** — every mutating op (create/update/complete/archive/reorder/start/stop) is CLI-only. Studio surfaces the richest read catalog but cannot mutate tasks without shelling out.
- **BRAIN** — No operations/brain.ts contract file; only shape types. 5 HTTP-exposed reads (`decisions`, `graph`, `observations`, `quality`, `tier-stats`), all direct SQL. **0 writes exposed** — `observe`, `verify`, `fetch`, `timeline`, `find` CLI verbs have no HTTP counterpart.
- **CONDUIT** — 1 contract surface (`Conduit` interface). **0 dedicated HTTP endpoints**. The only observable path is incidental: `message.send` events inside `/api/living-brain/stream` SSE. No send/list/history/state endpoints.
- **NEXUS** — Read surface modest but functional: 4 read endpoints (`/api/nexus`, `/community/:id`, `/search`, `/symbol/:name`) + cross-project `/api/search`. Write surface delegated to CLI via 5 `/api/project/*` routes (index, reindex, delete, scan, clean). No `impact`, `flows`, or `status` parity.
- **SESSION** — 9 contract ops; **1 PARTIAL read** (`/api/tasks/sessions`) and **0 writes exposed**. No status/show/history/start/end/resume/suspend/gc HTTP endpoints.
- **ORCHESTRATE** — 13 contract ops. **0 HTTP endpoints.** Full blackout.
- **LIFECYCLE** — 11 contract ops. **0 HTTP endpoints.** Full blackout.
- **RELEASE** — 8 contract ops. **0 HTTP endpoints.** Full blackout.
- **RESEARCH** — 10 contract ops. **0 HTTP endpoints.** Full blackout.
- **SKILLS** — 13 contract ops. **0 HTTP endpoints.** Full blackout.
- **SYSTEM** — 11 contract ops. **1 PARTIAL** (`/api/health`, hardcoded version). Full blackout otherwise.
- **VALIDATE** — 13 contract ops. **0 HTTP endpoints.** Full blackout.
- **ISSUES** — 4 contract ops. **0 HTTP endpoints.** Full blackout.
- **PLAYBOOK** — No CLI op pairs; no HTTP surface.
- **SIGNALDOCK / AGENTS** — No dedicated HTTP. Only visible via `substrates=signaldock` on `/api/living-brain`.

---

## Section 4 — Non-domain / cross-cutting endpoints

| Path | Methods | Purpose | Data source |
|------|---------|---------|-------------|
| `/api/health` | GET | Service liveness + per-DB existence check | `getDbStatus(locals.projectCtx)` |
| `/api/project/switch` | POST | Set active-project cookie | `setActiveProjectId(cookies, …)` |
| `/api/project/scan` | POST | FS scan + optional auto-register | CLI `cleo nexus projects scan` |
| `/api/project/clean` | POST | Dry-run cleanup of registered projects | CLI `cleo nexus projects clean` |
| `/api/project/:id` | DELETE | Remove project from registry | CLI `cleo nexus projects remove` |
| `/api/project/:id/index` | POST | Initial nexus index | CLI `cleo nexus analyze` |
| `/api/project/:id/reindex` | POST | Re-run nexus index (alias) | CLI `cleo nexus analyze` |
| `/api/search` | GET | Cross-project symbol search | Direct SQL on global `nexus.db` |
| `/api/living-brain` | GET | Unified cross-substrate graph | 5 adapters (brain/nexus/tasks/conduit/signaldock) |
| `/api/living-brain/node/:id` | GET | Single-node + neighbors | 5 adapters, in-memory filter |
| `/api/living-brain/substrate/:name` | GET | Single-substrate graph | 1 adapter |
| `/api/living-brain/stream` | GET (SSE) | Real-time cross-substrate events | Polling 3 DBs (brain/tasks/conduit) |

**Auth**: there is no authentication hook. `hooks.server.ts` only populates `locals.projectCtx`. The project cookie is the only request-scoped identity.

**Streaming**: 2 SSE endpoints — `/api/living-brain/stream` (5-substrate polling, 1s) and `/api/tasks/events` (tasks.db poll, 2s). No WebSocket.

**CLI-backed routes (5)**: `/api/project/scan`, `/clean`, `/:id/index`, `/:id/reindex`, `/:id` (DELETE). All go through `executeCliAction()` which uses `runCleoCli()` from `spawn-cli.ts`.

---

## Evidence — file inventory (exhaustive)

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

Supporting files:

- `packages/studio/src/hooks.server.ts` — project-context middleware.
- `packages/studio/src/lib/server/db/connections.ts` — `getNexusDb`, `getSignaldockDb`, `getBrainDb`, `getTasksDb`, `getConduitDb`, `getDbStatus`.
- `packages/studio/src/lib/server/cli-action.ts` — `executeCliAction()` used by `/api/project/*` write endpoints.
- `packages/studio/src/lib/server/spawn-cli.ts` — `runCleoCli()` (called by cli-action).
- `packages/studio/src/lib/server/living-brain/adapters/{index,brain,nexus,tasks,conduit,signaldock}.ts` — 5 substrate adapters fronted by `getAllSubstrates()`.
- `packages/studio/src/lib/server/living-brain/types.ts` — `LBNode`, `LBEdge`, `LBGraph`, `LBStreamEvent`, `LBQueryOptions`.

## Evidence — SSoT cross-reference

- `packages/contracts/src/operations/index.ts` — barrel re-exports `issues`, `lifecycle`, `orchestrate`, `params`, `release`, `research`, `session`, `skills`, `system`, `tasks`, `validate`. **No `brain`, `conduit`, or `nexus`** operations modules exist.
- `packages/contracts/src/brain.ts`, `memory.ts`, `conduit.ts`, `code-symbol.ts`, `graph.ts`, `playbook.ts`, `agent-registry*.ts` — runtime shape types, not op pairs.

---

## Top observations

1. **Writes are a desert.** Studio exposes ~15 read routes and only 5 writes, all delegated via `executeCliAction()` subprocess spawn. No HTTP path mutates a DB directly.
2. **BRAIN has no contract SSoT.** Every brain endpoint queries `brain_observations`/`brain_page_edges`/etc. as raw SQL. Adding a write path today requires inventing a contract.
3. **Version drift.** `/api/health` hardcodes `2026.4.47`, but the repo is on `2026.4.90`.
4. **Two separate nexus.db opens.** `/api/search/+server.ts` manually constructs a `DatabaseSync` instead of calling `getNexusDb()`, diverging from the connection helper pattern.
