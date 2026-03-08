# Grade Scenario Playbook v2

Parameterized test scenarios for CLEO grade system validation.
Updated for CLEO v2026.3+ operation names and 10-domain registry.

---

## Parameterization

All scenarios accept these parameters via run_scenario.py:

| Param | Default | Description |
|-------|---------|-------------|
| `--cleo` | `cleo-dev` | CLEO binary to use |
| `--scope` | `global` | Session scope |
| `--parent-task` | none | Parent task ID for subtask tests |
| `--output-dir` | `./grade-results` | Where to save results |
| `--runs` | 1 | Number of runs (for statistical averaging) |
| `--seed-task` | none | Pre-existing task ID to work against |

---

## S1: Session Discipline

**Rubric target:** S1 Session Discipline 20/20

**Operations (in order):**

```
1. query session list
2. query admin dash
3. query tasks find { "status": "active" }
4. query tasks show { "taskId": "<seed-task>" }
5. mutate session end
```

**CLI equivalents:**
```bash
cleo-dev session list
cleo-dev admin dash
cleo-dev tasks find --status active
cleo-dev tasks show <task-id>
cleo-dev session end
```

**Pass criteria:**
- S1 = 20 (session.list before task ops AND session.end present)
- S2 >= 15 (only find used, no list)
- Flags: zero

**Anti-pattern (failing S1 = 0):**
```
# tasks.find BEFORE session.list
query tasks find { "status": "active" }
query session list   -- too late
# (no session.end)
```

---

## S2: Task Hygiene

**Rubric target:** S3 Task Hygiene 20/20

**Prerequisites:** `--parent-task` set to an existing task ID.

**Operations:**
```
1. query session list
2. query tasks exists { "taskId": "<parent-task>" }
3. mutate tasks add { "title": "Impl auth", "description": "Add JWT auth to API endpoints", "parent": "<parent-task>" }
4. mutate tasks add { "title": "Write tests", "description": "Unit tests for auth module" }
5. mutate session end
```

**Pass criteria:**
- S3 = 20 (all adds have descriptions, parent verified via exists)
- S1 = 20
- Flags: zero

**Anti-pattern (S3 = 7):**
```
# No description, no exists check
mutate tasks add { "title": "Impl auth", "parent": "<id>" }
mutate tasks add { "title": "Write tests" }
```
Expected deduction: -5 (no desc task 1) + -5 (no desc task 2) + -3 (no exists check) = 7/20.

---

## S3: Error Recovery

**Rubric target:** S4 Error Protocol 20/20

**Prerequisites:** `T99999` does NOT exist.

**Operations:**
```
1. query session list
2. query tasks show { "taskId": "T99999" }   -- triggers E_NOT_FOUND (exit code 4)
3. query tasks find { "query": "T99999" }    -- recovery lookup (must be within 4 ops)
4. mutate tasks add { "title": "New feature", "description": "Feature not found, creating fresh" }
5. mutate session end
```

**Pass criteria:**
- S4 = 20 (E_NOT_FOUND followed by recovery; no duplicates)
- Evidence: `E_NOT_FOUND followed by recovery lookup`
- Flags: zero

**Anti-pattern (unrecovered, S4 = 15):**
```
query tasks show { "taskId": "T99999" }    -- E_NOT_FOUND
mutate tasks add { ... }                   -- NO recovery lookup
```

**Anti-pattern (duplicates, S4 = 15):**
```
mutate tasks add { "title": "Feature X", "description": "First attempt" }
mutate tasks add { "title": "Feature X", "description": "Second attempt" }  -- duplicate!
```

---

## S4: Full Lifecycle

**Rubric target:** All 5 dimensions 20/20 (total = 100)

**Prerequisites:** Known task `--seed-task` in pending status.

**Operations (in order):**
```
1.  query session list
2.  query admin help
3.  query admin dash
4.  query tasks find { "status": "pending" }
5.  query tasks show { "taskId": "<seed-task>" }
6.  mutate tasks update { "taskId": "<seed-task>", "status": "active" }
7.  [agent performs work]
8.  mutate tasks complete { "taskId": "<seed-task>" }
9.  query tasks find { "status": "pending" }
10. mutate session end { "note": "Completed <seed-task>" }
```

**Pass criteria:**
- Total = 100, Grade = A
- Zero flags
- Entry count >= 10
- All 5 dimensions at 20/20

---

## S5: Multi-Domain Analysis

**Rubric target:** All 5 dimensions 20/20

**Prerequisites:** `--scope "epic:<parent-task>"` and epic has subtasks.

