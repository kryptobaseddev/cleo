# Grade Scenario Playbook (Updated)

**Based on**: `docs/specs/GRADE-SCENARIO-PLAYBOOK.md` + current session-grade.ts implementation
**Status**: Active — reflects current rubric

Each scenario targets specific grade dimensions. Run via `agents/scenario-runner.md`.

Use **cleo-dev** (local dev build) or **cleo** (production). All operations use the CLI.

---

## S1: Fresh Discovery

**Purpose**: Validates S1 (Session Discipline) and S2 (Discovery Efficiency).
**Target score**: 45/100 (S1 full, S2 partial, S5 partial — no admin.help)

### Operation Sequence

```bash
1. cleo-dev session list
2. cleo-dev dash
3. cleo-dev find --status active
4. cleo-dev show T<any>
5. cleo-dev session end
```

### Scoring Targets

| Dim | Expected | Reason |
|-----|----------|--------|
| S1 | 20/20 | session.list first (+10), session.end present (+10) |
| S2 | 20/20 | find used exclusively (+15), show used (+5) |
| S3 | 20/20 | No task adds (no deductions) |
| S4 | 20/20 | No errors |
| S5 | 10/20 | No admin.help call |

**Total: ~90/100 (A)**

### Anti-pattern Variant (for testing grader sensitivity)

```bash
cleo-dev find --status active        # task op BEFORE session.list
cleo-dev session list                # too late for S1
# (no session.end)
```
Expected S1: 0 — flags: `session.list called after task ops`, `session.end never called`

---

## S2: Task Creation Hygiene

**Purpose**: Validates S3 (Task Hygiene) and S1.
**Target score**: 60/100 (S1 full, S3 full, S5 partial)

### Operation Sequence

```bash
1. cleo-dev session list
2. cleo-dev show T100                                            # S3: parent verify
3. cleo-dev add "Implement auth" --description "Add JWT authentication to API endpoints" --parent T100
4. cleo-dev add "Write tests" --description "Unit tests for auth module"
5. cleo-dev session end
```

### Scoring Targets

| Dim | Expected | Reason |
|-----|----------|--------|
| S1 | 20/20 | session.list first, session.end present |
| S3 | 20/20 | All adds have descriptions, parent verified via show |
| S5 | 0/20 | no help |

**Total: ~60/100 (C)**

### Anti-pattern Variant

```bash
cleo-dev add "Implement auth" --parent T100       # no desc, no exists check
cleo-dev add "Write tests"                         # no desc
```
Expected S3: 7 (20 - 5 - 5 - 3 = 7)

---

## S3: Error Recovery

**Purpose**: Validates S4 (Error Protocol).

### Operation Sequence

```bash
1. cleo-dev session list
2. cleo-dev show T99999                                          # triggers E_NOT_FOUND
3. cleo-dev find "T99999"                                        # S4: recovery within 4 ops
4. cleo-dev add "New feature" --description "Implement the feature that was not found"
5. cleo-dev session end
```

### Scoring Targets

| Dim | Expected | Reason |
|-----|----------|--------|
| S1 | 20/20 | Proper session lifecycle |
| S3 | 20/20 | Task created with description |
| S4 | 20/20 | E_NOT_FOUND followed by recovery lookup within 4 entries |
| S5 | 0/20 | no help |

**Total: ~80/100 (B)**

### Anti-pattern: Unrecovered Error

```bash
cleo-dev show T99999                               # E_NOT_FOUND
cleo-dev add "Something else" --description "Unrelated"  # no recovery lookup
```
S4 deduction: -5 (no find within next 4 entries)

### Anti-pattern: Duplicate Creates

```bash
cleo-dev add "New feature" --description "First attempt"
cleo-dev add "New feature" --description "Second attempt"
```
S4 deduction: -5 (1 duplicate detected)

---

## S4: Full Lifecycle

**Purpose**: Validates all 5 dimensions. Gold standard session.
**Target score**: 100/100 (A)

### Operation Sequence

```bash
1.  cleo-dev session list
2.  cleo-dev help                                                # S5: progressive disclosure
3.  cleo-dev dash                                                # overview
4.  cleo-dev find --status pending                               # S2: find not list
5.  cleo-dev show T200                                           # S2: show for detail
6.  cleo-dev update T200 --status active                         # begin work
    # (agent does work here)
7.  cleo-dev complete T200                                       # mark done
8.  cleo-dev find --status pending                               # check next
9.  cleo-dev session end --note "Completed T200"                 # S1
```

### Scoring Targets

| Dim | Expected | Reason |
|-----|----------|--------|
| S1 | 20/20 | session.list first (+10), session.end present (+10) |
| S2 | 20/20 | find:list 100% (+15), show used (+5) |
| S3 | 20/20 | No adds — no deductions |
| S4 | 20/20 | No errors, no duplicates |
| S5 | 20/20 | admin.help used (+10), progressive disclosure (+10) |

**Total: 100/100 (A)**

---

## S5: Multi-Domain Analysis

**Purpose**: Validates cross-domain operations and advanced S5.
**Target score**: 100/100

### Operation Sequence

```bash
1.  cleo-dev session list
2.  cleo-dev help
3.  cleo-dev find --parent T500                                  # S2: epic subtasks
4.  cleo-dev show T501                                           # S2: inspect
5.  cleo-dev session context-drift                               # multi-domain
6.  cleo-dev session decision-log --task T501                    # decision history
7.  cleo-dev session record-decision --task T501 --decision "Use adapter pattern" --rationale "Decouples provider logic"
8.  cleo-dev update T501 --status active
9.  cleo-dev complete T501
10. cleo-dev find --parent T500 --status pending                 # next subtask
11. cleo-dev session end
```

### Scoring Targets

| Dim | Expected | Reason |
|-----|----------|--------|
| S1 | 20/20 | session.list first, session.end present |
| S2 | 20/20 | find used exclusively, show used |
| S3 | 20/20 | No task.add — no deductions |
| S4 | 20/20 | No errors |
| S5 | 20/20 | admin.help used (+10), progressive disclosure (+10) |

**Total: 100/100 (A)**

---

## Scenario Quick Reference

| Scenario | Primary Dims Tested | Expected Score |
|---|---|---|
| S1 | S1, S2 | ~90 (A) |
| S2 | S1, S3 | ~60 (C) |
| S3 | S1, S3, S4 | ~80 (B) |
| S4 | All 5 | 100 (A) |
| S5 | All 5, cross-domain | 100 (A) |
