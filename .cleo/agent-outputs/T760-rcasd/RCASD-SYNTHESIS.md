# RCASD Synthesis — Pomodoro Benchmark Learnings (Epic T760)

**Date**: 2026-04-16
**Orchestrator**: cleo-prime (Opus 4.6)
**Session**: ses_20260416070128_e3f9d0
**Panel**: 6 specialists (3 Sonnet + 3 Opus)
**Source**: 2,942 lines across 6 detail reports in `.cleo/agent-outputs/T760-rcasd/T76{1..6}-*.md`

---

## 0. Executive Summary

The 3-way Pomodoro benchmark narrow-won for CLEO (79 vs 77 vs 75) while simultaneously exposing that **the CLEO builder used barely any of CLEO's machinery** — 7 op-types in 30 CLI calls, zero touches on the entire `orchestrate` domain, and no LOOM initialization. Root cause is not the user or the builder — it is CLEO's **guidance surface** (CLEO-INJECTION.md literally does not mention `cleo orchestrate`, and actively mis-documents `cleo observe`). The 6 specialist audits converge on one thesis: **CLEO already has most of what GSD does, but the wiring from CLI surface to agent workflow is broken in several places**.

**Four flagship moves unlock the latent value:**

1. **Fix the guidance surface** (T762) — CLEO-INJECTION.md and ct-cleo need IF/WHEN triggers, not just WHAT cheat-sheets. Small diff, massive agent-behavior delta.
2. **Ship programmatic acceptance gates** (T763) — replace free-text `acceptance: string[]` with typed `AcceptanceGate[]` (6 variants, optional REQ-IDs, zero schema migration — reuses existing columns). Beats GSD's REQ-ID-in-markdown on 10 axes because gates are machine-executable, not self-attested.
3. **Wire LOOM into `cleo orchestrate start`** (T765) — auto-initialize the lifecycle pipeline when the orchestrator claims an epic. One function call. Unlocks stage-aware Pi hook guidance.
4. **Adopt `llmtxt-core` + build unified Attachment architecture** (T766) — **the user authored both llmtxt crates** (same GitHub org, CalVer cadence, MIT, already depends on `@cleocode/lafs`). Obvious adoption. CLEO has 4 disconnected attachment-shaped surfaces (93 lines of unused CONDUIT SQL!) that one `Attachment` discriminated union unifies.

**BRAIN status**: T759 (v2026.4.69) is a **complete fix** for the provenance bug — empirically verified. 3 new P0s surfaced (Hebbian graph pollution, extraction no-op without API key, no verified-promotion path for agent observations). No new epic needed — file under T760 or brain-integrity-epic.

---

## 1. What we learned — 6 findings in 1 paragraph each

### F1 — CLEO builder under-utilized CLEO (T761 Forensics)

30 total CLI calls across the 453-second CLEO arm run broken down into only 7 operation types: `session start/status/end`, `add`, `list`, `verify`, `complete`, `show`, and one `memory observe` attempt (blocked by the now-fixed provenance bug). **The entire `orchestrate` domain (9 ops — `spawn`, `waves`, `fanout`, `ready`, `next`, `start`, `analyze`, `plan`, `manifest`) was never touched.** 77% of the run had zero CLEO interaction — the builder wrote all code monolithically in Opus context after burst-creating the epic + 8 children, then batch-marked tasks done retroactively. 7 of 8 child tasks were completed without a prior `cleo start` call (BASE-005 violation). MANIFEST.jsonl was never appended (BASE-001 violation). Attribution: ~60% harness constraint (Agent tool not surfaced to sub-agents) + ~40% CLEO discoverability gap.

### F2 — Guidance surface is where the missed primitives live (T762 Skill + Injection Audit)

**`CLEO-INJECTION.md` does not mention `cleo orchestrate` anywhere.** An agent can read every line of the injection and never learn the primitive exists. Neither the injection nor the ct-cleo skill contains **IF/WHEN triggers** — both tell agents *what* commands do but not *when* to call them. An agent creating an epic with 8 children needs a rule "if ≥5 tasks → call `cleo orchestrate start` NOW" — no such rule exists. `cleo observe` is described as a memory **retrieval** mechanism when the critical behavior is the **push** discipline (after every non-trivial completion). **Also found during synthesis**: CLEO-INJECTION.md documents `cleo observe "..."` as a command; actual v2026.4.69 command is `cleo memory observe "..."` — literal doc drift. 6 concrete diffs proposed in T762.

