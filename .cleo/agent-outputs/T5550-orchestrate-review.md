# T5550 — orchestrate Domain Review

**Task**: T5550
**Epic**: T5517
**Date**: 2026-03-08
**Status**: complete

---

## Summary

Current: 19 ops (12 query + 7 mutate) | Target: ≤16 | Projected: 15 ops (cuts: -4, net -4 after discarding 2 phantom ops)

The orchestrate domain has two distinct concerns layered together: agent coordination primitives (KEEP — these are the core workflow) and Tessera/WarpChain template management (BORDERLINE — only one template exists, operations are thin wrappers). Rationalization to 15 ops achieves the target by merging `tessera.show` into `tessera.list` (parameterized), removing phantom handler ops, and reclassifying `bootstrap` as tier 1.

---

## Canonical Operation Inventory

All 19 registry entries mapped from `src/dispatch/registry.ts`:

### Query (9 ops)

| Operation | Tier | Description |
|-----------|------|-------------|
| `status` | 0 | Orchestration status for an epic (optional epicId) |
| `next` | 0 | Next spawnable task for an epic |
| `ready` | 0 | Which tasks are ready to spawn |
| `analyze` | 0 | Dependency analysis for an epic |
| `context` | 0 | Orchestration context (optional epicId) |
| `waves` | 0 | Wave computation for an epic |
| `bootstrap` | 0 | Brain-state bootstrap (session startup context) |
| `unblock.opportunities` | 0 | Find tasks that could be unblocked |
| `critical.path` | 0 | Critical path across all tasks |
| `tessera.show` | 0 | Show a Tessera template by ID |
| `tessera.list` | 0 | List all Tessera templates |
| `chain.plan` | — | **PHANTOM** — handler case exists, NOT in registry |

### Mutate (7 ops)

| Operation | Tier | Description |
|-----------|------|-------------|
| `start` | 0 | Start orchestration for an epic |
| `spawn` | 0 | Prepare spawn context for a task |
| `handoff` | 1 | Composite: context.inject + session.end + spawn |
| `spawn.execute` | 0 | Execute spawn via adapter registry |
| `validate` | 0 | Validate spawn readiness for a task |
| `parallel.start` | 0 | Mark wave start for parallel execution |
| `parallel.end` | 0 | Mark wave end for parallel execution |
| `verify` | — | **PHANTOM** — handler case exists, NOT in registry |
| `tessera.instantiate` | 0 | Instantiate a Tessera template into a chain instance |

**Note on phantom ops**: `verify` (mutate) and `chain.plan` (query) are implemented in `OrchestrateHandler` and listed in `getSupportedOperations()` but have NO registry entry. They are unreachable via MCP gateway. These must be either registered or removed — they do not count toward the 19 but represent dead code.

---

## Decision Matrix

| Operation | Gateway | Decision | Reason |
|-----------|---------|----------|--------|
| `status` | query | KEEP | Core agent checkpoint — what is the orchestration state of my epic? |
| `next` | query | KEEP | Core agent loop primitive — what task do I spawn next? |
| `ready` | query | KEEP | Distinct from `next` — returns the full ready set, not just one task |
| `analyze` | query | KEEP | Pre-spawn dependency analysis; prevents illegal spawns |
| `context` | query | KEEP | Returns orchestration context needed for handoff injection |
| `waves` | query | KEEP | Wave metadata needed to correctly sequence parallel spawns |
| `bootstrap` | query | KEEP (tier 1) | Brain-state context for session startup; not needed in tight loops. Reclassify to tier 1. |
| `unblock.opportunities` | query | KEEP (tier 1) | Diagnostic — useful but not on critical agent path. Reclassify to tier 1. |
| `critical.path` | query | MERGE into `analyze` | `critical.path` returns a subset of what `analyze` can surface. Add `mode: 'critical-path'` param to `analyze` rather than separate op. Cut 1. |
| `tessera.show` | query | MERGE into `tessera.list` | Only 1 template exists (`tessera-rcasd`). Parameterize `tessera.list` with optional `id` — if provided, return single template. Cut 1. |
| `tessera.list` | query | KEEP (parameterized) | Becomes the single tessera read op (absorbs `tessera.show`). |
| `chain.plan` | query | REMOVE (phantom) | Not registered; dead handler code. If WarpChain planning is needed in future, add via a dedicated `pipeline.chain.plan` op. |
| `start` | mutate | KEEP | Required entry point to initialize orchestration state for an epic. |
| `spawn` | mutate | KEEP | Core spawn-prep primitive; produces the protocol context an agent needs. |
| `handoff` | mutate | KEEP | Composite operation is justified — 3-step atomic sequence (inject, end, spawn) that agents should not orchestrate manually. |
| `spawn.execute` | mutate | KEEP | Distinct from `spawn` — executes via adapter registry vs. just preparing context. Needed for autonomous execution paths. |
| `validate` | mutate | KEEP | Pre-spawn validation gate; anti-hallucination for spawn readiness. |
| `parallel.start` | mutate | MERGE with `parallel.end` | Parameterize: single `parallel` op with required `action: 'start' | 'end'` param. Cut 1. |
| `parallel.end` | mutate | MERGE into `parallel` | See above. |
| `tessera.instantiate` | mutate | KEEP | Only mutate op for tessera; creates chain instances from templates. |
| `verify` | mutate | REMOVE (phantom) | Not registered; dead handler code. System-integrity check belongs in `check` domain or `admin` domain, not orchestrate. |

