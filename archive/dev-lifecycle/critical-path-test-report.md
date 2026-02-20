# Critical Path Analysis Test Suite Report

**Created**: 2024-12-12
**Status**: ✅ Ready for Implementation
**Location**: `/mnt/projects/claude-todo/tests/test-critical-path.sh`

## Executive Summary

Comprehensive test suite created for critical path analysis functionality in claude-todo CLI. The test suite validates dependency chain identification, bottleneck detection, impact calculation, and edge case handling across 12 distinct test scenarios with 34 total test assertions.

## Test Suite Architecture

### File Structure
```
tests/
├── test-critical-path.sh          # Main test suite (executable)
└── fixtures/
    └── critical-path/
        └── README.md              # Fixture documentation
```

### Test Framework
- **Language**: Bash
- **Pattern**: Self-contained fixtures (inline JSON)
- **Dependencies**: jq, standard Unix tools
- **Execution**: Direct or via `run-all-tests.sh`

## Test Coverage (12 Scenarios, 34 Assertions)

### 1. Single Linear Chain
**Fixture**: A → B → C → D (4 tasks)
**Assertions**: 4 total (2 active, 2 pending implementation)
- ✅ Validates fixture has 4 tasks
- ✅ Validates last task has 1 dependency
- ⏭️ Critical path length verification
- ⏭️ Path identification correctness

**Expected Behavior**:
- Critical path: T001 → T002 → T003 → T004
- Length: 4 tasks
- All tasks on critical path

---

### 2. Multiple Chains (Longest Path Selection)
**Fixture**:
- Short chain: A → B (2 tasks)
- Long chain: C → D → E → F (4 tasks)

**Assertions**: 3 total (1 active, 2 pending)
- ✅ Validates 2 independent starting tasks
- ⏭️ Identifies longest chain
- ⏭️ Critical path starts with correct task

**Expected Behavior**:
- Critical path: T003 → T004 → T005 → T006
- Ignores shorter chain
- Length: 4 tasks

---

### 3. Diamond Dependency Pattern
**Fixture**: A → B → D, A → C → D (parallel paths)
**Assertions**: 3 total (1 active, 2 pending)
- ✅ Validates merge point has 2 dependencies
- ⏭️ Diamond path calculation
- ⏭️ Merge point identification

**Expected Behavior**:
- Either T001 → T002 → T004 or T001 → T003 → T004
- Both paths equally valid (same length)
- Length: 3 tasks

---

### 4. No Dependencies (Independent Tasks)
**Fixture**: 3 independent tasks with no connections
**Assertions**: 2 total (1 active, 1 pending)
- ✅ Validates all tasks are independent
- ⏭️ "No critical path" message verification

**Expected Behavior**:
- Message: "No critical path found" or "All tasks independent"
- Recommendation: Can work on any task

---

### 5. Bottleneck Detection
**Fixture**: T001 blocks T002, T003, T004, T005 (4 dependents)
**Assertions**: 3 total (1 active, 2 pending)
- ✅ Validates 4 tasks depend on T001
- ⏭️ Bottleneck identification
- ⏭️ Impact score calculation

**Expected Behavior**:
- Bottleneck: T001
- Impact score: 4 (blocks 4 tasks)
- Recommendation: Prioritize T001

---

### 6. Empty Task List
**Fixture**: No tasks in array
**Assertions**: 2 total (1 active, 1 pending)
- ✅ Validates empty array (0 tasks)
- ⏭️ Graceful handling verification

**Expected Behavior**:
- No errors/crashes
- Message: "No tasks to analyze"

---

### 7. All Tasks Completed
**Fixture**: 2 completed tasks in dependency chain
**Assertions**: 3 total (1 active, 2 pending)
- ✅ Validates all tasks have status "done"
- ⏭️ Completed task handling
- ⏭️ "No pending critical path" message

**Expected Behavior**:
- Message: "All tasks completed" or "No pending work"
- Historical path available for analysis

---

### 8. Circular Dependency Detection
**Fixture**: A → B → C → A (invalid cycle)
**Assertions**: 2 total (0 active, 2 pending)
- ⏭️ Circular dependency detection
- ⏭️ Error/warning message

**Expected Behavior**:
- Error detected: "Circular dependency detected"
- List affected tasks: T001, T002, T003

---

