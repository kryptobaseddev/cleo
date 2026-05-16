# Reconciliation Plan — E-PRIME-SENTIENCE ↔ Existing Epics

> **Status**: planning · DRAFT · 2026-05-15 · NO `cleo update` invocations yet
> **Goal**: One coherent tree. Zero work lost. Zero duplicate trees. Done work stays done.
> **Approach**: Absorb the pending children that ARE the new work; defer Tier-3 sandbox children to T-SANDBOX; keep adjacent epics parallel with `relates` links.

---

## 0. Per-Epic Action Summary (Quick Reference)

| Existing Epic | Status | Action | Manifest |
|---|---|---|---|
| **T1892** BBTT BRAIN/Briefing Trust | pending | **CLOSE-AS-SUPERSEDED** (3 reopened reparent to E-PRIME-T02, 14 done audit-then-historical) | [CLOSEOUT-T1892-MANIFEST.md](CLOSEOUT-T1892-MANIFEST.md) |
| **T942** Sentient CLEO Architecture Redesign | pending | **CLOSE-AS-SUPERSEDED** (all 8 children → T-SANDBOX) | [CLOSEOUT-T942-T1007-MANIFEST.md](CLOSEOUT-T942-T1007-MANIFEST.md) |
| **T1007** Sentient Loop Completion | pending | **CLOSE-AS-SUPERSEDED** (T1644+T1646 → E-PRIME-T09, T1645 → T-SANDBOX) | [CLOSEOUT-T942-T1007-MANIFEST.md](CLOSEOUT-T942-T1007-MANIFEST.md) |
| **T9232** 8-Phase Optimization Campaign | pending | **KEEP OPEN — PARTIAL EXTRACT** (T9245 → E-PRIME-T01 only; T9238/T9239 stay; T9233-T9237 done) | [T9232-PARTIAL-EXTRACT-MANIFEST.md](T9232-PARTIAL-EXTRACT-MANIFEST.md) |
| **T631** Cleo Prime Persona Bulldog AGI | pending | **KEEP PARALLEL** + `relates: E-PRIME-SENTIENCE` | (cross-link only, no manifest) |
| **T1737** CleoOS Sentient Harness v3 | pending | **KEEP PARALLEL** + selective `relates` on 4 children | (cross-link only, no manifest) |

**Hierarchy rule** (owner-set 2026-05-15, applies to ALL new tasks below):
- **Epic** = one shippable version (4-10 Tasks) — monitored by Orchestrator Prime
- **Task** = one demoable vertical capability (1-7 Subtasks) — monitored by Lead Agent
- **Subtask** = one context-window-sized unit of work (atomic / ephemeral worker)
- **Immutable rule**: if a subtask can't fit in one context window, it's two Tasks (not one bigger subtask).

---

## 1. Inventory — existing related epics (verified 2026-05-15 via `cleo show` + `cleo list --parent`)

### 1.1 T1892 — BBTT BRAIN/Briefing Trust (pending epic)

17 children. 14 done, 3 reopened.

| Child | Status | Maps to | Action |
|---|---|---|---|
| T1893 W0-1 relatedDocs gating | done | E-PRIME-T01 historical | KEEP DONE, historical context |
| T1894 W0-2 fixture epic heuristic | done | E-PRIME-T02 (superseded by W3-1) | KEEP DONE, mark as wedge superseded by T1899 |
| T1895 W2-1 `cleo memory dream --status` | done | E-PRIME-T01.P3 daemon liveness | KEEP DONE, references in T01 |
| T1896 W1-2 pattern dedup | done | E-PRIME-T02 promotion ratio | KEEP DONE |
| **T1897 W3-2 brain_observations provenance** | **pending** (reopened, blocked by T9245) | **E-PRIME-T02.P1.S2** origin/validated_at/provenance_chain migration | **REPARENT under E-PRIME-T02** |
| T1898 W2-0 daemon dead diagnosis | done | E-PRIME-T01.P3 prereq | KEEP DONE |
| **T1899 W3-1 tasks origin column** | **pending** (reopened, blocked by T9245) | **E-PRIME-T02.P1.S3** tasks origin migration | **REPARENT under E-PRIME-T02** |
| T1900 W1-1 recency mode | done | E-PRIME-T02.P5 (regression-test only) | KEEP DONE, plan §2.5 already marks as shipped |
| T1901 W2-2 sentient tick diagnosis | done | E-PRIME-T01.P3 prereq | KEEP DONE |
| T1902 W5-1 per-worktree handoff ADR | done | E-PRIME-T03.P5 reference | KEEP DONE, link from T03 |
| T1903 W3-5 auto-extract repair | done | E-PRIME-T02.P4 prereq | KEEP DONE, audit-only in T02 |
| T1904 W2-3 opportunistic dream trigger | done | E-PRIME-T01.P3 | KEEP DONE |
| T1905 W1-3 BriefingFieldContract types | done | E-PRIME-T02 | KEEP DONE |
| **T1906 W3-4 Test-DB isolation enforcement** | **pending** (reopened) | **E-PRIME-T02.P3.S** test-fixture quarantine | **REPARENT under E-PRIME-T02** |
| T1907 W2-5 freshness sentinel CI gate | done | E-PRIME-CI | KEEP DONE, reference in CI |
| T1908 W2-4 `cleo doctor brain` CLI | done | E-PRIME-CI.P1 prereq | KEEP DONE, extension under CI epic |
| T1909 W3-3 scan-test-fixtures-in-prod | done | E-PRIME-T02 | KEEP DONE |

