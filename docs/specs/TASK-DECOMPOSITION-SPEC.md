# Task Decomposition Specification

**Version**: 1.0.0
**Status**: DRAFT
**Created**: 2025-12-19
**Target**: v0.22.0+
**Implementation Report**: [TASK-DECOMPOSITION-SPEC-IMPLEMENTATION-REPORT.md](TASK-DECOMPOSITION-SPEC-IMPLEMENTATION-REPORT.md)

---

## Part 1: Preamble

### 1.1 Purpose

This specification defines an LLM-agent-first task decomposition system for transforming high-level user requests into atomic, executable tasks. The system produces validated task DAGs (Directed Acyclic Graphs) with dependency relationships suitable for parallel or sequential agent execution.

### 1.2 Authority

This specification is **AUTHORITATIVE** for:
- Task decomposition algorithm phases
- Atomicity criteria and validation
- Dependency graph construction rules
- Challenge protocol for decomposition validation
- CLI integration (`decompose` command)
- JSON output schemas for decomposition results

This specification **DEFERS TO**:
- [SPEC-BIBLE-GUIDELINES.md](SPEC-BIBLE-GUIDELINES.md) for document structure
- [LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md) for task ID format
- [HIERARCHY-ENHANCEMENT-SPEC.md](HIERARCHY-ENHANCEMENT-SPEC.md) for type/parentId/size fields
- [LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md) for JSON output standards
- [CONSENSUS-FRAMEWORK-SPEC.md](CONSENSUS-FRAMEWORK-SPEC.md) for adversarial validation protocol

---

## Part 2: RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all
capitals, as shown here.

---

## Part 3: Executive Summary

### 3.1 Problem Statement

LLM agents struggle with:
1. **Scope explosion**: Large tasks exceed context windows
2. **Hallucinated dependencies**: Assuming ordering that doesn't exist
3. **Non-atomic tasks**: Tasks that require hidden sub-decisions
4. **Parallel blindness**: Treating everything as sequential

### 3.2 Solution Architecture

A 4-phase decomposition pipeline with adversarial validation:

```
HUMAN INPUT (request)
       ↓
┌──────────────────────────────────────┐
│ PHASE 1: SCOPE ANALYZER              │
│ Complexity assessment, HITL gates    │
└──────────────────┬───────────────────┘
                   ↓
┌──────────────────────────────────────┐
│ PHASE 2: GOAL DECOMPOSER (HTN)       │
│ Recursive breakdown, atomicity check │
│ ← CHALLENGE: Valid decomposition?    │
└──────────────────┬───────────────────┘
                   ↓
┌──────────────────────────────────────┐
│ PHASE 3: DEPENDENCY GRAPH BUILDER    │
│ DAG construction, cycle detection    │
│ ← CHALLENGE: Dependencies real?      │
└──────────────────┬───────────────────┘
                   ↓
┌──────────────────────────────────────┐
│ PHASE 4: TASK SPECIFIER              │
│ Schema-compliant output generation   │
│ ← CHALLENGE: Truly atomic?           │
└──────────────────┬───────────────────┘
                   ↓
OUTPUT: Task DAG (todo.schema.json compliant)
```

### 3.3 Core Principles

| Principle | Requirement |
|-----------|-------------|
| **No Time Estimates** | Size by scope (small/medium/large), NEVER hours/days |
| **Evidence-Based Dependencies** | Dependencies MUST be provable, not assumed |
| **Atomicity Threshold** | Tasks MUST pass 6-point atomicity criteria |
| **Adversarial Validation** | Each phase MUST survive challenge |
| **HITL Gates** | Ambiguity triggers human decision points |
| **LLM-Agent-First Output** | JSON with `_meta` envelope, structured errors |

---

## Part 4: Atomicity Criteria (AUTHORITATIVE)

### 4.1 Six-Point Atomicity Test

A task is ATOMIC if and only if ALL of the following are TRUE:

| # | Criterion | Test | Failure Indicator |
|---|-----------|------|-------------------|
| 1 | **Single File Scope** | Affects ≤3 tightly-coupled files | Changes 4+ unrelated files |
| 2 | **Single Cognitive Concern** | One "thing" to understand | Requires context switching |
| 3 | **Clear Acceptance Criteria** | Testable completion condition | "It works" is not testable |
| 4 | **No Context Switching** | Can complete in one focus session | Requires waiting for external input |
| 5 | **No Hidden Sub-Decisions** | All choices made at decomposition time | Agent must ask HITL during execution |
| 6 | **Programmatic Validation** | Result verifiable by code/test | Requires subjective human judgment |

### 4.2 Atomicity Score Calculation

```
atomicity_score = (passed_criteria / 6) * 100

IF atomicity_score < 100:
    task.requiresDecomposition = true
    task.failedCriteria = [list of failed criterion IDs]
```

### 4.3 Size-to-Atomicity Mapping

| Size | File Scope | Atomicity Expectation |
|------|------------|----------------------|
| `small` | 1-2 files | MUST be atomic (score = 100) |
| `medium` | 3-7 files | SHOULD be atomic, MAY need review |
| `large` | 8+ files | MUST NOT be atomic, MUST decompose |

### 4.4 Examples

**ATOMIC** (score = 100):
```yaml
title: "Add validation to email input field"
files: ["src/components/EmailInput.tsx"]
acceptance: ["Email regex validates format", "Error message displays on invalid input"]
```

**NOT ATOMIC** (score = 50):
```yaml
title: "Implement authentication system"
files: ["src/auth/*", "src/api/*", "src/db/*"]  # Criterion 1 FAIL
acceptance: ["Users can log in"]  # Criterion 3 FAIL (not specific)
hidden_decisions: ["OAuth vs JWT?", "Session storage?"]  # Criterion 5 FAIL
```

---

## Part 5: Phase 1 - Scope Analyzer

### 5.1 Purpose

Assess input complexity and determine decomposition strategy before work begins.

### 5.2 Inputs

```typescript
interface ScopeInput {
  request: string;           // Natural language or structured
  context?: {
    codebase?: string;       // Project root path
    existingTasks?: Task[];  // Current task list for dedup
    phase?: string;          // Current project phase
  };
}
```

### 5.3 Algorithm

```
FUNCTION analyze_scope(input: ScopeInput) -> ScopeAssessment:

    # Step 1: Entity extraction
    entities = extract_entities(input.request)
    # entities: { files: [], components: [], concepts: [], actions: [] }

    # Step 2: Complexity scoring
    complexity = {
        file_count: estimate_files(entities),
        component_count: count_distinct(entities.components),
        reasoning: assess_reasoning_complexity(input.request),
        ambiguity: detect_ambiguities(input.request)
    }

    # Step 3: Classification
    IF complexity.file_count > 10 OR complexity.component_count > 3:
        classification = "epic"
        requires_decomposition = true
    ELSE IF complexity.file_count <= 2 AND complexity.reasoning == "trivial":
        classification = "subtask"
        requires_decomposition = false
    ELSE:
        classification = "task"
        requires_decomposition = complexity.file_count > 3

    # Step 4: HITL gate check
    IF complexity.ambiguity.count > 0:
        hitl_required = true
        hitl_questions = complexity.ambiguity.items
    ELSE:
        hitl_required = false

    RETURN ScopeAssessment {
        classification,
        requires_decomposition,
        complexity,
        hitl_required,
        hitl_questions
    }
```

### 5.4 Output Schema

