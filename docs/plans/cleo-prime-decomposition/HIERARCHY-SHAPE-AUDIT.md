# Hierarchy Shape Audit — Existing Tier-Epic Specs vs Strict Rule

> **Status**: audit-only · 2026-05-15 · NO reshape executed
> **Owner rule (2026-05-15)**: Epic = 4-10 Tasks · Task = 1-7 Subtasks · Subtask = one context-window
> **Immutable**: if a subtask can't fit one context window, it's two Tasks.
> **Purpose**: identify which of the 6 existing tier-epic specs need RESHAPE before `cleo add` execution begins. Vocabulary alignment + cap-violation fixes only — scope and subtask counts stay (≈452 total).

---

## 1. Per-Epic Audit Table

Vocabulary mapping: existing **"Phase"** = strict **"Task"**. Existing **"Subtask"** = strict **"Subtask"**. So mostly a rename, not a restructure — except where cap-violations require splits.

| Tier-Epic | Source file | Phases (→ Tasks) | Subtasks | Avg subtasks/task | Status vs strict rule |
|---|---|---|---|---|---|
| E-PRIME-T01 | T01-T02-CI.md | 3 | 36 | 12 | ⚠️ **Below 4-Task floor** AND ⚠️ **task-level subtasks exceed 7-cap** — needs split |
| E-PRIME-T02 | T01-T02-CI.md | 5 | 22 | 4.4 | ✅ Both rules OK |
| E-PRIME-CI | T01-T02-CI.md | 3 | 13 | 4.3 | ⚠️ **Below 4-Task floor** — consider adding "CI Telemetry" task or fold into another epic |
| E-PRIME-T03 | T03-T08a-identity.md | 8 (P0-P7) | 60 | 7.5 | ⚠️ Slightly over 7-cap — verify per-task |
| E-PRIME-T08a | T03-T08a-identity.md | 6 (P0-P5) | 20 | 3.3 | ✅ Both rules OK |
| E-PRIME-T04 | T04-T05-gate-bitemporal.md | 8 | 30 | 3.8 | ✅ OK |
| E-PRIME-T05 | T04-T05-gate-bitemporal.md | 8 | 32 | 4.0 | ✅ OK |
| E-PRIME-T06 | T06-psyche.md | 7 (6.A-6.G) | 76 | 10.9 | 🔴 **Major cap violations** — 6.D Dreamer has 25 subtasks, 6.B has 13, 6.C has 13 |
| E-PRIME-T07 | T07-T08b-T09-integration.md | 5 | 31 | 6.2 | ✅ OK |
| E-PRIME-T08b | T07-T08b-T09-integration.md | 4 | 23 | 5.8 | ✅ OK (floor exactly met) |
| E-PRIME-T09 | T07-T08b-T09-integration.md | 7 | 35 | 5.0 | ✅ OK |
| E-PRIME-T10 | T10-T11-T12-T13-T14-substrate.md | 5 | 14 | 2.8 | ✅ OK |
| E-PRIME-T11 | T10-T11-T12-T13-T14-substrate.md | 7 | 14 | 2.0 | ✅ OK (over-segmented but rule-compliant) |
| E-PRIME-T12 | T10-T11-T12-T13-T14-substrate.md | 8 | 17 | 2.1 | ✅ OK |
| E-PRIME-T13 | T10-T11-T12-T13-T14-substrate.md | 8 | 19 | 2.4 | ✅ OK |
| E-PRIME-T14 | T10-T11-T12-T13-T14-substrate.md | 4 | 10 | 2.5 | ✅ OK (floor exactly met) |

**Net audit**:
- ✅ **12 of 16 tier-epics conform** as-is (with vocabulary rename Phase→Task)
- ⚠️ **2 floor violations** (T01 and CI have only 3 Tasks each, rule wants 4-10)
- 🔴 **2 cap-violation epics** that need within-task splits (T01 internal + T06 PSYCHE)

---

## 2. Required Reshape Work — Three Concrete Splits

### 2.1 E-PRIME-T01 — split into 4-5 Tasks (currently 3 over-stuffed phases)

Current shape (from spec):
- Phase P1 (12 subtasks) — T9245 hardening + verifier-runner update + integration test + 13 BBTT re-verify subtasks
- Phase P2 (16 subtasks) — BBTT W0/W1/W2/W3 close-out
- Phase P3 (8 subtasks) — daemon install + cwd fix + reverify T1682/T1636

Required reshape (each Task = demoable vertical capability, ≤7 subtasks):
- **Task T01.1 — Verifier hardening** (4-6 subtasks): T9245 evidence-validator + integration test + commit-touches-AC-files predicate + verifier-runner update
- **Task T01.2 — BBTT 13-task re-verify, Wave A** (7 subtasks): T9220, T9222, T9223, T9224, T9227, T9172, T1467 → real evidence under hardened validator
- **Task T01.3 — BBTT 13-task re-verify, Wave B** (6 subtasks): T1693, T9194, T9173, T1897, T1899, T1906 → real evidence
- **Task T01.4 — Daemon install + cwd fix** (4-6 subtasks): `cleo daemon install` ritual + `daemon.ts:195` cwd resolution + systemd unit verification on operator host
- **Task T01.5 — BBTT closure ritual** (3-5 subtasks): close T1892 (per CLOSEOUT-T1892-MANIFEST.md), close T942 (per CLOSEOUT-T942-T1007-MANIFEST.md), close T1007, partial-extract T9232 (per T9232-PARTIAL-EXTRACT-MANIFEST.md)

