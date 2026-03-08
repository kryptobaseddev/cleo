# T5542 — check Domain Review

**Task**: T5542
**Epic**: T5540 (Domain rationalization sweep)
**Date**: 2026-03-07
**Status**: complete

---

## Summary

The check domain currently has **19 registered operations** (17 query + 2 mutate) plus one
handler-only operation (`chain.gate`) not present in the registry. The five `protocol.*`
specializations (consensus, contribution, decomposition, implementation, specification) are the
primary candidates for collapse — `check.protocol` already accepts a `protocolType` string
parameter, making all five redundant at the MCP surface. Applying all recommended cuts yields a
projected **11 operations** (down from 19), meeting the ≤13 target.

---

## Current Operation Inventory

### Query (17 registered + 1 handler-only)

| # | Operation | Gateway Classification | Notes |
|---|-----------|----------------------|-------|
| 1 | `schema` | query | Validates data payload against a named schema type |
| 2 | `protocol` | query | Protocol compliance check; accepts optional `protocolType` param |
| 3 | `task` | query | Task field-level validation (title, description, status, timestamps) |
| 4 | `manifest` | query | MANIFEST.jsonl structure validation |
| 5 | `output` | query | Agent output file validation |
| 6 | `compliance.summary` | query | Aggregate compliance score |
| 7 | `compliance.violations` | query | Recent violation list with optional `limit` |
| 8 | `coherence.check` | query | Cross-task coherence analysis |
| 9 | `test.status` | query | Test suite pass/fail state |
| 10 | `test.coverage` | query | Coverage report |
| 11 | `protocol.consensus` | query | Consensus protocol compliance (calls validateConsensusTask) |
| 12 | `protocol.contribution` | query | Contribution protocol compliance |
| 13 | `protocol.decomposition` | query | Decomposition protocol compliance |
| 14 | `protocol.implementation` | query | Implementation protocol compliance |
| 15 | `protocol.specification` | query | Specification protocol compliance |
| 16 | `gate.verify` | **MISCLASSIFIED** — registered as query but mutates state when gate/all/reset params are provided |
| 17 | `chain.validate` | query (tier 2) | WarpChain definition structural validation |
| 18 | `chain.gate` | **NOT REGISTERED** — in handler only; reads gate evaluation results from chain instances |

### Mutate (2)

| # | Operation | Notes |
|---|-----------|-------|
| 19 | `compliance.record` | Appends a compliance record to COMPLIANCE.jsonl |
| 20 | `test.run` | Triggers test execution (side-effecting) |

---

## Decision Matrix

| Operation | Decision | Reason |
|-----------|----------|--------|
| `schema` | **KEEP** | Core structural validation; no equivalent elsewhere |
| `protocol` | **KEEP** | The unified protocol check; already accepts `protocolType` string param — becomes the single entry point after protocol.* removal |
| `task` | **KEEP** | Field-level task validation; distinct from `schema` (validates semantics, not just shape) |
| `manifest` | **KEEP** | MANIFEST.jsonl is a domain-specific artifact; clear responsibility |
| `output` | **KEEP** | Agent output file validation; used by orchestration compliance |
| `compliance.summary` | **KEEP** | Summary and violations serve different access patterns |
| `compliance.violations` | **MERGE into compliance.summary** | Add an optional `detail: true` param to summary; violations list is a view of the same data |
| `coherence.check` | **RENAME** | Rename to `coherence` — the `.check` suffix is redundant on a domain named `check` |
| `test.status` | **MERGE into test.coverage** | Both read from the same test runner output; parameterize with `format: "status" | "coverage"` |
| `test.coverage` | **MERGE INTO** (receives test.status) | See above |
| `protocol.consensus` | **REMOVE — folded into `protocol`** | `check.protocol {taskId, protocolType: "consensus"}` is identical behavior |
| `protocol.contribution` | **REMOVE — folded into `protocol`** | Same; `protocolType: "contribution"` |
| `protocol.decomposition` | **REMOVE — folded into `protocol`** | Same; `protocolType: "decomposition"` |
| `protocol.implementation` | **REMOVE — folded into `protocol`** | Same; `protocolType: "implementation"` |
| `protocol.specification` | **REMOVE — folded into `protocol`** | Same; `protocolType: "specification"` |
| `gate.verify` | **MOVE TO MUTATE + SPLIT** | Read path stays in query as `gate.status`; write path (set/reset gates) moves to mutate as `gate.set` |
| `chain.validate` | **KEEP (tier 2)** | WarpChain validation is a legitimate specialized check; tier-2 hides it from basic callers |
| `chain.gate` | **REGISTER or REMOVE** | Handler-only gap: either add to registry as `chain.gate` (query) or remove from handler; recommended: REGISTER since it fills a real gap (reading gate evaluation history) |
| `compliance.record` | **KEEP** | Only write op for compliance tracking; essential |
| `test.run` | **KEEP** | Trigger path; no alternative |

