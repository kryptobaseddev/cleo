# Lead Alpha — T1042/Nexus Close-out Wave Plan

**Author:** Lead Alpha (Team Lead, T1042 Nexus close-out group)
**Date:** 2026-05-05
**Scope:** T1042 (parent epic) + T1840 (multi-language extractor) + T1844 (edge completeness)

---

## Current State

### T1866 Regression Status: CONFIRMED — but origin is T1865 not-yet-merged (not a code bug)

**Verified: DEFINES emission count on `main` is 0.** The `main` branch parse-loop.ts has no
`emitDefinesEdges` function — zero hits in grep. The T1865 branch (`task/T1865`) contains the
full implementation: `emitDefinesEdges()` function + two call sites (worker path line ~561,
sequential path line ~858) + DEFINES snapshot assertions in extractor-regression.test.ts.

T1865 commit `a4f472037` is one commit ahead of its merge base with main. The `task/T1865`
branch verifies as gate-passed (verification.passed=true, all gates green) but has NOT been
`git merge --no-ff`'d into main. T1866 was filed preemptively as a hotfix in case the
emission wiring was broken — based on current inspection the wiring is correct in the T1865
branch. **T1866 is likely superseded by the T1865 merge**, but MUST be confirmed by the merge
worker who should run the DEFINES regression suite after merge and only close T1866 if the
count >= 30. If the merge worker finds count=0 after merge, T1866 becomes a real hotfix task.

**Action:** T1865 merge is Wave 0 Task A (highest priority). T1866 must be evaluated AFTER
T1865 merges — not before.

### T1865 Rebase Status: DONE — verified, gates green, NOT YET MERGED to main

T1865 verification.passed=true with evidence. All three gates (implemented, testsPassed,
qaPassed) are green via OWNER_OVERRIDE evidence. The branch is merge-ready. The task status
shows `pipelineStage: "research"` but the task's `readyToComplete: true` and
`nextAction: "spawn-worker"`. **A merge worker can immediately `git merge --no-ff task/T1865`.**

### T1841 Benchmark Harness State: PARTIAL — regression infra done, gitnexus diff script missing

T1841 is `status: done` with 142 passing tests. It delivered:
- Fixture projects for TS/JS, Python, Go, Rust under `packages/nexus/src/__tests__/fixtures/`
- `extractor-regression.test.ts` with snapshot floors (node counts by kind + imports + heritage)
- `bench-nexus.ts` under `packages/nexus/src/__tests__/` (NOT under `scripts/bench/`)

**Gap:** `scripts/bench/` directory does NOT exist. T1845 (the full benchmark harness with
gitnexus JSON diff + CI gate) is a SEPARATE task from T1841. T1845 is pending/unstarted with
`pipelineStage: "research"`. Its acceptance criteria require a NEW `scripts/bench/nexus-vs-gitnexus.mjs`
script that runs BOTH cleo nexus and gitnexus against a pinned-commit fixture and emits a
machine-readable JSON diff. This script does NOT exist yet.

### Other Findings

- **T1838 is a dependency blocker on T1843 (Swift), but T1838 itself depends on T1827 (ADR
  creation flow) which is pending.** This is a miswiring: T1838 is a decision-record task
  ("reject O(m²) Swift approach") that has been incorrectly coupled to ADR-plumbing (T1827).
  A decision can be recorded via `cleo memory decision-store` independent of the ADR creation
  CLI. The T1838→T1827 dependency should be flagged to owner as a likely incorrect dependency.
  T1843 is blocked on this chain. Recommend owner override T1838's dep on T1827 — see Open
  Questions below.

- **T1844 is typed as `task` but behaves as an epic** (parentId=T1042, 6 children). Its
  `pipelineStage` is `"research"` which triggers `E_LIFECYCLE_GATE_FAILED` if children try to
  complete before the parent advances. The orchestrator must advance T1844's lifecycle before
  children can complete. This is a structural issue but not a blocker for starting Wave 0.

- **T1834 (perf) has confirmed full-table scan.** `context.ts:135` and `impact.ts:109` both
  call `db.select().from(nexusSchema.nexusNodes).all()` loading ALL rows before in-memory filter.
  The fix is a `WHERE project_id = ?` SQL filter. The `context.ts` file does have `projectId`
  in its function signature (line 95). The Drizzle `eq()` + `where()` pattern is the fix path.
  T1834 is blocked on T1845 — correct, as the benchmark harness is needed to assert the
  p50 <500ms criterion.