---

## Tessera Analysis

**What tessera ops are**: Tessera is a parameterized WarpChain template system. A `TesseraTemplate` wraps a `WarpChain` with variable substitution (`{{epicId}}`, `{{projectName}}`, `{{skipResearch}}`). At runtime, `tessera.instantiate` resolves variables, validates the chain, and creates a `WarpChainInstance`.

**Current state**: Only one template exists (`tessera-rcasd` — the default RCASD lifecycle chain). The template registry is in-memory and seeded at startup.

**Recommendation**: Merge `tessera.show` into `tessera.list`. Add optional `id` parameter to `tessera.list`; if provided, return single template details. This is a standard list-or-show pattern that reduces surface without losing capability. Net: -1 op.

**Should tessera move to plugin?** No. Tessera is the primary mechanism for instantiating lifecycle chains on epics. It is called by orchestrating agents before `start`. Keeping it in the orchestrate domain is correct — it is part of the orchestration bootstrap flow. However, if the template registry grows beyond 3-4 templates, consider moving tessera ops to the `pipeline` domain (where chains live).

---

## Handoff Analysis

`orchestrate.handoff` is a tier-1 composite operation that sequences:
1. `session.context.inject` — inject protocol into current session context
2. `session.end` — end the active session with handoff note
3. `orchestrate.spawn` — prepare spawn context for successor task

This is core and must be KEPT. The composite design is justified because:
- The 3-step sequence must be atomic from the orchestrating agent's perspective
- Partial handoffs (inject without end, or end without spawn) are error states
- The operation provides idempotency key support and per-step status in failure responses

The `spawn.execute` operation is separate and complementary — it runs after `handoff` in autonomous flows where the spawning adapter is registered. These two together form the complete handoff-and-spawn workflow.

---

## Agent Coordination Essentials

What every orchestrating agent genuinely needs (the 12-op core):

**Decision loop** (query):
- `status` — am I ready to orchestrate this epic?
- `analyze` — what are the dependencies? (absorbs critical.path with `mode` param)
- `ready` — which tasks can I spawn right now?
- `next` — which one should I spawn next?
- `waves` — what wave am I in?
- `context` — what context do I inject into the handoff?

**Execution** (mutate):
- `start` — initialize orchestration
- `validate` — check this task is spawn-safe
- `spawn` — prepare spawn context
- `handoff` — composite hand-off to next agent (end session + spawn)
- `spawn.execute` — execute via adapter (autonomous flows)

**Lifecycle templates** (read+write):
- `tessera.list` (with optional id — absorbs show)
- `tessera.instantiate`
- `parallel` (with action param — absorbs start+end)

Total: **15 ops** — 9 query + 6 mutate.

---

## Projected Cuts Summary

| Cut | From | To | Saves |
|-----|------|----|-------|
| Merge `tessera.show` into `tessera.list` | 2 ops | 1 op | -1 |
| Merge `critical.path` into `analyze` | 2 ops | 1 op | -1 |
| Merge `parallel.start` + `parallel.end` | 2 ops | 1 op | -1 |
| Reclassify `bootstrap` to tier 1 | stays | stays | 0 (visibility) |
| Reclassify `unblock.opportunities` to tier 1 | stays | stays | 0 (visibility) |
| Remove phantom `verify` from handler | 0 (dead) | removed | 0 (cleanup) |
| Remove phantom `chain.plan` from handler | 0 (dead) | removed | 0 (cleanup) |

**Net registry reduction**: 19 → **16 ops** (meets ≤16 target).
**With tier reclassification**: Tier-0 count drops from 19 to 14 (tier-1 agents see only 14 ops by default).

---

## Implementation Notes

1. `critical.path` merge: add `mode?: 'dependencies' | 'critical-path' | 'full'` param to `orchestrate.analyze`. Default `'dependencies'` preserves current behavior. `'critical-path'` runs `getCriticalPath()`. Remove registry entry for `critical.path`.

2. `tessera.show` merge: change `tessera.list` registry entry to note optional `id` param. In handler, if `id` provided, call `showTessera(id)` and return single result. Remove `tessera.show` registry entry.

3. `parallel.start`/`parallel.end` merge: new operation `parallel` with required param `action: 'start' | 'end'`. Both `epicId` and `wave` remain required. Remove both existing entries, add one new entry.

4. Phantom ops cleanup: remove `verify` case from handler mutate switch and `chain.plan` case from handler query switch. Remove from `getSupportedOperations()` return value.

5. Tier reclassification: update `bootstrap` and `unblock.opportunities` registry entries from `tier: 0` to `tier: 1`.

## References

- Task: T5550
- Epic: T5517
- Subtasks: T5551 (inventory), T5552 (challenge), T5553 (decisions)
- Source: `src/dispatch/domains/orchestrate.ts`
- Source: `src/dispatch/registry.ts` (lines 361-441, 1483-1565, 2867-2897)
- Source: `src/core/lifecycle/tessera-engine.ts`
- Source: `src/dispatch/engines/orchestrate-engine.ts`
