# T910 Dispatch Cast Audit — Latent Schema-Drift Reconciliation

> **Operator mandate**: "there MUST BE ZERO latent schema-drift — this must be reconciled and fixed across the codebase."
> **Scope**: `packages/cleo/src/dispatch/` (non-test source)
> **Generated**: 2026-04-18
> **Status**: Evidence-only. No source changes yet.

---

## Executive summary

| Metric | Value |
|---|---|
| Total `as SomeType` casts (non-test) | **174** |
| Total `params?.xxx as Y` param casts (domains) | **579** |
| `Record<string, unknown>` occurrences | **130** |
| `: unknown` annotations (incl. `catch err: unknown`) | **205** |
| Domain handlers still using `params?: Record<string, unknown>` entry signature | **34 method signatures** across 14 handler files |
| Typed contracts already published in `@cleocode/contracts/src/operations/` | **22 tasks params** + **31 brain params** + session/orchestrate/nexus (≥ 2275 LOC) |
| Current state | Dispatch contracts EXIST; dispatch code does NOT IMPORT them. |

**Root cause in one line**: the typed Params types were authored in `@cleocode/contracts/src/operations/*.ts` (tasks at some point in 2026-03, brain/conduit/nexus at commit `12a881991` on **2026-04-18**) but the domain handlers were never refactored to consume them. Every handler still starts with `Record<string, unknown>` and hand-casts each field at the call site.

---

## Section 1 — Quantification

Per-handler breakdown (source: grep over each file, excluding `__tests__`):

| Domain | Handler file | Total `as Y` casts | `params?.x as Y` param casts | `Record<string,unknown>` | `: unknown` | Typed ops available? |
|---|---|---:|---:|---:|---:|---|
| tasks | `domains/tasks.ts` | 0 | **79** | 2 | 0 | **Yes** — `contracts/src/operations/tasks.ts` (22 `*Params` interfaces) |
| memory (= brain) | `domains/memory.ts` | 5 | **88** | 3 | 0 | **Yes** — `contracts/src/operations/brain.ts` (31 params, authored 2026-04-18) |
| check | `domains/check.ts` | 2 | **58** | 3 | 0 | Partial — lives in contracts/src/validate.ts / operations/validate.ts |
| admin | `domains/admin.ts` | 1 | **107** | 3 | 1 | Partial — scattered; no canonical `AdminGetParams` etc. |
| pipeline | `domains/pipeline.ts` | 9 | **69** | 13 | 0 | Partial — `contracts/src/operations/release.ts` + `lifecycle.ts` but pipeline-specific gaps |
| orchestrate | `domains/orchestrate.ts` | 2 | **39** | 6 | 2 | **Yes** — `contracts/src/operations/orchestrate.ts` (199 LOC) |
| nexus | `domains/nexus.ts` | 2 | **34** | 2 | 0 | **Yes** — `contracts/src/operations/nexus.ts` (711 LOC, 2026-04-18) |
| session | `domains/session.ts` | 0 | **31** | 2 | 0 | **Yes** — `contracts/src/operations/session.ts` (131 LOC) |
| tools | `domains/tools.ts` | 3 | **25** | 11 | 1 | Partial |
| sticky | `domains/sticky.ts` | 0 | **18** | 2 | 0 | No canonical `StickyAddParams` |
| docs | `domains/docs.ts` | 2 | **13** | 2 | 1 | No canonical `DocsAddParams` |
| conduit | `domains/conduit.ts` | 0 | **10** | 2 | 1 | **Yes** — `contracts/src/operations/conduit.ts` (2026-04-18) |
| intelligence | `domains/intelligence.ts` | 0 | **5** | 2 | 0 | No canonical contracts — domain not in registry-canonical set |
| ivtr | `domains/ivtr.ts` | 2 | **0** (uses `params?.['evidence']` pattern) | 3 | 0 | No IVTR-specific params contracts |
| diagnostics | `domains/diagnostics.ts` | 0 | 0 (uses `typeof` guards — **best-in-class**) | 2 | 2 | — |
| playbook | `domains/playbook.ts` | 3 | **3** (uses normalizeListStatus + typeof) | 11 | 2 | Partial |
| **TOTAL domains** | | **31** | **579** | **69** | **10** | |
| **All engines (session-engine, orchestrate-engine, task-engine, …)** | 20 files | **~140** casts | — | 31 | 195 | — |
| **Registry / types / adapter** | 3 files | 1 | 0 | 7 | 2 | — |