```json
{
  "$schema": "https://cleo.dev/schemas/v1/decomposition/scope.schema.json",
  "_meta": {
    "phase": "scope-analysis",
    "version": "1.0.0",
    "timestamp": "2025-12-19T10:00:00Z"
  },
  "input": {
    "request": "Implement user authentication with OAuth",
    "requestHash": "sha256:abc123..."
  },
  "assessment": {
    "classification": "epic",
    "requiresDecomposition": true,
    "complexity": {
      "fileCount": 15,
      "componentCount": 4,
      "reasoning": "high",
      "domains": ["auth", "db", "api", "ui"]
    },
    "ambiguities": [
      {
        "id": "AMB-001",
        "question": "Which OAuth providers should be supported?",
        "severity": "blocking",
        "options": ["Google only", "Google + GitHub", "All major providers"]
      }
    ],
    "hitlRequired": true
  }
}
```

### 5.5 Exit Codes

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | `EXIT_SUCCESS` | Scope analysis complete |
| 2 | `EXIT_INVALID_INPUT` | Request is empty or malformed |
| 30 | `EXIT_HITL_REQUIRED` | Ambiguities require human input |

---

## Part 6: Phase 2 - Goal Decomposer

### 6.1 Purpose

Recursively decompose goals into atomic tasks using HTN-inspired methods.

### 6.2 Decomposition Methods (AUTHORITATIVE)

Each goal type has defined decomposition methods:

| Goal Pattern | Method | Subtask Template |
|--------------|--------|------------------|
| `implement_feature` | Feature Decomposition | [schema, api, logic, ui, tests] |
| `fix_bug` | Bug Fix Decomposition | [reproduce, diagnose, fix, verify] |
| `refactor_code` | Refactor Decomposition | [analyze, plan, execute, verify] |
| `add_command` | CLI Command Decomposition | [script, help, tests, docs] |
| `update_schema` | Schema Migration | [schema, migration, validation, update-code] |

### 6.3 Algorithm

```
FUNCTION decompose_goal(goal: Goal, depth: int = 0) -> TaskTree:

    # Depth guard (per TASK-HIERARCHY-SPEC)
    IF depth >= 3:
        WARN("Max depth reached, forcing atomic")
        RETURN create_atomic_task(goal)

    # Atomicity check
    atomicity = evaluate_atomicity(goal)
    IF atomicity.score == 100:
        RETURN create_atomic_task(goal)

    # Select decomposition method
    method = select_method(goal.pattern)
    IF method == null:
        # Fallback: generic decomposition
        method = generic_decomposition_method()

    # Apply method
    subtasks = []
    FOR template IN method.subtask_templates:
        subtask_goal = instantiate_template(template, goal)
        subtask_tree = decompose_goal(subtask_goal, depth + 1)
        subtasks.append(subtask_tree)

    # Sibling limit check (per TASK-HIERARCHY-SPEC)
    IF len(subtasks) > 7:
        subtasks = group_into_intermediates(subtasks, max_group=7)

    RETURN TaskTree {
        root: goal,
        children: subtasks,
        method: method.name
    }
```

### 6.4 Challenge Protocol (Phase 2)

Per CONSENSUS-FRAMEWORK-SPEC Part 5.5, decomposition MUST be challenged:

**Challenge Questions:**
1. "Can any of these subtasks be merged without losing clarity?"
2. "Are there missing tasks required to achieve the goal?"
3. "Does each subtask have clear, distinct acceptance criteria?"
4. "Is the decomposition method appropriate for this goal pattern?"

**Challenge Agent Evidence Standard:**
- Logical counter-argument with specific subtask reference
- OR counter-example showing merge/split improves outcome

**Verdict Thresholds:**
| Verdict | Condition |
|---------|-----------|
| VALID | Challenge Agent finds no substantive issues |
| NEEDS_REVISION | Challenge Agent identifies fixable issues |
| REJECTED | Decomposition fundamentally flawed, restart |

### 6.5 Output Schema

```json
{
  "$schema": "https://cleo.dev/schemas/v1/decomposition/goals.schema.json",
  "_meta": {
    "phase": "goal-decomposition",
    "version": "1.0.0",
    "method": "feature_decomposition",
    "depth": 2,
    "challengeStatus": "validated"
  },
  "goalTree": {
    "id": "G001",
    "title": "Implement user authentication",
    "type": "epic",
    "atomicityScore": 33,
    "children": [
      {
        "id": "G002",
        "title": "Create user schema",
        "type": "task",
        "atomicityScore": 100,
        "children": []
      },
      {
        "id": "G003",
        "title": "Implement login API",
        "type": "task",
        "atomicityScore": 83,
        "children": [
          {
            "id": "G004",
            "title": "Add /auth/login endpoint",
            "type": "subtask",
            "atomicityScore": 100,
            "children": []
          }
        ]
      }
    ]
  },
  "challenge": {
    "agent": "requirements-analyst",
    "verdict": "VALID",
    "findings": [],
    "timestamp": "2025-12-19T10:05:00Z"
  }
}
```

---

## Part 7: Phase 3 - Dependency Graph Builder

### 7.1 Purpose

Construct a validated DAG from the goal tree, identifying true dependencies and parallel opportunities.

### 7.2 Dependency Types (AUTHORITATIVE)

| Type | Detection Method | Evidence Required |
|------|------------------|-------------------|
| **Explicit** | Keywords: "after", "requires", "depends on" | Present in goal description |
| **Data Flow** | Output of A is input of B | Schema/type analysis |
| **File Conflict** | Both modify same file | File path intersection |
| **API Contract** | B calls API defined in A | Code/interface analysis |
| **Semantic** | Logical ordering (schema before queries) | Domain knowledge |

### 7.3 Algorithm

```
FUNCTION build_dependency_graph(goal_tree: TaskTree) -> DAG:

    # Flatten tree to node list
    nodes = flatten_to_leaves(goal_tree)

    # Initialize empty edge set
    edges = []

    FOR each node_a IN nodes:
        FOR each node_b IN nodes WHERE node_a != node_b:

            # Check each dependency type
            dependency = detect_dependency(node_a, node_b)

            IF dependency.exists:
                edge = Edge {
                    from: node_a.id,
                    to: node_b.id,
                    type: dependency.type,
                    evidence: dependency.evidence
                }
                edges.append(edge)

    # Construct DAG
    dag = DAG(nodes, edges)

    # Validate: no cycles
    IF has_cycle(dag):
        cycles = find_cycles(dag)
        RETURN Error {
            code: "E_CIRCULAR_REFERENCE",
            exitCode: 14,
            cycles: cycles
        }

    # Optimize: identify parallel groups
    dag.parallelGroups = compute_parallel_groups(dag)

    # Compute execution order
    dag.executionOrder = topological_sort(dag)

    RETURN dag
```

### 7.4 Challenge Protocol (Phase 3)

**Challenge Questions:**
1. "Is dependency X→Y proven or merely assumed?"
2. "Can task A actually run in parallel with B?"
3. "Are there hidden shared-state conflicts?"
4. "What happens if task C fails - what are the ripple effects?"

**Evidence Standard for Dependencies:**

| Claim | Required Evidence |
|-------|-------------------|
| "A must complete before B" | Data flow proof OR explicit requirement |
| "A and B can run in parallel" | No shared state, no ordering requirement |
| "A blocks B on failure" | Error propagation path identified |

### 7.5 Output Schema