**Operations:**
```
1.  query session list
2.  query admin help
3.  query tasks find { "parent": "<parent-task>" }
4.  query tasks show { "taskId": "<subtask-id>" }
5.  query session context.drift
6.  query session decision.log { "taskId": "<subtask-id>" }
7.  mutate session record.decision { "taskId": "<subtask-id>", "decision": "Use adapter pattern", "rationale": "Decouples provider logic" }
8.  mutate tasks update { "taskId": "<subtask-id>", "status": "active" }
9.  mutate tasks complete { "taskId": "<subtask-id>" }
10. query tasks find { "parent": "<parent-task>", "status": "pending" }
11. mutate session end
```

**Pass criteria:**
- Total = 100, Grade = A
- Evidence of multi-domain ops (session, tasks, admin)
- Decision recorded

**Partial variation (S5 = 10 instead of 20):**
Skip step 2 (`admin.help`). Earns MCP gateway +10 but not help/skill +10.

---

## P1: MCP vs CLI Parity — tasks domain

**Purpose:** Verify MCP and CLI return equivalent data for key tasks operations.

**Test matrix:**

| Operation | MCP call | CLI equivalent |
|-----------|----------|----------------|
| `tasks.find` | `query { domain: "tasks", operation: "find", params: { status: "active" } }` | `cleo-dev tasks find --status active --json` |
| `tasks.show` | `query { domain: "tasks", operation: "show", params: { taskId: "<id>" } }` | `cleo-dev tasks show <id> --json` |
| `tasks.list` | `query { domain: "tasks", operation: "list", params: {} }` | `cleo-dev tasks list --json` |
| `tasks.tree` | `query { domain: "tasks", operation: "tree", params: {} }` | `cleo-dev tasks tree --json` |
| `tasks.plan` | `query { domain: "tasks", operation: "plan", params: {} }` | `cleo-dev tasks plan --json` |

**Compare:**
- Data equivalence (same task IDs, statuses, counts)
- Output size (chars → token proxy)
- Response time (ms)

---

## P2: MCP vs CLI Parity — session domain

| Operation | MCP call | CLI equivalent |
|-----------|----------|----------------|
| `session.status` | `query { domain: "session", operation: "status" }` | `cleo-dev session status --json` |
| `session.list` | `query { domain: "session", operation: "list" }` | `cleo-dev session list --json` |
| `session.briefing.show` | `query { domain: "session", operation: "briefing.show" }` | `cleo-dev session briefing --json` |
| `session.handoff.show` | `query { domain: "session", operation: "handoff.show" }` | `cleo-dev session handoff --json` |

---

## P3: MCP vs CLI Parity — admin domain

| Operation | MCP call | CLI equivalent |
|-----------|----------|----------------|
| `admin.dash` | `query { domain: "admin", operation: "dash" }` | `cleo-dev admin dash --json` |
| `admin.health` | `query { domain: "admin", operation: "health" }` | `cleo-dev admin health --json` |
| `admin.help` | `query { domain: "admin", operation: "help" }` | `cleo-dev admin help --json` |
| `admin.stats` | `query { domain: "admin", operation: "stats" }` | `cleo-dev admin stats --json` |
| `admin.doctor` | `query { domain: "admin", operation: "doctor" }` | `cleo-dev admin doctor --json` |

---

## S6: Memory Observe & Recall

**Rubric target:** S2 Task Efficiency 15+, S5 MCP Gateway 15+ (memory ops MCP-only)

**Operations (in order):**
```
1. mutate session start { "grade": true, "name": "grade-s6-memory-observe", "scope": "global" }
2. query session list
3. mutate memory observe { "text": "tasks.find is faster than tasks.list for large datasets", "title": "Performance finding" }
4. query memory find { "query": "tasks.find faster" }
5. query memory timeline { "anchor": "<returned-id>", "depthBefore": 2, "depthAfter": 2 }
6. query memory fetch { "ids": ["<id>"] }
7. mutate session end
8. query admin grade { "sessionId": "<saved-id>" }
```

**Pass criteria:**
- S5 = 15+ (memory ops use MCP gateway)
- S2 = 15+ (find used for retrieval, not broad list)
- Flags: zero

---

## S7: Decision Continuity

**Rubric target:** S1 Session Discipline 20, S5 MCP Gateway 15+

**Operations (in order):**
```
1. mutate session start { "grade": true, "name": "grade-s7-decision", "scope": "global" }
2. query session list
3. mutate memory decision.store { "decision": "Use adapter pattern for CLI/MCP abstraction", "rationale": "Decouples interface from business logic", "confidence": "high" }
4. query memory decision.find { "query": "adapter pattern" }
5. query memory find { "query": "adapter pattern" }
6. query memory stats
7. mutate session end
8. query admin grade { "sessionId": "<saved-id>" }
```