Key observations from this table:

1. **`admin.ts` (107) + `memory.ts` (88) + `tasks.ts` (79) + `pipeline.ts` (69)** together account for **343 / 579 = 59%** of all param casts.
2. **Session + tasks have typed contracts already available** and would be the cheapest wins.
3. **Engines are a separate beast**: most of the 195 `: unknown` appearances in engine files are `catch (err: unknown)` — those are *legitimate* TypeScript strict-mode defensive patterns, not schema drift.
4. **`diagnostics.ts` is the gold standard** — zero param casts, uses `typeof params?.days === 'number' ? params.days : 30`. This pattern should become the template.

---

## Section 2 — Category-by-category catalog

### Category A — Input parameter casting (`params?.x as T`)

**579 occurrences** across 14 domain handlers. The T910 contracts (`contracts/src/operations/tasks.ts`, `brain.ts`, etc.) already expose the exact typed `*Params` shapes these casts are re-inventing.

**Representative sample** (full file:line list in the grep dumps at `/home/keatonhoskins/.claude/projects/.../toolu_01TSW5WTqP3iecrYvPwWExPk.txt`):

**tasks.ts** — 79 casts (every field reinvented at call site):
- `packages/cleo/src/dispatch/domains/tasks.ts:82` — `params!.taskId as string` → **should** be `TasksGetParams.taskId` (already exported at `contracts/src/operations/tasks.ts`)
- `packages/cleo/src/dispatch/domains/tasks.ts:95-104` (list) — `params?.parent as string | undefined`, `params?.status as string | undefined`, `params?.priority as string | undefined`, `params?.type as string | undefined`, `params?.phase as string | undefined`, `params?.label as string | undefined`, `params?.children as boolean | undefined`, `params?.limit as number | undefined`, `params?.offset as number | undefined`, `params?.compact as boolean | undefined`  → **all** exist as fields on `TasksListParams`
- `packages/cleo/src/dispatch/domains/tasks.ts:112-121` (find) — 9 casts for a single operation
- `packages/cleo/src/dispatch/domains/tasks.ts:280-316` (add + update) — 37 casts across two ops

**memory.ts** — 88 casts:
- `packages/cleo/src/dispatch/domains/memory.ts:73` — `params?.query as string` → `BrainFindParams.query`
- `packages/cleo/src/dispatch/domains/memory.ts:114-115` — `depthBefore`/`depthAfter as number | undefined` → typed in `BrainTimelineParams`
- `packages/cleo/src/dispatch/domains/memory.ts:153-154` — `params?.type as Parameters<typeof memoryPatternFind>[0]['type']` — this is the **worst pattern**; it ties the domain handler to the core implementation's internal signature, bypassing any API contract

**admin.ts** — 107 casts (largest single offender):
- `packages/cleo/src/dispatch/domains/admin.ts:449-470` (token.record) — 22 casts in one case block
- `packages/cleo/src/dispatch/domains/admin.ts:1056-1067` (audit.log.token) — 11 casts duplicating the above

**pipeline.ts** — 69 casts:
- `packages/cleo/src/dispatch/domains/pipeline.ts:820` — `params?.entry as Parameters<typeof pipelineManifestAppend>[0]` — same anti-pattern as memory.ts:153
- `packages/cleo/src/dispatch/domains/pipeline.ts:1048` — `params?.chain as WarpChain` — at least references a named type, but still cast
- `packages/cleo/src/dispatch/domains/pipeline.ts:1088-1089` — `Record<string, unknown>` casts propagating up

**nexus.ts** — 34 casts:
- `packages/cleo/src/dispatch/domains/nexus.ts:241-242` — `(params?.mode as 'copy' | 'move') ?? 'copy'` — inline string union repeated at 289, 317-318, 399-403
- Same union written out 4 times across the file = drift surface

**session.ts, sticky.ts, conduit.ts, orchestrate.ts** — follow the same uniform pattern. See grep dump for 1:1 lines.

### Category B — Return type widening (`result as Foo`)

**~90 occurrences across engines** (mostly `*-engine.ts`). These are where internal results are widened before being returned as `data?: unknown` on the envelope. These are *less harmful* because they represent the output boundary, not user input, but they still mask drift.

