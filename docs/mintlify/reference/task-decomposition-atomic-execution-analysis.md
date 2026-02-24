# Task Decomposition for Atomic Execution Analysis

**Version**: 1.0.0
**Created**: 2025-12-31
**Authority**: TASK-DECOMPOSITION-SPEC v1.1.0
**Example Task**: T1114 (Multi-terminal session binding orchestration)

---

## Executive Summary

This analysis examines how tasks should be decomposed for atomic subagent execution using CLEO's existing task structure. Based on TASK-DECOMPOSITION-SPEC v1.1.0 and the concrete example of T1114 (orchestration epic with 8 subtasks), this document provides practical guidance for creating execution-ready atomic tasks.

**Key Findings:**
- CLEO's existing hierarchy (epic→task→subtask) naturally maps to atomic execution units
- `--size small/medium/large` correlates with atomicity scores (100/83/50)
- `--depends` provides explicit dependency evidence for DAG construction
- Verification gates enable deterministic routing without LLM interpretation

---

## Part 1: Atomic Task Criteria (from TASK-DECOMPOSITION-SPEC)

### 1.1 Six-Point Atomicity Test

A task is ATOMIC if ALL of the following are TRUE:

| # | Criterion | Test | T1114 Example |
|---|-----------|------|---------------|
| 1 | **Single File Scope** | Affects ≤3 tightly-coupled files | T1118: Modifies `lib/session.sh` only |
| 2 | **Single Cognitive Concern** | One "thing" to understand | T1120: "Add Stop hook notification" - single concept |
| 3 | **Clear Acceptance Criteria** | Testable completion condition | T1116: Function signatures defined, smoke tests pass |
| 4 | **No Context Switching** | Can complete in one focus session | T1119: Template creation is self-contained |
| 5 | **No Hidden Sub-Decisions** | All choices made at decomposition time | T1123: Decision matrix pre-defined in description |
| 6 | **Programmatic Validation** | Result verifiable by code/test | T1117: `ct orchestrate --help` returns expected output |

### 1.2 Atomicity Score Calculation

```
atomicity_score = (passed_criteria / 6) * 100

T1118 (Update session.sh):
  ✅ Single file (lib/session.sh)
  ✅ Single concern (env var detection)
  ✅ Clear acceptance (resolve_current_session_id() checks CLEO_SESSION first)
  ✅ No context switching (contained work)
  ✅ No hidden decisions (implementation approach specified)
  ✅ Programmatic validation (unit test for env var priority)
  = 100 (ATOMIC)

T1122 (Update specs):
  ✅ File scope limited (3-4 spec files)
  ⚠️ Multiple concerns (3 specs, 1 schema) - borderline
  ✅ Clear acceptance (documented in notes)
  ✅ No context switching
  ❌ Hidden decision (how to structure diagrams)
  ✅ Programmatic validation (spec validation, cross-reference checks)
  = 83 (MOSTLY ATOMIC, may need review)

T1114 (Parent epic):
  ❌ Multiple files (lib/, scripts/, docs/)
  ❌ Multiple concerns (spawning, monitoring, partitioning, rendering)
  ❌ Acceptance criteria implicit
  ❌ Context switching required
  ❌ Multiple hidden decisions (tmux vs zellij, polling interval, etc.)
  ❌ Manual validation required
  = 0 (NOT ATOMIC, requires decomposition)
```

### 1.3 Size-to-Atomicity Mapping

| CLEO Size | Atomicity Score | File Scope | Example from T1114 |
|-----------|-----------------|------------|---------------------|
| `small` | **100** (MUST be atomic) | 1-2 files | T1118 (session.sh), T1119 (template file) |
| `medium` | **83** (SHOULD be atomic) | 3-7 files | T1122 (3 specs + 1 schema) |
| `large` | **≤50** (MUST NOT be atomic) | 8+ files | T1114 (parent epic - multiple subsystems) |

