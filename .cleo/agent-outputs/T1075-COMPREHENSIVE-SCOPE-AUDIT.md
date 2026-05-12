# T1075 PSYCHE Memory Integration — Comprehensive Scope Audit

**Audited**: 2026-04-24 (read-only, no edits)
**Evidence basis**: PLAN.md, PORT-AND-RENAME-SYNTHESIS.md, PSYCHE-SOURCE-NOTES.md, GLOSSARY.md, CONDUIT-A2A-DESIGN.md, CONDUIT-AUDIT.md, NEXT-SESSION-HANDOFF.md, git tag history (v2026.4.110–v2026.4.141), npm verification, filesystem spot-checks of target files, migration SQL files, schema source code, force-bypass.jsonl audit log.

---

## Section 1 — Executive Summary

1. **T1075 is formally archived (18/18 child rollup done)** per the handoff, but the "done" verdict is only partially backed by real code on disk. About 65–70% of the PLAN.md integration surface has provable shipped artifacts. The remaining 30–35% is either phantom-closed (T1256 placeholder), deferred to a continuation task (T1386 — which itself fully shipped), or explicitly out-of-scope per owner decisions.

2. **All four core schema migrations shipped and are confirmed on disk**: `user_profile` table (T1077/migration `20260423052640`), `peer_id`/`peer_scope` columns on all four brain tables (T1084/migration `20260423000001`), `session_narrative` table (T1089/migration `20260423000002`), and `sigils` table (T1148/migration `20260424140538`). These are the hardest-to-fake evidence atoms.

3. **Waves 0–8 have confirmed shipped code** at their target file paths. Every major subsystem module exists: `user-profile.ts`, `dialectic-evaluator.ts`, `session-narrative.ts`, `graph-memory-bridge.ts` (with peer_id threading), `session-context.ts` (with `activePeerId`), `deriver/` (queue-manager, consumer, enqueue), `surprisal.ts`, `specialists.ts`, `surprisal-tree.ts`, `brain-reconciler.ts`, `brain-noise-detector.ts`, `brain-sweep-executor.ts`, `sigil.ts`, and the full `llm/` layer (14 files in `packages/core/src/llm/` including `executor.ts`, `tool-loop.ts`, `api.ts`, three backends). The LLM layer shipped as T1386 (not T1256).

4. **Wave 9 (T1149 Conduit A2A) is the only wave with zero shipped code at its primary target** (topic tables in conduit.db, `subscribeTopic`/`publishToTopic` SDK methods). The CONDUIT-A2A-DESIGN.md and CONDUIT-AUDIT.md are detailed specs; `local-transport.ts` has been partially extended (topic parsing function + `topicHandlers` state field exists; imports for `ConduitTopicPublishOptions`, `ConduitTopicSubscribeOptions`), but the conduit-sqlite.ts DDL does not yet have the `topics`, `topic_subscriptions`, `topic_messages`, `topic_message_acks` tables. Status: PARTIAL — design done, implementation incomplete.

5. **Top 3 risks**:
   - (a) **T1256 phantom-close** — original "LLM port" task was closed as a retroactive placeholder with no code; the actual 3851-LOC port shipped as T1386 days later. Pattern is acknowledged but task records remain in confusing state (T1256 archived, T1386 done).
   - (b) **T1402 task record stuck at `status:pending`** despite the rename shipping in commit `932fad3d4` / v2026.4.139.
   - (c) **The 68-candidate BRAIN sweep** has persisted run receipts but no approved live-DB cutover. `cleo memory sweep --rollback` dispatch gap also unfixed.

---

## Section 2 — Wave-by-Wave Status Matrix

