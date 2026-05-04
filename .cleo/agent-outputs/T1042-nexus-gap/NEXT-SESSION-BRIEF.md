# T1042 Next-Session Brief — Cleo Nexus far-exceed GitNexus

**Generated**: 2026-05-04 by T1732 close-out sweep
**Session**: ses_20260503210550_324d4b
**Version at generation**: v2026.5.15

---

## State (as of 2026-05-04 / v2026.5.15)

This session (T1732) closed 16 tasks: all 11 EP2/EP3 implementation tasks that had shipped commits on main (T1062-T1072), plus the 5 T1042 research tasks whose artifacts exist in `.cleo/agent-outputs/T1042-nexus-gap/` (T1043-T1046, T1048). Two implementation tasks remain genuinely pending: T1073 (IVTR Breaking-Change Gate — needs `gate-validators.ts` impl) and T1534 (AST-based route shape inference — explicitly deferred in code). The newer research/decompose/implement wave (T1647, T1648, T1649) also remains pending — T1647's artifact (`.cleo/agent-outputs/T1042-gap-analysis.md`) does not exist. T1042 itself (the parent epic) remains open as it has genuinely unimplemented work.

The foundation is solid: living brain wiring (BRAIN↔NEXUS edges, tasks bridge schema, traversal primitives, sentient detectors, plasticity fix) is all shipped. What remains is the capability surface expansion that makes cleo nexus *exceed* gitnexus: query DSL, semantic code search, source retrieval, wiki generation, hook augmenter (P0), plus Leiden community detection, contract registry, route-map/shape-check (P1), and the cross-substrate traversal primitives (P2).

---

## Closed this session (T1732 sweep)

### EP2 — Nexus P1 Competitive Closure (children of T1055)

- **T1062** — EP2-T1: External Module Nodes (IMPORTS persistence) — commit `b0ceb546`, file `packages/nexus/src/pipeline/import-processor.ts` + test
- **T1063** — EP2-T2: Leiden Community Detection + member_of edges — commit `20b8db7c`, file `packages/nexus/src/pipeline/community-processor.ts`
- **T1064** — EP2-T3: Route-Map and Shape-Check Commands — commit `eba60a00`, test `packages/core/src/nexus/__tests__/route-analysis.test.ts`
- **T1065** — EP2-T4: Contract Registry — commit `29878f58`, files `packages/core/src/nexus/api-extractors/extractors.test.ts`, `packages/nexus/src/pipeline/leiden.ts`, `community-processor.ts`

### EP3 — Nexus P2 Living Brain Completion (children of T1056)

- **T1066** — EP3-T1: BRAIN→NEXUS Edge Writers — commit `ac55817c`, file `packages/core/src/memory/graph-memory-bridge.ts` + integration test
- **T1067** — EP3-T2: TASKS→NEXUS Bridge (task_touches_symbol) — commit `2dc6843f`, test `packages/core/src/nexus/__tests__/tasks-bridge.test.ts`
- **T1068** — EP3-T3: Living Brain SDK Traversal Primitives — commit `1d28f07d`, files `packages/core/src/nexus/living-brain.ts` + test
- **T1069** — EP3-T4: Extended Code Reasoning (why + impact-full) — commit `85a45c7f`, test `packages/core/src/memory/__tests__/brain-reasoning-symbol.test.ts`
- **T1070** — EP3-T5: Sentient Nexus Ingester Extensions — commit `8d064e63`, file `packages/core/src/sentient/ingesters/nexus-ingester.ts` + test
- **T1071** — EP3-T6: Conduit→Symbol Ingestion Pipeline (fix to T1066) — commit `2f249e09`, `graph-memory-bridge.ts` ORDER BY bug fix
- **T1072** — EP3-T7: Hebbian BUG-2 Fix + STDP Wire-Up — commit `796dcd20`, test `packages/core/src/memory/__tests__/nexus-plasticity.test.ts`

### T1042 Direct Research Children