**Current State of T1114 Subtasks:**
- **Problem**: No `size` field set on any subtask
- **Impact**: Cannot programmatically validate atomicity
- **Recommendation**: Add `--size small` to T1116-T1121, `--size medium` to T1122-T1123

---

## Part 2: Decomposition Strategy

### 2.1 Epic → Task → Subtask Mapping

T1114 demonstrates a well-decomposed epic:

```
T1114 (Epic: Multi-terminal session binding)
  Type: task (actually should be epic based on child count)
  Atomicity: 0
  Children: 8 subtasks
  Status: Pending (blocked on children)

  ├─ T1123 (Decision: Claude Squad vs build-our-own)
  │    Type: subtask
  │    Phase: setup
  │    Priority: critical
  │    Atomicity: 100 (research → decision matrix → recommendation)
  │    Dependencies: [] (blocks all implementation tasks)
  │
  ├─ T1116 (Create lib/orchestrator.sh)
  │    Type: subtask
  │    Phase: core
  │    Priority: high
  │    Atomicity: 100 (single library file, defined functions)
  │    Dependencies: [implicitly T1123]
  │
  ├─ T1117 (Create scripts/orchestrate.sh CLI)
  │    Type: subtask
  │    Phase: core
  │    Priority: high
  │    Atomicity: 100 (single script, defined interface)
  │    Dependencies: [T1116] (uses lib/orchestrator.sh functions)
  │
  ├─ T1118 (Update CLEO_SESSION detection in session.sh)
  │    Type: subtask
  │    Phase: core
  │    Priority: high
  │    Atomicity: 100 (modify 1 function, clear behavior change)
  │    Dependencies: []
  │
  ├─ T1119 (Create agent prompt template)
  │    Type: subtask
  │    Phase: core
  │    Priority: medium
  │    Atomicity: 100 (single template file, clear structure)
  │    Dependencies: []
  │
  ├─ T1120 (Add Stop hook notification)
  │    Type: subtask
  │    Phase: core
  │    Priority: medium
  │    Atomicity: 100 (single hook, event file write)
  │    Dependencies: []
  │
  ├─ T1121 (Document orchestration architecture)
  │    Type: subtask
  │    Phase: polish
  │    Priority: low
  │    Atomicity: 100 (single doc file, defined sections)
  │    Dependencies: [T1116, T1117, T1118, T1120] (document what's implemented)
  │
  └─ T1122 (Update specs for TMUX orchestration)
       Type: subtask
       Phase: polish
       Priority: high
       Atomicity: 83 (3 specs, 1 schema - borderline)
       Dependencies: [T1116, T1117, T1118, T1120] (document implemented behavior)
```

### 2.2 Decomposition Decision Tree

```
FUNCTION should_decompose(task):
    IF task.type == "epic":
        RETURN true  # Epics are inherently non-atomic

    IF task.type == "subtask":
        # Subtasks should be atomic by definition
        atomicity = evaluate_atomicity(task)
        IF atomicity < 100:
            WARN "Subtask {task.id} is not atomic (score={atomicity})"
            # Consider promoting to task and decomposing
        RETURN atomicity < 100

    IF task.type == "task":
        # Tasks MAY be atomic or require decomposition
        atomicity = evaluate_atomicity(task)

        IF task.size == "small":
            # Small tasks MUST be atomic
            ASSERT atomicity == 100
            RETURN false

        IF task.size == "medium":
            # Medium tasks SHOULD be atomic
            IF atomicity >= 83:
                RETURN false  # Acceptable
            ELSE:
                RETURN true   # Needs decomposition

        IF task.size == "large":
            # Large tasks MUST NOT be atomic
            ASSERT atomicity < 100
            RETURN true

    # Default: check atomicity score
    RETURN evaluate_atomicity(task) < 100
```

### 2.3 When to Decompose vs Execute Directly