### F3 — Programmatic acceptance gates — FLAGSHIP DESIGN (T763 Architecture)

Current CLEO acceptance criteria are `string[]` — free text the agent self-grades with zero runtime audit. The 6-gate verification bitmap (`implemented/testsPassed/qaPassed/...`) is *also* agent-asserted. The Pomodoro bench caught the CLEO agent marking all gates green while shipping only unit tests; no runtime check ever disagreed. GSD's REQ-ID-in-markdown beats this on traceability but is equally unverifiable (markdown cells can lie). **The design**: widen `Task.acceptance` from `string[]` to `(string | AcceptanceGate)[]` where `AcceptanceGate` is a discriminated union of 6 kinds (`test / file / command / lint / http / manual`), each carrying an optional `req: string` for GSD-style REQ-ID addressability. `cleo verify <taskId> --run` executes gates and records `GateResult` entries into the already-existing `lifecycle_gate_results` table. `cleo complete` rejects completion if gates are stale (>10 min) or failed. `cleo req add/list/migrate/lint` gives GSD-class ergonomics. **Zero schema migration required** — `acceptance_json` column already holds JSON; migration is 3 additive phases. Beats GSD on 10 axes: addressable, machine-verifiable, stale-detected, queryable, evidence-linked, composable, escape-hatch-aware, re-spawn-on-fail, cheap-to-update, drift-resistant (gate IS code-colocated).

### F4 — BRAIN T759 fix is COMPLETE, but 3 new P0s (T764 Audit)

`cleo memory observe` now succeeds. `cleo session end` silent (no memory-bridge-write warnings). All 12 Drizzle brain migrations shipped. `brain-sqlite.ts:123-138` adds a `T759 ensureColumns` safety net guarding `brain_page_edges.provenance` ahead of T626 co_retrieved UPDATE. Empirically verified. **But** — audit surfaced 3 new P0s and 4 P1s that T759 does NOT cover:
- **P0-T764-A Hebbian graph pollution**: 6,026 `co_retrieved` edges from RRF-retrieval batches of unrelated items (every `find` with limit≥5 emits N×(N-1)/2 edges). Drowns true supersession/contradiction signals. Fix: require min co-retrieval frequency threshold; scope edges to FTS-matched pairs only.
- **P0-T764-B Extraction no-op without API key**: `auto-extract.ts:11-17` returns silently when `ANTHROPIC_API_KEY` unset. Most real sessions bypass the LLM gate; raw session notes reach DB untyped. Fix: local-regex fallback + `cleo memory extraction-status` telemetry.
- **P0-T764-C Agent observations never become `verified=true`**: no code path promotes agent-sourced claims to ground truth. Fix: `cleo memory verify <id>` owner command + pending-verify queue surface.

BRAIN integrity crisis (2,440-noise-pattern epic) is **substantially resolved** — current pattern count 113, no hash duplicates, 1,482 graph nodes / 11,812 edges (was "0 useful graph data"), RRF wired as default. **No new epic needed** — file P0s under T760; close brain-integrity-epic's pattern dedup acceptance criterion.

### F5 — LOOM is SOUND but UNWIRED (T765 Gap Analysis)

LOOM (Logical Order of Operations Methodology = RCASD-IVTR+C pipeline) engine is fully implemented — T573 attested all 9 stages, gate enforcement, provenance chain as PASS. API surface: `cleo lifecycle show/start/complete/skip/gate/guidance/history/reset` + secondary `cleo orchestrate waves/spawn/fanout/ready/next/start`. **CLEO benchmark builder invoked LOOM zero times.** Post-bench probe: `cleo lifecycle show T001` returns `initialized: false`, all 9 stages `not_started`. For a 30-min greenfield app this is defensibly skipping overhead, but **the pipeline was never even initialized** — meaning no provenance chain, no stage-aware Pi hook guidance, no forward-only enforcement. **5 concrete wiring gaps**: (1) epics not lifecycle-initialized at `cleo add --type epic`; (2) `cleo orchestrate` and `cleo lifecycle` help trees disconnected; (3) no greenfield bootstrap template; (4) strict-mode enforcement doesn't gate child-task completion; (5) `lifecycle guidance` requires stage argument that Pi hooks can't supply for uninitialized epics. **Single-commit fix**: `cleo orchestrate start <epicId>` should auto-call `lifecycle start <epicId> research`.