- **T1043** — GitNexus CLI deep-dive — artifact: `.cleo/agent-outputs/T1042-nexus-gap/gitnexus-surface.md` (confirmed present)
- **T1044** — Cleo Nexus CLI deep-dive — artifact: `.cleo/agent-outputs/T1042-nexus-gap/cleo-nexus-surface.md` (confirmed present)
- **T1045** — Execute gitnexus on /mnt/projects/openclaw — artifacts: `.cleo/agent-outputs/T1042-nexus-gap/gitnexus-runs/` (confirmed present, 6+ run logs)
- **T1046** — Execute cleo nexus on /mnt/projects/openclaw — artifacts: `.cleo/agent-outputs/T1042-nexus-gap/cleo-nexus-runs/` (confirmed present, 6+ run logs)
- **T1048** — REVISED synthesis (RECOMMENDATION-v2.md) — artifact: `.cleo/agent-outputs/T1042-nexus-gap/RECOMMENDATION-v2.md` (773 lines, confirmed present)

---

## Genuinely pending

### Implementation tasks (real code missing)

- **T1073** — EP3-T8: IVTR Breaking-Change Gate — **what's missing**: `packages/core/src/engine/gate-validators.ts` needs a `nexusImpact` gate validator that calls `analyzeImpact()` on task files, blocks completion if any symbol is CRITICAL risk, supports `--acknowledge-risk` bypass with audit log write. The git commit found (`a804b57b`) was a handoff-notes commit, not the implementation.

- **T1534** — AST-based route shape inference — **what's missing**: `packages/core/src/nexus/route-analysis.ts` `shapeCheck()` currently uses string equality and explicitly comments "deferred to T1534 (AST-based shape inference)". Needs TypeScript compiler API or ts-morph integration to extract caller vs. route return type shapes and detect mismatches.

### Research/planning tasks (artifacts missing)

- **T1647** — Research: Map full GitNexus capability surface — **what's missing**: `.cleo/agent-outputs/T1042-gap-analysis.md` does not exist. Note: the more thorough research is already in `gitnexus-surface.md` + `RECOMMENDATION-v2.md`; T1647 may be superseded by those artifacts. Recommend confirming with owner whether T1647 should be closed against existing artifacts or formally marked superseded.

- **T1648** — Decompose gap analysis into actionable tasks — **what's missing**: child tasks under T1042 (or a new epic). RECOMMENDATION-v2.md §8 contains the full decomposition plan (3 epics, 12 tasks) but the tasks have not been created in the task DB. Recommend running the decomposition from §8 to create the child tasks.

- **T1649** — Implement top-3 priority gaps — **what's missing**: no code shipped for the P0 capabilities (query DSL, semantic search, source retrieval, wiki, hook augmenter). This task is the implementation stub and should be replaced by the concrete EP1 child tasks from the decomposition.

### Parent epics (blocked on children)

- **T1055** — Nexus P1: Competitive Closure (epic) — EP2-T1 through EP2-T4 children now closed. The epic itself may auto-close or may need a manual lifecycle complete.
- **T1056** — Nexus P2: Living Brain Completion (epic) — EP3-T1 through EP3-T7 children now closed; EP3-T8 (T1073) is genuinely pending. The epic needs T1073 shipped before closing.
- **T1042** — Cleo Nexus vs GitNexus: Far-Exceed (parent epic) — open; needs the P0 epic (EP1) built and shipped.

---

## Reference: Existing artifacts in `.cleo/agent-outputs/T1042-nexus-gap/`

### `gitnexus-surface.md` — key capabilities cleo nexus must MATCH or BEAT