Representative:
- `packages/cleo/src/dispatch/engines/system-engine.ts:379-401` — 13 consecutive `as Record<string, unknown>` / `as DashboardData['...']` casts while mapping a result object
- `packages/cleo/src/dispatch/engines/system-engine.ts:462-486` — 9 casts in stats.show
- `packages/cleo/src/dispatch/engines/session-engine.ts:500-502` — `JSON.parse(pred.debriefJson as string) as DebriefData` — **two** stacked casts; the JSON cast is legitimate (Category D), the outer `DebriefData` cast is Category B
- `packages/cleo/src/dispatch/engines/nexus-engine.ts:104,233` — `page.items as Awaited<ReturnType<typeof nexusList>>` — another "bypass contracts, mirror implementation" pattern
- `packages/cleo/src/dispatch/engines/tools-engine.ts:98,307,393,627,812` — 5 `as ReturnType<typeof X>` casts

### Category C — Error shape casting (`err as Error`)

**~90 occurrences**, one per `catch` block across engines. Pattern `(err as Error).message`.

Representative:
- `packages/cleo/src/dispatch/engines/release-engine.ts` — **28** occurrences of `(err as Error).message`
- `packages/cleo/src/dispatch/engines/orchestrate-engine.ts` — **16** occurrences
- `packages/cleo/src/dispatch/engines/system-engine.ts` — **36** occurrences
- `packages/cleo/src/dispatch/engines/validate-engine.ts` — ~20
- `packages/cleo/src/dispatch/engines/task-engine.ts` — **34**

These are **mostly legitimate** (TS strict mode forces `unknown` in `catch`) but should use a helper like `errorMessage(err)` from `_error.ts` — which *exists* at `packages/cleo/src/dispatch/engines/_error.ts:342` (`err as CaughtCleoErrorShape`) but isn't consumed uniformly.

### Category D — Legitimate unknowns (JSON parse, dynamic imports, Object entries)

**~20 occurrences**. Keep these, but annotate the boundary:

- `packages/cleo/src/dispatch/engines/session-engine.ts:500` — `JSON.parse(pred.debriefJson as string)` (source column is `string | null`; legitimate)
- `packages/cleo/src/dispatch/domains/admin/smoke-provider.ts:266` — `(await import(adapterDistPath)) as Record<string, unknown>` — dynamic import (legitimate)
- `packages/cleo/src/dispatch/domains/playbook.ts:217,227` — `parsed as Record<string, unknown>` inside `parseContextJson` — legitimate JSON.parse return
- `packages/cleo/src/dispatch/lib/config-loader.ts:125` — `validateField(key: string, value: unknown): void` — legitimate input validation signature
- `packages/cleo/src/dispatch/middleware/projection.ts:35,69-84` — generic prune/walk helpers over `unknown` — legitimate
- `packages/cleo/src/dispatch/lib/background-jobs.ts:73,181` — `row.status as BackgroundJobStatus` where `row` comes from a raw SQL select — legitimate IF the DB schema enforces the domain. Would be even better if drizzle schemas validated this at the ORM layer.

### Cast-heavy "anti-pattern" sub-categories within A

Two problematic *styles* inside Category A that deserve calling out:

**A1. `Parameters<typeof someCoreFn>[0]` casts** — ties dispatch to core function shape, bypasses contract:
- `packages/cleo/src/dispatch/domains/memory.ts:153-154, 645, 648`
- `packages/cleo/src/dispatch/domains/pipeline.ts:714, 820`
- `packages/cleo/src/dispatch/domains/ivtr.ts:267, 282`
- `packages/cleo/src/dispatch/lib/budget.ts:69, 125`

**A2. Literal string unions repeated inline** — same 3–4 literal unions hand-written at ≥2 call sites:
- `'yellow' | 'blue' | 'green' | 'red' | 'purple'` — sticky.ts lines 47, 137
- `'low' | 'medium' | 'high'` — sticky.ts 48, 138; session.ts 340
- `'copy' | 'move'` — nexus.ts 241, 399
- `'single' | 'subtree'` — nexus.ts 242, 400
- `'cli' | 'api' | 'agent' | 'unknown'` — admin.ts 450, 485, 1058, 1099 (4×)
- `'global' | 'project'` or `'project' | 'global'` — tools.ts 396, 494, 548
- `'strip' | 'placeholder' | 'fail'` — admin.ts 992
- `'skip' | 'overwrite' | 'rename'` — admin.ts 1018
- `0 | 1 | 2` — orchestrate.ts 362, 390, 420

