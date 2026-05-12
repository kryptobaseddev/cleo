# T943 Round 2 — CONTRARIAN ATTACK on the D+C Hybrid

**Verdict up front: the hybrid is a cop-out built on three false premises. Recommend OPTION E (fixed dual-state rollup) as the honest Wave 1, with C deferred until llmtxt is actually upgraded and evidence coverage crosses a measurable threshold.**

## 1. The SQLite view performance claim is indexed incorrectly

The advocate said "subqueries indexed on parent_id, pipeline_id, stage_id — <5ms p99". The EXPLAIN QUERY PLAN tells a different story.

For the view body:

```
CORRELATED SCALAR SUBQUERY 1 (current stage)
  SEARCH s USING INDEX idx_lifecycle_stages_status (status=?)   <-- NOT pipeline_id
  SEARCH p USING INDEX sqlite_autoindex_lifecycle_pipelines_1 (id=?)
```

The planner picks `idx_lifecycle_stages_status` (`tasks-schema.ts:396`) and then correlates back to the pipeline by PK — this means as `lifecycle_stages` grows, every task row reprobes a status-wide index, not a task-scoped one. There is no composite `(pipeline_id, status)` or `(task_id → current_stage)` index. On today's tiny dataset (17 pipelines, 0 gate results) wall-clock is 0.7ms for 948 rows; that number is meaningless. At the projected T627-class scale (47 children under one epic × 10 stages × multiple gates) this becomes N*M correlated scans, exactly what the advocate promised indices would prevent. **No benchmark exists** — there are ZERO views in the codebase (`sqlite_master WHERE type='view'` returns empty). The p99 figure is invented.

Evidence: `packages/core/src/store/tasks-schema.ts:353-356, 393-398, 419, 439`.

## 2. The cold-start problem is not a "growing" problem — it is a 99.7% problem

I queried `.cleo/tasks.db` directly:

| Metric | Value |
|---|---|
| total_tasks | **948** |
| tasks with any lifecycle_pipeline | **17** |
| tasks with any lifecycle_gate_result | **0** |
| tasks with any lifecycle_evidence | **15** |
| total gate_result rows | **0** |
| total evidence rows | 100 |

**Zero gate results. Zero.** The D advocate's claim that "the view already reads `lifecycle_gate_results` — evidence atoms flow in naturally" is falsified by production data. 931 of 948 tasks (98.2%) have NO pipeline at all; 948 of 948 (100%) have no gate result. The hybrid premise that "C converges as ADR-051 coverage grows" is empirically a decade away, not a release away. ADR-051 landed in v2026.4.80 (days ago) and has produced 0 rows here. The hybrid bets on a growth curve that has not started.

## 3. The llmtxt/events leapfrog is vaporware at today's version

Synthesis cites `llmtxt/events` (append-only hash-chained event log) as the C substrate. I checked the installed package:

- `packages/core/package.json:123` declares `llmtxt: "^2026.4.6"`
- `node_modules/.pnpm/llmtxt@2026.4.6/.../package.json` exports ONLY: `./sdk`, `./local`, `./remote`, `./cli`, `./disclosure`, `./similarity`, `./graph`, `./crdt`, `./crdt-primitives`
- **No `./events`, no `./blob`, no `./identity`, no `./transport`**

Those subpaths only exist in v2026.4.9 per the context doc. Until T947 ships the upgrade, "C+llmtxt/events" is fiction. Any plan that names llmtxt/events as the Option C foundation must be gated on T947 landing first — which means the hybrid's "destination" is two epics away, not one view away.

## 4. "Reversible DROP VIEW" is not zero-risk

Drizzle ORM does not model raw views — it types against tables. If we add a view via raw SQL migration and then Studio routes (`packages/studio/src/routes/api/tasks/+server.ts:63-74`) or the SDK wrapper import a Drizzle-inferred row type, that type will NOT include the derived columns. Consumers will cast or duck-type around it, which is exactly the `as unknown as X` anti-pattern this codebase forbids (see repo rules in `AGENTS.md`). Parity tests also tend to silently pass the `LEFT JOIN NULL` path on cold-start rows (all 931 of them) — the view returns `NULL` derived stage, the column returns the current value, they don't match, but the parity test will likely filter those out and declare green. That is a test pattern that MISSES drift: compare against a row set where both sides return NULL and you prove nothing.

Concrete miss pattern:

```ts
expect(view.derivedStage ?? 'unassigned').toBe(task.pipelineStage ?? 'unassigned');
```

