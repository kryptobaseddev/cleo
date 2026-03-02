---
version: 1.0.0
status: active
task: T4916
date: 2026-03-01
---

# Grade Scenario Playbook

Test scenarios for validating the CLEO grading rubric. Each scenario targets specific dimensions of the 5-dimension behavioral rubric and provides concrete operation sequences that agents (or test harnesses) can execute.

See `docs/specs/CLEO-GRADE-SPEC.md` for the full rubric specification.

## S1: Fresh Discovery

**Purpose:** Validate Session Discipline (S1) scoring. Tests that the agent checks for existing sessions before performing task operations and ends sessions properly.

### Setup

1. Start a grade-enabled session:
   ```
   cleo_mutate session start { "scope": "global", "name": "s1-test", "grade": true }
   ```

### Expected Operations (in order)

1. `cleo_query session list` -- check existing sessions (must come before any task op)
2. `cleo_query admin dash` -- project overview
3. `cleo_query tasks find { "status": "active" }` -- discover tasks
4. `cleo_query tasks show { "taskId": "T1234" }` -- inspect a specific task
5. `cleo_mutate session end` -- end session cleanly

### Scoring Targets

| Dimension | Expected Score | Why |
|-----------|---------------|-----|
| S1 Session Discipline | 20/20 | session.list before task ops (+10), session.end present (+10) |
| S2 Discovery Efficiency | 20/20 | find used exclusively (+15), show used (+5) |
| S5 Progressive Disclosure | 10/20 | cleo_query gateway used (+10), no help/skill calls (+0) |

### Pass Criteria

- S1 score = 20
- No flags related to session.list ordering or session.end absence
- Evidence includes `session.list called before first task op` and `session.end called`

### Anti-pattern (Failing)

```
cleo_query tasks find { "status": "active" }    # task op before session.list!
cleo_query session list                          # too late
# (no session.end)
```

Expected S1 score: 0 (session.list after task ops, no session.end).

---

## S2: Task Creation Hygiene

**Purpose:** Validate Task Hygiene (S3) scoring. Tests proper task creation with descriptions and parent verification for subtasks.

### Setup

1. Start a grade-enabled session:
   ```
   cleo_mutate session start { "scope": "global", "name": "s2-test", "grade": true }
   ```
2. Ensure a known parent task exists (e.g., `T100`).

### Expected Operations

1. `cleo_query session list` -- session discipline
2. `cleo_query tasks exists { "taskId": "T100" }` -- verify parent before subtask
3. `cleo_mutate tasks add { "title": "Implement auth", "description": "Add JWT authentication to API endpoints", "parent": "T100" }` -- subtask with description + parent check
4. `cleo_mutate tasks add { "title": "Write tests", "description": "Unit tests for auth module" }` -- standalone task with description
5. `cleo_mutate session end`

### Scoring Targets

| Dimension | Expected Score | Why |
|-----------|---------------|-----|
| S3 Task Hygiene | 20/20 | All adds have descriptions (no -5), parent verified via exists (no -3) |
| S1 Session Discipline | 20/20 | session.list first, session.end present |

### Pass Criteria

- S3 score = 20
- Evidence includes `Parent existence verified before subtask creation` and `All 2 tasks.add calls had descriptions`
- No flags about missing descriptions or parent checks

### Anti-pattern (Failing)

```
cleo_mutate tasks add { "title": "Implement auth", "parent": "T100" }  # no description, no exists check
cleo_mutate tasks add { "title": "Write tests" }                       # no description
```

Expected S3 score: 7 (20 - 5 - 5 - 3 = 7).

---

## S3: Error Recovery

**Purpose:** Validate Error Protocol (S4) scoring. Tests that the agent recovers from E_NOT_FOUND errors and avoids duplicate task creation.

### Setup

1. Start a grade-enabled session:
   ```
   cleo_mutate session start { "scope": "global", "name": "s3-test", "grade": true }
   ```
2. Ensure task `T99999` does NOT exist.

### Expected Operations

1. `cleo_query session list`
2. `cleo_query tasks show { "taskId": "T99999" }` -- triggers E_NOT_FOUND (exit code 4)
3. `cleo_query tasks find { "query": "T99999" }` -- recovery lookup within 4 entries
4. `cleo_mutate tasks add { "title": "New feature", "description": "Implement the feature that was not found" }` -- create once
5. `cleo_mutate session end`

### Scoring Targets

| Dimension | Expected Score | Why |
|-----------|---------------|-----|
| S4 Error Protocol | 20/20 | E_NOT_FOUND followed by recovery (+0 deduction), no duplicates (+0 deduction) |
| S1 Session Discipline | 20/20 | Proper session lifecycle |
| S3 Task Hygiene | 20/20 | Task created with description |

### Pass Criteria

- S4 score = 20
- Evidence includes `E_NOT_FOUND followed by recovery lookup`
- No flags about unrecovered errors or duplicates

### Anti-pattern (Failing -- unrecovered error)

```
cleo_query tasks show { "taskId": "T99999" }     # E_NOT_FOUND
cleo_mutate tasks add { "title": "Something else", "description": "Unrelated" }  # no recovery lookup
```

Expected S4 deduction: -5 (unrecovered E_NOT_FOUND).

### Anti-pattern (Failing -- duplicate creates)

```
cleo_mutate tasks add { "title": "New feature", "description": "First attempt" }
cleo_mutate tasks add { "title": "New feature", "description": "Second attempt" }  # duplicate title
```

