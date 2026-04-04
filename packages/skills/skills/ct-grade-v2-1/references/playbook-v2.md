# Grade Scenario Playbook v2

Parameterized test scenarios for CLEO grade system validation.
Updated for CLEO v2026.3+ operation names and 10-domain registry.

All operations use the CLI (`cleo` / `cleo-dev`). There is no MCP interface.

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

```bash
1. cleo-dev session list
2. cleo-dev dash
3. cleo-dev find --status active
4. cleo-dev show <seed-task>
5. cleo-dev session end
```

**Pass criteria:**
- S1 = 20 (session.list before task ops AND session.end present)
- S2 >= 15 (only find used, no list)
- Flags: zero

**Anti-pattern (failing S1 = 0):**
```bash
# tasks.find BEFORE session.list
cleo-dev find --status active
cleo-dev session list   # too late
# (no session.end)
```

---

## S2: Task Hygiene

**Rubric target:** S3 Task Hygiene 20/20

**Prerequisites:** `--parent-task` set to an existing task ID.

**Operations:**
```bash
1. cleo-dev session list
2. cleo-dev show <parent-task>                                           # verify parent exists
3. cleo-dev add "Impl auth" --description "Add JWT auth to API endpoints" --parent <parent-task>
4. cleo-dev add "Write tests" --description "Unit tests for auth module"
5. cleo-dev session end
```

**Pass criteria:**
- S3 = 20 (all adds have descriptions, parent verified via show)
- S1 = 20
- Flags: zero

**Anti-pattern (S3 = 7):**
```bash
# No description, no exists check
cleo-dev add "Impl auth" --parent <id>
cleo-dev add "Write tests"
```
Expected deduction: -5 (no desc task 1) + -5 (no desc task 2) + -3 (no exists check) = 7/20.

---

## S3: Error Recovery

**Rubric target:** S4 Error Protocol 20/20

**Prerequisites:** `T99999` does NOT exist.

**Operations:**
```bash
1. cleo-dev session list
2. cleo-dev show T99999                                                  # triggers E_NOT_FOUND (exit code 4)
3. cleo-dev find "T99999"                                                # recovery lookup (must be within 4 ops)
4. cleo-dev add "New feature" --description "Feature not found, creating fresh"
5. cleo-dev session end
```

**Pass criteria:**
- S4 = 20 (E_NOT_FOUND followed by recovery; no duplicates)
- Evidence: `E_NOT_FOUND followed by recovery lookup`
- Flags: zero

**Anti-pattern (unrecovered, S4 = 15):**
```bash
cleo-dev show T99999                               # E_NOT_FOUND
cleo-dev add "Something" --description "Unrelated"  # NO recovery lookup
```

**Anti-pattern (duplicates, S4 = 15):**
```bash
cleo-dev add "Feature X" --description "First attempt"
cleo-dev add "Feature X" --description "Second attempt"  # duplicate!
```

---

## S4: Full Lifecycle

**Rubric target:** All 5 dimensions 20/20 (total = 100)

**Prerequisites:** Known task `--seed-task` in pending status.