### 9. Mixed Status Dependencies
**Fixture**: done → active → pending chain
**Assertions**: 3 total (1 active, 2 pending)
- ✅ Validates 3 different statuses present
- ⏭️ Mixed status chain handling
- ⏭️ Completed task exclusion

**Expected Behavior**:
- Critical path: T002 → T003 (excludes completed T001)
- Length: 2 tasks (remaining only)

---

### 10. Complex Multi-Level Tree
**Fixture**: Tree structure with multiple branches and depths
```
       T001 (root)
      /    \
    T002    T003
    /  \
  T004  T005
   |
  T006
```

**Assertions**: 3 total (1 active, 2 pending)
- ✅ Validates deep branch exists (T006)
- ⏭️ Tree depth calculation
- ⏭️ Deepest critical path identification

**Expected Behavior**:
- Critical path: T001 → T002 → T004 → T006
- Length: 4 tasks

---

### 11. Output Format Validation
**Assertions**: 3 pending
- ⏭️ JSON output structure validation
- ⏭️ Text output formatting
- ⏭️ Recommendations section presence

**Expected Behavior**:
- Valid JSON with `_meta` envelope
- Formatted text with sections
- Actionable recommendations

---

### 12. Impact Calculation Accuracy
**Assertions**: 3 pending
- ⏭️ Direct dependency impact
- ⏭️ Transitive dependency impact
- ⏭️ Impact percentage calculation

**Expected Behavior**:
- Correct direct impact counts
- Recursive transitive impact
- Accurate percentage calculations

---

## Test Results Summary

```
Current Status (as of test suite creation):
==========================================
Total Assertions:     34
Active Tests:         10 ✅ (fixture validation)
Pending Tests:        24 ⏭️ (awaiting implementation)
Failed Tests:         0  ❌
==========================================
```

## Implementation Guidelines

### Required Implementation File
**Path**: `/mnt/projects/claude-todo/lib/analysis.sh`

### Core Functions to Implement

```bash
# 1. Build dependency graph from tasks
build_dependency_graph() {
    local todo_file="$1"
    # Returns: adjacency list representation
}

# 2. Detect circular dependencies
detect_circular_dependencies() {
    local graph="$1"
    # Returns: 0 if valid, 1 if circular + affected task IDs
}

# 3. Calculate critical path
calculate_critical_path() {
    local graph="$1"
    local include_completed="${2:-false}"
    # Returns: JSON array of task IDs on critical path
}

# 4. Identify bottlenecks
identify_bottlenecks() {
    local graph="$1"
    local threshold="${2:-2}"  # Min tasks blocked to be bottleneck
    # Returns: JSON array of bottlenecks with impact scores
}

# 5. Calculate impact score
calculate_impact() {
    local task_id="$1"
    local graph="$2"
    # Returns: Number of tasks blocked (direct + transitive)
}

# 6. Generate recommendations
generate_recommendations() {
    local critical_path="$1"
    local bottlenecks="$2"
    # Returns: JSON array of actionable recommendations
}
```

### Algorithms Required

#### Critical Path Calculation
```
1. Build dependency graph (adjacency list)
2. Detect cycles (DFS with visited/stack tracking)
3. Calculate depths (topological sort or DP)
4. Find longest path (track max depth to each node)
5. Backtrack from deepest node to root
```

#### Bottleneck Detection
```
1. Count dependents for each task
2. Calculate impact = direct + transitive dependents
3. Rank by impact score (descending)
4. Filter tasks blocking ≥ threshold others
```

#### Impact Calculation
```
Direct impact: Immediate dependents (1 hop)
Transitive impact: All downstream tasks (recursive DFS)
Impact %: (Blocked tasks / Total pending tasks) × 100
```

## Expected Output Formats

### JSON Output Schema
```json
{
  "$schema": "https://claude-todo.dev/schemas/critical-path-v1.json",
  "_meta": {
    "version": "0.8.0",
    "command": "analyze critical-path",
    "timestamp": "2024-12-12T20:00:00Z"
  },
  "data": {
    "critical_path": {
      "tasks": ["T001", "T002", "T003", "T004"],
      "length": 4,
      "estimated_completion": "N/A"
    },
    "bottlenecks": [
      {
        "task_id": "T001",
        "impact_score": 4,
        "blocked_tasks": ["T002", "T003", "T004", "T005"]
      }
    ],
    "recommendations": [
      {
        "priority": "high",
        "message": "Prioritize T001 (blocks 4 tasks)"
      }
    ],
    "statistics": {
      "total_tasks": 10,
      "tasks_on_critical_path": 4,
      "independent_tasks": 3,
      "circular_dependencies": 0
    }
  }
}
```