- **`method_overrides` and `method_implements` ARE already present in `packages/contracts/src/graph.ts`**
  (lines 93-94). T1846 and T1847 tasks say they need to add these — the schema entries exist.
  The real work is emission only. Worker briefings must clarify: schema already present, add
  emission logic only. Do NOT re-add to contracts.

---

## Wave Plan

### Wave 0 (parallel-safe, spawn IMMEDIATELY)

These tasks have no inter-dependencies and can run in parallel.

- **T1865** — Merge T1836+T1837 (DEFINES+ACCESSES) into main via `git merge --no-ff` —
  risk:low — est:S — agent_role: Worker
  - Status: gate-passed, branch `task/T1865` is merge-ready
  - After merge: run DEFINES regression suite, evaluate whether T1866 closes or needs work

- **T1845** — Reproducible benchmark harness (nexus-vs-gitnexus JSON diff, CI gate) —
  risk:med — est:M — agent_role: Worker
  - No deps (T1841 infra is done, T1845 builds on top of it)
  - Creates `scripts/bench/nexus-vs-gitnexus.mjs` + wires into `pnpm bench:nexus`
  - Unblocks: T1834 (perf fix)

- **T1861** — Port LanguageConfig dataclass pattern (generic extractor, Java demo) —
  risk:med — est:L — agent_role: Worker
  - No blocking deps (T1841 infra is done)
  - Creates `packages/nexus/src/pipeline/extractors/language-config.ts` +
    `packages/nexus/src/pipeline/extractors/generic-extractor.ts`
  - Adds Java via LanguageConfig to prove the pattern
  - Unblocks: remaining multi-language extractors in T1840

- **T1862** — Confidence labels on extracted edges (EXTRACTED|INFERRED|AMBIGUOUS) —
  risk:med — est:M — agent_role: Worker
  - No blocking deps (T1841 infra is done)
  - Modifies `packages/contracts/src/graph.ts` (GraphRelation) + all 4 extractors
  - NOTE: Wave 0 only if T1865 is running in parallel. If T1865 merge touches the same
    files (parse-loop.ts, extractor files), T1862 worker must coordinate or take T1865
    as a merge-base. **Recommend spawning T1862 AFTER T1865 merge completes** to avoid
    conflict. Demote to Wave 1 if parallelism causes concern.

### Wave 1 (after T1865 merge confirmed + T1866 evaluated)

- **T1866** — DEFINES emission wiring hotfix — risk:low — est:S — agent_role: Worker
  - CONDITION: only needs work if DEFINES count is still 0 after T1865 merge
  - If T1865 merge resolves the regression: close T1866 with evidence note
  - If regression persists: worker inspects `parse-loop.ts` call sites and fixes wiring
  - Files: `packages/nexus/src/pipeline/parse-loop.ts`,
           `packages/nexus/src/pipeline/index.ts`

- **T1846** — METHOD_OVERRIDES emission (schema already present in contracts) —
  risk:med — est:M — agent_role: Worker
  - Depends on: T1865 merge (to avoid parse-loop conflicts)
  - Schema entry `method_overrides` already in contracts/src/graph.ts line 93 — emit ONLY
  - Heritage extractor (heritage-processor.ts) or per-extractor is the injection site

- **T1847** — METHOD_IMPLEMENTS emission (schema already present in contracts) —
  risk:med — est:M — agent_role: Worker
  - Depends on: T1865 merge (same reason)
  - Schema entry `method_implements` already in contracts/src/graph.ts line 94 — emit ONLY
  - Can run in parallel with T1846

### Wave 2 (after T1845 benchmark harness + T1865 merge)

- **T1834** — PERF: context.ts/impact.ts/clusters.ts full-table scan fix —
  risk:low — est:M — agent_role: Worker
  - Depends on: T1845 (benchmark harness must exist to assert p50 <500ms criterion)
  - Files: `packages/core/src/nexus/context.ts`, `packages/core/src/nexus/impact.ts`,
           `packages/core/src/nexus/clusters.ts`
  - Fix pattern: Drizzle `where(eq(nexusSchema.nexusNodes.projectId, projectId))` instead
    of `.all()` then in-memory filter

