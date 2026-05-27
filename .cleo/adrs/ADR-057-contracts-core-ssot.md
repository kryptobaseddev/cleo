# ADR-057: Contracts/Core SSoT layering — uniform `(projectRoot, params)` Core API and OpsFromCore-inferred dispatch

**Status**: ACCEPTED
**Date**: 2026-04-25
**Tasks**: T1449 (epic), T1450 (PROOF), T1451-T1458 (per-domain), T1459 (this ADR + lint), T1460 (release)
**Council**: 2026-04-25 verdict at `~/.claude/skills/council/.cleo/council-runs/20260425T143444Z-e72b81ef/verdict.md`
**Audit**: `.cleo/agent-outputs/T1449-CORE-API-AUDIT.md`
**Supersedes**: none
**Supplements**: ADR-039 (LAFS envelopes), ADR-056 (DB SSoT), ADR-039+ (typed dispatch migration T975)

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## Context

CLEO has a three-layer dispatch architecture:

```
packages/contracts/src/operations/<domain>.ts   ← wire contract types (Params/Result)
packages/core/src/<domain>/*.ts                  ← Core implementation (the SDK)
packages/cleo/src/dispatch/engines/<domain>-engine.ts   ← optional EngineResult wrapper
packages/cleo/src/dispatch/domains/<domain>.ts   ← dispatch handler (CLI/Studio entry)
```

Prior to T1449, the three layers used **partially-divergent field names** and **non-uniform Core function signatures** (positional, mixed, options-object — all coexisting). The dispatch layer translated between them. T1435 attempted to make dispatch a thin pass-through via `OpsFromCore<C>` type-helper inference but failed because Core's API was not uniform — `Parameters[0]` resolved to `string` (projectRoot) on positional fns, breaking inference.

### Catalyst — T1435 Option A friction analysis (2026-04-25)
T1435 cherry-picked an `OpsFromCore<C>` helper (T1436) and refactored 9 dispatch domains to use it. Domains with already-options-object Core fns succeeded; domains with positional Core fns (claim, unclaim, sync.reconcile, archive — `Parameters[0]: string`) failed. The branch was preserved at `feat/t1435-dispatch-ops-inference` (10 commits including T1436 helper) for partial recycling.

### Council convened (2026-04-25 14:34 UTC)
Five-advisor stress test of the proposed remediation. All advisors gated PASS on rigor/evidence/frame; Executor PASS on action with caveat. Convergence: Core API uniformity is load-bearing; CI enforcement gate must come AFTER audit (validates against stable surface). Two questions deferred to owner: aliases policy (registry vs canonical) and refactor sequencing (sequential vs partial-parallel).

### Orchestrator audit (2026-04-25 15:30 UTC)
Per orchestrator's full audit (`.cleo/agent-outputs/T1449-CORE-API-AUDIT.md`), sample shows **~19% options-object compatible / ~81% positional or mixed**. Council's >80% rule fires: **NORMALIZE FIRST**. Two open questions resolved by orchestrator under owner-granted autonomy:
- Q1 aliases: **OPTION B — canonical SSoT in Contracts** (data: 2 alias pairs, 7 dispatch normalization sites, blast radius LOW per gitnexus impact).
- Q2 sequencing: **NORMALIZE FIRST, PARALLEL across all 9 domains** (each domain Core refactor is independent; PROOF gates the parallelism).

GitNexus impact analysis confirms LOW blast radius for sample symbols (impactedCount ≤ 3 for `sessionStart`, `startSession`, `findAdrs`, `validateProtocol`, `TasksAddParams`).

---

## Decision

### D1 — Uniform Core API signature

Every Core function exported from `packages/core/src/<domain>/` that backs a dispatch operation MUST have signature:

```typescript
async function <name>(projectRoot: string, params: <Op>Params): Promise<<Op>Result>
```