**Action on T1892 (epic itself)**: After T1897, T1899, T1906 are reparented and re-verified with real evidence under E-PRIME-T01/T02, **close T1892 with `cleo complete` + a final attestation note linking to E-PRIME-SENTIENCE**. The 14 done children remain historical record under their original IDs.

### 1.2 T9245 — validateCommit loophole (pending bug)

- Parent: T9232 (8-Phase Optimization Campaign master)
- Status: pending, P0
- Maps to: **E-PRIME-T01.P1.S1** (the load-bearing first subtask)

**Action**: **REPARENT under E-PRIME-T01**. Add `relates: T9232` to preserve T9232 traceability. T9232 epic continues with its other children unaffected.

### 1.3 T942 — Sentient CLEO Architecture Redesign (pending epic)

8 children, all pending, all Tier-3 sandbox infrastructure.

| Child | Title slice | Action |
|---|---|---|
| T946 | Autonomous self-improving loop Tier1/2/3 + Ed25519 + sandbox | **REPARENT under T-SANDBOX** |
| T1010 | Tier 3 externally-anchored baseline + signed audit | **REPARENT under T-SANDBOX** |
| T1011 | Tier 3 FF-only merge with abort-on-fail + kill-switch | **REPARENT under T-SANDBOX** |
| T1012 | `cleo revert --from <receiptId>` audit chain walker | **REPARENT under T-SANDBOX** |
| T1029 | abort-to-clean-state protocol | **REPARENT under T-SANDBOX** |
| T1030 | full merge ritual orchestrator (10-step flow) | **REPARENT under T-SANDBOX** |
| T1032 | merge ritual integration test | **REPARENT under T-SANDBOX** |
| T1074 | Complete Tier-3 sentient state-pause subsystem | **REPARENT under T-SANDBOX** |

**Action on T942 (epic itself)**: After all 8 children reparented, **close T942 with `cleo complete` + attestation note linking to T-SANDBOX**. T-SANDBOX becomes the canonical home for Tier-3 sandbox work.

### 1.4 T1007 — Sentient Loop Completion (pending epic)

3 children, all pending.

| Child | Title slice | Action |
|---|---|---|
| **T1644** | Tier-2 proposal generation: BRAIN-pattern-driven proposals + owner approval gate | **REPARENT under E-PRIME-T09** (P1.S1 detector wiring) |
| T1645 | Tier-3 sandbox auto-merge with Ed25519 receipt chain + metricsImproved gate | **REPARENT under T-SANDBOX** |
| **T1646** | Integration tests for full Tier 1/2/3 sentient daemon lifecycle | **REPARENT under E-PRIME-T09** (P2.S* daemon-lifecycle tests) |

**Action on T1007 (epic itself)**: After children reparented, **close T1007** with attestation note linking children to their new parents.

### 1.5 T631 — Cleo Prime Orchestrator Persona — Bulldog AGI (pending epic)

3 children, all pending. Persona portability work — adjacent but distinct from peer-graph infrastructure.

| Child | Title slice | Action |
|---|---|---|
| T1638 | Extract orchestrator protocol to .cant template | KEEP under T631, add `relates: E-PRIME-T03` |
| T1639 | Project-agnostic harness detection | KEEP under T631 (harness concern) |
| T1640 | Document cleo-prime portability contract | KEEP under T631 |