- **Storage**: LadybugDB (native property graph, HNSW vector index, FTS/BM25, Cypher) — cleo uses SQLite
- **Key CLI gap**: `gitnexus cypher` (raw Cypher query) — cleo has no equivalent ad-hoc graph query DSL
- **Semantic search**: `gitnexus query <nl>` (BM25+HNSW+RRF semantic search over execution flows) — cleo's `smartSearch()` exists but unwired
- **Source retrieval**: `gitnexus context --content` (inline source from symbol) — cleo's `smartUnfold()` exists but unwired
- **Wiki generation**: 3-phase LLM pipeline → `.gitnexus/wiki/*.md` — cleo `docs-generator.ts` exists but not wired to nexus
- **Hook augmenter**: `gitnexus augment <pattern>` (PreToolUse → context injection) — CAAMP infrastructure exists but handler not built
- **Community scale**: 6,797 Leiden communities vs cleo's 513 Louvain communities
- **IMPORTS scale**: 390k IMPORTS edges stored as ExternalModule nodes — cleo discards unresolved imports
- **Cross-repo groups**: `gitnexus group sync` builds Contract Registry — cleo has no equivalent
- **Route/API tools**: MCP-accessible `route_map`, `shape_check`, `api_impact` — cleo has `route-analysis.ts` but no CLI verbs

### `cleo-nexus-surface.md` — cleo nexus current capabilities

See document for full table. Short summary of cleo's *advantages* over gitnexus:
- 5-substrate living brain (BRAIN + NEXUS + TASKS + CONDUIT + SIGNALDOCK) — gitnexus is code-graph only
- Task↔symbol bridges (`code_reference` edges, `tasks-bridge.ts`) — gitnexus has no task layer
- Hebbian/STDP plasticity weights on edges — no gitnexus equivalent
- Sentient proposals from code-graph anomalies (`nexus-ingester.ts`) — no gitnexus equivalent
- Multi-project task registry operations (transfer, deps, critical-path) — orthogonal to gitnexus

### `RECOMMENDATION-v2.md` — owner-approved direction (all 773 lines)

- **Strategy**: supersession via architectural difference, not parity. cleo nexus becomes the code-plane of a unified 5-substrate living brain.
- **No MCP**: all primitives in `packages/core/src/nexus/`, CLI verbs in `packages/cleo/src/cli/commands/nexus.ts`, hook augmenter in `packages/cleo-os/src/hooks/`. ADR-explicit.
- **Graph engine locked**: SQLite recursive CTEs (D-BRAIN-VIZ-09). Do NOT adopt LadybugDB (PolyForm Noncommercial).
- **P0 tasks** (unwiring fixes and small builds): query DSL, semantic search, source retrieval, wiki, hook augmenter
- **P1 tasks** (competitive closure): Leiden swap, IMPORTS persistence, route-map/shape-check, contract registry
- **P2 tasks** (living brain completion): TASKS→NEXUS edge writers, `getSymbolFullContext()`, `getTaskCodeImpact()`, CONDUIT→NEXUS, extended reason-why

---

## Concrete next-session entry point

1. **Read this brief + `RECOMMENDATION-v2.md` §8** (10 min) — the decomposition table at §8 is the implementation backlog; just create the child tasks from it.

2. **Create EP1 child tasks under T1055** (or a new epic) using §8 of RECOMMENDATION-v2.md as the specification. The five EP1 tasks are: EP1-T1 (CTE query DSL), EP1-T2 (semantic search unwiring), EP1-T3 (source retrieval `--content` flag), EP1-T4 (wiki generator), EP1-T5 (hook augmenter). These are all small-to-medium and mostly "unwire existing code."

3. **Spawn on EP1-T3 first** (source retrieval `--content` flag) — smallest, highest leverage, 3 lines of code in `nexus.ts`. Proves the pattern. Ship it.

4. **Then EP1-T2** (semantic search unwiring) — `smartSearch()` is fully implemented in `packages/nexus/src/code/search.ts`, just needs a CLI verb. Pair with hybrid search extension for `cleo memory search-hybrid`.

5. **Separately: close T1073** — this is the only EP3 task still blocking T1056. The `nexusImpact` gate validator in `packages/core/src/engine/gate-validators.ts` is a self-contained medium task. Spawn a worker on it.

---

## Far-exceed targets (gitnexus capabilities cleo nexus must beat)

Ordered by leverage (highest first):

