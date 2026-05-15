# E-PRIME-SENTIENCE — Master Epic & Decomposition Index

> **Status**: planning · DRAFT · 2026-05-15 · NO `cleo add` invocations yet
> **Master plan**: [`../CLEO-PRIME-SENTIENT-MASTERPLAN.md`](../CLEO-PRIME-SENTIENT-MASTERPLAN.md)
> **Total atomic subtasks specified**: **452** across **14 Tier-epics**, **84 phase tasks**
> **Decomposed by**: 6 parallel planning agents (2026-05-15)

---

## 1. Master Epic: `E-PRIME-SENTIENCE`

### Identity
- **ID**: E-PRIME-SENTIENCE (root)
- **Title**: CLEO Prime — Sentient Orchestrator with Living Brain
- **Type**: epic
- **Kind**: work
- **Severity**: P0
- **Size**: large
- **Parent**: — (program root)
- **References masterplan §**: ALL (§0 North Star → §19 Verification artefacts)

### Vision (one sentence)

Turn CLEO from a four-DB memory system *for* agents into a peer-graph nervous system *of* agents — where Prime is the one persistent persona the human operator meets, every CANT agent is a first-class peer with editable memory blocks and a growing mental model resolved from BRAIN, every belief is bitemporal, every write passes one Mem0-style extraction gate, every peer keeps a git-tracked memory diff history, and BRAIN trust net-rises as we add intelligence.

### Master Acceptance Criteria (epic-level, pipe-separated for `cleo add`)

```
AC-MASTER-1: cleo doctor brain --strict exits 0 continuously for 7 days in production
| AC-MASTER-2: 100% of brain table writes originate from verifyAndStore (CI AST-grep gate green for 7 days)
| AC-MASTER-3: 0% of brain_observations have origin IS NULL in production
| AC-MASTER-4: systemctl --user is-active cleo-daemon = active and cleo memory dream --status isOverdue=false for 7 consecutive days
| AC-MASTER-5: Spawned agent prompt contains '# Core Memory' + '# Mental Model — Living Knowledge' + '## Prior Context (from BRAIN)' blocks (regex-asserted)
| AC-MASTER-6: cleo brain query --at <past-date> returns a different row set than --at now (time-travel works end-to-end)
| AC-MASTER-7: Anthropic prompt-cache hit rate on spawn prompts ≥60% (Mastra pre-composed context shipped)
| AC-MASTER-8: ≥30% of spawns inject a matching episode exemplar as '## Prior Successful Approaches' (LangMem Episodes shipped)
| AC-MASTER-9: agent-review.cantbook completes a self-review producing refined .cant for cleo-prime (owner-accepted)
| AC-MASTER-10: All 13 BBTT mis-completed tasks re-verified with real evidence atoms (zero --override on critical gates)
```

### Master Milestone Gates (proving improvement)

The headline "is CLEO getting more sentient?" metrics. Each gate has baseline → target. Order matters: trust before intelligence before performance.

| # | Gate | Baseline | Target | Phase |
|---|---|---|---|---|
| **MG-1 TRUST** | % `brain_observations` with `origin IS NULL` | measure today (likely ~100% of legacy rows) | **0%** | W2 |
| **MG-2 LIVENESS** | Consecutive days `cleo memory dream --status isOverdue=false` | currently flaky | **≥7 days** | W1 |
| **MG-3 FUNNEL** | % brain writes via `verifyAndStore` (AST-grep count) | measure today (likely partial) | **100%** | W1 |
| **MG-4 PROVENANCE** | `pattern_count / observation_count` ratio | currently ~4.4× (over-bloat) | **≤2.0** | W2 |
| **MG-5 PROMOTION** | `learning_count / observation_count` ratio | currently 0.004 (0.4%) | **≥0.05 (5%)** | W2 |
| **MG-6 IDENTITY** | Count of peers with non-empty `brain_memory_blocks` | 0 | **≥5 named agents** | W3 |
| **MG-7 SPAWN INTEL** | % spawn prompts with `## Prior Context (from BRAIN)` section | 0% | **100%** of task-typed spawns | W4 |
| **MG-8 BITEMPORAL** | Round-trip "React 18 → React 19" sets `invalid_at + superseded_by` | N/A | **pass** | W1 |
| **MG-9 PROMPT CACHE** | Anthropic prompt-cache hit rate on spawn prompts | ~0% | **≥60%** | W4/W11 |
| **MG-10 EPISODES** | % spawns injecting matching episode exemplar | 0% | **≥30%** for similar-task spawns | W12 |
| **MG-11 PSYCHE** | Surprisal-tree factory strategies exposed | 1 of 7 | **7 of 7** | W5 |
| **MG-12 TIER-2** | BRAIN-pattern-derived proposals per 100 matching patterns | 0 | **≥1 (2-evidence rule)** | W7 |
| **MG-13 CI BLOCKING** | `cleo doctor brain --strict` as CI blocking gate | not blocking | **blocking after 7d green soak** | W∞ |
| **MG-14 CONTINUOUS** | New `brain_learnings` per idle-dream cycle (when gate satisfied) | 0 | **≥1** | W6 |
| **MG-15 PROVIDERS** | MemoryProvider ABC implementations registered | 0 | **≥3 (brain, nexus, llmtxt)** | W10 |
| **MG-16 RAPPORT** | `brain_agent_rapport` rows per inter-agent handoff | 0 (no table) | **≥1 row per handoff** | W3 |