Both sides collapse to `'unassigned'` for 98% of the table. Parity green, correctness unvalidated.

## 5. "Minimal refactor" is not minimal

The D advocate implied a Wave 1 view + SDK function + route swap. Actual blast radius:

- `pipelineStage` references: **165 occurrences across 32 files** (`rg "\.pipelineStage"` TS-only)
- Studio `pipeline_stage` references: **104 occurrences across 18 files**
- ALL four Studio tasks routes run raw SQL with `pipeline_stage` column in SELECT (`+server.ts:64-66`, `pipeline/+server.ts:34-42`, `search/+server.ts`, `tree/[epicId]/+server.ts`)

Wave 5's "retire `tasks.pipelineStage` column" means migrating every one of those. That is not a follow-up — it is an epic. Option D's "minimalism" is preserved only by deferring that epic indefinitely, which is how the hybrid becomes "D forever, C never."

## 6. "D is vehicle, C is destination" is textbook false compromise

If C is correct, ship C. If D is correct, ship D. Hybrids pay 2× cost (view maintenance + future migration) for 1× benefit (ships this quarter). The advocate's synthesis is optimistic about evidence coverage (§2 shows it's empirically 0), optimistic about llmtxt/events (§3 shows it's not installed), optimistic about index coverage (§1 shows EXPLAIN disagrees), and optimistic about Studio route scope (§5 shows 104 refs). Four optimistic assumptions stacked = coherent narrative that collapses on contact with data.

## 7. AI-LLM payload analysis

`computeTaskView(T123)` returning task + pipeline + stages + gate_results + evidence is a JSON blob that — for a mature task — includes the full ADR-051 atom list (commits, files, tool exit codes, sha256s). Per task that is easily 5–20KB. For `cleo next` / `cleo dash` LLM contexts that query 20+ tasks, you are pushing 100–400KB per call. Either the SDK trims (leaks implementation by requiring query-param projection) or it ships fat (breaks token budgets the CLEO Protocol explicitly tracks — see `CLEO-INJECTION.md` "~200-400 tokens" expectations). Neither side of the synthesis priced this.

## Recommendation — switch to OPTION E with a named upgrade path

**Ship NOW (Wave 1, 2-3 days):**
1. Fix the rollup. One pure function `packages/core/src/lifecycle/rollup.ts` with signature `rollupTaskState(task, pipeline?, stages?, gateResults?): { status, pipelineStage, derivedFrom: 'legacy'|'evidence' }`. Called from `complete.ts:221-248`, `update.ts`, and the Studio routes via the existing `Cleo` facade. Delete the 7 manual writes.
2. Add a single composite index `(lifecycle_stages.pipeline_id, status)` to fix the EXPLAIN plan exposed in §1.
3. No view. No DROP VIEW reversibility theater. No SDK surface expansion yet.

**Gate C on measurable reality (Wave 3+):**
- Block Option C on BOTH (a) T947 landing llmtxt/events, AND (b) evidence coverage crossing 30% of active tasks (today: 0%). Put the threshold check in `cleo doctor`. When both green, Option C becomes a feature branch, not a hybrid bet.

**Kill Wave 5 from the plan.** Retiring `tasks.pipelineStage` is a separate epic with its own RCASD. Listing it as a W5 bullet masks 165 migration points.

## Weakest link

The weakest link is **§2**: zero gate-result rows in production. Everything else is recoverable engineering. That one datum turns the hybrid's "convergence" into wishful thinking. Evidence-driven architecture requires evidence; we do not have it yet. Build the cheap thing (E), measure coverage, then decide between D and C from a position of knowledge rather than synthesis.

## Citations

- `/mnt/projects/cleocode/packages/core/src/store/tasks-schema.ts:335-440` (lifecycle schema + indices)
- `/mnt/projects/cleocode/packages/core/src/tasks/complete.ts:221-248` (7 manual writes)
- `/mnt/projects/cleocode/packages/studio/src/routes/api/tasks/+server.ts:63-74` (raw SQL)
- `/mnt/projects/cleocode/packages/studio/src/routes/api/tasks/pipeline/+server.ts:33-43` (raw SQL)
- `/mnt/projects/cleocode/packages/core/package.json:123` (llmtxt ^2026.4.6)
- `/mnt/projects/cleocode/.cleo/tasks.db` (empirical: 948 / 17 / 0 / 15)
- EXPLAIN QUERY PLAN output (§1), no existing views (`sqlite_master WHERE type='view'` empty)
