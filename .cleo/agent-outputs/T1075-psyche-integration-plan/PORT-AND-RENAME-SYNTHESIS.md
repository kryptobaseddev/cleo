# Honcho → PSYCHE Port + Rename Synthesis

**Session**: ses_20260422131135_5149eb · **Date**: 2026-04-23
**Authority**: Owner confirmation 2026-04-23 (direct port rights from PSYCHE team)
**Decisions**: D032 (PSYCHE rename) · D033 (direct-port strategy) · Pattern O-mobktdxk-0 (15K LOC inventory)
**New tasks**: T1255 (rename execution) · T1256 (LLM port Wave 10)
**Supersedes**: prior AGPL-aware reimplementation model in PLAN.md Part 11

---

## 1. Scope of the port (what we're getting)

Four parallel Explore agents audited PSYCHE's full source tree. Total port surface: **~15,000 LOC** across nine subsystems. PSYCHE has MORE than CLEO on almost every axis; the only CLEO wins are Hebbian plasticity + NEXUS cross-substrate graph + existing dream trigger logic. Everything else is a straight port opportunity.

### 1.1 Per-subsystem disposition matrix

| PSYCHE subsystem | LOC | Files | Disposition | Target |
|------------------|----:|------:|-------------|--------|
| `models.py` + schemas/ | ~1000 | 4 | **ADAPT** | `packages/core/src/store/memory-schema.ts` extensions |
| `crud/` foundation (peer, peer_card, session, message, workspace) | ~3200 | 5 | **ADAPT** | `packages/core/src/memory/{peer,sigil,session,message,workspace}.ts` |
| `crud/` intelligence (representation, document) | ~1640 | 2 | **ADAPT** | `packages/core/src/memory/{representations,observations}.ts` |
| `crud/deriver.py` | 220 | 1 | **DIRECT-PORT** | `packages/core/src/queue/status.ts` |
| `llm/` multi-model abstraction | **5680** | **13** | **HYBRID** | `packages/core/src/llm/` (new — T1256) |
| `dialectic/` (core + chat + prompts) | 890 | 3 | **ADAPT** | `packages/core/src/dialectic/agent.ts` |
| `deriver/` queue pipeline | 2104 | 6 | **DIRECT-PORT** | `packages/core/src/deriver/` (satisfies T1145) |
| `dreamer/` | 1760 | 5 | **ADAPT + DIRECT** | `packages/core/src/memory/{surprisal,specialists,dream-*}.ts` |
| `dreamer/trees/rptree.py` ONLY | 157 | 1 | **DIRECT-PORT** | `packages/core/src/memory/surprisal-tree.ts` |
| `reconciler/` (scheduler + sync_vectors) | 878 | 2 | **DIRECT-PORT** | `packages/core/src/memory/reconciler/` (satisfies T1139) |
| `telemetry/` event types + emitter | ~1100 | 6 | **ADAPT** | `packages/core/src/telemetry/` |
| `utils/agent_tools` + `json_parser` | ~91K | 2 relevant | **ADAPT + DIRECT** | `packages/core/src/memory/specialist-tools.ts` + `utils/json-repair.ts` |
| `config.py` subset | ~200 | 1 | **ADAPT** | existing `packages/core/src/config/` |

### 1.2 Subsystems we SKIP

- `routers/` (2.0K LOC, 7 files) — REST/FastAPI; CLEO is CLI-first. Revisit IF Pillar 4 MCP adapter needs REST bridge.
- `vector_store/` (3 files: lancedb, turbopuffer, base) — CLEO uses SQLite FTS5 native; porting multi-backend abstraction adds weight for no benefit today.
- `webhooks/` (5.4K) — CLEO has no webhook surface; revisit for agent integration later.
- `cache/` (Redis-backed) — CLEO uses file-based memory; port would add Redis dependency.
- `main.py` FastAPI entry — incompatible with CLI architecture.
- `collection.py` — implicit via `peer_id` grouping; no materialized table per our earlier decision.
- `reconciler/queue_cleanup.py` — low-priority maintenance; not on critical path.
- `dreamer/trees/{covertree,lsh,graph,prototype,sklearn_wrapper}.py` — rptree subsumes all of these at lower complexity.

