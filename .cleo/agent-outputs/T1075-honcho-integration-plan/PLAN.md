# T1075 Honcho Memory Integration — Comprehensive Integration Plan

**Owner**: kryptobaseddev
**Filed**: 2026-04-21 (session ses_20260421173407_ac5c20)
**Parent epic**: T1075 The Honcho Memory Integration
**Related epics**: T1106 (living brain recovery) · T942 (sentient CLEO architecture) · T-BRAIN-LIVING (unified living brain)
**Related decisions**: D023 (SDK-first) · D024 (neurosurgery model) · T1139 (BRAIN auto-reconcile) · T1140 (worktree-by-default) · T1141 (migration generator hardening)

---

## TL;DR — What this plan adds to the existing T1075 tree

The existing T1075 → T1076/T1081/T1082/T1083 tree with 12 atomic tasks captures **~30% of the Honcho integration surface**. Honcho's actual architecture has three additional subsystems (`deriver/`, `dreamer/`, `reconciler/`) plus a peer-card identity layer plus vector reconciliation that the original plan missed. This document:

1. Audits the **existing T1075 tree** (17 tasks, structural parentage verified correct).
2. Adds **Wave 0** (pre-requisite Honcho source study + packages/agents/ peer_id SSoT cleanup).
3. Adds **Wave 5** (deriver queue pipeline — background derivation worker).
4. Adds **Wave 6** (dreamer with surprisal + specialists + trees — upgrade to existing dream-cycle).
5. Adds **Wave 7** (reconciler with vector sync — merges with T1139 scope).
6. Adds **Wave 8** (peer-card identity layer + CANT DSL integration).
7. Cross-references **every** Honcho source file to the target CLEO file.
8. Captures the **SDK-first** mapping (D023) — every new capability ships as core SDK primitive first, dispatch surface second.

---

## Part 1: Honcho Source Inventory

Honcho is locally available at `/mnt/projects/honcho`. Full source tree:

```
/mnt/projects/honcho/src/
├── main.py, db.py, dependencies.py, exceptions.py, security.py, config.py
├── models.py                              # SQLAlchemy data model (User/Peer/Session/Message)
├── embedding_client.py                    # Embedding abstraction
├── dialectic/
│   ├── core.py                            # DialecticAgent evaluation loop
│   ├── chat.py                            # Chat-turn processing
│   ├── prompts.py                         # Prompt templates for dialectic reasoning
├── crud/
│   ├── peers.py                           # Observer/observed tuple CRUD
│   ├── peer_card.py                       # Peer identity card
│   ├── representation.py                  # Theory-of-mind representation model
│   ├── session.py                         # Session CRUD
│   ├── workspace.py                       # Workspace isolation (multi-tenant)
│   ├── message.py, collection.py, document.py, deriver.py, webhook.py
├── deriver/                               # BACKGROUND DERIVATION QUEUE
│   ├── consumer.py                        # Queue consumer worker
│   ├── deriver.py                         # Derivation logic (message → insight)
│   ├── enqueue.py                         # Queue producer
│   ├── queue_manager.py                   # Queue state management
│   ├── prompts.py                         # Derivation prompt templates
│   ├── __main__.py                        # Runnable worker entrypoint
├── dreamer/                               # CONSOLIDATION + SLEEP CYCLE
│   ├── dream_scheduler.py                 # Scheduled dream-cycle triggers
│   ├── orchestrator.py                    # Dream orchestrator
│   ├── specialists.py                     # Topic-specific consolidation specialists
│   ├── surprisal.py                       # Bayesian surprisal scoring
│   ├── trees/                             # Hierarchical memory trees
├── reconciler/                            # CONFLICT RESOLUTION + VECTOR SYNC
│   ├── scheduler.py                       # Periodic reconcile scheduler
│   ├── sync_vectors.py                    # Vector index reconciliation
│   ├── queue_cleanup.py                   # Dead-letter queue handling
├── llm/                                   # LLM abstraction layer
│   ├── api.py, backend.py, backends/
│   ├── caching.py, credentials.py, executor.py
│   ├── conversation.py, history_adapters.py
│   ├── registry.py, request_builder.py, runtime.py
│   ├── structured_output.py, tool_loop.py, types.py
├── schemas/
│   ├── api.py                             # External API schemas
│   ├── configuration.py                   # Config schemas
│   ├── internal.py                        # Internal-only schemas
├── routers/                               # REST API surface
│   ├── peers.py, messages.py, sessions.py, workspaces.py
│   ├── conclusions.py, webhooks.py, keys.py
├── vector_store/                          # Vector storage adapters
├── telemetry/                             # Observability
├── webhooks/                              # Webhook handling
├── cache/
├── utils/
└── examples/ (under /mnt/projects/honcho/examples/)
    ├── crewai/, gmail/, granola/, langgraph/, n8n/, zo/
```

---

## Part 2: CLEO Target File Inventory

Full memory/sessions/store/nexus/dispatch file surface (verified 2026-04-21):

### `packages/core/src/memory/` (54 files)
```
brain-retrieval.ts              ← Wave 4 multi-pass refactor target
brain-search.ts                 ← Wave 4 multi-pass refactor target
brain-lifecycle.ts              ← Wave 6 dreamer integration target
brain-consolidator.ts           ← Wave 6 dreamer integration target
brain-reasoning.ts              ← Wave 3 dialectic-evaluator extension target
brain-maintenance.ts            ← Wave 7 reconciler integration target
brain-stdp.ts                   ← Existing plasticity (STDP = Spike-Timing-Dep Plasticity)
brain-plasticity-class.ts       ← Hebbian work already shipped
brain-similarity.ts             ← Wave 7 reconciler semantic-similarity
brain-embedding.ts              ← Wave 7 reconciler vector-sync
embedding-queue.ts, embedding-worker.ts, embedding-local.ts
observer-reflector.ts           ← Wave 3 session narrative extension target
graph-memory-bridge.ts          ← Wave 2 peer_id filter target (+ Wave 4 retrieval)
extraction-gate.ts              ← Existing Check A0 blocklist (T993)
temporal-supersession.ts        ← Wave 7 reconciler — prose-supersession scanner
dream-cycle.ts                  ← Wave 6 dreamer upgrade target
sleep-consolidation.ts          ← Wave 6 dreamer upgrade target
session-memory.ts               ← Wave 3 session narrative state store
precompact-flush.ts             ← Pre-compaction flush (T1004)
transcript-ingestor.ts, transcript-extractor.ts, transcript-scanner.ts
mental-model-injection.ts, mental-model-queue.ts
llm-backend-resolver.ts, llm-extraction.ts, anthropic-key-resolver.ts
auto-extract.ts, auto-research.ts, quality-scoring.ts, quality-feedback.ts
decisions.ts, learnings.ts, patterns.ts
brain-links.ts, decision-cross-link.ts, edge-types.ts, graph-queries.ts
nexus-plasticity.ts             ← Existing Hebbian/cross-substrate (T998)
memory-bridge.ts                ← CLI-directive bridge replacement (T999)
brain-export.ts, brain-backfill.ts, brain-purge.ts, brain-migration.ts
claude-mem-migration.ts
pipeline-manifest-sqlite.ts, manifest-ingestion.ts
graph-auto-populate.ts, engine-compat.ts, redaction.ts, promotion-score.ts
brain-row-types.ts, brain-consolidator.ts (duplicate listed — verify in audit)
index.ts                        ← Barrel export (line 1500: brain-retrieval)
```