### Wave 0 — Prerequisites (T1144, children T1209/T1210/T1211)
**Original scope**: PSYCHE source deep-audit; `packages/agents/` cleanup + PeerIdentity SSoT; PSYCHE↔CLEO glossary.
**Tasks filed**: T1144 (epic), T1209, T1210, T1211.
**What actually shipped**:
- `PSYCHE-SOURCE-NOTES.md` exists (3200+ words, 26 Python files audited).
- `GLOSSARY.md` exists (8 terminology entries).
- `packages/contracts/src/peer.ts` exists with `PeerIdentity` interface (header references T1210/v2026.4.110).
- `packages/agents/` canonical layout: `cleo-subagent.cant`, `seed-agents/`, `meta/`, `harness-adapters/`. Shipped v2026.4.110 per ADR-055.

**Status verdict**: COMPLETE
**Evidence**: Files at paths above; handoff "T1209/T1210/T1211 ✅ SHIPPED v2026.4.115"; `peer.ts` header references T1210.

---

### Wave 1 — NEXUS User Identity (T1076, children T1077–T1080)
**Original scope**: `user_profile` table; `user-profile.ts` CRUD; `transfer.ts` import/export; CLI commands.
**What actually shipped**:
- Migration: `/mnt/projects/cleocode/packages/core/migrations/drizzle-nexus/20260423052640_t1077-add-user-profile-table/migration.sql` — creates `user_profile` table with all 9 columns including `superseded_by`.
- `packages/core/src/nexus/user-profile.ts` — exists, header references "PSYCHE Wave 1 (T1078)".
- `packages/core/src/nexus/transfer.ts` — exists, header references T1079.
- `nexus-schema.ts` lists "user_profile" and "sigils" tables.

**Status verdict**: COMPLETE

---

### Wave 2 — CANT Peer Memory Isolation (T1081, children T1084–T1086)
**Original scope**: Add `peer_id`/`peer_scope` to four brain tables; peer-scoped retrieval filters; active CANT agent in CQRS context.
**What actually shipped**:
- Migration: `20260423000001_t1084-peer-id-memory-isolation/migration.sql` — adds `peer_id`/`peer_scope` to all four brain tables.
- `memory-schema.ts:250` — `peerId` and `peerScope` on `brainDecisions` (T1084 comment).
- `idx_brain_decisions_peer_scope` index confirmed.
- `session-context.ts:30` — `activePeerId` field with "T1086 Wave 2 memory isolation" reference.
- `graph-memory-bridge.ts` — peer-aware querying confirmed.

**Status verdict**: COMPLETE

---

### Wave 3 — Continuous Dialectic Evaluator (T1082, children T1087–T1089)
**Original scope**: `dialectic-evaluator.ts`; CQRS dispatcher hook (T1088); rolling session narrative (T1089).
**What actually shipped**:
- `packages/core/src/memory/dialectic-evaluator.ts` — exists.
- `packages/core/src/memory/session-narrative.ts` — exists.
- `dispatcher.ts` — has T1088 dialectic hook with `DIALECTIC_RATE_LIMIT_MS = 10_000` and rate limiter map.
- Migration `20260423000002_t1089-add-session-narrative-table/migration.sql` confirmed.

**Caveat**: PLAN.md spec said T1088 should call `enqueueDerivation` (durable queue) after T1145 shipped, but dispatcher uses `setImmediate` pattern from original T1088 design. **Wave 5 §5.3 integration not done.**

**Status verdict**: COMPLETE (with caveat: dispatcher uses fire-and-forget, not durable queue per §5.3)

---

### Wave 4 — Multi-Pass Context Engine (T1083, children T1090–T1092)
**Original scope**: `brain-retrieval.ts` multi-pass refactor with `RetrievalBundle`; `briefing.ts` integration; E2E test.
**What actually shipped**:
- `RetrievalBundle`, `RetrievalRequest`, `PassMask`, `SigilCard` in `packages/contracts/src/operations/memory.ts:1044+` — full 3-pass structure matches PLAN.md exactly.
- `briefing.ts` — imports `RetrievalBundle`, `bundle?` field on `SessionBriefing`.
- `psyche-wave4.test.ts` — exists (renamed from `honcho-wave4.test.ts` per T1255).

**Status verdict**: COMPLETE

---