**Action on T631 (epic itself)**: **KEEP open as parallel epic**. Add `relates: E-PRIME-SENTIENCE` on T631 root. Both epics ship in parallel — T631 produces the `.cant` template file; E-PRIME-T03 produces the database peer-graph that materializes the persona. They feed each other.

### 1.6 T1737 — CleoOS Sentient Harness v3 — Full Native Stack Replacement (pending epic)

52 children. Most are runtime/tool extensions to core SDK (Hermes-derived). Adjacent to E-PRIME-SENTIENCE but distinct scope (runtime stack vs sentience layer).

| Child sampling | Status | Cross-link |
|---|---|---|
| T1738 Design CleoOS harness architecture | pending | reference for E-PRIME-T11 substrate work |
| T1739 Agent-facing tool registry | pending | `relates: E-PRIME-T11` (provider plugin parallel) |
| T1740 Tool dispatch handlers | pending | independent |
| T1741-T1743 Terminal/file/web/memory/MCP tools | pending | T1743 memory tool may overlap E-PRIME-T03 — add `relates` |
| T1744 LLM retry+failover | pending | independent |
| T1745 Subagent delegation | pending | `relates: E-PRIME-T07` four-bus spawn work |
| T1746 Native MCP client | pending | `relates: E-PRIME-T14` Honcho-MCP decision |
| T1747 Wire Rust CANT parser via napi-rs | pending | independent (CANT plumbing) |
| ...+44 more | mixed | mostly independent runtime work |

**Action on T1737 (epic itself)**: **KEEP open as parallel epic**. Add `relates: E-PRIME-SENTIENCE` at the root. Selectively cross-link individual children where overlap is real (T1743 ↔ E-PRIME-T03, T1745 ↔ E-PRIME-T07, T1746 ↔ E-PRIME-T14, T1739 ↔ E-PRIME-T11). These epics co-evolve — T1737 builds the tool/runtime stack; E-PRIME-SENTIENCE builds the memory/identity layer that lives on top.

---

## 2. Final Tree (after reconciliation)