### `packages/core/src/sessions/` (28 files)
```
briefing.ts                     ← Wave 4 session narrative injection target
handoff.ts                      ← Session handoff packaging
session-memory-bridge.ts        ← Bridge to brain session narrative
agent-session.ts, agent-session-adapter.ts ← Wave 8 CANT agent binding
decisions.ts, assumptions.ts    ← Session-scoped decision/assumption tracking
context-inject.ts, context-alert.ts, context-monitor.ts, context-drift ← Context plumbing
session-drift.ts, session-enforcement.ts, session-grade.ts
session-suspend.ts, session-switch.ts, session-cleanup.ts, session-archive.ts
session-show.ts, session-stats.ts, session-view.ts, session-history.ts, session-id.ts
snapshot.ts, statusline-setup.ts, find.ts, hitl-warnings.ts, types.ts, index.ts
```

### `packages/core/src/store/` (relevant files)
```
nexus-schema.ts                 ← Wave 1 — ADD user_profile table (verified: no user_profile today)
memory-schema.ts                ← Wave 2 — ADD peer_id column (verified: no peer_id today)
tasks-schema.ts, schema.ts      ← Existing schema
nexus-sqlite.ts, memory-sqlite.ts, sqlite.ts
nexus-validation-schemas.ts, validation-schemas.ts
migration-manager.ts, migration-sqlite.ts ← Wave 1 + Wave 2 migrations
task-store.ts, session-store.ts, data-accessor.ts, memory-accessor.ts
backup.ts, backup-pack.ts, backup-unpack.ts, backup-crypto.ts, sqlite-backup.ts
data-safety.ts, data-safety-central.ts, safety-data-accessor.ts, cross-db-cleanup.ts
```

### `packages/core/src/nexus/` (21 files)
```
transfer.ts                     ← Wave 1 — ADD importUserProfile/exportUserProfile
registry.ts, workspace.ts       ← Wave 1 — hook user_profile into registry
query.ts, query-dsl.ts
living-brain.ts                 ← Existing living-brain pipeline (T1107 target)
plasticity-queries.ts           ← Existing Hebbian queries (T998)
tasks-bridge.ts, nexus-bridge.ts
embeddings.ts                   ← Wave 7 reconciler — vector sync
augment.ts, hooks-augment.ts
discover.ts, deps.ts, hash.ts, permissions.ts, migrate-json-to-sqlite.ts
route-analysis.ts, wiki-index.ts, transfer-types.ts, index.ts
```

### `packages/cleo/src/dispatch/` (relevant files)
```
dispatcher.ts                           ← Wave 3 — ADD background dialectic hook
context/session-context.ts              ← Wave 2 — ADD active peer_id to context
domains/memory.ts                       ← Wave 1/3/4 — expose new ops via CLI
domains/nexus.ts                        ← Wave 1 — expose profile import/export/view
engines/memory-engine.ts                ← Wave 4 — multi-pass retrieval engine
engines/nexus-engine.ts                 ← Wave 1 — user_profile engine
engines/session-engine.ts               ← Wave 4 — briefing rolling narrative
```

### `packages/cant/src/` (17 files) — CANT DSL
```
composer.ts                     ← Wave 8 — compose peer_card from CANT agent
hierarchy.ts                    ← Wave 8 — CANT agent identity hierarchy
mental-model.ts                 ← Wave 8 — mental-model maps to representation
context-provider-brain.ts       ← Wave 2/8 — CANT-scoped BRAIN context
native-loader.ts                ← Wave 8 — CANT agent registry loader
parse.ts, document.ts, bundle.ts, worktree.ts
migrate/ (converter, diff, markdown-parser, serializer, types)
types.ts, index.ts
```

### `packages/agents/` — the messy one
```
package.json, README.md, .npmignore
seed-agents/                    ← Wave 0 — 7 CANT files + README (cleanup target)
    cleo-db-lead.cant, cleo-dev.cant, cleo-historian.cant,
    cleoos-opus-orchestrator.cant, cleo-prime.cant,
    cleo-rust-lead.cant, cleo-subagent.cant, README.md
cleo-subagent/                  ← Wave 0 — duplicate entry (AGENT.md + cleo-subagent.cant)
```

---

## Part 3: Existing T1075 Tree — Audit

Verified via `cleo show` for each ID:

```
T1075 (epic) The Honcho Memory Integration
├── T1076 (epic) Wave 1: The NEXUS User Identity
│   ├── T1077 Update nexus-schema with user_profile table
│   ├── T1078 Implement user-profile.ts CRUD operations
│   ├── T1079 Implement import/export for user_profile.json
│   └── T1080 Add CLI commands for nexus profile management
├── T1081 (epic) Wave 2: CANT Peer Memory Isolation
│   ├── T1084 Add peer_id to memory-schema tables
│   ├── T1085 Update graph-memory-bridge and brain-retrieval filters
│   └── T1086 Track active CANT agent in CQRS Session context
├── T1082 (epic) Wave 3: Continuous Dialectic Evaluator & Observer Upgrade
│   ├── T1087 Create dialectic-evaluator.ts LLM pass
│   ├── T1088 Wire Dialectic Evaluator into CQRS dispatcher
│   └── T1089 Extend observer-reflector for Session Narrative
└── T1083 (epic) Wave 4: Multi-Pass Context Engine
    ├── T1090 Refactor brain-retrieval into structured multi-pass
    ├── T1091 Update briefing for rolling session narrative
    └── T1092 End-to-End Integration Test for Honcho Memory Engine
```

**Structural parentage**: verified correct. `cleo tree T1075` returning empty is a separate CLI bug (consumers bypass the fact — use per-task `cleo show` until fixed; filed as T-TREE-BUG in next-session backlog).

**Existing acceptance criteria**: Present on all 17 tasks but at 3-5 criteria each with no file paths in `files[]`. Enrichment recommended — see Part 5 below.

---

## Part 4: The Missing Waves — What T1075 Tree Doesn't Capture

### Wave 0 — Prerequisites (FILED — T1144)

**Goal**: Ship the substrate so Waves 1-4 can execute safely without decoherence.

#### 0.1 Honcho source deep-audit (information task, small)
- Read `/mnt/projects/honcho/src/models.py` and extract the exact User/Peer/Session/Message schema (SQLAlchemy).
- Read `/mnt/projects/honcho/src/schemas/internal.py` for the DTO shapes.
- Read `/mnt/projects/honcho/src/dialectic/{core,chat,prompts}.py` end-to-end.
- Read `/mnt/projects/honcho/src/crud/{peers,peer_card,representation,session,workspace}.py`.
- Output: `.cleo/agent-outputs/T1075-honcho-integration-plan/HONCHO-SOURCE-NOTES.md` with a per-file summary and direct mapping to CLEO equivalents.