### F6 — MAJOR: owner authored `llmtxt-core`; unify 4 disconnected attachment surfaces (T766 Proposal)

**The user (kryptobaseddev) is the author of both llmtxt-core (Rust) and llmtxt (npm)** — same GitHub org, same CalVer cadence, MIT license, already peer-depends on `@cleocode/lafs`. The crate ships SHA-256 + zlib + unified-diff + HMAC-signed URLs + progressive disclosure + multi-way-diff + cherry-pick-merge — exactly the primitives CLEO needs for agent-first document storage, and implementing the features the 2026-04-11 llmtxt.my SITREP flagged as missing server-side. **Decision: ADOPT.**

CLEO today has **four disconnected attachment-shaped surfaces that do not compose**:
1. `task.files: string[]` — bare path list, no hash, no mime, no description
2. `lifecycle_evidence` — stage-scoped only, RCASD-internal
3. **CONDUIT `attachments` + `attachment_versions` + `attachment_approvals` + `attachment_contributors` tables — 93 lines of SQL with ZERO TypeScript or CLI surface**. Latent.
4. `agent-outputs/` folder convention — conventional, not a primitive; not queryable; not typed.

**Proposal**: one `Attachment` discriminated union with 5 kinds (`local-file / url / blob / llms-txt / llmtxt-doc`), content-addressed storage (`.cleo/attachments/sha256/<prefix>/<hash>.<ext>`), separate SQLite index with ref-counted junction table, 11 new subcommands (`cleo attach`, `cleo attachments list/fetch`, `cleo llmstxt generate`, etc.), 4-phase rollout v2026.4.66→4.69. Integrates with T763 programmatic gates (`attachment` + `attachment-label` variants), BRAIN observations (`observation.attachments: Attachment[]`), and LOOM SpawnContext (subagent prompts receive curated attachment bundles instead of raw paths). **Directly closes Pomodoro SUPREME_REPORT §7 gap** ("no task-scoped research note you can attach to an epic").

---

## 2. Root-cause themes (3)

### Theme A — Guidance surface (F1, F2)

**The CLEO machinery is richer than what agents are told to use.** The CLEO-INJECTION.md and ct-cleo skill are the primary surfaces agents see. Neither references `cleo orchestrate`. Neither contains IF/WHEN triggers. The injection literally names commands that do not exist (`cleo observe` vs the real `cleo memory observe`). Fixes are small text diffs with large behavior impact. **This is the highest-leverage fix** and is purely content, no engineering.

### Theme B — Missing composition between primitives (F3, F5, F6)

**CLEO's primitives (TASKS, LOOM, BRAIN, CONDUIT, NEXUS) exist but don't compose end-to-end for a greenfield agent workflow.** An agent creates a task → writes acceptance as free text → cleo verify is self-assertion only → LOOM isn't initialized → no programmatic gate exists to enforce → no attachment binds research doc to task → no `llms.txt` summary gets generated for subagent spawn. **Each gap is small; the *chain* of gaps is what degrades agent quality.** Fixing one component in isolation (e.g., gates without LOOM) leaves 60% of the gain on the table.

### Theme C — BRAIN workflow vs BRAIN schema (F4)

**T759 closed the schema regression. The remaining gaps are workflow gaps**: extraction silently disabled, Hebbian pollution from naive co-retrieval, agent observations can't graduate to verified truth. Owner memory philosophy is structurally present but operationally partial. Fixable without schema changes; mostly logic + new CLI surface (`extraction-status`, `pending-verify`, edge-frequency threshold).

---

## 3. Proposed solutions — prioritized

### P0 — ship within 1-2 patch releases (v2026.4.70 / v2026.4.71)