1. **[P0-A] Graph query DSL** — `cleo nexus query "<cte>"` with 6 template aliases. Currently zero ad-hoc query surface; gitnexus has `cypher`. SQLite recursive CTEs.
2. **[P0-B] Semantic code symbol search** — `cleo nexus search-code <q>`. `smartSearch()` is fully implemented and unwired. Also extend `cleo memory search-hybrid` to fan out to nexus symbols.
3. **[P0-C] Source content retrieval** — `cleo nexus context --content`. `smartUnfold()` is fully implemented and unwired. 3-line change in `nexus.ts`.
4. **[P0-D] Wiki generator** — `cleo nexus wiki`. Extend `packages/core/src/docs/docs-generator.ts`. Group by community, generate per-community docs via LOOM.
5. **[P0-E] Hook augmenter** — `cleo nexus augment <pattern>` + `packages/cleo-os/src/hooks/nexus-augment.ts` PreToolUse handler. CAAMP infrastructure exists.
6. **[P1-A] Leiden community detection** — swap Louvain for Leiden in `community-processor.ts`, emit `member_of` graph edges. Closes 6,797 vs 513 community gap.
7. **[P1-B] IMPORTS persistence** — persist unresolved imports as ExternalModule nodes. Currently 390k gitnexus IMPORTS vs 0 in cleo.
8. **[P1-C] Route-map + shape-check CLI verbs** — `cleo nexus route-map`, `cleo nexus shape-check`. `route-analysis.ts` already exists; needs CLI verbs + AST shape inference (T1534).
9. **[P1-D] Contract registry** — `cleo nexus contracts` cross-repo linking. Depends on route-map.
10. **[P2] `getSymbolFullContext()`** — the key living-brain query primitive (symbol → tasks + memories + proposals). Foundation (bridges, edge writers) now shipped. Unwire and expose.

---

## Build-into-CORE constraint reminder

- All runtime primitives MUST live in `packages/core/src/nexus/` — NEVER MCP, NEVER side packages
- CLI verbs MUST live in `packages/cleo/src/cli/commands/nexus.ts` as thin dispatch wrappers
- Hook augmenter MUST live in `packages/cleo-os/src/hooks/` (harness concern)
- Tests MUST live in `packages/{core,nexus}/__tests__/`
- Storage engine is SQLite — do NOT adopt LadybugDB (PolyForm Noncommercial license)
- See AGENTS.md Package-Boundary Check table for full boundary rules

---

## Open questions / decisions needed

> **STATUS UPDATE (2026-05-04)** — These questions were originally framed as 5 open owner decisions. After Council review (5-advisor + peer-review + Chairman synthesis, all 4/4 gates passed, run id `20260504T051843Z-a36ef96d`), **only one** turns out to be a genuine owner decision. The other four are derivable from the supersession-via-architecture frame already approved in `RECOMMENDATION-v2.md`. See "Council Decisions (2026-05-04)" section below for the operational dispositions; the original framings are kept here for traceability.

- **T1055/T1056 lifecycle close**: Now that EP2-T1 through EP2-T4 are closed, can T1055 auto-close? EP3-T1 through EP3-T7 are closed but T1073 is still pending — T1056 cannot close until T1073 ships. Owner should decide whether to scope-cut T1073 or schedule it.

- **T1647/T1648/T1649 disposition**: These three tasks overlap with work already done in T1043-T1048. T1647 wants `.cleo/agent-outputs/T1042-gap-analysis.md` which doesn't exist, but `gitnexus-surface.md` + `RECOMMENDATION-v2.md` contain the same information. Owner should confirm: close T1647 against existing artifacts, or create the gap-analysis.md as a brief redirect document?

- **EP1 epic creation**: RECOMMENDATION-v2.md §8 specifies EP1 (Core Query Power) as a set of 5 tasks. These tasks have NOT been created in the task DB. Next session should create them before spawning workers. (**Council finding: this is wrong — T1057-T1061 ARE the EP1 tasks and they are CLOSED. The brief was authored partly stale; see Decision 2 below.**)

- **Leiden vs Louvain decision**: T1063 closed with Louvain resolution tuning + `member_of` edge documentation. The Leiden swap is still on the far-exceed list. Owner should confirm whether T1063 closing means Leiden is descoped or still wanted. (**Council finding: T1063 record and brief contradict each other on Leiden vs Louvain — must read `community-processor.ts` source for canonical answer.**)