```json
{
  "$schema": "https://cleo.dev/schemas/v1/decomposition/dag.schema.json",
  "_meta": {
    "phase": "dependency-graph",
    "version": "1.0.0",
    "nodeCount": 5,
    "edgeCount": 4,
    "maxParallelism": 3,
    "criticalPathLength": 3,
    "challengeStatus": "validated"
  },
  "nodes": [
    {"id": "T001", "title": "Create user schema", "depth": 0},
    {"id": "T002", "title": "Add login endpoint", "depth": 1},
    {"id": "T003", "title": "Add logout endpoint", "depth": 1},
    {"id": "T004", "title": "Write auth tests", "depth": 2},
    {"id": "T005", "title": "Update API docs", "depth": 2}
  ],
  "edges": [
    {"from": "T001", "to": "T002", "type": "data_flow", "evidence": "User model required"},
    {"from": "T001", "to": "T003", "type": "data_flow", "evidence": "User model required"},
    {"from": "T002", "to": "T004", "type": "semantic", "evidence": "Tests require implementation"},
    {"from": "T003", "to": "T004", "type": "semantic", "evidence": "Tests require implementation"}
  ],
  "parallelGroups": [
    {"group": 1, "tasks": ["T001"]},
    {"group": 2, "tasks": ["T002", "T003"]},
    {"group": 3, "tasks": ["T004", "T005"]}
  ],
  "executionOrder": ["T001", "T002", "T003", "T004", "T005"],
  "challenge": {
    "agent": "requirements-analyst",
    "verdict": "VALID",
    "findings": [
      {
        "type": "optimization",
        "message": "T005 (docs) could run in parallel with T002/T003",
        "action": "accepted",
        "newEdge": null
      }
    ]
  }
}
```

---

## Part 8: Phase 4 - Task Specifier

### 8.1 Purpose

Generate schema-compliant task objects ready for insertion into cleo.

### 8.2 Field Mapping

| DAG Field | todo.schema.json Field | Transformation |
|-----------|------------------------|----------------|
| `node.id` | `id` | Prefix with "T", pad to 3+ digits |
| `node.title` | `title` | Validate length ≤120 chars |
| `goal.type` | `type` | Map: epic/task/subtask |
| `parent_node.id` | `parentId` | Use parent's task ID |
| `node.atomicityScore` | `size` | ≤50→small, ≤80→medium, else→large |
| `edges[to=node]` | `depends` | Collect all incoming edge sources |
| `goal.acceptance` | `acceptance` | Array of testable criteria |

### 8.3 Algorithm

```
FUNCTION specify_tasks(dag: DAG, phase: string) -> Task[]:

    tasks = []
    id_counter = get_next_task_id()  # From existing todo.json

    FOR node IN dag.executionOrder:

        # Generate ID
        task_id = format_id(id_counter++)

        # Map fields
        task = {
            id: task_id,
            title: truncate(node.title, 120),
            status: "pending",
            priority: infer_priority(node),
            type: node.type,
            parentId: get_parent_id(node, dag),
            size: atomicity_to_size(node.atomicityScore),
            phase: phase,
            description: node.description,
            files: node.files or [],
            acceptance: node.acceptance or [],
            depends: get_dependencies(node, dag, id_mapping),
            createdAt: now_iso8601(),
            labels: ["decomposed", f"decomposition:{decomposition_id}"]
        }

        # Validate against schema
        validation = validate_schema(task, "todo.schema.json")
        IF NOT validation.valid:
            RETURN Error {
                code: "E_VALIDATION_SCHEMA",
                exitCode: 6,
                task: task_id,
                errors: validation.errors
            }

        tasks.append(task)

    RETURN tasks
```

### 8.4 Challenge Protocol (Phase 4)

**Challenge Questions:**
1. "Can an LLM agent complete this task without HITL intervention?"
2. "Is the scope truly minimal or can it be decomposed further?"
3. "Are the acceptance criteria actually testable by code?"
4. "Is the size classification accurate?"

**Atomicity Verification Checklist:**
```
FOR each task IN tasks:
    [ ] Single file scope (≤3 files)
    [ ] Single cognitive concern
    [ ] Clear acceptance criteria (≥1 testable)
    [ ] No hidden sub-decisions
    [ ] No external wait requirements
    [ ] Programmatically verifiable result
```

### 8.5 Final Output Schema

```json
{
  "$schema": "https://cleo.dev/schemas/v1/decomposition/output.schema.json",
  "_meta": {
    "command": "decompose",
    "version": "0.22.0",
    "timestamp": "2025-12-19T10:10:00Z",
    "decompositionId": "DEC-20251219-001",
    "inputHash": "sha256:abc123...",
    "phases": {
      "scope": "completed",
      "goals": "completed",
      "dag": "completed",
      "tasks": "completed"
    },
    "challenge": {
      "phases_challenged": 3,
      "total_findings": 2,
      "findings_addressed": 2,
      "final_verdict": "VALID"
    }
  },
  "success": true,
  "summary": {
    "inputRequest": "Implement user authentication with OAuth",
    "epicCount": 1,
    "taskCount": 3,
    "subtaskCount": 5,
    "totalTasks": 9,
    "maxDepth": 2,
    "parallelGroups": 3,
    "criticalPathLength": 4,
    "estimatedParallelism": 2.25
  },
  "tasks": [
    {
      "id": "T042",
      "title": "Create user schema",
      "status": "pending",
      "priority": "high",
      "type": "task",
      "parentId": "T041",
      "size": "small",
      "phase": "core",
      "files": ["src/db/schema/user.ts"],
      "acceptance": [
        "User table has id, email, passwordHash, createdAt fields",
        "Schema validates with Drizzle generate"
      ],
      "depends": [],
      "createdAt": "2025-12-19T10:10:00Z",
      "labels": ["decomposed", "decomposition:DEC-20251219-001"]
    }
  ],
  "dag": {
    "nodes": [...],
    "edges": [...],
    "parallelGroups": [...],
    "executionOrder": [...]
  },
  "hitlGates": []
}
```

---

## Part 9: CLI Integration

### 9.1 Command Syntax

```bash
cleo decompose <request> [OPTIONS]

# Examples
cleo decompose "Implement user authentication"
cleo decompose --file requirements.md
cleo decompose "Add dark mode" --phase ui --dry-run
```

### 9.2 Command Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `<request>` | string | required | Natural language request or structured input |
| `--file, -i` | path | - | Read request from file |
| `--phase` | string | current | Target phase for generated tasks |
| `--parent` | task ID | - | Parent task for all generated tasks |
| `--dry-run` | boolean | false | Preview without creating tasks |
| `--no-challenge` | boolean | false | Skip adversarial validation (NOT RECOMMENDED) |
| `--format, -f` | string | auto | Output format (json/text/markdown) |
| `--quiet, -q` | boolean | false | Suppress non-essential output |
| `--verbose, -v` | boolean | false | Show detailed phase outputs |

### 9.3 Exit Codes

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | `EXIT_SUCCESS` | Decomposition complete, tasks created |
| 2 | `EXIT_INVALID_INPUT` | Request empty or malformed |
| 6 | `EXIT_VALIDATION_ERROR` | Generated tasks fail schema validation |
| 10 | `EXIT_PARENT_NOT_FOUND` | Specified `--parent` doesn't exist |
| 11 | `EXIT_DEPTH_EXCEEDED` | Would exceed max hierarchy depth |
| 12 | `EXIT_SIBLING_LIMIT` | Would exceed max sibling count |
| 14 | `EXIT_CIRCULAR_REFERENCE` | DAG contains cycles |
| 30 | `EXIT_HITL_REQUIRED` | Decomposition blocked by ambiguity |
| 31 | `EXIT_CHALLENGE_REJECTED` | Challenge agent rejected decomposition |
| 102 | `EXIT_NO_CHANGE` | Request already decomposed (idempotent) |

### 9.4 Error Codes

| Code | Exit Code | Description |
|------|-----------|-------------|
| `E_DECOMPOSE_EMPTY_INPUT` | 2 | No request provided |
| `E_DECOMPOSE_AMBIGUOUS` | 30 | Request has unresolved ambiguities |
| `E_DECOMPOSE_CYCLE` | 14 | Generated DAG has cycles |
| `E_DECOMPOSE_REJECTED` | 31 | Challenge agent rejected decomposition |
| `E_DECOMPOSE_DEPTH` | 11 | Recursive decomposition exceeded depth |
| `E_DECOMPOSE_SIBLINGS` | 12 | Too many sibling tasks generated |