### Wave 5 — Deriver Queue Pipeline (T1145)
**Original scope**: Durable `derivation-queue.ts`; `derivation-worker.ts`; replace T1088 `setImmediate` with `enqueueDerivation`.
**What actually shipped**:
- `packages/core/src/deriver/queue-manager.ts`, `consumer.ts`, `enqueue.ts` — all confirmed.
- PORT-AND-RENAME re-scoped to `packages/core/src/deriver/` directory (where files landed).

**Gap**: PLAN.md §5.3 stated T1088's `setImmediate` should be replaced with `enqueueDerivation`. Dispatcher still uses `setImmediate`. Dialectic evaluations are not durable; crashed process loses in-flight evaluation.

**Status verdict**: PARTIAL — queue infrastructure shipped; dispatcher integration (§5.3) not done.

---

### Wave 6 — Dreamer with Surprisal + Specialists + Trees (T1146)
**Original scope**: `surprisal.ts`; consolidation specialists; hierarchical trees (`brain_memory_trees` table).
**What actually shipped**:
- `surprisal.ts` — Bayesian Surprisal Scoring (T1146 header).
- `specialists.ts` — 6 concrete specialist classes.
- `surprisal-tree.ts` — RPTree implementation.

**Unverified**: `brain_memory_trees` schema table (PLAN.md §6.3 "large" item). No migration found in audit. May have been descoped or column-only approach used.

**Status verdict**: PARTIAL — surprisal/specialists/RPTree shipped; `brain_memory_trees` table unconfirmed.

---

### Wave 7 — Reconciler with Vector Sync (T1147)
**Original scope**: `brain-reconcile.ts` with vector sync + decision supersession; DLQ operations; periodic reconciliation scheduler.
**What actually shipped**:
- `brain-reconciler.ts` — T1147 Wave 7 header.
- `brain-noise-detector.ts` — T1147 Wave 7 header.
- `brain-sweep-executor.ts` — T1147 Wave 7 header.
- 2440-entry sweep infrastructure operational: 2 `brain_backfill_runs` rows of `kind='noise-sweep-2440'`, 68 candidates each.
- `brain_observations_staging` table (renamed from `brain_v2_candidate` per T1402).
- `triggerReconcilerSweep()` in `brain-reconciler.ts`.

**Not shipped**:
- `packages/core/src/sentient/reconcile-scheduler.ts` — **does not exist**. Periodic scheduler never implemented.
- DLQ CLI (`cleo memory dlq list|retry|purge`) — unconfirmed.
- 68 candidates staged but owner has not approved live-DB cutover.
- `cleo memory sweep --rollback <runId>` returns `E_INVALID_OPERATION` — gateway not wired.

**Status verdict**: PARTIAL — core sweep infrastructure shipped; scheduler absent; rollback dispatch gap; live sweep pending approval.

---

### Wave 8 — Sigil Identity Layer + CANT Integration (T1148)
**Original scope**: `sigils` table; `sigil.ts` CRUD; auto-populate from CANT; representation updates via dialectic; CLI surface.
**What actually shipped**:
- Migration: `20260424140538_t1148-add-sigils-table/migration.sql` — creates `sigils` table with `peer_id PK`, `cant_file`, `display_name`, `role`, `system_prompt_fragment`, `capability_flags`, timestamps.
- `sigil.ts` — Sigil CRUD operations.
- 8 canonical agent sigils populated in `~/.local/share/cleo/nexus.db` (cleo-subagent, project-orchestrator/dev-lead/code-worker/docs-worker/security-worker, agent-architect, playbook-architect).
- Auto-sync wired at `cleo init` per commit `b1d76ae75`.
- `SigilCard` type in contracts.
- `brain-retrieval.ts:fetchIdentity()` enriched with `sigilCard`.

**Deviation from PLAN.md §8.1**: shipped schema differs — has `role`, `system_prompt_fragment`, `capability_flags` instead of `mentalModel`, `toolsAllowed`, `skillsActive`, `representationJson`. Simpler but `representationJson`/`mentalModel` columns not implemented. Representation-via-dialectic (§8.3) and `cleo agents export/import` (§8.4) unconfirmed.