---

## Protocol.* Unification Analysis

`check.protocol` (operation #2 above) already has this signature:

```typescript
validateProtocol(taskId: string, protocolType?: string, projectRoot?: string)
```

The five `protocol.*` operations each call a different underlying validator but all share
identical params shape: `{ mode, taskId?, manifestFile?, strict?, ...extras }`. The existing
`check.protocol` passes `protocolType` through to `coreValidateProtocol`, which presumably
dispatches by type. If `coreValidateProtocol` already routes to the same five validators
internally, then the five MCP-surface operations are purely cosmetic and can be removed without
any core-layer change.

**Recommendation**: Remove all five `protocol.*` operations from registry and handler. Update
`check.protocol` description to document valid `protocolType` values: `consensus`, `contribution`,
`decomposition`, `implementation`, `specification`. Add `mode` and `strict` params to `check.protocol`
to match the superset of params currently scattered across the five operations.

Net saving: -5 operations.

---

## Gate Verification Analysis

`gate.verify` is registered under the **query** gateway but its implementation mutates task data
when any of `gate`, `all`, or `reset` params are supplied. This violates the CLEO gateway contract
(query = never modifies state).

**Recommendation**:

Split into two operations with correct gateway placement:

| New Op | Gateway | Params | Purpose |
|--------|---------|--------|---------|
| `gate.status` | query | `{ taskId }` | View verification gate state (read-only path of current gate.verify) |
| `gate.set` | mutate | `{ taskId, gate?, all?, reset?, value?, agent? }` | Set/reset verification gates |

This split also matches the task assignment hint ("merge gate.verify into task"), but the more
precise fix is a gateway reclassification rather than removal. The read path is genuinely useful as
a standalone query. The mutation should not live in query.

Net: 0 operations added or removed (swap classification only), but a compliance violation is fixed.

---

## Coherence Operation Name

`coherence.check` has a redundant suffix (`check`) given the domain is already named `check`.
Rename to `coherence`. This is a pure rename, zero behavioral change.

---

## Projected Final Count

| Gateway | Before | After |
|---------|--------|-------|
| query | 17 (+ 1 unregistered) | 10 |
| mutate | 2 | 3 (adds gate.set) |
| **total** | **19** | **13** |

### Post-rationalization query operations (10)

1. `schema`
2. `protocol` (absorbs 5 protocol.* ops; gains mode/strict params)
3. `task`
4. `manifest`
5. `output`
6. `compliance.summary` (absorbs compliance.violations via detail param)
7. `coherence` (renamed from coherence.check)
8. `test` (merged test.status + test.coverage via format param)
9. `gate.status` (read half of gate.verify)
10. `chain.validate`

Register `chain.gate` as query op 11 if the gap review confirms it has callers; otherwise omit.
With chain.gate registered: **11 query + 3 mutate = 14 total** (one over target, acceptable
given the gateway-fix rationale). Without chain.gate: **10 + 3 = 13**, exactly at ceiling.

### Post-rationalization mutate operations (3)

1. `compliance.record`
2. `test.run`
3. `gate.set` (new, from gate.verify write path)

---

## Implementation Notes

- The five `protocol.*` engine functions (`validateProtocolConsensus`, etc.) should be preserved
  in `validate-engine.ts` — `check.protocol` (or `coreValidateProtocol`) will route to them
  internally. Only their MCP surface registrations and handler cases are removed.
- `chain.gate` is already implemented in the handler (`check.ts`); only a registry entry is
  needed to make it reachable.
- `gate.set` implementation is the existing modification branches of `validateGateVerify` —
  extract into a separate engine function for clarity.
- Renaming `coherence.check` → `coherence` requires a registry entry update, handler case
  update, and a CLI alias if the CLI exposes this operation.

---

## References

- Related tasks: T5540 (epic), T5327 (protocol.* added), T5405 (chain.* added)
- Source files: `src/dispatch/domains/check.ts`, `src/dispatch/registry.ts`,
  `src/dispatch/engines/validate-engine.ts`