### 9.5 Script Implementation Pattern

```bash
#!/usr/bin/env bash
# scripts/decompose.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(dirname "$SCRIPT_DIR")/lib"

# Source required libraries (per LLM-AGENT-FIRST-SPEC Part 4)
source "${LIB_DIR}/exit-codes.sh"
source "${LIB_DIR}/error-json.sh"
source "${LIB_DIR}/output-format.sh"
source "${LIB_DIR}/decomposition.sh"  # NEW: Decomposition functions

COMMAND_NAME="decompose"
VERSION=$(cat "${SCRIPT_DIR}/../VERSION" | tr -d '[:space:]')

# Flag defaults
FORMAT=""
QUIET=false
VERBOSE=false
DRY_RUN=false
NO_CHALLENGE=false
PHASE=""
PARENT=""
INPUT_FILE=""

show_help() {
    cat << 'EOF'
Usage: cleo decompose <request> [OPTIONS]

Decompose a high-level request into atomic, executable tasks.

Arguments:
  <request>           Natural language description of work to decompose

Options:
  -i, --file FILE     Read request from file instead of argument
  --phase PHASE       Target phase for generated tasks
  --parent ID         Parent task ID for all generated tasks
  --dry-run           Preview decomposition without creating tasks
  --no-challenge      Skip adversarial validation (NOT RECOMMENDED)
  -f, --format FMT    Output format (json|text|markdown)
  -q, --quiet         Suppress non-essential output
  -v, --verbose       Show detailed phase outputs
  -h, --help          Show this help message

Exit Codes:
  0   Success - tasks created
  2   Invalid input
  6   Validation error
  14  Circular reference detected
  30  HITL required (ambiguities)
  31  Challenge rejected decomposition

Examples:
  cleo decompose "Add user authentication"
  cleo decompose --file requirements.md --phase core
  cleo decompose "Fix login bug" --dry-run --format json
EOF
}

# Argument parsing
parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -f|--format)   FORMAT="$2"; shift 2 ;;
            --json)        FORMAT="json"; shift ;;
            --human)       FORMAT="text"; shift ;;
            -q|--quiet)    QUIET=true; shift ;;
            -v|--verbose)  VERBOSE=true; shift ;;
            --dry-run)     DRY_RUN=true; shift ;;
            --no-challenge) NO_CHALLENGE=true; shift ;;
            --phase)       PHASE="$2"; shift 2 ;;
            --parent)      PARENT="$2"; shift 2 ;;
            -i|--file)     INPUT_FILE="$2"; shift 2 ;;
            -h|--help)     show_help; exit 0 ;;
            -*)            output_error "E_INPUT_INVALID" "Unknown option: $1" 2; exit 2 ;;
            *)             REQUEST="$1"; shift ;;
        esac
    done

    FORMAT=$(resolve_format "$FORMAT")
}

main() {
    parse_args "$@"

    # Get request
    if [[ -n "$INPUT_FILE" ]]; then
        [[ -f "$INPUT_FILE" ]] || { output_error "E_FILE_NOT_FOUND" "File not found: $INPUT_FILE" 4; exit 4; }
        REQUEST=$(cat "$INPUT_FILE")
    fi

    [[ -z "${REQUEST:-}" ]] && { output_error "E_DECOMPOSE_EMPTY_INPUT" "No request provided" 2; exit 2; }

    # Phase 1: Scope Analysis
    scope_result=$(analyze_scope "$REQUEST")

    if [[ $(echo "$scope_result" | jq -r '.hitlRequired') == "true" ]]; then
        output_hitl_gate "$scope_result"
        exit $EXIT_HITL_REQUIRED
    fi

    # Phase 2: Goal Decomposition
    goal_result=$(decompose_goals "$REQUEST" "$scope_result")

    if [[ "$NO_CHALLENGE" != "true" ]]; then
        challenge_result=$(challenge_decomposition "$goal_result" "goals")
        if [[ $(echo "$challenge_result" | jq -r '.verdict') == "REJECTED" ]]; then
            output_error "E_DECOMPOSE_REJECTED" "Challenge agent rejected decomposition" 31
            exit $EXIT_CHALLENGE_REJECTED
        fi
    fi

    # Phase 3: Dependency Graph
    dag_result=$(build_dependency_graph "$goal_result")

    if [[ $(echo "$dag_result" | jq -r '.hasCycle') == "true" ]]; then
        output_error "E_DECOMPOSE_CYCLE" "Circular dependency detected" 14
        exit $EXIT_CIRCULAR_REFERENCE
    fi

    if [[ "$NO_CHALLENGE" != "true" ]]; then
        challenge_result=$(challenge_decomposition "$dag_result" "dag")
    fi

    # Phase 4: Task Specification
    tasks_result=$(specify_tasks "$dag_result" "$PHASE" "$PARENT")

    if [[ "$NO_CHALLENGE" != "true" ]]; then
        challenge_result=$(challenge_decomposition "$tasks_result" "tasks")
    fi

    # Output or create
    if [[ "$DRY_RUN" == "true" ]]; then
        output_dry_run "$tasks_result"
    else
        created=$(create_tasks "$tasks_result")
        output_success "$created"
    fi

    exit $EXIT_SUCCESS
}

main "$@"
```

---

## Part 10: Library Functions

### 10.1 New Library: `lib/decomposition.sh`

```bash
#!/usr/bin/env bash
# lib/decomposition.sh - Task decomposition functions

# Analyze scope of a request
# Arguments: $1 = request text
# Returns: JSON ScopeAssessment
analyze_scope() {
    local request="$1"
    local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    # Entity extraction (simplified - full impl uses LLM)
    local file_count=$(echo "$request" | grep -oE '\b[a-z]+\.(ts|js|sh|py|json)\b' | wc -l)
    local component_count=$(echo "$request" | grep -oE '\b(component|service|controller|model|schema)\b' | wc -l)

    # Complexity assessment
    local complexity="low"
    [[ $file_count -gt 5 ]] && complexity="medium"
    [[ $file_count -gt 10 ]] && complexity="high"

    # Classification
    local classification="task"
    local requires_decomposition=false
    [[ $file_count -gt 10 || $component_count -gt 3 ]] && {
        classification="epic"
        requires_decomposition=true
    }
    [[ $file_count -le 2 && "$complexity" == "low" ]] && classification="subtask"

    # Generate output
    jq -n \
        --arg ts "$timestamp" \
        --arg req "$request" \
        --arg class "$classification" \
        --argjson decomp "$requires_decomposition" \
        --argjson files "$file_count" \
        --argjson comps "$component_count" \
        --arg complex "$complexity" \
        '{
            "_meta": {
                "phase": "scope-analysis",
                "timestamp": $ts
            },
            "input": {"request": $req},
            "assessment": {
                "classification": $class,
                "requiresDecomposition": $decomp,
                "complexity": {
                    "fileCount": $files,
                    "componentCount": $comps,
                    "reasoning": $complex
                },
                "hitlRequired": false,
                "ambiguities": []
            }
        }'
}

# Decompose goals into task tree
# Arguments: $1 = request, $2 = scope_result JSON
# Returns: JSON GoalTree
decompose_goals() {
    local request="$1"
    local scope="$2"

    # This would invoke LLM for actual decomposition
    # Simplified stub for spec
    echo "$scope" | jq '.goalTree = {"id": "G001", "title": "Root goal", "children": []}'
}

# Build dependency graph from goal tree
# Arguments: $1 = goal_result JSON
# Returns: JSON DAG
build_dependency_graph() {
    local goals="$1"

    # Extract nodes, compute edges, validate DAG
    # Simplified stub
    echo "$goals" | jq '. + {
        "dag": {
            "nodes": [],
            "edges": [],
            "hasCycle": false,
            "parallelGroups": [],
            "executionOrder": []
        }
    }'
}

# Challenge decomposition via adversarial agent
# Arguments: $1 = result JSON, $2 = phase name
# Returns: JSON ChallengeResult
challenge_decomposition() {
    local result="$1"
    local phase="$2"

    # Would spawn challenge agent per CONSENSUS-FRAMEWORK-SPEC
    # Simplified stub
    jq -n --arg phase "$phase" '{
        "phase": $phase,
        "verdict": "VALID",
        "findings": [],
        "timestamp": (now | todate)
    }'
}

# Convert DAG to schema-compliant tasks
# Arguments: $1 = dag_result JSON, $2 = phase, $3 = parent
# Returns: JSON Task[]
specify_tasks() {
    local dag="$1"
    local phase="${2:-}"
    local parent="${3:-null}"

    # Generate task objects from DAG nodes
    # Would apply id generation, field mapping, validation
    echo "$dag" | jq --arg phase "$phase" --arg parent "$parent" '. + {
        "tasks": []
    }'
}

# Create tasks in todo.json
# Arguments: $1 = tasks_result JSON
# Returns: JSON with created task IDs
create_tasks() {
    local tasks="$1"

    # Would call add-task.sh for each task
    # Returns summary of created tasks
    echo "$tasks" | jq '.created = true'
}
```

