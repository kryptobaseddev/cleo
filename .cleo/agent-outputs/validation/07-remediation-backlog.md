# 07 Remediation Backlog (from reports 02-05)

Date: 2026-03-05
Source reports:
- `.cleo/agent-outputs/validation/02-workstream-a-hooks.md` (all verified; no remediation items)
- `.cleo/agent-outputs/validation/03-workstream-b-brain.md`
- `.cleo/agent-outputs/validation/04-workstream-cd-warp-tessera.md`
- `.cleo/agent-outputs/validation/05-hygiene-audit.md`

Hard cap: 185k characters
Handoff trigger: 150k characters
Current payload: well below handoff threshold

## Global acceptance policy (applies to every item)

Every remediation item below must pass these explicit checks before closure:

1) Zero TODO comments in tracked source
- Required check command:
  - `git grep -nE "(^|[[:space:]])(//|#|/\*|\*)[[:space:]]*TODO\b" -- . ':(exclude)docs/**' ':(exclude).cleo/agent-outputs/**' ':(exclude)CHANGELOG.md'`
- Gate:
  - No matches in tracked source paths that are in policy scope.

2) No functionality removal
- Required check commands:
  - `npm test`
  - `npx tsc --noEmit`
  - Operation contract probes where relevant (examples in item test commands).
- Gate:
  - Existing passing behavior remains passing; operation counts/registrations are equal or expanded only; no previously supported operation is silently removed.

3) Underscore-prefixed imports are justified or wired
- Required check command:
  - `git grep -nE "import .* as _[A-Za-z0-9_]+" -- 'src/**/*.ts' 'tests/**/*.ts'`
- Gate:
  - Each underscore-prefixed import is either (a) actively used for runtime/type interop, or (b) documented with a clear justification in the same file and covered by lint/test expectations.

---

## Atomic remediation items

### RB-01
- id: `RB-01`
- title: `Close MCP gateway memory-op parity gap (B3)`
- scope: `medium`
- dependency list: `[]`
- required evidence:
  - Query/mutate gateway matrices include memory graph/reason/hybrid ops currently rejected.
  - Validation path accepts `memory.reason.why` and `memory.graph.add` (no `E_INVALID_OPERATION`).
  - Evidence references updated from:
    - `src/mcp/gateways/query.ts`
    - `src/mcp/gateways/mutate.ts`
    - `src/mcp/gateways/__tests__/query.test.ts`
    - `src/mcp/gateways/__tests__/mutate.test.ts`
- test commands:
  - `npx vitest run src/mcp/gateways/__tests__/query.test.ts src/mcp/gateways/__tests__/mutate.test.ts`
  - `npx tsx -e "import { validateQueryParams } from './src/mcp/gateways/query.ts'; import { validateMutateParams } from './src/mcp/gateways/mutate.ts'; console.log(validateQueryParams({domain:'memory',operation:'reason.why',params:{taskId:'T1'}} as any).valid, validateMutateParams({domain:'memory',operation:'graph.add',params:{nodeId:'n1',nodeType:'task',label:'x'}} as any).valid);"`
- acceptance gates:
  - Missing memory ops are callable through canonical MCP gateways.
  - No existing gateway operation removed.
  - Global acceptance policy passes.

### RB-02
- id: `RB-02`
- title: `Add MCP-level acceptance tests for advanced memory ops`
- scope: `small`
- dependency list: `[RB-01]`
- required evidence:
  - Dedicated tests prove end-to-end query/mutate acceptance for `graph.*`, `reason.*`, and `search.hybrid` through gateway validation/dispatch paths.
  - New tests fail before fix and pass after fix.
- test commands:
  - `npx vitest run src/mcp/gateways/__tests__/query.test.ts src/mcp/gateways/__tests__/mutate.test.ts tests/e2e/brain-lifecycle.test.ts`
- acceptance gates:
  - Regression tests lock MCP parity so future drift is caught.
  - Global acceptance policy passes.

### RB-03
- id: `RB-03`
- title: `Add unit tests for session-memory bridge coverage gap`
- scope: `small`
- dependency list: `[]`
- required evidence:
  - New tests directly exercise `src/core/sessions/session-memory-bridge.ts` behavior and error handling.
  - Coverage includes success path and failure-resilience path during session end.
- test commands:
  - `npx vitest run src/core/sessions/__tests__/session-memory-bridge.test.ts src/core/sessions/__tests__/index.test.ts`
