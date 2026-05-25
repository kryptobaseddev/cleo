# CLEO Prime — Canonical Sentient Master Plan

> **Canonical**: this document supersedes `~/.claude/plans/dreamy-yawning-pinwheel.md` and `~/.claude/plans/i-know-there-was-sequential-elephant.md`, merging both into a single layered roadmap.
> **Status**: canonical (promoted from DRAFT 2026-05-23) · indexed by `cleo docs fetch cleo-canonical-north-star` (mirror: [`docs/plan/cleo-canonical-north-star.md`](../plan/cleo-canonical-north-star.md))
> **Originally drafted**: 2026-05-15
> **Floor**: `v2026.5.68` (T9261 Phase 4 W1-W4 — unified LLM provider architecture live)
> **Sibling canon**: [`docs/research/CleoCode-Architecture-Harness-Planning.md`](../research/CleoCode-Architecture-Harness-Planning.md) — UI/IPC/TUI layer (Tier 0 added 2026-05-23)
> **2026-05-23 addendum**: brain.db malformed in production; Tier 0 prerequisite **T10281 SG-BRAIN-DB-RESILIENCE** filed — Wave 0 (T10286 hotfix) shipped 2026-05-23
> **2026-05-24 addendum**: 11-saga Tier-0 mesh + 2 persona/memory sagas — see `cleo docs fetch cleo-canonical-north-star` (v3 owner-shipped 2026-05-24 18:01 via commit 3064d10d5); T10288 SG-DOCS-INTEGRITY shipped (v2026.5.115), enforces canonical doc routing
> **Author**: cleo-prime (orchestrator), synthesizing two parallel research-pass plans into one canon

---

## 0. North Star

CLEO is being built into **one persistent sentient Orchestrator** — codename **Prime** — that the human operator interacts with through a single conversational surface and that *feels* like the same entity across context windows, sessions, projects, and inference providers. The operator never has to remember which model is on the other end, never re-explains who they are, and never sees a "fresh start."

Every other agent in CLEO (Lead, Worker, Subagent, meta-agents like agent-architect) is a **peer in Prime's nervous system** — provisioned, supervised, and reconciled by Prime through the BRAIN ↔ NEXUS ↔ TASKS ↔ CONDUIT four-bus.

The substrate that makes this real:

- **`packages/core/`** is the harness. It is *the* SDK. CLI, Studio, MCP adapters, and any future surface are thin views over typed contracts emitted from `packages/contracts/`.
- **`.cleo/`** in a user's project = local nervous tissue: tasks.db, brain.db, conduit.db, llmtxt.db, manifest.db, telemetry.db.
- **`~/.local/share/cleo/`** / global NEXUS = central neural connection across all the operator's projects.
- **Every shipped iteration improves Prime itself.** Dogfooding this repo means the next user who installs CLEO gets a more sentient companion than the prior one.

**The invariant we will not break**: as we add intelligence, **BRAIN trust goes up, not down**. Every new write — peer cards, memory-block edits, theory-of-mind inferences, skill-distillation candidates, Conduit-ingested messages — funnels through one Mem0-style write-time extraction gate. No exceptions.

---

## 1. Why this, why now

Three converging realities:

1. **Trust is half-built.** BBTT epic T1892 is 14/17 done; three children (T1897/T1899/T1906) closed on `--override` evidence on worktree branches. The root cause is T9245 — a P0 loophole at **`packages/core/src/tasks/evidence.ts:427`** (corrected from `lifecycle/evidence.ts` — see §16.A) where `validateCommit` checks SHA reachability + branch scope (T9178) but never intersects the commit diff with AC file paths. Thirteen tasks across the campaign closed on bogus evidence. Until T9245 lands, *no* future "shipped" claim can be believed.

2. **The systems work but don't flow into each other.** BRAIN ingests, NEXUS maps, TASKS plans, CONDUIT messages — but agents don't read BRAIN at spawn, `cleo nexus impact <sym>` doesn't surface BRAIN evidence, CONDUIT carries status not handoffs, personas freeze at compose-time, and auto-extract is broken (11 learnings from 2,819 observations = 0.4% promotion ratio). Plumbing is there; the wires aren't tied.

3. **The floor is finally solid.** `v2026.5.67` shipped T9320 BRAIN unhardcode (executeForRole helper) and T9321 Kimi Code provider. `v2026.5.68` shipped T9261 Phase 4 W1-W4 — the unified LLM provider architecture (transport/session/executor + 5 W4 wire-ins, `backends/` deleted, 485 LLM tests green). Dreams are confirmed running end-to-end with Kimi: 5 summaries, 2 patterns, 3 insights per cycle, 450 graph links per dream, 15,962 nodes / 33,213 edges total. The plumbing works. Now we wire it.

**Intended outcome of this plan** (single sentence):

> Turn CLEO from a four-DB memory system *for* agents into a peer-graph nervous system *of* agents — where Prime is the one persistent persona the human meets, every CANT agent is a first-class peer with editable memory blocks and a growing mental model resolved from BRAIN, every belief is bitemporal, every write passes one extraction gate, every peer keeps a git-tracked memory diff history, and BRAIN trust net-rises as we add intelligence.

---

## 2. Source-of-Truth Inventory (verified read-only, 2026-05-15)

### 2.1 Living-brain canonical files

| Concern | File |
|---|---|
| BRAIN schema (Drizzle) | `packages/core/src/store/memory-schema.ts` |
| BRAIN runtime DDL + pragmas | `packages/core/src/store/memory-sqlite.ts` |
| BRAIN ERD | `docs/architecture/erd-brain-db.md` |
| Retrieval (BM25/RRF) | `packages/core/src/memory/brain-retrieval.ts` · `brain-search.ts` |
| Lifecycle + consolidation | `brain-lifecycle.ts` · `brain-consolidator.ts` · `sleep-consolidation.ts` · `dream-cycle.ts` |
| Auto-extract | `packages/core/src/memory/auto-extract.ts` |
| Session memory (BM25-as-recency bug) | `packages/core/src/memory/session-memory.ts:404-422` |
| Briefing | `packages/core/src/sessions/briefing.ts` |
| Multi-pass retrieval bundle | `brain-retrieval.ts` → `buildRetrievalBundle()` |
| Sentient daemon | `packages/core/src/sentient/{tick,daemon,daemon-entry,daemon-api}.ts` |
| Sentient propose (stub) | `packages/core/src/sentient/propose.ts` + `propose-tick.ts` |
| Worktree dispatch | `packages/core/src/sentient/worktree-dispatch.ts` · `packages/worktree-backend/` |
| Evidence validator (T9245 site) | `packages/core/src/tasks/evidence.ts:427` (corrected — §16.A) |
| Doctor brain | `packages/cleo/src/cli/commands/doctor.ts` |
| Extraction gate (chokepoint) | `packages/core/src/memory/extraction-gate.ts:606` (`verifyAndStore`) |
| LLM extraction | `packages/core/src/memory/llm-extraction.ts:360` |
| Graph-memory bridge | `packages/core/src/memory/graph-memory-bridge.ts:1026` |
| Temporal supersession | `packages/core/src/memory/temporal-supersession.ts` |

### 2.2 CANT + persona surface

| Concern | File |
|---|---|
| CANT spec | `docs/concepts/CLEO-CANT.md` |
| CANT parser SSoT (Rust) | `cleocode/crates/cant-core/` |
| CANT TS binding | `packages/cant/src/{parse,types,native-loader,variable-resolver,composer,mental-model}.ts` |
| Hook event SSoT | `packages/caamp/providers/hook-mappings.json` (31 canonical events) |
| Peer identity contract | `packages/contracts/src/peer.ts` |
| Sigil card contract | `packages/contracts/src/operations/memory.ts` (`SigilCard`) |
| Sigil store | `packages/core/src/nexus/sigil.ts` |
| Seed agents | `packages/agents/cleo-subagent.cant` + `packages/agents/templates/*.cant` + `packages/agents/meta/*.cant` |
| Project agents | `.cleo/cant/agents/*.cant` |
| Spawn payload | `packages/core/src/orchestrate/{spawn-ops,spawn-prompt,classify}.ts` |
| Agent resolver cascade | `packages/core/src/store/agent-resolver.ts` (5-tier: project → global → packaged → fallback → universal) |
| Playbook runtime | `packages/playbooks/*.cantbook` |

### 2.3 PSYCHE / Honcho integration artifacts

| File | Purpose |
|---|---|
| `.cleo/agent-outputs/T1075-psyche-integration-plan/PLAN.md` | Master PSYCHE plan W0-W9 |
| `.cleo/agent-outputs/T1075-psyche-integration-plan/PSYCHE-SOURCE-NOTES.md` | Honcho source audit |
| `.cleo/agent-outputs/T1075-psyche-integration-plan/GLOSSARY.md` | Honcho↔CLEO term bridge |
| `.cleo/agent-outputs/T1075-psyche-integration-plan/CONDUIT-A2A-DESIGN.md` | Wave 9 mesh-coordination |

### 2.4 BBTT artifacts

| File | Purpose |
|---|---|
| `.cleo/rcasd/cleo-briefing-trust/RCASD-WAVE-PLAN.md` | W0-W6 wave plan + cross-cutting X observability |
| `.cleo/rcasd/cleo-briefing-trust/WHY-DREAM-DIDNT-RUN.md` | Daemon dead-since-Apr-21 root cause + Tier 1/2/3 remediation |
| `.cleo/rcasd/campaign-validation-2026-05-12/SYNTHESIS.md` | Audit that reopened T1897/T1899/T1906 |

### 2.5 Prior memory research (T549 lineage, 2026-04-13)

| File | Purpose |
|---|---|
| `.cleo/agent-outputs/T549-R1-memory-system-deep-audit.md` | Current implementation audit |
| `.cleo/agent-outputs/T549-R2-industry-memory-research.md` | 14-system competitive analysis (Letta, Mem0, Zep, Graphiti, Hindsight 91.4% SOTA, Mastra 95% SOTA, LangMem, A-Mem, ChatGPT) |
| `.cleo/agent-outputs/T549-CA1-retrieval-spec.md` | Multi-strategy retrieval design |
| `.cleo/agent-outputs/T549-CA2-extraction-pipeline-spec.md` | 7-step extraction pipeline |

### 2.6 Canonical ADRs

| ADR | Purpose |
|---|---|
| ADR-006 | Canonical SQLite storage |
| ADR-009 | BRAIN cognitive architecture (5-dim, Vectorless RAG primary) |
| ADR-021 | Memory domain = brain.db ONLY (immutable cutover) |
| ADR-048 | 7-step gated extraction pipeline |
| ADR-051 | Evidence-based gate ritual |
| ADR-055 | Worktree-by-default spawn + PSYCHE rename |
| ADR-062 | merge --no-ff (not cherry-pick) for worktree integration |
| ADR-065 | PR-gated release pipeline |
| ADR-070 | Hierarchical orchestration (HITL Orchestrator → Phase Lead → Worker) |

---

## 3. What CLEO already has vs. what's missing

### 3.1 Already shipped (verified)

- BRAIN with FTS5 + vector embeddings, BM25/RRF retrieval, confidence decay (half-life 90d, evict <0.6)
- PSYCHE Wave 0 (PeerIdentity contract, packages/agents canonical layout, worktree backend SDK)
- PSYCHE Wave 1-2 partial (user_profile table on nexus.db, peer_id column on brain tables — T1085)
- SigilCard struct + sigil store
- `buildRetrievalBundle()` with cold/warm/hot tiers (`RetrievalBundle` in contracts)
- CANT DSL grammar + napi-rs binding; 13 directives; 5-layer stack
- Sentient daemon Tier 1 (resumed 2026-05-12, picks unblocked tasks every 5 min, spawns workers, writes receipts via `memory.observe`)
- Tier 2 propose-tick scaffold (`propose-tick.ts` runs every 2h, conditionally enabled via `tier2Enabled` in `.cleo/sentient-state.json`)
- Auto-extract pipeline (degraded — 0.4% promotion ratio)
- Pattern extraction (over-firing — 4.4× ratio for 2,819 observations)
- Dream cycle scheduled every 4 hours (when daemon alive); confirmed firing on Kimi
- 5-tier agent resolver cascade
- Worktree-by-default spawn + merge-not-cherry-pick integration
- 9-DB topology with single openCleoDb chokepoint (D003)
- v2026.5.67 T9320 BRAIN unhardcode (executeForRole helper)
- v2026.5.67 T9321 Kimi Code provider (sk-kimi-/OAuth/X-Msh headers)
- v2026.5.67 T9322 daemon heartbeat + cron try/catch
- v2026.5.68 T9261 Phase 4 W1-W4 unified LLM provider architecture (transport/session/executor; 485 tests pass)

### 3.2 Gaps blocking sentience (the design targets)

1. **T9245 P0 evidence loophole** — `validateCommit` accepts override-only evidence; 13 tasks closed on bogus evidence
2. **No agent diary / self-reflection** — agents can't record learnings about themselves
3. **No SigilCard history** — sigil is static; no diff-able snapshot table
4. **No skill mastery tracking** — agent can't track "47 reviews, 85% acceptance"
5. **No identity drift detection** — `agent-doctor` audits registry, not behavioral coherence
6. **No inter-agent rapport graph** — PeerIdentity is one agent in isolation
7. **No structured A2A handoff** — Conduit A2A (Wave 9) deferred
8. **Auto-extract barely working** — 0.4% promotion ratio (BBTT W3-5)
9. **Pattern dedup missing** — 4.4× pattern bloat (BBTT W1-2)
10. **Dialectic evaluator unbuilt** — PSYCHE Wave 3
11. **Deriver queue unbuilt** — PSYCHE Wave 5 (durable derivation queue + retry + DLQ)
12. **Dreamer specialists unbuilt** — PSYCHE Wave 6 (surprisal scoring, topic-specialists, hierarchical memory trees)
13. **Reconciler unbuilt** — PSYCHE Wave 7 (vector sync, dead-letter cleanup, decision supersession from T1139)
14. **Tier-2 detector unwired** — propose-tick fires but pattern detector inside `propose.ts` is empty (T1644)
15. **cleo-daemon.service systemd unit not installed** on operator host
16. **Spawn payload doesn't carry BRAIN context** — no `SpawnBrainContext` field today
17. **NEXUS impact result lacks BRAIN evidence** — `cleo nexus impact <sym>` doesn't show prior decisions about that symbol
18. **TASKS decomposition is module-blind** — no pre-decomposition NEXUS advisor
19. **CONDUIT carries no BRAIN-digest events** — wave rollups don't publish insights
20. **CONDUIT messages don't feed BRAIN** — no significant-message ingester
21. **No agent-edited memory blocks** — Letta's killer feature (agent decides what to remember) missing
22. **No memory-git per peer** — agents can't audit their own evolution
23. **No continuous (idle) sleep-time compute** — dreams only at scheduled cron, not during idle
24. **No skill distillation** — successful patterns don't auto-compile into reusable skills
25. **No bitemporal validity** — `valid_to`/`superseded_at` clocks missing; can't answer "what did BRAIN believe on X?"
26. **No 4-network cognitive typing** — `world-fact` and `belief` rows can't be distinguished from `episodic`/`semantic`/`procedural`
27. **Multiple write paths to BRAIN** — not every insert goes through `verifyAndStore` (Mem0 chokepoint not enforced)