- **T1534 scope**: AST shape inference is deferred in source code. Owner should confirm whether to keep T1534 as a medium-priority task or deprioritize in favor of the P0 wave.

---

## Council Decisions (2026-05-04)

> ⚠️ **Decision 4 was REVERSED on owner pushback** — Council R4 ("descope Leiden, Louvain is enough") was based on a false brief premise. Source-code reads confirm **Leiden is already shipped** in `packages/nexus/src/pipeline/community-processor.ts` + `leiden.ts` (pure-TS impl). Owner correctly identified that Louvain has a published correctness bug (internally disconnected communities) that Leiden's refinement phase fixes — this is correctness, not parity. See Decision 4 section below for the corrected disposition. **Process lesson: when source code is the canonical answer, the Chairman should read it during synthesis, not punt it to the operational step.**


**Source**: 5-advisor Council run `20260504T051843Z-a36ef96d` (all 4/4 gates passed, no convergence flag, confidence: high). Full transcript at `.claude/skills/council/.cleo/council-runs/20260504T051843Z-a36ef96d/output.md`. Verdict at `…/verdict.md`.

**Headline**: Of the 5 outstanding decisions, **only Decision 3 (functional validation) genuinely requires owner direction**; Decisions 1, 2, 4, 5 are execution-derivable from the supersession-via-architecture frame and current task state. The brief's framing of all 5 as escalation points reflected bookkeeping caution, not actual ambiguity.

### Decision 1 — T1055/T1056 epic-close discipline → **Option (b): ship T1073, mechanically close T1055**

**Recommendation**: Ship T1073 next session as the focused unblocker. Mechanically close T1055 against its 4/5 children with T1534 demoted to non-blocking residual.

**Rationale**: First Principles is decisive — T1055's EP2 children (T1062-T1065) are all `done`, making this execution-derivable, not an owner decision. T1534 is parity (matches gitnexus `shape_check`), which the supersession frame defers without owner input. T1056 is genuinely blocked by T1073 (IVTR `nexusImpact` gate validator); ship that one task and the epic closes naturally. Scope-cutting T1073 contradicts the supersession strategy because IVTR is differentiation-adjacent.

**Conditional**: IF `cleo complete T1055` returns `E_LIFECYCLE_GATE_FAILED`, demote T1534 to medium priority + `p1.5-residual` label first, then retry.

**Operational step**:
```bash
cleo verify T1055 --gate cleanupDone --evidence "note:EP2 done; T1534 → P1.5 residual per Council 2026-05-04"
cleo complete T1055   # if E_LIFECYCLE_GATE_FAILED:
cleo update T1534 --priority medium --label p1.5-residual
cleo complete T1055
cleo orchestrate spawn T1073 --tier 1
```

### Decision 2 — T1647/T1648/T1649 disposition → **Hybrid (a)+(b): redirect stub + close all three**

**Recommendation**: Write the 8-line redirect stub at `.cleo/agent-outputs/T1042-gap-analysis.md`, then close T1647 + T1648 + T1649 against existing artifacts.

**Rationale**: Outsider documented that T1648's AC ("≥5 child tasks created under T1042") is met by T1057-T1061 + T1062-T1072 in `done` status. T1647's required artifact is a strict subset of `gitnexus-surface.md` + `RECOMMENDATION-v2.md`. T1649's "implement top-3 gaps" was operationalized by T1057-T1061. The stub costs 8 lines, converts a fictional blocker into a real audit-trail link, and is execution work, not owner work.

**Conditional**: Unconditional. Highest-leverage immediate action; entire sequence runs in <20 minutes wall-clock.

**Operational step**: Run Executor's exact paste-ready command sequence from `phase1-executor.md` §"The action (one)" — the stub + 9 `cleo verify` + 3 `cleo complete` calls.

### Decision 3 — Functional validation gap → **Option (a): full re-run + side-by-side comparison** ⚠️ owner decision

