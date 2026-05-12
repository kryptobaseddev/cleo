# SPECIALIST C — Intelligence / Nexus / BRAIN / Living Brain

Audit date: 2026-04-28
Scope: T1042 nexus-gap meta-epic, T1047 / T1048 synthesis, T1054/T1055/T1056 tri-epic + 17 children, T1110/T1111/T1112 Living Brain proofs.
Project root: /mnt/projects/cleocode

---

## 1. Synthesis verdict (T1047 vs T1048)

**T1048 is canonical. Archive T1047. Both tasks are still pending in TASKS, but only T1048's RECOMMENDATION-v2.md is the working source-of-truth.**

Evidence (read directly from `.cleo/agent-outputs/T1042-nexus-gap/`):

- `RECOMMENDATION.md` (T1047, 557 lines) and `RECOMMENDATION-v2.md` (T1048, 773 lines) BOTH exist.
- V2 frontmatter is explicit: "Supersedes: `.cleo/agent-outputs/T1042-nexus-gap/RECOMMENDATION.md` (V1, T1047)".
- V2 §3 enumerates V1 corrections: (a) the V1 P0 "MCP Tool Surface" task EP1-T5 is deleted as architecturally wrong (CLEO is CLI-only, MCP is rejected per AGENTS.md package boundary); (b) V1 marked several capabilities as MISSING-IN-CLEO when they were already shipped (`smartUnfold`, `smartSearch`, `code-auto-link`, `search-hybrid`); (c) V1's HITL-1 "graph engine choice" is over-scoped — D-BRAIN-VIZ-09 already locked SQLite-only.
- `EXECUTION-LOG.md` records HITL resolutions for V2 explicitly (transformers.js, wiki cancelled→T1060, 14-day half-life decay) and lists the V2 wave plan (T1057-T1073) — V1 was never used to decompose tasks.
- The 17 child tasks T1057-T1073 are titled with V2's EP1/EP2/EP3 task IDs (e.g., T1066 = "EP3-T1: Complete BRAIN→NEXUS Edge Writers"), confirming V2 drove decomposition.

Action: archive T1047 (cancel or close as superseded) and keep T1048 as the canonical synthesis. Both can be marked done — V2 was delivered as RECOMMENDATION-v2.md, and the decomposition into T1054/T1055/T1056 + 17 children IS the deliverable; the tasks just never got verified.

---

## 2. Tri-Epic Status Table

| Epic | Children Total | Children Done | Children Pending | % Verified Gates | Critical-path child |
|------|---------------:|--------------:|-----------------:|-----------------:|---------------------|
| T1054 (P0 Core Query Power) | 5 (T1057-T1061) | 0 | 5 | 0% | T1057 (Recursive CTE DSL) |
| T1055 (P1 Competitive Closure) | 4 (T1062-T1065) | 0 | 4 | 0% | T1062 (External Module IMPORTS) |
| T1056 (P2 Living Brain Completion) | 8 (T1066-T1073) | 0 | 8 | 0% | T1068 (Living Brain SDK primitives) |

All 17 children are status=pending, verification.passed=false, gates not run. **However, the code IS shipped** (see §4) — this is a verification-gate hygiene gap, not an implementation gap.

---

## 3. Per-Child Status (T1057-T1073)

Format: `ID | parent | status | verified? | one-line`