---

## Part 11: Agent Invocation Pattern

### 11.1 LLM Agent Prompt for Goal Decomposition

```markdown
You are a Goal Decomposition Agent. Your task is to break down a high-level request into atomic, executable subtasks.

## Input
Request: {request}
Scope Assessment: {scope_json}

## Constraints
1. Maximum depth: 3 levels (epic → task → subtask)
2. Maximum siblings: 7 per parent
3. Each leaf task MUST pass atomicity criteria:
   - Single file scope (≤3 files)
   - Single cognitive concern
   - Clear acceptance criteria
   - No hidden sub-decisions
   - No external wait requirements
   - Programmatically verifiable

## Output Format
Return JSON matching this schema:
{goal_tree_schema}

## Decomposition Methods
For "implement_feature": [schema, api, logic, ui, tests]
For "fix_bug": [reproduce, diagnose, fix, verify]
For "refactor_code": [analyze, plan, execute, verify]
For "add_command": [script, help, tests, docs]

## Task
Decompose the request into a goal tree. For each goal that is not atomic, recursively decompose until all leaves are atomic.
```

### 11.2 Challenge Agent Prompt

```markdown
You are a Challenge Agent (Red Team). Your role is to attack the decomposition and identify flaws.

## Input
Phase: {phase_name}
Decomposition: {decomposition_json}

## Your Mission
Find problems with this decomposition. You MUST challenge, not accept.

## Challenge Questions
1. Can any subtasks be merged without losing clarity?
2. Are there missing tasks required to achieve the goal?
3. Does each subtask have clear, distinct acceptance criteria?
4. Are dependencies real or assumed?
5. Can an LLM agent complete each task without HITL?

## Evidence Standard
For each finding, provide:
- Specific reference (task ID or edge)
- Logical counter-argument OR counter-example
- Suggested fix

## Output Format
{
  "verdict": "VALID" | "NEEDS_REVISION" | "REJECTED",
  "findings": [
    {
      "type": "missing_task" | "merge_possible" | "unclear_criteria" | "hallucinated_dependency" | "non_atomic",
      "reference": "task or edge ID",
      "argument": "why this is a problem",
      "suggestion": "how to fix"
    }
  ]
}

## Rules
- You MUST NOT rubber-stamp. Easy agreement is suspicious.
- If decomposition is good, explain WHY with evidence.
- Minimum 2 challenges per decomposition (even if minor).
```

---

## Part 12: HITL Gate Integration

### 12.1 Gate Triggers

Decomposition MUST trigger HITL when:

| Condition | Gate Type | Action |
|-----------|-----------|--------|
| Request has multiple interpretations | `ambiguity` | Present options, request choice |
| Scope exceeds single-session viability | `scope` | Confirm epic creation |
| External system dependencies detected | `external` | Confirm integration approach |
| >2 valid decomposition approaches | `method` | Present options with trade-offs |
| Challenge agent raises blocking issue | `challenge` | Present finding, request decision |

### 12.2 Gate Output Format

```json
{
  "$schema": "https://cleo.dev/schemas/v1/decomposition/hitl-gate.schema.json",
  "_meta": {
    "command": "decompose",
    "gateId": "HITL-DEC-001",
    "phase": "scope-analysis",
    "blocking": true
  },
  "gate": {
    "type": "ambiguity",
    "trigger": "Multiple OAuth providers possible",
    "context": "Request mentions 'OAuth' but doesn't specify providers"
  },
  "questions": [
    {
      "id": "Q1",
      "text": "Which OAuth providers should be supported?",
      "options": [
        {"id": "A", "label": "Google only", "implications": "Simpler, ~2 tasks"},
        {"id": "B", "label": "Google + GitHub", "implications": "Moderate, ~4 tasks"},
        {"id": "C", "label": "All major (Google, GitHub, Microsoft, Apple)", "implications": "Complex, ~8 tasks"}
      ]
    }
  ],
  "recommendation": {
    "option": "B",
    "rationale": "Covers most common use cases without excessive complexity"
  },
  "respondBy": "blocking"
}
```

---

## Part 13: Testing Requirements

### 13.1 Unit Tests

```bash
# tests/unit/test-decomposition.bats

@test "analyze_scope classifies small request as subtask" {
    result=$(analyze_scope "Fix typo in README")
    classification=$(echo "$result" | jq -r '.assessment.classification')
    [[ "$classification" == "subtask" ]]
}

@test "analyze_scope classifies large request as epic" {
    result=$(analyze_scope "Implement authentication with OAuth, password reset, 2FA, and session management")
    classification=$(echo "$result" | jq -r '.assessment.classification')
    [[ "$classification" == "epic" ]]
    decompose=$(echo "$result" | jq -r '.assessment.requiresDecomposition')
    [[ "$decompose" == "true" ]]
}

@test "decompose rejects request with cycles" {
    run cleo decompose "Task A depends on B, B depends on C, C depends on A"
    [[ "$status" -eq 14 ]]  # EXIT_CIRCULAR_REFERENCE
}

@test "decompose respects max depth" {
    result=$(cleo decompose "Deeply nested task" --format json 2>&1)
    max_depth=$(echo "$result" | jq -r '.summary.maxDepth')
    [[ "$max_depth" -le 3 ]]
}

@test "decompose respects max siblings" {
    result=$(cleo decompose "Task with many subtasks" --format json 2>&1)
    # Check no parent has >7 children
    over_limit=$(echo "$result" | jq '[.tasks[] | select(.parentId != null)] | group_by(.parentId) | map(length) | max')
    [[ "$over_limit" -le 7 ]]
}
```

### 13.2 Integration Tests

```bash
# tests/integration/decomposition.bats

@test "decompose creates valid tasks" {
    # Decompose
    result=$(cleo decompose "Add email validation" --format json)
    [[ $(echo "$result" | jq -r '.success') == "true" ]]

    # Verify tasks exist
    task_id=$(echo "$result" | jq -r '.tasks[0].id')
    cleo exists "$task_id" --quiet
    [[ $? -eq 0 ]]
}

@test "decompose dry-run creates no tasks" {
    count_before=$(cleo list --format json | jq '.tasks | length')
    cleo decompose "Add feature X" --dry-run
    count_after=$(cleo list --format json | jq '.tasks | length')
    [[ "$count_before" -eq "$count_after" ]]
}

@test "decompose with parent sets parentId" {
    # Create parent
    parent=$(cleo add "Parent epic" --type epic --format json | jq -r '.task.id')

    # Decompose under parent
    result=$(cleo decompose "Subtask work" --parent "$parent" --format json)

    # Verify parentId
    child_parent=$(echo "$result" | jq -r '.tasks[0].parentId')
    [[ "$child_parent" == "$parent" ]]
}
```

