# 11 Epic and Blocker Task Creation

Date: 2026-03-05
Agent: Task Architecture Agent
Scope: Create one remediation epic and exactly one child task per blocker RB-01..RB-14 using CLEO CLI.

## Source Inputs

- `.cleo/agent-outputs/validation/07-remediation-backlog.md`
- `.cleo/agent-outputs/validation/10-review-board-digest.md`

## Created Epic

- Epic ID: `T5414`
- Title: `EPIC: Validation Remediation Closure for Warp/BRAIN/Tessera Claims`
- Type: `epic`
- Priority: `critical`
- Labels: `validation-remediation`, `rb-backlog`
- Description: Coordinates closure of RB-01 through RB-14 for MCP parity, Warp/Tessera claim remediation, and hygiene lock-in before certification.

## RB to CLEO Task Mapping

| RB ID | CLEO Task ID | Priority | Parent | Dependencies |
|---|---|---|---|---|
| RB-01 | T5415 | critical | T5414 | - |
| RB-02 | T5416 | high | T5414 | T5415 |
| RB-03 | T5417 | medium | T5414 | - |
| RB-04 | T5418 | high | T5414 | T5415, T5416 |
| RB-05 | T5419 | medium | T5414 | - |
| RB-06 | T5420 | medium | T5414 | - |
| RB-07 | T5421 | critical | T5414 | - |
| RB-08 | T5422 | high | T5414 | - |
| RB-09 | T5423 | critical | T5414 | T5421 |
| RB-10 | T5424 | high | T5414 | - |
| RB-11 | T5425 | medium | T5414 | T5424 |
| RB-12 | T5426 | medium | T5414 | T5423 |
| RB-13 | T5427 | medium | T5414 | - |
| RB-14 | T5428 | high | T5414 | T5427 |

## Child Task Details

Each child task was created as type `task`, labeled with `validation-remediation`, `rb-backlog`, and blocker label `rb-xx`, and given backlog-derived description plus acceptance criteria.

- `T5415` (`RB-01`): MCP gateway memory op parity closure for graph/reason/hybrid validation and matrices.
- `T5416` (`RB-02`): MCP acceptance tests for graph.*, reason.*, search.hybrid; depends on `T5415`.
- `T5417` (`RB-03`): Session-memory bridge unit tests for success and failure-resilience paths.
- `T5418` (`RB-04`): Runtime/doc operation-count synchronization; depends on `T5415`, `T5416`.
- `T5419` (`RB-05`): Add protocol_valid stage gate coverage for default chain builder.
- `T5420` (`RB-06`): Add fork/join validateChain test scenario.
- `T5421` (`RB-07`): Implement and wire end-to-end chain find capability.
- `T5422` (`RB-08`): Add chain instance to chain FK with migration and integrity tests.
- `T5423` (`RB-09`): Complete missing WarpChain wiring for gate pass/fail, check, orchestrate plan; depends on `T5421`.
- `T5424` (`RB-10`): Tessera variable type validation and deep substitution.
- `T5425` (`RB-11`): Tessera invalid-variable-type negative tests; depends on `T5424`.
- `T5426` (`RB-12`): Warp workflow E2E wave-plan plus 3-stage advance assertions; depends on `T5423`.
- `T5427` (`RB-13`): Resolve TODO debt and lock policy scope for zero-TODO claims.
- `T5428` (`RB-14`): Add CI hygiene gates for TODO and underscore-import justification; depends on `T5427`.

## Commands Used