- acceptance gates:
  - Bridge behavior is verified independently of E2E tests.
  - Global acceptance policy passes.

### RB-04
- id: `RB-04`
- title: `Synchronize operation-count source-of-truth docs (B14)`
- scope: `small`
- dependency list: `[RB-01]`
- required evidence:
  - Runtime operation totals and canonical docs are consistent (no 207/218/256 drift).
  - Updated references in:
    - `docs/specs/CLEO-OPERATION-CONSTITUTION.md`
    - `docs/concepts/CLEO-VISION.md`
    - `AGENTS.md`
- test commands:
  - `npx tsx -e "import { getQueryOperationCount } from './src/mcp/gateways/query.ts'; import { getMutateOperationCount } from './src/mcp/gateways/mutate.ts'; console.log(getQueryOperationCount(), getMutateOperationCount(), getQueryOperationCount()+getMutateOperationCount());"`
  - `npx vitest run src/mcp/gateways/__tests__/query.test.ts src/mcp/gateways/__tests__/mutate.test.ts`
- acceptance gates:
  - Exactly one canonical operation total appears across runtime/docs.
  - Global acceptance policy passes.

### RB-05
- id: `RB-05`
- title: `Add protocol_valid stage gate to default chain builder (T5399)`
- scope: `small`
- dependency list: `[]`
- required evidence:
  - Default chain builder constructs stage-specific `protocol_valid` gate(s) as claimed.
  - Corresponding test assertions added in `src/core/lifecycle/__tests__/default-chain.test.ts`.
- test commands:
  - `npx vitest run src/core/lifecycle/__tests__/default-chain.test.ts`
- acceptance gates:
  - Claim for T5399 becomes fully verified (not partial).
  - Global acceptance policy passes.

### RB-06
- id: `RB-06`
- title: `Add fork-join chain validation test scenario (T5402 gap)`
- scope: `small`
- dependency list: `[]`
- required evidence:
  - Explicit test confirms a valid fork chain with join passes `validateChain`.
  - Test lives in `src/core/validation/__tests__/chain-validation.test.ts`.
- test commands:
  - `npx vitest run src/core/validation/__tests__/chain-validation.test.ts`
- acceptance gates:
  - Missing fork/join claim element is covered.
  - Global acceptance policy passes.

### RB-07
- id: `RB-07`
- title: `Implement chain find capability end-to-end (T5403 + T5405 overlap)`
- scope: `medium`
- dependency list: `[]`
- required evidence:
  - `findChains` exists in storage/core layer and is wired to `pipeline.chain.find` dispatch/MCP path.
  - Tests verify filtering behavior and backward compatibility for list/show/add.
- test commands:
  - `npx vitest run src/core/lifecycle/__tests__/chain-store.test.ts src/dispatch/domains/__tests__/pipeline.test.ts src/mcp/gateways/__tests__/query.test.ts`
- acceptance gates:
  - `pipeline.chain.find` is available and behaves as documented.
  - No regression in existing chain operations.
  - Global acceptance policy passes.

### RB-08
- id: `RB-08`
- title: `Add DB foreign key for chain instance -> chain relation (T5403 gap)`
- scope: `medium`
- dependency list: `[]`
- required evidence:
  - Schema and migration enforce `chainId` FK semantics.
  - Migration generated using project drizzle workflow (includes snapshot).
  - Tests prove FK constraint behavior and non-breaking upgrades.
- test commands:
  - `npx drizzle-kit generate --custom --name "chain-instance-fk"`
  - `npx vitest run src/core/lifecycle/__tests__/chain-store.test.ts`
- acceptance gates:
  - Referential integrity enforced in DB layer.
  - Migration chain remains valid.
  - Global acceptance policy passes.

### RB-09
- id: `RB-09`
- title: `Complete missing WarpChain operations wiring (T5405 fail)`
- scope: `large`
- dependency list: `[RB-07]`
- required evidence:
  - Operations implemented and wired across registry/domain/gateway layers:
    - `pipeline.chain.gate.pass`
    - `pipeline.chain.gate.fail`
    - `check.chain.gate`
    - `orchestrate.chain.plan`
  - Existing wired operations remain intact.
- test commands:
  - `npx vitest run src/dispatch/domains/__tests__/pipeline.test.ts src/dispatch/domains/__tests__/check.test.ts src/dispatch/domains/__tests__/orchestrate.test.ts src/mcp/gateways/__tests__/query.test.ts src/mcp/gateways/__tests__/mutate.test.ts`
  - `npx tsx -e "import { MemoryHandler } from './src/dispatch/domains/memory.ts'; console.log('dispatch alive', typeof new MemoryHandler().getSupportedOperations === 'function');"`