### 13.3 Challenge Tests

```bash
@test "challenge agent rejects non-atomic tasks" {
    # Force a task with low atomicity
    result=$(decompose_goals "Build entire application" "{}")
    challenge=$(challenge_decomposition "$result" "goals")

    # Should have findings
    finding_count=$(echo "$challenge" | jq '.findings | length')
    [[ "$finding_count" -gt 0 ]]
}

@test "challenge agent flags hallucinated dependencies" {
    # Create DAG with suspicious edge
    dag='{"edges":[{"from":"T001","to":"T002","evidence":"assumed"}]}'
    challenge=$(challenge_decomposition "$dag" "dag")

    # Should flag the edge
    echo "$challenge" | jq -e '.findings[] | select(.type == "hallucinated_dependency")'
}
```

---

## Part 14: Performance Requirements

### 14.1 Latency Targets

| Phase | Target | Max |
|-------|--------|-----|
| Scope Analysis | <500ms | 2s |
| Goal Decomposition | <5s | 30s |
| Dependency Graph | <1s | 5s |
| Task Specification | <500ms | 2s |
| Challenge (per phase) | <10s | 60s |
| **Total (with challenge)** | <20s | 120s |

### 14.2 Scaling Limits

| Metric | Limit | Reason |
|--------|-------|--------|
| Tasks per decomposition | 50 | Context window preservation |
| Depth | 3 | Per TASK-HIERARCHY-SPEC |
| Siblings | 7 | Per TASK-HIERARCHY-SPEC |
| Parallel DAG width | 10 | Practical execution limit |
| Request length | 10,000 chars | Prompt size management |

---

## Part 15: Security Considerations

### 15.1 Input Validation

- Request text MUST be sanitized before LLM prompts
- File paths in `--file` MUST be validated (no path traversal)
- Parent IDs MUST be validated against existing tasks

### 15.2 Output Integrity

- Generated task IDs MUST use sequential allocation (no user input)
- Decomposition results SHOULD be checksummed
- Challenge results MUST NOT be editable by decomposition agent

### 15.3 Prompt Injection Prevention

- User request MUST be isolated in prompt (not interpolated)
- JSON outputs MUST be validated before use
- LLM outputs MUST NOT be executed as code without sandboxing

---

## Part 16: Conformance

### 16.1 Conformance Classes

A conforming implementation MUST:
- Implement all 4 phases (scope, goals, dag, tasks)
- Apply atomicity criteria per Part 4
- Validate DAG for cycles before output
- Produce JSON matching output schemas
- Support all exit codes defined in Part 9.3
- Source required libraries per LLM-AGENT-FIRST-SPEC

A conforming implementation SHOULD:
- Implement challenge protocol per Part 6.4, 7.4, 8.4
- Support HITL gates per Part 12
- Meet latency targets per Part 14.1

A conforming implementation MAY:
- Use alternative decomposition methods beyond Part 6.2
- Extend atomicity criteria beyond Part 4.1
- Add additional output fields to schemas

---

## Part 17: Related Specifications

| Document | Relationship |
|----------|--------------|
| **[SPEC-BIBLE-GUIDELINES.md](SPEC-BIBLE-GUIDELINES.md)** | **AUTHORITATIVE** for document structure |
| **[LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md)** | **AUTHORITATIVE** for JSON output, exit codes, error handling |
| **[HIERARCHY-ENHANCEMENT-SPEC.md](HIERARCHY-ENHANCEMENT-SPEC.md)** | **AUTHORITATIVE** for type/parentId/size, depth/sibling limits |
| **[LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md)** | **AUTHORITATIVE** for task ID format |
| **[CONSENSUS-FRAMEWORK-SPEC.md](CONSENSUS-FRAMEWORK-SPEC.md)** | **AUTHORITATIVE** for challenge protocol, evidence standards |
| **[PHASE-SYSTEM-SPEC.md](PHASE-SYSTEM-SPEC.md)** | Related for phase assignment |
| **[RCSD-PIPELINE-SPEC.md](RCSD-PIPELINE-SPEC.md)** | **Stage**: This spec implements the DECOMPOSE stage of the RCSD Pipeline (Part 4) |

---

## Part 18: LLM Invocation Architecture (AUTHORITATIVE)

This section addresses **Finding 5** (BLOCKING): LLM invocation pattern unclear.

### 18.1 Token Budget Allocation

| Phase | Max Input Tokens | Max Output Tokens | Model Tier |
|-------|------------------|-------------------|------------|
| Scope Analysis | 2,000 | 1,000 | Fast (Haiku) |
| Goal Decomposition | 8,000 | 4,000 | Standard (Sonnet) |
| Dependency Graph | 4,000 | 2,000 | Fast (Haiku) |
| Task Specification | 4,000 | 3,000 | Fast (Haiku) |
| Challenge (per phase) | 6,000 | 2,000 | Standard (Sonnet) |

### 18.2 Invocation Decision Matrix

```
FUNCTION should_invoke_llm(phase: string, input: any) -> boolean:

    # Local-only phases (no LLM needed)
    IF phase == "scope" AND input.complexity.simple:
        RETURN false  # Use heuristic classification

    IF phase == "dag" AND input.explicit_dependencies_only:
        RETURN false  # Parse explicit keywords only

    # Always invoke LLM for
    IF phase == "goals":
        RETURN true  # Decomposition requires reasoning

    IF phase == "challenge":
        RETURN true  # Adversarial requires different model

    # Hybrid decision
    IF phase == "tasks":
        RETURN input.requires_description_generation
```

### 18.3 Prompt Template Architecture

```
PROMPT_STRUCTURE = {
    "system": {
        "role": "Decomposition Agent | Challenge Agent",
        "constraints": [atomicity_rules, depth_limits, sibling_limits],
        "output_schema": phase_specific_schema
    },
    "user": {
        "input": request_or_previous_phase_output,
        "context": {
            "existing_tasks": optional_dedup_context,
            "project_phase": current_phase
        }
    }
}
```

### 18.4 Model Selection Logic

```bash
# lib/llm-invoke.sh

select_model() {
    local phase="$1"
    local complexity="${2:-medium}"

    case "$phase" in
        scope|dag|tasks)
            echo "haiku"  # Fast, low-cost for structured extraction
            ;;
        goals)
            if [[ "$complexity" == "high" ]]; then
                echo "sonnet"  # Complex reasoning
            else
                echo "haiku"
            fi
            ;;
        challenge)
            echo "sonnet"  # Always use capable model for adversarial
            ;;
        *)
            echo "haiku"
            ;;
    esac
}
```

### 18.5 Fallback Strategy

If LLM invocation fails:

| Failure Type | Fallback Action |
|--------------|-----------------|
| Rate limit | Exponential backoff (1s, 2s, 4s, max 30s) |
| Timeout | Return partial result with `incomplete: true` |
| Invalid output | Retry once with stricter schema enforcement |
| Model unavailable | Fall back to simpler model tier |

---

## Part 19: Dependency Detection Algorithms (AUTHORITATIVE)

This section addresses **Finding 3** (BLOCKING): Dependency detection underspecified.

### 19.1 Detection Functions