#### 0.2 packages/agents/ cleanup — establish peer_id SSoT (medium)
- Consolidate `packages/agents/seed-agents/cleo-subagent.cant` vs `packages/agents/cleo-subagent/cleo-subagent.cant` — ONE canonical location.
- Define `PeerIdentity` type in `packages/contracts/src/peer.ts`:
  ```ts
  export interface PeerIdentity {
    peerId: string;        // "cleo-prime", "cleo-subagent", "ct-research-agent"
    peerKind: "orchestrator" | "subagent" | "specialist" | "legacy-skill";
    cantFile?: string;     // absolute path to .cant source
    displayName: string;
    description: string;
  }
  ```
- Wire `packages/cant/src/native-loader.ts` to produce `PeerIdentity[]` from seed-agents/ + any project-local `.cleo/cant/` overrides.
- Legacy skills (ct-research-agent, ct-task-executor, ct-orchestrator, etc.) get `peerKind: "legacy-skill"` and continue to work until Wave 8 reconciles them.

#### 0.3 Honcho↔CLEO terminology glossary (small)
- Honcho `workspace` ≡ CLEO project (`.cleo/` scope)
- Honcho `peer` ≡ CLEO CANT agent
- Honcho `session` ≡ CLEO session (close match)
- Honcho `representation` ≡ theory-of-mind model (NEW in CLEO; belongs in BRAIN as `brain_representations` table OR joins to `user_profile` with `peer_id`)
- Honcho `collection` ≡ CLEO `brain_observations` grouping
- Honcho `document` ≡ CLEO `brain_learnings`
- Honcho `message` ≡ CLEO session turn (not currently persisted at turn-granularity; requires new `session_messages` table for Wave 5)

**Acceptance**:
- HONCHO-SOURCE-NOTES.md written with per-file mapping.
- `packages/contracts/src/peer.ts` shipped with `PeerIdentity` type.
- `packages/agents/` deduplicated — one canonical subagent.
- Glossary.md in plan directory.

---

### Wave 1 — The NEXUS User Identity (EXISTS — T1076)

Enrichment for existing T1077-T1080 with specific file references:

#### T1077 — Update `nexus-schema.ts` with `user_profile` table
- File: `packages/core/src/store/nexus-schema.ts`
- Schema (Drizzle):
  ```ts
  export const userProfile = sqliteTable("user_profile", {
    traitKey: text("trait_key").primaryKey(),      // "prefers-zero-deps", "verbose-git-logs"
    traitValue: text("trait_value").notNull(),     // JSON-encoded value
    confidence: real("confidence").notNull(),      // 0.0-1.0 Bayesian confidence
    source: text("source").notNull(),              // "dialectic:T<id>" | "import:user_profile.json" | "manual"
    derivedFromMessageId: text("derived_from_message_id"),  // FK to session turn
    firstObservedAt: integer("first_observed_at", { mode: "timestamp" }).notNull(),
    lastReinforcedAt: integer("last_reinforced_at", { mode: "timestamp" }).notNull(),
    reinforcementCount: integer("reinforcement_count").notNull().default(1),
    supersededBy: text("superseded_by"),           // Link to T1139 supersession graph
  });
  ```
- Honcho reference: `/mnt/projects/honcho/src/models.py` (User + Peer models; extract `metadata`/`attributes` pattern)
- Migration: generate via drizzle-kit; **must pass T1141 (Meta-B) trailing-marker sanitizer** once shipped.
- **Per T1139**: add `supersededBy` column from day one so reconcile landing later doesn't require a second migration.

#### T1078 — `user-profile.ts` CRUD
- New file: `packages/core/src/nexus/user-profile.ts`
- SDK surface (D023 SDK-first):
  ```ts
  export interface UserProfileTrait { ... }
  export async function getUserProfileTrait(nexusDb: BetterDB, key: string): Promise<UserProfileTrait | null>
  export async function upsertUserProfileTrait(nexusDb: BetterDB, trait: UserProfileTrait): Promise<void>
  export async function reinforceTrait(nexusDb: BetterDB, key: string, source: string): Promise<void>
  export async function listUserProfile(nexusDb: BetterDB, opts?: { minConfidence?: number }): Promise<UserProfileTrait[]>
  export async function supersedeTrait(nexusDb: BetterDB, oldKey: string, newKey: string): Promise<void>
  ```
- Contracts: add `packages/contracts/src/operations/nexus-user-profile.ts` with Params/Result for each SDK fn.
- Honcho reference: `/mnt/projects/honcho/src/crud/peer.py` (getOrCreate pattern, metadata merge).

#### T1079 — Import/export `user_profile.json`
- File: `packages/core/src/nexus/transfer.ts` — ADD `importUserProfile(path)` + `exportUserProfile(path)`.
- Canonical path: `~/.cleo/user_profile.json` (global, portable across installs).
- JSON schema: array of `UserProfileTrait` with `$schema` URL.
- On import: call `upsertUserProfileTrait` for each entry; if conflict, higher-confidence + more-recent wins; lower loses (with supersede link).
- Honcho reference: `/mnt/projects/honcho/src/crud/workspace.py` (workspace export pattern).

#### T1080 — CLI commands `cleo nexus profile {export,import,view,reinforce}`
- File: `packages/cleo/src/dispatch/domains/nexus.ts` — ADD profile subcommands.
- Engine: `packages/cleo/src/dispatch/engines/nexus-engine.ts` — route through SDK fns.
- Dispatch registry: register all 4 ops in `packages/cleo/src/dispatch/registry.ts` (per T1107 pattern — every verb reachable via programmatic query/mutate).
- Tests: per-command parity tests (CLI output ≡ programmatic dispatch output).

---

### Wave 2 — CANT Peer Memory Isolation (EXISTS — T1081)

#### T1084 — Add `peer_id` to memory-schema tables
- File: `packages/core/src/store/memory-schema.ts`
- Tables to update: `brain_observations`, `brain_learnings`, `brain_patterns`, `brain_decisions`, `brain_observations_fts` (FTS5), `brain_embeddings`
- New column spec:
  ```ts
  peerId: text("peer_id").notNull().default("global"),   // "global" | peerId from CANT
  peerScope: text("peer_scope").notNull().default("project"),  // "global" | "project" | "peer"
  ```
- Migration: **staged backfill** per T1003 pattern — existing rows get `peer_id='global'`, `peer_scope='project'`.
- Index: add `idx_peer_scope` on `(peer_id, peer_scope)` for Wave 2.2 filter performance.
- Honcho reference: `/mnt/projects/honcho/src/models.py` (Peer model + relationships).