---

## 4. Architecture overview — the layered substrate

```
┌─────────────────────────────────────────────────────────────────┐
│                          OPERATOR (human)                        │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                  CLEO PRIME (the one persona)                    │
│      sentient daemon · session continuity · briefing             │
└─────────────────────────────────────────────────────────────────┘
                                │
        ┌───────────┬───────────┼───────────┬───────────┐
        ▼           ▼           ▼           ▼           ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
   │  BRAIN  │ │  NEXUS  │ │  TASKS  │ │ CONDUIT │ │  CANT   │
   │ memory  │ │  code   │ │  plan   │ │  msgs   │ │ persona │
   └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘
        │           │           │           │           │
        └───────────┴───────────┴───────────┴───────────┘
                            │
                            ▼
              ┌────────────────────────────┐
              │ packages/core (THE harness)│
              │  ↑                         │
              │  packages/contracts (types)│
              └────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
   packages/cleo      packages/cleo-os     packages/studio
   (CLI surface)      (Pi/Claude harness)  (SvelteKit UI)
```

**Six living systems** (LAFS is the envelope, not a system; LIFECYCLE is a cross-cutting concern, not a system):

| System | Owns | DB |
|---|---|---|
| BRAIN | observations, learnings, patterns, decisions, sigils, memory blocks, peer cards | `.cleo/brain.db` |
| NEXUS | code graph, impact analysis, cross-project comparison | `.cleo/nexus-graph/<projectId>.db` + `~/.local/share/cleo/nexus-registry.db` |
| TASKS | epics, tasks, gates, evidence, lifecycle stages | `.cleo/tasks.db` |
| CONDUIT | messages, events, A2A topics, pipeline_manifest | `.cleo/conduit.db` |
| CANT | persona DSL, agent definitions, playbooks, mental-model resolution | `.cleo/cant/` (filesystem) + `signaldock.db` for identity |
| SENTIENT | daemon ticks, Tier-1 task picker, Tier-2 propose, dream cycle, idle compute | `.cleo/sentient-state.json` + cross-cuts BRAIN/TASKS |

---

## 5. The Tiered Roadmap

Ten tiers, each gated by the prior. Tier numbering is logical not temporal — within a wave, tiers can ship in parallel where dependencies allow.

### TIER 1 — Trust Foundation

**Goal**: every "shipped" claim is backed by programmatic evidence the verifier cannot be lied to. Without this, every tier below is suspect.

#### 1.1 T9245 — Evidence-validator hardening

At `packages/core/src/tasks/evidence.ts:427` (`validateCommit`):

- Parse task AC to extract file paths.
- Run `git show --name-only` on the evidence commit.
- Intersect commit diff with AC file paths.
- **Reject `implemented` gate** when intersection is empty.
- **Reject `--override`** on the critical gates (`implemented`, `testsPassed`).
- Add an integration test: task AC = file A; evidence commit touches only file B → assert verify fails with `E_EVIDENCE_INSUFFICIENT`.
- Re-verify all 13 mis-completed tasks (T9220, T9222, T9223, T9224, T9227, T1897, T1899, T1906, T9172, T1467, T1693, T9194, T9173) with real evidence atoms.

#### 1.2 BBTT W0/W1/W2/W3 close-out (with real evidence after T9245)

- W0-1 `relatedDocs` gated on `currentTaskId` — SHIPPED, validate
- W0-2 test-fixture-shaped epic filter — SHIPPED, replaced by W3-1
- W1-1 recency mode on `searchBrainCompact` — needs re-verify with real evidence
- W1-2 pattern dedup at consolidation time — needs implementation + re-verify
- W1-3 field-name contract types + runtime assertion — needs implementation
- W2-1 `cleo memory dream --status` returns `{ lastConsolidatedAt, observationsSinceLastConsolidation, idleMinutesSinceLastRetrieval, tickLoopAlive, isOverdue }`; non-zero exit when overdue (≥24h)
- W2-3 opportunistic dream trigger from `cleo briefing` (5-min cooldown)
- W2-4 `cleo doctor brain` aggregated health dashboard
- W2-5 freshness sentinel as CI gate (daily check, alert if overdue >24h)
- W3-1 `origin` column on tasks (`production | test-fixture | imported | migrated`)
- W3-2 `origin + validated_at + provenance_chain` on `brain_observations`
- W3-3 `cleo doctor scan-test-fixtures-in-prod` CLI
- W3-4 test-DB isolation — `assertTestEnv()` throws if `CLEO_TEST_MODE=1` and project root is the live repo; CI gate fails any test writing to `.cleo/tasks.db`
- W3-5 auto-extract repair — surface invocation/candidate/promoted/rejected metrics in `cleo doctor brain`; lower thresholds; assert 5+ matching observations produces a learning

#### 1.3 Daemon liveness

- Install `cleo-daemon.service` on operator host (`cleo daemon install`).
- Fix `--foreground` cwd bug at `packages/cleo/src/cli/commands/daemon.ts:195` — replace `process.cwd()` with `CLEO_PROJECT_ROOT` env or first-ancestor `.cleo/` resolution.
- Reverify T1682 + T1636 with `systemctl --user is-active cleo-daemon = active` evidence.
- Apply BBTT W2-1/W2-3/W2-4/W2-5 to expose freshness everywhere the operator looks.

**Acceptance Tier 1**:
- T9245 integration test passes (AC-file-A + commit-touches-B → fails).
- All 13 mis-completed tasks re-verified with real evidence atoms (no `--override`).
- `systemctl --user is-active cleo-daemon = active`.
- `cleo memory dream --status` returns `isOverdue: false` continuously for 7 days.
- `cleo doctor brain --strict` exits 0.

---

### TIER 2 — Provenance, Quarantine & Auto-Extract Repair

**Goal**: every BRAIN row carries verifiable lineage; test fixtures never reach the production briefing; auto-extract promotes at a healthy rate.

#### 2.1 Origin columns + writer funnel

- Add `origin TEXT NOT NULL DEFAULT 'manual'` to `tasks` (`conduit-schema.ts`); enum: `production | test-fixture | imported | migrated`.
- Add `origin TEXT NOT NULL`, `validated_at INTEGER`, `provenance_chain TEXT` (JSON array of `{sourceType, sourceId, recordedAt}`) to `brain_observations` and sibling tables (`brain_learnings`, `brain_patterns`, `brain_decisions`).
- Lock the 5 `origin` values: `manual | auto-extract | transcript-ingest | session-debrief | test`.
- New: `packages/core/src/memory/provenance-gate.ts` — `assertOriginIsSet(row, callerName)`; wired into `extraction-gate.ts:606`.
- New: `packages/core/scripts/verify-provenance-writers.mjs` — AST grep for `INSERT INTO brain_*`; CI fails if writer is not on the allowlist.

#### 2.2 Test-fixture quarantine (T1909)

Three-layer block on T932EP / E1 / test-prefixed rows reaching production briefing:

- Detector: `packages/core/src/memory/brain-noise-detector.ts` — heuristics on id regex, text regex, agent regex; tags `origin='test'`.
- Tasks gate: `packages/core/src/tasks/add.ts` refuses to write `origin='test-fixture'` to production without env override.
- Briefing query: every brain query injects `AND COALESCE(origin,'manual') != 'test'`.

#### 2.3 Auto-extract end-to-end repair (T729 + T730 + T736 + T737)

The pipeline is broken in 4 places. Fix each; funnel through `verifyAndStore`.

- T729 — Two-pass transcript reader at `packages/core/src/memory/transcript-extractor.ts:151`. First pass collects `sessionId ↔ parentUuid` pairs; second pass tags orphans.
- T730 — Tighten `llm-extraction.ts:360` JSON contract; route through `verifyAndStoreBatch`.
- T736 — Funnel every direct-write in `auto-extract.ts` through `verifyAndStore`.
- T737 — Extend `hashDedupCheck` (`extraction-gate.ts:286`) to loop all 4 typed tables.
- Diagnostic: when `fulfillment_note='no-narrative'`, emit a `brain-doctor` event so the metric is visible.

#### 2.4 T1903 — Promotion-log fulfillment columns (idempotency fix)

`fulfilled_at` + `fulfillment_note` exist at runtime in `memory-sqlite.ts:386-388` but are missing from the Drizzle table def. Move them into `memory-schema.ts`; drop the silent `try/catch` in `brain-doctor.ts:420-430`; create a parity migration for fresh installs.

#### 2.5 T1900 — Kill BM25-on-"session" — **ALREADY SHIPPED** (verify only)

Internal validation confirms the fix is already applied at `session-memory.ts:416` — `query: scopeQuery or 'session'` is now passed in recency mode (not BM25), and the T1900 comment in source confirms past-state. **Action**: regression test only. Seed one fresh obs + one 11-day-old; assert fresh wins. No code change needed.

**Acceptance Tier 2**:
- `SELECT COUNT(*) FROM brain_observations WHERE origin IS NULL` == 0 in production within 7 days of ship.
- `pattern_count / observation_count` ≤ 2.0.
- `learning_count / observation_count` ≥ 0.05.
- Last dream cycle < 24h.
- `cleo memory find --source-type test` returns rows; briefing context never includes them.
- `cleo doctor scan-test-fixtures-in-prod` returns clean.

---

### TIER 3 — Peer-Graph Identity (the inseparable epic)

**Goal**: every CANT persona is a first-class peer with editable memory blocks, a growing mental model resolved from BRAIN at spawn, identity-drift detection, and a peer-to-peer rapport graph. Memory blocks + growing personas + drift detection ship as **one coherent epic** because they share the peer-identity substrate.

#### 3.1 Peer-graph schema (5 new tables on brain.db)

| Table | Purpose |
|---|---|
| `brain_peers` | Promotes `PeerIdentity` (already in `packages/contracts/src/peer.ts`) to first-class row. Humans + agents. `kind` ∈ {human, agent, orchestrator, lead, worker, subagent, external}. `seed_prompt_hash` for drift detection. |
| `brain_peer_cards` | Static rendered representation per (peer, project, dimension). Regenerated by sleep cycle via `executeForRole('derivation')`. Embedding for retrieval. Bitemporal (`valid_from`/`valid_to`). |
| `brain_peer_models` | Theory-of-Mind: observer's belief about subject. Unique on (observer, subject, dimension). ToM-derived via `executeForRole('judgement')`. |
| `brain_sessions` | Multi-peer interaction thread. Replaces stringly-typed `session_id` references. |
| `brain_session_peers` | Junction: which peers participated, role, time bounds. |

Existing `peerId` column (default 'global') stays — every new write writes a real canonical peer ID. Canonical form: `human:<email>` · `agent:<peerKind>:<name>` · `external:<provider>:<id>`. Helper `canonicalPeerId()` in `packages/contracts/src/peer.ts`.

#### 3.2 Memory blocks (Letta-grade self-editing)

New table `brain_memory_blocks`:

```sql
CREATE TABLE brain_memory_blocks (
  id TEXT PRIMARY KEY,
  peer_id TEXT NOT NULL,
  project TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  content TEXT NOT NULL,
  max_size_tokens INTEGER NOT NULL DEFAULT 2000,
  locked INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  current_history_entry_id TEXT,
  is_template INTEGER NOT NULL DEFAULT 0,
  template_name TEXT,
  preserve_on_migration INTEGER NOT NULL DEFAULT 1,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(peer_id, project, label)
);

CREATE TABLE brain_memory_block_history (
  id TEXT PRIMARY KEY,
  block_id TEXT NOT NULL,
  prev_value TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  reason TEXT
);
```