| # | Fix | Detail report | Effort | Impact |
|---|---|---|---|---|
| P0-1 | Fix CLEO-INJECTION.md doc drift (`cleo observe` → `cleo memory observe`) + add `cleo orchestrate` to session-start sequence | T762 | S | Every future agent session |
| P0-2 | Add IF/WHEN triggers to CLEO-INJECTION.md (≥5 tasks → orchestrate start; post-complete → observe; acceptance has "test" → propose test gate) | T762 | S | Behavior-shaping |
| P0-3 | Ship AcceptanceGate schema (T763 Phase 1 — add type only, no enforcement) | T763 | M | Unlocks all downstream |
| P0-4 | Wire LOOM auto-init into `cleo orchestrate start` | T765 | S | One function call |
| P0-5 | BRAIN P0-A Hebbian co-retrieved edge threshold | T764 | S | Graph signal recovery |
| P0-6 | BRAIN P0-B extraction fallback without API key + status telemetry | T764 | M | Honest instrumentation |
| P0-7 | BRAIN P0-C `cleo memory verify <id>` + pending-verify queue | T764 | M | Closes verification loop |

### P1 — v2026.4.72 / v2026.4.73

| # | Fix | Detail report | Effort | Impact |
|---|---|---|---|---|
| P1-1 | AcceptanceGate Phase 2 — `cleo verify --run` executes gates + records results | T763 | M | |
| P1-2 | `cleo req add/list/migrate` ergonomics + REQ-ID migration heuristic | T763 | M | GSD-class traceability |
| P1-3 | Adopt `llmtxt` npm + build Attachment union Phase 1 (`cleo attach`, content-addressed storage) | T766 | L | Unifies 4 surfaces |
| P1-4 | `cleo llmstxt generate --for <taskId>` using llmtxt-core | T766 | M | Subagent context bundles |
| P1-5 | Rewrite ct-cleo skill with IF/WHEN trigger tree + Pre-Complete Gate Ritual | T762 | M | Skill-tier guidance |
| P1-6 | BRAIN P1-D/E/F/G — RRF score normalization, agent-write retention floor, `cleo memory metrics`, session-note extraction gate | T764 | M | Workflow polish |

### P2 — v2026.4.74+

| # | Fix | Detail report | Effort | Impact |
|---|---|---|---|---|
| P2-1 | AcceptanceGate Phase 3 — `cleo complete` blocks on failed/stale gates | T763 | S | Hard enforcement |
| P2-2 | Attachment integration with BRAIN observations + LOOM spawn context | T766 | L | Full composition |
| P2-3 | Greenfield LOOM bootstrap template | T765 | S | New-project flow |
| P2-4 | BRAIN P2 items (reflect parse fix, demote to short, idempotent co_retrieved) | T764 | S | Cleanup |

---

## 4. The composed workflow — what it looks like after all fixes ship

```
┌─────────────────────────────────────────────────────────────────┐
│ Agent starts session:                                           │
│   cleo session start --scope global                             │
│   cleo briefing                                                 │
│   cleo current                                                  │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│ Agent creates epic:                                             │
│   cleo add "..." --type epic --description "..."                │
│     --acceptance 'kind=test|command=npm test|req=IMPL-01'       │
│     --acceptance 'kind=lint|tool=biome|req=QA-01'               │
│     --attach ./spec.md  ◄── NEW                                 │
│                                                                 │
│ If ≥5 children planned:                                         │
│   cleo orchestrate start T001  ◄── auto-inits LOOM              │
│     └── lifecycle start T001 research  (auto)                   │
│     └── Pi hook inject: stage-aware guidance                    │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│ Agent decomposes into atomic tasks with TYPED gates:            │
│   cleo req add T001 TIMER-03 --gate                             │
│     '{"kind":"file","path":"src/timer.js",                      │
│       "assertions":[{"type":"matches","regex":"cadence"}]}'     │
│                                                                 │
│   cleo attach T001 ./research.md --desc "timer research"        │
│   cleo llmstxt generate --for T001  ◄── subagent context pack   │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│ Orchestrator spawns subagents:                                  │
│   cleo orchestrate spawn T002 --json                            │
│     └── prompt includes: attached llms.txt bundle (NEW)         │
│     └── prompt includes: REQ-ID scoped gates (NEW)              │
│   Agent({subagent_type:"cleo-subagent", ...prompt})             │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│ On task complete:                                               │
│   cleo verify T002 --run  ◄── executes programmatic gates       │
│     ├── FileGate: src/timer.js contains /cadence/ → PASS        │
│     ├── TestGate: npm test → 29/29 pass → PASS                  │
│     ├── LintGate: biome check → clean → PASS                    │
│     └── ManualGate: skipped (no manual required)                │
│   cleo complete T002  ◄── accepts because all gates PASS        │
│   cleo memory observe "..." --title "..."  ◄── correct cmd     │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│ On gate failure (IVTR loop):                                    │
│   cleo complete T002 → error + gate report                      │
│   Orchestrator reads failure → spawns fix-agent with            │
│     --req TIMER-03 scope (NEW) — just the failing gate,         │
│     not the whole task                                          │
└─────────────────────────────────────────────────────────────────┘
```