```
FUNCTION detect_explicit_dependency(task_a, task_b) -> Dependency | null:
    # Keywords in task_a that reference task_b
    keywords = ["after", "requires", "depends on", "following", "once"]

    FOR keyword IN keywords:
        IF task_a.description CONTAINS keyword + task_b.identifier:
            RETURN Dependency {
                type: "explicit",
                evidence: f"Keyword '{keyword}' references {task_b.id}",
                confidence: 1.0
            }

    RETURN null


FUNCTION detect_data_flow_dependency(task_a, task_b) -> Dependency | null:
    # Schema/type analysis
    outputs_a = extract_outputs(task_a)  # Files created, APIs exposed
    inputs_b = extract_inputs(task_b)    # Files read, APIs called

    overlap = outputs_a INTERSECT inputs_b

    IF overlap.length > 0:
        RETURN Dependency {
            type: "data_flow",
            evidence: f"Output {overlap[0]} from {task_a.id} consumed by {task_b.id}",
            confidence: 0.9,
            artifacts: overlap
        }

    RETURN null


FUNCTION detect_file_conflict_dependency(task_a, task_b) -> Dependency | null:
    # Both tasks modify same file
    files_a = task_a.files or []
    files_b = task_b.files or []

    conflicts = files_a INTERSECT files_b

    IF conflicts.length > 0:
        # Need ordering to avoid merge conflicts
        RETURN Dependency {
            type: "file_conflict",
            evidence: f"Both modify {conflicts[0]}",
            confidence: 0.85,
            files: conflicts,
            resolution: "serialize_execution"
        }

    RETURN null


FUNCTION detect_semantic_dependency(task_a, task_b) -> Dependency | null:
    # Domain knowledge patterns
    semantic_rules = [
        ("schema", "query"),      # Schema before queries
        ("model", "migration"),   # Model before migration
        ("interface", "impl"),    # Interface before implementation
        ("test", "implement"),    # Implementation before tests (inverted)
    ]

    FOR (before_pattern, after_pattern) IN semantic_rules:
        IF task_a.title MATCHES before_pattern AND task_b.title MATCHES after_pattern:
            RETURN Dependency {
                type: "semantic",
                evidence: f"Domain rule: {before_pattern} → {after_pattern}",
                confidence: 0.75,
                rule: f"{before_pattern}_before_{after_pattern}"
            }

    RETURN null
```

### 19.2 Confidence Thresholds

| Confidence | Action |
|------------|--------|
| ≥0.9 | Auto-include dependency |
| 0.7-0.89 | Include, flag for challenge review |
| 0.5-0.69 | Require HITL confirmation |
| <0.5 | Reject, log as "considered but excluded" |

### 19.3 Transitive Dependency Resolution

```
FUNCTION compute_transitive_closure(dag: DAG) -> DAG:
    # Floyd-Warshall for reachability
    reachable = initialize_matrix(dag.nodes.length)

    FOR edge IN dag.edges:
        reachable[edge.from][edge.to] = true

    FOR k IN dag.nodes:
        FOR i IN dag.nodes:
            FOR j IN dag.nodes:
                IF reachable[i][k] AND reachable[k][j]:
                    reachable[i][j] = true

    # Remove redundant edges (A→B when A→C→B exists)
    optimized_edges = []
    FOR edge IN dag.edges:
        is_redundant = false
        FOR intermediate IN dag.nodes:
            IF intermediate != edge.from AND intermediate != edge.to:
                IF reachable[edge.from][intermediate] AND reachable[intermediate][edge.to]:
                    is_redundant = true
                    BREAK

        IF NOT is_redundant:
            optimized_edges.append(edge)

    dag.edges = optimized_edges
    RETURN dag
```

### 19.4 Anti-Hallucination Validation

Every dependency MUST have:
1. **Type** from defined set: `explicit | data_flow | file_conflict | api_contract | semantic`
2. **Evidence** string explaining the relationship
3. **Confidence** score 0.0-1.0

Dependencies with `evidence: null` or `evidence: "assumed"` MUST be rejected.

---

## Part 20: Generic Decomposition Fallback (AUTHORITATIVE)

This section addresses **Finding 2**: Generic decomposition method undefined.

### 20.1 Fallback Method

When no pattern-specific method matches:

```yaml
method: generic_decomposition
pattern: ".*"  # Fallback, lowest priority
phases:
  1_understand:
    template: "Understand requirements for {goal}"
    type: subtask
    atomicity_target: 100
  2_plan:
    template: "Plan approach for {goal}"
    type: subtask
    atomicity_target: 100
  3_implement:
    template: "Implement {goal}"
    type: task
    atomicity_target: 80  # May need further decomposition
  4_validate:
    template: "Validate {goal} meets requirements"
    type: subtask
    atomicity_target: 100
```

### 20.2 Recursive Application

If `3_implement` fails atomicity (score < 100), recursively apply:

```
FUNCTION apply_generic_fallback(goal: Goal, depth: int) -> TaskTree:

    IF depth >= 3:
        WARN("Max depth reached, accepting non-atomic")
        RETURN create_task(goal, atomic=false)

    result = apply_method("generic_decomposition", goal)

    FOR subtask IN result.children:
        IF subtask.atomicity_score < 100:
            subtask.children = apply_generic_fallback(subtask, depth + 1)

    RETURN result
```

### 20.3 Method Priority Order

1. Exact pattern match (e.g., `implement_feature`)
2. Partial pattern match (regex similarity > 0.8)
3. LLM-suggested method (if enabled)
4. Generic fallback

---

## Part 21: Challenge Quality Metrics (AUTHORITATIVE)

This section addresses **Finding 4**: Challenge agent quality metrics missing.

### 21.1 Finding Severity Classification

| Severity | Criteria | Required Action |
|----------|----------|-----------------|
| **blocking** | Decomposition fundamentally broken | REJECT, require restart |
| **major** | Missing/incorrect tasks or dependencies | REVISE before proceeding |
| **minor** | Style, naming, or optimization issues | LOG, optional fix |
| **info** | Suggestions for improvement | DOCUMENT for future |

### 21.2 Challenge Quality Scoring

```
challenge_quality_score = {
    specificity: findings.all(f => f.reference != null),      # 0-1
    evidence: findings.all(f => f.argument.length > 50),      # 0-1
    actionable: findings.all(f => f.suggestion != null),      # 0-1
    coverage: unique_tasks_challenged / total_tasks           # 0-1
}

overall_quality = average(challenge_quality_score.values())

IF overall_quality < 0.6:
    WARN("Challenge quality below threshold, may need re-challenge")
```

### 21.3 Rubber-Stamp Detection

Challenge agent outputs are suspect if:
- `verdict: "VALID"` with `findings.length == 0`
- All findings are `severity: "info"`
- Challenge completed in <2 seconds
- No specific task/edge references

```
FUNCTION detect_rubber_stamp(challenge_result) -> boolean:
    IF challenge_result.verdict == "VALID" AND challenge_result.findings.length == 0:
        RETURN true

    IF all(f.severity == "info" FOR f IN challenge_result.findings):
        RETURN true

    IF challenge_result.duration_ms < 2000:
        RETURN true

    RETURN false


IF detect_rubber_stamp(challenge_result):
    LOG_WARNING("Potential rubber-stamp detected, requesting re-challenge")
    challenge_result = re_challenge_with_stricter_prompt()
```

### 21.4 Minimum Challenge Requirements

Every challenge MUST produce at least:
- 2 findings (even if `severity: info`)
- 1 specific reference to task or edge
- 1 actionable suggestion

---

## Part 22: Iteration and Retry Protocol (AUTHORITATIVE)

This section addresses **Finding 6**: No iteration/retry protocol.

### 22.1 Retry Configuration

```yaml
retry_config:
  max_retries_per_phase: 3
  max_total_retries: 10
  backoff:
    initial_delay_ms: 1000
    max_delay_ms: 30000
    multiplier: 2.0
  circuit_breaker:
    failure_threshold: 5
    reset_timeout_ms: 60000
```