#### T1085 — Peer-scoped retrieval filters
- Files:
  - `packages/core/src/memory/graph-memory-bridge.ts` — add `peerId` arg to `queryMemoriesForContext(...)` with SQL: `WHERE peer_id = ? OR peer_id = 'global'`
  - `packages/core/src/memory/brain-retrieval.ts` — same param threading
  - `packages/core/src/memory/brain-search.ts` — same (FTS5 query scope)
- Contract update: `RetrievalParams` adds `peerId?: string; includeGlobal?: boolean`
- Test: peer A writes observation, peer B retrieves → peer B sees nothing; peer A sees own + global. Regression: no peer_id on query ≡ current behavior (backward compat).

#### T1086 — Active CANT agent in CQRS Session context
- File: `packages/cleo/src/dispatch/context/session-context.ts` — add `activePeerId: string` field resolved from currently-loaded CANT agent (via `packages/cant/src/native-loader.ts`).
- Upstream: `packages/cleo/src/dispatch/dispatcher.ts` threads `activePeerId` into every domain handler call.
- Honcho reference: `/mnt/projects/honcho/src/dependencies.py` (request-scoped peer context injection pattern).
- **Depends on**: Wave 0.2 (peer_id SSoT must exist).

---

### Wave 3 — Continuous Dialectic Evaluator (EXISTS — T1082)

#### T1087 — `dialectic-evaluator.ts`
- New file: `packages/core/src/memory/dialectic-evaluator.ts`
- Honcho reference: `/mnt/projects/honcho/src/dialectic/core.py` + `/mnt/projects/honcho/src/dialectic/prompts.py`
- Core API:
  ```ts
  export interface DialecticTurn {
    userMessage: string;
    systemResponse: string;
    activePeerId: string;
    sessionId: string;
  }
  export interface DialecticInsights {
    globalTraits: Array<{ key: string; value: string; confidence: number }>;
    peerInsights: Array<{ key: string; value: string; peerId: string; confidence: number }>;
    sessionNarrativeDelta?: string;
  }
  export async function evaluateDialectic(turn: DialecticTurn): Promise<DialecticInsights>
  ```