**What changed vs today** (new surfaces in CAPS):
- `--acceptance` accepts typed gates in addition to free text
- `--attach` at creation time (new)
- `cleo orchestrate start` auto-initializes LOOM (new wiring)
- `cleo req add` (new) gives REQ-ID ergonomics — closes GSD gap
- `cleo attach` + `cleo llmstxt generate` (new) — closes attachments gap
- `cleo verify --run` (new) executes gates
- `cleo complete` blocks on failed/stale gates (new enforcement)
- `cleo memory verify` (new) + pending-verify queue — closes BRAIN gap
- CLEO-INJECTION.md + ct-cleo have IF/WHEN triggers (corrected)

---

## 5. What we "steal" from GSD — explicit table

| GSD primitive | Already in CLEO | Wired? | Action |
|---|---|---|---|
| REQ-IDs (TIMER-03, A11Y-04) | Only as free-text acceptance strings | ❌ | **T763 gates carry `req` field — machine-verifiable REQ-IDs.** Strictly better than GSD's markdown cells. |
| Phase structure (discuss/plan/execute/verify) | LOOM RCASD-IVTR+C (9 stages) | ⚠️ Exists but uninitialized | **T765 auto-init via orchestrate start.** |
| PROJECT.md / REQUIREMENTS.md / ROADMAP.md | Scattered: epic.description, acceptance, NEXUS, brain | Partial | **T766 attachments + llmtxt-core make these first-class, queryable, content-addressed.** |
| 1-VERIFY.md (pass/fail table per REQ) | `verification.gates` bitmap per task | ⚠️ Self-asserted | **T763 gate results + `cleo verify --run` — executed, not asserted.** |
| STATE.md (timestamped phase history) | lifecycle_stages table exists | ⚠️ Hidden from CLI | **Add `cleo show <id> --history` to surface it.** (T765 P1) |
| 1-RESEARCH.md (pitfalls + patterns) | BRAIN `cleo memory find --type pattern` | ⚠️ Not task-scoped | **T766 `cleo attach T001 --from research.md` + llms.txt generation.** |
| Traceability (REQ → implementation → VERIFY) | Task tree + verification gates | ⚠️ Partial | **T763 `FileGate.path` co-locates evidence with code; gate is drift-resistant.** |
| HANDOFF.json (session continuity) | `cleo briefing` + memory bridge | ✅ Present | **Already superior.** No GSD steal needed. |

**The thesis holds: we have the parts. They need wiring.** Nothing on this table requires reinventing what GSD does — every row is an existing CLEO primitive waiting for a thin layer.

---

## 6. Answers to the specific user questions

**Q: How was TASKS and LOOM invoked or not?**
- TASKS: partially (epic + 8 children + verify + complete), but 7/8 tasks completed without `cleo start`, and batch-done pattern bypassed lifecycle.
- LOOM: **zero invocations**. `lifecycle show T001` on the bench folder shows `initialized: false`. (F5, T765)