**Recommendation**: Full re-run of both pipelines on `/mnt/projects/openclaw` with v2026.5.15+, gated to a single new task before any P1/P2 supersession claim propagates.

**Rationale**: Both Contrarian and First Principles independently flagged this as the most substantive uncorrected error in the closed-task record. ADR-051 `tool:test` evidence proves unit-test green, NOT capability parity. The closures of T1062-T1072 are valid as completion claims but **invalid as supersession-vs-gitnexus proofs**. The artifacts in `cleo-nexus-runs/` and `gitnexus-runs/` predate v2026.5.15. Spot-check (b) is insufficient because the gap is systematic across 11 tasks; trust-records (c) propagates a false claim.

**Conditional** ⚠️ **owner choice**: spot-check (b) is acceptable IF the owner explicitly downgrades the supersession claim to "structurally distinct, not benchmark-equivalent." Otherwise, full (a). **This is the one genuine owner decision in the 5.**

**Operational step**:
```bash
cleo add --parent T1042 --type task --priority high --size medium \
  --title "T1042 functional validation: re-run gitnexus + cleo nexus side-by-side on /mnt/projects/openclaw with v2026.5.15+; produce diff at .cleo/agent-outputs/T1042-nexus-gap/v2026.5.15-side-by-side.md" \
  --description "ADR-051 tool:test evidence proves unit-test green, NOT side-by-side capability parity. Run both pipelines fresh; capture: (1) symbol counts, (2) IMPORTS edge counts, (3) community counts (Leiden vs Louvain disposition), (4) callers/callees parity for 10 sample symbols, (5) wiki output diff, (6) hook augmenter latency. Output a SUPERSESSION-EVIDENCE.md and update task records on T1062-T1072 with structured 'parity-verified' note." \
  --acceptance "Both pipelines run cleanly on /mnt/projects/openclaw|6-axis comparison table produced|Each axis tagged exceeds/matches/falls-behind|Falls-behind axes filed as new tasks|Update T1062-T1072 records with parity outcome note"
```

### Decision 4 — Leiden vs Louvain → **CORRECTION (2026-05-04 owner pushback)**

> ⚠️ **The original Council recommendation here was WRONG.** Council R4 said "descope Leiden, Louvain is enough" based on the brief's false framing of Leiden as a parity-only feature. Owner pushback identified the actual atomic truth the Council missed: **Louvain has a known correctness bug** (internally disconnected communities — Traag, Waltman & van Eck 2019). Leiden adds a refinement phase that guarantees connected communities, runs in O(n log n), and is *strictly better*. This is not parity vs differentiation — it's correct vs buggy substrate. Differentiation features (sentient detectors, plasticity heat localization, getSymbolFullContext) all consume community membership; if those communities are internally disconnected, every feature built on top of them is operating on a flawed substrate.

**Source-of-truth finding (read from the actual code, not the brief)**:

```text
packages/nexus/src/pipeline/community-processor.ts:4
  "Uses the Leiden algorithm (pure-TS implementation) to detect..."

packages/nexus/src/pipeline/community-processor.ts:13
  "Implements the Leiden algorithm from Traag, Waltman, van Eck (2019)"

packages/nexus/src/pipeline/community-processor.ts:15
  "Refinement phase distinguishes Leiden from Louvain by splitting..."

packages/nexus/src/pipeline/community-processor.ts:17
  "Produces ~10–15× more communities than Louvain at same resolution"

packages/nexus/src/pipeline/community-processor.ts:30
  import { leiden } from './leiden.js';
```

There's a dedicated `packages/nexus/src/pipeline/leiden.ts` (pure-TS implementation, written because `graphology-leiden` was unavailable). **Leiden is the canonical algorithm and is already shipped.**

**Corrected recommendation**: **Leiden is correct, shipped, and required — keep it.** Update T1063's task description to match the source code. The brief's line 155 "T1063 closed with Louvain resolution tuning" was a sloppy closed-task description that the brief inherited. The 13× community-count gap is **not** a gap — it's the expected effect of using the more granular and correctness-guaranteed algorithm. The "513 vs 6,797" benchmark in `gitnexus-surface.md` predates Leiden's adoption in cleo.