### Wave 3 (after T1838 decision recorded + T1841 infra confirmed)

- **T1843** — Swift explicit-import tree-sitter extractor —
  risk:high — est:L — agent_role: Worker
  - Currently blocked on T1838 (decision task) which is blocked on T1827
  - HITL required to unblock T1838 dep chain (see Open Questions)
  - If T1838 dep on T1827 is removed: T1843 can start after T1841 (already done) + T1861

### Wave 4 (after all T1844 children done + T1845 + T1834)

- **T1042 close ceremony** — verify all close-out gates passed, run `cleo complete T1042` —
  risk:low — est:S — agent_role: Worker
  - Gate checklist: T1845 done + T1834 done + T1836 done (via T1865) + T1837 done (via T1865)
    + T1839 done (already) + T1833 done (already) + T1846 done + T1847 done
  - Note: T1843 (Swift) and T1861 (LanguageConfig) and T1862 (confidence labels) are
    enhancements — T1042 close does NOT require them per T1042's acceptance criteria
  - Run `cleo lifecycle complete T1044` if needed to advance T1844 pipelineStage first

---

## IVTR Strategy per Task

### T1865 — Merge DEFINES+ACCESSES into main

- **Files:** `packages/nexus/src/pipeline/parse-loop.ts` (primary), `packages/nexus/src/__tests__/extractor-regression.test.ts`
- **Acceptance:** `git merge --no-ff task/T1865` succeeds; `pnpm --filter @cleocode/nexus run test` passes 152+ tests; DEFINES regression suite reports >= 30 edges
- **Test invocation:** `pnpm --filter @cleocode/nexus run test`
- **Evidence atoms:** `commit:<merge-sha>;files:packages/nexus/src/pipeline/parse-loop.ts` + `tool:test` + `tool:lint;tool:typecheck`

### T1845 — Benchmark harness

- **Files:** `scripts/bench/nexus-vs-gitnexus.mjs` (new), `packages/nexus/package.json` (add `bench:nexus` script), `.github/workflows/ci.yml` (add CI gate)
- **Acceptance:** Script runs both tools against pinned fixture; emits JSON diff; `pnpm bench:nexus` exits 0; CI gate added on paths `packages/nexus/**,packages/core/src/nexus/**`
- **Test invocation:** `pnpm bench:nexus` (script-level), `pnpm --filter @cleocode/nexus run test`
- **Evidence atoms:** `commit:<sha>;files:scripts/bench/nexus-vs-gitnexus.mjs` + `tool:test` + `tool:lint;tool:typecheck`

### T1861 — LanguageConfig pattern port

- **Files:** `packages/nexus/src/pipeline/extractors/language-config.ts` (new), `packages/nexus/src/pipeline/extractors/generic-extractor.ts` (new), `packages/nexus/src/__tests__/extractor-regression.test.ts` (add Java snapshot)
- **Acceptance:** `language-config.ts` exports `LanguageConfig` interface; `generic-extractor.ts` exports `extractGeneric`; Java extractor demo passes T1841 regression snapshot; existing 4 extractor snapshot tests still pass
- **Test invocation:** `pnpm --filter @cleocode/nexus run test`
- **Evidence atoms:** `commit:<sha>;files:packages/nexus/src/pipeline/extractors/language-config.ts,packages/nexus/src/pipeline/extractors/generic-extractor.ts` + `tool:test` + `tool:lint;tool:typecheck` + `files:packages/nexus/src/pipeline/extractors/language-config.ts`

### T1862 — Confidence labels

- **Files:** `packages/contracts/src/graph.ts` (extend GraphRelation), `packages/core/src/nexus/parse-loop.ts` (annotate edges)
- **Acceptance:** GraphRelation has `confidence: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS'`; tier1 = EXTRACTED, tier2a = INFERRED, tier3 = AMBIGUOUS; snapshot tests assert >70% EXTRACTED on fixtures
- **Test invocation:** `pnpm --filter @cleocode/nexus run test && pnpm --filter @cleocode/core run test`
- **Evidence atoms:** `commit:<sha>;files:packages/contracts/src/graph.ts,packages/core/src/nexus/parse-loop.ts` + `tool:test` + `tool:lint;tool:typecheck`

### T1866 — DEFINES hotfix (conditional)