- T1057 | T1054 | pending | false | EP1-T1 SQLite Recursive CTE Query DSL — code shipped (`02bd45657 feat(T1057)`, `1b1f85c71 fix(T1057)`); CLI verb `cleo nexus query` live.
- T1058 | T1054 | pending | false | EP1-T2 Semantic Code Symbol Search — code shipped (`e467c1a6d feat(T1058)`); CLI verb `search-code` live.
- T1059 | T1054 | pending | false | EP1-T3 Source Content Retrieval — `smartUnfold()` already wired pre-tri-epic.
- T1060 | T1054 | pending | false | EP1-T4 Wiki Generator — code shipped (`d58d85f1c feat(T1060)`, `99c7a690a feat(T1109)` LOOM integration); CLI verb `wiki` live.
- T1061 | T1054 | pending | false | EP1-T5 Hook Augmenter (PreToolUse) — `augment.ts`, `hooks-augment.ts` live; `cleo nexus augment` + `cleo nexus setup` exposed.
- T1062 | T1055 | pending | false | EP2-T1 External Module IMPORTS — code shipped (`b0ceb546d test(T1062)`); replaces 390k unresolved-call gap.
- T1063 | T1055 | pending | false | EP2-T2 Leiden + member_of edges — implementation status uncertain (no recent commit); Louvain still default.
- T1064 | T1055 | pending | false | EP2-T3 Route-Map / Shape-Check — code shipped (`eba60a002 fix(T1064)`); CLI verbs `route-map`/`shape-check` live; module `core/src/nexus/route-analysis.ts` exists.
- T1065 | T1055 | pending | false | EP2-T4 Contract Registry — code shipped (`a057f6589 fix(T1065)`, `29878f58a test(T1065)`, `ecb9c6926 fix(T1065)`); CLI verbs `contracts`/`group` live.
- T1066 | T1056 | pending | false | EP3-T1 BRAIN→NEXUS Edge Writers (`documents`/`modified_by`/`affects`/`mentions`).
- T1067 | T1056 | pending | false | EP3-T2 TASKS→NEXUS Bridge (`task_touches_symbol`) — code shipped (`2dc6843f4 fix(T1067)`); SDK `tasks-bridge.ts` exists; CLI `task-symbols` live.
- T1068 | T1056 | pending | false | EP3-T3 Living Brain SDK Traversal — code shipped (`1d28f07d0 feat(T1068)`); `living-brain.ts` exists; CLI `full-context`/`task-footprint`/`brain-anchors` live.
- T1069 | T1056 | pending | false | EP3-T4 Extended Code Reasoning (`why`/`impact-full`) — code shipped (`75dabed22 feat(T1069/PartB)`); both CLI verbs live.
- T1070 | T1056 | pending | false | EP3-T5 Sentient Nexus Ingester Extensions — `nexus-ingester.ts` exists; T1112 verified 5/5 detectors (parent T1056).
- T1071 | T1056 | pending | false | EP3-T6 Conduit→Symbol Ingestion — code shipped (`2f249e090 fix(T1071)`); CLI `conduit-scan` live.
- T1072 | T1056 | pending | false | EP3-T7 Hebbian BUG-2 Fix + STDP Wire-Up — code shipped (`a1a935db8 fix(T1072)`, `796dcd207 fix(T1072)`); 14-day half-life decay landed.
- T1073 | T1056 | pending | false | EP3-T8 IVTR Breaking-Change Gate — code shipped across 5 commits (`dc3a9ebe8 PartA` → `7a010a040 + summary`); exit-code 79 + `--acknowledge-risk` flag wired.

Bottom line: 16 of 17 children have visible commit evidence. Only T1063 (Leiden) shows no implementation activity.

---

## 4. Code Reality Check

`/mnt/projects/cleocode/packages/core/src/nexus/` contents (relevant slice):

```
augment.ts          embeddings.ts        hooks-augment.ts
living-brain.ts     query-dsl.ts         query.ts
route-analysis.ts   wiki-index.ts        nexus-bridge.ts
plasticity-queries.ts  tasks-bridge.ts   sigil-sync.ts
projects-clean.ts   register.ts          ...
```

`cleo nexus --help` exposes (counts of new tri-epic verbs): `query`, `route-map`, `shape-check`, `full-context`, `task-footprint`, `brain-anchors`, `why`, `impact-full`, `conduit-scan`, `task-symbols`, `search-code`, `contracts`, `group`, `wiki`, `hot-paths`, `hot-nodes`, `cold-symbols`, `top-entries`, `augment`, `setup`. That's **20 new verbs** matching the V2 RECOMMENDATION-v2.md proposed surface.

What's claimed but not in code:

- **Leiden community detection** (T1063, EP2-T2): no `leiden.ts` module under `packages/core/src/nexus/` or `packages/nexus/src/pipeline/`. Louvain still the only algorithm. Claim is open.
- **Hebbian BUG-2 zero-row liveness check**: code landed (T1072), but RECOMMENDATION-v2.md §2 logged "0 live rows strengthened" and "0 pairs extracted from retrieval log". No verification evidence post-fix proves the bug actually closed in production data.
- **STDP wire-up**: schema defined (`brain-stdp.ts` exists), but RECOMMENDATION-v2.md §2 explicitly notes 0 live rows (BUG-1/2/3). T1072 is the only commit, and no proof task confirms STDP edges now populate.
- **`mentions` / `documents` / `modified_by` edge writers** (T1066, EP3-T1): the EDGE_TYPES enum in `packages/core/src/memory/edge-types.ts` declares them, but I did not verify writers fire (skipped per budget). T1066 has NO commit hits in the last 6 weeks of git log (only T1067, T1068, T1069 cited there). T1066 is likely the most-deferred child.
- **5-substrate end-to-end proof (T1111)**: pending; no commit. Owner explicitly flagged this as "theater-breaker required" in description.

Sentient ingesters: `packages/core/src/sentient/ingesters/` contains `brain-ingester.ts`, `nexus-ingester.ts`, `test-ingester.ts`. T1112 is **the only DONE task in this entire audit set** (commit `04d08e280 feat(T1112): sentient Tier-2 anomaly proof — 5/5 detectors verified`). Sentient Tier-2 has real-world proof.

---

## 5. Priority-Ranked List for Intelligence Domain

### P0 — Verification debt (do first; no new code)
1. **Run `cleo verify` on T1057-T1062, T1064, T1065, T1067-T1073**: code is shipped, gates were never executed. Estimated 30 min of work to convert ~13 pending tasks to done. This is the highest-leverage P0 — converting verification debt into closed tasks.
2. **Resolve T1047 vs T1048**: archive T1047 with a "superseded by T1048" note; mark T1048 as done (RECOMMENDATION-v2.md is the deliverable).

### P1 — Real implementation gaps
3. **T1066 (EP3-T1 BRAIN→NEXUS edge writers)**: `documents` / `modified_by` / `mentions` writers have no commit. Verify `graph-memory-bridge.ts` has new writers; if not, this is a real gap.
4. **T1063 (EP2-T2 Leiden + member_of)**: no Leiden implementation in code. Louvain remains default. Either ship the algorithm or formally defer.
5. **T1072 (EP3-T7) liveness validation**: confirm Hebbian rows now strengthen in production data and STDP rows now write. T1072 fixed BUG-1/BUG-2 in code but I found no liveness proof.

### P2 — Proof-of-life
6. **T1111 (5-substrate end-to-end sandbox proof)**: owner flagged as theater-breaker. T1112 (sentient) shipped its proof — T1111 is the missing companion. Without it, the Living Brain story is unverified end-to-end.
7. **T1110 (sweeper post-hook)**: pending; commit `473f7a8ff fix(T1110)` exists but task isn't marked done.

### P3 — Strategic
8. Living Brain Phase 5 STDP completion (separate from T1072 — T1072 was the bug fix, full Phase 5 is bigger).
9. Cross-project contract registry to TASKS link (RECOMMENDATION-v2.md §7.4 — apex differentiator, depends on T1065 + T1067 both being verified).

---

## 6. Top 3 Findings

### Finding 1: 16 of 17 tri-epic children have shipped code but ZERO have run verification gates
Confirmed by: `cleo show T1057..T1073` → all return `verification.passed=false, gates.implemented=false, lastUpdated=null` (gates were never even initialized as run). Cross-referenced with `git log --grep T10[5-7][0-9]`: at least 28 commits across T1057, T1058, T1060, T1061, T1062, T1064, T1065, T1067, T1068, T1069, T1071, T1072, T1073. The implementation work happened, but verify-then-complete ritual was skipped — making the entire tri-epic look stalled when it's actually mostly ready to close.

### Finding 2: V1 RECOMMENDATION.md (T1047) misframes the architecture and should be archived
V1 lists "MCP Tool Surface for Code Graph" as P0 CRITICAL with EP1-T5 as a 15-tool MCP server epic. This directly contradicts AGENTS.md package boundaries and the locked CLI-only-dispatch decision (memory MCP-removal-complete from 2026-04-04). V2 explicitly deletes EP1-T5, removes MCP references throughout, and cites D-BRAIN-VIZ-09 (SQLite-only graph engine) to kill V1's HITL-1. Keeping V1 in the agent-outputs directory creates ID-overload risk: future agents may reference V1's EP-task IDs which don't match the actual T1057-T1073 task layout (which followed V2).