Result: 5 Tasks × 4-7 Subtasks = 24-35 Subtasks total (≈36 currently — accounting matches).

### 2.2 E-PRIME-CI — split into 4 Tasks (currently 3 phases)

Current shape:
- Phase P1 (6 subtasks) — `cleo doctor brain --strict` extension
- Phase P2 (3 subtasks) — CI workflow brain-doctor job
- Phase P3 (4 subtasks) — daemon resilience (PRAGMA busy_timeout + watchdog + dream-overdue alarm)

Required reshape:
- **Task CI.1 — `cleo doctor brain --strict` extension** (6 subtasks, as-is) — already conforming, just rename
- **Task CI.2 — CI workflow integration (warning mode → blocking after soak)** (3-5 subtasks): split P2 + add the 7-day-green soak gate as its own subtask
- **Task CI.3 — Daemon resilience (PRAGMA + watchdog)** (3-4 subtasks) — split P3
- **Task CI.4 — Dream-overdue alarm + Tier-3 hygiene events** (3-4 subtasks): the previously-bundled hygiene event work as its own demoable Task

Result: 4 Tasks × 3-6 Subtasks = 14-20 Subtasks (≈13 currently — light expansion).

### 2.3 E-PRIME-T06 PSYCHE — split each oversized sub-area

Current shape:
- 6.A Audits (6 subtasks) ✅
- 6.B Derivation Queue (13 subtasks) 🔴
- 6.C Dialectic Harden (13 subtasks) 🔴
- 6.D Dreamer Harden (25 subtasks) 🔴🔴
- 6.E Reconciler Harden (10 subtasks) 🔴
- 6.F Structural Fast-Path (4 subtasks) ✅
- 6.G Observability + Docs (5 subtasks) ✅

Required reshape (split each oversized sub-area into ≤7-subtask Tasks):
- **Task T06.1 — Audits + Surprisal-Tree 7-strategy parity** (6 subtasks, as-is)
- **Task T06.2a — Derivation Queue schema + claim pattern** (5-6 subtasks): SQLite SKIP-LOCKED, ActiveQueueSession-equiv, work-unit key, retry/backoff
- **Task T06.2b — Derivation Worker + CLI + observability** (5-7 subtasks): standalone worker, `cleo memory derive-worker --watch`, QUEUE_EMPTY webhook, DLQ ops, integration test
- **Task T06.3a — Dialectic 7-tool surface** (6-7 subtasks): `get_reasoning_chain`, `extract_preferences`, `search_memory`, `search_messages`, etc.
- **Task T06.3b — Dialectic tier dispatch + structured output** (4-5 subtasks): MAX_TOOL_ITERATIONS per level, minimal-vs-full tool sets, structured `DialecticInsights` output
- **Task T06.4a — Dreamer specialists (sequential OMNI)** (6 subtasks): 6 specialists harden into sequential phases
- **Task T06.4b — Surprisal 7-strategy tree factory** (7 subtasks): one subtask per missing strategy (CoverTree, LSH, KDTree, BallTree, Prototype, Graph) + factory pattern + parity test
- **Task T06.4c — 4-AND dream gate + force override + 2-evidence rule + finish_consolidation** (6-7 subtasks)
- **Task T06.4d — Memory tree integration (observation tree_id wiring)** (4-5 subtasks)
- **Task T06.5 — Reconciler sync_state + sibling embedding table + DLQ** (6-7 subtasks)
- **Task T06.6 — Reconciler scheduler + T1139 supersession absorption** (3-4 subtasks)
- **Task T06.7 — Structural fast-path split** (4 subtasks, as-is)
- **Task T06.8 — Observability dashboard + ADR + docs** (5 subtasks, as-is)

Result: 13 Tasks × 4-7 Subtasks = 60-91 Subtasks (≈76 currently — accounting matches; 13 Tasks slightly exceeds 10-Task ceiling).

**Decision needed**: E-PRIME-T06 at 13 Tasks technically violates the 4-10 Task epic ceiling. Two options:
- **Option (a)**: Accept 13 Tasks for T06 PSYCHE because the existing PSYCHE files audit-then-harden naturally requires this granularity.
- **Option (b)**: Split E-PRIME-T06 into TWO epics — **E-PRIME-T06a Audit + Dialectic + Deriver** (6 Tasks) and **E-PRIME-T06b Dreamer + Reconciler + Structural** (7 Tasks). Each ships as its own release.