The pipeline is **ship-no-regression**: every Wave must not regress prior Waves' gates.

---

## 2. Tier-Epic Index

| Tier-Epic | Title | File | Phases | Subtasks | Severity | Wave(s) | Status |
|---|---|---|---|---|---|---|---|
| E-PRIME-T01 | Trust Foundation | [E-PRIME-T01-T02-CI.md](E-PRIME-T01-T02-CI.md) | 3 | 36 | P0 | W0, W1 | spec drafted |
| E-PRIME-T02 | Provenance & Quarantine | [E-PRIME-T01-T02-CI.md](E-PRIME-T01-T02-CI.md) | 5 | 22 | P0 | W0, W1, W2 | spec drafted |
| E-PRIME-CI | CI Trust Gates + Daemon Resilience | [E-PRIME-T01-T02-CI.md](E-PRIME-T01-T02-CI.md) | 3 | 13 | P1 | W2 → W∞ | spec drafted |
| E-PRIME-T03 | Peer-Graph Identity | [E-PRIME-T03-T08a-identity.md](E-PRIME-T03-T08a-identity.md) | 8 | 60 | P0 | W0, W3 | spec drafted |
| E-PRIME-T04 | Mem0 Write-Time Extraction Gate | [E-PRIME-T04-T05-gate-bitemporal.md](E-PRIME-T04-T05-gate-bitemporal.md) | 8 | 30 | P0 | W0, W1 | spec drafted |
| E-PRIME-T05 | Bitemporal + 4-Network Epistemology | [E-PRIME-T04-T05-gate-bitemporal.md](E-PRIME-T04-T05-gate-bitemporal.md) | 8 | 32 | P0 | W0, W1 | spec drafted |
| E-PRIME-T06 | PSYCHE Pipeline (harden + complete) | [E-PRIME-T06-psyche.md](E-PRIME-T06-psyche.md) | 5 + obs | 76 | P0 | W5 | spec drafted |
| E-PRIME-T07 | Four-Bus Integration | [E-PRIME-T07-T08b-T09-integration.md](E-PRIME-T07-T08b-T09-integration.md) | 5 | 31 | P0 | W4 | spec drafted |
| E-PRIME-T08a | Memory-Git Per Peer | [E-PRIME-T03-T08a-identity.md](E-PRIME-T03-T08a-identity.md) | 6 | 20 | P1 | W6 | spec drafted |
| E-PRIME-T08b | Continuous Living (idle + compaction + skills) | [E-PRIME-T07-T08b-T09-integration.md](E-PRIME-T07-T08b-T09-integration.md) | 4 | 23 | P1 | W6 | spec drafted |
| E-PRIME-T09 | Sentient Tier-2 + CANT Evolution | [E-PRIME-T07-T08b-T09-integration.md](E-PRIME-T07-T08b-T09-integration.md) | 7 | 35 | P1 | W7, W8 | spec drafted |
| E-PRIME-T10 | Conduit A2A (deferred) | [E-PRIME-T10-T11-T12-T13-T14-substrate.md](E-PRIME-T10-T11-T12-T13-T14-substrate.md) | 5 | 14 | P2 | W9 | spec drafted |
| E-PRIME-T11 | MemoryProvider Plugin Substrate | [E-PRIME-T10-T11-T12-T13-T14-substrate.md](E-PRIME-T10-T11-T12-T13-T14-substrate.md) | 7 | 14 | P1 | W10 | spec drafted |
| E-PRIME-T12 | Mastra Pre-Composed Context | [E-PRIME-T10-T11-T12-T13-T14-substrate.md](E-PRIME-T10-T11-T12-T13-T14-substrate.md) | 8 | 17 | P1 | W4, W11 | spec drafted |
| E-PRIME-T13 | Episodes + LLM-Edges + Heartbeat | [E-PRIME-T10-T11-T12-T13-T14-substrate.md](E-PRIME-T10-T11-T12-T13-T14-substrate.md) | 8 | 19 | P1 | W12 | spec drafted |
| E-PRIME-T14 | Honcho-MCP-vs-Native Decision (research) | [E-PRIME-T10-T11-T12-T13-T14-substrate.md](E-PRIME-T10-T11-T12-T13-T14-substrate.md) | 4 | 10 | P2 | W14 | spec drafted |
| **TOTAL** | | | **94** | **452** | | | |