```bash
cleo add --help
cleo update --help

cleo add "EPIC: Validation Remediation Closure for Warp/BRAIN/Tessera Claims" -t epic -p critical --size large -l "validation-remediation,rb-backlog" -d "Coordinate closure of Review Board remediation backlog RB-01 through RB-14 to restore canonical MCP parity, complete Warp/Tessera claim gaps, and lock validation hygiene before certification." --acceptance "All RB-01 through RB-14 tasks are created with correct dependencies and evidence gates,Blocker items RB-01 RB-07 RB-09 are verified before any completion certification claim,Independent re-validation wave reruns protocol matrix and status reconciliation after remediation"
cleo update T5414 --size large

cleo add "RB-01: Close MCP gateway memory-op parity gap (B3)" -t task --parent T5414 -p critical --size medium -l "validation-remediation,rb-backlog,rb-01" -d "Close the canonical MCP gateway parity gap where memory graph/reason/hybrid operations are implemented in dispatch but rejected at gateway validation. Scope includes query/mutate matrices and validation acceptance for memory.reason.why and memory.graph.add with no E_INVALID_OPERATION." --acceptance "Query and mutate gateway matrices include missing memory graph reason hybrid operations,Validation accepts memory.reason.why and memory.graph.add without E_INVALID_OPERATION,Targeted gateway tests and global acceptance policy checks pass with no existing operation removed"
cleo add "RB-02: Add MCP-level acceptance tests for advanced memory ops" -t task --parent T5414 -p high --size small -l "validation-remediation,rb-backlog,rb-02" -D "T5415" -d "Add dedicated MCP-level acceptance tests that prove query and mutate acceptance for graph.*, reason.*, and search.hybrid through gateway validation and dispatch paths, ensuring future parity regressions are caught." --acceptance "Tests cover graph reason and hybrid operations end to end through gateway validation and dispatch,Test set demonstrates fail-before and pass-after behavior for parity fix,Global acceptance policy checks pass"
cleo add "RB-03: Add unit tests for session-memory bridge coverage gap" -t task --parent T5414 -p medium -l "validation-remediation,rb-backlog,rb-03" -d "Add direct unit tests for session-memory bridge behavior in success and failure-resilience paths during session end so bridge correctness is verified independently of E2E coverage." --acceptance "New tests exercise session-memory bridge success path and failure-resilience path,Bridge behavior is validated independently from E2E suites,Global acceptance policy checks pass"
cleo add "RB-04: Synchronize operation-count source-of-truth docs (B14)" -t task --parent T5414 -p high -l "validation-remediation,rb-backlog,rb-04" -D "T5415" -d "Align runtime MCP operation totals and canonical documentation so there is one consistent operation count across runtime and docs, eliminating 207/218/256 drift." --acceptance "Runtime query and mutate operation totals match canonical docs in all referenced files,Exactly one canonical operation total is present across runtime and documentation,Global acceptance policy checks pass"
cleo add "RB-05: Add protocol_valid stage gate to default chain builder (T5399)" -t task --parent T5414 -p medium -l "validation-remediation,rb-backlog,rb-05" -d "Add stage-specific protocol_valid gate generation in the default lifecycle chain builder and prove behavior in default-chain tests so the T5399 claim is fully verified instead of partial." --acceptance "Default chain builder emits protocol_valid stage gates as documented,default-chain tests assert protocol_valid gate behavior,Global acceptance policy checks pass"
cleo add "RB-06: Add fork-join chain validation test scenario (T5402 gap)" -t task --parent T5414 -p medium -l "validation-remediation,rb-backlog,rb-06" -d "Add explicit chain-validation coverage for a valid fork chain with join so validateChain acceptance includes the missing fork/join claim element." --acceptance "Chain-validation tests include a valid fork with join passing validateChain,Missing fork/join claim element is covered by executable evidence,Global acceptance policy checks pass"
cleo add "RB-07: Implement chain find capability end-to-end (T5403/T5405 overlap)" -t task --parent T5414 -p critical -l "validation-remediation,rb-backlog,rb-07" -d "Implement findChains in storage/core and wire it through pipeline.chain.find dispatch and MCP query interfaces, with filtering tests and backward compatibility coverage for list/show/add operations." --acceptance "findChains is implemented in storage or core and wired to pipeline.chain.find through dispatch and MCP,Tests verify filtering behavior and backward compatibility for list show and add operations,Global acceptance policy checks pass"
cleo add "RB-08: Add DB foreign key for chain instance to chain relation (T5403 gap)" -t task --parent T5414 -p high -l "validation-remediation,rb-backlog,rb-08" -d "Add and validate database foreign key enforcement for chain instance chainId to chain relation, including drizzle migration with snapshot and tests proving referential integrity with non-breaking upgrade behavior." --acceptance "Schema and migration enforce chainId foreign key semantics with generated snapshot workflow,Tests verify foreign key constraint behavior and upgrade compatibility,Global acceptance policy checks pass"
cleo add "RB-09: Complete missing WarpChain operations wiring (T5405 fail)" -t task --parent T5414 -p critical -l "validation-remediation,rb-backlog,rb-09" -D "T5421" -d "Implement and wire missing WarpChain operations across registry, domain, and gateway layers for pipeline.chain.gate.pass, pipeline.chain.gate.fail, check.chain.gate, and orchestrate.chain.plan while preserving existing operation behavior." --acceptance "All listed T5405 operations are invocable via canonical interfaces after wiring,Existing previously wired operations remain intact with no removals,Targeted domain and gateway tests plus global acceptance policy checks pass"
cleo add "RB-10: Implement Tessera variable type validation and substitution (T5409)" -t task --parent T5414 -p high -l "validation-remediation,rb-backlog,rb-10" -d "Implement Tessera instantiation type validation and deep variable substitution beyond shallow merge, with deterministic error paths and clear user-facing diagnostics to close T5409 partial evidence gaps." --acceptance "Instantiation validates variable types and performs substitution beyond shallow merge,Error paths are deterministic with clear diagnostics,No regression in template defaults or required-variable behavior and global acceptance policy checks pass"
cleo add "RB-11: Add Tessera invalid-variable-type tests (T5410 gap)" -t task --parent T5414 -p medium -l "validation-remediation,rb-backlog,rb-11" -D "T5424" -d "Add Tessera tests that assert invalid variable type input fails with the expected error contract while preserving positive-path behavior, fully evidencing the T5410 claim." --acceptance "Invalid variable type inputs fail with expected error contract in tests,Positive path tests remain passing,Global acceptance policy checks pass"
cleo add "RB-12: Strengthen warp workflow E2E for wave-plan and three-stage advance (T5412 gaps)" -t task --parent T5414 -p medium -l "validation-remediation,rb-backlog,rb-12" -D "T5423" -d "Extend warp workflow E2E coverage with explicit wave-plan generation assertions and verified advancement through three lifecycle stages with expected state transitions to close T5412 gaps." --acceptance "E2E test asserts wave-plan generation explicitly,E2E workflow advances through three stages with expected transitions,T5412 evidence is complete and global acceptance policy checks pass"
cleo add "RB-13: Resolve tracked TODO-comment debt and lock zero-TODO hygiene" -t task --parent T5414 -p medium -l "validation-remediation,rb-backlog,rb-13" -d "Resolve actionable tracked TODO-comment debt and codify policy scope for TODO enforcement, including explicit in-scope or excluded treatment for dev/archived paths used in hygiene claims." --acceptance "Known TODO debt locations are resolved or policy-scoped with explicit in-repo rationale,Zero in-scope TODO comments remain in tracked source,Global acceptance policy checks pass"
cleo add "RB-14: Add CI hygiene gates for TODO and underscore-import justification" -t task --parent T5414 -p high -l "validation-remediation,rb-backlog,rb-14" -D "T5427" -d "Add CI hygiene gates that fail on in-scope TODO comments and enforce reporting or justification for underscore-prefixed imports across source and test policy scope." --acceptance "CI fails on in-scope TODO comments,CI reports underscore-prefixed imports and enforces justification or wiring rule,Hygiene checks block non-compliant changes and global acceptance policy checks pass"

cleo update T5418 --add-depends T5416

cleo show T5414 --json
for id in T5415 T5416 T5417 T5418 T5419 T5420 T5421 T5422 T5423 T5424 T5425 T5426 T5427 T5428; do cleo show "$id" --json | jq -r '.result.task | [.id,.title,.priority,((.labels//[])|join("|")),((.depends//[])|join("|")),.parentId] | @tsv'; done
```

## Notes

- CLEO label validation requires lowercase labels; blocker labels were applied as `rb-01`..`rb-14`.
- Dependency graph was implemented per backlog graph with `RB-04` additionally linked through `RB-02`.