### 22.2 Phase Retry Logic

```
FUNCTION execute_phase_with_retry(phase, input) -> Result:
    retries = 0

    WHILE retries < config.max_retries_per_phase:
        TRY:
            result = execute_phase(phase, input)

            IF result.success:
                RETURN result

            IF result.error.retryable == false:
                RETURN result  # Permanent failure

            retries += 1
            delay = calculate_backoff(retries)
            sleep(delay)

        CATCH error:
            IF is_transient(error):
                retries += 1
                continue
            ELSE:
                RETURN Error(error)

    RETURN Error("Max retries exceeded for phase: {phase}")
```

### 22.3 Challenge-Revision Loop

```
FUNCTION decomposition_with_challenge_loop(request) -> Result:
    max_iterations = 3
    iteration = 0

    scope = analyze_scope(request)
    goals = decompose_goals(request, scope)

    WHILE iteration < max_iterations:
        challenge = challenge_decomposition(goals, "goals")

        IF challenge.verdict == "VALID":
            BREAK

        IF challenge.verdict == "REJECTED":
            # Fundamental flaw, restart with new approach
            goals = decompose_goals(request, scope, approach="alternative")
            iteration += 1
            continue

        IF challenge.verdict == "NEEDS_REVISION":
            # Apply suggested fixes
            FOR finding IN challenge.findings WHERE finding.severity IN ["blocking", "major"]:
                goals = apply_fix(goals, finding)

            iteration += 1

    IF iteration >= max_iterations:
        RETURN Error("Could not produce valid decomposition after {max_iterations} iterations")

    RETURN goals
```

### 22.4 State Preservation

Between retries, preserve:
- Original request (immutable)
- Phase outputs completed successfully
- Challenge findings for learning
- Retry count per phase

```json
{
  "_retry_state": {
    "request_hash": "sha256:abc...",
    "completed_phases": ["scope"],
    "current_phase": "goals",
    "attempt": 2,
    "previous_findings": [...]
  }
}
```

---

## Part 23: Schema Extensions (AUTHORITATIVE)

This section addresses **Finding**: Schema considerations for children and computed fields.

### 23.1 Proposed Schema Additions

The following fields SHOULD be added to `todo.schema.json` v2.4.0:

```json
{
  "children": {
    "type": "array",
    "items": { "type": "string", "pattern": "^T\\d{3,}$" },
    "description": "Computed: IDs of direct child tasks (inverse of parentId)",
    "computed": true
  },
  "ancestors": {
    "type": "array",
    "items": { "type": "string", "pattern": "^T\\d{3,}$" },
    "description": "Computed: IDs of all ancestor tasks (transitive parentId)",
    "computed": true
  },
  "depth": {
    "type": "integer",
    "minimum": 0,
    "maximum": 2,
    "description": "Computed: Hierarchy depth (0=root, 1=child, 2=grandchild)",
    "computed": true
  },
  "dependents": {
    "type": "array",
    "items": { "type": "string", "pattern": "^T\\d{3,}$" },
    "description": "Computed: IDs of tasks that depend on this task (inverse of depends)",
    "computed": true
  },
  "blockedBy": {
    "type": "array",
    "items": { "type": "string", "pattern": "^T\\d{3,}$" },
    "description": "Computed: IDs of incomplete dependencies blocking this task",
    "computed": true
  },
  "decompositionId": {
    "type": "string",
    "pattern": "^DEC-\\d{8}-\\d{3}$",
    "description": "ID of decomposition session that created this task"
  },
  "atomicityScore": {
    "type": "integer",
    "minimum": 0,
    "maximum": 100,
    "description": "Atomicity score at creation (see Part 4)"
  },
  "acceptance": {
    "type": "array",
    "items": { "type": "string" },
    "description": "Testable acceptance criteria"
  }
}
```

### 23.2 Computed Field Calculation

Computed fields are NOT stored in todo.json but calculated on read:

```bash
# lib/computed-fields.sh

compute_children() {
    local task_id="$1"
    local todo_file="$2"

    jq -r --arg id "$task_id" \
        '.tasks[] | select(.parentId == $id) | .id' \
        "$todo_file" | jq -Rs 'split("\n") | map(select(. != ""))'
}

compute_depth() {
    local task_id="$1"
    local todo_file="$2"

    local depth=0
    local current="$task_id"

    while true; do
        parent=$(jq -r --arg id "$current" '.tasks[] | select(.id == $id) | .parentId // empty' "$todo_file")
        [[ -z "$parent" ]] && break
        ((depth++))
        current="$parent"
    done

    echo "$depth"
}

compute_blocked_by() {
    local task_id="$1"
    local todo_file="$2"

    jq -r --arg id "$task_id" '
        (.tasks[] | select(.id == $id) | .depends // []) as $deps |
        .tasks[] | select(.id as $tid | $deps | index($tid)) |
        select(.status != "done") | .id
    ' "$todo_file" | jq -Rs 'split("\n") | map(select(. != ""))'
}
```

### 23.3 Materialization Strategy

For performance, computed fields MAY be materialized:
- **On write**: Update `children`/`dependents` when `parentId`/`depends` changes
- **On read**: Always compute `blockedBy` (status-dependent)
- **Cache**: Store in separate `.cleo/computed-cache.json` with TTL

### 23.4 Backward Compatibility

New fields MUST be:
- Optional in schema (not `required`)
- Handled gracefully by older CLI versions
- Migrated via `cleo migrate run`

---

## Appendix A: Decomposition Method Library

### A.1 Feature Implementation

```yaml
method: feature_decomposition
pattern: "implement.*feature|add.*functionality|create.*system"
subtasks:
  - name: schema
    template: "Define data schema for {feature}"
    type: task
    dependencies: []
  - name: api
    template: "Implement API endpoints for {feature}"
    type: task
    dependencies: [schema]
  - name: logic
    template: "Implement business logic for {feature}"
    type: task
    dependencies: [schema]
  - name: ui
    template: "Create UI components for {feature}"
    type: task
    dependencies: [api, logic]
  - name: tests
    template: "Write tests for {feature}"
    type: task
    dependencies: [api, logic, ui]
```

### A.2 Bug Fix

```yaml
method: bug_fix_decomposition
pattern: "fix.*bug|resolve.*issue|correct.*error"
subtasks:
  - name: reproduce
    template: "Create reproduction case for {bug}"
    type: subtask
    dependencies: []
  - name: diagnose
    template: "Identify root cause of {bug}"
    type: subtask
    dependencies: [reproduce]
  - name: fix
    template: "Implement fix for {bug}"
    type: subtask
    dependencies: [diagnose]
  - name: verify
    template: "Verify fix and add regression test for {bug}"
    type: subtask
    dependencies: [fix]
```

### A.3 CLI Command

```yaml
method: cli_command_decomposition
pattern: "add.*command|create.*command|implement.*cli"
subtasks:
  - name: script
    template: "Create {command} script"
    type: task
    dependencies: []
  - name: help
    template: "Add help text for {command}"
    type: subtask
    dependencies: [script]
  - name: tests
    template: "Write tests for {command}"
    type: task
    dependencies: [script]
  - name: docs
    template: "Document {command} in docs/commands/"
    type: subtask
    dependencies: [script]
```

---

## Appendix B: Changelog

### Version 1.0.0 (2025-12-19)
- Initial specification
- 4-phase decomposition pipeline
- Atomicity criteria (6-point test)
- HTN-inspired goal decomposition
- DAG construction with cycle detection
- Challenge protocol integration
- CLI command specification
- Library function definitions
- Test requirements
- Performance targets

---

*End of Specification*