```
E-PRIME-SENTIENCE (new master epic, P0, large)
├── E-PRIME-T01 — Trust Foundation
│   ├── T9245 ▸ (REPARENTED from T9232) — validateCommit AC-intersection
│   ├── [13 BBTT re-verify subtasks for T9220/T9222/T9223/T9224/T9227/T9172/T1467/T1693/T9194/T9173]
│   └── [daemon liveness subtasks per spec]
├── E-PRIME-T02 — Provenance & Quarantine
│   ├── T1897 ▸ (REPARENTED from T1892) — brain_observations origin/validated_at/provenance_chain
│   ├── T1899 ▸ (REPARENTED from T1892) — tasks origin column
│   ├── T1906 ▸ (REPARENTED from T1892) — test-DB isolation enforcement
│   └── [new T729/T730/T736/T737 auto-extract repair + T1903 promo-log audit + recency regression test]
├── E-PRIME-T03 — Peer-Graph Identity (NEW)
│   └── [60 subtasks: 5 peer tables + 13-col memory_blocks + memory_apply_patch + CANT growth + drift + 4 identity siblings]
├── E-PRIME-T04 — Mem0 Write-Time Extraction Gate (NEW)
│   └── [30 subtasks: verdict envelope + reconcile.ts + funnel 8 writers + AST-grep CI gate]
├── E-PRIME-T05 — Bitemporal + 4-Network Epistemology (NEW)
│   └── [32 subtasks: Graphiti 4-timestamp + Hindsight 4-network + confidence updates + disposition]
├── E-PRIME-T06 — PSYCHE Pipeline (harden + complete + integrate)
│   └── [76 subtasks: 4 audits + derivation queue + 7-strategy tree + reconciler decoupling + structural fast-path]
├── E-PRIME-T07 — Four-Bus Integration (NEW)
│   └── [31 subtasks: spawn-context + nexus brainEvidence + decomp advisor + brain-digest + conduit-ingester]
├── E-PRIME-T08a — Memory-Git Per Peer (NEW)
│   └── [20 subtasks: per-peer git repo + 6 ops + cherry-pick guard + 3 CLI commands]
├── E-PRIME-T08b — Continuous Living (NEW)
│   └── [23 subtasks: idleDreamGate + archiveCompactionTick + skill distillation]
├── E-PRIME-T09 — Sentient Tier-2 + CANT Evolution
│   ├── T1644 ▸ (REPARENTED from T1007) — Tier-2 detector wiring
│   ├── T1646 ▸ (REPARENTED from T1007) — daemon-lifecycle integration tests
│   └── [33 new subtasks: 5 proposal kinds + 4-AND gate + hook events + /reflect + agent-architect + agent-review.cantbook + T1659 op audit]
├── E-PRIME-T10 — Conduit A2A (deferred)
│   └── [14 subtasks: /handoff directive + parser + topic + subscriber + ADR]
├── E-PRIME-T11 — MemoryProvider Plugin Substrate (NEW)
│   └── [14 subtasks: ABC + 3 implementations + registry + dual-write test]
├── E-PRIME-T12 — Mastra Pre-Composed Context (NEW)
│   └── [17 subtasks: prompt-prefix-builder + Observer/Reflector + cache_control + 3-date model + traffic-light priority]
├── E-PRIME-T13 — Episodes + LLM-Edges + Heartbeat (NEW)
│   └── [19 subtasks: brain_episodes + verdict-pass A-Mem edges + envelope heartbeat + tool-loop chain]
├── E-PRIME-T14 — Honcho-MCP-vs-Native Decision (NEW, research-track)
│   └── [10 subtasks: sidecar deploy + A/B vs native + ADR verdict]
└── E-PRIME-CI — CI Trust Gates + Daemon Resilience (NEW, cross-cutting)
    └── [13 subtasks: --strict checks + CI workflow warning→blocking + PRAGMA busy_timeout + watchdog]

T-SANDBOX (new sibling epic, deferred follow-up, P2, large)
├── T946  ▸ (REPARENTED from T942) — Autonomous loop with sandbox
├── T1010 ▸ (REPARENTED from T942) — Externally-anchored baseline
├── T1011 ▸ (REPARENTED from T942) — FF-only merge + kill-switch
├── T1012 ▸ (REPARENTED from T942) — cleo revert --from receiptId
├── T1029 ▸ (REPARENTED from T942) — abort-to-clean-state protocol
├── T1030 ▸ (REPARENTED from T942) — full merge ritual orchestrator
├── T1032 ▸ (REPARENTED from T942) — merge ritual integration test
├── T1074 ▸ (REPARENTED from T942) — state-pause subsystem
└── T1645 ▸ (REPARENTED from T1007) — Tier-3 sandbox auto-merge

T631 — Cleo Prime Orchestrator Persona (PARALLEL, KEEP)
├── T1638 — Extract orchestrator protocol to .cant template  [relates: E-PRIME-T03]
├── T1639 — Project-agnostic harness detection
└── T1640 — Document portability contract

T1737 — CleoOS Sentient Harness v3 (PARALLEL, KEEP — relates: E-PRIME-SENTIENCE)
└── [52 children, selective cross-links to E-PRIME-T03/T07/T11/T14]

T9232 — 8-Phase Optimization Campaign (CONTINUES — T9245 moved out)
└── [remaining children continue]

T1892 — BBTT (CLOSE after 3 reopened children reparented and re-verified)
T942  — Sentient Tier-3 Redesign (CLOSE after all 8 children moved to T-SANDBOX)
T1007 — Sentient Loop Completion (CLOSE after T1644/T1646→T09, T1645→T-SANDBOX)
```

**Net effect**:
- 14 new epics under E-PRIME-SENTIENCE (T01-T14 + CI)
- 1 new sibling epic T-SANDBOX absorbing 9 reparented Tier-3 children
- 6 existing tasks reparented under new tree (T9245, T1897, T1899, T1906, T1644, T1646)
- 3 existing epics closed-as-superseded after reparenting (T1892, T942, T1007)
- 2 existing epics kept parallel with `relates` links (T631, T1737)
- 1 existing epic untouched, continues (T9232)
- Zero done tasks moved (T1893/T1895/T1896/T1898/T1900/T1901/T1902/T1903/T1904/T1905/T1907/T1908/T1909 stay under T1892 as historical record)

---

## 3. Execution Plan — exact CLEO commands

### Phase A — Create new epics (16 epics: master + 14 tiers + 1 sibling)

