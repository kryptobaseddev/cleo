---
id: t9831-sg-arch-solid-saga
tasks: [T9831, T9832, T9833, T9834, T9835, T9836, T9837, T10060, T10061, T10062, T10063, T10064, T10065, T10066, T10067, T10068, T10069, T10070, T10071, T10072, T10073, T10074, T10075, T10076]
kind: feat
summary: "Saga SG-ARCH-SOLID complete: SOLID/DRY architecture restoration across 6 epics, 17 sub-task PRs"
prs: [462, 463, 464, 465, 466, 467, 468, 469, 470, 471, 472, 473, 474, 475, 476, 477, 478]
---

Saga T9831 (SG-ARCH-SOLID) shipped 17 sub-task PRs delivering CLI-as-wrapper + core-as-SDK + contracts-owns-types restoration.

### What's in
- **T9832 E-CONTRACTS-FOUNDATION**: ScaffoldResult/CheckResult/OperationDef/Resolution + 17 provenance unions + memory wire-shapes promoted to @cleocode/contracts
- **T9833 E-CLI-BOUNDARY**: handler-toolkit foundation (5 primitives), OPERATIONS data (7479 LOC) relocated to contracts behind defineOp/defineDomain builders, 8 fat handlers extracted to core/, 3 SSoT-EXEMPT comments retired in nexus.ts, T9621 getDb chokepoint closed
- **T9834 E-CORE-DECOMP**: 4 god-modules decomposed (task-ops 3408 LOC, tasks-schema 2485 LOC with 1190-LOC provenance, scaffold 2445 LOC, brain-retrieval 2348 LOC) → 36 cohesive files behind barrels. Drizzle-kit dry-run verified empty DDL diff
- **T9835 E-CORE-TOOLS**: 13 first-class SDK tools — TaskTools (build-task-tree, compute-critical-path, score-task-priority, render-task-tree), ProjectTools (scaffold-project, doctor-project, scaffold-global), BrainTools (brain-search, brain-observe, brain-fetch, brain-timeline, build-retrieval-bundle), describe-schema
- **T9836 E-TEST-HELPERS**: tests/integration/helpers/ harness; skills-coverage 2726→1817 LOC
- **T9837 E-SSOT-ENFORCEMENT**: 5 CI lint gates (no-raw-define-command, no-direct-db-open, contracts-fan-out, no-ssot-exempt, cli-package-boundary) + cleo check arch CLI runs all gates and emits LAFS envelope

### Numbers
- 17 sub-task PRs (#462–#478) shipped via TeamCreate sg-arch-solid-ship with 17 cleo-subagent executors in worktrees
- ~14,000–17,000 LOC moved/eliminated per master plan estimate
- Zero new test failures vs main baseline
- All 5 lint gates committed in baseline mode (current count) — flip to --strict in follow-up

### Migration / next
- Architectural Boundary Check workflow runs in baseline mode on every PR
- ct-orchestrator + ct-task-executor skills already aligned with worktree-mandatory protocol