Where `<Op>Params` and `<Op>Result` are imported from `@cleocode/contracts/operations/<domain>` (or, where domains lack a dedicated file, from the appropriate consolidated contract file — see D2).

Rationale: enables uniform `OpsFromCore<typeof coreOps>` inference at the dispatch layer; makes Core the single SDK consumable by external clients (Studio, future CLI alternatives, MCP adapters).

**Exceptions** (documented at the call site with `// SSoT-EXEMPT:<reason>` comment):
- Internal helper functions NOT exposed via dispatch.
- Functions that legitimately don't take projectRoot (e.g., pure type-system parsers like `parseScope`).
- Database-handle-first signatures within a single SDK package (e.g., `@cleocode/playbooks` state.ts internal accessors) — these expose options-object wrappers at the public surface.
- Zero-params ops (no `<Op>Params` arg needed, only `projectRoot`).
- Snapshot/file-path ops that use `cwd?` rather than `projectRoot` by convention.

### D2 — Contracts as canonical SSoT (no aliases in operation Params)

Operation contract types (`<Op>Params`, `<Op>Result`) MUST declare each logical field exactly ONCE. Alias spellings (e.g., `parent` and `parentId` for the same concept) are FORBIDDEN at the contract level.

CLI ergonomic aliases MUST live at the **CLI command layer** (`packages/cleo/src/cli/commands/<domain>.ts`):

```typescript
program
  .command('add')
  .option('-p, --parent <id>', 'parent task id')
  .option('--parent-id <id>', 'alias for --parent (deprecated; will be removed in v2027)')
  .action((opts) => {
    const params: TasksAddParams = {
      ...opts,
      parent: opts.parent ?? opts.parentId,  // CLI-level alias normalization
    };
    delete (params as { parentId?: unknown }).parentId;
    return dispatch.mutate('tasks.add', params);
  });
```

Dispatch handlers MUST NOT contain `params.X ?? params.Y` translations on contract fields. Wire/internal model translations (e.g., wire `parent` ↔ Drizzle `parentId`) are ALLOWED and remain at the boundary they currently occupy (Core internals).

**Backward-compat exception** (`// SSoT-EXEMPT: targetId is a backward-compat alias for relatedId accepted since T5149`): the `TasksRelatesAddParams.targetId` field is retained alongside `relatedId` for backward compatibility with T5149. Removal is tracked as a separate cleanup task.

### D3 — Dispatch as thin pass-through via OpsFromCore

Each `packages/cleo/src/dispatch/domains/<domain>.ts` MUST:

1. Import Core fns directly (or via the engine wrapper if one exists).
2. Build a `coreOps` record mapping op names to Core/engine fns.
3. Type ops via `type <Domain>Ops = OpsFromCore<typeof coreOps>` — inferred, NOT manually maintained.
4. Implement handler bodies as 1-3 lines: `async (params) => wrapResult(await coreOps.<op>(getProjectRoot(), params))`.

Translation logic, alias normalization, field-name massaging in handler bodies are PROHIBITED.

### D4 — Engine wrapper layer (optional, when present)

Domains that wrap Core in an `<domain>-engine.ts` (currently: session, nexus, pipeline, tasks) MAY keep the engine layer to provide `EngineResult<T>` envelope wrapping (success/error tuple). Engine fn signatures MUST mirror the new Core signature: `(projectRoot: string, params: <Op>Params): Promise<EngineResult<<Op>Result>>`.

The engine layer is a candidate for future collapse (engine → Core direct call with try/catch in dispatch). That collapse is **out of scope for T1449**; flag as follow-up when all engine fns become trivial.

### D5 — Lint enforcement (CI gate)

A repository lint script (`scripts/lint-contracts-core-ssot.mjs`) MUST run in pre-commit hook AND CI. It MUST reject:

- **L1**: Any Core fn called as a dispatch entry point (awaited within `defineTypedHandler<>` block) whose signature doesn't match `(projectRoot: string, params: <Op>Params): Promise<<Op>Result>` — flagged as `SSOT_VIOLATION_NON_UNIFORM_SIGNATURE`.
- **L2**: Any contract `<Op>Params` interface that declares the same logical field under two distinct keys — flagged as `SSOT_VIOLATION_ALIAS_IN_CONTRACT`.
- **L3**: Any dispatch handler body containing `params\.[a-zA-Z_][a-zA-Z0-9_]* \?\? params\.` for two contract field names — flagged as `SSOT_VIOLATION_DISPATCH_NORMALIZATION`.
- **L4**: Any Core fn imported by dispatch that is not also re-exported from `@cleocode/core` (must be SDK-public) — flagged as `SSOT_VIOLATION_NON_PUBLIC_CORE_FN`.

Exceptions: any line annotated with `// SSoT-EXEMPT:<reason>` is excluded from lint. Comment MUST appear within 3 lines of the offending construct.

**L1 scope**: Only Core fns that appear as `await <fnName>(` calls WITHIN the `defineTypedHandler<XOps>('domain', {...})` block are in scope. Internal helpers used BY those entry points are out of scope (prevents false-positives on utilities like `getLogger`, `paginate`, `getProjectRoot`, ADR helpers, etc.).

### D6 — Public SDK expansion DEFERRED

Per Council Expansionist's frame, normalized Core unlocks reusable type-safe ops framework for SDK consumers. Per Contrarian + Outsider's risk constraints, that expansion is OUT OF SCOPE for T1449. File as follow-on epic (T149X) AFTER T1460 ships and internal alignment is proven over ≥ 2 weeks of normal CLEO operation.

---

## Implementation

### T1450 PROOF (session domain)
- Commit on main: `af49ffb18`
- Pattern doc: `.cleo/agent-outputs/T1450-MIGRATION-PATTERN.md`
- Notes: Established the migration pattern for all subsequent domains.

### T1451-T1458 (8 parallel domains)

| Task | Domain | Commit on main | Notes |
|---|---|---|---|
| T1451 | admin | `c6db48f3e` | WIP-recovered; full refactor verified. Token-service/snapshot fns partially normalized; SSoT-EXEMPT annotations mark pending T1451 follow-up |
| T1452 | check | `36ad4fc54` | Clean |
| T1453 | conduit | `0f032cba5` | Vitest alias; minimal touch |
| T1454 | nexus | `ceb30ed47` | Uses `TypedDomainHandler<NexusOps>` from T1424; backward-compat positional overloads retained — follow-up tracked |
| T1455 | pipeline | `ad6b49a9d` | Clean |
| T1456 | playbook | `25b7b6628` | SSoT-EXEMPT for db-handle internals |
| T1457 | sentient | `edfa04977` | WIP-recovered, complete |
| T1458 | tasks | `651d4d199` (Part A) + `8bc7baa15` (Part B) | parentId/kind/type aliases removed; CLI-layer aliasing |

### Post-merge caller fixes

| Fix | Commit | Scope |
|---|---|---|
| Session callers | `a40abf979` | 5 internal callers updated for T1450 normalized signatures |
| Lifecycle callers | `5feda5140` | 2 internal callers updated for T1455 normalized signatures |

### T1459 — ADR + lint script (this task)
- ADR: `docs/adr/ADR-057-contracts-core-ssot.md`
- Lint script: `scripts/lint-contracts-core-ssot.mjs`
- Pre-commit hook: `.husky/pre-commit`
- CI workflow: `.github/workflows/ci.yml`
- Residual aliases resolved: `session.ts:246` (startTask/focus), `tasks.ts:473` (notes/note); `tasks.ts:648` (relatedId/targetId) exempted per T5149 backward compat

---

## Consequences