```bash
# 1. Master epic (no parent — program root)
cleo add --type epic --title "E-PRIME-SENTIENCE — CLEO Prime Sentient Orchestrator with Living Brain" \
  --kind work --severity P0 --size large \
  --acceptance "cleo doctor brain --strict exits 0 for 7 consecutive days | 100% of brain writes via verifyAndStore (AST-grep CI gate green for 7 days) | 0% of brain_observations have origin IS NULL | systemctl --user is-active cleo-daemon = active for 7 consecutive days | Spawned agent prompt contains '# Core Memory' + '# Mental Model — Living Knowledge' + '## Prior Context (from BRAIN)' (regex-asserted) | cleo brain query --at <past-date> returns different row set than --at now | Anthropic prompt-cache hit rate ≥60% on spawn prompts | ≥30% of spawns inject matching episode exemplar | agent-review.cantbook produces refined .cant for cleo-prime (owner-accepted) | All 13 BBTT mis-completed tasks re-verified with real evidence atoms (zero --override on critical gates)"
# → captures master ID e.g. T-XXXX

# 2. 14 Tier-epics + CI (parent = E-PRIME-SENTIENCE)
cleo add --type epic --parent <MASTER> --title "E-PRIME-T01 — Trust Foundation" \
  --kind work --severity P0 --size large \
  --acceptance "T9245 integration test passes (AC-file-A + commit-touches-B fails with E_EVIDENCE_INSUFFICIENT) | All 13 mis-completed tasks re-verified with real evidence (no --override) | systemctl --user is-active cleo-daemon = active | cleo memory dream --status isOverdue=false for 7d"

cleo add --type epic --parent <MASTER> --title "E-PRIME-T02 — Provenance & Quarantine" \
  --kind work --severity P0 --size large \
  --acceptance "SELECT COUNT(*) FROM brain_observations WHERE origin IS NULL = 0 within 7d | pattern_count/observation_count ≤ 2.0 | learning_count/observation_count ≥ 0.05 | cleo doctor scan-test-fixtures-in-prod returns clean | CI fails any test writing to live .cleo/tasks.db"

cleo add --type epic --parent <MASTER> --title "E-PRIME-T03 — Peer-Graph Identity" \
  --kind work --severity P0 --size large \
  --acceptance "Spawned agent prompt contains '# Core Memory' + '# Mental Model — Living Knowledge' blocks | cleo peer card cleo-prime returns non-empty markdown | After 5 sessions, cleo agent diff shows non-trivial diff | Agent memory.edit_block updates next-spawn briefing | cleo agents show cleo-prime --history shows sigil evolution"

cleo add --type epic --parent <MASTER> --title "E-PRIME-T04 — Mem0 Write-Time Extraction Gate" \
  --kind work --severity P0 --size large \
  --acceptance "100% of brain table writes via verifyAndStore (AST-grep CI gate) | Mem0 V3 verdict envelope schema in @cleocode/contracts | Insert 'React 18' then 'React 19' sets invalid_at + superseded_by | BRAIN_GATE_DISABLED kill-switch documented as forensic-only"

cleo add --type epic --parent <MASTER> --title "E-PRIME-T05 — Bitemporal + Four-Network Epistemology" \
  --kind work --severity P0 --size large \
  --acceptance "Graphiti 4-timestamp columns (expired_at, valid_at, plus existing created_at + invalid_at) live on 4 typed tables | cleo brain query --at <past-date> returns different row set than --at now | All 4 networks (world/bank/opinion/observation) populated | Opinion-network confidence reduces on contradicting evidence"

cleo add --type epic --parent <MASTER> --title "E-PRIME-T06 — PSYCHE Pipeline (harden + complete + integrate)" \
  --kind work --severity P0 --size large \
  --acceptance "Surprisal-tree factory exposes 7 strategies (CoverTree, RPTree, LSH, KDTree, BallTree, Prototype, Graph) | Derivation queue survives mid-run kill + worker restart | Dream cycle reduces brain_patterns count by ≥50% via dedup | Reconciler purges N superseded rows from brain_observation_embeddings per cycle | 4-AND dream gate blocks scheduled dreams when any condition fails | Structural fast-path runs when LLM unreachable"

cleo add --type epic --parent <MASTER> --title "E-PRIME-T07 — Four-Bus Integration (BRAIN↔NEXUS↔TASKS↔CONDUIT)" \
  --kind work --severity P0 --size large \
  --acceptance "cleo orchestrate spawn <task> --dry-run contains '## Prior Context (from BRAIN)' | cleo nexus impact <sym> --json returns non-empty .brainEvidence | Wave completion publishes brain-digest event within 5s | % conduit-messages in [task-blocked,status-flip,decision,brain-digest] ingested = 100%"

cleo add --type epic --parent <MASTER> --title "E-PRIME-T08a — Memory-Git Per Peer" \
  --kind work --severity P1 --size large \
  --acceptance "Per-peer git repo at ~/.local/share/cleo/memory-versions/<peer-id>/ | cleo memory log <peer> returns git-style history | Subagent branching aligned with ADR-062 merge-not-cherry-pick | Cherry-pick CI guard fails on attempted cherry-pick"

cleo add --type epic --parent <MASTER> --title "E-PRIME-T08b — Continuous Living (idle dream + compaction + skills)" \
  --kind work --severity P1 --size large \
  --acceptance "6 backdated obs + idleMinutes=10 fires idleDreamGate writing ≥1 brain_learning | Pattern retrievalCount=6 successRate=0.9 produces SkillDistillationProposal | Owner accepts → .md skill file appears at ~/.cleo/skills/<peer>/"

cleo add --type epic --parent <MASTER> --title "E-PRIME-T09 — Sentient Tier-2 + CANT Evolution" \
  --kind work --severity P1 --size large \
  --acceptance "Tier-2 detector emits proposal task when ≥3 same-pattern rows in 7 days (2-evidence rule) | Integration test exercises Tier1+2+3 with mock BRAIN data | /reflect directive parses in CANT | agent-review.cantbook produces refined .cant for cleo-prime"

cleo add --type epic --parent <MASTER> --title "E-PRIME-T10 — Conduit A2A (deferred)" \
  --kind work --severity P2 --size medium \
  --acceptance "CANT /handoff parser accepts directive without error | 1-hop handoff round-trips observation_ids preserved | Replaces .cleo/agent-outputs/*.md redirect stubs"

cleo add --type epic --parent <MASTER> --title "E-PRIME-T11 — MemoryProvider Plugin Substrate" \
  --kind work --severity P1 --size large \
  --acceptance "MemoryProvider ABC in packages/core/src/memory/provider.ts | 3 implementations registered (brain, nexus, llmtxt) | Integration test dual-writes via ABC to brain + mock provider | All existing brain tests pass unchanged"

cleo add --type epic --parent <MASTER> --title "E-PRIME-T12 — Mastra Pre-Composed Context (prompt cache discipline)" \
  --kind work --severity P1 --size large \
  --acceptance "Anthropic prompt-cache hit rate ≥60% on spawn prompts | Token cost per medium-task spawn -50% to -90% | Observer writes priority-tagged observation per turn | Three-date model populated on observations"

cleo add --type epic --parent <MASTER> --title "E-PRIME-T13 — Episodes + LLM-Edges + Heartbeat" \
  --kind work --severity P1 --size large \
  --acceptance "≥30% of spawns inject matching episode exemplar for similar tasks | brain_episodes table populated on task complete | Tool-loop heartbeat chain executes 3-step retrieval in single turn | LLM-edge pass emits non-empty linkedNodes ≥1 per dream cycle"

cleo add --type epic --parent <MASTER> --title "E-PRIME-T14 — Honcho-MCP-vs-Native Decision" \
  --kind research --severity P2 --size medium \
  --acceptance "Honcho MCP sidecar deployed | A/B vs MemoryProvider-wrapped BRAIN provider | ADR-NNN shipped with quantitative A/B verdict"

cleo add --type epic --parent <MASTER> --title "E-PRIME-CI — CI Trust Gates + Daemon Resilience" \
  --kind work --severity P1 --size medium \
  --acceptance "cleo doctor brain --strict extension covers origin/pattern-bloat/learning-liveness/dream-freshness | CI workflow brain-doctor job (warning week 1 → blocking from week 2 after 7d green) | PRAGMA busy_timeout=5000 at every brain.db open | Watchdog exits on >2× interval stall"

# 3. T-SANDBOX sibling epic (parent = NONE — program-level sibling)
cleo add --type epic --title "T-SANDBOX — Tier-3 Sentient Sandbox (deferred follow-up to E-PRIME-SENTIENCE)" \
  --kind work --severity P2 --size large \
  --acceptance "Tier-3 sandbox runs experiments in container with network-none | Ed25519 signed receipts via llmtxt/events | FF-only merge with abort-on-fail | cleo revert --from <receiptId> works end-to-end | Integration test injects kill-switch at step 6 verifies no merge"
```