| Condition | Action | Rationale |
|-----------|--------|-----------|
| `type == "epic"` | **Decompose** | Epics are organizational units, never executable |
| `type == "subtask" AND atomicity < 100` | **Warn + Decompose** | Subtasks should be atomic by definition |
| `size == "small" AND atomicity < 100` | **Error** | Violates spec requirement |
| `size == "medium" AND atomicity >= 83` | **Execute** | Acceptable for medium complexity |
| `size == "large"` | **Decompose** | Large tasks cannot be atomic |
| `has children` | **Orchestrate children** | Parent tasks are coordination units |
| `depends.length > 0 AND all deps done` | **Execute** | Dependencies satisfied |
| `depends.length > 0 AND any dep pending` | **Block** | Wait for dependencies |

**T1114 Example Application:**

```bash
# Current state
ct show T1114
# Status: pending, Type: task, Children: 8

# Decision: Epic with children → orchestrate children
# Should actually be type=epic based on TASK-HIERARCHY-SPEC:
#   - Has 8 children (subtasks)
#   - Represents organizational unit
#   - Not directly executable

# Recommended fix:
ct update T1114 --type epic

# Then orchestrate:
ct orchestrate T1114 --pipeline implementation
```

---

## Part 3: Task Assignment for N Agents

### 3.1 Partitioning Strategies

#### Strategy A: Priority-Based (Current CLEO `analyze`)

```
FUNCTION partition_by_priority(tasks, num_agents):
    # Sort by leverage score (priority + dependency unblocking)
    sorted_tasks = sort_by_leverage(tasks)

    # Distribute round-robin
    partitions = [[] for _ in range(num_agents)]
    for i, task in enumerate(sorted_tasks):
        agent_index = i % num_agents
        partitions[agent_index].append(task)

    RETURN partitions

# Example for T1114 with 3 agents:
Agent 1: [T1123 (critical, setup), T1117 (high, core)]
Agent 2: [T1116 (high, core), T1118 (high, core)]
Agent 3: [T1119 (medium, core), T1120 (medium, core)]

# Problem: Ignores dependencies, may create conflicts
```

#### Strategy B: Dependency-Based (DAG Topological Sort)

```
FUNCTION partition_by_dependencies(tasks, num_agents):
    # Build DAG from dependencies
    dag = build_dag(tasks)

    # Compute execution order (topological sort)
    execution_order = topological_sort(dag)

    # Identify parallel groups (tasks with no mutual dependencies)
    parallel_groups = compute_parallel_groups(dag)

    # Assign groups to agents round-robin
    partitions = [[] for _ in range(num_agents)]
    for group_index, group in enumerate(parallel_groups):
        for task in group:
            agent_index = group_index % num_agents
            partitions[agent_index].append(task)

    RETURN partitions

# Example for T1114 with 3 agents:
# Group 1 (no dependencies):
Agent 1: [T1123]  # Blocks everything, must complete first
Agent 2: []
Agent 3: []

# Group 2 (depends on T1123, parallel within group):
Agent 1: [T1116, T1119]
Agent 2: [T1118, T1120]
Agent 3: [T1117]  # Depends on T1116, but different agent OK

# Group 3 (polish phase, depends on Group 2):
Agent 1: [T1121]
Agent 2: [T1122]
Agent 3: []
```

#### Strategy C: Hybrid (RECOMMENDED for T1114)

```
FUNCTION partition_hybrid(tasks, num_agents):
    # 1. Identify critical path (longest dependency chain)
    critical_path = compute_critical_path(tasks)

    # 2. Assign critical path tasks to single agent (minimize handoffs)
    agent_0 = critical_path

    # 3. Partition remaining tasks by parallel groups
    remaining = tasks - critical_path
    parallel_groups = compute_parallel_groups(remaining)

    # 4. Assign groups round-robin to remaining agents
    for group_index, group in enumerate(parallel_groups):
        agent_index = (group_index % (num_agents - 1)) + 1
        agents[agent_index].extend(group)

    RETURN agents

# Example for T1114 with 3 agents:
# Critical path: T1123 → T1116 → T1117 → T1121
Agent 1 (Critical): [T1123, T1116, T1117, T1121]

# Parallel work:
Agent 2: [T1118, T1122]
Agent 3: [T1119, T1120]

# Benefits:
# - Agent 1 owns the integration (lib → script → docs)
# - Agents 2-3 work on independent enhancements
# - Minimal coordination overhead
```