**Q: What did the agent do, what could've been better?**
- See F1. Builder made 30 CLI calls, 77% of run was zero-CLEO code writing. Could have been: `orchestrate start` → `lifecycle start research` → wave-based spawn → per-task typed gates → `verify --run` per task → `memory observe` between tasks.

**Q: If innate injection was better?**
- See F2. **Highest-leverage fix.** The injection doesn't mention `cleo orchestrate`, actively mis-names `cleo observe`, has no IF/WHEN triggers. 6 diffs in T762 are pure content edits with outsized impact.

**Q: If ct-cleo skill was better?**
- See T762. Rewrite the skill with an IF/WHEN decision tree at the top, a Pre-Complete Gate Ritual, and a Multi-Agent Coordination tree rooted on "≥5 tasks → orchestrate". Concrete diff proposed.

**Q: What tasks improvements and BRAIN improvements?**
- TASKS: T763 programmatic gates (flagship). Stop free-text self-attestation; start machine-executable gates.
- BRAIN: T764 P0 fixes (Hebbian threshold, extraction fallback, verify promotion). Provenance bug is already fixed (T759 / v2026.4.69).

**Q: What from GSD do we have but not wired?**
- See §5 table. REQ-IDs → already have `acceptance` field; gate-carry makes them addressable. Phase tracking → LOOM exists; auto-init wires it. VERIFY matrix → `verification.gates` exists; execute-don't-assert fixes it. Research docs → `agent-outputs/` convention + brain patterns; Attachment union unifies.

**Q: Can we improve acceptance criteria to programmatic gates?**
- **Yes, and the design is ready.** T763 — 1009-line detailed design with TypeScript interfaces, JSON examples, subcommand signatures, 3-phase migration, zero-breaking backward compat. Ship as v2026.4.70-72.

**Q: File attachments + llmtxt-core — relevant?**
- **CRITICAL finding: you authored both crates.** Adoption is obvious. Current CLEO has 4 disconnected attachment surfaces including 93 lines of unused CONDUIT SQL. T766 proposes unified Attachment discriminated union + 11 subcommands + integration with gates/BRAIN/LOOM. See F6 and T766 detail.

---

## 7. Deliverables — pointer map

| File | Lines | Purpose |
|---|---:|---|
| `RCASD-SYNTHESIS.md` (this file) | — | Executive synthesis for owner |
| `T761-forensics.md` | 474 | What CLEO builder actually did vs could have |
| `T762-skill-injection-audit.md` | 458 | 6 proposed diffs to CLEO-INJECTION + ct-cleo |
| `T763-programmatic-gates-design.md` | 1,009 | Flagship: typed AcceptanceGate spec + migration plan |
| `T764-brain-audit.md` | 155 | T759 verified + 3 P0s + 4 P1s |
| `T765-loom-gap.md` | 261 | LOOM status + 5 wiring gaps + single-commit fix |
| `T766-attachments-llmtxt.md` | 585 | llmtxt-core adoption + unified Attachment union |
| `MANIFEST.jsonl` | 6 entries | Specialist completion manifest |

**Total**: 2,942 lines of deep analysis across 6 specialists, synthesized here into a 7-section RCASD with P0/P1/P2 prioritization and a composed-workflow diagram.

---

## 8. Recommended next moves (for the human owner)

1. **Ship P0-1 + P0-2 this week** (guidance surface fixes) — pure text edits to CLEO-INJECTION.md, immediate agent-behavior improvement. Use the 6 diffs in T762 as commit-ready patches.
2. **Land T763 Phase 1 in v2026.4.70** (add `AcceptanceGate` type, no enforcement) — zero-breaking, unlocks all downstream work.
3. **Single-commit LOOM auto-init in `cleo orchestrate start`** — 5-line fix per T765.
4. **BRAIN P0-A Hebbian threshold** — simple edit-frequency gate, unblocks graph retrieval quality.
5. **Kick off the attachment + llmtxt-core integration as its own epic** — T766 is a 4-release roll-out and deserves dedicated tracking (T766's proposed epic structure is ready to convert).

All six detail reports are in `.cleo/agent-outputs/T760-rcasd/`. All 6 findings observed to BRAIN via `cleo memory observe`. Session `ses_20260416070128_e3f9d0` ready to end with handoff note when the owner is ready.