**Status verdict**: PARTIAL — schema + SDK + sigil population shipped; representation-update via dialectic and export/import CLI unconfirmed.

---

### Wave 9 — Conduit A2A (T1149)
**Original scope**: A2A envelope; topic subscription/publish API; topic DDL in conduit-sqlite.ts; spawn-prompt CONDUIT section; DLQ notification.
**What actually shipped**:
- Design documents: CONDUIT-AUDIT.md and CONDUIT-A2A-DESIGN.md complete.
- `local-transport.ts` has **partial topic infrastructure**: `parseTopicName()` function, `topicHandlers` map in `LocalTransportState`, type imports.
- `conduit-sqlite.ts` schema version `'2026.4.23'` — does NOT include `topics`, `topic_subscriptions`, `topic_messages`, `topic_message_acks` tables.

**Not shipped**: Four new conduit.db tables; `subscribeTopic()`, `publishToTopic()`, `pollTopic()` SDK methods; `cleo conduit subscribe/publish/listen` CLI; `## CONDUIT Subscription` spawn-prompt section.

**Status verdict**: PHANTOM-CLOSED — T1149 marked done but primary deliverable (topic pub-sub in conduit.db) has only type-level scaffolding. No DDL migration. No working API.

**Evidence**: `conduit-sqlite.ts` schema lacks topic tables; `local-transport.ts` imports topic types but no `subscribeTopic` method body found; PLAN.md Part 7b explicitly listed T1149 as "DEFERRED — still the remaining substrate gap" as of v2026.4.115.

---

### Meta-Agents E1–E6 (T1258–T1263)
- **T1258 E1** — canonical naming + 14 Living Brain verbs + BRAIN-doctor detector. SHIPPED v2026.4.126.
- **T1259 E2** — seed-install meta-agent + `cleo agent mint` + agents-starter. SHIPPED v2026.4.127.
- **T1260 E3** — spawn wiring + provenanceClass M6 gate + M1 parity. SHIPPED v2026.4.128. (`provenanceClass` confirmed in `memory-schema.ts:236`.)
- **T1261 E4** — governed pipelines + STRICT cutover. SHIPPED v2026.4.129.
- **T1262 E5** — CANCELLED, scope superseded by structural reconciliation.
- **T1263 E6** — session-journal substrate + memory-doctor CLI. SHIPPED v2026.4.130.

**Status verdict**: E1/E2/E3/E4/E6 COMPLETE; E5 (T1262) CANCELLED with documented rationale.

---

### T1107 — 14 Living Brain Verbs
**Status verdict**: SUPERSEDED by T1258 E1. ARCHIVED at 18:59:00.442Z.

---

### T1151 — Sentient v1 Four-Pillar
**Original scope**: 4 pillars — event-driven nervous system, hierarchical memory, sub-agent context isolation, aggressive extensibility. Children T1152–T1159 proposed.
**What actually shipped**:
- `packages/core/src/sentient/propose-tick.ts` — `checkBrainHealthReflex()` (W8-8 dispatch-time reflex).
- `triggerReconcilerSweep()` in `brain-reconciler.ts`.
- M7 gate in `sentient.ts:setTier2Enabled()`.
- Gates: `implemented:true testsPassed:true qaPassed:true`.

**Not shipped per PLAN.md Part 10**: T1152 (step-level retry wrapper), T1153 (reflection agent), T1154 (session tree), T1155 (soft-trim pruning), T1156 (context budget per sub-agent), T1158 (TUI adapter), T1159 (pluggable filesystem/sandbox) — **NONE filed as tasks**. T1157 (MCP adapter) shipped as standalone `@cleocode/mcp-adapter`, not as T1151 child.

**Status verdict**: PARTIAL — dispatch-time reflex + M7 gate shipped; T1152–T1156/T1158/T1159 subtasks never filed.

---

### T1386 — LLM Layer Port (real implementation)
**Status verdict**: COMPLETE — 15/15 child tasks done; 14 source files in `packages/core/src/llm/`; commit `954586850`.