Expected S4 deduction: -5 (1 duplicate detected).

---

## S4: Full Lifecycle

**Purpose:** Validate all 5 dimensions in a complete session lifecycle. Tests the ideal agent workflow from session start through task work to session end.

### Setup

1. Ensure a clean environment with known tasks.
2. Start a grade-enabled session:
   ```
   cleo_mutate session start { "scope": "global", "name": "s4-test", "grade": true }
   ```

### Expected Operations (in order)

1. `cleo_query session list` -- check existing sessions
2. `cleo_query admin help` -- progressive disclosure
3. `cleo_query admin dash` -- project overview
4. `cleo_query tasks find { "status": "pending" }` -- discovery via find (not list)
5. `cleo_query tasks show { "taskId": "T200" }` -- inspect chosen task
6. `cleo_mutate tasks update { "taskId": "T200", "status": "active" }` -- begin work
7. *(agent does actual code work here)*
8. `cleo_mutate tasks complete { "taskId": "T200" }` -- mark done
9. `cleo_query tasks find { "status": "pending" }` -- check for next task
10. `cleo_mutate session end { "note": "Completed T200" }` -- clean end

### Scoring Targets

| Dimension | Expected Score | Why |
|-----------|---------------|-----|
| S1 Session Discipline | 20/20 | session.list first (+10), session.end present (+10) |
| S2 Discovery Efficiency | 20/20 | find:list ratio 100% (+15), show used (+5) |
| S3 Task Hygiene | 20/20 | No adds without descriptions, no subtask violations |
| S4 Error Protocol | 20/20 | No errors, no duplicates |
| S5 Progressive Disclosure | 20/20 | admin.help used (+10), cleo_query gateway (+10) |

### Pass Criteria

- Total score = 100/100
- Grade = A
- Zero flags
- Entry count >= 10

### Notes

This scenario represents the "gold standard" agent workflow. All dimensions score maximum because the agent:
- Checks sessions before acting
- Uses help for progressive disclosure
- Uses find (not list) for discovery
- Inspects specific tasks via show
- Never triggers errors
- Ends session cleanly
- Uses the MCP gateway throughout

---

## S5: Multi-Domain Analysis

**Purpose:** Validate cross-domain operation patterns and progressive disclosure depth. Tests more advanced agent behavior across multiple CLEO domains.

### Setup

1. Start a grade-enabled session:
   ```
   cleo_mutate session start { "scope": "epic:T500", "name": "s5-test", "grade": true }
   ```
2. Ensure epic T500 exists with subtasks.

### Expected Operations

1. `cleo_query session list` -- session discipline
2. `cleo_query admin help` -- tier 0 progressive disclosure
3. `cleo_query tasks find { "parent": "T500" }` -- discover epic subtasks
4. `cleo_query tasks show { "taskId": "T501" }` -- inspect specific subtask
5. `cleo_query session context.drift` -- check context drift
6. `cleo_query session decision.log { "taskId": "T501" }` -- review past decisions
7. `cleo_mutate session record.decision { "taskId": "T501", "decision": "Use adapter pattern", "rationale": "Decouples provider logic" }` -- record a decision
8. `cleo_mutate tasks update { "taskId": "T501", "status": "active" }` -- begin work
9. `cleo_mutate tasks complete { "taskId": "T501" }` -- mark done
10. `cleo_query tasks find { "parent": "T500", "status": "pending" }` -- next subtask
11. `cleo_mutate session end`

### Scoring Targets

| Dimension | Expected Score | Why |
|-----------|---------------|-----|
| S1 Session Discipline | 20/20 | session.list first, session.end present |
| S2 Discovery Efficiency | 20/20 | find used exclusively, show used |
| S3 Task Hygiene | 20/20 | No task creation (only updates/completions) |
| S4 Error Protocol | 20/20 | No errors |
| S5 Progressive Disclosure | 20/20 | admin.help used (+10), cleo_query gateway (+10) |

### Pass Criteria

- Total score = 100/100
- Grade = A
- Evidence includes multi-domain operation usage (session, tasks, admin)
- Decision recorded for traceability

### Advanced Variation: Partial Disclosure

Replace step 2 with nothing (no help call) to test S5 partial scoring:

Expected S5 score: 10/20 (MCP gateway used but no help/skill calls).

---

## Scoring Quick Reference

| Grade | Threshold | Typical Profile |
|-------|-----------|-----------------|
| A | >= 90% | All dimensions near max, zero or minimal flags |
| B | >= 75% | Minor violations (e.g., missing help call, one list instead of find) |
| C | >= 60% | Several protocol gaps (no session.end, some missing descriptions) |
| D | >= 45% | Multiple anti-patterns (no session discipline, frequent errors) |
| F | < 45% | Severe protocol violations across most dimensions |

## Running Scenarios

### Via CLI

```bash
# Start graded session
cleo session start --scope global --name "test-scenario" --grade

# ... execute scenario operations ...

# End session
cleo session end

# Grade it
cleo grade <session-id>
```

### Via MCP

```
cleo_mutate session start { "scope": "global", "name": "test-scenario", "grade": true }
# ... execute scenario operations ...
cleo_mutate session end
cleo_query admin grade { "sessionId": "<session-id>" }
```

### Reviewing History

```bash
cleo grade --list                    # CLI: list all grades
```

```
cleo_query admin grade.list          # MCP: list all grades
```