- **Files:** `packages/nexus/src/pipeline/parse-loop.ts`, `packages/nexus/src/pipeline/index.ts`
- **Acceptance:** DEFINES regression suite `>= 30` edges after main merge of T1865; if count=0 post-merge, fix emission call site
- **Test invocation:** `pnpm --filter @cleocode/nexus run test`
- **Evidence atoms:** `commit:<sha>;files:packages/nexus/src/pipeline/parse-loop.ts` + `tool:test` OR `note:superseded-by-T1865-merge` (if count >= 30 post-merge)

### T1846 — METHOD_OVERRIDES emission

- **Files:** `packages/nexus/src/pipeline/heritage-processor.ts` (primary emit site), `packages/nexus/src/__tests__/extractor-regression.test.ts` (add snapshot floor)
- **Acceptance:** `method_overrides` edges emitted non-zero on openclaw or fixture; contracts schema NOT modified (already present); snapshot test asserts >= 1 edge
- **Test invocation:** `pnpm --filter @cleocode/nexus run test`
- **Evidence atoms:** `commit:<sha>;files:packages/nexus/src/pipeline/heritage-processor.ts` + `tool:test` + `tool:lint;tool:typecheck`

### T1847 — METHOD_IMPLEMENTS emission

- **Files:** `packages/nexus/src/pipeline/heritage-processor.ts` (primary emit site), `packages/nexus/src/__tests__/extractor-regression.test.ts` (add snapshot floor)
- **Acceptance:** `method_implements` edges emitted non-zero on openclaw or fixture; schema NOT modified; snapshot test asserts >= 1 edge
- **Test invocation:** `pnpm --filter @cleocode/nexus run test`
- **Evidence atoms:** `commit:<sha>;files:packages/nexus/src/pipeline/heritage-processor.ts` + `tool:test` + `tool:lint;tool:typecheck`

### T1834 — Full-table scan perf fix

- **Files:** `packages/core/src/nexus/context.ts`, `packages/core/src/nexus/impact.ts`, `packages/core/src/nexus/clusters.ts`
- **Acceptance:** All 3 files use `where(eq(nexusSchema.nexusNodes.projectId, projectId))`; p50 assertion made via bench harness; existing tests pass
- **Test invocation:** `pnpm --filter @cleocode/core run test && pnpm bench:nexus`
- **Evidence atoms:** `commit:<sha>;files:packages/core/src/nexus/context.ts,packages/core/src/nexus/impact.ts,packages/core/src/nexus/clusters.ts` + `tool:test` + `tool:lint;tool:typecheck`

### T1843 — Swift extractor (Wave 3, gated)

- **Files:** `packages/nexus/src/pipeline/extractors/swift-extractor.ts` (new), `packages/nexus/src/__tests__/fixtures/swift/sample.swift` (new), `packages/nexus/package.json` (add tree-sitter-swift dep)
- **Acceptance:** Emits Function/Method/Class/Protocol nodes; explicit IMPORTS only (no O(m²)); fixture snapshot test passes; T1841 regression green
- **Test invocation:** `pnpm --filter @cleocode/nexus run test`
- **Evidence atoms:** `commit:<sha>;files:packages/nexus/src/pipeline/extractors/swift-extractor.ts` + `tool:test` + `tool:lint;tool:typecheck`

---

## Open Questions for HITL

1. **T1838 → T1827 dependency chain is likely incorrect.** T1838 is a "record decision" task
   (record the rejection of O(m²) Swift approach via `cleo memory decision-store`). Its dep
   on T1827 (ADR creation CLI plumbing) means Swift extractor (T1843) cannot start until ADR
   creation tooling ships. A decision can be recorded independently of the ADR creation flow.
   **Owner decision required:** Should T1838's dep on T1827 be removed? If yes, T1843 becomes
   Wave 3-ready immediately after T1841 (done) + T1861. If no, T1843 is blocked until T1827
   ships (which is itself behind T1826).

2. **T1844 pipelineStage is "research" but it has 6 children in "implementation".** The
   lifecycle gate on T1844 will block children from completing with `E_LIFECYCLE_GATE_FAILED`.
   **Owner decision required (or orchestrator action):** Advance T1844 lifecycle stage with
   `cleo lifecycle complete T1844` (through research → consensus → architecture_decision →
   specification → decomposition → implementation) before wave workers try to complete.