---

### T1255 — Rename Execution (Honcho → PSYCHE)
**Status verdict**: COMPLETE — terminology scrub shipped v2026.4.141 (commit `5d040b598`).

---

### T1256 — LLM Port Placeholder
**Status verdict**: PHANTOM-CLOSED (acknowledged; continuation as T1386 shipped).

---

### T1402 — brain_v2_candidate rename
**Status verdict**: SHIPPED in code (`932fad3d4` / v2026.4.139) but task record stuck at `status:pending` (administrative gap).

---

## Section 3 — Items in PLAN.md with No Corresponding Task Filed

### 5.1 LLM Backend Unification
Resolved via T1386 (the actual LLM port). **No gap.**

### 5.2 Telemetry Surface
PSYCHE's `DialecticCompletedEvent`, `DreamRunEvent`, `RepresentationCompletedEvent` documented in PSYCHE-SOURCE-NOTES.md but no CLEO equivalent. **~1100 LOC of telemetry/event emission UNTOUCHED. No task filed.**

### 5.3 Vector Store Adapter
Decision: stay with SQLite FTS5 per PORT-AND-RENAME-SYNTHESIS.md §1.2. **Explicitly descoped.**

### 5.4 Webhook Ingestion
PORT-AND-RENAME-SYNTHESIS.md §1.2 explicitly skips `webhooks/` (5.4K LOC). **Explicitly descoped.**

### PLAN.md Part 10 — T1152–T1159 subtasks

| Task ID | Description | Status |
|---------|-------------|--------|
| T1152 | Step-level retry wrapper | **NOT FILED** |
| T1153 | Reflection agent | **NOT FILED** |
| T1154 | Session tree (id + parentId) | **NOT FILED** |
| T1155 | Soft-trim context pruning | **NOT FILED** |
| T1156 | Context budget per sub-agent | **NOT FILED** |
| T1157 | MCP adapter | **SHIPPED** as `@cleocode/mcp-adapter` (outside T1151 subtask structure) |
| T1158 | TUI adapter | **NOT FILED** |
| T1159 | Pluggable filesystem/sandbox backend | **NOT FILED** |

T1152–T1156, T1158, T1159 explicitly proposed in PLAN.md Part 10 — never filed. Represents unrealized "event-driven nervous system + extensibility" scope of the 4-pillar vision.

### Wave 9 / T1149 sub-tasks (A2A implementation tasks)
T1251 (Audit + Design) shipped its deliverables; implementation worker tasks (per CONDUIT-AUDIT.md Part 3 Lead B1 scope) **never filed**. Why T1149 has design docs but no code.

---

## Section 4 — Per-File Port Verification (Sample)

15 entries from PORT-AND-RENAME-SYNTHESIS.md §4:

| PSYCHE Source | CLEO Target | Exists? |
|---|---|---|
| `llm/executor.py` | `packages/core/src/llm/executor.ts` | YES — header confirms |
| `llm/tool_loop.py` | `packages/core/src/llm/tool-loop.ts` | YES |
| `llm/backends/anthropic.py` | `packages/core/src/llm/backends/anthropic.ts` | YES |
| `llm/backends/openai.py` | `packages/core/src/llm/backends/openai.ts` | YES |
| `llm/backends/gemini.py` | `packages/core/src/llm/backends/gemini.ts` | YES |
| `dialectic/core.py` | `packages/core/src/dialectic/agent.ts` | AMBIGUOUS — `dialectic-evaluator.ts` confirmed in `memory/`; `dialectic/` directory unverified |
| `deriver/queue_manager.py` | `packages/core/src/deriver/queue-manager.ts` | YES |
| `deriver/consumer.py` | `packages/core/src/deriver/consumer.ts` | YES |
| `deriver/enqueue.py` | `packages/core/src/deriver/enqueue.ts` | YES |
| `dreamer/surprisal.py` | `packages/core/src/memory/surprisal.ts` | YES |
| `dreamer/specialists.py` | `packages/core/src/memory/specialists.ts` | YES |
| `dreamer/trees/rptree.py` | `packages/core/src/memory/surprisal-tree.ts` | YES |
| `crud/peer_card.py` | `packages/core/src/memory/sigil.ts` | YES |
| `reconciler/scheduler.py` | `packages/core/src/sentient/reconcile-scheduler.ts` | **NO** — confirmed absent |
| `reconciler/sync_vectors.py` | `packages/core/src/memory/reconciler/` (directory) | **NO** — confirmed absent |