### Positive
- **Drift becomes structurally impossible**: changing a contract type breaks Core signature at compile time; lint rejects manual drift in dispatch.
- **SDK consumers (Studio, MCP adapter, future CLIs) get clean canonical types** instead of guessing which alias to use.
- **Dispatch LOC reduced ~50%** across 9 domains (each handler body becomes 1-3 lines).
- **CI enforcement** prevents future regressions without ongoing reviewer vigilance.

### Negative
- **One-time refactor cost**: ~250 Core function signatures, hundreds of internal callers updated. Mitigated by per-domain parallelization (8 domains in parallel after PROOF).
- **CLI flag handling moves** from Contracts/dispatch into CLI command layer. Slightly more code in CLI verb files; offset by removal from dispatch.
- **Studio frontend imports may need updating** if they used alias forms (gitnexus impact says 2 Studio files for `TasksAddParams`).

### Risks + mitigations
| Risk | Mitigation |
|---|---|
| Dispatch consolidation breaks adjacent domain tests | Each per-domain worker runs repo-wide `pnpm run test` before complete |
| `Cleo.sessions` facade signature change cascades to embedders | Workers update facade in same commit as Core (atomicity gate) |
| Engine wrapper layer becomes vestigial | Acknowledged; flag as follow-up, not in T1449 scope |
| Lint false-positives block legitimate work | `// SSoT-EXEMPT:<reason>` annotation provides escape hatch; L1 scoped to dispatch entry points only |
| Index goes stale during parallel work | `npx gitnexus analyze --embeddings` after T1459, before T1460 release |

---

## Alternatives considered

### A1 — Keep aliases in Contracts as registry-of-spellings (REJECTED)
Pros: zero migration cost. Cons: drift can re-enter contract any time; SDK consumers must know which spelling is canonical; lint rule must validate aliases-list parity (more complex than canonical SSoT enforcement).

### A2 — Partial dispatch consolidation on already-compatible subset (REJECTED)
Pros: ship some quick wins. Cons: creates two-class system (consolidated vs not); fails the SSoT invariant; T1459 lint rule cannot be enforced repo-wide; matches owner's "stop bandaid drifting" warning.

### A3 — Sequential per-domain Core normalization (REJECTED)
Pros: lower coordination overhead. Cons: 9× wall time vs parallel; per-domain refactors are independent (verified by gitnexus impact <3 per fn); no benefit to serializing.

### A4 — Defer T1449 entirely; do public SDK expansion first (REJECTED — Council Expansionist's frame)
Pros: market value of SDK. Cons: SDK on inconsistent surface ships drift to consumers; internal alignment is prerequisite; Council deferred SDK explicitly.

---

## Compliance

- [x] All 9 dispatch domains pass L1-L4 lint after T1459
- [x] `node scripts/lint-contracts-core-ssot.mjs --exit-on-fail` exits 0 on main
- [ ] No Core fn called by dispatch has `// SSoT-EXEMPT:` annotation without an active follow-up task ID (T1451 token-service/snapshot fns carry SSoT-EXEMPT pending normalization)
- [ ] All Studio frontend imports of contract types use canonical fields (no alias references) — verify separately
- [x] CI workflow has `lint-contracts-core-ssot` step that exits non-zero on violation
- [x] Pre-commit hook runs same script locally before push

---

## References

- T1449 epic + 11 children
- T1435 Option A failure analysis (canonical state in tasks.db; run `cleo briefing` to read it — markdown handoff files are NOT a source of truth, see T1593)
- T1436 OpsFromCore<C> helper (cherry-picked to T1450 from `feat/t1435-dispatch-ops-inference`)
- Council verdict 2026-04-25: `~/.claude/skills/council/.cleo/council-runs/20260425T143444Z-e72b81ef/verdict.md`
- Orchestrator audit: `.cleo/agent-outputs/T1449-CORE-API-AUDIT.md`
- ADR-039: LAFS envelope contract
- ADR-051: Evidence-based completion
- ADR-056: DB SSoT + naming convention