- acceptance gates:
  - All operations claimed in T5405 are invocable via canonical interfaces.
  - No operation removals from prior supported set.
  - Global acceptance policy passes.

### RB-10
- id: `RB-10`
- title: `Implement Tessera variable type validation and substitution (T5409)`
- scope: `medium`
- dependency list: `[]`
- required evidence:
  - Instantiation validates variable types and performs substitution beyond shallow merge.
  - Error paths are deterministic and user-facing diagnostics are clear.
- test commands:
  - `npx vitest run src/core/lifecycle/__tests__/tessera-engine.test.ts`
  - `npx tsc --noEmit --pretty false`
- acceptance gates:
  - T5409 moves from partial to verified.
  - No regression in existing template defaults/required-variable behavior.
  - Global acceptance policy passes.

### RB-11
- id: `RB-11`
- title: `Add Tessera invalid-variable-type tests (T5410 gap)`
- scope: `small`
- dependency list: `[RB-10]`
- required evidence:
  - Tests assert invalid type input fails with expected error contract.
  - Positive-path tests still pass.
- test commands:
  - `npx vitest run src/core/lifecycle/__tests__/tessera-engine.test.ts`
- acceptance gates:
  - T5410 claim is fully evidenced.
  - Global acceptance policy passes.

### RB-12
- id: `RB-12`
- title: `Strengthen warp workflow E2E for wave-plan and 3-stage advance (T5412 gaps)`
- scope: `small`
- dependency list: `[RB-09]`
- required evidence:
  - E2E includes explicit wave-plan generation assertion.
  - E2E advances through 3 stages with expected state transitions.
- test commands:
  - `npx vitest run tests/e2e/warp-workflow.test.ts`
- acceptance gates:
  - T5412 no longer partial.
  - Global acceptance policy passes.

### RB-13
- id: `RB-13`
- title: `Resolve tracked TODO-comment debt and lock zero-TODO hygiene (Report 05)`
- scope: `small`
- dependency list: `[]`
- required evidence:
  - Actionable TODO comments resolved or policy-scoped with explicit exclusion rationale.
  - Current known TODO locations addressed:
    - `dev/archived/schema-diff-analyzer.sh:217`
    - `dev/archived/schema-diff-analyzer.sh:260`
  - Hygiene policy documents whether `dev/archived/**` is in or out of enforcement scope.
- test commands:
  - `git grep -nE "(^|[[:space:]])(//|#|/\*|\*)[[:space:]]*TODO\b" -- .`
- acceptance gates:
  - Zero in-scope TODO comments in tracked source.
  - Exclusions, if any, are documented and approved in-repo.
  - Global acceptance policy passes.

### RB-14
- id: `RB-14`
- title: `Add CI hygiene gates for TODO and underscore-import justification`
- scope: `medium`
- dependency list: `[RB-13]`
- required evidence:
  - CI step fails on in-scope TODO comments.
  - CI step reports underscore-prefixed imports and enforces justification/wiring rule.
  - Optional: include tests tree in import hygiene if policy requires it.
- test commands:
  - `npx tsc --noEmit`
  - `git grep -nE "import .* as _[A-Za-z0-9_]+" -- 'src/**/*.ts' 'tests/**/*.ts'`
  - `git grep -nE "(^|[[:space:]])(//|#|/\*|\*)[[:space:]]*TODO\b" -- .`
- acceptance gates:
  - Hygiene checks run in CI and block non-compliant changes.
  - Global acceptance policy passes.

---

## Dependency graph (concise)

- `RB-01 -> RB-02 -> RB-04`
- `RB-07 -> RB-09 -> RB-12`
- `RB-10 -> RB-11`
- `RB-13 -> RB-14`
- Independent and parallelizable: `RB-03`, `RB-05`, `RB-06`, `RB-08`

## Prioritized execution order

1. `RB-01`, `RB-07`, `RB-09` (close hard FAIL paths first)
2. `RB-04`, `RB-05`, `RB-06`, `RB-10` (convert partials to verified)
3. `RB-02`, `RB-03`, `RB-11`, `RB-12` (coverage hardening)
4. `RB-13`, `RB-14` (hygiene lock-in and policy enforcement)