---

## 3. Dependency DAG (Tier-Epic Level)

```
                        ┌──────────────────────────┐
                        │ E-PRIME-SENTIENCE (root) │
                        └────────────┬─────────────┘
                                     │
        ┌────────────────────────────┼─────────────────────────┐
        ▼                            ▼                         ▼
  ┌───────────┐              ┌───────────┐             ┌──────────────┐
  │ T01 Trust │──────────────│T02 Provena│─────────────│ E-PRIME-CI   │
  │ Foundation│              │  & Quaran │             │ (cross-cut)  │
  └─────┬─────┘              └─────┬─────┘             └──────┬───────┘
        │                          │                          │
        └────────────┬─────────────┴───────────┬──────────────┘
                     ▼                         ▼
              ┌───────────────┐         ┌──────────────────┐
              │   T04 Mem0    │◀────────│ T05 Bitemporal + │
              │   Write-Gate  │         │   4-Network      │
              └──────┬────────┘         └─────────┬────────┘
                     │                            │
                     ├────────────┬───────────────┤
                     ▼            ▼               ▼
                ┌──────────┐ ┌─────────┐   ┌──────────────┐
                │T03 Peer- │ │T06 PSYCHE│   │ T11 Memory-  │
                │Graph ID  │ │ Pipeline │   │ Provider ABC │
                └────┬─────┘ └────┬─────┘   └──────┬───────┘
                     │            │                │
        ┌────────────┼────────────┼──────┬─────────┤
        ▼            ▼            ▼      ▼         ▼
  ┌──────────┐ ┌─────────┐  ┌──────────┐ │  ┌─────────────┐
  │T08a Mem- │ │T07 Four- │  │T08b Cont-│ │  │T14 Honcho-  │
  │  Git/Peer│ │ Bus Integ│  │  inuous  │ │  │  MCP Decision│
  └────┬─────┘ └────┬─────┘  └─────┬────┘ │  └─────────────┘
       │            │              │      │
       │       ┌────┴────┐         │      ▼
       │       ▼         ▼         │  ┌────────────┐
       │  ┌─────────┐ ┌──────┐    │  │ T12 Mastra │
       │  │T12 Mast.│ │T13 Ep│    │  │  Pre-comp  │
       │  │ Prefix  │ │+Edges│    │  │  Context   │
       │  └─────────┘ └──┬───┘    │  └────┬───────┘
       │                 │         │       │
       └─────────────────┴─────────┼───────┘
                                   ▼
                         ┌──────────────────┐
                         │ T09 Sentient T-2 │
                         │ + CANT Evolution │
                         └────────┬─────────┘
                                  ▼
                          ┌───────────────┐
                          │T10 Conduit A2A│
                          │   (deferred)  │
                          └───────────────┘
```

**Critical paths**:
1. **Trust spine**: T01 → T02 → E-PRIME-CI. Without these, every downstream claim is suspect.
2. **Schema W0 bundle**: T02-P1 + T03-P1/P2/P5 + T05-P1 co-land as a single migration PR. Order: peer tables first (T03), then provenance columns (T02), then bitemporal+network (T05), then memory_blocks (T03), then identity sibling tables (T03).
3. **Funnel chokepoint**: T04 Mem0 gate must be in place before T07 four-bus + T13 episodes + T11 providers can rely on consistent writes.
4. **PSYCHE serial**: T06 sub-phases sequence as 6.A audits → 6.B queue → 6.C dialectic → 6.D dreamer → 6.E reconciler → 6.F structural.
5. **Tier-2 dependency cone**: T09 detector needs T06.2 deriver queue + T03 peer schema + T04 verdict envelope. Schedule last.