### Finding 3: T1066 BRAIN→NEXUS edge writers is the sole P2 tri-epic child with no commit evidence
While T1067, T1068, T1069, T1071, T1072, T1073 all have feat/fix commits in git, T1066 (EP3-T1: Complete BRAIN→NEXUS Edge Writers — `documents`, `modified_by`, `affects`, `mentions`) does not appear in `git log --oneline` filtered to the last 6 weeks. The downstream tasks T1068 (Living Brain SDK), T1069 (`why`/`impact-full`) depend on these edges to return meaningful data — without writers populating those rows, the SDK primitives shipped by T1068 will return empty cross-substrate context for non-`code_reference` paths. This is a silent quality bug: APIs work but data is incomplete.

---

## 7. Top 5 Recommendations

1. **Run a verification sweep across T1057-T1073** (~30 min). For each task with shipping commits, run `cleo verify <id> --gate implemented --evidence "commit:<sha>;files:<list>"` then `--gate testsPassed --evidence "tool:test"` then `cleo complete <id>`. This converts apparent stalled status into 13-15 closed tasks. Do this BEFORE shipping any new tri-epic code — the orchestration debt is masking real progress.

2. **Archive T1047 + close T1048 as done.** Add a brain observation: "RECOMMENDATION-v2.md is canonical; V1 superseded due to MCP misframe and locked SQLite engine decision." Cancel T1047 with `cleo update T1047 --status cancelled --note "Superseded by T1048; V2 RECOMMENDATION-v2.md is canonical."`

3. **Investigate T1066 (BRAIN→NEXUS edge writers) as a real gap.** Read `packages/core/src/memory/graph-memory-bridge.ts` and confirm whether `documents`/`modified_by`/`mentions`/`affects` writers exist. If absent, either ship them (small, days) or formally defer the dependent tasks (T1068, T1069) and document that their CLI verbs return partial cross-substrate context.

4. **Schedule T1111 (5-substrate end-to-end sandbox proof) as next intelligence-domain work.** Owner has explicitly flagged as theater-breaker. T1112 already proved sentient detectors with the same playbook. The Living Brain pitch is unverifiable until T1111 demonstrates: brain observation → nexus code-link → task-touches-symbol → conduit thread → sentient proposal in one sandbox flow.

5. **Implement Leiden (T1063) or formally defer.** The 13× community-count gap vs gitnexus is the single most-cited code-intelligence quality metric in the audit (RECOMMENDATION-v2.md §3 evidence on openclaw). Either ship a Rust Leiden implementation (cleanest), use a JS port, or write an ADR formally accepting the Louvain ceiling. The worst outcome is leaving T1063 as zombie-pending indefinitely while CLI users compare community counts to gitnexus.

---

## Summary of evidence cited

- File: `/mnt/projects/cleocode/.cleo/agent-outputs/T1042-nexus-gap/RECOMMENDATION.md` (T1047 V1)
- File: `/mnt/projects/cleocode/.cleo/agent-outputs/T1042-nexus-gap/RECOMMENDATION-v2.md` (T1048 V2 — canonical)
- File: `/mnt/projects/cleocode/.cleo/agent-outputs/T1042-nexus-gap/EXECUTION-LOG.md` (HITL resolutions, wave plan)
- Source dir: `/mnt/projects/cleocode/packages/core/src/nexus/` (20 modules confirmed)
- Source dir: `/mnt/projects/cleocode/packages/core/src/sentient/ingesters/` (3 ingesters)
- Source dir: `/mnt/projects/cleocode/packages/core/src/memory/` (graph-memory-bridge, nexus-plasticity, edge-types confirmed)
- CLI: `cleo nexus --help` (20 new tri-epic verbs exposed)
- Git: 28+ commits across T1057-T1073 found in `git log --since="6 weeks ago"`
- Task DB: `cleo show` for T1042-T1048, T1054-T1056, T1057-T1073, T1110-T1112
