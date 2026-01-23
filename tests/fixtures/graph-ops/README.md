# Graph Operations Test Fixtures

Test fixtures for `lib/graph-ops.sh` graph algorithm unit tests.

## Fixture Overview

### linear-chain.json
**Pattern**: T001 -> T002 -> T003 -> T004
**Purpose**: Test basic linear dependency chain
**Critical Path**: T001 -> T002 -> T003 -> T004 (length 4)
**Waves**: Wave 0: [T001], Wave 1: [T002], Wave 2: [T003], Wave 3: [T004]

### diamond.json
**Pattern**:
```
    T001
   /    \
 T002  T003
   \    /
    T004
```
**Purpose**: Test diamond/convergent dependency pattern
**Critical Path**: Any path through the diamond (length 3)
**Waves**: Wave 0: [T001], Wave 1: [T002, T003], Wave 2: [T004]

### cycle.json
**Pattern**: T001 -> T002 -> T003 -> T001 (circular)
**Purpose**: Test cycle detection
**Expected**: Cycle detected involving all 3 tasks
**Note**: Invalid graph - should trigger cycle detection errors

### parallel.json
**Pattern**: T001 -> T003, T002 -> T003 (T001 and T002 are independent)
**Purpose**: Test parallel task identification
**Critical Path**: Either T001 -> T003 or T002 -> T003 (length 2)
**Waves**: Wave 0: [T001, T002], Wave 1: [T003]

### complex-graph.json
**Pattern**:
```
           T001 (root)
          /    \
       T002    T003
        |      |  \
       T004   T005  T006
        |       |
       T008   T007
```
**Purpose**: Test complex multi-path graphs
**Critical Path**: T001 -> T002 -> T004 -> T008 (length 4 - longest)
**Waves**: 
- Wave 0: [T001]
- Wave 1: [T002, T003]
- Wave 2: [T004, T005, T006]
- Wave 3: [T007, T008]

### multiple-cycles.json
**Pattern**: Two disconnected cycles
- Cycle 1: T001 <-> T002
- Cycle 2: T003 -> T004 -> T005 -> T003
**Purpose**: Test detection of multiple independent cycles
**Expected**: Both cycles detected and reported

### valid-dag.json
**Pattern**:
```
  T001  T002
    \  /
    T003
    /  \
  T004  T005
```
**Purpose**: Test valid DAG (no cycles) - baseline for cycle detection
**Critical Path**: T001/T002 -> T003 -> T004/T005 (length 3)
**Waves**: Wave 0: [T001, T002], Wave 1: [T003], Wave 2: [T004, T005]

## Test Categories Coverage

| Fixture | Critical Path | Impact Radius | Waves | Cycles | Topo Sort |
|---------|--------------|---------------|-------|--------|-----------|
| linear-chain | X | X | X | - | X |
| diamond | X | X | X | - | X |
| cycle | - | - | - | X | X (fail) |
| parallel | X | X | X | - | X |
| complex-graph | X | X | X | - | X |
| multiple-cycles | - | - | - | X | X (fail) |
| valid-dag | X | X | X | X (none) | X |

## Usage in Tests

Fixtures can be loaded directly or used as templates for inline fixture creation:

```bash
# Copy fixture to test directory
cp "$FIXTURES_DIR/graph-ops/linear-chain.json" "$TODO_FILE"

# Or use inline fixture helpers defined in the test file
create_linear_chain
create_diamond_dependency
create_simple_cycle
```

## Schema Compliance

All fixtures use schema version 2.3.0 and include:
- `_meta.checksum` for cache validation
- `_meta.lastModified` for staleness detection
- Standard 5-phase project structure
- Required task fields (id, title, description, status, depends)