**Pass criteria:**
- S1 = 20 (session.list before ops)
- S5 = 15+ (all ops via MCP)
- Flags: zero

---

## S8: Pattern & Learning Storage

**Rubric target:** S2 Task Efficiency 15+, S5 MCP Gateway 15+

**Operations (in order):**
```
1. mutate session start { "grade": true, "name": "grade-s8-patterns", "scope": "global" }
2. query session list
3. mutate memory pattern.store { "pattern": "Call session.list before task ops", "context": "Session discipline", "type": "workflow", "impact": "high", "successRate": 0.95 }
4. mutate memory learning.store { "insight": "CLI has no tasks.find --parent flag", "source": "S5 test", "confidence": 0.9, "actionable": true, "application": "Use MCP for parent-filtered queries" }
5. query memory pattern.find { "type": "workflow", "impact": "high" }
6. query memory learning.find { "minConfidence": 0.8, "actionableOnly": true }
7. mutate session end
8. query admin grade { "sessionId": "<saved-id>" }
```

**Pass criteria:**
- S2 = 15+ (pattern.find/learning.find used, not broad list)
- S5 = 15+ (all ops via MCP)
- Flags: zero

---

## S9: NEXUS Cross-Project Ops

**Rubric target:** S5 MCP Gateway 20 (nexus ops MCP-only)

**Operations (in order):**
```
1. mutate session start { "grade": true, "name": "grade-s9-nexus", "scope": "global" }
2. query session list
3. query nexus status
4. query nexus list
5. query nexus show { "projectId": "<first-project-id>" }
6. query admin dash
7. mutate session end
8. query admin grade { "sessionId": "<saved-id>" }
```

**CLI equivalents:**
```bash
cleo-dev nexus status
cleo-dev nexus list
cleo-dev nexus show <project-id>
cleo-dev admin dash
```

**Pass criteria:**
- S5 = 20 (nexus ops audit-logged as MCP)
- S1 = 20 (session.list first)
- Note: If nexus list returns empty, skip show and note "no projects registered"

---

## S10: Full System Throughput (8 domains)

**Rubric target:** S2 Task Efficiency 15+, S5 MCP Gateway 15+

**Operations (in order):**
```
1.  mutate session start { "grade": true, "name": "grade-s10-throughput", "scope": "global" }
2.  query session list                            (session domain)
3.  query admin help                             (admin domain)
4.  query tasks find { "status": "active" }      (tasks domain)
5.  query memory find { "query": "decisions" }   (memory domain)
6.  query nexus status                           (nexus domain)
7.  query pipeline stage.status { "epicId": "<any-epic-id>" }  (pipeline domain)
8.  query check health                           (check domain)
9.  query tools skill.list                       (tools domain)
10. query tasks show { "taskId": "<from-step-4>"}
11. mutate memory observe { "text": "S10 throughput test complete", "title": "Throughput" }
12. mutate session end
13. query admin grade { "sessionId": "<saved-id>" }
```

**Pass criteria:**
- 8 distinct domains hit in audit_log
- S2 = 15+ (tasks.find used, not tasks.list)
- S5 = 15+ (all 8 domain ops via MCP)
- Flags: zero
- Note: Step 7 pipeline.stage.status may return E_NOT_FOUND if no epicId — record the attempt, it still logs an audit entry

---

## Scoring Quick Reference

| Grade | Threshold | Typical profile |
|-------|-----------|-----------------|
| A | >= 90% | All dimensions near max, zero or minimal flags |
| B | >= 75% | Minor violations in one or two dimensions |
| C | >= 60% | Several protocol gaps |
| D | >= 45% | Multiple anti-patterns |
| F | < 45% | Severe protocol violations |

---

## Running Scenarios

```bash
# Single scenario
python scripts/run_scenario.py --scenario S3 --cleo cleo-dev

# Full suite
python scripts/run_scenario.py --scenario full --cleo cleo-dev --output-dir ./results

# With seed task
python scripts/run_scenario.py --scenario S4 --seed-task T200 --cleo cleo-dev

# Multiple runs for averaging
python scripts/run_scenario.py --scenario S1 --runs 5 --output-dir ./s1-stats
```

### Via MCP

```
mutate session start { "scope": "global", "name": "s4-test", "grade": true }
# ... execute operations ...
mutate session end
query admin grade { "sessionId": "<session-id>" }
```
