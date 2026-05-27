---
id: t9842-ivtr-lead-blast-radius
tasks: [T9842]
kind: fix
summary: "IVTR Lead Validate-phase prompt auto-injects full per-package test guidance on infrastructure touches (T9814 precedent)"
---

Fixes a Lead-spawn protocol gap surfaced by T9814 R2 (2026-05-20). The Validate-phase
prompt produced by `resolvePhasePrompt()` previously only listed the targeted tests
named in the task spec. When a SAVEPOINT refactor in `DataAccessor.transaction()`
shipped with 6/6 + 34/34 + 9/9 targeted tests green, the IVTR Lead approved on that
scope and CI surfaced a regression in `agent-resolver.test.ts preferTier` seconds
later. The hotfix commit `baa996d2b` restored the outer-transaction case.

**Change**: when the Implement-phase evidence bundle has `filesChanged` entries that
match canonical infrastructure paths (`packages/core/src/store/`,
`packages/core/src/orchestration/`, `packages/core/src/dispatch/`,
`packages/cleo/src/dispatch/`, `packages/contracts/src/`, `packages/worktree/src/`,
`packages/core/src/migration/`, or any path whose basename contains `transaction`,
`pragma`, or `migration`), the Validate-phase Lead prompt is auto-enriched with:

1. A `### Blast-Radius Test Scope — MANDATORY (T9842)` section listing every touched
   file plus the exact `pnpm --filter @cleocode/<pkg> run test` command per affected
   package.
2. A new REJECT criterion `Infra-test-scope violation (T9842)` that loops the task
   back with reason `infra-test-scope-violation` when targeted-only test evidence is
   attached on an infrastructure touch.

Implementation:
- New SSoT module `packages/core/src/lifecycle/infra-touch.ts` —
  `INFRASTRUCTURE_PATH_PATTERNS`, `INFRASTRUCTURE_BASENAME_SUBSTRINGS`,
  pure `detectInfrastructureTouch()` and `buildBlastRadiusTestScopeSection()`.
- `buildValidatePhaseInstruction()` in `packages/core/src/lifecycle/ivtr-loop.ts`
  composes the new section into the Validate-phase Lead prompt.
- `ct-validator/SKILL.md` documents the rule under a new "Blast-Radius Test Scope"
  section, citing the T9814 precedent.
- 21 new infra-touch unit tests + 3 new ivtr-loop integration tests that exercise
  the synthetic infrastructure-touch + targeted-only-Lead-review path (AC3).