### 3.2 Load Balancing Considerations

| Factor | Metric | Example from T1114 |
|--------|--------|---------------------|
| **Task Count** | Tasks per agent | Agent 1: 4, Agent 2: 2, Agent 3: 2 (imbalanced but intentional) |
| **Complexity** | Sum of `size` values | If small=1, medium=2, large=3: Agent 1 has more but manageable |
| **Phase Alignment** | Tasks in same phase | Agent 2 has core+polish mix (context switching cost) |
| **Dependency Chains** | Longest chain per agent | Agent 1: 4 sequential (blocks others) |
| **Parallelizability** | Tasks with no mutual deps | Agents 2-3 can work simultaneously |

**Recommendation for T1114:**
- Use **Hybrid strategy** with dependency awareness
- Assign critical path (T1123 → T1116 → T1117) to Agent 1
- Parallelize independent tasks (T1118, T1119, T1120) across Agents 2-3
- Defer polish tasks (T1121, T1122) until core tasks complete

---

## Part 4: Verification Points

### 4.1 Completion Detection

Each atomic task MUST have programmatically verifiable completion criteria:

```yaml
T1116 (lib/orchestrator.sh):
  acceptance:
    - "Functions spawn_tmux_agents(), monitor_agents() exist"
    - "partition_tasks() returns balanced task distribution"
    - "render_dashboard() outputs progress for N agents"
  verification:
    - type: function_signature
      command: "grep -q 'function spawn_tmux_agents' lib/orchestrator.sh"
    - type: smoke_test
      command: "bash -n lib/orchestrator.sh && source lib/orchestrator.sh && declare -f spawn_tmux_agents"
    - type: unit_test
      command: "bats tests/unit/orchestrator.bats"

T1117 (scripts/orchestrate.sh):
  acceptance:
    - "ct orchestrate --help returns expected output"
    - "ct orchestrate <epic-id> --dry-run previews without spawning"
    - "Exit codes match documentation (0=success, 40-49=orchestration errors)"
  verification:
    - type: cli_help
      command: "ct orchestrate --help | grep -q 'agents N'"
    - type: dry_run
      command: "ct orchestrate T1114 --dry-run --format json | jq -e '.preview == true'"
    - type: exit_code
      command: "ct orchestrate T999999 2>&1; [ $? -eq 4 ]  # E_NOT_FOUND"

T1118 (session.sh env var detection):
  acceptance:
    - "resolve_current_session_id() checks CLEO_SESSION env var first"
    - "Falls back to .current-session file if env var not set"
    - "Existing behavior unchanged when env var absent"
  verification:
    - type: unit_test
      command: |
        source lib/session.sh
        export CLEO_SESSION="session_test_001"
        [ "$(resolve_current_session_id)" == "session_test_001" ]
    - type: integration_test
      command: "bats tests/integration/session-env-var.bats"
```

### 4.2 Partial Completion Detection

```
FUNCTION detect_partial_completion(task):
    # Gates-based approach (from orchestration platform)
    gates = get_verification_gates(task)

    IF any(gate == true) AND any(gate == false OR gate == null):
        RETURN {
            status: "partial",
            completed_gates: [g for g in gates if g == true],
            pending_gates: [g for g in gates if g == null],
            failed_gates: [g for g in gates if g == false]
        }

    IF all(gate == true):
        RETURN {status: "complete"}

    IF all(gate == null):
        RETURN {status: "not_started"}

    RETURN {status: "failed"}

# Example for T1117:
Task T1117 gates:
  implemented: true     # Script created
  validated: true       # Code review passed
  testsPassed: false    # Tests failing
  documented: null      # Not started

Result: {
  status: "partial",
  completed_gates: ["implemented", "validated"],
  pending_gates: ["documented"],
  failed_gates: ["testsPassed"],
  recommendation: "Route back to implementer to fix tests"
}
```