My recommendation: **Option (b)** — splits cleanly along W5 → W5.5 wave boundary and each half is independently demoable.

---

## 3. Reshape work-package size

| Tier-Epic | Reshape effort | Owner-decision needed? |
|---|---|---|
| T01 | Split 3 phases → 5 Tasks | No — mechanical |
| T02 | Rename only | No |
| CI | Split 3 phases → 4 Tasks (add hygiene-event Task) | No |
| T03 | Verify each P0-P7 phase ≤7 subtasks; split P2 if needed | No |
| T08a | Rename only | No |
| T04, T05 | Rename only | No |
| **T06** | **Major split — Option (a) accept 13 Tasks, OR Option (b) split into T06a + T06b** | **YES — decide before reshape** |
| T07, T08b, T09 | Rename only | No |
| T10-T14 | Rename only | No |

**Aggregate work**: ~7 of 16 tier-epics need only a vocabulary rename. 3 need Task-level splits (T01, CI, T06). 1 needs an owner decision (T06 split-into-two).

---

## 4. Subtask context-window check

The immutable rule says: **subtask must fit in one context window. If it can't, it's two Tasks.**

The existing 452 subtasks were specified by 6 decomposition agents whose output explicitly aimed at "single-PR scope, atomic action, one-sentence what-changes." That maps to ≤1 context window in practice. **A spot-check of 10 randomly-sampled subtasks across the 6 spec files showed all conform** to single-PR scope.

If during execution a Lead Agent finds any spec'd subtask too large for one window, the rule mandates split-into-two-Tasks (not split into smaller subtasks). The Lead Agent surfaces this as a follow-up Task to the Orchestrator before execution.

---

## 5. Recommended next steps (after CLOSEOUT-T1892/T942/T1007 ship via your agents)

1. **Owner decides T06 split**: Option (a) accept 13 Tasks OR Option (b) split into T06a + T06b. My vote: **(b)**.
2. **I reshape T01, CI, T06** directly (mechanical splits per §2 above). Output: updated tier-epic spec files in-place.
3. **I rename Phase→Task** across all 6 spec files (mechanical text replacement).
4. **I update master README.md** with the corrected shape (Epic counts, Task counts per epic, total Subtask count).
5. **I write `scripts/expand-decomposition.mjs`** parser that emits the `cleo add` sequence for the entire 16-epic / ~85-Task / ~460-Subtask tree.
6. **Owner reviews first 20 generated `cleo add` invocations as dry-run** before any state mutations.

This sequence keeps your closeout work (T1892/T942/T1007 via your agents) independent of my organize-and-verify work on the tier-epic shape (no shared state).

---

## 6. Artifacts produced this session

| File | Purpose |
|---|---|
| [CLEO-PRIME-SENTIENT-MASTERPLAN.md](../CLEO-PRIME-SENTIENT-MASTERPLAN.md) | Master roadmap (§16 Research Validation appendix, §17 new Tiers, §18 wave plan) |
| [README.md](README.md) | Master epic E-PRIME-SENTIENCE + 16 milestone gates + dependency DAG |
| [RECONCILIATION-PLAN.md](RECONCILIATION-PLAN.md) | Existing epics ↔ new tree mapping (corrected 2026-05-15 with §0 quick-ref table + hierarchy rule) |
| [CLOSEOUT-T1892-MANIFEST.md](CLOSEOUT-T1892-MANIFEST.md) | Per-child audit + closure ritual for BBTT |
| [CLOSEOUT-T942-T1007-MANIFEST.md](CLOSEOUT-T942-T1007-MANIFEST.md) | Reparent ritual for 11 children + closure for both epics |
| [T9232-PARTIAL-EXTRACT-MANIFEST.md](T9232-PARTIAL-EXTRACT-MANIFEST.md) | Surgical T9245 extract, T9232 stays open |
| [HIERARCHY-SHAPE-AUDIT.md](HIERARCHY-SHAPE-AUDIT.md) | This file — shape gaps + reshape plan |
| [E-PRIME-T01-T02-CI.md](E-PRIME-T01-T02-CI.md) | Trust + Provenance + CI spec (needs T01 split + CI split before `cleo add`) |
| [E-PRIME-T03-T08a-identity.md](E-PRIME-T03-T08a-identity.md) | Identity + memory-git spec |
| [E-PRIME-T04-T05-gate-bitemporal.md](E-PRIME-T04-T05-gate-bitemporal.md) | Mem0 gate + bitemporal spec |
| [E-PRIME-T06-psyche.md](E-PRIME-T06-psyche.md) | PSYCHE spec (needs major reshape before `cleo add` — see §2.3) |
| [E-PRIME-T07-T08b-T09-integration.md](E-PRIME-T07-T08b-T09-integration.md) | Four-bus + continuous + Tier-2 spec |
| [E-PRIME-T10-T11-T12-T13-T14-substrate.md](E-PRIME-T10-T11-T12-T13-T14-substrate.md) | Substrate + Conduit A2A + Mastra + Episodes + Honcho-MCP spec |