Each of these *is* the drift the operator is talking about: the moment one handler adds `'orange'` to the sticky color set, the other handler silently accepts an undefined behavior, and TypeScript can't help.

---

## Section 3 — Root cause analysis

### Timeline reconstruction (from `git log --follow`)

| Date | Event |
|---|---|
| **2026-03-18** | `feat: COMPLETE MONOREPO — 6 packages, 0 errors, 4734 tests passing` — commit `d821281bb`. First appearance of `packages/cleo/src/dispatch/domains/tasks.ts` in git history. Already shaped as `Record<string, unknown>` at birth. |
| **2026-03-18** | Same commit — `packages/cleo/src/dispatch/types.ts` first appears. `DomainHandler.query` signature is `Record<string, unknown>` from day 1. |
| **2026-03-18** | `contracts/src/operations/tasks.ts` first appears (commit `d821281bb`). The *typed* `TasksGetParams` interface has existed for **a month** before this audit. **Dispatch never imported it.** |
| **2026-03-19** | T001 provider-agnostic reconciliation engine added (`f901ee3ee`). Maintains the untyped pattern. |
| **2026-03-20** | T069 MCP/CLI parity (`7d3730a6c`). Untyped pattern solidified. |
| **2026-04-03** | `feat(core): remove MCP dispatch, ship CLI-only per MODERN-CLI-STANDARD` — MCP removed, CLI became the only transport. Would have been the ideal moment to retype the dispatch but it was not done. |
| **2026-04-14 → 2026-04-16** | T760 RCASD pomodoro feedback / T882 spawn rebuild / T889 coherence foundation. Dispatch layer continued to accrete. |
| **2026-04-18** | **Commit `12a881991`** — `feat(contracts): add brain/conduit/nexus operation contracts`. Today's commit. Extends contracts to brain (31 params), conduit, nexus. Dispatch still hasn't adopted any of them. |

### Was there an earlier typed version?

**No.** The dispatch layer was born untyped on 2026-03-18. The "typed contracts" were authored *alongside* it in the same commit (see: `packages/contracts/src/operations/tasks.ts` dates to the same `d821281bb` commit). The contracts exist as *documentation of the intended API surface* but the dispatch code has never imported them. This is the drift: contracts say one thing, handlers implement another, TypeScript can't cross-check because both sides accept `Record<string, unknown>`.

### Is there a factory/adapter pattern that could fix this in one place?

**Yes — and it would be trivially small.** All 4 middleware entries already receive a fully-typed `DispatchRequest`; the gap is entirely between `DispatchRequest.params: Record<string, unknown>` on `types.ts:83` and the per-op typed `*Params` interfaces in `contracts/operations/*.ts`.

The dispatcher **already has** the operation resolver (`registry.ts:5080-5095` — `resolveOperation(gateway, domain, operation) → Resolution`). It also **already has** `validateRequiredParams(def, params)` at `registry.ts:5099`. Both drop typing at the boundary. A single `typedParams<T>(def, params): T` helper wired into the registry would eliminate 500+ casts across 14 files.

---

## Section 4 — Fix strategy (three approaches)

### Option A — Adapter layer (single-point fix) [**RECOMMENDED**]

Extend the registry / adapter with a generic boundary:

```
// types.ts additions (sketch, do not ship yet)
export interface TypedDomainHandler<Ops extends Record<string, { Params: unknown; Result: unknown }>> {
  query<K extends keyof Ops>(op: K, params: Ops[K]['Params']): Promise<LafsEnvelope<Ops[K]['Result']>>;
  mutate<K extends keyof Ops>(op: K, params: Ops[K]['Params']): Promise<LafsEnvelope<Ops[K]['Result']>>;
}
```

Coupled with a per-domain operation map imported from `contracts/operations/*.ts`:
```
// contracts/operations/tasks.ts already has:
//   TasksGetParams, TasksListParams, TasksFindParams, TasksCreateParams, ...
// Add an adjacent export:
export interface TasksOperations {
  get: { Params: TasksGetParams; Result: Task };
  list: { Params: TasksListParams; Result: Task[] };
  // ...
}
```