---

## 2. Schema deltas for Wave 2 BRAIN migration

The port requires schema extensions to `packages/core/src/store/memory-schema.ts`:

```sql
-- NEW TABLE — sigils (structured identity; maps to Sigil if owner picks that name)
CREATE TABLE sigils (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES projects(id),
  observer_id TEXT NOT NULL,             -- peerId from CANT
  observed_id TEXT NOT NULL,
  content TEXT NOT NULL,                 -- JSON array of mental-model strings
  cant_file TEXT,                         -- absolute path when available
  display_name TEXT,
  description TEXT,
  mental_model TEXT,                      -- theory-of-mind JSON
  tools_allowed TEXT,                     -- JSON array
  skills_active TEXT,                     -- JSON array
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(workspace_id, observer_id, observed_id)
);

-- NEW TABLE — embedding reconciliation tracking (per T1139 Wave 7)
CREATE TABLE observation_embeddings (
  id INTEGER PRIMARY KEY,
  observation_id INTEGER UNIQUE REFERENCES brain_observations(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,               -- serialized float32 vector
  sync_state TEXT DEFAULT 'pending',     -- pending | synced | failed
  last_sync_at INTEGER,
  sync_attempts INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_obs_emb_sync ON observation_embeddings(sync_state, last_sync_at);

-- NEW TABLE — session turn embeddings (dialectic + narrative retrieval)
CREATE TABLE turn_embeddings (
  id INTEGER PRIMARY KEY,
  turn_id INTEGER REFERENCES session_turns(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  embedding BLOB NOT NULL,
  sync_state TEXT DEFAULT 'pending',
  last_sync_at INTEGER,
  sync_attempts INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- EXTEND brain_observations with derivation tracking
ALTER TABLE brain_observations ADD COLUMN source_ids TEXT;       -- JSON array of ancestor IDs
ALTER TABLE brain_observations ADD COLUMN times_derived INTEGER DEFAULT 1;
ALTER TABLE brain_observations ADD COLUMN level TEXT DEFAULT 'explicit';
-- CHECK(level IN ('explicit','deductive','inductive','contradiction'))
ALTER TABLE brain_observations ADD COLUMN tree_id INTEGER;       -- FK to brain_memory_trees (Wave 6)
```

**Critical**: migration MUST pass through T1141 (Meta-B) trailing-marker sanitizer once that ships. Also benefits from D022/D025/D029 evolution — write migration against the current D029 env-paths-aware substrate.

---

## 3. Rename execution (T1255)

### 3.1 Directory renames (via `git mv` to preserve history)

Historical record of the rename transformation (executed under T1255):

```bash
# original → new
git mv .cleo/agent-outputs/T1075-honcho-integration-plan/ \
        .cleo/agent-outputs/T1075-psyche-integration-plan/

git mv .cleo/agent-outputs/T1075-psyche-integration-plan/HONCHO-SOURCE-NOTES.md \
        .cleo/agent-outputs/T1075-psyche-integration-plan/PSYCHE-SOURCE-NOTES.md

git mv packages/core/src/memory/__tests__/honcho-wave4.test.ts \
        packages/core/src/memory/__tests__/psyche-wave4.test.ts
```

### 3.2 In-file rename map (31 files)

Files requiring `Honcho → PSYCHE` + `honcho → psyche` global substitution (exceptions noted):

**Planning docs** (5 files): PLAN.md · PSYCHE-SOURCE-NOTES.md · GLOSSARY.md · CONDUIT-A2A-DESIGN.md · T1082-wave3-dialectic-evaluator.md · T1083-wave4-multi-pass-retrieval.md · NEXT-SESSION-HANDOFF.md · V2026.4.110-RELEASE-PLAN.md