Default char_limit = 2000 (Letta's `CORE_MEMORY_BLOCK_CHAR_LIMIT`). Optimistic locking via `version`. Block kinds:

- `persona` — locked, seeded from CANT agent.prompt
- `human` — theory-of-mind of operator (per agent's view)
- `project` — codebase model
- `current-goal` — agent-editable
- `open-questions` — agent-editable
- `recent-decisions` — appended by sleep cycle
- `scratchpad` — free-form, capped at max_size_tokens
- `shared:<topic>` — cross-agent shared

**Five memory tools** exposed to agents through CANT permissions:

| Tool | Effect |
|---|---|
| `memory.read_blocks()` | Returns labelled block contents — cheap, no LLM |
| `memory.edit_block(label, new_content)` | Replaces. Bumps version. Logs `type='memory-edit'` observation. CAS: throws `E_BLOCK_CAS_MISMATCH` if `old !== current.value` (Letta's pattern). |
| `memory.append_block(label, delta)` | Appends + auto-truncates oldest lines to max_size_tokens. Always safe under concurrency. |
| `memory.search_archival(query, limit?, peer_scope?)` | Vector + BM25 over BRAIN |
| `memory.recall_messages(filter)` | Filters brain_observations |

CLI mirror:
- `cleo memory block read --peer <id> --label <l>`
- `cleo memory block append --peer <id> --label <l> --content <t>`
- `cleo memory block replace --peer <id> --label <l> --old <s> --new <s>`
- `cleo memory block summarize --peer <id> --label <l> --max <n>` (LLM-driven compaction)

**Tier mapping** (Letta's 3-tier memory model mapped to CLEO):

- **Core** (in-prompt) = active peer's memory blocks ≤ 2K tokens
- **Recall** (searchable) = recent observations
- **Archival** (vector-queried) = full BRAIN

**The agent-decides rule** (Letta's killer feature): the spawn prompt instructs the agent to edit its own blocks when new information updates understanding. No gate at the per-edit level — audit via `memory-edit` observations + memory-git (Tier 8).

#### 3.3 Growing personas via CANT (`CantMentalModelRef.growth`)

Extend `CantMentalModelRef` (`packages/cant/src/types.ts:104`):

```ts
mentalModelRef: {
  scope: 'project' | 'global',
  name?: string,
  maxTokens: number,
  validateOnLoad: boolean,
  growth?: {
    enabled: boolean,
    sourceQueries: CantBrainQuery[],
    consolidationInterval: 'session' | 'daily' | 'weekly',
    driftAlertThreshold: number,
    seedPromptHash?: string,
  }
}

type CantBrainQuery = {
  table: 'observations' | 'learnings' | 'patterns' | 'decisions',
  filter: {
    peerId?: '@self' | string,
    memoryType?: BrainCognitiveType[],
    minConfidence?: number,
    sinceDays?: number,
    tags?: string[],
    roleMatch?: string,
  },
  limit: number,
  rankBy: 'recency' | 'retrievalCount' | 'confidence' | 'embedding',
  embeddingTarget?: string,
}
```

Spawn-time resolution: composer runs all `sourceQueries`, renders results as `# Mental Model — Living Knowledge` block, hashes the rendered content as `mentalModelDigest`. Backwards-compat: agents without `growth.enabled` keep working unchanged.

#### 3.4 Identity drift detection

`packages/core/src/agents/persona-evolution.ts`:

1. Re-render mental model block post-session.
2. Embed and compare against `growth.seedPromptHash` stored embedding.
3. `drift = 1 − cosineSimilarity(current, seed)`.
4. If `drift > driftAlertThreshold` → emit `IdentityDriftAlert` event (`sentient/events.ts`).
5. `cleo agent diff <id>` shows seed vs current rendered persona.

#### 3.5 Sigil history + diary + skill mastery + rapport

Four sibling tables to round out the per-agent identity record:

```sql
CREATE TABLE brain_sigil_history (
  id TEXT PRIMARY KEY,
  peer_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  delta_json TEXT,  -- changed fields only
  trigger TEXT NOT NULL,  -- 'dialectic' | 'manual' | 'review'
  created_at INTEGER NOT NULL
);

CREATE TABLE brain_agent_diary (
  id TEXT PRIMARY KEY,
  peer_id TEXT NOT NULL,
  session_id TEXT,
  content TEXT NOT NULL,
  diary_type TEXT NOT NULL,  -- 'insight' | 'struggle' | 'preference' | 'hypothesis'
  confidence REAL NOT NULL,
  validated_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE brain_agent_skills (
  id TEXT PRIMARY KEY,
  peer_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  invocations INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  mastery_score REAL NOT NULL DEFAULT 0,
  evidence_observation_ids TEXT,  -- JSON array
  UNIQUE(peer_id, skill_id)
);

CREATE TABLE brain_agent_rapport (
  id TEXT PRIMARY KEY,
  actor_peer_id TEXT NOT NULL,
  observed_peer_id TEXT NOT NULL,
  interaction_type TEXT NOT NULL,  -- 'handoff' | 'review' | 'spawn-child' | 'consensus'
  outcome TEXT NOT NULL,  -- 'accepted' | 'rejected' | 'partial'
  created_at INTEGER NOT NULL
);
```

- Sigil history: triggered by dialectic evaluator (Tier 6) when `peerRepresentationDelta` is non-empty; surfaced in `cleo agents show <peerId> --history`.
- Agent diary: per-agent self-reflective observations distinct from `brain_observations.agent` (which names the observer, not self-referential); written by reflection prompt at session end or `cleo agents reflect <peerId>`.
- Skill mastery: updated on skill invocation + task-completion outcome; influences agent selection in `classify.ts` (high-mastery agents preferred for matching tasks).
- Rapport graph: drives "this orchestrator usually trusts cleo-prime's architecture decisions" insights; surfaced in `cleo agents rapport <peerId>`.

#### 3.6 Files for Tier 3

**Create**:
- `packages/core/migrations/drizzle-brain/<ts>_peers_tables/migration.sql`
- `packages/core/migrations/drizzle-brain/<ts>_memory_blocks/migration.sql`
- `packages/core/migrations/drizzle-brain/<ts>_identity_tables/migration.sql`
- `packages/core/src/memory/{peers,peer-cards,peer-tom,memory-blocks,identity-drift,agent-diary,agent-skills,agent-rapport,sigil-history}.ts`
- `packages/core/src/agents/persona-evolution.ts`
- `packages/cleo/src/cli/commands/peer.ts` (`peer list|card|beliefs|activity`)
- Extend `packages/cleo/src/cli/commands/memory.ts` (`memory blocks|edit|log`)
- Extend `packages/cleo/src/cli/commands/agent.ts` (`agent diff|reflect|mastery|rapport|doctor`)

**Edit**:
- `packages/core/src/store/memory-schema.ts` (add 9 tables)
- `packages/cant/src/types.ts` (`CantMentalModelRef`, `CantBrainQuery`, `growth`)
- `packages/cant/src/parse.ts` (parse `growth:` subblock)
- `packages/cant/src/composer.ts` (resolve growth at compose)
- `packages/cant/src/mental-model.ts` (`resolveGrowthQueries(growth, peerId, project)`)
- `packages/contracts/src/peer.ts` (`canonicalPeerId()`, row-type re-exports)
- `packages/core/src/llm/role-executor.ts` (`buildMemoryToolset(peerId, project)`)
- `packages/core/src/llm/tool-loop.ts` (dispatch `memory.*` tool calls)
- `packages/core/src/sessions/briefing.ts` (inject agent's own peer card as `## Who you are`)
- `packages/core/src/sentient/events.ts` (`IdentityDriftAlert` variant)

**Acceptance Tier 3**:
- Spawned agent prompt contains `# Core Memory` + `# Mental Model — Living Knowledge` blocks.
- `cleo peer card cleo-prime` returns non-empty markdown.
- After 5 sessions with growth-enabled agent, `cleo agent diff cleo-prime` shows non-trivial diff.
- Agent calls `memory.edit_block('current-goal', '...')` → next briefing shows updated content.
- `cleo agents show cleo-prime --history` shows sigil evolution timeline.
- New agent invokes a skill → `brain_agent_skills` row updates.
- Session ends → `brain_agent_diary` row written.

---

### TIER 4 — Mem0 Write-Time Extraction Gate (the chokepoint)

**Goal**: every BRAIN write — peer cards, memory-block edits, ToM inferences, skill-distill candidates, conduit-ingested messages, auto-extract output — passes through one `verifyAndStore` funnel. Without this, every other tier eventually corrupts trust.

#### 4.1 The single funnel

ALL writers → `verifyAndStore` (`extraction-gate.ts:606`) → `verifyCandidate` (via `executeForRole('extraction')`) → decision ∈ `{append-new, update-existing, reject}`.

On `update-existing`: invalidate prior row (`valid_to=now`, `superseded_by=<new>`); insert new row.

Verdict JSON contract (tighten via `structured-output.ts`) — modeled directly on **Mem0's V3 ADDITIVE_EXTRACTION_PROMPT envelope** (see §16.D):

```ts
{
  // Mem0 V3 contract — append-only, link-based supersession
  event: 'ADD' | 'UPDATE' | 'NONE',     // DELETE intentionally removed — Mem0 V3 conceded DELETE causes regressions
  classification: 'world' | 'bank' | 'opinion' | 'observation',  // Hindsight 4-network (§16.E)
  entities: Array<{ kind: 'symbol' | 'peer' | 'task' | 'file', ref: string }>,
  contradicts: Array<{ id: string, severity: 'minor' | 'major' }>,
  linkedMemoryIds?: string[],            // Soft-supersede: link rather than delete
  updateTargetId?: string,               // Only if event === 'UPDATE'
  rejectReason?: 'noise' | 'duplicate' | 'low-signal' | 'pii'  // event === 'NONE'
}
```

The two-phase pattern is **extract → reconcile**: pass 1 extracts atomic facts; pass 2 retrieves top-k similar via kNN and emits the verdict against them. Direct port of Mem0's `Memory.add()` flow (`mem0/memory/main.py` ~lines 172-1329).

#### 4.2 Backstop + kill-switch

- `BRAIN_GATE_BUDGET_MS = 2000` per-candidate timeout; on timeout, fall back to `hashDedupCheck` only.
- `BRAIN_GATE_DISABLED=1` env — kill-switch (NOT a feature flag) for forensic recovery.
- Remove `_skipGate` re-entry shortcut except for batch-internal recursion.

#### 4.3 Audit trail by default

Every memory-block edit writes a `brain_observations` row with `type='memory-edit'`, `peer_id=<editor>`, `recipient_peer_id=<block-owner>`. This is the "trust budget" discipline: as we add new write paths, the audit log compounds, not the noise.

#### 4.4 Files for Tier 4

- Refactor: `packages/core/src/memory/{llm-extraction,extraction-gate,auto-extract,learnings,decisions,patterns}.ts`
- Tighten contract: `packages/core/src/memory/structured-output.ts`

**Acceptance Tier 4**:
- 100% of brain table writes originate from `verifyAndStore` (AST-grep gate in CI).
- Inserting "We use React 18" then "We migrated to React 19" sets `valid_to + superseded_by` on the first row; second row has higher confidence.
- New observations with `memoryType='belief'` route through reflector with disposition weighting visible in logs.

---

### TIER 5 — Bitemporal + Four-Network Epistemology

**Goal**: BRAIN can answer "what did the system believe on date X?" with a system-time + assertion-time clock pair. Cognitive type taxonomy widens from 3-network to 4-network (Hindsight SOTA pattern).

#### 5.1 Bitemporal validity (Graphiti pattern, ship hard, no flag)

Graphiti's actual schema is **FOUR timestamps** (verified at `graphiti_core/edges.py:263`, see §16.F), not two clocks:

| Column | Clock | Semantics |
|---|---|---|
| `created_at` | system-time | When the row was written to BRAIN |
| `expired_at` | system-time | When the row was superseded in BRAIN (replaces our proposed `superseded_at`) |
| `valid_at` | world-time | When the asserted fact became true in the world |
| `invalid_at` | world-time | When the asserted fact stopped being true in the world (KEEP existing column name — Graphiti uses `invalid_at`; renaming to `valid_to` actually departs from canonical) |

- **Reverse earlier decision**: keep `invalid_at` (current column name on all 4 typed tables per §16.A). Add `expired_at`, `valid_at`, plus existing `created_at`.
- Add `superseded_by` (FK to replacement row).
- **Invalidation-as-LLM-call** (Graphiti pattern): on each new BRAIN write, kNN-retrieve semantically-adjacent rows and let the LLM emit `{contradicts: [id], reason}`. The contradicted edge gets `invalid_at = newRow.valid_at`. Audit trail preserved — never delete.
- **Concurrent extract + invalidate** — Graphiti runs both passes in parallel per episode. CLEO's current ingest is serial; parallelize.
- All readers updated to: `valid_at <= now AND (invalid_at IS NULL OR invalid_at > now) AND expired_at IS NULL`.
- CLI: `--at <iso>` flag on `cleo brain query` for time-travel.
- Two-stage migration: ALTER + new readers + invariant test in one PR.

#### 5.2 Four-network epistemology (Hindsight 91.4% SOTA — arXiv 2512.12818)

Hindsight's actual networks (per §16.E, paper-accurate):

| Network | Content | CLEO routing |
|---|---|---|
| **World** | Objective external facts | High-confidence facts about codebase/operator environment |
| **Bank** | First-person agent experiences/actions | Tool outputs, completed tasks, observed events |
| **Opinion** | Subjective beliefs with **confidence scores that update on new evidence** | Decisions, hypotheses, ToM inferences |
| **Observation** | Preference-neutral entity summaries synthesized from underlying facts | Peer cards, project summaries, system narratives |

**Key insight** (load-bearing): structural separation of **evidence (World/Bank)** from **inference (Opinion)**. When evidence changes, opinions linked to it get **confidence reduced** rather than rewritten. Solves the D0xx-overload problem in MEMORY.md.

Implementation:

- Extend `BRAIN_COGNITIVE_TYPES` (verified at `memory-schema.ts:60`, currently `['semantic','episodic','procedural']`) by adding a parallel `network` column with enum `['world','bank','opinion','observation']`. Keep cognitive types for backwards-compat.
- Add `confidence: REAL` + `evidence_ids: TEXT` (JSON array) to **`opinion`-network rows only** — these update on new evidence arrival.
- Add `recipient_peer_id` column to `brain_observations` for peer-to-peer beliefs (default NULL).
- Add **disposition traits on the reflector** (Hindsight's Cara subsystem pattern): `disposition: 'skeptical' | 'literal' | 'empathetic'` in BBTT briefing config. `observer-reflector.ts` applies dispositional weighting per persona — persona = retrieval prior + disposition, not just prompt-text.
- Map existing 3-network procedural rows: `procedural` stays as a pattern store, separate from the 4-network split.

#### 5.3 LangMem-style typed routing

Confirm and enforce: `memory_type='factual'` → `brain_learnings`; `episodic` → `brain_observations`; `procedural` → `brain_patterns`; `decision` → `brain_decisions`. The architecture already separates these tables — the gap is enforcement that the extraction pipeline routes by type.

**Acceptance Tier 5**:
- `cleo brain query --at 2026-04-01` returns the row set the system believed on that date — different from `--at now`.
- `sqlite3 .cleo/brain.db "SELECT memory_type, COUNT(*) FROM brain_observations GROUP BY memory_type"` shows all 5 types.
- ToM-derived rows have `recipient_peer_id` populated.

---

### TIER 6 — PSYCHE Pipeline (Honcho-derived)

**Goal**: dialectic + deriver + dreamer + reconciler, ported from Honcho V3, ship as core SDK primitives first (per D023) then dispatch surface. Each wave is a separate, durable, restart-safe subsystem.

> **STATUS CORRECTION (§16.A)**: Internal validation shows `dialectic-evaluator.ts`, `surprisal.ts`, `surprisal-tree.ts`, `brain-reconciler.ts` **already exist** in `packages/core/src/memory/`. Only `derivation-queue.ts` is genuinely absent. Tier 6 is **harden + complete + integrate**, not "build from scratch." Each sub-section below is restated as a delta against current state.

#### 6.1 Wave 3 — Dialectic evaluator (`packages/core/src/memory/dialectic-evaluator.ts`)

- `evaluateDialectic(turn: DialecticTurn): Promise<DialecticInsights>` — observer/observed/session pattern from Honcho.
- Two parallel semantic searches per query: explicit observations + derived observations.
- Tool-based context gathering: `search_memory`, `get_reasoning_chain`, `search_messages`, `grep_messages`, `get_observation_context`, `get_messages_by_date_range`.
- Structured output: `DialecticInsights { globalTraits, peerInsights, sessionNarrativeDelta }`.
- Reasoning levels: `low | minimal | medium | high | extreme` (cheaper sets for `minimal`).
- **Open question** (see §10): tools approach (high quality, high latency) vs structured output (lower quality, faster). Recommended: tools for `medium/high/max`, structured for `minimal/low`.

#### 6.2 Wave 5 — Deriver queue (`packages/core/src/memory/derivation-queue.ts` + `derivation-worker.ts`)

- `brain_derivation_queue` table (`session_id, turn_id, status: 'pending|processing|done|failed', attempts, last_error, enqueued_at`).
- SKIP-LOCKED claim pattern via SQLite txn.
- Worker via `cleo memory derive-worker --watch` OR spawned inside sentient daemon tick.
- Retry: exponential backoff, max 5 attempts → dead-letter.
- Replaces the synchronous `setImmediate` dialectic wire-up from Wave 3 with durable enqueue.

#### 6.3 Wave 6 — Dreamer with surprisal + specialists + trees

- `packages/core/src/memory/surprisal.ts` — Bayesian update over `brain_patterns` (cosine > 0.8 prior); high-surprisal candidates bypass rate limit.
- Specialist dispatch inside `sleep-consolidation.ts`:
  - `user-preference-specialist`
  - `decision-specialist`
  - `code-pattern-specialist`
  - `task-outcome-specialist`
- `brain_memory_trees` table (`tree_id, parent_tree_id, topic, summary, observation_count`); observations attach via `tree_id` column.
- Retrieval walks tree root → relevant subtree by query.
- **Honcho 3-AND dream gate** applied to scheduled dream: `(observationsSinceLastDream >= 50) AND (hoursSinceLastDream >= 8) AND (idleMinutesSinceLastTaskComplete >= 60)`. Manual override via `cleo memory dream --force` bypasses.
- **Induction specialist 2-evidence rule** (Honcho constraint): `tendency`/`correlation`/`preference` inductions must have ≥2 source conclusions before emitting.

#### 6.4 Wave 7 — Reconciler (`packages/core/src/memory/brain-reconcile.ts`)

- Absorbs T1139 decision-supersession scope.
- `syncVectorIndex(brainDb)`: re-embed updated observations; purge superseded rows from `brain_embeddings`.
- `rebuildEmbeddings(brainDb, peerIds?)`: per-peer re-embed.
- Dead-letter queue ops + CLI: `cleo memory dlq list|retry|purge`.
- `packages/core/src/sentient/reconcile-scheduler.ts` — periodic via sentient tick or on-demand.

#### 6.5 Structural dream fast-path

Split `runConsolidation()` in `brain-lifecycle.ts` into:
- `runStructuralDream` (steps 1-5 + 9b/9c, no LLM, cheap)
- `runSemanticDream` (full LLM pipeline)

Tick runs structural every cycle when `unconsolidatedObservationCount > 50` even if LLM unavailable.

**Acceptance Tier 6**:
- Wave 3 dialectic produces structured `DialecticInsights` for a seeded session.
- Wave 5 derivation queue survives mid-run kill + worker restart.
- Wave 6 dream cycle reduces `brain_patterns` by ≥50% via dedup.
- Wave 7 reconciler purges superseded rows from `brain_embeddings`.
- 3-AND gate observably blocks scheduled dreams when any condition fails; `--force` bypasses.

---

### TIER 7 — Four-Bus Integration (the inseparable epic, part 2)

**Goal**: BRAIN ↔ NEXUS ↔ TASKS ↔ CONDUIT flow into each other at well-defined seams. No more parallel silos. This is where the agent stops feeling like four disconnected services and starts feeling like one nervous system.

#### 7.1 BRAIN → TASKS — agent spawn injection

New `packages/core/src/orchestrate/spawn-context-builder.ts`. Called from **`composeSpawnForTask`** (`spawn-ops.ts` — function name corrected per §16.A; plan originally said `composeSpawnPayload`). Adds a `SpawnBrainContext` field to the payload with three buckets under a 1200-token budget:

| Bucket | Source | Cap |
|---|---|---|
| Touched-symbol decisions | `task_touches_symbol` edge targets → `graph-memory-bridge.findMemoryNodesForCodeNode(symbolId)` → `brain_decisions` join | 4 |
| Type-matching patterns | `searchBrainCompact({tables:['patterns'], mode:'hybrid', filter:{taskType: task.type}})` | 3 |
| Epic 1-hop learnings | `brain_memory_links` 1-hop from epic id → `brain_learnings` | 3 |

Composer renders as `## Prior Context (from BRAIN)` section. Note: `mental-model-injection.ts` is NOT the right home (that's CANT-level static); this is per-spawn evidence.

#### 7.2 NEXUS → BRAIN — code-aware retrieval

Extend `packages/core/src/nexus/impact.ts` return shape to include `brainEvidence: { decisions, observations }` per impacted symbol. Bridge function `findMemoryNodesForCodeNode` already exists at `memory/graph-memory-bridge.ts:1026`. CLI: `cleo nexus impact <sym>` renders a new `## Memory Context` block per symbol.

#### 7.3 TASKS → NEXUS — pre-decomposition advisor

New `packages/core/src/tasks/decomposition-impact-advisor.ts` — `adviseDecomposition(task, files, projectRoot)` returns `{ shouldSplit, suggestedSplits }`. Cluster symbols by module ownership; recommend split when ≥3 top-level modules or ≥5 unrelated subsystems touched. Wired into `tasks/add.ts` and `tasks/atomicity.ts`. Distinct from `nexus-impact-gate.ts:108` which runs at COMPLETION; this runs at DECOMPOSITION.

#### 7.4 BRAIN ↔ CONDUIT — cross-agent brain handoff

New event type `BrainDigestEvent` published to topic `epic-<TID>.brain-digest`:

```ts
type BrainDigestEvent = {
  type: 'brain-digest',
  epicId: string,
  waveNumber: number,
  emittedBy: string,
  emittedAt: string,
  insights: {
    decisions: string[],
    blockers: string[],
    patternsConfirmed: string[],
  },
  observationIds: string[],
}
```

- Writer: `packages/core/src/orchestrate/wave-rollup.ts` — Phase Lead aggregates wave, publishes digest after `rollupWaveStatus` converges.
- Reader: `spawn-context-builder.ts` drains recent digests when the spawn's task has an `epicId`, injects into `SpawnBrainContext`.

#### 7.5 CONDUIT → BRAIN — significant-message ingester

`packages/core/src/memory/conduit-ingester.ts` — `ingestSignificantMessages(projectRoot, since)`. Deterministic heuristics (no LLM): `task-blocked`, `status-flip`, `decision`, `brain-digest`. Each becomes a `brain_observations` row via `verifyAndStore` with `sourceType='conduit-ingest'`, `origin='auto-extract'`, `provenanceChain=[conduitMessageId]`. Scheduled inside daemon tick.

#### 7.6 Files for Tier 7

**Create**: `spawn-context-builder.ts`, `wave-rollup.ts`, `decomposition-impact-advisor.ts`, `conduit-ingester.ts`.

**Edit**: `spawn-ops.ts:234`, `cant/composer.ts`, `nexus/impact.ts`, `tasks/{add,atomicity}.ts`, `conduit/ops.ts`, `sentient/tick.ts`.

**Acceptance Tier 7**:
- `cleo orchestrate spawn <task> --dry-run` output contains `## Prior Context (from BRAIN)`.
- `cleo nexus impact composeSpawnForTask --json | jq .brainEvidence` returns rows.
- Wave completion → subscriber on `epic-T*.brain-digest` receives event.
- `cleo memory find --source-type conduit-ingest` returns rows after a wave publishes a decision.
- `cleo task plan --files a/x.ts,b/y.ts,c/z.ts` triggers decomposition advisor.

---

### TIER 8 — Continuous Living: idle dream + memory-git + skill distillation

**Goal**: BRAIN learns continuously, not just at session-end. Every peer keeps a git-tracked memory history. Successful patterns auto-distill into reusable skills.

#### 8.1 Continuous sleep-time compute (Letta steal — partially wired)

Today: `executeForRole('consolidation')` runs at session-end. Target: also during idle.

`idleDreamGate(state)` in `packages/core/src/sentient/tick.ts`:
- Trigger: `idleMinutes > 5 AND observationsSinceLastDream > 5 AND daemonHealth.ok`.
- Calls `runPartialDream(top5HighSurprisalObs, peerId)` in `sentient/dream-cycle.ts`.
- Uses existing `surprisal.ts` to pick top-5; routes through `executeForRole('consolidation', { mode: 'partial' })`.
- Writes 1-3 insights into `brain_learnings`.

`archiveCompactionTick(state)` — monthly cycle: learnings with `confidence >= 0.85 AND retrievalCount >= 3 AND peer_id != 'global'` → append to owning peer's `recent-decisions` or `persona` memory block via `memory.append_block`. Mark sources with `tier_promoted_at = now`.

#### 8.2 Memory-git (Letta context-repositories steal)

`packages/core/src/memory/memory-git.ts` — one git repo per peer at `~/.local/share/cleo/memory-versions/<peer-id>/`. Operations:

- `initPeerRepo(peerId)`
- `commitSnapshot(peerId, blocks)`
- `diffBlocks(peerId, from, to)`
- `revertPeer(peerId, sha)`
- `subagentBranch(peerId, subagentId)`
- `mergeSubagent(peerId, branch)`

Hook: every `memory_blocks.ts` write triggers async `commitSnapshot`. Subagent spawns get `MEMORY_GIT_BRANCH=subagent-<id>` env; returned diff merges at phase-lead aggregation (this maps cleanly onto our existing worktree-by-default + ADR-062 merge-not-cherry-pick discipline).

CLI: `cleo memory log <peer>`, `cleo memory diff <peer> <sha1> <sha2>`, `cleo memory revert <peer> <sha>`.

Storage: ~5 MB per peer per year (text blocks dedup well in git).

#### 8.3 Skill distillation (Letta steal)

Trigger in `sentient/dream-cycle.ts`: when `brain_patterns.retrieval_count >= 5 AND brain_patterns.success_rate >= 0.8 AND peer_id != 'global'` → emit `SkillDistillationProposal`. Owner approves via `cleo agent skills review`.

Output: markdown at `~/.cleo/skills/<peer-id>/<skill-name>.md`. Frontmatter: `name, trigger, distilled_from, confidence, source_obs_ids, created_at`.

Subsequent spawns of that peer include the skill via existing progressive-disclosure (`packages/skills/`).

**Files**: `packages/core/src/agents/skill-distill.ts`, extend `packages/cleo/src/cli/commands/agent.ts` (`skills review|list`).

**Acceptance Tier 8**:
- 6 backdated obs + idle 10 min → `idleDreamGate` fires → ≥1 new learning written.
- `cleo memory log cleo-prime` returns git-style history.
- Pattern with retrievalCount=6, successRate=0.9 → proposal visible → on accept, `.md` file appears.

---

### TIER 9 — Sentient Tier-2 detector + Tier-3 sandbox + CANT persona evolution

**Goal**: Tier-2 propose-tick actually generates proposals from BRAIN patterns; agents periodically self-review and emit refined `.cant` definitions.

#### 9.1 T1644 — Tier-2 detector wiring

Implement Honcho-style induction taxonomy in `packages/core/src/sentient/propose.ts`:

- `contradiction` proposals: 2 decisions point opposite ways → propose reconciliation task.
- `correlation` proposals: ≥2 BRAIN entries co-occur ≥K times in nexus plasticity graph → propose investigation.
- `preference` proposals: operator chooses tool X over Y across ≥2 sessions → propose configuration update.
- `tendency` proposals: worker class fails a gate ≥2 times → propose intervention.
- `card_update` proposals: stable fact emerges about operator/codebase → propose persona block update.
- **All proposals enforce 2-evidence rule** (Honcho induction specialist constraint).
- All proposals dedup via content_hash + 7-day window.

Apply 3-AND Honcho gate to Tier-2 propose tick (same `obs >= 50 AND hours >= 8 AND idle >= 60`). Owner override via `cleo sentient propose --force`.

#### 9.2 T1646 — Integration tests

`packages/core/src/sentient/__tests__/daemon-lifecycle.test.ts` exercises Tier1+2+3 with seeded BRAIN patterns; assert specific proposal kinds emit on matched evidence.

#### 9.3 Tier-3 sandbox (deferred follow-up)

File as T-SANDBOX with explicit dependency on cleo-os adapter work. Letta runs sleep-time agents in-process; CLEO has worktrees but not containers. Decision: defer until cleo-os matures.

#### 9.4 T1659 — 312-op surface audit (independent track)

Instrument BRAIN ingestion to record op-invocation events. Build frequency map. Identify top-30, dead aliases, undocumented essentials. Output: `.cleo/agent-outputs/T1250-op-audit.md`.

#### 9.5 CANT persona evolution

- Hook events for identity (add 3 to `hook-mappings.json`): `AgentSigilUpdated`, `AgentSkillMasteryChanged`, `AgentDiaryWritten`.
- `/reflect` directive in CANT: `/reflect @cleo-prime "what worked today"` triggers `cleo agents reflect <peerId>`.
- `agent-architect` meta-agent extension: given an agent's diary + skill mastery + rapport graph, propose a refined `.cant` definition (tier upgrade, skill additions, tool removals).
- Playbook `packages/playbooks/agent-review.cantbook`: reflect → propose refinements → owner approves → re-emit `.cant`.

**Acceptance Tier 9**:
- Tier-2 detector emits a proposal task with `status='proposed'` when 3+ same-pattern rows accumulate in 7 days. Owner accepts → real task created.
- Integration test exercises Tier1+2+3 with mock BRAIN data.
- Periodic `agent-review.cantbook` run produces a refined `.cant` for `cleo-prime` based on its diary + mastery. Owner approves → installed.

---

### TIER 10 — Conduit A2A (PSYCHE Wave 9, deferred)

**Goal**: structured `CANT /handoff @<peerId>` directive with linked observation IDs replaces the deprecated `.cleo/agent-outputs/*.md` redirect stubs.

Design lives at `.cleo/agent-outputs/T1075-psyche-integration-plan/CONDUIT-A2A-DESIGN.md`. Ships in R6.

---

## 6. CI Trust Gates + Hardening (cross-cutting)

#### 6.1 `cleo doctor brain --strict`

Extend `packages/core/src/memory/brain-doctor.ts`. Add 4 checks, exit non-zero when `--strict`:

- Origin coverage: `SELECT COUNT(*) FROM brain_observations WHERE origin IS NULL` == 0
- Pattern bloat: `pattern_count / observation_count <= 2.0`
- Learning liveness: `learning_count / observation_count >= 0.05`
- Dream freshness: `max(consolidated_at)` from `brain_consolidation_events` within 24h

#### 6.2 CI workflow

Add `brain-doctor` job to `.github/workflows/ci.yml`:
- Week 1: `continue-on-error: true` (warning + artifact upload for trend)
- Week 2+: blocking gate after 7 green days

#### 6.3 Daemon resilience

- `PRAGMA busy_timeout = 5000` at every brain.db open site. Helper `applyBrainPragmas(nativeDb)` in `memory-sqlite.ts`; called by every consumer.
- Watchdog at top of `sentient/daemon.ts` cron callback — if `Date.now() - lastCronFiredAt > 2 * intervalMs`, log + `process.exit(2)`. Parent harness restarts.
- Dream-overdue alarm: when `cleo memory dream --status isOverdue=true`, emit a Tier-3 hygiene event surfaced in `cleo briefing`.

**Acceptance §6**:
- `CLEO_BRAIN_INJECT_FAILURE=origin cleo doctor brain --strict` exits 1.
- After daemon `kill -STOP` for 2× interval, watchdog log + process gone.
- `sqlite3 brain.db "PRAGMA busy_timeout"` returns 5000 after first open.

---

## 7. Wave plan (sequenced execution)

Schema-touching work serializes; everything else parallelizes per wave.

| Wave | Tiers | Parallel within wave? | Blocker |
|---|---|---|---|
| **W0 — Schema lock-in** | 1.1 (T9245), 2.1 origin columns, 3.1 peer tables, 3.2 memory_blocks, 3.5 identity tables, 5.1 bitemporal rename, 5.2 cognitive types | **SERIAL** — migrations stack | None — first wave |
| **W1 — Trust funnel** | 2.1 writers + provenance-gate, 2.5 recency call sites, 2.2 fixture quarantine, 4.1-4.3 Mem0 gate funnel, 6.3 daemon C+E | **PARALLEL** — different writers | W0 schema ready |
| **W2 — Auto-extract repair** | 2.3 four-fix bundle, 2.4 T1903 promotion-log, 6.1 brain-doctor strict, 6.2 CI gate (warning) | **PARALLEL** | W1 funnel |
| **W3 — Identity core** | 3.1 peer CRUD/cards/ToM, 3.2 memory blocks + 5 tools, 3.3 CANT growth resolution, 3.4 identity drift, 3.5 sigil-history/diary/skill/rapport, 5.3 dispositional weighting | **PARALLEL** across files; intra-wave dep: 3.3 ← 3.1 peer cards | W0 schema; trust foundation closed |
| **W4 — Four-bus integration** | 7.1 spawn-context-builder, 7.2 nexus impact join, 7.3 decomposition advisor, 7.4 brain-digest, 7.5 conduit ingester | **PARALLEL** across files; intra-wave dep: 7.1 reads what 7.4 writes | W3 peer ID conventions |
| **W5 — PSYCHE pipeline** | 6.1 dialectic, 6.2 deriver queue, 6.3 dreamer + surprisal + trees, 6.4 reconciler, 6.5 structural fast-path | **SEQUENTIAL within tier** (3→5→6→7); parallel across file edits within each tier | W2 origin column live |
| **W6 — Continuous living** | 8.1 idle dream + archive compaction, 8.2 memory-git, 8.3 skill distillation | **PARALLEL** | W3 memory_blocks |
| **W7 — Sentient Tier-2** | 9.1 pattern detector, propose-tick gate, 9.2 integration tests, 9.4 op audit | **PARALLEL** | W5 deriver queue |
| **W8 — CANT evolution** | 9.5 hook events, /reflect, agent-architect, agent-review.cantbook | **PARALLEL** | W3 diary + skill tables |
| **W9 — Conduit A2A** | Tier 10 (deferred) | **TBD** | W4 brain-digest |
| **W∞ — Promote CI gate** | 6.2 flip to blocking after 7d green soak; all §x acceptance smoke tests | **SERIAL at end** | Soak time |

**Dependency graph** (high-level):

```
W0 (Schema lock-in)
  └──▶ W1 (Trust funnel) ──▶ W2 (Auto-extract repair)
         │                       │
         │                       └──▶ W∞ (CI gate blocking)
         │
         └──▶ W3 (Identity core)
                │
                ├──▶ W4 (Four-bus integration)
                │     │
                │     └──▶ W9 (Conduit A2A)  [deferred]
                │
                ├──▶ W5 (PSYCHE pipeline) ──▶ W7 (Sentient Tier-2)
                │
                ├──▶ W6 (Continuous living)
                │
                └──▶ W8 (CANT evolution)
```

**Calendar** (intentionally NOT specified per owner directive — "no concern of timeframes"). Wave order is the load-bearing claim; durations are emergent.

---

## 8. Letta + Honcho V3 — Verified External Facts

### 8.1 Letta (letta-ai/letta + letta-code)

- **Block schema** (`letta/orm/block.py`): `id`, `label` (e.g. `"persona"`, `"human"`), `value: str`, `limit: int` (default `CORE_MEMORY_BLOCK_CHAR_LIMIT = 2000`), `read_only`, `is_template + template_name + preserve_on_migration`, `version: int` (SQLAlchemy `version_id_col` = **optimistic locking**), `current_history_entry_id → block_history.id`.
- **Memory tools** (`letta/functions/function_sets/base.py`): `core_memory_append(label, content)`, `core_memory_replace(label, old_content, new_content)` (empty new = delete; **CAS** on `old_content`), `archival_memory_insert(content, tags?)`, `archival_memory_search(query, tags, tag_match_mode, top_k, start_datetime, end_datetime)`, `conversation_search(query, roles, limit, start_date, end_date)`.
- **Concurrency**: insert = safe, replace = CAS-safe (fails if string changed), rethink = last-writer-wins. Best practice: one owner per block; collaborators use insert.
- **Sleep-time agent**: separate Letta agent linked via Group; runs every `sleeptime_agent_frequency` steps (default 5–10); recommended slower/smarter model than primary; edits **the primary agent's blocks** through the same tool surface.
- **Letta Code's `/sleeptime`** triggers on **MemFS** (a git-tracked memory filesystem, NOT a worktree — §16.G correction). Three trigger modes: `off | step-count | compaction-event`. Two behaviors: `reminder | auto-launch` (auto-launch requires MemFS). Reflection runs in an asyncio background task editing the same memory repo; each block edit produces a git commit via `letta/services/memory_repo/git_operations.py` (638 lines of libgit2-style operations). CLEO's existing worktree-by-default spawn is **adjacent** to but distinct from this — Tier 8 memory-git is its own primitive.
- **Three memory tiers**: core blocks (in prompt always), archival (vector, agent must search), recall (every message persisted, search via tool).
- **Identity layer**: `Identity` ORM keyed via `identities_blocks` and `identities_agents` carries blocks across agent instances.

### 8.2 Honcho V3 (plastic-labs/honcho + honcho.dev)

- **Workspace → Peer → Session → Message → Document(level: explicit|deductive|inductive|contradiction)** hierarchy. Peer is symmetric.
- **Conclusions** are pgvector Documents in a `(observer_peer, observed_peer)` Collection — directional model; contradictions across observers are legitimate.
- **Dream triggers (all required AND)**: ≥50 new conclusions since last dream + ≥8h elapsed + dreaming enabled. **Then a 60-minute idle gate** — new messages reset it. Manual override: `POST /workspaces/{}/schedule_dream`.
- **Two dream specialists**:
  - *Deduction*: knowledge updates, logical implications, contradictions, peer-card updates.
  - *Induction*: behavioral tendencies, preferences, personality traits, correlations — **≥2 source conclusions required** before emitting.
- **Peer card**: `list[str]` — **4 prefixed categories** in code (plain biographical facts, `INSTRUCTION:`, `PREFERENCE:`, `TRAIT:` — verified at `specialists.py:359-363`). The "Identity / Occupation / Relationships / Instructions / Preferences / Traits" 6-category list is flavor text in the system prompt, not enforced enum. **40-entry cap is a prompt hint** (`specialists.py:366,506`), **not** code-enforced — `set_peer_card` is wholesale replace with no validator. Schema is unstructured `list[str]`.
- **Dialectic API**: `peer.chat(query, reasoning_level: minimal|low|medium|high|max, stream)` — synthesizes over peer card + representation documents + relevant source messages.
- **Deriver**: ~1000-token threshold per (peer, representation) batch; queue-based with session ordering preserved.
- **Summarizer**: short (1000 tok, every 20 messages) + long (4000 tok, every 60 messages) — one slot each per session.

### 8.3 What CLEO should NOT copy

- Don't put whole BRAIN in prompt — 2000 × N blocks blows up orchestrator context.
- Don't go fully Honcho-background — orchestrator needs deterministic, inspectable prompts.
- Don't flatten human/agent symmetry — CLEO has **Operator → cleobot SUPREME → cleo-prime → workers** ordering that must be preserved. Use `(observer_peer, observed_peer)` columns to unlock directional ToM without flattening authority.

---

## 9. Borrowing map: Honcho ↔ Letta ↔ CLEO

| External concept | Source | CLEO target | Status |
|---|---|---|---|
| Workspace / Peer / Session | Honcho | PSYCHE Wave 0 | ✅ Shipped |
| Observation hierarchy (explicit/deductive/inductive/contradiction) | Honcho | `brain_observations.level` | Pending — W0 migration |
| Dialectic agent | Honcho | `dialectic-evaluator.ts` | Tier 6.1 |
| Deriver queue | Honcho | `derivation-queue.ts` | Tier 6.2 |
| Dreamer specialists | Honcho | `sleep-consolidation.ts` extensions | Tier 6.3 |
| Surprisal trees | Honcho | `surprisal.ts` + `brain_memory_trees` | Tier 6.3 |
| Reconciler scheduler | Honcho | `brain-reconcile.ts` + `reconcile-scheduler.ts` | Tier 6.4 |
| Peer card → Sigil | Honcho → CLEO | `SigilCard` + `sigil.ts` | ✅ Shipped |
| Theory-of-mind representation | Honcho | `SigilCard.representationJson` + `brain_peer_models` | Tier 3.1 |
| Working representation (3-way blend) | Honcho | `buildRetrievalBundle` cold/warm/hot | ✅ Shipped |
| Memory blocks (sized, editable) | Letta | `brain_memory_blocks` | Tier 3.2 |
| Core memory tool functions | Letta | `memory.{read,edit,append,search,recall}` + CANT directives | Tier 3.2 |
| Archival memory | Letta | Existing `brain_observations` + FTS5 | Already covered |
| Recall memory | Letta | Existing `session-memory.ts` | Already covered (post-W1) |
| Sleep-time agents | Letta + Honcho | Sentient daemon Tier-1 dream cycle | ✅ Shipped Tier-1; Tier-2 pending |
| Persona block | Letta | `SigilCard.systemPromptFragment` + `brain_memory_blocks` label='persona' | Tier 3.2 |
| Human block | Letta | `brain_memory_blocks` label='human' per agent | Tier 3.2 |
| Function calling for memory mgmt | Letta | CANT directives + dispatch ops | Tier 3.2 |
| Shared org memory blocks | Letta | `brain_memory_blocks` label='shared:<topic>' | Tier 3.2 |
| Agent state persistence | Letta | Sigil + Diary + Skill Mastery + Rapport | Tier 3.5 |
| Context-repository (git-tracked memory) | Letta Code | `memory-git.ts` + per-peer repo | Tier 8.2 |
| Bitemporal validity | Graphiti | `valid_to` + `superseded_at` + `superseded_by` | Tier 5.1 |
| Multi-strategy retrieval | Hindsight (91.4% SOTA) | `searchBrainCompact` vector + BM25 + graph in parallel | T549 deferred Phase-2 |
| 4-network epistemology (W/B/O/S) | Hindsight | `BRAIN_COGNITIVE_TYPES` extend | Tier 5.2 |
| Write-time extraction gate (single chokepoint) | Mem0 | `verifyAndStore` funnel | Tier 4 |
| Typed memory taxonomy | LangMem | `memory_type` routing rule | Tier 5.3 |
| Pre-composed context | Mastra (95% SOTA) | `buildRetrievalBundle` cold pre-render | ✅ Shipped |

---

## 10. Open questions for owner

1. **Tier-3 sandbox infra** — defer to a separate epic (current plan), or invest now? Letta runs sleep-time agents in-process; CLEO has worktrees but not containers.
2. **Honcho V3 dialectic-via-tools vs. structured-output** — Honcho V3 dialectic uses ~7 agent tools (`search_memory`, `get_reasoning_chain`, `search_messages`, `grep_messages`, `get_observation_context`, `get_messages_by_date_range`, `search_messages_temporal`). PSYCHE Wave 3 T1087 currently specs structured-output. Recommend: tools for `medium/high/max` reasoning, structured for `minimal/low`. Confirm.
3. **Conduit A2A (Tier 10 / PSYCHE Wave 9)** — ship in W4 alongside four-bus integration, or defer to W9 as currently sequenced? Unlocks true mesh coordination, adds complexity.
4. **Daemon install policy** — operator runs `cleo daemon install` manually, or build a first-run wizard prompted on `cleo init`?
5. **Symmetry of human/agent peers (Honcho-style)** — adopt symmetric Peer model where an "agent" is queryable identically to "operator", or preserve CLEO's hierarchy (Operator → cleobot SUPREME → cleo-prime → workers)? **Recommendation**: keep hierarchy, add `(observer_peer, observed_peer)` columns on BRAIN entries to unlock directional ToM without flattening authority.
6. **Reflection model tier** — Letta recommends slower/smarter for sleep-time. CLEO's owner-locked Q4/Q5 puts warm=Ollama, cold=Sonnet. Should sleep-time consolidator use Opus 4.7 for highest quality, or stay on Sonnet to match cold-tier?
7. **Memory-git storage location** — per-peer repos under `~/.local/share/cleo/memory-versions/<peer-id>/` (current proposal) vs `.cleo/memory-versions/<peer-id>/` (per-project). Cross-project rapport favors global; per-project sandboxing favors local. **Recommendation**: global. Confirm.
8. **CI gate flip to blocking** — 7d green soak is conservative. Trigger sooner (3d) if all checks stay green? Owner risk tolerance call.

---

## 11. Cross-cutting concerns

### 11.1 The trust budget (gating discipline)

This plan adds ~10 new tables, ~15 new columns, ~30 new code paths into BRAIN. **The Tier 4 extraction-gate funnel is the chokepoint** that keeps trust net-positive. Every new write goes through `verifyAndStore`. No exceptions. Audit trail by default: every memory-block edit writes a `brain_observations` row with `type='memory-edit'`.

### 11.2 Kill-switches (despite "ship hard, no flags")

Two emergency kill-switches stay — these are NOT feature flags, they're forensic levers:
- `BRAIN_GATE_DISABLED=1` — bypass extraction gate (data still routes through `hashDedupCheck`)
- `CLEO_DAEMON_WATCHDOG=0` — disable watchdog if self-exits become a problem

Everything else ships default-on.

### 11.3 Peer ID canonicalization

`packages/contracts/src/peer.ts`:
- `human:<email>`
- `agent:<peerKind>:<name>` (e.g. `agent:orchestrator:cleo-prime`)
- `external:<provider>:<id>`

### 11.4 Backwards-compat

Agents without `growth.enabled` keep working exactly as today. Composer's `if (mentalModelRef.growth?.enabled)` branch is the only divergence. All existing seed agents in `packages/cleo-os/seed-agents/` pass unchanged through the test corpus.

### 11.5 Performance

- Memory blocks add ~500-2000 tokens per spawn. Existing `TIER_CAPS` + `escalateTier` in `composer.ts` handles via budget accounting.
- Peer-card retrieval: single indexed lookup, sub-ms.
- ToM inference: LLM call. Cache in `brain_peer_models` with `valid_to = now+6h`. Don't re-infer unless invalidated.
- Memory-git commit: async, fire-and-forget, never blocks agent.

### 11.6 Privacy / redaction

`brain_peers.attributes_json` may contain PII for human peers. Mark for redaction in `packages/core/src/memory/redaction.ts` pipeline.

### 11.7 SDK-first (D023)

Every Tier ships as a core SDK primitive first; CLI dispatch follows. This is what makes Prime portable across any inference provider — the harness is `packages/core/`, and `packages/cleo/`, `packages/cleo-os/`, `packages/studio/`, `packages/caamp/`, and future surfaces are views over it.

---

## 12. Verification strategy

### 12.1 Per-tier truth checks

- **T1**: T9245 integration test passes. All 13 mis-completed tasks re-verified with real evidence atoms (no `--override`). `systemctl --user is-active cleo-daemon = active`. `cleo memory dream --status` shows `isOverdue: false` for 7 days.
- **T2**: Every BRAIN row has `origin != null` (100%). `cleo briefing --strict` exits non-zero on contract violation. CI fails any test writing to live `.cleo/tasks.db`. Auto-extract promotion ratio ≥ 5%.
- **T3**: Spawned agent prompt contains `# Core Memory` + `# Mental Model` blocks. `cleo peer card cleo-prime` non-empty. After 5 sessions, `cleo agent diff` shows non-trivial diff. `cleo agents show cleo-prime --history` shows sigil timeline.
- **T4**: 100% of brain table writes originate from `verifyAndStore` (CI AST-grep). Supersession works.
- **T5**: `cleo brain query --at <past-date>` returns historic row set. All 5 cognitive types populated.
- **T6**: Dialectic produces structured `DialecticInsights`. Deriver queue survives mid-run kill. Dream cycle reduces `brain_patterns` ≥50%. Reconciler purges superseded vector rows.
- **T7**: `cleo orchestrate spawn <task> --dry-run` shows `## Prior Context (from BRAIN)`. `cleo nexus impact <sym> --json` returns `brainEvidence`. Wave completion publishes `brain-digest` event.
- **T8**: Idle dream fires under conditions. `cleo memory log <peer>` returns history. Skill distillation proposal visible on accept.
- **T9**: Tier-2 detector emits proposal task when ≥3 same-pattern rows accumulate in 7 days. Integration test passes Tier1+2+3 with mock data.
- **T10**: A2A handoff round-trips with observation IDs preserved (deferred).

### 12.2 End-to-end verification

```bash
# 0. Install
npm install -g @cleocode/cleo@<new-version>
cleo --version

# 1. Trust foundation
cleo verify T9245 --gate implemented --evidence "commit:<sha>;files:packages/core/src/lifecycle/evidence.ts"
cleo verify T9245 --gate testsPassed --evidence "tool:test"
cleo verify T9245 --gate qaPassed --evidence "tool:lint;tool:typecheck"
cleo show T1892   # BBTT epic re-completes

# 2. Engine liveness
cleo daemon install
systemctl --user is-active cleo-daemon
cleo memory dream --status      # isOverdue=false
cleo doctor brain --strict      # all green

# 3. Peer + memory blocks + growing personas
cleo peer list
cleo peer card cleo-prime
cleo orchestrate spawn <task> --dry-run | grep -E "Core Memory|Mental Model|Prior Context"
# Have a worker call memory.edit_block('current-goal', 'X')
cleo memory blocks <peer-id>
# After 5 sessions:
cleo agent diff <agent-id>
cleo agents show cleo-prime --history
cleo agents diary cleo-prime
cleo agents mastery cleo-prime
cleo agents rapport cleo-prime

# 4. Mem0 gate + bitemporal
cleo memory observe "We use React 18"
cleo memory observe "We migrated to React 19"
# First row should now have valid_to + superseded_by set
cleo brain query --at $(date -u -d '7 days ago' --iso-8601)
sqlite3 .cleo/brain.db "SELECT memory_type, COUNT(*) FROM brain_observations GROUP BY memory_type"

# 5. PSYCHE pipeline smoke
cleo memory derive-worker --watch &
cleo session start
# ... agent activity ...
cleo memory dream --force
cleo memory dlq list

# 6. Four-bus flow
cleo nexus impact composeSpawnForTask --json | jq .brainEvidence
cleo task plan --files a/x.ts,b/y.ts,c/z.ts   # decomposition advisor splits
cleo conduit subscribe epic-T9999.brain-digest &
# Trigger wave completion → verify digest arrives
cleo memory find --source-type conduit-ingest

# 7. Continuous living
# Backdate 6 observations, set idleMinutes=10
cleo sentient tick --dry-run    # should fire idleDreamGate
cleo memory log <peer-id>        # git-style history
# Insert pattern with retrievalCount=6, successRate=0.9
cleo memory dream
cleo agent skills review         # proposal visible

# 8. Tier-2 propose + CANT evolution
cleo sentient propose list
cleo sentient propose accept <id>
cleo playbook run agent-review.cantbook -- --peer cleo-prime

# 9. CI gate
CLEO_BRAIN_INJECT_FAILURE=origin cleo doctor brain --strict   # exits 1
gh workflow run ci.yml && gh run watch

# Final ship gate
cleo doctor brain --strict       # all green
cleo briefing --strict            # exits 0
```

Each tier ships its own `cleo verify` evidence atoms (`verify.brain.originCoverage`, `verify.spawn.brainContext`, `verify.conduit.brainDigest`, etc.).

---

## 13. Critical files reference (consolidated)

### Schema + migrations
- `packages/core/src/store/memory-schema.ts` (Drizzle source)
- `packages/core/src/store/memory-sqlite.ts` (runtime DDL + pragmas)
- `packages/core/migrations/drizzle-brain/<ts>_<task>/migration.sql` (one per schema delta)

### Memory pipeline
- `packages/core/src/memory/extraction-gate.ts` — THE chokepoint (Tier 4)
- `verifyAndStore` (`extraction-gate.ts:606`)
- `packages/core/src/memory/brain-lifecycle.ts` — `runConsolidation` 11-step
- `packages/core/src/memory/sleep-consolidation.ts` — already routes via Kimi (T9320)
- `packages/core/src/memory/dream-cycle.ts` — trigger logic
- `packages/core/src/memory/observer-reflector.ts` — disposition (Tier 5)
- `packages/core/src/memory/llm-extraction.ts` — Mem0 verdict contract (Tier 4)
- `packages/core/src/memory/auto-extract.ts` — funnel (Tier 2)
- `packages/core/src/memory/graph-memory-bridge.ts` — `findMemoryNodesForCodeNode` (Tier 7)
- `packages/core/src/memory/brain-doctor.ts` — CI gate (§6)
- `packages/core/src/memory/redaction.ts` — privacy
- `packages/core/src/memory/temporal-supersession.ts` — bitemporal (Tier 5)
- `packages/core/src/memory/dialectic-evaluator.ts` — NEW (Tier 6.1)
- `packages/core/src/memory/derivation-queue.ts` — NEW (Tier 6.2)
- `packages/core/src/memory/derivation-worker.ts` — NEW (Tier 6.2)
- `packages/core/src/memory/surprisal.ts` — NEW (Tier 6.3)
- `packages/core/src/memory/specialist-agents.ts` — NEW (Tier 6.3)
- `packages/core/src/memory/brain-reconcile.ts` — NEW (Tier 6.4)
- `packages/core/src/memory/peers.ts` — NEW (Tier 3)
- `packages/core/src/memory/peer-cards.ts` — NEW (Tier 3)
- `packages/core/src/memory/peer-tom.ts` — NEW (Tier 3)
- `packages/core/src/memory/memory-blocks.ts` — NEW (Tier 3)
- `packages/core/src/memory/identity-drift.ts` — NEW (Tier 3)
- `packages/core/src/memory/agent-diary.ts` — NEW (Tier 3)
- `packages/core/src/memory/agent-skills.ts` — NEW (Tier 3)
- `packages/core/src/memory/agent-rapport.ts` — NEW (Tier 3)
- `packages/core/src/memory/sigil-history.ts` — NEW (Tier 3)
- `packages/core/src/memory/memory-git.ts` — NEW (Tier 8.2)
- `packages/core/src/memory/conduit-ingester.ts` — NEW (Tier 7.5)
- `packages/core/src/memory/provenance-gate.ts` — NEW (Tier 2)
- `packages/core/src/memory/brain-noise-detector.ts` — NEW (Tier 2.2)

### Peer + persona
- `packages/contracts/src/peer.ts` — `PeerIdentity` + `canonicalPeerId`
- `packages/cant/src/types.ts` — `CantMentalModelRef.growth` (Tier 3.3)
- `packages/cant/src/composer.ts` — spawn-time growth resolution
- `packages/cant/src/mental-model.ts` — `resolveGrowthQueries`
- `packages/agents/meta/agent-architect.cant` — extension (Tier 9.5)

### Sentient + spawn
- `packages/core/src/sentient/daemon.ts` — watchdog (§6.3)
- `packages/core/src/sentient/tick.ts` — `idleDreamGate`, `archiveCompactionTick`
- `packages/core/src/sentient/propose.ts` — pattern detector wiring (Tier 9.1)
- `packages/core/src/sentient/propose-tick.ts` — 3-AND gate (Tier 9.1)
- `packages/core/src/sentient/reconcile-scheduler.ts` — NEW (Tier 6.4)
- `packages/core/src/orchestrate/spawn-ops.ts:234` — `composeSpawnPayload` (Tier 7.1)
- `packages/core/src/orchestrate/spawn-context-builder.ts` — NEW (Tier 7.1)
- `packages/core/src/orchestrate/wave-rollup.ts` — NEW (Tier 7.4)
- `packages/core/src/agents/persona-evolution.ts` — NEW (Tier 3.4)
- `packages/core/src/agents/skill-distill.ts` — NEW (Tier 8.3)
- `packages/core/src/tasks/decomposition-impact-advisor.ts` — NEW (Tier 7.3)

### Four-bus seams
- `packages/core/src/nexus/impact.ts` (Tier 7.2)
- `packages/core/src/tasks/{add,atomicity,nexus-impact-gate}.ts` (Tier 7.3)
- `packages/core/src/conduit/ops.ts` (Tier 7.4, 7.5)

### Lifecycle / evidence
- `packages/core/src/lifecycle/evidence.ts:427` — `validateCommit` (Tier 1.1)
- `packages/core/src/tasks/verifier-runner.ts` (Tier 1.1)

### CLI surface
- `packages/cleo/src/cli/commands/daemon.ts:195` — cwd resolution (Tier 1.3)
- `packages/cleo/src/cli/commands/memory.ts` — block/log/dream/dlq surfaces
- `packages/cleo/src/cli/commands/doctor.ts` — `doctor brain --strict`
- `packages/cleo/src/cli/commands/peer.ts` — NEW (Tier 3)
- `packages/cleo/src/cli/commands/agent.ts` — extend (diff/reflect/mastery/rapport/doctor/skills)
- `packages/cleo/scripts/install-daemon-service.mjs` — `WorkingDirectory=` (Tier 1.3)

### LLM stack (already shipped — reuse)
- `packages/core/src/llm/role-executor.ts` — `executeForRole(role, ...)` (T9320)
- `packages/core/src/llm/{runtime,session,executor}.ts` — T9261 Phase 4 W1-W4
- `packages/core/src/llm/provider-registry/builtin/kimi-code.ts` — T9321

### CI + hardening
- `scripts/freshness-sentinel.ts` + `.github/workflows/freshness.yml` — NEW (Tier 1.3)
- `.github/workflows/ci.yml` — add `brain-doctor` job (§6.2)
- `packages/core/scripts/verify-provenance-writers.mjs` — NEW (Tier 2.1)

### Hook + playbook
- `packages/caamp/providers/hook-mappings.json` — +3 events (Tier 9.5)
- `crates/cant-core/src/` — `/reflect` directive (Tier 9.5)
- `packages/playbooks/agent-review.cantbook` — NEW (Tier 9.5)

---

## 14. Deliverables summary

By the end of this initiative, CLEO will have:

1. **A trust-verifier that cannot be bypassed by `--override`** (Tier 1)
2. **A demonstrably-running sentient daemon** with a 7-day clean dream-cycle window and systemd-managed liveness (Tier 1)
3. **Full provenance + quarantine** — every BRAIN row has `origin`; test fixtures never reach production briefing (Tier 2)
4. **Per-agent peer graph** — every CANT persona is a first-class peer with sigil history, diary, skill mastery, and rapport graph (Tier 3)
5. **Letta-style editable memory blocks** for persona, human-block, project-block, scratchpad, and shared blocks per agent (Tier 3)
6. **Growing CANT personas** — mental models resolved from BRAIN at spawn, with identity-drift detection (Tier 3)
7. **One Mem0-style write-time extraction gate** — single chokepoint for every BRAIN write (Tier 4)
8. **Bitemporal validity** — `cleo brain query --at <date>` time-travel (Tier 5)
9. **4-network cognitive types** — world-fact, belief, observation, summary, procedural (Tier 5)
10. **Full PSYCHE pipeline** — dialectic evaluator, durable deriver queue, dreamer specialists with surprisal + memory trees, reconciler with vector sync (Tier 6)
11. **Four-bus integration** — BRAIN context in spawn prompts, BRAIN evidence in NEXUS impact, NEXUS guidance in TASKS decomposition, brain-digest events on CONDUIT, CONDUIT messages into BRAIN (Tier 7)
12. **Continuous sleep-time compute** — idle-dream gate, archive compaction, structural fast-path (Tier 8)
13. **Memory-git per peer** — git-tracked memory diff history with subagent branching (Tier 8)
14. **Skill distillation** — successful patterns auto-compile into reusable agent skills (Tier 8)
15. **Tier-2 proposal generation** — BRAIN-pattern-driven tasks surfaced for owner review with 2-evidence rule (Tier 9)
16. **CANT persona evolution** — `agent-review.cantbook` periodic self-review producing refined `.cant` definitions (Tier 9)
17. **A `cleo doctor brain --strict` CI gate** catching regressions in any of the above (§6)
18. **(Deferred)** Conduit A2A for structured agent-to-agent handoff replacing `.cleo/agent-outputs/*.md` redirect stubs (Tier 10)

---

## 15. One-line summary

We are turning CLEO from a four-DB memory system *for* agents into a peer-graph nervous system *of* agents — where CLEO Prime is the one persistent persona the operator meets, every CANT agent is a first-class peer with editable memory blocks and a growing mental model resolved from BRAIN, every belief is bitemporal, every write passes one Mem0-style extraction gate, every peer keeps a git-tracked memory diff history, and BRAIN trust net-rises as we add intelligence.

The brain remembers. The agents grow. The system tells the truth about itself. Prime persists.

---

## Appendix A — Provenance of this plan

This document synthesizes two parallel research-pass plans into one canonical roadmap:

- `~/.claude/plans/dreamy-yawning-pinwheel.md` (7-layer "Living Brain + Personas + Honcho/Letta Integration")
- `~/.claude/plans/i-know-there-was-sequential-elephant.md` (6-phase "Living Brain — Sentient CLEO: Full Roadmap")

Both source plans drew on:
- T549-R1/R2/CA1/CA2 prior memory research (2026-04-13)
- T1075 PSYCHE integration plan (Wave 0-9)
- BBTT campaign artifacts (RCASD-WAVE-PLAN, WHY-DREAM-DIDNT-RUN, campaign-validation-2026-05-12)
- Letta source audit (letta-ai/letta + letta-code, 2026-05-15 research pass)
- Honcho V3 source audit (plastic-labs/honcho, 2026-05-15 research pass)
- ADR-006/009/021/048/051/055/062/065/070 (canonical lineage)
- Active git state as of 2026-05-15 (branch `feat/T9261-phase4-w5-w8`; v2026.5.68 latest tag)

Differences resolved in this synthesis:
- "Layers" (plan 1) and "Phases" (plan 2) merged into unified **Tiers** with explicit wave plan.
- Plan 1's Honcho-focus and Plan 2's four-bus-focus combined as **Tier 6 + Tier 7** (parallel concerns).
- Plan 1's Conduit A2A as **Tier 10 (deferred)** matches Plan 2's lack of equivalent.
- Plan 2's memory-git + skill-distillation + idle-dream consolidated under **Tier 8** (Continuous Living).
- Plan 2's Mem0 extraction gate elevated to standalone **Tier 4** (the chokepoint discipline).
- Both plans' bitemporal + 4-network unified under **Tier 5**.
- Both plans' identity persistence (sigil history + diary + mastery + rapport) + Letta memory blocks merged into **Tier 3** as one coherent epic.

This plan is the canonical sentience roadmap. Subsequent task creation, RCASD specs, and PSYCHE wave execution should reference Tier numbers in this document.

---

## 16. Research Validation Appendix (added 2026-05-15, post research-pass-2)

Four parallel research agents validated this plan's claims against (a) the current CLEO codebase and (b) external systems (Honcho V3, Letta, Hermes-Agent, Mem0, Zep/Graphiti, Hindsight, Mastra, LangMem, MemGPT, A-Mem). This appendix records the corrections + the broader catalogue of steal-worthy primitives not in the original body. Body sections above have been edited where the correction is load-bearing; everything else is captured here.

### 16.A — Internal codebase validation (corrections to body)

| Plan claim | Reality | Fix applied |
|---|---|---|
| T9245 site = `lifecycle/evidence.ts:427` | Actual = `packages/core/src/tasks/evidence.ts:427` | Tier 1.1 + §13 file paths updated |
| `composeSpawnPayload` | Actual name = `composeSpawnForTask` | Tier 7.1 updated |
| Tier 2.5 BM25-on-"session" is an active bug | Already fixed at `session-memory.ts:416` | Tier 2.5 demoted to "regression test only" |
| PSYCHE files (dialectic, surprisal, reconcile) "DO NOT exist yet" | `dialectic-evaluator.ts`, `surprisal.ts`, `surprisal-tree.ts`, `brain-reconciler.ts` all exist; only `derivation-queue.ts` is missing | Tier 6 reframed as "harden + complete" |
| `brain_memory_trees` is a NEW table | Already exists | Tier 6.3 should treat as harden, not create |
| Brain schema has ~8 tables | Schema has 18+ tables incl. `brain_page_nodes`, `brain_page_edges`, `brain_retrieval_log`, `brain_plasticity_events`, `brain_weight_history`, `brain_modulators`, `brain_consolidation_events`, `brain_transcript_events`, `brain_promotion_log`, `brain_backfill_runs`, `brain_memory_trees` | Tier 3.1 + §13 should enumerate the full surface |
| `canonicalPeerId()` exists in contracts | Confirmed ABSENT — needs creating | Tier 3.1 stands |
| `CantMentalModelRef.growth` field | Confirmed ABSENT — needs adding | Tier 3.3 stands |
| Daemon cwd `CLEO_PROJECT_ROOT` fallback | Confirmed ABSENT — `daemon.ts:195` only `process.cwd()` | Tier 1.3 stands |
| 31 canonical hook events | Confirmed correct | No change |
| `invalid_at` present on 4 typed tables | Confirmed at `memory-schema.ts:207,464,610,747` | Tier 5.1 should KEEP `invalid_at` (was: rename to `valid_to`) — reversed to match Graphiti canonical naming |
| `memory-git.ts` / `memory-versions/` exists | Confirmed ABSENT | Tier 8.2 stands |
| `BRAIN_COGNITIVE_TYPES` = 3 types | Confirmed `['semantic','episodic','procedural']` at `memory-schema.ts:60` | Tier 5.2 stands (4-network adds a parallel `network` column rather than replacing cognitive types) |

### 16.B — Hermes-Agent (NousResearch, Apache-2.0) — `NousResearch/hermes-agent`

**Status**: not in original plan. **Verdict**: high-leverage adopt-list.

| Primitive | File reference | CLEO integration |
|---|---|---|
| **Curator pattern** — auxiliary-LLM background skill-maintenance orchestrator | `agent/curator.py` (state in `~/.hermes/skills/.curator_state`; defaults 7-day interval, 30-day stale, 90-day archive) | Tier 9 sentient daemon adopts auxiliary-client model. Strict invariants: only touches `created_by:"agent"` artifacts; never deletes (archive recoverable); pinned bypasses all auto-transitions; uses separate auxiliary client to **preserve main session's prompt cache**. |
| **MemoryProvider plugin ABC** — `sync_turn`, `prefetch`, `shutdown`, `post_setup` lifecycle | `plugins/memory/{honcho,mem0,hindsight,supermemory,retaindb,byterover,openviking,holographic}/` | NEW Tier 11: define `packages/core/src/memory/provider.ts` with same ABC. BRAIN, NEXUS, and future llmtxt-core all implement it. CLEO becomes provider-agnostic at the memory layer. |
| **Toolset bundles keyed off role** | `tools/registry.py` + `toolsets.py` — bundles `browser`, `terminal`, `delegation`, `memory`, `skills`, `kanban_*` attached to roles | Replaces our spawn-prompt tier 0/1/2 with **role × capability** matrix. Tier conflates content depth with capability surface; bundles split them cleanly. |
| **Bounded delegation recursion** | `tools/delegate_tool.py` — `delegation.max_spawn_depth`, role-gated; leaf workers cannot spawn | Maps to existing ORC-001 rule. Codify in `spawn-context-builder.ts`. |
| **SessionDB SQLite with FTS5 + `parent_session_id` lineage chains** | `hermes_state.py` | CLEO conduit.db already has FTS5; add `parent_session_id` chain to `brain_sessions` (Tier 3.1). |
| **Context compressor** — middle-of-window summarization via auxiliary LLM with `protect_last_n` floor | `agent/context_compressor.py` | Tier 6.5 structural fast-path absorbs this; aux-client rule preserves main cache. |
| **Prompt-cache hygiene rule** | Implicit in curator.py separating clients | New CROSS-CUTTING rule §11.8: auxiliary tasks MUST use a different client than the foreground orchestrator. Today's sentient/dream-tick may invalidate the operator's main KV cache. |

### 16.C — Letta v2 memory tool family (supersedes plan's v1 surface)

Plan's Tier 3.2 proposed Letta's v1 tools (`core_memory_append`, `core_memory_replace`). Letta has shipped a **v2 family** alongside v1; new agents likely use v2.

| v2 tool | Behavior |
|---|---|
| `memory` | Codex-style unified entry point — `memory(command, ...)` with sub-commands |
| `memory_apply_patch` | **Multi-block atomic patches** with unified-diff headers: `*** Add Block:`/`*** Update Block:`/`*** Delete Block:`/`*** Move to:` (`base.py:453-485`). One tool call mutates many blocks atomically. |
| `memory_replace` | v2 replace, CAS semantics inherited |
| `memory_insert` | Append, always safe |
| `memory_rethink` | Last-writer-wins (overwrite) |
| `memory_finish_edits` | Sentinel — explicitly signals "done editing", avoids wasted LLM cycles |

**Action**: Tier 3.2 should port v2 not v1. The patch-headers format is directly usable.

**Plus** (verified in Letta source):

- **Optimistic-lock + linear history chain** (`orm/block.py:56-61` + `orm/block_history.py:12-49`). SQLAlchemy `version_id_col` for `StaleDataError`-on-conflict; `BlockHistory` has monotonic `sequence_number` with per-`block_id` unique index — **full undo/redo chain**, not just current pointer. Adopt verbatim in `brain_memory_blocks` + `brain_memory_block_history`.
- **Block↔Agent↔Group↔Identity 4-way M:N graph** — `blocks_agents`, `groups_blocks`, `identities_blocks`, `identities_agents`. One Block row can be shared across multiple agents AND across multiple human identities. Direct analogue for CLEO's "shared memory across orchestrator + workers" — Tier 3.2 `shared:<topic>` becomes a Group association rather than a label prefix.
- **Group manager strategies** (`schemas/group.py:12-14,86+`): `round_robin`, `supervisor`, `dynamic`, `sleeptime`, `voice_sleeptime`. `manager_agent_id` + `termination_token` + `max_turns` + `max_message_buffer_length` / `min_message_buffer_length` make this a **declarative supervisor primitive**. Maps onto ADR-070 hierarchical orchestration — CLEO can ship a YAML supervisor config rather than baking control-flow into code.
- **Hybrid recall search** — every persisted message gets a background embedding update task; `conversation_search` runs text-OR-semantic over the entire history (`message_manager.py:632-756,876-915`). Today's `session-memory.ts` is text-only. Adopt for conduit messages too.
- **`safe_create_task` background-task helper** (`letta/utils.py:1166-1294`) — labeled asyncio task spawner with GeneratorExit-safe sleeptime trigger (sleeptime runs in `finally` block to survive stream cancellation). Plus per-resource `asyncio.Semaphore(5)` for vector store (`tpuf_client.py:159`) — bounded concurrency pattern.
- **Tool sandbox layering** (`letta/services/tool_sandbox/`): local, E2B, Modal (v2 + deployment manager + version manager). Pluggable sandbox transport. Tier-3 sandbox plan (deferred to T-SANDBOX) should adopt this abstraction shape.
- **Production-grade MCP client surface** (`letta/services/mcp/`): stdio, SSE, streamable_http, fastmcp, server-side OAuth. Far beyond our current `@cleocode/mcp-adapter` external bridge.

**Letta corrections to plan**:
- `sleeptime_agent_frequency` has **no code default of "5-10"** (`schemas/group.py:43,122,128` — `Optional[int] = Field(None)`). The 5-10 guidance is docs-only.
- `/sleeptime` reflection uses **MemFS** (filesystem + cloud HTTP service swapped via `LETTA_MEMFS_SERVICE_URL`), NOT a git worktree. Trigger modes `off | step-count | compaction-event`; behaviors `reminder | auto-launch`. `compaction-event + auto-launch` requires MemFS.
- Letta's OSS has **no standalone eval harness** — `lettuce` is a cloud stub. Published benchmark numbers are not reproducible from open source.

### 16.D — Mem0 verdict envelope (correction to Tier 4)

`mem0ai/mem0` (Apache-2.0). Plan's Tier 4 verdict contract was a fabrication; the actual envelope is verified in source.

- **V1/V2 envelope** (`mem0/configs/prompts.py:176` — `DEFAULT_UPDATE_MEMORY_PROMPT`): `{event: "ADD" | "UPDATE" | "DELETE" | "NONE", old_memory?: string}`. Two-phase: extract candidate facts → kNN top-k against existing memories → emit verdict.
- **V3 envelope** (`prompts.py:468` — `ADDITIVE_EXTRACTION_PROMPT`): **DELETE removed**. Append-only with `linked_memory_ids: UUID[]` for soft-supersession. Mem0 publicly conceded DELETE causes regressions.
- **Driver**: `Memory.add()` at `mem0/memory/main.py:172-1329`.

**Action**: Tier 4 body now uses the Mem0 V3 envelope shape directly (event ∈ {ADD, UPDATE, NONE}, `linkedMemoryIds` for soft-supersede, no DELETE). This aligns with Tier 5 bitemporal — supersession is `invalid_at` + `superseded_by`, never `DELETE FROM`.

### 16.E — Hindsight 4-network details (correction to Tier 5.2)

Paper: arXiv 2512.12818 (Dec 2025), MIT-licensed. First system across 90% on LongMemEval S.

- **Four networks**: World (objective external facts) / Bank (first-person agent experiences) / Opinion (subjective beliefs with confidence scores updated on new evidence) / Observation (preference-neutral entity summaries synthesized from underlying facts).
- **Two subsystems**: **Tempr** (Temporal Entity Memory Priming Retrieval) — owns *retain* + *recall*. **Cara** (Coherent Adaptive Reasoning Agents) — owns *reflect* with disposition traits.
- **Three operations**: retain, recall, reflect.
- **Headline gains** (LongMemEval): multi-session 21.1 → 79.7, temporal 31.6 → 79.7, knowledge-update 60.3 → 84.6.

**Load-bearing idea**: structural separation of evidence (World+Bank) from inference (Opinion). When evidence changes, opinions linked to it get their confidence reduced rather than rewritten. **Tier 5.2 has been rewritten to match this.** CLEO's nexus/sentient subsystems map cleanly onto Tempr/Cara — Nexus owns retrieve, sentient owns reflect.

### 16.F — Graphiti bitemporal correction (Tier 5.1)

`getzep/graphiti` (Apache-2.0). Verified at `graphiti_core/edges.py:263`:

```python
class EntityEdge(Edge):
    created_at: datetime    # system-time (write)
    expired_at: datetime    # system-time (supersession)
    valid_at: datetime      # world-time (asserted truth start)
    invalid_at: datetime    # world-time (asserted truth end)
```

**Four** timestamps, not two clocks. Plan body now reflects this. Plus:

- **Invalidation-as-LLM-call**: edges are NEVER deleted on contradiction. The contradicted edge gets `invalid_at = new edge's valid_at`. Reconciliation runs `dedupe_edges.py` + `extract_edges.py` siblings, an LLM call per new edge against semantically-related existing edges.
- **Concurrent extract + invalidate**: both passes parallel per episode. CLEO's ingest today is serial.

### 16.G — Honcho V3 corrections (Tier 6)

Verified against `plastic-labs/honcho@HEAD`:

| Plan claim | Reality | Action |
|---|---|---|
| Peer card 6 categories | **4** in code: plain facts, `INSTRUCTION:`, `PREFERENCE:`, `TRAIT:`. 40-cap is prompt-only, not enforced. | Body corrected (§8.2). |
| Two dream specialists with two dream types | Single `DreamType.OMNI` enum (`schemas/configuration.py:16-19`). Deduction + induction are **sequential phases** of one omni dream. | Tier 6.3 "two specialists" stays correct but the dispatch model should be one omni dream cycle, not two separately-scheduled dreams. |
| Deriver key = `(peer, representation)` | Actual: `representation:{workspace}:{session_name}:{observed}` (`work_unit.py:53-56`). Observers list in payload — single LLM call writes into multiple `(observer, observed)` collections at once. | Tier 6.2 work-unit key updated. |
| 3-AND dream gate | Actually 4-AND: 4th implicit "no dream already pending for this collection" (`dream_scheduler.py:310-327`). Only `level=='explicit'` documents count toward 50-threshold. | Tier 4.5 and Tier 6.3 dream gates note the 4th condition. |
| `peer.chat` 5 reasoning levels | Verified `minimal|low|medium|high|max`. Per-level `MAX_TOOL_ITERATIONS`: 1 / 2 / 4 / 5 / 10. | No change. |
| Dialectic uses 7 tools | Verified `DIALECTIC_TOOLS` at `agent_tools.py:712-721`: `search_memory, search_messages, get_observation_context, grep_messages, get_messages_by_date_range, search_messages_temporal, get_reasoning_chain`. Plus `DIALECTIC_TOOLS_MINIMAL` (`:725-728`) — just 2 tools for `minimal` level. | Tier 6.1 uses tools approach for `medium/high/max`; structured for `minimal/low`. Match this exactly. |

**New Honcho primitives not in plan**:

1. **Geometric surprisal sampling for "what to dream about"** (`src/dreamer/surprisal.py` + `src/dreamer/trees/`, ~492 LOC). **7 tree strategies** via factory at `trees/__init__.py:17`: CoverTree, RPTree, LSH, KDTree, BallTree, Prototype, Graph. Higher surprisal = embedding distance further from tree-resident neighbors → fed as "hints" to specialists. **Single highest-leverage primitive the plan missed.** Existing `surprisal.ts` / `surprisal-tree.ts` in CLEO (§16.A) — confirm 7-strategy parity.
2. **`get_reasoning_chain` tool** (`agent_tools.py:689-708`) — traverses premises↔conclusions DAG via `Document.source_ids`. Makes synthesis output **auditable**. Tier 6.1 dialectic should expose this.
3. **`extract_preferences` first-class dreamer tool** (`:1102-1146`) — batch-embeds candidate preferences and dedupes via vector similarity before writing. Solves memory churn.
4. **Queue-based ingestion with single-claim concurrency** (`src/deriver/queue_manager.py`, 876 LOC) — `ActiveQueueSession` ensures only one worker owns a work-unit-key at a time. `WorkerOwnership` registry + `STALE_SESSION_TIMEOUT_MINUTES=5` cleanup. Clean PostgreSQL-only durable-queue pattern. **Tier 6.2 deriver-queue should adopt this exact pattern** (SQLite equivalent: SKIP-LOCKED txn + heartbeat).
5. **Reconciler service** (`src/reconciler/{sync_vectors,queue_cleanup,scheduler}`) — vector sync state decoupled: write doc → mark `sync_state: VectorSyncState='pending'` → reconciler asynchronously embeds. **Resilient to embedder downtime.** Tier 6.4 reconciler should adopt the same decoupled-embedding pattern.
6. **`times_derived` counter on Document** (`models.py:389-391`) — tracks how often an observation has been re-derived. "Stability via repetition" signal. Add to `brain_observations`.
7. **Hierarchical configuration resolution** (`src/utils/config_helpers.py`) — Workspace > Session > Message-level resolved configuration with explicit `Resolved*` types. Avoids per-call parameter explosion. Apply to CLEO's `project-context.json` → `session-context` → `task-context` cascade.
8. **`MessageEmbedding` separate sibling table** (`models.py:277`) — embeddings live in sibling table, not on Message. Re-embed at different dimensions/providers without touching message rows. Adopt for `brain_observations`.
9. **Queue-empty webhook** (`src/webhooks/events.py:26` — `WebhookEventType.QUEUE_EMPTY`) — external systems get notified when deriver queue drains. Natural cue for "memory is current, safe to query." Surface as `cleo memory status --watch` event.
10. **`finish_consolidation` sentinel tool** (`agent_tools.py:668`) — dreamer agent explicitly signals "I'm done" rather than running to iteration cap. Avoids wasted LLM cycles.
11. **Honcho ships an MCP server** (`/mcp/` Bun + TypeScript + Wrangler on Cloudflare Workers). CLEO could connect to it directly rather than reimplementing. Open question: do we want a CLEO MCP server too? (See §10 open questions.)

**Architectural surprises worth noting**:
- Dreams are pre-scheduled `asyncio.Task`s in `pending_dreams: dict[str, asyncio.Task]`. **Not persisted across process restarts.** If CLEO wants durable dream scheduling (which we do, given daemon-died-21-days experience), we must re-derive pending dreams from queue state on startup.
- Token-threshold batching, not time-batching. Short bursty sessions may delay memory formation until `FLUSH_ENABLED` or explicit flush. Implication for CLEO: idle-flush sentinel.
- Peer card and reasoning are coupled — "if reasoning is disabled, peer cards will also be disabled." Single kill-switch for memory features.

### 16.H — Mastra Observational Memory (94.87% LongMemEval SOTA)

`mastra-ai/mastra` (Elastic-2.0). Adds a **new Tier 11** (below).

- **Observer + Reflector** runs *between* turns, not inside the agent loop. Observer writes dated, priority-tagged observations per turn; Reflector restructures + condenses when observations cross a token threshold.
- **Two-block context**: Block 1 = stable cacheable Reflections + Observations prefix; Block 2 = volatile recent raw messages. **Stable prefix → high prompt-cache hit rate → 4-10× cost reduction**.
- **Three-date model** per observation: observation date, referenced date, relative date — drives temporal-reasoning gains.
- **Traffic-light priority** 🔴🟡🟢 — 1-token importance encoding the LLM reads natively.

**Direct port to CLEO**:
- Restructure spawn prompts to: `<stable: CLEO-INJECTION + project context + observation prefix>` ||| `<volatile: task instructions + recent conduit messages>`.
- Wire prompt-caching boundary so Anthropic prompt-cache kicks in.
- Add `priority: P0|P1|P2` to BRAIN observations (already exists at task level — reuse).
- Add observation_date / referenced_date / relative_date triplet (Tier 5.1 absorbs).

### 16.I — LangMem typed memory + debounced reflection

`langchain-ai/langmem` (MIT). Adds two ideas not in plan:

- **Three memory types** (replaces our untyped observation default):
  - **Collections** — `enable_inserts=True`, unbounded (maps to today's `brain_observations`)
  - **Profiles** — Pydantic schemas, update-in-place (maps to `SigilCard` + `brain_peers`)
  - **Episodes** — successful trajectories as **few-shot exemplars** (**CLEO has zero of this today**)
- **`ReflectionExecutor`** — debounced, delayed background reflection so writes coalesce while user is active. CLEO's sentient tick is currently pure cron; should debounce on activity instead.
- **Namespace templating** — `namespace=("memories", "{user_id}")` resolved at runtime. `{worktreeId}`, `{taskId}`, `{epicId}` give clean multi-tenant memory boundaries for parallel-orchestrator world.

**Action**: NEW Tier 12 below adds Episodes as a memory type + debounced reflection executor.

### 16.J — MemGPT (paper-accurate, arXiv 2310.08560)

Letta's lineage. Adds two primitives not in plan:

- **Heartbeat keyword on tool calls** — `request_heartbeat=true` as a keyword arg on any tool call → executor immediately re-invokes the model with the tool result. Enables multi-step retrieval chains off a single user input. CLEO's tool-loop today has no equivalent.
- **FIFO + recursive summary under context-pressure** — when prompt > 70% of context, oldest messages roll into a recursive summary. CLEO has no autonomous compaction today; pairs with Mastra Reflector.

**Action**: extend envelope `meta` schema (`packages/contracts/src/envelope.ts`) with `requestHeartbeat?: boolean`. In `packages/core/src/llm/tool-loop.ts` (already on this branch's git status), when a tool result returns `meta.requestHeartbeat`, re-enter loop without yielding. Bound by `maxHeartbeats: 10` per turn (MemGPT default).

### 16.K — A-Mem (NeurIPS 2025, MIT)

`agiresearch/A-mem` + `WujiangXu/A-mem`. arXiv 2502.12110. Adds three primitives:

- **LLM-generated edges** (not just kNN) — for high-leverage BRAIN nodes (decisions, ADRs), an LLM-emitted relationship is worth the token. CLEO's nexus today builds edges structurally.
- **Memory evolution on ingest** — new notes can trigger LLM updates to existing notes' **context/attributes** (not the fact). Solves staleness without supersession.
- **Atomicity rule** — one self-contained unit per note. CLEO observations today are often multi-fact paragraphs; splitting improves recall precision.

**Action**: on `cleo memory observe`, after the verdict pass (Tier 4), run a kNN + LLM-edge pass that may emit `update-description` ops on neighbors. Cap at 3 neighbors per ingest. Add `linkedNodes: {id, kind, reason}[]` field to BRAIN nodes.

---

## 17. New Tiers added by research-pass-2

### TIER 11 — Memory Provider Plugin Substrate (Hermes-Agent pattern)

Refactor `packages/core/src/memory/` to expose a `MemoryProvider` ABC with `sync_turn / prefetch / shutdown / post_setup` lifecycle methods. BRAIN, NEXUS, and future llmtxt-core all implement it. **CLEO becomes provider-agnostic at the memory layer.** This makes the system future-proof against swapping in Honcho, Letta, Mem0, or any other memory backend as a drop-in.

**Files**: `packages/core/src/memory/provider.ts` (ABC), `packages/core/src/memory/providers/{brain,nexus,llmtxt}.ts` (implementations).

**Acceptance**: an integration test instantiates two providers (brain + a mock alternate) and verifies that `cleo memory observe` writes to both via the ABC.

### TIER 12 — Mastra-Style Pre-Composed Context (prompt cache discipline)

Restructure spawn prompts into a stable cacheable prefix + volatile suffix. Wire Anthropic prompt-caching markers. Add Observer/Reflector pair to the sentient daemon. Add `priority: P0|P1|P2` + traffic-light render + 3-date model to `brain_observations`.

**Expected impact**: 4-10× cost reduction on agent spawns; pairs with curator auxiliary-client rule (§16.B) so Tier-1 daemon work doesn't invalidate the operator's main cache.

**Files**: `packages/core/src/orchestrate/prompt-prefix-builder.ts` (NEW), edit `composeSpawnForTask` (`spawn-ops.ts`), `packages/core/src/sentient/observer.ts` + `reflector.ts` (NEW).

### TIER 13 — Episodes (LangMem) + LLM-edges + A-Mem evolution

Add a third memory type beyond Collections (observations) and Profiles (peer cards): **Episodes** — completed task trajectories stored as few-shot exemplars. On task completion, distill `{task, plan, outcome, surprise}` into `brain_episodes`. Spawn-time retrieval injects matching episodes as `## Prior Successful Approaches` ahead of `## Prior Context (from BRAIN)`.

Couple with **A-Mem LLM-edge generation** (kNN + LLM emits `update-description` on neighbors) and **MemGPT heartbeat** for chain-step retrieval.

**Files**: `packages/core/src/memory/episodes.ts`, migration for `brain_episodes`, extend `verifyAndStore` to emit memory-evolution ops, extend envelope `meta` with `requestHeartbeat`.

### TIER 14 — Honcho MCP Front-End vs. Native (deferred decision)

Honcho already ships an MCP server (`/mcp/` Bun + TS + Wrangler). Open question (§10.9): do we connect to it directly OR build our own MCP server for BRAIN? Deferred until Tier 11 MemoryProvider ABC lands — at that point, Honcho-as-provider becomes a viable A/B comparison.

---

## 18. Revised wave plan (incorporating new Tiers)

Drop new Tiers into the existing wave plan:

| Wave | Original tiers | Added in research-pass-2 |
|---|---|---|
| W0 — Schema lock-in | unchanged | — |
| W1 — Trust funnel | unchanged | + Hermes prompt-cache hygiene rule (auxiliary-client) baked into daemon resilience |
| W2 — Auto-extract repair | unchanged | + Mem0 V3 verdict envelope shipped as the funnel contract |
| W3 — Identity core | + Letta v2 tool family (memory_apply_patch + headers) | + Letta optimistic-lock + monotonic history chain |
| W4 — Four-bus integration | unchanged | + Mastra two-block prompt prefix (Tier 12) lands here |
| W5 — PSYCHE pipeline | reframed as "harden + complete" (only `derivation-queue.ts` is new) | + Honcho ActiveQueueSession + WorkerOwnership pattern, `get_reasoning_chain`, `finish_consolidation`, `times_derived`, queue-empty webhook |
| W6 — Continuous living | unchanged | + Letta MemFS clarification (NOT worktree); + LangMem ReflectionExecutor debouncing |
| W7 — Sentient Tier-2 | unchanged | + Hermes Curator pattern as the supervisor template |
| W8 — CANT evolution | unchanged | + LangMem Episodes type (Tier 13) |
| W9 — Conduit A2A | unchanged | — |
| **W10 — Memory Provider Substrate** | NEW | Tier 11 MemoryProvider ABC + plugin loaders |
| **W11 — Mastra Prefix + Observer/Reflector** | NEW | Tier 12 |
| **W12 — Episodes + LLM-edges + Heartbeat** | NEW | Tier 13 |
| W∞ — Promote CI gate | unchanged | — |

---

## 19. Verification artefacts (research-pass-2)

Four parallel research agents ran on 2026-05-15. Their full reports are preserved in the conversation transcript that produced this plan. The most important file-path-level citations have been inlined into §16 above. When task execution begins on any Tier, re-running the corresponding research stream (or reading the four GitHub repos directly at the pinned commits below) is recommended:

- **Letta**: `letta-ai/letta` @ commit `1131535` (2026-05-14)
- **Honcho V3**: `plastic-labs/honcho` @ `main` HEAD (2026-05-15)
- **Hermes-Agent**: `NousResearch/hermes-agent` @ `main` (v0.13.x as of 2026-05)
- **Mem0**: `mem0ai/mem0` @ `main` HEAD (prompts.py L15, L176, L468)
- **Graphiti**: `getzep/graphiti` @ `main` HEAD (edges.py L263)
- **Hindsight**: arXiv 2512.12818 (Dec 2025, MIT)
- **Mastra**: `mastra-ai/mastra` Observational Memory research (Elastic-2.0)
- **LangMem**: `langchain-ai/langmem` @ `main` HEAD
- **MemGPT**: arXiv 2310.08560 (canonical paper)
- **A-Mem**: `agiresearch/A-mem` + `WujiangXu/A-mem` (arXiv 2502.12110, MIT)

**This plan is now grounded in source-verified facts from both internal codebase audit and external system reads at commit-level granularity. The §16 corrections reflect direct file:line evidence; the §17 new Tiers reflect verified primitives ready to port.**