Each handler then declares `class TasksHandler implements TypedDomainHandler<TasksOperations>`.
The single cast lives in the dispatcher (`registry.ts resolveOperation` → typed params) after `validateRequiredParams` runs.

**Files to change**:
- `packages/cleo/src/dispatch/types.ts` — add `TypedDomainHandler`, keep `DomainHandler` deprecated alias (backward compat)
- `packages/cleo/src/dispatch/registry.ts` — add `typedDispatch<P, R>(def, params)` helper (~30 lines)
- `packages/cleo/src/dispatch/dispatcher.ts` — wire the helper once
- `packages/contracts/src/operations/*.ts` — add `XxxOperations` map per domain (~50 LOC per domain × 14 = 700 LOC contracts)
- 14 × `packages/cleo/src/dispatch/domains/*.ts` — swap signature, drop all `as T` param casts

**Risk of regression**: LOW-MEDIUM. The core behaviour doesn't change; only types tighten. Risks:
1. Contracts may be *incomplete* — a handler casts a field that isn't on the `*Params` interface yet. Detected at `tsc`. Fixed by extending the contract (that's the whole point).
2. Runtime-only flexibility (e.g., dynamic keys in admin.token.record) may need discriminated unions. Solvable.

**Incremental migration**: Ship domain-by-domain using a temporary `__legacy` bridge:
```
// legacy bridge during migration
class DomainHandlerAdapter<O> implements DomainHandler {
  constructor(private typed: TypedDomainHandler<O>) {}
  async query(op: string, p?: Record<string, unknown>): Promise<DispatchResponse> {
    // cast happens here, ONCE, with runtime guard
    return this.typed.query(op as keyof O, p as O[keyof O]['Params']);
  }
}
```
Order (cheapest first, biggest ROI last):
1. **session** (31 casts, contract exists) — 1 PR
2. **nexus** (34 casts, contract exists) — 1 PR
3. **orchestrate** (39 casts, contract exists) — 1 PR
4. **tasks** (79 casts, contract exists, the flagship) — 1 PR
5. **memory** (88 casts, contract shipped today) — 1 PR
6. **conduit** (10 casts, contract exists) — fold into memory PR
7. **sticky / docs / intelligence** — new contracts needed (~150 LOC each)
8. **pipeline** (69 casts) — new pipeline params contract
9. **check** (58 casts) — split between validate + check contracts
10. **admin** (107 casts) — last, biggest. Break into admin.audit / admin.token / admin.snapshot sub-contracts.

**Testing strategy**:
- Existing parity tests (`packages/cleo/src/dispatch/__tests__/parity.test.ts`) already cover registry ↔ OPERATIONS alignment. Add a new test per domain that instantiates the typed handler and passes a fully-typed params object; compile-time success is the test.
- Run full `pnpm run test` after every handler migration.
- Add a `forge-ts` rule that fails build if any `params?.\w+ as ` appears under `packages/cleo/src/dispatch/domains/`.

**Effort estimate**: **MEDIUM** (3-5 days of focused work for all 14 domains, or ship as a 6-wave epic).

### Option B — Per-handler refactor

Rewrite each handler to take its typed `*Params` directly, no shared adapter. More code churn (~1400 LOC diff), but zero indirection.

**Pros**: Simplest mental model; each handler is a plain function `(params: TasksGetParams) => Promise<Task>`.
**Cons**: 579 call-sites touched individually; no single choke point where future drift can be enforced; `DomainHandler.query(op: string, …)` still needs to dispatch *somehow*, so you end up with a per-handler internal switch that maps string → typed fn. That switch becomes the new untyped surface unless you use A.

**Not recommended** as primary — it's effectively option A with more mechanical labour and worse future enforcement.

### Option C — Runtime validation (zod/ajv)

Add runtime schemas for every op. Validate at the dispatch entry point. The schema *generates* the TS type, so dispatch code uses `z.infer<typeof TasksGetParamsSchema>`.

**Pros**: Catches malformed input (wrong type from external CLI parsers); aligns with what `forge-ts` + `drizzle-zod` already do elsewhere in the monorepo (see `.skill: drizzle-orm` note about `createInsertSchema`); the owner's ground-truth ethos (STDP / extraction pipeline / typed memory) matches runtime validation.
**Cons**: Biggest change (adds zod to every op, ~2275 LOC of contracts need mirror schemas); subtle perf cost (~10-50µs per dispatch); needs a migration path from plain TS types to zod schemas in `@cleocode/contracts`.

