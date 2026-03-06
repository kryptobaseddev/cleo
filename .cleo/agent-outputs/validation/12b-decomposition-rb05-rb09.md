# Validation Remediation Decomposition (RB-05 to RB-09)

Date: 2026-03-05
Agent: Decomposition Agent Beta
Scope: Create subtask-only decomposition records for blocker tasks `T5419` through `T5423`.

## Decomposition Principles Applied

- Each blocker was decomposed into 5 atomic subtasks:
  1) schema/model update (or explicit no-change decision),
  2) dispatch/gateway wiring,
  3) tests,
  4) regression checks,
  5) acceptance evidence.
- All created subtasks include labels:
  - `validation-remediation`
  - `decomposition`
  - blocker label (`rb-05` .. `rb-09`)
- Dependency constraint preserved:
  - Parent `T5423` (RB-09) depends on `T5421` (RB-07)
  - All RB-09 subtasks additionally carry `depends: ["T5421"]`

## Created Subtask Mapping

### RB-05 `T5419`

- `T5442` - RB-05.1: Confirm protocol_valid schema/model impact
- `T5450` - RB-05.2: Wire protocol_valid through dispatch/gateway chain assembly
- `T5448` - RB-05.3: Add default-chain tests for protocol_valid gate
- `T5449` - RB-05.4: Run regression checks for existing lifecycle chains
- `T5451` - RB-05.5: Capture acceptance evidence for T5419 closure

### RB-06 `T5420`

- `T5458` - RB-06.1: Confirm fork/join schema-model prerequisites
- `T5455` - RB-06.2: Wire fork-join scenario via dispatch/gateway validation path
- `T5456` - RB-06.3: Add fork-join validateChain test coverage
- `T5457` - RB-06.4: Execute regression checks for chain validation matrix
- `T5454` - RB-06.5: Assemble acceptance evidence for T5420

### RB-07 `T5421`

- `T5468` - RB-07.1: Define chain-find schema/model updates
- `T5472` - RB-07.2: Wire findChains through dispatch and MCP query gateway
- `T5471` - RB-07.3: Add tests for chain-find filtering and compatibility
- `T5470` - RB-07.4: Run regression checks across chain operations
- `T5469` - RB-07.5: Compile acceptance evidence for T5421 completion

### RB-08 `T5422`

- `T5484` - RB-08.1: Specify FK schema/model migration for chain instances
- `T5483` - RB-08.2: Wire FK enforcement through dispatch and gateway persistence paths
- `T5482` - RB-08.3: Add integrity tests for FK success and failure cases
- `T5485` - RB-08.4: Run migration regression and upgrade safety checks
- `T5486` - RB-08.5: Package acceptance evidence for T5422 closure

### RB-09 `T5423` (depends on RB-07)

- `T5488` - RB-09.1: Define model/registry deltas for missing WarpChain ops
- `T5491` - RB-09.2: Wire missing WarpChain ops across domain and gateways
- `T5490` - RB-09.3: Add operation-level tests for new WarpChain routes
- `T5487` - RB-09.4: Execute regression checks for existing WarpChain behavior
- `T5489` - RB-09.5: Prepare acceptance evidence for T5423 closure

## Suggested Wave Execution Order

### Wave 1 - Foundation and schema/model decisions

- RB-05.1 `T5442`
- RB-06.1 `T5458`
- RB-07.1 `T5468`
- RB-08.1 `T5484`

### Wave 2 - Dispatch/gateway wiring design and implementation

- RB-05.2 `T5450`
- RB-06.2 `T5455`
- RB-07.2 `T5472`
- RB-08.2 `T5483`

### Wave 3 - Core test additions and regression for RB-05..RB-08

- RB-05.3 `T5448`, RB-05.4 `T5449`
- RB-06.3 `T5456`, RB-06.4 `T5457`
- RB-07.3 `T5471`, RB-07.4 `T5470`
- RB-08.3 `T5482`, RB-08.4 `T5485`

### Wave 4 - RB-09 dependent execution (after RB-07 done)

- RB-09.1 `T5488`
- RB-09.2 `T5491`
- RB-09.3 `T5490`
- RB-09.4 `T5487`

### Wave 5 - Acceptance evidence and closure packets

- RB-05.5 `T5451`
- RB-06.5 `T5454`
- RB-07.5 `T5469`
- RB-08.5 `T5486`
- RB-09.5 `T5489`

## Notes

- This output is decomposition-only. No source edits were made.
- Subtask sequencing can be parallelized within each wave except where direct dependencies apply.