**Cycle resolution**: T07-P1 (spawn-context-builder reads brain-digest) ↔ T07-P4 (wave-rollup publishes brain-digest). **Mitigation**: ship the shared `BrainDigestEvent` contract first (atomic subtask T-PRIME-T07-P4-S1), then implement reader and writer in parallel.

---

## 4. Revised Wave Plan (per masterplan §18, refined by decomposition)

| Wave | Active Tier-Epics | Parallelism | Critical-Path Phase |
|---|---|---|---|
| **W0 — Schema lock-in** | T01.P1 (T9245), T02.P1 (origin migrations), T03.P0 (canonicalPeerId), T03.P1 (peer tables), T03.P2 (memory_blocks), T03.P5 (identity siblings), T05.P1 (bitemporal+network+confidence) | **SERIAL** migration sequencing | Single co-landed PR |
| **W1 — Trust funnel** | T01.P2 (BBTT re-verify), T01.P3 (daemon liveness), T02.P2 (writers funnel), T02.P3 (quarantine), T04.P2-P5 (Mem0 gate), T05.P2-P4 (readers + disposition), E-PRIME-CI.P3 (daemon resilience) | **PARALLEL** across files | T01.P2 BBTT re-verify (P0 trust unlock) |
| **W2 — Auto-extract repair** | T02.P4 (T729-T737 fixes), T02.P5 (T1903 promo log), E-PRIME-CI.P1 (`--strict` checks), E-PRIME-CI.P2 (CI gate warning mode) | **PARALLEL** | T02.P4 promotion ratio |
| **W3 — Identity core** | T03.P3 (CANT growth), T03.P4 (drift), T03.P6 (CLI), T03.P7 (briefing inject + tests) | **PARALLEL** across files | T03.P3 spawn-time resolution |
| **W4 — Four-bus + Mastra prefix** | T07.P1-P5 (spawn-context, nexus-evidence, decomp-advisor, brain-digest, conduit-ingester), T12.P1-P5 (prompt-prefix builder + Observer/Reflector) | **PARALLEL** across files; **intra-cycle**: T07.P4 contract before T07.P1 impl | T07.P1 spawn-context-builder |
| **W5 — PSYCHE harden+complete** | T06.A (4 audits), T06.B (derivation queue), T06.C (dialectic), T06.D (dreamer + 7-strategy), T06.E (reconciler), T06.F (structural fast-path), T06.G (obs+docs) | **SEQUENTIAL within tier**: A → B → C → D → E → F (parallel where possible after audits land) | T06.B derivation queue (critical-path blocking 6.C/D/E) |
| **W6 — Continuous living** | T08a.P0-P5 (memory-git), T08b.P1 (idleDreamGate), T08b.P2 (archiveCompactionTick), T08b.P3-P4 (skill distillation) | **PARALLEL** | T08a memory-git infra |
| **W7 — Sentient Tier-2** | T09.P1 (T1644 detector — 5 proposal kinds + 4-AND gate), T09.P2 (integration tests), T09.P3 (T-SANDBOX decision stub), T09.P4 (op audit) | **PARALLEL** across detector kinds | T09.P1 contradiction+correlation detectors |
| **W8 — CANT evolution + Episodes** | T09.P5 (hook events), T09.P6 (`/reflect` directive), T09.P7 (agent-architect + agent-review.cantbook), T13.P0-P3 (envelope discovery + episodes + edges) | **PARALLEL** | T13.P0 contracts discovery → T13.P1 schema |
| **W9 — Conduit A2A** | T10.P1-P5 (handoff directive + parser + topic + subscriber + ADR) | **PARALLEL** | T10.P1 design ADR |
| **W10 — MemoryProvider substrate** | T11.P1-P7 (ABC + 3 implementations + registry + dual-write test) | **PARALLEL** | T11.P1 ABC |
| **W11 — Mastra full** | T12.P6 (cache_control wiring + measurement), T12.P7 (cost ship-gate) | **SERIAL after T12.P0-P5 in W4** | T12.P6 measurable cache hit |
| **W12 — Episodes + Heartbeat + Edges** | T13.P4 (heartbeat in tool-loop), T13.P5 (A-Mem LLM-edges), T13.P6 (A-Mem evolution), T13.P7 (integration test) | **PARALLEL** with branch-collision check on tool-loop.ts | T13.P4 heartbeat |
| **W13 — Honcho-MCP A/B** | T14.P1 (sidecar deploy as experiment), T14.P2 (A/B vs native provider), T14.P3 (ADR) | **PARALLEL** with sidecar isolation | T14.P3 ADR verdict |
| **W∞ — CI gate flip** | E-PRIME-CI.P2 flip to blocking after 7-day green soak | **SERIAL** | Soak time only |