### Phase B — Reparent existing children

```bash
# Reparent 3 reopened BBTT children
cleo update T1897 --parent <E-PRIME-T02-ID>
cleo update T1899 --parent <E-PRIME-T02-ID>
cleo update T1906 --parent <E-PRIME-T02-ID>

# Reparent T9245 from T9232 to E-PRIME-T01
cleo update T9245 --parent <E-PRIME-T01-ID>
# Add cross-reference back to T9232 master campaign
cleo update T9245 --relates add T9232

# Reparent T1644 + T1646 from T1007 to E-PRIME-T09
cleo update T1644 --parent <E-PRIME-T09-ID>
cleo update T1646 --parent <E-PRIME-T09-ID>

# Reparent 9 Tier-3 sandbox children to T-SANDBOX
cleo update T946  --parent <T-SANDBOX-ID>
cleo update T1010 --parent <T-SANDBOX-ID>
cleo update T1011 --parent <T-SANDBOX-ID>
cleo update T1012 --parent <T-SANDBOX-ID>
cleo update T1029 --parent <T-SANDBOX-ID>
cleo update T1030 --parent <T-SANDBOX-ID>
cleo update T1032 --parent <T-SANDBOX-ID>
cleo update T1074 --parent <T-SANDBOX-ID>
cleo update T1645 --parent <T-SANDBOX-ID>
```

