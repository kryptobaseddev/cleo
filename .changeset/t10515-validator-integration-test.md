---
id: t10515-validator-integration-test
tasks: [T10515]
kind: test
summary: "integration: end-to-end Validator pipeline + SKILL stability experimental→stable (T10383 closure)"
---

End-to-end integration test that wires every shipped piece of the Validator
subsystem together in one flow, closing T10383 (E-VALIDATOR-ROLE) and the
penultimate saga T10377 (SG-IVTR-AC-BINDING) acceptance criterion.

New test file:
`packages/core/src/lifecycle/validator/__tests__/integration.test.ts`

Exercises the runtime against REAL SDK tool implementations — the
`spawnValidator` DI callback invokes the real `validatorAttest` /
`validatorReject` functions, which read/write a real SQLite test DB
seeded via `createTestDb()` + `addTask()`. Per T10515 task description
note #5, the runtime's DI seam (designed by T10512) satisfies "real
spawn" without subprocess overhead.

Coverage paths (all 4 in T10515 AC #3 wired end-to-end):

1. **Attest happy path** — Worker submits → Validator ATTESTs →
   `evidence_ac_bindings` rows land → AC-coverage gate passes
2. **Reject happy path** — Worker submits → Validator REJECTs →
   no bindings written → AC-coverage gate still fails
3. **Retry-then-attest** — REJECT round 1, ATTEST round 2 →
   `respawnWorker` invoked exactly once → bindings written on round 2
4. **Retry-exhaust-then-escalate** — Max-N REJECTs → final attempt's
   audit row in `.cleo/audit/validator-retries.jsonl` carries
   `retryDecision='escalate-hitl'` (canonical escalation signal)

Plus a cross-cutting partial-attest + waiver test demonstrating that
`computeAcCoverage` + `applyWaivers` compose correctly when the
Validator only attests a subset of ACs.

SKILL bump:
`.cleo/skills/cleo-validator/SKILL.md` metadata.stability
`experimental` → `stable`, version `2.0.0` → `2.1.0`. Every piece of
the surface area (contracts, SDK tools, Max-N runtime, lead-rollup
flag) is now shipped AND integration-tested.

T10515 is the penultimate piece of saga T10377 — T10384 closeout
follows.