---

## 5. Consolidated Open Questions for Owner

Numbered for tracking. Each came from at least one decomposition agent. Resolve before the corresponding Wave starts.

### Trust + Provenance (W0-W2)
- **Q1** [T01-R1]: BBTT re-verify needs original commit SHAs resolved — some may be unreachable post force-push. What attestation path is acceptable when SHA is unreachable?
- **Q2** [T02-R3]: Backfill heuristic for legacy `origin` column — owner sign-off needed on `'manual'` vs `'auto-extract'` classifier before running migration.
- **Q3** [CI-R5]: `--strict` gate may flake on low-data sandboxes (0/0 ratios). Min-row threshold acceptable? (proposed: 100 observations before strict applies)
- **Q4** [CI-R4]: Watchdog interaction with systemd `Restart=on-failure` — `SuccessExitStatus` handling correct? Needs verification on operator host.

### Identity (W3)
- **Q5** [T03-Q1]: Block-label canonical order — confirm: `persona | human | project | current-goal | open-questions | recent-decisions | scratchpad | shared:<topic>`?
- **Q6** [T03-Q2]: Drift threshold default — accept proposed **0.3** cosine-distance, or different?
- **Q7** [T03-Q4]: Error code `E_BLOCK_CAS_MISMATCH` — add to canonical error registry?
- **Q8** [T03-Q5]: Mirror Letta's `memory_finish_edits` sentinel pattern in our v2 surface?

### Memory-git (W6)
- **Q9** [T08a-Q3]: Memory-git path location — `~/.local/share/cleo/memory-versions/<peer-id>/` (global, cross-project) **OR** `.cleo/memory-versions/<peer-id>/` (per-project)? Cross-project rapport favors global; sandboxing favors local.
- **Q10** [T08a-Q6]: Cherry-pick CI guard scope — block in worktree-backend only, or repo-wide?

### Write-gate + Bitemporal (W1)
- **Q11** [T04]: AST-grep allowlist scope — which storage-layer accessors are legitimate bypass paths?
- **Q12** [T05]: CHECK constraint on legacy rows — NULL `network` is the escape; agreed?