### Phase C — Close superseded parent epics

```bash
# T1892 BBTT — close with attestation linking to E-PRIME-SENTIENCE
cleo update T1892 --note "Superseded by E-PRIME-SENTIENCE. 14 done children remain historical record. 3 pending children (T1897, T1899, T1906) reparented under E-PRIME-T02. See docs/plans/cleo-prime-decomposition/ for canonical roadmap."
cleo verify T1892 --gate implemented --evidence "decision:E-PRIME-SENTIENCE;note:superseded, children reparented, 14 done children preserved as historical record" \
&& cleo verify T1892 --gate testsPassed --evidence "note:design-only epic; no tests to run" \
&& cleo verify T1892 --gate qaPassed --evidence "note:design-only epic" \
&& cleo complete T1892

# T942 Sentient Architecture Redesign — close after children moved to T-SANDBOX
cleo update T942 --note "Superseded by T-SANDBOX. All 8 children reparented under new Tier-3 sandbox epic."
cleo verify T942 --gate implemented --evidence "decision:T-SANDBOX;note:children reparented" \
&& cleo verify T942 --gate testsPassed --evidence "note:design-only epic" \
&& cleo verify T942 --gate qaPassed --evidence "note:design-only epic" \
&& cleo complete T942

# T1007 Sentient Loop Completion — close after children split
cleo update T1007 --note "Superseded. T1644+T1646 reparented under E-PRIME-T09. T1645 reparented under T-SANDBOX."
cleo verify T1007 --gate implemented --evidence "decision:E-PRIME-T09;note:children split between E-PRIME-T09 and T-SANDBOX" \
&& cleo verify T1007 --gate testsPassed --evidence "note:design-only epic" \
&& cleo verify T1007 --gate qaPassed --evidence "note:design-only epic" \
&& cleo complete T1007
```

### Phase D — Cross-link parallel epics

```bash
# T631 Cleo Prime Persona parallel-link
cleo update T631 --relates add E-PRIME-SENTIENCE
cleo update T1638 --relates add E-PRIME-T03

# T1737 CleoOS Sentient Harness v3 parallel-link
cleo update T1737 --relates add E-PRIME-SENTIENCE
cleo update T1739 --relates add E-PRIME-T11   # tool registry ~ provider plugin parallel
cleo update T1743 --relates add E-PRIME-T03   # memory tool ~ peer-graph
cleo update T1745 --relates add E-PRIME-T07   # subagent delegation ~ four-bus
cleo update T1746 --relates add E-PRIME-T14   # native MCP ~ Honcho-MCP decision
```

### Phase E — Decompose Tier-epics into phase tasks + subtasks

This is the bulk of the work — 452 atomic subtasks across 84 phase tasks. Driven by the 6 tier-epic spec files in this directory.

**Recommended path**: write a programmatic script `scripts/expand-decomposition.mjs` that:
1. Reads the 6 `E-PRIME-T*.md` spec files
2. Parses each `### Phase N` and `#### Subtask N.M` block
3. Emits `cleo add --type task --parent <tier-id> --title ... --acceptance ...` invocations
4. Emits `cleo add --type subtask --parent <task-id> --title ... --acceptance ... --files ...`
5. Handles `depends-on` edges with `--depends` flag at task-creation time

