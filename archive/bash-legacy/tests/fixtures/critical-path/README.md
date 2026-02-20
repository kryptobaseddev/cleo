# Critical Path Analysis Test Fixtures

Comprehensive test fixtures for validating critical path analysis, bottleneck detection, and dependency chain calculations.

## Test Coverage Overview

### 1. Single Linear Chain
**File**: Inline fixture in test suite
**Pattern**: A → B → C → D (4 tasks)
**Purpose**: Verify basic chain identification
**Expected Behavior**:
- Critical path: T001 → T002 → T003 → T004
- Path length: 4 tasks
- All tasks on critical path

### 2. Multiple Chains
**File**: Inline fixture in test suite
**Pattern**:
- Chain 1: A → B (2 tasks)
- Chain 2: C → D → E → F (4 tasks)

**Purpose**: Verify longest chain selection
**Expected Behavior**:
- Critical path: T003 → T004 → T005 → T006
- Path length: 4 tasks (chain 2)
- Chain 1 ignored (shorter)

### 3. Diamond Pattern
**File**: Inline fixture in test suite
**Pattern**: A → B → D, A → C → D
**Purpose**: Verify parallel path handling
**Expected Behavior**:
- Critical path: Either T001 → T002 → T004 or T001 → T003 → T004
- Path length: 3 tasks
- Both paths equally valid (same length)

### 4. No Dependencies
**File**: Inline fixture in test suite
**Pattern**: 3 independent tasks
**Purpose**: Verify handling of unconnected tasks
**Expected Behavior**:
- No critical path (all tasks independent)
- Message: "No critical path found" or "All tasks independent"
- Recommendation: Can work on any task

### 5. Bottleneck Detection
**File**: Inline fixture in test suite
**Pattern**: T001 ← T002, T001 ← T003, T001 ← T004, T001 ← T005
**Purpose**: Identify tasks blocking multiple others
**Expected Behavior**:
- Bottleneck: T001
- Impact score: 4 (blocks 4 tasks)
- Recommendation: Prioritize T001 completion

### 6. Empty Task List
**File**: Inline fixture in test suite
**Pattern**: No tasks
**Purpose**: Verify graceful handling of empty state
**Expected Behavior**:
- Return empty result or null
- No errors/crashes
- Message: "No tasks to analyze"

### 7. All Tasks Completed
**File**: Inline fixture in test suite
**Pattern**: 2 completed tasks in dependency chain
**Purpose**: Verify completed task handling
**Expected Behavior**:
- No pending critical path
- Message: "All tasks completed" or "No pending work"
- Historical path available for analysis

### 8. Circular Dependency
**File**: Inline fixture in test suite
**Pattern**: A → B → C → A (cycle)
**Purpose**: Detect invalid circular dependencies
**Expected Behavior**:
- Error or warning detected
- Message: "Circular dependency detected"
- List affected tasks: T001, T002, T003

### 9. Mixed Status Dependencies
**File**: Inline fixture in test suite
**Pattern**: done → active → pending
**Purpose**: Calculate remaining critical path
**Expected Behavior**:
- Critical path: T002 → T003 (excludes completed T001)
- Path length: 2 tasks (remaining only)
- Recommendation focuses on active/pending tasks

### 10. Complex Multi-Level Tree
**File**: Inline fixture in test suite
**Pattern**: Tree with multiple branches and depths
```
       T001 (root)
      /    \
    T002    T003
    /  \
  T004  T005
   |
  T006
```
**Purpose**: Verify deep dependency chain calculation
**Expected Behavior**:
- Critical path: T001 → T002 → T004 → T006
- Path length: 4 tasks
- Identifies deepest branch

## Expected Output Formats

### Text Output Example
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
```

### JSON Output Example
```json
{
  "$schema": "https://claude-todo.dev/schemas/v1/critical-path.schema.json",
  "_meta": {
    "format": "json",
    "version": "0.16.0",
    "command": "blockers analyze",
    "timestamp": "2025-12-17T20:00:00Z"
  },
  "summary": {
    "blockedCount": 5,
    "maxChainDepth": 4,
    "totalImpactedTasks": 4,
    "criticalPathLength": 4,
    "bottleneckCount": 1
  },
  "criticalPath": {
    "id": "T001",
    "title": "Task A",
    "chainDepth": 4,
    "impactCount": 4
  },
  "bottlenecks": [
    {
      "id": "T001",
      "title": "Task A",
      "impactCount": 4,
      "blockedTasks": ["T002", "T003", "T004", "T005"]
    }
  ],
  "recommendations": {
    "highImpact": [
      {
        "id": "T001",
        "title": "Task A",
        "impactCount": 4,
        "reason": "Unblocking this task will enable 4 other tasks"
      }
    ],
    "quickWins": [
      {
        "id": "T005",
        "title": "Task E",
        "chainDepth": 1,
        "reason": "Short dependency chain - quick to unblock"
      }
    ]
  }
}
```

## Implementation Guidelines

### Critical Path Algorithm
1. **Build dependency graph**: Create adjacency list from task dependencies
2. **Detect cycles**: Use DFS with visited/stack tracking
3. **Calculate depths**: Use topological sort or dynamic programming
4. **Find longest path**: Track maximum depth to each node
5. **Identify critical path**: Backtrack from deepest node

### Bottleneck Detection Algorithm
1. **Count dependents**: For each task, count direct and transitive dependents
2. **Calculate impact**: Impact score = number of blocked tasks
3. **Rank bottlenecks**: Sort by impact score (descending)
4. **Filter threshold**: Consider tasks blocking ≥2 others as bottlenecks

### Impact Calculation
- **Direct impact**: Immediate dependents (1 hop)
- **Transitive impact**: All downstream tasks (recursive)
- **Impact percentage**: (Blocked tasks / Total pending tasks) × 100

### Edge Cases to Handle
1. **Empty task list**: Return empty result gracefully
2. **No dependencies**: Report "no critical path"
3. **All completed**: Report completed historical path
4. **Circular dependencies**: Error with affected task IDs
5. **Disconnected components**: Analyze each component separately
6. **Mixed statuses**: Exclude completed tasks from pending analysis

## Test Validation Criteria

### ✅ Pass Conditions
- Correct critical path identified
- Bottlenecks accurately detected
- Impact scores calculated correctly
- Output format matches schema
- Edge cases handled gracefully
- No crashes on invalid input

### ❌ Fail Conditions
- Incorrect path identification
- Missing bottleneck detection
- Incorrect impact calculations
- Invalid JSON output
- Crashes on edge cases
- Circular dependencies not detected

## Usage

Run all critical path tests:
```bash
./tests/test-critical-path.sh
```

Run with verbose output:
```bash
bash -x ./tests/test-critical-path.sh
```

## Integration with Test Suite

Add to `tests/run-all-tests.sh`:
```bash
echo "Running critical path analysis tests..."
./tests/test-critical-path.sh || FAILED=$((FAILED + 1))
```

## Future Enhancements

### Additional Test Scenarios
- [ ] Performance testing with 100+ tasks
- [ ] Stress testing with deep chains (20+ levels)
- [ ] Wide dependency graphs (50+ parallel tasks)
- [ ] Real-world project dependency patterns
- [ ] Time-based critical path (estimated completion times)
- [ ] Priority-weighted critical paths

### Advanced Features to Test
- [ ] Slack time calculation (float analysis)
- [ ] Alternative path suggestions
- [ ] Risk analysis (task failure impact)
- [ ] Resource allocation recommendations
- [ ] Gantt chart data generation
- [ ] PERT chart calculations