3. **T1862 (confidence labels) touches `packages/contracts/src/graph.ts`** — the same file
   that T1846 and T1847 may read. If T1862 adds a `confidence` field to `GraphRelation` BEFORE
   T1846/T1847 land, those workers may need to annotate their emitted edges too. Wave ordering
   recommendation: T1862 either runs in Wave 1 (after T1865) in parallel with T1846/T1847, OR
   the worker for T1846/T1847 is briefed that they must add `confidence: 'EXTRACTED'` to any
   emitted edges if T1862 has landed. **No HITL required — orchestrator should sequence T1862
   before T1846/T1847 or pass a coordination note.**

---

## New Tasks Proposed (decomposition gaps found)

- **Proposed: T####** — "Advance T1844 lifecycle stage to implementation" — parent: T1844 —
  rationale: T1844.pipelineStage is "research" but all child tasks are implementation-ready.
  The lifecycle gate will block `cleo complete` for T1836, T1837, T1846, T1847, T1865, T1866
  children. A meta-task to run `cleo lifecycle complete T1844` through all intermediate stages
  is needed before any child task attempts to complete. This can be a `--no-worktree` spawn.

- **Proposed: T####** — "Update SUPERSESSION-EVIDENCE.md with T1844 edge emission counts" —
  parent: T1042 — rationale: T1044 acceptance criterion #6 requires SUPERSESSION-EVIDENCE.md
  to be updated with corrected DEFINES/ACCESSES/METHOD_OVERRIDES/METHOD_IMPLEMENTS counts after
  emission is live. This is a documentation-only task that belongs AFTER T1846 + T1847 + T1865
  merge, targeting the close ceremony (Wave 4). Currently no task tracks this explicitly.

---

## Risks & Mitigations

- **Risk: T1865 merge conflicts with recent main commits (v2026.5.22-v2026.5.25)** — T1865's
  merge base is `e78994a8a` but main has 10+ commits since. `package.json` version bumps and
  studio/worktree package changes appear in the diff (53 files, 1742 deletions mostly package
  versioning). **Mitigation:** Worker must rebase T1865 onto current main before merging, or
  resolve conflicts carefully. The parse-loop.ts additions are likely conflict-free (main has
  no DEFINES code); the bulk of the diff is version bumps that will trivially resolve.

- **Risk: T1844 lifecycle gate blocks child completion** — Children (T1836, T1837, T1846,
  T1847, T1865, T1866) are parented under T1844 which is stuck in "research" stage. Any
  `cleo complete <child>` will fail with E_LIFECYCLE_GATE_FAILED. **Mitigation:** File the
  proposed lifecycle-advance task and run it before Wave 1 completions. Alternatively the
  orchestrator can use `CLEO_OWNER_OVERRIDE=1` if owner approves — but prefer the clean path.

- **Risk: T1866 may be a real bug, not just a pre-T1865-merge artifact** — The T1865
  worker used OWNER_OVERRIDE evidence atoms (not programmatic proof) for testsPassed and
  implemented gates. If the actual test run on T1865 shows DEFINES=0, the wiring bug is real.
  **Mitigation:** T1865 merge worker MUST run `pnpm --filter @cleocode/nexus run test` and
  capture actual DEFINES edge count — if 0, do NOT complete T1865; pivot to T1866 hotfix
  immediately with correct emission wiring.

- **Risk: T1834 p50 assertion cannot be made without real openclaw data** — The benchmark
  needs gitnexus installed AND openclaw at a pinned commit. Worker must verify gitnexus is
  available (`/home/keatonhoskins/.npm-global/bin/gitnexus`) and openclaw is accessible
  at `/mnt/projects/openclaw`. **Mitigation:** Worker should check both preconditions before
  starting T1845. If openclaw is unavailable, use the `packages/nexus/src/__tests__/fixtures/`
  corpus as a proxy fixture for the JSON diff baseline.

- **Risk: `method_overrides` / `method_implements` emission requires AST-level analysis** —
  Detecting overrides requires knowing which methods in subclass match a base class method
  name. This requires heritage processor context (who extends whom). The heritage-processor.ts
  already builds this map — T1846/T1847 workers should hook into `processHeritage()` not
  try to re-derive inheritance independently. **Mitigation:** Worker briefings for T1846/T1847
  MUST point to `packages/nexus/src/pipeline/heritage-processor.ts` as the canonical emission
  site — NOT individual extractors.
