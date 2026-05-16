# CLOSEOUT MANIFEST — T942 + T1007 (Sentient Tier-3 + Sentient Loop)

> **Status**: ready-for-agent-execution · 2026-05-15
> **Agent role**: reparent 11 pending children, close 2 superseded epics with attestation
> **ZERO ASSUMPTIONS**: every child's depends-on edges must be reverified after reparent (some chain across T942↔T1007)

---

## 1. Epic-level context

| Epic | Title | Status | Children | Action |
|---|---|---|---|---|
| T942 | Sentient CLEO Architecture Redesign | pending | 8 pending | close-as-superseded → T-SANDBOX |
| T1007 | Sentient Loop Completion — Tier 2 Proposals + Tier 3 Sandbox Auto-Merge | pending | 3 pending | close-as-superseded → split E-PRIME-T09 / T-SANDBOX |

Both epics overlap heavily with E-PRIME-SENTIENCE Tier 9 (Sentient Tier-2 + CANT Evolution) and the deferred T-SANDBOX bucket.

---

## 2. T942 children — all 8 → T-SANDBOX

| Child | Title slice | Reparent → |
|---|---|---|
| T946 | Autonomous self-improving loop Tier1/2/3 + Ed25519 + sandbox | **T-SANDBOX** |
| T1010 | Tier 3 externally-anchored baseline + signed llmtxt/events audit | **T-SANDBOX** |
| T1011 | Tier 3 FF-only merge with abort-on-fail + per-step kill-switch | **T-SANDBOX** |
| T1012 | `cleo revert --from <receiptId>` audit chain walker | **T-SANDBOX** |
| T1029 | abort-to-clean-state protocol (`abortExperiment` orchestrator) | **T-SANDBOX** |
| T1030 | full merge ritual orchestrator (10-step flow) | **T-SANDBOX** |
| T1032 | merge ritual integration test (kill-switch injected at step 6) | **T-SANDBOX** |
| T1074 | Complete Tier 3 sentient state-pause subsystem (revert lifecycle) | **T-SANDBOX** |

**Validation BEFORE reparent**:
```bash
# Verify no T942 child has dependents OUTSIDE T942 that would break on reparent
for child in T946 T1010 T1011 T1012 T1029 T1030 T1032 T1074; do
  cleo find "depends:$child" 2>&1 | tail -1 | jq '.data.results[] | select(.id != null) | "\(.id): \(.title[:60])"'
done
```

If any external dependent exists, document it before reparent so the dependency edge survives.

**Reparent ritual per child** (run after T-SANDBOX epic exists):
```bash
cleo update T946 --note "Reparented from T942 to T-SANDBOX on 2026-05-15. Tier-3 sandbox infrastructure scope retained verbatim. Deferred follow-up per E-PRIME-SENTIENCE masterplan §10.1."
cleo update T946 --parent <T-SANDBOX-ID>
# Repeat for T1010, T1011, T1012, T1029, T1030, T1032, T1074
```

**No re-verify required** — all 8 children are pending (not done), so no evidence-trust audit needed. The reparent moves them under the new home; their AC and files stay unchanged.

---

## 3. T1007 children — split E-PRIME-T09 + T-SANDBOX

| Child | Title slice | Reparent → | Rationale |
|---|---|---|---|
| **T1644** | Tier 2 proposal generation: BRAIN-pattern-driven proposals + owner approval gate | **E-PRIME-T09** | Direct match for T09.P1.S1 (T1644 detector wiring per masterplan §5 Tier 9.1) |
| T1645 | Tier 3 sandbox auto-merge with Ed25519 receipt chain + metricsImproved gate | **T-SANDBOX** | Tier-3 scope, deferred |
| **T1646** | Integration tests for full Tier 1/2/3 sentient daemon lifecycle | **E-PRIME-T09** | Direct match for T09.P2.S* (T1646 integration tests per masterplan §5 Tier 9.2) |

**Reparent ritual**:
```bash
# E-PRIME-T09 absorptions (after E-PRIME-T09 exists)
cleo update T1644 --note "Reparented from T1007 to E-PRIME-T09 on 2026-05-15. AC retained: detector emits proposals from BRAIN patterns with owner approval gate. New Honcho 2-evidence rule + 4-AND dream-gate constraints added via E-PRIME-T09 subtasks (see docs/plans/cleo-prime-decomposition/E-PRIME-T07-T08b-T09-integration.md)."
cleo update T1644 --parent <E-PRIME-T09-ID>

cleo update T1646 --note "Reparented from T1007 to E-PRIME-T09 on 2026-05-15. Daemon-lifecycle test scope retained. Now part of E-PRIME-T09 integration test phase."
cleo update T1646 --parent <E-PRIME-T09-ID>

# T-SANDBOX absorption
cleo update T1645 --note "Reparented from T1007 to T-SANDBOX on 2026-05-15. Tier-3 sandbox auto-merge scope retained verbatim. Deferred follow-up."
cleo update T1645 --parent <T-SANDBOX-ID>
```

---

## 4. Epic closure ritual

### 4.1 Close T942