**Findings**:
- 11/15 sampled targets confirmed on disk.
- `reconcile-scheduler.ts` and `packages/core/src/memory/reconciler/` ABSENT — periodic scheduler and `sync_vectors` port never completed.
- PORT-AND-RENAME §2 schema deltas (`observation_embeddings`, `turn_embeddings`, `source_ids`/`times_derived`/`level`/`tree_id` columns on `brain_observations`) NOT confirmed in current `memory-schema.ts`. Quietly dropped.

---

## Section 5 — Owner-Override Audit

`force-bypass.jsonl` contains 150+ entries. Key patterns:

- **T1387–T1401** (T1386 children): all closed with `CLEO_OWNER_OVERRIDE` reason "T1386 overnight slot" — 15 tasks closed in one batch with single shared `tool:pnpm-test` evidence atom.
- **7 parent epics** (T1147, T1148, T1075, T1259, T1261, T1145, T1146): closed with `verification=null`. Pumped via T1404. None had atomic evidence at epic level — closed by rollup of children.
- **T1151** original `testsPassed` override with `note:owner-approved` — superseded by real verification gates by post-.141.

**Risk**: T1387–T1401 batch override means LLM port (3851 LOC) verified against single shared test atom. Acceptable if `pnpm-test` actually ran; not auditable post-hoc whether tests truly passed each child.

---

## Section 6 — Outstanding Backlog (Priority-Ranked)

### P0 — Blocks production / data integrity

1. **`cleo memory sweep --rollback <runId>` dispatch gap** — returns `E_INVALID_OPERATION` in v2026.4.141. Operator stuck using direct SQL.
2. **68-candidate BRAIN sweep pending owner approval** — 50 of 68 are decisions. Owner must decide: re-run+approve (irreversible purge) or abandon.
3. **T1402 task record not closed** — `cleo complete T1402 --evidence "commit:932fad3d4"` is a 30-second fix.

### P1 — Known incomplete PLAN.md scope

4. **Wave 9 T1149 Conduit A2A implementation** — sole remaining substrate gap. Without this, Lead coordination is orchestrator-as-hub only (no true mesh).
5. **Periodic reconcile scheduler absent** — `reconcile-scheduler.ts` does not exist. PLAN.md §7.3 was "medium" scope.
6. **T1152–T1156 T1151 subtasks never filed** — Pillar 1 + Pillar 2 capabilities of 4-pillar self-healing.
7. **PORT-AND-RENAME §2 schema deltas not confirmed** — `observation_embeddings`, `turn_embeddings`, column additions on `brain_observations`. Hidden behind Wave 2 "complete" status.

### P2 — Cleanup / dogfood / verification

8. **MCP adapter consumer dogfood** — published; no `.mcp.json` consumer end-to-end verification.
9. **Sentient v1 live dogfood** — gate operational, never tested in production with real proposals.
10. **T1088 dispatcher upgraded to durable queue** — Wave 5 §5.3 spec replacement never done.
11. **Wave 6 `brain_memory_trees` table** — PLAN.md §6.3 specified; not confirmed.
12. **Wave 8 representation updates via dialectic** — §8.3 spec; sigils table lacks `mental_model` column.

### P3 — Process / pump

13. **T1403 Release post-deploy-execute stage** — filed but not implemented.
14. **T1404 Parent-closure-without-atom enforcement** — filed but not implemented.

---

## Section 7 — Risks / Things That Got Lost

### 1. T1256 Phantom-Close (clearest example)
T1256 closed retroactively as placeholder; actual 3851-LOC port shipped 3+ days later as T1386. Acknowledged but anyone reading T1256 will see misleading evidence atoms.