- Uses `packages/core/src/memory/llm-backend-resolver.ts` (CLEO's existing LLM abstraction — do NOT import honcho's `llm/` directly).
- Prompt template: port from `/mnt/projects/honcho/src/dialectic/prompts.py` but rewrite for Claude 4.x (we don't use their OpenAI-first prompt style).
- Structured output: use `response_format: json` with `DialecticInsights` schema.

#### T1088 — Wire evaluator into CQRS dispatcher
- File: `packages/cleo/src/dispatch/dispatcher.ts`
- Pattern: after each domain handler returns, **if** `result.dialecticEligible === true` AND operation was a user-facing command (not internal):
  ```ts
  setImmediate(() => {
    evaluateDialectic(turn)
      .then(insights => applyInsights(insights, nexusDb, brainDb))
      .catch(err => logger.warn({ err }, "dialectic-evaluator failed"));
  });
  ```
- `applyInsights` (new function in `packages/core/src/memory/dialectic-evaluator.ts`):
  - Global traits → `upsertUserProfileTrait` (Wave 1)
  - Peer insights → `storeObservation` with `peerId` from turn + source `"dialectic:<sessionId>"`
  - Session narrative delta → append to `session_narrative` (Wave 3.3)
- Rate limit: reuse `brain_rate_limit` table from T1008 transactional rate limiter. Default: 1 evaluation per 10s per session.

#### T1089 — Rolling session narrative
- New file: `packages/core/src/memory/session-narrative.ts`
- Schema (new — add to memory-schema.ts in Wave 2 migration if feasible, else separate migration):
  ```ts
  export const sessionNarrative = sqliteTable("session_narrative", {
    sessionId: text("session_id").primaryKey(),
    narrative: text("narrative").notNull(),              // Rolling summary (max 2000 chars)
    turnCount: integer("turn_count").notNull().default(0),
    lastUpdatedAt: integer("last_updated_at", { mode: "timestamp" }).notNull(),
    pivotCount: integer("pivot_count").notNull().default(0),  // # of major direction changes
  });
  ```
- SDK: `getSessionNarrative(sessionId)`, `appendNarrativeDelta(sessionId, delta)`, `detectPivot(delta)`
- Honcho reference: `/mnt/projects/honcho/src/deriver/deriver.py` (session state derivation)
- Integration: `packages/core/src/memory/observer-reflector.ts` — when Reflector runs compression, also yield narrative delta.

---

### Wave 4 — Multi-Pass Context Engine (EXISTS — T1083)

#### T1090 — Multi-pass `brain-retrieval.ts` refactor
- File: `packages/core/src/memory/brain-retrieval.ts`
- New API shape:
  ```ts
  export interface RetrievalRequest {
    peerId: string;
    sessionId: string;
    query?: string;           // optional user-query
    passMask?: PassMask;      // default: all passes
  }
  export type PassMask = { cold: boolean; warm: boolean; hot: boolean };

  export interface RetrievalBundle {
    cold: { userProfile: UserProfileTrait[]; peerInstructions: string };
    warm: { peerLearnings: Learning[]; peerPatterns: Pattern[]; decisions: Decision[] };
    hot: { sessionNarrative: string; recentObservations: Observation[]; activeTasks: Task[] };
    tokenCounts: { cold: number; warm: number; hot: number; total: number };
  }

  export async function fetchIdentity(peerId: string, nexusDb: BetterDB): Promise<RetrievalBundle["cold"]>
  export async function fetchPeerMemory(peerId: string, brainDb: BetterDB, query?: string): Promise<RetrievalBundle["warm"]>
  export async function fetchSessionState(sessionId: string, brainDb: BetterDB, tasksDb: BetterDB): Promise<RetrievalBundle["hot"]>
  export async function buildRetrievalBundle(req: RetrievalRequest): Promise<RetrievalBundle>
  ```
- Token budget: default 4000 tokens split 20/50/30 cold/warm/hot; configurable via `.cleo/config.json`.
- Honcho reference: `/mnt/projects/honcho/src/dialectic/chat.py` (context-building before LLM call).

#### T1091 — `briefing.ts` uses rolling narrative
- File: `packages/core/src/sessions/briefing.ts`
- Replace "static recent decisions injection" with `buildRetrievalBundle({peerId, sessionId, passMask: {cold:true, warm:true, hot:true}})`.
- Render bundle as markdown for CLI output; as structured JSON for programmatic consumption.
- Maintain backward compat: existing `briefing` return shape preserved but add `bundle` field.

#### T1092 — E2E integration test
- File: `packages/core/src/memory/__tests__/honcho-integration.test.ts`
- Fixtures:
  - Seed nexus.db with 5 user_profile traits
  - Seed brain.db with peer-scoped observations (3 peers, 20 observations)
  - Seed session_narrative with rolling summary
- Test scenarios:
  - Peer A briefing returns only peer A + global warm memory
  - Peer B briefing returns only peer B + global warm memory
  - Cold pass is identical across peers (user_profile is global)
  - Hot pass changes across sessions (session-scoped)
  - Dialectic evaluator mock produces structured output
  - Token budget respected — over-budget retrieval trims hot first

---

### Wave 5 — Deriver Queue Pipeline (FILED — T1145)

**Honcho equivalent**: `/mnt/projects/honcho/src/deriver/` — background consumer/producer queue for derivation.

**Why it's missing from T1075**: The original T1087 dialectic-evaluator is a *synchronous-ish fire-and-forget*. Honcho's deriver is a real **queue** with durable state, retries, and dead-letter handling. For a production-grade integration, we need the queue.

#### 5.1 Durable derivation queue (medium)
- New file: `packages/core/src/memory/derivation-queue.ts`
- Schema: `brain_derivation_queue` (session_id, turn_id, status: `pending|processing|done|failed`, attempts, last_error, enqueued_at)
- SDK: `enqueueDerivation(turn)`, `claimNextDerivation()` (SKIP LOCKED pattern for SQLite via txn), `completeDerivation(id, result)`, `failDerivation(id, err, retry?)`
- Honcho references:
  - `/mnt/projects/honcho/src/deriver/enqueue.py` (producer)
  - `/mnt/projects/honcho/src/deriver/consumer.py` (worker)
  - `/mnt/projects/honcho/src/deriver/queue_manager.py` (state mgmt)

#### 5.2 Worker process (medium)
- New file: `packages/core/src/memory/derivation-worker.ts`
- Runs via `cleo memory derive-worker --watch` (CLI) OR as spawned sub-process in sentient daemon.
- Pulls from queue, calls `evaluateDialectic`, writes results via `applyInsights`.
- Retry policy: exponential backoff, max 5 attempts, then dead-letter.

#### 5.3 Replace synchronous T1088 wire-up (small)
- T1088's `setImmediate` becomes `enqueueDerivation(turn)` — non-blocking as before but DURABLE.
- Acceptance: killing the CLI mid-derivation + restarting worker → derivation completes.

---

### Wave 6 — Dreamer with Surprisal + Specialists + Trees (FILED — T1146)

**Honcho equivalent**: `/mnt/projects/honcho/src/dreamer/` — consolidation with Bayesian surprisal, topic specialists, hierarchical trees.

**Why it's missing from T1075**: We already have `brain-lifecycle.ts` with dream-cycle + `sleep-consolidation.ts` + `brain-consolidator.ts`. But Honcho's dreamer has THREE capabilities ours lacks:

1. **Surprisal scoring** (`surprisal.py`) — Bayesian update: is this observation surprising vs the prior belief? Surprising = high consolidation priority.
2. **Topic specialists** (`specialists.py`) — different consolidation agents for code-patterns vs user-preferences vs decisions.
3. **Hierarchical trees** (`trees/`) — consolidated memory is stored as a tree (parent topic → child observations) not flat.

#### 6.1 Surprisal scoring (medium)
- New file: `packages/core/src/memory/surprisal.ts`
- API: `scoreSurprisal(obs: Observation, priorBelief: BeliefDistribution): number // 0.0-1.0`
- Belief model: Bayesian update over existing `brain_patterns` with same `peer_id` + similar embedding (cosine > 0.8).
- High-surprisal observations get priority-consolidation (bypass rate limit).
- Honcho reference: `/mnt/projects/honcho/src/dreamer/surprisal.py`

#### 6.2 Consolidation specialists (medium)
- Extend `packages/core/src/memory/sleep-consolidation.ts` with specialist dispatch:
  - `user-preference-specialist` — consolidates user_profile traits
  - `decision-specialist` — consolidates decisions + supersession (feeds T1139)
  - `code-pattern-specialist` — consolidates brain_patterns
  - `task-outcome-specialist` — consolidates task completion patterns
- Each specialist is a CANT agent (peer_id in Wave 2 terms) + LLM prompt.
- Honcho reference: `/mnt/projects/honcho/src/dreamer/specialists.py`

#### 6.3 Hierarchical memory trees (large)
- Schema: new table `brain_memory_trees` with (tree_id, parent_tree_id, topic, summary, observation_count)
- Consolidated observations attach to a tree node via new column `tree_id` on `brain_observations`.
- Retrieval: multi-pass (Wave 4) can walk tree from root → relevant subtree based on query.
- Honcho reference: `/mnt/projects/honcho/src/dreamer/trees/`

---

### Wave 7 — Reconciler with Vector Sync (FILED — T1147, MERGES with T1139)

**Honcho equivalent**: `/mnt/projects/honcho/src/reconciler/` — conflict resolution + vector index sync + dead-letter cleanup.

**Already have T1139 filed** — but T1139's scope was *decision supersession only*. Honcho's reconciler handles three distinct concerns:
1. **Semantic conflict resolution** (decisions, traits, patterns) — T1139 scope.
2. **Vector index synchronization** — when observations are updated, re-embed; when superseded, purge from vector index.
3. **Dead-letter queue cleanup** — derivations that failed permanently go to DLQ; periodic scan notifies HITL.

#### 7.1 Extend T1139 scope to include vector sync (medium)
- File: `packages/core/src/memory/brain-reconcile.ts` (new per T1139)
- Add `syncVectorIndex(brainDb)`: for every superseded row, remove from `brain_embeddings` FTS5 index.
- Add `rebuildEmbeddings(brainDb, peerIds?: string[])`: re-embed all non-superseded observations for given peers.
- Honcho reference: `/mnt/projects/honcho/src/reconciler/sync_vectors.py`

#### 7.2 Dead-letter queue (small)
- File: `packages/core/src/memory/derivation-queue.ts` (from Wave 5) — add DLQ operations.
- CLI: `cleo memory dlq list`, `cleo memory dlq retry <id>`, `cleo memory dlq purge --older-than <days>`
- Honcho reference: `/mnt/projects/honcho/src/reconciler/queue_cleanup.py`

#### 7.3 Periodic reconciliation scheduler (medium)
- File: `packages/core/src/sentient/reconcile-scheduler.ts` (extends existing sentient tick)
- Triggers: every N ticks OR on-demand via `cleo memory reconcile`.
- Actions: run decision-supersession scan + vector sync + DLQ cleanup.
- Honcho reference: `/mnt/projects/honcho/src/reconciler/scheduler.py`

---

### Wave 8 — Peer-Card Identity Layer + CANT Integration (FILED — T1148)

**Honcho equivalent**: `/mnt/projects/honcho/src/crud/peer_card.py` + `/mnt/projects/honcho/src/crud/representation.py`

**Why it's missing from T1075**: The original plan tags memory with `peer_id` (string) but doesn't model the *peer card* — the structured identity of a CANT agent as seen by BRAIN. This matters for:
- Rendering agent "profiles" in UI (Studio)
- Storing representation (theory-of-mind for each peer)
- Cross-project portability (export peer card with agent)

#### 8.1 Peer card schema (small)
- File: `packages/core/src/store/memory-schema.ts`
- New table: `peer_cards`
  ```ts
  peerId: text("peer_id").primaryKey(),
  cantFile: text("cant_file"),             // absolute path when available
  displayName, description, mentalModel, toolsAllowed, skillsActive
  representationJson: text("representation_json"),  // theory-of-mind model
  createdAt, updatedAt
  ```

#### 8.2 Auto-populate from CANT
- File: `packages/cant/src/native-loader.ts` — on agent load, upsert peer_card into BRAIN.
- File: `packages/core/src/memory/peer-card.ts` (new) — CRUD + `getPeerRepresentation(peerId)`.

#### 8.3 Representation updates via dialectic
- Extend T1087 `DialecticInsights` with `peerRepresentationDelta: string`
- On insight apply, merge delta into peer_cards.representationJson.
- Honcho reference: `/mnt/projects/honcho/src/crud/representation.py`

#### 8.4 CLI surface
- `cleo agents list` — list peer cards with status
- `cleo agents show <peerId>` — full card + representation
- `cleo agents export <peerId>` — bundle .cant + card + representation for cross-project use
- `cleo agents import <path>` — inverse

#### 8.5 packages/agents/ structural cleanup
- Depends on Wave 0.2 (peer_id SSoT).
- Move `packages/agents/cleo-subagent/cleo-subagent.cant` → canonical location under `seed-agents/` OR vice versa — pick ONE.
- Archive `packages/agents/cleo-subagent/AGENT.md` content into the .cant (it's documentation, not a separate file).
- Update `packages/agents/package.json` exports to only expose the deduplicated paths.

---

## Part 5: Additional Work Not Captured Anywhere

### 5.1 LLM Backend Unification (TBD — consider T1147)

Honcho has its own `src/llm/` layer with backend registry, caching, tool-loop, structured output. CLEO has `packages/core/src/memory/llm-backend-resolver.ts` which is thinner. For dialectic + dreamer + reconciler to work at scale:

- Evaluate caching (Honcho has `llm/caching.py`) — CLEO doesn't cache LLM calls today; dialectic evaluations are high-volume and deterministic-ish → caching is a 10× cost reduction.
- Evaluate conversation adapter (`llm/history_adapters.py`) — CLEO re-serializes context every call; Honcho reuses.
- Evaluate structured output helper (`llm/structured_output.py`) — we're ad-hoc right now; formalize.

### 5.2 Telemetry Surface (TBD — consider T1148)

Honcho has `src/telemetry/` with emission for every memory operation. We have `packages/cleo/src/system/telemetry/` (grep to verify). Cross-reference and align.

### 5.3 Vector Store Adapter (TBD — consider T1149)

Honcho has `src/vector_store/` with pluggable adapters. We have `brain_embeddings` (SQLite FTS5 + separate embedding column). For Wave 7 vector sync to be efficient, consider if we should adopt Honcho's pluggable pattern OR stick with SQLite-native (per current architecture).

### 5.4 Webhook Ingestion (TBD — consider T1150)

Honcho has `src/webhooks/` for inbound event ingestion. CLEO has no webhook surface today. Relevant if CLEO wants to auto-ingest from Granola/Gmail/etc (per Honcho examples).

---

## Part 6: RCASD Artifacts Required

Per CLEO protocol + D023 SDK-first, each Wave needs the full RCASD doc before execution. Orchestrator should produce:

- `.cleo/agent-outputs/T1075-honcho-integration-plan/RCASD-W0-prerequisites.md`
- `.cleo/agent-outputs/T1075-honcho-integration-plan/RCASD-W1-nexus-user-identity.md`
- `.cleo/agent-outputs/T1075-honcho-integration-plan/RCASD-W2-cant-peer-isolation.md`
- `.cleo/agent-outputs/T1075-honcho-integration-plan/RCASD-W3-dialectic-evaluator.md`
- `.cleo/agent-outputs/T1075-honcho-integration-plan/RCASD-W4-multipass-context.md`
- `.cleo/agent-outputs/T1075-honcho-integration-plan/RCASD-W5-deriver-queue.md`
- `.cleo/agent-outputs/T1075-honcho-integration-plan/RCASD-W6-dreamer-surprisal.md`
- `.cleo/agent-outputs/T1075-honcho-integration-plan/RCASD-W7-reconciler-vectorsync.md`
- `.cleo/agent-outputs/T1075-honcho-integration-plan/RCASD-W8-peer-card-cant.md`

Each follows the standard RCASD template (Requirements · Context · Architecture · Solution · Deliverables) with explicit:
- CLEO file paths to create/modify
- Honcho source file references for each design decision
- Contract types (Params/Result) in `packages/contracts/`
- Test fixtures + expected behavior
- Dependency graph on other waves

---

## Part 7: Wave Execution Order

```
Wave 0 (T1144) — PREREQUISITE [HARD BLOCKER: cleo-db-lead E_AGENT_NOT_FOUND]
  ├── 0.1 Honcho source audit
  ├── 0.2 packages/agents/ cleanup + peer_id SSoT [FIXES E_AGENT_NOT_FOUND]
  └── 0.3 Glossary
       │
       ▼
Wave 1 (T1076) ────▶ Wave 2 (T1081) ────▶ Wave 3 (T1082)
 User profile       Peer isolation        Dialectic evaluator
 schema + CRUD      schema + filters      + session narrative
       │                 │                       │
       └─────────────────┴───────────────────────┘
                         ▼
Wave 4 (T1083) — Multi-pass retrieval engine (stitches 1+2+3)
                         │
                         ▼
Wave 5 (T1145) — Deriver queue (replaces T1088 sync wire-up)
                         │
                         ▼
Wave 6 (T1146) — Dreamer surprisal + specialists + trees
                         │
                         ▼
Wave 7 (T1147) — Reconciler (absorbs T1139 + vector sync + DLQ)
                         │
                         ▼
Wave 8 (T1148) — Peer card + CANT representation
                         │
                         ▼
Wave 9 (T1149) — Conduit Agent-to-Agent communication [CRITICAL · SUBSTRATE]
  Enables all Leads to coordinate peer-to-peer rather than one-shot manifest
  return to orchestrator. Without Wave 9: Waves 1-8 execute serially; with
  Wave 9: Waves 1+2 parallel, 3+4 serialize via conduit-notify, 5-8 true mesh.

 Optional: T1147-T1150 additional — LLM unification, telemetry, vector store, webhooks
```

## Part 7b: Critical Substrate Triad — STATUS as of v2026.4.115

> **Updated 2026-04-23**: scope-flipped per D029/D030; reconciled vs shipped state. Original prose (worktrunk-wrap, `.cleo/.trees/` layout, dotted-ID Wave 0 subtasks) is SUPERSEDED.

| ID | Name | Status |
|----|------|--------|
| **T1140** (Meta-A worktree-by-default spawn) | `## Worktree Setup (REQUIRED)` section emission + SDK routing + `--no-worktree` CLI flag | ✅ **SHIPPED v2026.4.115** (commit 7de4d1716). `cleo orchestrate spawn` auto-provisions worktrees via `spawnWorktree()` in `worktree-dispatch.ts`. |
| **T1161** (Native worktree-backend SDK) | `packages/worktree-backend/` — `createWorktree`/`destroyWorktree`/`listWorktrees`/`pruneWorktrees` + hooks framework + include glob | ✅ **SHIPPED v2026.4.115** (commit 775c9b1b6). D030 native implementation — ZERO worktrunk dep. |
| **T1144.0.2 ≡ T1210** (packages/agents/ cleanup) | PeerIdentity contract + native-loader hardening + dedup | ✅ **SHIPPED v2026.4.115** (commit 60c15af85). Additionally T1232 parallel-agent scope shipped v2026.4.110 — generic templates + meta-agents framework. |
| **T1149** (Conduit A2A integration) | Agent-to-agent coordination substrate — mesh-style Lead coordination replacing human-relay | ❌ **DEFERRED** — still the remaining substrate gap. Without this, Leads serialize via orchestrator manifest return instead of communicating peer-to-peer. |

**Original Wave 0 prerequisite epic (T1144)** — all 3 subtasks shipped v2026.4.115:
- T1209 — Honcho source audit → `HONCHO-SOURCE-NOTES.md` ✅
- T1210 — packages/agents/ cleanup + PeerIdentity ✅ (doubles as T1144.0.2)
- T1211 — Honcho↔CLEO glossary → `GLOSSARY.md` ✅

**Net substrate state**: 3/4 triad items shipped. T1149 Conduit A2A is the sole remaining substrate blocker. Until it ships, parallel Lead dispatch falls back to orchestrator-as-hub pattern (proved in v2026.4.115: 5 Leads in one wave, but coordination cost paid by orchestrator + human relay).

**Waves 1–9 execution order** (unchanged): 1+2 parallel → 3+4 serial → 5 after 3 → 6 after 1+2 → 7 after 5 → 8 after 0+2 → 9 Conduit anytime (but sooner unlocks true mesh for 5–8).

---

## Part 8: Acceptance for THIS plan

This document is accepted when:
1. ✅ All 17 existing T1075-T1092 tasks verified structurally parented correctly
2. ✅ Honcho source inventoried with all subsystem paths (done above)
3. ✅ CLEO target file inventory for memory/sessions/store/nexus/dispatch/cant/agents (done above)
4. ✅ Four missing Waves (0, 5, 6, 7) identified + fifth (Wave 8 peer-card) captured
5. ⏳ New epic IDs filed for missing Waves (T1142-T1146 to be added)
6. ⏳ Handoff updated to reference this plan as the canonical Honcho integration master doc
7. ⏳ Existing T1075-T1092 task descriptions enriched with file paths (deferred to worker tasks — orchestrator can do batch `cleo update` per task)

---

## Part 10: Four-Pillar Integration (T1151 MASTER anchor)

Per owner's architectural vision 2026-04-21, CLEO self-healing / self-improving / persona-maintaining capability maps to four pillars. This part translates them to CLEO files + existing tasks + new work.

### Pillar 1 — Event-Driven Nervous System (SELF-HEALING)

**Goal**: Every LLM call + tool call is an independent durable step. Failures isolate + trigger reflection; they don't cascade. Audit trail is inherent because actions are event-sourced.

| File / capability | Status | Task |
|---|---|---|
| `packages/core/src/sentient/tick.ts` | Exists (T1007 Tier 2) | — |
| `packages/core/src/memory/precompact-flush.ts` | Exists (T1004) | — |
| `packages/core/src/memory/derivation-queue.ts` | NEW | T1145 Wave 5 |
| `packages/core/src/sentient/reconcile-scheduler.ts` | NEW | T1147 Wave 7 |
| Step-level retry wrapper around LLM+tool calls | NEW | Propose as T1152 (under T1151) |
| Reflection agent (catches worker failure, proposes retry) | NEW | Propose as T1153 (under T1151) |

**Pillar 1 is the PREREQUISITE for Pillar 2** — hierarchical memory needs reliable writes.

### Pillar 2 — Hierarchical Pluggable Memory (PERSONA)

**Goal**: `.cleo/` project brain = short-term working memory with context pruning; NEXUS global = long-term with tree-structured sessions (id + parentId branching). Memory extracted OUT of LLM into CLEO harness — proprietary persona substrate.

| File / capability | Status | Task |
|---|---|---|
| `packages/core/src/memory/brain-retrieval.ts` → multi-pass | Exists flat | T1090 Wave 4 |
| `packages/core/src/memory/session-narrative.ts` | NEW | T1089 Wave 3 |
| `brain_memory_trees` table (hierarchical consolidation) | NEW | T1146 Wave 6.3 |
| Session tree (id + parentId branching) | NEW | Propose as T1154 (under T1151) |
| Soft-trim context pruning for older tool outputs | NEW | Propose as T1155 (under T1151) |

### Pillar 3 — Sub-Agent Context Isolation (SUBCONSCIOUS)

**Goal**: `delegate_task` spawns specialists with isolated context that return clean summaries. Orchestrator persona preserved.

| File / capability | Status | Task |
|---|---|---|
| `cleo orchestrate spawn` — default to worktree | Partial | **T1140** (SUBSTRATE) |
| `packages/agents/` canonical layout | Broken today | **T1144.0.2** (SUBSTRATE — E_AGENT_NOT_FOUND evidence) |
| Conduit agent-to-agent messaging | Missing | **T1149** (SUBSTRATE — Wave 9) |
| Conduit-aware spawn prompts (tier-2) | Partial | T1149.9.3 |
| Context budget per sub-agent (token quotas) | NEW | Propose as T1156 (under T1151) |

### Pillar 4 — Aggressive Extensibility (MOLDABLE CLAY)

**Goal**: Core is model-agnostic + backend-agnostic. CLI is one surface of many.

| File / capability | Status | Task |
|---|---|---|
| `packages/core/src/memory/llm-backend-resolver.ts` | Thin | Extend with Honcho `llm/` pattern |
| `packages/core/` SDK typed surface | Partial | T1107 (14 Living Brain verbs) |
| MCP adapter over core SDK | None | Propose as T1157 (under T1151) |
| TUI adapter over core SDK | None | Propose as T1158 (under T1151) |
| Pluggable filesystem / sandbox backend | None | Propose as T1159 (under T1151) |

### Pillar-to-Wave Dependency Matrix

```
              Pillar 1  Pillar 2  Pillar 3  Pillar 4
              event     memory    isolation ext
T1144 Wave 0     —         —         ★★★       —        ★★★ = blocker
T1076 Wave 1     ★         ★★        —         —
T1081 Wave 2     —         ★★        ★         —
T1082 Wave 3     ★★        ★★        —         —
T1083 Wave 4     —         ★★★       —         ★
T1145 Wave 5     ★★★       —         ★         —
T1146 Wave 6     —         ★★★       —         —
T1147 Wave 7     ★★★       ★         —         —
T1148 Wave 8     —         ★★        ★★        —
T1149 Wave 9     ★★        —         ★★★       ★★
T1140 Meta-A     —         —         ★★★       —
T1141 Meta-B     ★         —         —         —
```

### Ship-Order Recommendation

1. **Release R1** (substrate) — T1140 + T1141 + T1144 (0.2 agent registry fix) → v2026.4.108
2. **Release R2** (event-driven foundation) — T1145 + step-retry wrapper + T1149 Conduit core → v2026.4.109
3. **Release R3** (Honcho schema + identity) — T1076 + T1081 + T1148 peer-card → v2026.4.110
4. **Release R4** (intelligence layer) — T1082 + T1083 + T1146 → v2026.4.111
5. **Release R5** (reconciliation + full substrate) — T1147 (absorbs T1139) → v2026.5.0 *"CLEO Sentient v1"*
6. **Release R6** (extensibility proof) — MCP + TUI adapter → v2026.5.1

---

## Part 9: Next Steps for the Fresh Orchestrator

When the next session opens:

1. `cat .cleo/agent-outputs/NEXT-SESSION-HANDOFF.md` — read the handoff.
2. `cat .cleo/agent-outputs/T1075-honcho-integration-plan/PLAN.md` — read this plan (you are here).
3. Decide: ship T1140 worktree-by-default FIRST (substrate), then Wave 0 prerequisite tasks.
4. Use `cleo orchestrate start T1075` to initialize the epic pipeline.
5. Spawn Wave 0 workers in parallel on isolated worktrees.
6. Per D023: every new capability lands as a core SDK primitive FIRST with contract types, dispatch surface SECOND.

---

## Part 11: Native Worktree Backend — SHIPPED v2026.4.115 (T1161 / D030)

> **Status 2026-04-23**: the former "Worktrunk Core-Baked Integration Spec (D026)" section is OBSOLETE and has been removed. D026 was superseded by **D030** (native CLEO implementation, zero worktrunk dependency) on 2026-04-22 after an independent audit confirmed CLEO already had most of the substrate internally (`packages/cant/src/worktree.ts` + `packages/cleo-git-shim/` + `packages/core/src/spawn/branch-lock.ts` + `packages/core/src/sentient/baseline.ts` / `merge.ts` + `classify.ts`). Worktrunk offered only two patterns worth keeping — declarative hooks + `.worktreeinclude` glob — and those were lifted as native additions. Worktree canonical path = `~/.local/share/cleo/worktrees/<projectHash>/<taskId>/` per **D029** (env-paths-based, supersedes both D022 sibling and D025 `.cleo/.trees/` nested).

### 11.1 Shipped SDK surface

`packages/worktree-backend/src/` (10 source files + tests — commit `775c9b1b6` on v2026.4.115 tag):

```
packages/worktree-backend/
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── src/
    ├── index.ts                   ← public SDK exports
    ├── paths.ts                   ← env-paths resolution (D026-compliant)
    ├── git.ts                     ← git primitives wrapper
    ├── worktree-create.ts         ← createWorktree(opts): WorktreeHandle
    ├── worktree-destroy.ts        ← destroyWorktree(slug): void
    ├── worktree-list.ts           ← listWorktrees(opts?): WorktreeHandle[]
    ├── worktree-prune.ts          ← pruneWorktrees(): { pruned, errors }
    ├── worktree-hooks.ts          ← declarative post-create/post-start hooks
    ├── worktree-include.ts        ← .cleo/worktree-include glob pattern
    ├── compat.ts                  ← re-export shim for packages/cant/src/worktree.ts consumers (deprecation-safe)
    └── __tests__/                 ← 5 test files covering paths, hooks, include, list, prune
```

Consumed by `packages/core/src/sentient/worktree-dispatch.ts` (`spawnWorktree` / `teardownWorktree` / `listProjectWorktrees` / `pruneWorktreesForProject` / `warmupWorktreeBackend`) which in turn is called from `packages/core/src/orchestrate/spawn-prompt.ts` (`buildWorktreeSetupBlock`).

### 11.2 What's still open

These items from the original spec are **NOT in T1161 acceptance** but ARE worth filing as follow-up tasks when they become needed:

1. **Dedicated `cleo worktree` CLI surface** — today worktree ops are accessible via `cleo orchestrate spawn` (auto-provision) and internally via the SDK. A first-class `cleo worktree list | prune | show <id>` surface would help HITL debugging. Deferred until demand surfaces.
2. **Multi-project root (`cleo projects list | add | remove`)** — cross-project view. Deferred; `env-paths` handles per-machine isolation cleanly without an explicit project registry.
3. **E2E concurrent-spawn regression test** — spawn 3+ Leads in parallel, verify isolated worktrees + clean prune. Proved manually in v2026.4.115 (5 Leads in parallel). Formalize as a test when CI adds a real multi-Lead scenario.
4. **psmux durable sessions** — original spec deferred this to T1151 Pillar 1. Still correct; worktrees give filesystem isolation, psmux adds process-lifetime durability. Different concerns.

### 11.3 T1161 acceptance — reconciled against shipped state

The original T1161 acceptance array (still in tasks.db as of 2026-04-23) carries pre-D029/D030 items that are now moot (`.cleo/.trees/` layout, `.gitignore .cleo/.trees/` entry, "runtime-selects backend bundled > system wt > raw git"). Those criteria are **superseded** by the D029/D030 corrections and the shipped implementation. Effective v2026.4.115 criteria:

- ✅ `packages/worktree-backend/` exists with SDK surface
- ✅ `packages/core/src/sentient/worktree-dispatch.ts` routes to native SDK (no runtime backend-selector — there is only one backend: native)
- ✅ `cleo orchestrate spawn` emits `## Worktree Setup (REQUIRED)` section via SDK (T1140)
- ✅ Worktree layout per D029: `~/.local/share/cleo/worktrees/<projectHash>/<taskId>/` via env-paths
- ✅ Baseline validator integrated via `packages/core/src/sentient/baseline.ts` (already existed)
- ✅ Context isolation text: "authorized only within `<worktreePath>`" embedded in spawn prompt (T1140)
- ✅ Cleanup: `worktree-prune.ts` SDK primitive; `cleo sentient tick` prune-loop wiring is T1244 GAP work (deferred)
- ✅ `cleo orchestrate spawn` smoke-tested: 5 Leads in parallel (T1209/T1210/T1211/T1161/T1140), each with its own worktree, all IVTR-reconciled
- ✅ biome + build + test green (v2026.4.115 release gates)

---

*Plan authored ses_20260421173407_ac5c20 (2026-04-21, zero code). Reconciled against shipped v2026.4.115 state ses_20260422131135_5149eb (2026-04-23): Part 7b updated to reflect 3/4 substrate triad complete; Part 11 replaced obsolete worktrunk spec with shipped native implementation reference; Honcho Wave 0 (T1144 + T1209/T1210/T1211) marked complete; Waves 1–9 unchanged.*