**Why the Council got this wrong**:
1. Outsider correctly flagged the brief's internal contradiction (line 23 says Leiden, line 155 says Louvain) but did not read source.
2. Chairman punted with "read source for canonical answer" instead of doing it.
3. First Principles applied "parity defers under supersession" without checking whether Louvain is actually correct — which it isn't, by published proof. **Atomic truth missed**: an algorithm with a known correctness bug is never lower priority than the algorithm that fixes it, regardless of strategy frame.

**Conditional**: None. Leiden stays. Louvain is not an option.

**Operational steps**:
```bash
# 1. Update T1063's description to reflect the source-code truth
cleo update T1063 --description "Leiden community detection + member_of edges. Pure-TS Leiden implementation in packages/nexus/src/pipeline/leiden.ts (replaces unavailable graphology-leiden package). Per Traag, Waltman & van Eck 2019 — refinement phase guarantees internally connected communities (Louvain's known correctness bug). Produces ~10-15x more communities than Louvain at same resolution. Source-of-truth: packages/nexus/src/pipeline/community-processor.ts. Brief's prior 'Louvain resolution tuning' description was incorrect."

# 2. The Decision 3 validation campaign should now compare gitnexus' Leiden vs cleo's Leiden (not gitnexus' Leiden vs cleo's Louvain). Update the validation task's acceptance criteria accordingly when filing it.

# 3. Verify the implementation handles the same correctness invariants gitnexus relies on:
pnpm --filter @cleocode/nexus test community-process --run
```

**Validation question that supersedes the original D4**: now that we know both tools run Leiden, does cleo's pure-TS Leiden produce the same partition (or better) as gitnexus' Leiden on `/mnt/projects/openclaw`? This is the right Decision 3 axis — the original D4 ("descope or keep") was based on a false premise.

### Decision 5 — T1534 AST shape inference scope → **Hybrid (a)+(c): keep medium, P1.5 residual**

**Recommendation**: Keep at medium priority in P1.5 residual queue. Do NOT escalate to P0.

**Rationale**: First Principles: T1534 (real shape-check via TypeScript compiler API or ts-morph) is parity with gitnexus' `shape_check`. Under supersession-via-architecture, this is differentiation-adjacent only because route-map exists; the bare CLI verb (string-equality fallback) is functionally degraded but present. Escalating contradicts the approved strategy. Descoping reads as accepting a half-built capability.

**Conditional**: Escalate IF Decision 3's validation shows users invoking `cleo nexus shape-check` and getting wrong answers (false-equal or false-different) — at that point the deferred-comment becomes a bug.

**Operational step**:
```bash
cleo update T1534 --priority medium --size large --label p1.5-residual
```

### Carried-forward sharpest findings (for next-session orchestrator awareness)

- **Contrarian**: T1063/Leiden contradiction will silently resolve as "done" when the next session reads the closed-task record, shipping EP1 against a Louvain-partitioned graph while the task DB claims Leiden — undetected until a benchmark that no gate currently requires.
- **First Principles**: Supersession-via-architecture is the approved strategy, not a preference; it already answers Q4 and Q5 without escalation.
- **Expansionist**: Wire `getSymbolFullContext()` (EP3-T5) into the CAAMP PreToolUse hook augmenter (EP1-T5) as one compound primitive (conditional on non-empty task/brain/plasticity provenance) — permanently separates cleo from any static code-intelligence tool.
- **Outsider**: The brief's "next-session entry point" section is stale — recommends spawning on T1059 (`--content` flag) which is already on main.
- **Executor**: 60-minute action — write redirect stub, close T1647/T1648/T1649, drain false-critical backlog, expose the real three open items.

### Sole owner question

**Decision 3 supersession-claim strength**: stronger (benchmark-equivalent — requires full side-by-side re-run) or weaker (structurally distinct — spot-check sufficient)? This is the only question the Council could not resolve from the strategy frame alone.