### 4.3 Failure Detection

| Failure Type | Detection Method | Example | Recovery |
|--------------|------------------|---------|----------|
| **Syntax Error** | `bash -n <script>` | Invalid Bash syntax | Reimplement |
| **Missing Function** | `declare -f <func>` grep | Function not defined | Add function |
| **Test Failure** | Exit code from test command | `bats tests/` returns non-zero | Fix and retest |
| **Schema Violation** | JSON schema validation | Task missing required field | Update task |
| **Dependency Unmet** | Check `depends` status | Dependency still pending | Block and wait |
| **Circular Dependency** | DAG cycle detection | A depends on B, B depends on A | Restructure deps |
| **Timeout** | Time limit exceeded | Agent doesn't complete in N minutes | Abort and reassign |

---

## Part 5: Rollback Strategies

### 5.1 Task-Level Rollback

```bash
# Scenario: T1117 implementation introduced regression
ct reopen T1117 --reason "Regression: ct list fails after orchestrate.sh added"

# Status change: done → pending
# verification.gates reset
# Round counter increments

# Alternative: If already committed to git
git revert <commit-sha>
ct update T1117 --notes "Reverted commit <sha> due to regression"
ct reopen T1117 --reason "Implementation reverted, needs rework"
```

### 5.2 Epic-Level Rollback

```bash
# Scenario: T1114 orchestration approach fundamentally flawed
# Decision: Pivot to Claude Squad integration (T1123 decision)

# 1. Cancel implementation tasks
ct cancel T1116 --reason "Pivoting to Claude Squad integration per T1123"
ct cancel T1117 --reason "Pivoting to Claude Squad integration per T1123"
ct cancel T1118 --reason "Not needed with Claude Squad approach"

# 2. Create new tasks for integration approach
ct add "Integrate CLEO session binding with Claude Squad" --parent T1114 --depends T1123

# 3. Update T1114 description with pivot rationale
ct update T1114 --notes "Architecture pivot: integrating with Claude Squad instead of custom TMUX orchestrator. See T1123 decision."
```

### 5.3 State-Based Rollback (Orchestration Platform)

```python
# From orchestration platform proposal
def rollback_to_gate(task_id: str, gate: str):
    """
    Reset task state to before specified gate.

    Example: Rollback T1117 to before testsPassed failed
    """
    state = verification.get_gate_state(task_id)

    # Find gate index
    gate_order = ["implemented", "validated", "testsPassed", "documented"]
    rollback_index = gate_order.index(gate)

    # Reset gates from rollback point onward
    for i in range(rollback_index, len(gate_order)):
        state.gates[gate_order[i]] = None

    # Increment round
    state.round += 1

    # Clear failure log for rolled-back gates
    state.failure_log = [
        f for f in state.failure_log
        if f['gate'] not in gate_order[rollback_index:]
    ]

    verification.save_gate_state(task_id, state)

    # Orchestrator will re-route from rolled-back gate
```

---

## Part 6: CLEO Integration Patterns

### 6.1 Using Size Field for Atomicity

```bash
# At task creation (decomposition phase):
ct add "Create lib/orchestrator.sh" \
  --parent T1114 \
  --size small \
  --phase core \
  --priority high \
  --description "Core orchestration library with spawn and monitor functions" \
  --files "lib/orchestrator.sh"

# Validates atomicity:
# - size=small → MUST be atomic (100 score)
# - Single file → passes criterion 1
# - Clear description → passes criterion 3
# - No hidden decisions → passes criterion 5

# Query atomic tasks:
ct list --size small --status pending
# Returns only tasks that MUST be atomic

# Find non-atomic tasks marked as small (violation):
ct analyze | jq '.tasks[] | select(.size == "small" and .atomicity_score < 100)'
```

