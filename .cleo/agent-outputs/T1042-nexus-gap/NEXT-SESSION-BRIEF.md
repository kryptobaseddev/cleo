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

- **T1055/T1056 lifecycle close**: Now that EP2-T1 through EP2-T4 are closed, can T1055 auto-close? EP3-T1 through EP3-T7 are closed but T1073 is still pending — T1056 cannot close until T1073 ships. Owner should decide whether to scope-cut T1073 or schedule it.

- **T1647/T1648/T1649 disposition**: These three tasks overlap with work already done in T1043-T1048. T1647 wants `.cleo/agent-outputs/T1042-gap-analysis.md` which doesn't exist, but `gitnexus-surface.md` + `RECOMMENDATION-v2.md` contain the same information. Owner should confirm: close T1647 against existing artifacts, or create the gap-analysis.md as a brief redirect document?

- **EP1 epic creation**: RECOMMENDATION-v2.md §8 specifies EP1 (Core Query Power) as a set of 5 tasks. These tasks have NOT been created in the task DB. Next session should create them before spawning workers.

- **Leiden vs Louvain decision**: T1063 closed with Louvain resolution tuning + `member_of` edge documentation. The Leiden swap is still on the far-exceed list. Owner should confirm whether T1063 closing means Leiden is descoped or still wanted.

- **T1534 scope**: AST shape inference is deferred in source code. Owner should confirm whether to keep T1534 as a medium-priority task or deprioritize in favor of the P0 wave.