**Feasibility today**: **HIGH**. `drizzle-orm/zod` is already available in the monorepo. The `@cleocode/contracts` package could emit both types and schemas (zod-first would cost <1 day to add for tasks domain).

**Recommended as follow-up to A**, not in place of it. Ship A first to kill drift at compile time, then layer C on top for runtime hardening.

### Comparison

| Criterion | A (Adapter) | B (Per-handler) | C (Runtime) |
|---|---|---|---|
| LOC changed | ~1200 | ~1400 | ~3000 |
| Compile-time safety | Full | Full | Full (via z.infer) |
| Runtime safety | None (contract is just TS) | None | Full |
| Migration risk | Low-med | Low | Medium |
| Future-drift prevention | Strong (single boundary) | Weak (no choke point) | Strongest |
| Matches operator's "ZERO drift" mandate | ✅ | ✅ | ✅✅ |
| Incremental shipping | Per-domain | Per-domain | Per-domain |
| Rollback cost | Low (remove adapter) | Low | Medium (remove zod) |

**Final recommendation**: **A now, C later.** Ship A domain-by-domain to eliminate the 579 param casts and lock the compile-time contract. Then layer C on top of A (same schemas, just swap TS interface for `z.infer`). Operator gets compile-time drift elimination in Wave 1, runtime drift elimination in Wave 2.

---

## Section 5 — Cross-package leakage

### `packages/core/src/tasks/*.ts`

Sample grep (non-exhaustive) shows **16 matches** across 10 files, but the pattern is different:
- `packages/core/src/tasks/add.ts:184-231` — `lower as TaskPriority`, `type as TaskType`, `size as TaskSize` after **explicit `VALID_*.includes(...)` guard**. These are **legitimate**: the guard narrows a string, then the cast is a no-op for the TS compiler. This is the "gold standard" pattern elsewhere in the repo.
- `packages/core/src/tasks/find.ts:127` — `archive.archivedTasks as Task[]` after reading from JSON storage. Category D (legitimate JSON boundary) — but would benefit from zod if/when we add runtime validation.
- `packages/core/src/tasks/gate-runner.ts:171,425,536` — `err as NodeJS.ErrnoException & {...}` — Category C (error shape), acceptable.
- `packages/core/src/tasks/hierarchy-policy.ts:55` — `hierarchy?.enforcementProfile as ProfileName | undefined` — Category A, **leakage**. This one mirrors the dispatch issue but at the business-logic layer. Worth fixing but not urgent.
- `packages/core/src/tasks/req.ts:183,234` — `as AcceptanceItem[]` after reading from a DB row — Category D.

**Verdict**: Core is ~80% clean. The 16 casts are mostly Category C/D legitimate or post-guard no-ops. ~2 genuine drift points (`hierarchy-policy.ts`). Not a priority for the T910 reconciliation.

### `packages/studio/src/routes/api/**/+server.ts`

Sample grep shows ~17 matches. Pattern is **direct SQL + cast** (studio reads raw sqlite rows):
- `packages/studio/src/routes/api/brain/decisions/+server.ts:57` — `.all() as BrainDecision[]`
- `packages/studio/src/routes/api/brain/graph/+server.ts:68-78` — `.all() as BrainNode[]`, `.all() as BrainEdge[]`
- `packages/studio/src/routes/api/brain/observations/+server.ts:85`
- `packages/studio/src/routes/api/living-brain/stream/+server.ts:144-370` — 6 row-array casts
- `packages/studio/src/routes/api/living-brain/substrate/[name]/+server.ts:26` — `params.name as LBSubstrate` — **leakage** (same pattern as dispatch)

**Verdict**: Studio has two distinct cast patterns:
1. **Raw-SQL row casts** (15 of 17) — Category D legitimate. Would benefit from drizzle ORM + zod schemas (matches existing `drizzle-orm/zod` skill guidance) but not the same urgency as dispatch.
2. **SvelteKit params cast** (`params.name as LBSubstrate`, `params.name as LBSubstrate`) — Category A leakage, 2 occurrences. Trivial fix.