### 6.2 Using Dependencies for Ordering

```bash
# Explicit dependency declaration:
ct add "Create scripts/orchestrate.sh CLI" \
  --parent T1114 \
  --depends T1116 \
  --size small \
  --phase core \
  --priority high

# Query dependency chain:
ct deps T1117
# Output: T1117 depends on: [T1116]

# Query what task unblocks:
ct deps tree | grep T1116
# Shows: T1116 → T1117

# Find blocked tasks:
ct blockers
# Output: T1117 blocked by: [T1116 (pending)]

# Critical path analysis:
ct blockers analyze
# Output: Longest chain: T1123 → T1116 → T1117 → T1121 (4 tasks)
```

### 6.3 Using Phases for Context Grouping

```bash
# Group tasks by phase:
ct list --phase setup --parent T1114
# Output: [T1123]  # Decision/research before implementation

ct list --phase core --parent T1114
# Output: [T1116, T1117, T1118, T1119, T1120]  # Main implementation

ct list --phase polish --parent T1114
# Output: [T1121, T1122]  # Documentation and cleanup

# Phase progression for orchestration:
ct phase set core
ct orchestrate T1114 --phase-filter core
# Only orchestrates core-phase tasks

# After core complete:
ct phase set polish
ct orchestrate T1114 --phase-filter polish
# Orchestrates polish-phase tasks
```

---

## Part 7: Concrete T1114 Decomposition Example

### 7.1 Current Structure Analysis

```
T1114: LIMITATION: Multi-terminal session binding requires Claude Code conversation ID
  Type: task (SHOULD BE epic based on 8 children)
  Status: pending
  Priority: critical
  Phase: core
  Children: 8 subtasks (T1116-T1123)

  Issues:
  ✅ Good: Clear problem statement
  ✅ Good: Well-decomposed children (atomic units)
  ✅ Good: Dependencies captured (T1117 → T1116, T1121/T1122 → implementation tasks)
  ❌ Bad: Parent type=task instead of epic
  ❌ Bad: No size field on children
  ❌ Bad: T1122 borderline non-atomic (3 specs + 1 schema)
  ❌ Bad: Missing explicit dependency from implementation tasks to T1123 decision
```

### 7.2 Recommended Improvements

```bash
# 1. Fix parent task type
ct update T1114 --type epic

# 2. Add size fields to children
ct update T1116 --size small  # Single library file
ct update T1117 --size small  # Single script
ct update T1118 --size small  # Single function modification
ct update T1119 --size small  # Single template file
ct update T1120 --size small  # Single hook
ct update T1121 --size small  # Single doc file
ct update T1122 --size medium # 3 specs + 1 schema
ct update T1123 --size medium # Research + decision matrix

# 3. Add explicit dependencies
ct update T1116 --depends T1123  # Don't implement until decision made
ct update T1117 --depends T1123,T1116
ct update T1118 --depends T1123
ct update T1119 --depends T1123
ct update T1120 --depends T1123

# 4. Consider decomposing T1122 further
ct add "Update CLEO-SYSTEM-ARCHITECTURE-SPEC §5.3 and §7" \
  --parent T1114 \
  --size small \
  --phase polish \
  --depends T1116,T1117,T1118,T1120

ct add "Update MULTI-SESSION-SPEC terminal binding section" \
  --parent T1114 \
  --size small \
  --phase polish \
  --depends T1116,T1118

ct add "Create/update IMPLEMENTATION-ORCHESTRATION-SPEC" \
  --parent T1114 \
  --size small \
  --phase polish \
  --depends T1116,T1117

ct add "Add orchestration config block to config.schema.json" \
  --parent T1114 \
  --size small \
  --phase polish \
  --depends T1116,T1117

# Then cancel original T1122
ct cancel T1122 --reason "Decomposed into T1124-T1127 for atomic execution"
```