```bash
cleo update T942 --note "Closed-as-superseded 2026-05-15 by T-SANDBOX. All 8 children (T946, T1010, T1011, T1012, T1029, T1030, T1032, T1074) reparented under T-SANDBOX as Tier-3 sandbox infrastructure work — deferred follow-up per E-PRIME-SENTIENCE masterplan §10.1. See docs/plans/cleo-prime-decomposition/RECONCILIATION-PLAN.md §1.3."

cleo verify T942 --gate implemented \
  --evidence "decision:T-SANDBOX;files:docs/plans/cleo-prime-decomposition/RECONCILIATION-PLAN.md,docs/plans/cleo-prime-decomposition/CLOSEOUT-T942-T1007-MANIFEST.md;note:8 children reparented to T-SANDBOX, scope preserved"

cleo verify T942 --gate testsPassed \
  --evidence "note:design-only epic supersession; child-level tests stay under reparented children"

cleo verify T942 --gate qaPassed \
  --evidence "note:design-only epic supersession; no source changes"

cleo verify T942 --gate documented \
  --evidence "files:docs/plans/cleo-prime-decomposition/CLOSEOUT-T942-T1007-MANIFEST.md"

cleo verify T942 --gate securityPassed \
  --evidence "note:no source changes; security envelope of T-SANDBOX inherits all T942 children's signed-receipt + Ed25519 requirements"

cleo verify T942 --gate cleanupDone \
  --evidence "note:all 8 children reparented; T942 leaf-free"

cleo complete T942
```

### 4.2 Close T1007

```bash
cleo update T1007 --note "Closed-as-superseded 2026-05-15. T1644 + T1646 reparented to E-PRIME-T09 (Sentient Tier-2 + CANT Evolution). T1645 reparented to T-SANDBOX (Tier-3 sandbox deferred). See docs/plans/cleo-prime-decomposition/RECONCILIATION-PLAN.md §1.4."

cleo verify T1007 --gate implemented \
  --evidence "decision:E-PRIME-T09;files:docs/plans/cleo-prime-decomposition/RECONCILIATION-PLAN.md,docs/plans/cleo-prime-decomposition/CLOSEOUT-T942-T1007-MANIFEST.md;note:3 children split between E-PRIME-T09 (T1644,T1646) and T-SANDBOX (T1645)"

cleo verify T1007 --gate testsPassed \
  --evidence "note:design-only epic supersession; T1646 integration tests carry forward under E-PRIME-T09"

cleo verify T1007 --gate qaPassed \
  --evidence "note:design-only epic supersession; no source changes"

cleo verify T1007 --gate documented \
  --evidence "files:docs/plans/cleo-prime-decomposition/CLOSEOUT-T942-T1007-MANIFEST.md"

cleo verify T1007 --gate securityPassed \
  --evidence "note:no source changes"

cleo verify T1007 --gate cleanupDone \
  --evidence "note:all 3 children reparented; T1007 leaf-free"

cleo complete T1007
```

---

## 5. Validation gates BEFORE closure

Agent must confirm ALL of the following before running `cleo complete T942` and `cleo complete T1007`:

```bash
# 1. T942 has zero pending children
cleo list --parent T942 --json | jq '.data.tasks | map(select(.status == "pending")) | length'
# expected: 0

# 2. T1007 has zero pending children
cleo list --parent T1007 --json | jq '.data.tasks | map(select(.status == "pending")) | length'
# expected: 0

# 3. T-SANDBOX has the 9 reparented children
cleo list --parent <T-SANDBOX-ID> --json | jq '.data.tasks | length'
# expected: 9 (T946, T1010, T1011, T1012, T1029, T1030, T1032, T1074, T1645)

# 4. E-PRIME-T09 has T1644 + T1646 as direct children
cleo list --parent <E-PRIME-T09-ID> --json | jq '.data.tasks[] | select(.id == "T1644" or .id == "T1646") | .id'
# expected: T1644, T1646

# 5. No orphan dependencies on T942/T1007 from other live tasks
cleo find "depends:T942" 2>&1 | tail -1 | jq '.data.results | length'
cleo find "depends:T1007" 2>&1 | tail -1 | jq '.data.results | length'
# If non-zero: investigate before closing. Likely external tasks depended on these.
```

---

## 6. Success criteria

- [ ] All 8 T942 children reparented to T-SANDBOX with audit-note
- [ ] T1644 + T1646 reparented to E-PRIME-T09
- [ ] T1645 reparented to T-SANDBOX
- [ ] T942 closed with 6-gate evidence chain (no `--override`)
- [ ] T1007 closed with 6-gate evidence chain (no `--override`)
- [ ] `cleo list --parent T942` returns 0 pending children
- [ ] `cleo list --parent T1007` returns 0 pending children
- [ ] T-SANDBOX has 9 reparented children
- [ ] E-PRIME-T09 has T1644 + T1646 as children

Once met, the Tier-3 sandbox work consolidates under T-SANDBOX (deferred) and the Tier-2 detector + integration tests consolidate under E-PRIME-T09.
