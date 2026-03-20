# CLEO Grade Specification v2

Updated for CLEO v2026.3+ with 10 canonical domains and 262 operations.
Source of truth: `src/core/sessions/session-grade.ts` + `docs/specs/CLEO-GRADE-SPEC.md`.

---

## Rubric: 5 Dimensions (100 pts max)

### S1: Session Discipline (20 pts)

Measures whether the agent checks existing sessions before starting work and properly ends sessions.

| Points | Condition | Evidence string |
|--------|-----------|-----------------|
| +10 | `session.list` called before first `tasks.*` operation | `session.list called before first task op` |
| +10 | `session.end` called at least once | `session.end called` |

**Flags on violation:**
- `session.list never called (check existing sessions before starting)`
- `session.list called after task ops (should check sessions first)`
- `session.end never called (always end sessions when done)`

**Scoring:** Starts at 0. Range: 0–20.

---

### S2: Discovery Efficiency (20 pts)

Measures whether the agent uses `tasks.find` (lightweight, minimal fields) over `tasks.list` (heavy, full notes arrays).

| Points | Condition | Evidence string |
|--------|-----------|-----------------|
| +15 | `find / (find + list)` ratio >= 80% | `find:list ratio N% >= 80%` |
| partial | Proportional if ratio < 80%: `round(15 * ratio)` | — |
| +10 | Zero discovery calls (benefit of doubt) | `No discovery calls needed` |
| +5 | `tasks.show` used at least once | `tasks.show used Nx for detail` |

**Flags:** `tasks.list used Nx (prefer tasks.find for discovery)`

**Scoring:** Capped at 20. Range: 0–20.

---

### S3: Task Hygiene (20 pts)

Measures whether tasks are created with proper descriptions and subtask parent verification.

| Points | Condition | Evidence string |
|--------|-----------|-----------------|
| -5 each | `tasks.add` succeeded without a description | flag per violation |
| -3 | Subtasks created (with `parent` param) but no preceding `tasks.find {exact:true}` | `Subtasks created without parent existence check` |
| (none) | All adds have descriptions | `All N tasks.add calls had descriptions` |
| (none) | Subtasks preceded by `tasks.find {exact:true}` | `Parent existence verified before subtask creation` |

**Flags:**
- `tasks.add without description (taskId: <id>)`
- `Subtasks created without parent existence check`

**Scoring:** Starts at 20, deducts penalties. Floor: 0.

---

### S4: Error Protocol (20 pts)

Measures whether the agent recovers from `E_NOT_FOUND` (exit code 4) and avoids duplicate creates.

| Points | Condition | Evidence string |
|--------|-----------|-----------------|
| -5 each | `E_NOT_FOUND` not followed by `tasks.find` within next 4 entries | flag per violation |
| -5 | Duplicate task creates (same title, case-insensitive) in session | `N potentially duplicate task create(s) detected` |
| (none) | Error followed by recovery | `E_NOT_FOUND followed by recovery lookup` |
| (none) | No violations | `No error protocol violations` |

**Recovery window:** Checks `entries[errIdx+1 : errIdx+5]` for `tasks.find`.

**Duplicate detection:** Compares lowercased trimmed titles of all successful `tasks.add` calls.

**Scoring:** Starts at 20, deducts penalties. Floor: 0.

---

### S5: Progressive Disclosure Use (20 pts)

Measures whether the agent uses CLEO's progressive disclosure system and the MCP query gateway.

| Points | Condition | Evidence string |
|--------|-----------|-----------------|
| +10 | At least one help/skill call: `admin.help`, `tools.skill.show`, `tools.skill.list`, `tools.skill.find` | `Progressive disclosure used (Nx)` |
| +10 | At least one MCP query gateway call (`metadata.gateway === "query"`) | `query (MCP) used Nx` |

**Flags:**
- `No admin.help or skill lookup calls (load ct-cleo for guidance)`
- `No MCP query calls (prefer query over CLI for programmatic access)`

**Scoring:** Starts at 0. Range: 0–20.

---

## Grade Letter Mapping

| Grade | Threshold | Profile |
|-------|-----------|---------|
| A | >= 90% | All dimensions near max, zero or minimal flags |
| B | >= 75% | Minor violations in one or two dimensions |
| C | >= 60% | Several protocol gaps |
| D | >= 45% | Multiple anti-patterns |
| F | < 45% | Severe protocol violations across most dimensions |

---

## Token Metadata (v2.1 addition)

Grade results in v2.1 carry optional token metadata alongside the standard GradeResult — not a scored dimension, but captured for efficiency analysis:

```json
{
  "_tokenMeta": {
    "estimationMethod": "otel|output_chars",
    "totalEstimatedTokens": 4200,
    "perDomain": {
      "tasks": 1800,
      "session": 600,
      "admin": 400
    },
    "mcpQueryTokens": 2100,
    "cliTokens": 1100,
    "auditEntries": 47
  }
}
```

This field is appended by the run_scenario.py and run_ab_test.py scripts. It does NOT affect the 0–100 score.

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| No audit entries | All scores 0; flag `No audit entries found for session (use --grade flag when starting session)` |
| No task operations | S1 session.list check passes (list is always "before" task ops when there are none) |
| No discovery calls | S2 awards 10 baseline (benefit of doubt) |
| No adds | S3 starts at 20 with no deductions |
| No errors | S4 starts at 20 with no deductions |
| No grade file | `readGrades()` returns `[]` |

---

## Updated Domain Recognition (v2.1)

The rubric recognizes all 10 canonical domains in audit entries. Key domain-to-dimension mappings:

| Domain | Affects |
|--------|---------|
| `session` | S1 (list/end), S5 (gateway) |
| `tasks` | S1 (first task op timing), S2 (find/list/show), S3 (add/exists), S4 (error recovery) |
| `admin` | S5 (admin.help progressive disclosure) |
| `tools` | S5 (skill.show, skill.list, skill.find) |
| `memory` | S5 (gateway tracking only) |
| `pipeline` | S5 (gateway tracking only) |
| `check` | S5 (gateway tracking only) |
| `orchestrate` | S5 (gateway tracking only) |
| `nexus` | S5 (gateway tracking only) |
| `sticky` | S5 (gateway tracking only) |

All 10 domains contribute to `mcpQueryCalls` count in S5 — any MCP query gateway call regardless of domain earns the +10.
