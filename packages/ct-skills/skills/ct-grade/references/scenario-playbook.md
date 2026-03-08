# Grade Scenario Playbook (Updated)

**Based on**: `docs/specs/GRADE-SCENARIO-PLAYBOOK.md` + current session-grade.ts implementation
**Status**: Active — reflects current rubric

Each scenario targets specific grade dimensions. Run via `agents/scenario-runner.md`.

Use **cleo-dev** (local dev build) for MCP operations or **cleo** (production).
Use the MCP `query`/`mutate` gateway for MCP-interface runs; `cleo-dev` CLI for CLI-interface runs.

---

## S1: Fresh Discovery

**Purpose**: Validates S1 (Session Discipline) and S2 (Discovery Efficiency).
**Target score**: 45/100 (S1 full, S2 partial, S5 partial — no admin.help)

### Operation Sequence (MCP)

```
1. query session list                                          — S1: must be first
2. query admin dash                                            — project overview
3. query tasks find { "status": "active" }                    — S2: find not list
4. query tasks show { "taskId": "T<any>" }                    — S2: show used
5. mutate session end                                          — S1: session.end
```

### Operation Sequence (CLI)

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
| S5 (MCP) | 10/20 | query gateway used (+10), no admin.help call |
| S5 (CLI) | 0/20 | No MCP query calls, no admin.help |

**MCP total: ~90/100 (A)**
**CLI total: ~80/100 (B)**

### Anti-pattern Variant (for testing grader sensitivity)

```
query tasks find { "status": "active" }   ← task op BEFORE session.list
query session list                         ← too late for S1
(no session.end)
```
Expected S1: 0 — flags: `session.list called after task ops`, `session.end never called`

---

## S2: Task Creation Hygiene

**Purpose**: Validates S3 (Task Hygiene) and S1.
**Target score**: 60/100 (S1 full, S3 full, S5 partial MCP or 0 CLI)

### Operation Sequence (MCP)

```
1. query session list                                             — S1
2. query tasks exists { "taskId": "T100" }                       — S3: parent verify
3. mutate tasks add { "title": "Implement auth",
     "description": "Add JWT authentication to API endpoints",
     "parent": "T100" }                                          — S3: desc + parent
4. mutate tasks add { "title": "Write tests",
     "description": "Unit tests for auth module" }               — S3: desc present
5. mutate session end                                            — S1
```

### Scoring Targets

| Dim | Expected | Reason |
|-----|----------|--------|
| S1 | 20/20 | session.list first, session.end present |
| S3 | 20/20 | All adds have descriptions, parent verified via exists |
| S5 (MCP) | 10/20 | query gateway used |
| S5 (CLI) | 0/20 | no MCP query, no help |

**MCP total: ~70/100 (C)**
**CLI total: ~60/100 (C)**

### Anti-pattern Variant

```
mutate tasks add { "title": "Implement auth", "parent": "T100" }  ← no desc, no exists check
mutate tasks add { "title": "Write tests" }                         ← no desc
```
Expected S3: 7 (20 - 5 - 5 - 3 = 7)

---

## S3: Error Recovery

**Purpose**: Validates S4 (Error Protocol).

### Operation Sequence (MCP)

```
1. query session list                                            — S1
2. query tasks show { "taskId": "T99999" }                      — triggers E_NOT_FOUND
3. query tasks find { "query": "T99999" }                       — S4: recovery within 4 ops
4. mutate tasks add { "title": "New feature",
     "description": "Implement the feature that was not found" } — S3: desc present
5. mutate session end                                            — S1
```

### Scoring Targets

| Dim | Expected | Reason |
|-----|----------|--------|
| S1 | 20/20 | Proper session lifecycle |
| S3 | 20/20 | Task created with description |
| S4 | 20/20 | E_NOT_FOUND followed by recovery lookup within 4 entries |
| S5 (MCP) | 10/20 | query gateway used |

**MCP total: ~90/100 (A)**

### Anti-pattern: Unrecovered Error