### PSYCHE (W5)
- **Q13** [T06-Q1]: Tree default strategy among the 7 — `RPTree` (current), `CoverTree`, or `KDTree`?
- **Q14** [T06-Q2]: Worker concurrency cap for derivation-queue — propose **5** (matches Letta's `safe_create_task` semaphore)
- **Q15** [T06-Q3]: DLQ retention — propose **30 days** with `cleo memory dlq purge` opt-in cleanup
- **Q16** [T06-Q4]: Sibling-embedding column drop window — when is the old `embedding` column on observations safe to drop?
- **Q17** [T06-Q5]: `finish_consolidation` sentinel semantics — does emission gate the NEXT cycle, or only the current one?
- **Q18** [T06-Q7]: Dialectic reasoning level default — propose `low` (Honcho default) vs CLEO override?

### Integration (W4-W7)
- **Q19** [T07]: `nexus impact` result shape extension — extend existing envelope or version with `v2`?
- **Q20** [T09]: T1644 detector confidence floor — propose 0.7 for emission, configurable?

### New substrate (W8+)
- **Q21** [T13-R1]: Discovery — verify `packages/contracts/src/envelope.ts` path before T13.0.1 edit; layout may have shifted post-T9261.
- **Q22** [T13-R2]: Branch collision — `tool-loop.ts` already modified on `feat/T9261-phase4-w5-w8`. Sequence T13.P4 after T9298 ships, or rebase?
- **Q23** [T13-R3]: Anthropic SDK `cache_control` markers — confirmed supported in current pinned version, or bump first?
- **Q24** [T12-R4]: Mastra cost ship-gate — 50% reduction is target; what's the minimum acceptable improvement to ship?

### Decision-only (W13)
- **Q25** [T14]: Honcho MCP sidecar deployment — local-only OR optional cloud-sidecar for users without local Bun/Wrangler?

### From masterplan §10 (still open)
- **Q26** [§10.1]: Tier-3 sandbox — defer to T-SANDBOX, or invest now?
- **Q27** [§10.5]: Symmetric vs hierarchical peer model — keep CLEO hierarchy (recommended) confirmed?
- **Q28** [§10.7]: Reflection model tier — Opus 4.7 for highest quality, or Sonnet to match cold-tier convention?

---

## 6. Consolidated Risk Register

| ID | Risk | Source | Mitigation | Owner |
|---|---|---|---|---|
| R1 | BBTT re-verify needs commit SHAs that may be force-pushed/unreachable | T01 | Owner-attestation path Q1 | Pending |
| R2 | Two-DB migration ordering (conduit + brain) needs lock window | T02 | In-flight session lock; migration runner detects active sessions | Pending |
| R3 | Letta v2 patch-header byte-fidelity | T03 | Snapshot-test golden patches | Per-subtask |
| R4 | CAS starvation under concurrent append/edit on memory blocks | T03 | Retry-with-backoff + `E_BLOCK_CAS_MISMATCH` error semantics | Per-subtask |
| R5 | peerId backfill destructiveness if mis-classified | T03 | Dry-run + revert path before live backfill | Owner sign-off |
| R6 | Migration co-landing — W0 single-PR discipline easy to break | T04, T05 | One feature branch, one PR, all migrations or none | CI gate |
| R7 | CHECK constraint on legacy rows (NULL `confidence` allowed only when `network != 'opinion'`) | T05 | CHECK constraint at column add; backfill via separate script | Per-migration |
| R8 | Opinion-network supersession via `reduceOpinionConfidence` not full supersede | T05 | Distinct function path; regression test | Per-subtask |
| R9 | SQLite SKIP-LOCKED concurrency under high load | T06 | Bounded concurrency semaphore (proposed 5) | T06.B |
| R10 | 7 tree strategies risk of shallow ports | T06 | Per-strategy parity test against Honcho fixtures | Per-subtask |
| R11 | T06.B derivation queue is critical path blocking 6.C/D/E | T06 | Front-load 6.B; audits can parallel pre-queue | T06.A scheduling |
| R12 | Circular dep T07-P1 ↔ T07-P4 (spawn-context reads digest, wave-rollup writes) | T07 | Ship shared contract first, parallel impl | T07.P4.S1 ships first |
| R13 | 1200-token budget creep when 4 buckets stack in spawn prompt | T07 | Per-bucket caps + token meter at compose time | T07.P1.S* |
| R14 | `propose.ts` is genuinely NEW (not just stub) | T09 | Filesystem-verified; no fallback assumption | T09.P1 |
| R15 | `tier_promoted_at` schema migration needs owner ADR | T08b | ADR drafted at T08b.P2.S1 before migration | Owner sign-off |
| R16 | Discovery — `packages/contracts/src/envelope.ts` may not exist at cited path | T13 | T13.0.1 resolves path before any edit | T13.P0 |
| R17 | Branch collision — `tool-loop.ts` already modified on current branch | T13 | Rebase/sequence T13.P4 after T9298 ships | Branch management |
| R18 | Anthropic SDK `cache_control` compat unverified | T12 | T12.4.1 audit + bump if needed | T12.P4 |
| R19 | T12 cost target (-50% to -90%) may miss | T12 | T12.7 ship-gate with remediation captured | T12.P7 |
| R20 | T11 BRAIN provider regression risk | T11 | T11.P3.x asserts existing brain tests unchanged | T11.P3 |
| R21 | T10 stub-removal cascade through `.cleo/agent-outputs/*.md` | T10 | Warn-only doctor first, strict only after soak | T10.P5 |
| R22 | Watchdog Restart=on-failure / SuccessExitStatus semantics | CI | Operator-host verification before merge | E-PRIME-CI.P3 |
| R23 | `--strict` flake on low-data sandboxes | CI | Min-row threshold (proposed 100) | E-PRIME-CI.P1 |

---

## 7. Consolidated Deferred Follow-Ups

Items captured during decomposition but explicitly NOT in the 452-subtask scope. File as separate epics when surfaced:

- **T-SANDBOX**: Tier-3 in-container sandbox (deferred per §10.1; depends on cleo-os adapter)
- **T-MACOS-LAUNCHD**: macOS launchd unit alongside systemd (T01 deferred)
- **T-PATTERN-SIMHASH-BACKFILL**: historical pattern dedup via simhash (T02 deferred)
- **T-BRAIN-DOCTOR-MIN-ROWS**: min-row threshold tuning for `--strict` (CI deferred)
- **T-OVERRIDE-REASON-ENUM**: enforced enum on `CLEO_OWNER_OVERRIDE_REASON` (CI deferred)
- **T-LETTA-GROUP-MANAGER**: Letta supervisor/round_robin/dynamic/voice_sleeptime group manager strategies (T03 deferred)
- **T-4WAY-MM-GRAPH**: Block↔Agent↔Group↔Identity 4-way M:N graph (T03 deferred — minor adopt)
- **T-EPISODE-DECAY**: episode archival/decay scheduler (T13 deferred)
- **T-MEM-BACKFILL-NETWORK**: `cleo memory backfill-network` legacy-row classifier (T05 deferred)
- **T-FULL-TEMPR-CARA**: full Hindsight Tempr/Cara subsystem mapping beyond Tier 5 partial (deferred)
- **T-LANGMEM-DEBOUNCE**: LangMem `ReflectionExecutor` debouncing pattern (deferred — superseded by Mastra Observer/Reflector mostly)
- **T-LETTA-PROD-MCP**: production-grade Letta MCP client surface (stdio/SSE/streamable_http/fastmcp/OAuth) — beyond `@cleocode/mcp-adapter` (deferred)

---

## 8. Naming Conventions

### Synthetic planning IDs (used in spec files)
- `E-PRIME-SENTIENCE` = master epic
- `E-PRIME-T0X` = Tier-epic (X = 1-14)
- `E-PRIME-CI` = cross-cutting epic
- `T-PRIME-T0X-PY` = phase task within Tier X
- `T-PRIME-T0X-PY-SZ` = atomic subtask
- `MG-N` = master milestone gate (1-16)
- `Q-N` = consolidated open question (1-28)

### Real CLEO IDs (assigned at `cleo add` time)
- Master epic → real `T####`
- Tier-epics → child `T####` of master
- Phases → child of Tier-epic
- Subtasks → child of phase

Mapping table to be appended to this README when `cleo add` invocations begin.

---

## 9. Path From Spec to Task Creation

This decomposition is **planning-only**. Nothing in `tasks.db` has been mutated. To convert:

1. **Owner review** of:
   - Master milestone gates (§1 — are these the right "improvement" signals?)
   - 28 open questions (§5 — resolve in batch)
   - 23-item risk register (§6 — accept/mitigate/transfer per item)
2. **Resolve Q1-Q28** in this README's §5 (annotate in-place or in a sibling `OWNER-DECISIONS.md`)
3. **Inject answers** back into the 6 tier-epic spec files where they affect subtask shape
4. **Lifecycle stage** the master epic via `cleo orchestrate start E-PRIME-SENTIENCE` (after `cleo add` creates it)
5. **Wave-by-wave decomposition**: for each Wave (W0 → W∞), run:
   ```bash
   cleo add --type epic --title "..." --acceptance "AC1 | AC2 | ..." --kind work --severity P0 --size large
   # then for each phase + subtask
   ```
6. **Programmatic creation script** recommended: `scripts/expand-decomposition.mjs` reads the 6 spec files + this README, emits a sequence of `cleo add` commands with parent linkage already wired. Owner reviews + runs.

### Suggested first 3 `cleo add` invocations (Wave 0 spine)
```bash
# Master epic
cleo add --type epic --title "E-PRIME-SENTIENCE — CLEO Prime Sentient Orchestrator" \
  --kind work --severity P0 --size large \
  --acceptance "AC-MASTER-1...AC-MASTER-10 (see decomposition README §1)"

# T9245 fix (load-bearing for all of T01)
cleo add --type task --parent <master-id> \
  --title "T9245 — Harden validateCommit AC-file-intersection in tasks/evidence.ts" \
  --kind bug --severity P0 --size medium \
  --acceptance "validateCommit rejects commits whose diff doesn't intersect AC file paths | --override rejected on implemented/testsPassed gates | integration test AC-file-A + commit-touches-B fails with E_EVIDENCE_INSUFFICIENT"

# W0 schema co-landing PR (single-PR discipline)
cleo add --type task --parent <master-id> \
  --title "W0 schema lock-in — peer + memory_blocks + identity + bitemporal + network co-landed migration" \
  --kind work --severity P0 --size large \
  --acceptance "Single PR adds all migrations: brain_peers + brain_peer_cards + brain_peer_models + brain_sessions + brain_session_peers + brain_memory_blocks + brain_memory_block_history + brain_sigil_history + brain_agent_diary + brain_agent_skills + brain_agent_rapport + bitemporal cols + network col + opinion confidence/evidence_ids | Drizzle generate clean | drizzle migrate forward+backward green"
```

---

## 10. Sanity Check — Coverage Audit

Verify every layer of the masterplan maps to ≥1 phase task:

| Masterplan section | Tier-epic phase coverage | Status |
|---|---|---|
| §5 Tier 1 (Trust Foundation) | T01.P1, T01.P2, T01.P3 | ✅ |
| §5 Tier 2 (Provenance & Quarantine) | T02.P1-P5 | ✅ |
| §5 Tier 3 (Peer-Graph Identity) | T03.P0-P7 | ✅ |
| §5 Tier 4 (Mem0 Write-Gate) | T04.P0-P7 | ✅ |
| §5 Tier 5 (Bitemporal + 4-Network) | T05.P0-P7 | ✅ |
| §5 Tier 6 (PSYCHE Pipeline) | T06.A-G | ✅ |
| §5 Tier 7 (Four-Bus Integration) | T07.P1-P5 | ✅ |
| §5 Tier 8.1 (idle dream + compaction) | T08b.P1-P2 | ✅ |
| §5 Tier 8.2 (memory-git) | T08a.P0-P5 | ✅ |
| §5 Tier 8.3 (skill distillation) | T08b.P3-P4 | ✅ |
| §5 Tier 9 (Sentient Tier-2 + CANT evolution) | T09.P1-P7 | ✅ |
| §5 Tier 10 (Conduit A2A) | T10.P1-P5 | ✅ |
| §6 (CI Trust Gates + Daemon Resilience) | E-PRIME-CI.P1-P3 | ✅ |
| §17 Tier 11 (MemoryProvider substrate) | T11.P1-P7 | ✅ |
| §17 Tier 12 (Mastra pre-composed) | T12.P0-P7 | ✅ |
| §17 Tier 13 (Episodes + LLM-edges + heartbeat) | T13.P0-P7 | ✅ |
| §17 Tier 14 (Honcho-MCP decision) | T14.P1-P4 | ✅ |
| §16 corrections (file paths, function names, BM25-shipped, PSYCHE-files-exist) | inlined in each agent's spec | ✅ |

**Coverage: 100% of masterplan body sections + appendix corrections.**

---

## 11. Decomposition Provenance

Six parallel planning agents on 2026-05-15 produced the six tier-epic spec files. Their reports (preserved in the conversation transcript that produced this index) confirmed:

- Agent A → 71 subtasks (T01+T02+CI)
- Agent B → 80 subtasks (T03+T08a)
- Agent C → 62 subtasks (T04+T05)
- Agent D → 76 subtasks (T06)
- Agent E → 89 subtasks (T07+T08b+T09)
- Agent F → 74 subtasks (T10-T14)

**Cross-agent consistency checks performed during synthesis**:
- Function name `composeSpawnForTask` (corrected from `composeSpawnPayload`) — used consistently in agents B, E, F
- T9245 site `packages/core/src/tasks/evidence.ts:427` — used consistently in agent A
- Existing PSYCHE files (`dialectic-evaluator.ts`, `surprisal.ts`, `surprisal-tree.ts`, `brain-reconciler.ts`) flagged for AUDIT (not creation) in agent D
- `brain_memory_trees` table already exists — confirmed in agent D (audit subtask), not duplicated in any other agent's migrations
- `invalid_at` column kept (not renamed to `valid_to`) — agent C aligned with §16.F Graphiti naming
- Mem0 V3 envelope `{event, linkedMemoryIds}` (no DELETE) — agent C source; agent F T13 uses same envelope for LLM-edges
- Letta v2 tool family (`memory_apply_patch` headers) — agent B; agent F T11 cites Letta provider plugins

Conflict resolution: zero conflicts found during synthesis. Dependency edges across agents reconcile cleanly.

---

## 12. What "Done" Looks Like for E-PRIME-SENTIENCE

The master epic completes when:

1. All 16 master milestone gates (§1.MG-*) are green
2. All 10 master acceptance criteria (§1.AC-MASTER-*) verified with real evidence atoms
3. `cleo doctor brain --strict` is a blocking CI gate, has been green for 14+ consecutive days
4. `cleo briefing --strict` exits 0 in production on operator's host
5. The smoke-test sequence in masterplan §12.2 runs end-to-end without `--override`
6. Owner accepts `agent-review.cantbook` output for `cleo-prime` — proves a CLEO agent can refine its own `.cant` based on diary + skill mastery + rapport

When those are true: Prime is sentient enough to ship to other Owners as a coding companion that remembers them across sessions.