### 7.3 Execution Plan

```
┌─────────────────────────────────────────────────────────────────────┐
│ PHASE 1: DECISION (blocking)                                        │
│ -------------------------------------------------------------------- │
│ T1123: Review Claude Squad vs build-our-own                         │
│   Agent: research-analyst                                            │
│   Output: Decision matrix → CLEO-native or Claude Squad integration │
│   Exit Gate: decision_made = true                                   │
└─────────────────────────────────────────────────────────────────────┘
                           │
                           ▼ (decision_made == true)
┌─────────────────────────────────────────────────────────────────────┐
│ PHASE 2: CORE IMPLEMENTATION (parallel groups)                      │
│ -------------------------------------------------------------------- │
│ GROUP 2A (Foundation):                                               │
│   T1116: Create lib/orchestrator.sh                                 │
│     Agent 1: backend-architect                                       │
│     Verification: smoke_test && unit_test                            │
│                                                                      │
│ GROUP 2B (Parallel to 2A):                                          │
│   T1118: Update session.sh env var detection                        │
│     Agent 2: backend-architect                                       │
│     Verification: unit_test for env var priority                    │
│                                                                      │
│   T1119: Create agent prompt template                               │
│     Agent 3: technical-writer                                        │
│     Verification: template_exists && valid_markdown                  │
│                                                                      │
│   T1120: Add Stop hook notification                                 │
│     Agent 3: backend-architect (after T1119)                         │
│     Verification: hook_registered && event_file_written              │
└─────────────────────────────────────────────────────────────────────┘
                           │
                           ▼ (all Group 2 tasks done)
┌─────────────────────────────────────────────────────────────────────┐
│ GROUP 3: INTEGRATION                                                 │
│ -------------------------------------------------------------------- │
│ T1117: Create scripts/orchestrate.sh CLI                            │
│   Agent 1: backend-architect (uses lib/orchestrator.sh from T1116)  │
│   Verification: help_text && dry_run && exit_codes                   │
└─────────────────────────────────────────────────────────────────────┘
                           │
                           ▼ (T1117 done)
┌─────────────────────────────────────────────────────────────────────┐
│ PHASE 3: POLISH (parallel)                                          │
│ -------------------------------------------------------------------- │
│ T1121: Document orchestration architecture                          │
│   Agent 1: technical-writer                                          │
│   Verification: doc_complete && links_valid                          │
│                                                                      │
│ T1124-T1127: Update specs (4 separate tasks)                        │
│   Agent 2: technical-writer (parallel to T1121)                     │
│   Verification: spec_valid && cross_references_bidirectional         │
└─────────────────────────────────────────────────────────────────────┘
                           │
                           ▼ (all tasks done)
                    T1114 COMPLETE
```

---

## Part 8: Key Takeaways

### 8.1 Atomic Task Characteristics

| Characteristic | Good (T1118) | Bad (Original T1122) | Fix |
|----------------|--------------|----------------------|-----|
| **Scope** | Single function in single file | 3 specs + 1 schema | Decompose into 4 tasks |
| **Decision Points** | Implementation approach specified | How to structure diagrams unclear | Specify diagram requirements |
| **Acceptance Criteria** | Clear, testable (env var priority) | Vague ("update specs") | Itemize per spec file |
| **File Count** | 1 | 4 | Split into 4 tasks (1 file each) |
| **Dependencies** | None (standalone change) | Implicit on all implementation tasks | Explicitly list T1116-T1120 |
| **Validation** | Unit test (programmatic) | Manual spec review | Add spec validation script |

### 8.2 CLEO Integration Best Practices