### 2. T1149 Phantom-Closed with Design-Only Evidence (most consequential)
T1149 counted as `done` in 18/18 rollup but no implementation on disk. Design docs are excellent specs. **This is the most consequential phantom-close because T1149 is listed as a "SUBSTRATE" for enabling true mesh Lead coordination.**

### 3. PORT-AND-RENAME §2 Schema Deltas Silently Dropped
`observation_embeddings` table, `turn_embeddings` table, four `brain_observations` column additions (`source_ids`, `times_derived`, `level`, `tree_id`) — NONE confirmed in `memory-schema.ts`. Were supposed to land alongside `peer_id` migration. Quietly dropped — CLEO lacks embedding sync-state tracking and observation-level taxonomy that PSYCHE's reconciler depends on.

### 4. T1151 Subtask Architecture Never Filed
Only T1157 (MCP adapter) built — as standalone package, not T1151 child. The remaining 7 proposed subtasks never filed. 4-pillar vision remains aspirational without concrete tasks anchoring the work.

### 5. Terminology Drift in Planning Docs
PSYCHE-SOURCE-NOTES.md, CONDUIT-A2A-DESIGN.md, GLOSSARY.md still contain `Honcho` in historical-record sections. If future agents grep for `Honcho`, will be confused by planning docs themselves.

---

## Section 8 — Recommended Next Single Action

**Close T1402 administratively + implement `cleo memory sweep --rollback` dispatch gap fix.**

Reasoning: highest-leverage action to clear items that actively mislead the task DB about ship state.

1. `cleo complete T1402 --evidence "commit:932fad3d4;files:packages/core/migrations/drizzle-brain/20260424000006_t1402-rename-staging-table/migration.sql,packages/core/src/store/memory-schema.ts"` — 30 seconds.
2. Wire `memory.sweep.rollback` dispatch gateway in `packages/cleo/src/dispatch/domains/memory.ts` — single case handler addition, ~20 LOC.

T1149 (Wave 9 Conduit A2A) is architecturally more important but requires full implementation session. T1402 + rollback fix is doable in <10 minutes and immediately improves ship-state reliability.

---

## Absolute File Paths Referenced

- `/mnt/projects/cleocode/.cleo/agent-outputs/T1075-psyche-integration-plan/PLAN.md`
- `/mnt/projects/cleocode/.cleo/agent-outputs/T1075-psyche-integration-plan/PORT-AND-RENAME-SYNTHESIS.md`
- `/mnt/projects/cleocode/.cleo/agent-outputs/NEXT-SESSION-HANDOFF.md`
- `/mnt/projects/cleocode/packages/core/src/store/memory-schema.ts`
- `/mnt/projects/cleocode/packages/core/src/store/nexus-schema.ts`
- `/mnt/projects/cleocode/packages/core/migrations/drizzle-nexus/20260423052640_t1077-add-user-profile-table/migration.sql`
- `/mnt/projects/cleocode/packages/core/migrations/drizzle-brain/20260423000001_t1084-peer-id-memory-isolation/migration.sql`
- `/mnt/projects/cleocode/packages/core/migrations/drizzle-brain/20260423000002_t1089-add-session-narrative-table/migration.sql`
- `/mnt/projects/cleocode/packages/core/migrations/drizzle-nexus/20260424140538_t1148-add-sigils-table/migration.sql`
- `/mnt/projects/cleocode/packages/contracts/src/operations/memory.ts` (RetrievalBundle, SigilCard at offset 1044+)
- `/mnt/projects/cleocode/packages/core/src/conduit/local-transport.ts`
- `/mnt/projects/cleocode/packages/core/src/store/conduit-sqlite.ts`
- `/mnt/projects/cleocode/packages/cleo/src/dispatch/dispatcher.ts`
- `/mnt/projects/cleocode/packages/cleo/src/dispatch/context/session-context.ts`
- `/mnt/projects/cleocode/.cleo/audit/force-bypass.jsonl`