This script avoids 452 manual `cleo add` invocations and ensures consistent shape across all subtasks.

---

## 4. Open questions for owner (BLOCKING Phase A)

Before any `cleo add` runs, confirm:

1. **Master epic naming**: stick with `E-PRIME-SENTIENCE` synthetic ID OR rename to something like `T-PRIME-SENTIENCE` so the synthetic-vs-real-ID distinction is gone?
2. **T-SANDBOX naming**: synthetic ID OR mint as `T-SANDBOX-CLEO` to leave room for other sandbox epics later?
3. **Closing T1892/T942/T1007**: confirm closing-as-superseded is acceptable vs setting status=cancelled or leaving open with a redirect note. Closing-with-evidence preserves attestation lineage which I think is right.
4. **Reparenting evidence atoms**: when reparenting T1897/T1899/T1906/T1644/T1646/T9245, should I add a new evidence atom `decision:<original-parent-id>;note:reparented` to preserve audit lineage? Or is `--parent` change in tasks.db audit log sufficient?
5. **T9245 dual-parenting**: it currently sits under T9232 (8-phase optimization campaign). Reparenting to E-PRIME-T01 + `relates: T9232` preserves the cross-reference. Alternative: keep `parent=T9232`, add `relates: E-PRIME-T01`. Which is the "primary" home — the trust-foundation epic that needs it shipped, or the optimization campaign that originally tracked it? My recommendation: E-PRIME-T01 as primary parent, T9232 as relates.
6. **Phase E execution**: I write the `scripts/expand-decomposition.mjs` parser AND run it, OR you review the generated commands first as a dry-run before any `cleo add` lands?

---

## 5. Risk Register (reconciliation-specific)

| Risk | Mitigation |
|---|---|
| Reparenting loses BBTT W3 evidence atoms on T1897/T1899/T1906 | Re-verify under new parent with REAL evidence (commit+files+tool) — the original `--override` evidence atoms are what we're explicitly correcting via T9245 anyway. New parent fixes the audit trail. |
| Closing T1892 erases its task-tree audit | NO — `cleo complete` writes `completedAt` + evidence; the tree stays queryable. 14 done children remain under T1892. Closing the epic is a status change, not a delete. |
| T631 + E-PRIME-T03 produce conflicting persona definitions | T631 produces `.cant` template files; E-PRIME-T03 produces database schema for personas. Different artifacts. `relates` link makes the connection visible. |
| T1737 children that overlap (T1739/T1743/T1745/T1746) get double-counted | Selective cross-link with `relates`, not reparent. T1737 keeps its full subtree. E-PRIME-T03/T07/T11/T14 cite the T1737 child as a dependency where useful. |
| Some BBTT children completed via `--override` and never properly re-verified | T01.P2 explicitly includes 13 re-verify subtasks. The done BBTT children that USED `--override` evidence (T1897/T1899/T1906 were already reopened — but T1898/T1901/T1902/T1908/T1903/T1908/T1894 etc. ALSO show override-evidence in the inventory query). Owner-decision: re-verify only the 3 already-reopened, or audit all done BBTT children for `--override` and re-verify all? Recommendation: only the 3 reopened (already triaged by validation audit); add a separate audit subtask under E-PRIME-T01 to scan all `--override` evidence in `tasks.db` and flag any other suspect closures. |
| `cleo update T-X --parent T-Y` may not exist as a CLI verb | Verify before Phase B. If unsupported, fall back to `cleo edit T-X --parent T-Y` or whatever the canonical reparent verb is. |

---

## 6. Recommended next step

1. **Owner reviews this RECONCILIATION-PLAN.md + answers the 6 questions in §4**.
2. **I run Phase A** — create 15 epics + T-SANDBOX. Capture real `T####` IDs in a mapping table appended to `README.md` §8.
3. **I run Phase B** — reparent 13 existing tasks.
4. **I run Phase C** — close 3 superseded epics with attestation evidence.
5. **I run Phase D** — add `relates` cross-links.
6. **I write Phase E script** + show owner the first 20 generated `cleo add` invocations as dry-run before executing across all 452 subtasks.

Wave 0 execution (T9245 fix + W0 schema bundle) starts only after Phase E lands and all open questions in `README.md §5` (Q1-Q28) are answered.