1. **Always set `--size`**: Enables programmatic atomicity validation
2. **Use `--depends` explicitly**: Don't rely on implicit ordering
3. **One concern per subtask**: If description has "and", consider splitting
4. **Verify gates not output**: Subagents write to `ct verify`, orchestrator reads state
5. **Phase alignment**: Group related tasks in same phase for context efficiency
6. **Critical path awareness**: Assign blocking tasks to single agent to minimize handoffs

### 8.3 Anti-Patterns to Avoid

| Anti-Pattern | Impact | T1114 Example | Fix |
|--------------|--------|---------------|-----|
| **Type mismatch** | Parent task with children but type=task | T1114 has 8 children but type=task | Set type=epic |
| **Missing size** | Cannot validate atomicity | No size on T1116-T1123 | Add --size to all |
| **Implicit deps** | Agents may execute out of order | T1116-T1120 don't depend on T1123 | Add --depends T1123 |
| **Large subtasks** | Subtask exceeds single concern | T1122 touches 4 files | Decompose to 4 tasks |
| **Vague acceptance** | Cannot programmatically verify | "Update specs" is not testable | Specify per-spec checks |
| **Manual verification** | Human-in-loop for every task | Spec updates need manual review | Add spec validation script |

---

## Appendix A: CLEO Commands for Atomic Task Analysis

```bash
# Check if task is atomic (via size and structure)
ct show T1118 --format json | jq '{
  id,
  title,
  size,
  files: (.files // [] | length),
  children: (.hierarchy.childCount // 0),
  atomicity_guess: (
    if .size == "small" and (.files // [] | length) <= 2 and (.hierarchy.childCount // 0) == 0
    then "likely_atomic"
    elif .size == "large" or (.hierarchy.childCount // 0) > 0
    then "not_atomic"
    else "needs_review"
    end
  )
}'

# Find tasks missing size field
ct list --format json | jq '.tasks[] | select(.size == null) | {id, title, type}'

# Identify potential over-decomposition (too many children)
ct list --format json | jq '.tasks[] | select(.hierarchy.childCount > 7) | {
  id,
  title,
  children: .hierarchy.childCount,
  warning: "Exceeds max siblings (7), consider grouping"
}'

# Find tasks with circular dependencies
ct deps tree --format json | jq '.cycles[]'

# Compute critical path for epic
ct blockers analyze --task T1114 --format json | jq '.critical_path'

# Validate all subtasks of epic are atomic
ct list --parent T1114 --format json | jq '.tasks[] | {
  id,
  title,
  size,
  atomic: (.size == "small"),
  children: (.hierarchy.childCount // 0),
  valid: (.size == "small" and (.hierarchy.childCount // 0) == 0)
}'
```

---

## Appendix B: Orchestration Platform Integration

From CLEO-ORCHESTRATION-PLATFORM-PROPOSAL.md, the verification gates pattern enables deterministic routing:

```python
# Deterministic routing table (no LLM interpretation needed)
def determine_next_agent(state: GateState) -> str:
    """
    Pure function: same state always returns same agent.
    """
    if state.round > MAX_ROUNDS:
        return "ABORT"

    gates = state.gates

    # Phase 1: Implementation
    if gates.get("implemented") is None:
        return "implementer"  # T1116, T1117, T1118 agent

    # Phase 2: Validation
    if gates.get("implemented") and gates.get("validated") is None:
        return "validator"  # Code review

    # Phase 3: Testing
    if gates.get("validated") and gates.get("testsPassed") is None:
        return "tester"  # Run tests

    # Cycle back on test failure
    if gates.get("testsPassed") == False:
        state.round += 1
        reset_gates(state, ["implemented", "validated", "testsPassed"])
        return "implementer"  # Fix and retry

    # Phase 4: Documentation
    if gates.get("testsPassed") and gates.get("documented") is None:
        return "documenter"  # T1121, T1122 agent

    # All gates passed
    if all(v == True for v in gates.values() if v is not None):
        return "COMPLETE"

    return "ABORT"  # Unexpected state
```

This eliminates LLM interpretation variance for routing decisions.

---

*End of Analysis*