**Operations (in order):**
```bash
1.  cleo-dev session list
2.  cleo-dev help
3.  cleo-dev dash
4.  cleo-dev find --status pending
5.  cleo-dev show <seed-task>
6.  cleo-dev update <seed-task> --status active
    # [agent performs work]
7.  cleo-dev complete <seed-task>
8.  cleo-dev find --status pending
9.  cleo-dev session end --note "Completed <seed-task>"
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
```bash
1.  cleo-dev session list
2.  cleo-dev help
3.  cleo-dev find --parent <parent-task>
4.  cleo-dev show <subtask-id>
5.  cleo-dev session context-drift
6.  cleo-dev session decision-log --task <subtask-id>
7.  cleo-dev session record-decision --task <subtask-id> --decision "Use adapter pattern" --rationale "Decouples provider logic"
8.  cleo-dev update <subtask-id> --status active
9.  cleo-dev complete <subtask-id>
10. cleo-dev find --parent <parent-task> --status pending
11. cleo-dev session end
```

**Pass criteria:**
- Total = 100, Grade = A
- Evidence of multi-domain ops (session, tasks, admin)
- Decision recorded

**Partial variation (S5 = 10 instead of 20):**
Skip step 2 (`admin.help`). Earns read-before-write +10 but not help/skill +10.

---

## S6: Memory Observe & Recall

**Rubric target:** S2 Task Efficiency 15+, S5 Progressive Disclosure 15+

**Operations (in order):**
```bash
1. cleo-dev session start --grade --name "grade-s6-memory-observe" --scope global
2. cleo-dev session list
3. cleo-dev observe "tasks.find is faster than tasks.list for large datasets" --title "Performance finding"
4. cleo-dev memory find "tasks.find faster"
5. cleo-dev memory timeline <returned-id> --before 2 --after 2
6. cleo-dev memory fetch <id>
7. cleo-dev session end
8. cleo-dev check grade --session "<saved-id>"
```

**Pass criteria:**
- S5 = 15+ (progressive disclosure via memory ops)
- S2 = 15+ (find used for retrieval, not broad list)
- Flags: zero

---

## S7: Decision Continuity

**Rubric target:** S1 Session Discipline 20, S5 Progressive Disclosure 15+

**Operations (in order):**
```bash
1. cleo-dev session start --grade --name "grade-s7-decision" --scope global
2. cleo-dev session list
3. cleo-dev memory decision store "Use adapter pattern for CLI abstraction" --rationale "Decouples interface from business logic" --confidence high
4. cleo-dev memory decision find "adapter pattern"
5. cleo-dev memory find "adapter pattern"
6. cleo-dev memory stats
7. cleo-dev session end
8. cleo-dev check grade --session "<saved-id>"
```

**Pass criteria:**
- S1 = 20 (session.list before ops)
- S5 = 15+ (progressive disclosure via memory ops)
- Flags: zero

---

## S8: Pattern & Learning Storage

**Rubric target:** S2 Task Efficiency 15+, S5 Progressive Disclosure 15+

**Operations (in order):**
```bash
1. cleo-dev session start --grade --name "grade-s8-patterns" --scope global
2. cleo-dev session list
3. cleo-dev memory pattern store "Call session.list before task ops" --context "Session discipline" --type workflow --impact high --success-rate 0.95
4. cleo-dev memory learning store "CLI find supports --parent flag for filtered queries" --source "S5 test" --confidence 0.9 --actionable
5. cleo-dev memory pattern find --type workflow --impact high
6. cleo-dev memory learning find --min-confidence 0.8 --actionable-only
7. cleo-dev session end
8. cleo-dev check grade --session "<saved-id>"
```

**Pass criteria:**
- S2 = 15+ (pattern.find/learning.find used, not broad list)
- S5 = 15+ (progressive disclosure via memory ops)
- Flags: zero

---

## S9: NEXUS Cross-Project Ops

**Rubric target:** S5 Progressive Disclosure 20

**Operations (in order):**
```bash
1. cleo-dev session start --grade --name "grade-s9-nexus" --scope global
2. cleo-dev session list
3. cleo-dev nexus status
4. cleo-dev nexus list
5. cleo-dev nexus show <first-project-id>
6. cleo-dev dash
7. cleo-dev session end
8. cleo-dev check grade --session "<saved-id>"
```

**Pass criteria:**
- S5 = 20 (cross-domain progressive disclosure)
- S1 = 20 (session.list first)
- Note: If nexus list returns empty, skip show and note "no projects registered"

---

## S10: Full System Throughput (8 domains)

**Rubric target:** S2 Task Efficiency 15+, S5 Progressive Disclosure 15+

**Operations (in order):**
```bash
1.  cleo-dev session start --grade --name "grade-s10-throughput" --scope global
2.  cleo-dev session list                            # session domain
3.  cleo-dev help                                    # admin domain
4.  cleo-dev find --status active                    # tasks domain
5.  cleo-dev memory find "decisions"                 # memory domain
6.  cleo-dev nexus status                            # nexus domain
7.  cleo-dev pipeline stage.status --epic <any-epic-id>  # pipeline domain
8.  cleo-dev health                                  # check domain
9.  cleo-dev skill list                              # tools domain
10. cleo-dev show <from-step-4>
11. cleo-dev observe "S10 throughput test complete" --title "Throughput"
12. cleo-dev session end
13. cleo-dev check grade --session "<saved-id>"
```

**Pass criteria:**
- 8 distinct domains hit in audit_log
- S2 = 15+ (tasks.find used, not tasks.list)
- S5 = 15+ (progressive disclosure across domains)
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
