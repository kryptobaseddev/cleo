# PARTIAL EXTRACT MANIFEST — T9232 (8-Phase CLEO Optimization Campaign)

> **Status**: ready-for-agent-execution · 2026-05-15
> **Decision**: T9232 STAYS OPEN. Only T9245 reparents out. T9238 + T9239 cross-link to E-PRIME-SENTIENCE without reparenting.
> **Rationale**: 6 of 8 children done. Closing T9232 would lose the campaign's audit lineage. Reparent-only.

---

## 1. Epic-level context

- **Epic**: T9232 — "MASTER: 8-Phase CLEO Optimization Campaign 2026-05-12"
- **Status**: pending (epic-level)
- **Children**: 8 total · 6 done (T9233, T9234, T9235, T9236, T9237) · 2 pending epics (T9238, T9239) · 1 pending task (T9245)
- **Action**: PARTIAL EXTRACT — T9245 moves to E-PRIME-T01; T9238/T9239 cross-link; T9232 epic continues
- **Successor (for T9245 only)**: E-PRIME-T01

---

## 2. Per-child disposition

| Child | Status | Action | Rationale |
|---|---|---|---|
| T9233 | done (epic) | KEEP-DONE-HISTORICAL | Phase 2 Verifier Lockdown shipped |
| T9234 | done (epic) | KEEP-DONE-HISTORICAL | Phase 3 BBTT — was the meta-tracker for T1892's 15 children, which is now superseded by E-PRIME-T01/T02. T9234 itself stays done. |
| T9235 | done (epic) | KEEP-DONE-HISTORICAL | Phase 4 CSL-RESET + Core SDK Foundation shipped |
| T9236 | done (epic) | KEEP-DONE-HISTORICAL | Phase 5 Reliability Tail shipped |
| T9237 | done (epic) | KEEP-DONE-HISTORICAL | Phase 6 High-Leverage Features shipped |
| **T9238** | pending (epic) | **KEEP-OPEN + CROSS-LINK** to E-PRIME-SENTIENCE | Phase 7 CleoOS Sentient Harness v3 — depends on T1737 + T9245. T1737 is the parallel epic E-PRIME-SENTIENCE cross-links to. Add `relates: E-PRIME-SENTIENCE`. |
| **T9239** | pending (epic) | **KEEP-OPEN** | Phase 8 Studio UI/UX — depends on T990. Out of scope for E-PRIME-SENTIENCE (Studio is parallel UI work). |
| **T9245** | pending (task) | **REPARENT → E-PRIME-T01** + add `relates: T9232, T9238` | Load-bearing for E-PRIME-T01 trust-validator hardening. T9238 depends on T9245 so the relates-edge preserves Phase 7 unblock signal. |

---

## 3. Reparent ritual for T9245

```bash
# Step 1: Audit note BEFORE reparent (preserves audit lineage)
cleo update T9245 --note "Reparented from T9232 (8-Phase Optimization Campaign) to E-PRIME-T01 (Trust Foundation) on 2026-05-15. Original Phase 7 unblock dependency preserved via relates:T9238. See docs/plans/cleo-prime-decomposition/T9232-PARTIAL-EXTRACT-MANIFEST.md and docs/plans/cleo-prime-decomposition/CLEO-PRIME-SENTIENT-MASTERPLAN.md §16.A (file-path correction: actual site is packages/core/src/tasks/evidence.ts:427, not lifecycle/evidence.ts)."

# Step 2: Reparent to E-PRIME-T01 (assumes E-PRIME-T01 was created — capture its real ID)
cleo update T9245 --parent <E-PRIME-T01-ID>

# Step 3: Preserve cross-references
cleo update T9245 --relates add T9232    # campaign-of-origin
cleo update T9245 --relates add T9238    # downstream unblock

# Step 4: Update T9238 to cross-reference E-PRIME-SENTIENCE
cleo update T9238 --relates add E-PRIME-SENTIENCE
cleo update T9238 --note "2026-05-15: T9245 (this epic's P0 blocker) reparented to E-PRIME-T01. T9238 stays here under T9232. When T9245 ships under E-PRIME-T01, T9238 becomes unblocked. See docs/plans/cleo-prime-decomposition/T9232-PARTIAL-EXTRACT-MANIFEST.md."
```

---

## 4. No epic closure

**T9232 STAYS OPEN.** Do NOT run `cleo complete T9232`. The campaign has:
- 2 pending children (T9238 Phase 7, T9239 Phase 8) that are not part of E-PRIME-SENTIENCE
- 6 done children that remain historical record

The campaign continues with its remaining scope.

---

## 5. Validation gates AFTER reparent

```bash
# 1. T9245 has new parent
cleo show T9245 --json | jq '.data.task.parentId'
# expected: <E-PRIME-T01-ID>

# 2. T9245 has both cross-references
cleo show T9245 --json | jq '.data.task.relates'
# expected: contains both T9232 and T9238

# 3. T9232 has 7 children remaining (was 8, lost T9245)
cleo list --parent T9232 --json | jq '.data.tasks | length'
# expected: 7

# 4. T9238 cross-references E-PRIME-SENTIENCE
cleo show T9238 --json | jq '.data.task.relates'
# expected: contains E-PRIME-SENTIENCE

# 5. T9232 status unchanged (still pending — campaign continues)
cleo show T9232 --json | jq '.data.task.status'
# expected: "pending"
```

---

## 6. Success criteria

- [ ] T9245 reparented to E-PRIME-T01 with audit-note
- [ ] T9245 retains `relates: T9232, T9238` cross-references
- [ ] T9238 has `relates: E-PRIME-SENTIENCE` added
- [ ] T9232 remains open with 7 children (was 8)
- [ ] No `cleo complete` invoked on T9232 (intentional)
- [ ] T9232 Phase 7 (T9238) is now bidirectionally linked to E-PRIME-SENTIENCE's T9245 work

This is a SURGICAL extract, not a closure. T9232 owns Studio + harness work that's beyond E-PRIME-SENTIENCE scope.