### Text Output Format
```
Critical Path Analysis
======================

Critical Path (4 tasks):
  T001: Task A (pending)
    ↓
  T002: Task B (pending)
    ↓
  T003: Task C (pending)
    ↓
  T004: Task D (pending)

Bottlenecks:
  T001: Blocks 4 tasks (Impact: High)

Recommendations:
  1. Prioritize T001 (highest impact)
  2. Consider parallel work on independent branches
  3. Review blocked tasks: T002, T003, T004, T005

Statistics:
  Total Tasks: 10
  Tasks on Critical Path: 4
  Independent Tasks: 3
```

## Edge Cases Handled

| Edge Case | Test Coverage | Expected Behavior |
|-----------|---------------|-------------------|
| Empty task list | Test 6 | Return empty result, no errors |
| No dependencies | Test 4 | Report "no critical path" |
| All completed | Test 7 | Report completed historical path |
| Circular deps | Test 8 | Error with affected task IDs |
| Mixed statuses | Test 9 | Exclude completed from pending analysis |
| Disconnected components | Not yet covered | Analyze each component separately |

## Integration with Test Suite

### Automatic Execution
The test is automatically included in the main test runner:
```bash
./tests/run-all-tests.sh
```

### Isolated Execution
```bash
./tests/test-critical-path.sh
```

### Suite-Specific Execution
```bash
./tests/run-all-tests.sh --suite critical-path
```

## Quality Standards

### Pass Conditions ✅
- Correct critical path identified in all scenarios
- Bottlenecks accurately detected with correct impact scores
- Impact scores calculated correctly (direct + transitive)
- Output format matches JSON schema specification
- All edge cases handled gracefully without crashes
- Circular dependencies detected and reported

### Fail Conditions ❌
- Incorrect path identification (wrong tasks or order)
- Missing bottleneck detection (impact > threshold)
- Incorrect impact calculations (counting errors)
- Invalid JSON output (schema violations)
- Crashes on edge cases (empty, circular, etc.)
- Circular dependencies not detected

## Future Enhancements

### Additional Test Scenarios
- [ ] Performance testing with 100+ tasks
- [ ] Stress testing with deep chains (20+ levels)
- [ ] Wide dependency graphs (50+ parallel tasks)
- [ ] Real-world project dependency patterns
- [ ] Time-based critical path (estimated completion)
- [ ] Priority-weighted critical paths

### Advanced Features
- [ ] Slack time calculation (float analysis)
- [ ] Alternative path suggestions
- [ ] Risk analysis (task failure impact)
- [ ] Resource allocation recommendations
- [ ] Gantt chart data generation
- [ ] PERT chart calculations

## Implementation Readiness

### Prerequisites ✅
- [x] Test framework established
- [x] Test fixtures created (inline)
- [x] Expected behaviors documented
- [x] Output formats specified
- [x] Edge cases identified
- [x] Integration with test runner

### Next Steps
1. Implement `/mnt/projects/claude-todo/lib/analysis.sh`
2. Add core analysis functions (graph, critical path, bottlenecks)
3. Run test suite: `./tests/test-critical-path.sh`
4. Iterate on failing tests until all pass
5. Add to main CLI via `claude-todo analyze critical-path`

## Validation Criteria

When implementation is complete, all 34 assertions should pass:
```bash
./tests/test-critical-path.sh

Expected Output:
=========================================
Test Results
=========================================
Passed:  34
Failed:  0
Skipped: 0
=========================================
✅ All tests passed!
```

## References

- **Test File**: `/mnt/projects/claude-todo/tests/test-critical-path.sh`
- **Fixture Docs**: `/mnt/projects/claude-todo/tests/fixtures/critical-path/README.md`
- **Main Project**: `/mnt/projects/claude-todo/CLAUDE.md`
- **Test Runner**: `/mnt/projects/claude-todo/tests/run-all-tests.sh`

---

**Status**: Test suite ready for implementation phase. All fixtures validated, expected behaviors documented, and integration complete.