**Source comments** (14 files):
- `packages/core/src/nexus/{user-profile.ts, transfer.ts}`
- `packages/core/src/memory/{dialectic-evaluator.ts, session-narrative.ts, index.ts, graph-memory-bridge.ts, brain-search.ts, brain-retrieval.ts}`
- `packages/core/src/sessions/briefing.ts`
- `packages/core/src/store/{nexus-schema.ts, memory-schema.ts, memory-sqlite.ts}`
- `packages/contracts/src/operations/{nexus-user-profile.ts, dialectic.ts, memory.ts}`
- `packages/contracts/src/index.ts`

**Dispatch layer** (5 files): `packages/cleo/src/dispatch/registry.ts` · `dispatcher.ts` · `__tests__/parity.test.ts` · `domains/__tests__/nexus.test.ts` · `packages/core/src/store/__tests__/memory-peer-isolation.test.ts`

**Migration SQL** (3 files) — update migration header comments only (don't touch SQL body):
- `packages/core/migrations/drizzle-nexus/20260423052640_t1077-add-user-profile-table/migration.sql`
- `packages/core/migrations/drizzle-brain/20260423000001_t1084-peer-id-memory-isolation/migration.sql`
- `packages/core/migrations/drizzle-brain/20260423000002_t1089-add-session-narrative-table/migration.sql`

**CHANGELOG.md** — 12 occurrences of "PSYCHE Wave X" references

### 3.3 Rules for the rename

1. **Global substitution**: `Honcho` → `PSYCHE` (uppercase canonical). `honcho` (lowercase) → `psyche` ONLY in file/directory/test-name contexts.
2. **Preserve external citations**: any string containing `/mnt/projects/honcho/` MUST stay intact (external source repo path).
3. **Preserve external type names**: `HonchoLLMCall*` external Pydantic type names (when referenced for inspiration) stay intact — they're not CLEO types.
4. **Task records**: update via `cleo update T<id> --title "..."` and `--description "..."` for T1075, T1076-T1083, T1089, T1092, T1209, T1211.
5. **Peer Card vs Sigil naming**: RESOLVED 2026-04-23 — owner chose **Sigil**. All CLEO-facing identifiers for the structured peer-identity record use "sigil" / "sigils" table / `packages/core/src/memory/sigil.ts`. External `/mnt/projects/honcho/src/crud/peer_card.py` references remain intact (external source citation).
6. **Post-rename verification**: `git grep -i "honcho"` MUST return only lines with `/mnt/projects/honcho/` path, `HonchoLLMCall` external type refs, or this synthesis doc's historical rename-rule descriptions. No other `honcho` survives in CLEO-owned code or active docs.

### 3.4 Quality gates

```bash
pnpm biome check --write .
pnpm run build           # full monorepo
pnpm run test            # 640 files, verify zero new failures
git grep -i "psyche"     # verification — only external refs should remain
```

---

## 4. Port execution plan — wave-by-wave with file destinations

### Wave 10 — LLM Layer Port (T1256 — NEW)

Port PSYCHE's `src/llm/` (5680 LOC) as the canonical CLEO multi-model substrate. **Ship FIRST** because Waves 3 (dialectic) + 5 (deriver) + 6 (dreamer specialists) all depend on LLM abstraction.

| PSYCHE | CLEO target | Disposition |
|--------|-------------|-------------|
| `llm/executor.py` (227) | `packages/core/src/llm/executor.ts` | DIRECT-PORT |
| `llm/tool_loop.py` (491) | `packages/core/src/llm/tool-loop.ts` | DIRECT-PORT |
| `llm/request_builder.py` (80) | `packages/core/src/llm/request-builder.ts` | DIRECT-PORT |
| `llm/caching.py` (98) | `packages/core/src/llm/cache.ts` | ADAPT — provider-agnostic + Redis hook |
| `llm/structured_output.py` (132) | `packages/core/src/llm/structured-output.ts` | ADAPT — Zod not Pydantic; 3-tier fallback |
| `llm/registry.py` (186) | `packages/core/src/llm/provider-registry.ts` | ADAPT — DI-friendly |
| `llm/api.py` | `packages/core/src/llm/api.ts` | ADAPT — custom retry wrapper |
| `llm/backends/{anthropic,openai,gemini}.py` | `packages/core/src/llm/backends/` | DIRECT-PORT per backend |
| `llm/history_adapters.py` | `packages/core/src/llm/history-adapters.ts` | DIRECT-PORT |

**Value**: Satisfies Pillar 4 (model-agnosticism) in one port. Replaces our thin `llm-backend-resolver.ts`. 30+ new unit tests on cache-key generation + JSON repair + tool-loop edge cases.

### Wave 1 (T1076) — NEXUS User Identity

Port `crud/peer.py` + `crud/peer_card.py` + `crud/workspace.py` → `packages/core/src/memory/{peer,sigil,workspace}.ts`. Already filed T1077-T1080; descriptions need enrichment with file paths.

### Wave 2 (T1081) — Peer Memory Isolation + schema deltas

Port `models.py` peer + session schema. Execute schema migration per § 2 above. Update `graph-memory-bridge.ts` + `brain-retrieval.ts` with `peer_id` filter per T1085.

### Wave 3 (T1082) — Dialectic Evaluator

Port `dialectic/core.py` + `dialectic/prompts.py` → `packages/core/src/dialectic/agent.ts` + `prompts.ts`. Prompts are **90% reusable** for Claude 4.x per Agent B analysis. Wire background hook into CQRS dispatcher (T1088).

### Wave 4 (T1083) — Multi-Pass Retrieval

Already **SHIPPED v2026.4.120**. Post-rename, the test file becomes `psyche-wave4.test.ts`.

### Wave 5 (T1145) — Deriver Queue

Port `deriver/queue_manager.py` (876 LOC) wholesale → `packages/core/src/deriver/queue-manager.ts`. Uses PostgreSQL `FOR UPDATE SKIP LOCKED` pattern — adapt SQL dialect for SQLite WAL mode. Port `consumer.py` + `deriver.py` + `enqueue.py` alongside. **Production-grade pattern that beats our filesystem queue ideas.**

### Wave 6 (T1146) — Dreamer with Surprisal + Specialists + RPTree

Port `dreamer/orchestrator.py` (333) + `surprisal.py` (492) + `specialists.py` (598) + `trees/base.py` (63) + `trees/rptree.py` (157 — ONLY tree variant). ADAPT `specialists.py` to extend `BaseSpecialist` with 4 new CLEO-specific specialists: `UserPreferenceSpecialist`, `DecisionSpecialist`, `CodePatternSpecialist`, `TaskOutcomeSpecialist`. ADAPT `surprisal.py` with temporal-decay + confidence-weighting (CLEO improvements).

### Wave 7 (T1147) — Reconciler + T1139 merge

Port `reconciler/scheduler.py` (268) + `sync_vectors.py` (610) wholesale → `packages/core/src/memory/reconciler/`. `sync_vectors.py` directly solves T1139's vector-sync gap. Adds DLQ surface via `cleo memory dlq list|retry|purge`.

### Wave 8 (T1148) — Sigil Identity

Apply schema delta from § 2 for `sigils` table. Port `crud/peer_card.py` CRUD → `packages/core/src/memory/sigil.ts`. Wire `packages/cant/src/native-loader.ts` to upsert sigil on CANT load. Extend `DialecticInsights.peerRepresentationDelta` to merge into `sigils.mental_model`.

### Wave 9 (T1149) — Conduit A2A

Unchanged from earlier plan. Does NOT use PSYCHE webhooks (we skip that subsystem). Native CLEO conduit-sqlite implementation.

---

## 5. CLEO improvements on top of PSYCHE (the "MORE" delta)

Per owner "ALL of what PSYCHE has today but MORE and improved". Concrete CLEO improvements vs pure port:

1. **Hebbian plasticity** (T998 already shipped) — PSYCHE has no co-access weight update. CLEO's `nexus-plasticity.ts` already strengthens relations on joint retrieval. **Wave 2 retains this**; the port doesn't replace it.
2. **NEXUS cross-substrate graph** — PSYCHE has only pgvector. CLEO has the living-brain substrate (5-way: BRAIN+NEXUS+TASKS+CONDUIT+SIGNALDOCK). The ported observations gain cross-substrate edges for free.
3. **Temporal-decay + confidence-weighted surprisal** — add on top of PSYCHE's geometric surprisal for richer priority scoring (Wave 6).
4. **Four extra specialists** — PSYCHE ships Deduction + Induction. CLEO adds User-Preference + Decision + Code-Pattern + Task-Outcome (Wave 6).
5. **Event-sourced tool-loop** — PSYCHE's `tool_loop.py` retries per-iteration but has no durable checkpointing. T1151 Pillar 1 layers event-sourcing on top: every tool call becomes an `ExecuteToolEvent` that can replay on worker restart.
6. **Multi-model registry default** — PSYCHE targets Gemini primarily with OpenAI/Anthropic support. CLEO defaults to Claude 4.x with equal first-class status for all three.
7. **Conduit A2A integration** (T1149) — PSYCHE has none; CLEO Leads coordinate mesh-style via Conduit, not just return manifests.
8. **Worktree-bounded specialist execution** — each specialist (Wave 6) can run in its own isolated `.cleo/.trees/<slug>` worktree per D029; PSYCHE has no worktree concept.
9. **CANT agent identity as peer** — PSYCHE peers are REST-account-tied; CLEO peers ARE CANT agents with full `peer_id` = CANT identifier. Better integration with existing `packages/cant/`.
10. **BRAIN auto-reconcile on decisions** (T1139) — PSYCHE reconciler handles vector sync but not semantic-conflict decision supersession. CLEO adds that as separate layer (still active).

---

## 6. Open naming questions for owner

1. **Peer Card vs Sigil** — RESOLVED 2026-04-23: owner chose **Sigil**. Canonical type: `Sigil` (TS interface in `packages/contracts/src/sigil.ts`). Canonical table: `sigils`. Canonical file: `packages/core/src/memory/sigil.ts`. External references to `peer_card.py` stay intact as source-of-inspiration citations.
2. **Surprisal trees vs Novelty trees** — both acceptable. Surprisal is the technical term used in PSYCHE + literature. Recommend keeping.
3. **PSYCHE initials** — do we eventually spell it out as an acronym? (P.S.Y.C.H.E. = ?) Or leave as mythological name. Recommend leaving as mythological name per D032 rationale.

---

## 7. Ship order recommendation

Revised to account for port + rename + substrate:

| Release | Content | Epic/task IDs |
|---------|---------|---------------|
| v2026.4.121 | **T1255 rename execution** (substrate — no code-behavior change) | T1255 |
| v2026.4.122-.124 | **T1256 LLM Layer Port** (Wave 10) — unlocks all downstream waves | T1256 |
| v2026.4.125 | Wave 1 (user_profile) + Wave 2 (peer_id) port together | T1076 + T1081 (parallel) |
| v2026.4.126 | Wave 3 dialectic port + Wave 5 deriver queue port | T1082 + T1145 (parallel) |
| v2026.4.127 | Wave 6 dreamer + rptree + specialists | T1146 |
| v2026.4.128 | Wave 7 reconciler (subsumes T1139) | T1147 |
| v2026.4.129 | Wave 8 sigil + Wave 9 Conduit A2A | T1148 + T1149 |
| **v2026.5.0** | **"CLEO Sentient v1"** — 4-pillar integration consolidation + MCP adapter proof | T1151 |

---

## 8. For the next orchestrator

Opening move:
```bash
cleo --version                                              # verify v2026.4.120+
cat .cleo/agent-outputs/NEXT-SESSION-HANDOFF.md             # handoff
cat .cleo/agent-outputs/T1075-psyche-integration-plan/PLAN.md             # master plan
cat .cleo/agent-outputs/T1075-psyche-integration-plan/PORT-AND-RENAME-SYNTHESIS.md  # this doc
cleo memory fetch D032 D033                                 # rename + port decisions
cleo show T1255                                             # rename execution task
cleo show T1256                                             # LLM layer port epic
```

First action: ship T1255 rename as v2026.4.121 (substrate-only, no behavior change). Then spawn T1256 LLM port Lead in an isolated worktree per D029. Every subsequent Wave depends on T1256 shipping first.