**Overall cross-package assessment**: The drift is **concentrated in `packages/cleo/src/dispatch/domains/`** (579 / ~610 total param casts across all packages = **95%**). Core and studio have cosmetic variants but are not major drift surfaces. Fixing dispatch reconciles ~95% of the latent schema drift in one focused epic.

---

## Section 6 — Open questions for HITL

1. **Adopt zod?** The operator's "ZERO latent drift" mandate is best served by runtime validation (Option C). Do we ship **A now and C later** (recommended), or gate the whole fix on **A+C atomic** (pure but larger PR)?
2. **Atomic vs incremental?** Operator said ZERO drift. Does that mean:
   - (a) Ship domain-by-domain (incremental green, each wave ends in a clean main branch) — my recommendation.
   - (b) Gate the whole migration behind a single PR (14 domains + contracts) to flip the invariant in one step.
3. **Where do missing contracts live?** `sticky`, `docs`, `intelligence`, `ivtr`, `pipeline`, `check`, `admin` sub-areas don't yet have `*Params` interfaces in `packages/contracts/src/operations/`. Do we:
   - (a) Author them as part of the dispatch retype (extends T910 scope).
   - (b) Gate dispatch retype on a preceding contracts epic.
4. **Deprecation policy for `DomainHandler`?** If we add `TypedDomainHandler<O>`, do we:
   - (a) Remove the legacy `DomainHandler` interface once all 14 handlers migrate.
   - (b) Keep it forever as a back-compat shim (external plugins may implement it).
5. **Registry `validateRequiredParams` evolution**: the runtime validation at `registry.ts:5099` currently checks only for presence. Should it also validate *types* in the adapter layer fix, or leave that to a later zod pass?
6. **`as Parameters<typeof coreFn>[0]` anti-pattern (10 sites)**: these tie dispatch to internal core signatures. When we move to typed contracts, do we:
   - (a) Export new `Parameters` types from contracts (fast, mirrors current behavior).
   - (b) Refactor the core fn signatures to match contracts (correct but larger scope).
7. **`Record<string, unknown>` in `DispatchRequest.params`** (`types.ts:83`): once handlers are typed, should `DispatchRequest` itself become generic `DispatchRequest<P = Record<string, unknown>>`? Impacts middleware surface.
8. **Cross-repo canary**: external packages that depend on `@cleocode/contracts` will see new exports. Any breaking change risk for consumers embedding the canonical domain handlers?

---

## Appendix — raw grep dumps (evidence trail)

Full line-by-line dumps (too large to inline — attached as Claude Code tool artifacts):

1. `/home/keatonhoskins/.claude/projects/-mnt-projects-cleocode/d4e48534-f2c1-4c4d-ba9f-01f3c0d7d22f/tool-results/toolu_01FXVs8zd5SqY2tiYoQQqGuw.txt` — 256 lines, all ` as [A-Z][A-Za-z]+` matches in `packages/cleo/src/dispatch/`.
2. `/home/keatonhoskins/.claude/projects/-mnt-projects-cleocode/d4e48534-f2c1-4c4d-ba9f-01f3c0d7d22f/tool-results/toolu_01TSW5WTqP3iecrYvPwWExPk.txt` — 642 lines, all `params?.` matches in `packages/cleo/src/dispatch/domains/`.
3. `/home/keatonhoskins/.claude/projects/-mnt-projects-cleocode/d4e48534-f2c1-4c4d-ba9f-01f3c0d7d22f/tool-results/toolu_01WkgznD53dHiY49JwNHmLLW.txt` — all `Record<string, unknown>` matches.

Key anchor files for the fix:
- `/mnt/projects/cleocode/packages/cleo/src/dispatch/types.ts` (201 LOC — the signature to evolve)
- `/mnt/projects/cleocode/packages/cleo/src/dispatch/registry.ts` (5100+ LOC — 278 operation defs; the single source of truth for what ops exist)
- `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/tasks.ts` (reference handler — 79 param casts to eliminate)
- `/mnt/projects/cleocode/packages/contracts/src/operations/tasks.ts` (280 LOC — 22 typed Params interfaces, already complete)
- `/mnt/projects/cleocode/packages/contracts/src/operations/brain.ts` (954 LOC — 31 typed Params, shipped 2026-04-18)
- `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/diagnostics.ts` (gold standard; zero param casts, uses `typeof` guards)