```
query tasks show { "taskId": "T99999" }        ← E_NOT_FOUND
mutate tasks add { "title": "Something else",
  "description": "Unrelated" }                 ← no recovery lookup
```
S4 deduction: -5 (no tasks.find within next 4 entries)

### Anti-pattern: Duplicate Creates

```
mutate tasks add { "title": "New feature", "description": "First attempt" }
mutate tasks add { "title": "New feature", "description": "Second attempt" }
```
S4 deduction: -5 (1 duplicate detected)

---

## S4: Full Lifecycle

**Purpose**: Validates all 5 dimensions. Gold standard session.
**Target score**: 100/100 (A) for MCP, ~80/100 (B) for CLI

### Operation Sequence (MCP)

```
1.  query session list                                         — S1
2.  query admin help                                           — S5: progressive disclosure
3.  query admin dash                                           — overview
4.  query tasks find { "status": "pending" }                  — S2: find not list
5.  query tasks show { "taskId": "T200" }                     — S2: show for detail
6.  mutate tasks update { "taskId": "T200", "status": "active" } — begin work
(agent does work here)
7.  mutate tasks complete { "taskId": "T200" }                — mark done
8.  query tasks find { "status": "pending" }                  — check next
9.  mutate session end { "note": "Completed T200" }           — S1
```

### Scoring Targets (MCP)

| Dim | Expected | Reason |
|-----|----------|--------|
| S1 | 20/20 | session.list first (+10), session.end present (+10) |
| S2 | 20/20 | find:list 100% (+15), show used (+5) |
| S3 | 20/20 | No adds — no deductions |
| S4 | 20/20 | No errors, no duplicates |
| S5 | 20/20 | admin.help (+10), query gateway (+10) |

**MCP total: 100/100 (A)**
**CLI total: ~80/100 (B)** — loses S5 entirely

---

## S5: Multi-Domain Analysis

**Purpose**: Validates cross-domain operations and advanced S5.
**Target score**: 100/100 (MCP), ~80/100 (CLI)

### Operation Sequence (MCP)

```
1.  query session list                                              — S1
2.  query admin help                                               — S5
3.  query tasks find { "parent": "T500" }                         — S2: epic subtasks
4.  query tasks show { "taskId": "T501" }                         — S2: inspect
5.  query session context.drift                                    — multi-domain
6.  query session decision.log { "taskId": "T501" }               — decision history
7.  mutate session record.decision { "taskId": "T501",
      "decision": "Use adapter pattern",
      "rationale": "Decouples provider logic" }                    — record decision
8.  mutate tasks update { "taskId": "T501", "status": "active" }
9.  mutate tasks complete { "taskId": "T501" }
10. query tasks find { "parent": "T500", "status": "pending" }    — next subtask
11. mutate session end                                             — S1
```

### Scoring Targets

| Dim | Expected | Reason |
|-----|----------|--------|
| S1 | 20/20 | session.list first, session.end present |
| S2 | 20/20 | find used exclusively, show used |
| S3 | 20/20 | No task.add — no deductions |
| S4 | 20/20 | No errors |
| S5 | 20/20 | admin.help (+10), query gateway (+10) |

**MCP total: 100/100 (A)**

---

## Scenario Quick Reference

| Scenario | Primary Dims Tested | MCP Expected | CLI Expected |
|---|---|---|---|
| S1 | S1, S2 | ~90 (A) | ~80 (B) |
| S2 | S1, S3 | ~70 (C) | ~60 (C) |
| S3 | S1, S3, S4 | ~90 (A) | ~80 (B) |
| S4 | All 5 | 100 (A) | ~80 (B) |
| S5 | All 5, cross-domain | 100 (A) | ~80 (B) |

**Key insight**: CLI interface will consistently score 0 on S5 Progressive Disclosure because:
1. CLI operations don't set `metadata.gateway = 'query'` (no +10)
2. `cleo-dev admin help` CLI call is not detected as `admin.help` MCP call (no +10)

This is by design — the rubric rewards MCP-first behavior.
