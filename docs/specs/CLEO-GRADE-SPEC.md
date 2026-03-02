---
version: 1.0.0
status: active
task: T4916
date: 2026-03-01
---

# CLEO Grade Specification

## Overview

The CLEO grading system provides rubric-based behavioral analysis of agent sessions. It evaluates how well an AI coding agent follows the CLEO protocol by analyzing audit log entries recorded during a session.

Grading measures five dimensions of agent behavior, each worth 20 points, for a maximum score of 100. The system produces a `GradeResult` with per-dimension scores, evidence strings, and diagnostic flags identifying specific protocol violations.

### Purpose

- Provide objective, repeatable measurement of agent protocol adherence
- Identify specific behavioral anti-patterns agents can correct
- Track agent improvement across sessions via `GRADES.jsonl` history
- Enable automated quality gates (session grade must meet threshold before merge)

## Architecture

### Data Flow

```
session.start(grade: true)
    |
    v
CLEO_SESSION_GRADE=true         (env var set)
CLEO_SESSION_GRADE_ID=<id>      (env var set)
CLEO_SESSION_ID=<id>            (env var set)
    |
    v
audit middleware (src/dispatch/middleware/audit.ts)
    - Logs ALL operations (query + mutate) when grade mode active
    - Normal mode: only mutate operations are audited
    - Writes to SQLite audit_log table (awaited in grade mode)
    |
    v
session.end
    |
    v
admin.grade <sessionId>
    - Reads audit entries via queryAudit({ sessionId })
    - Applies 5-dimension rubric
    - Appends result to .cleo/metrics/GRADES.jsonl
    - Returns GradeResult
```

### Key Files

| File | Role |
|------|------|
| `src/core/sessions/session-grade.ts` | Rubric implementation (scoring logic) |
| `src/core/sessions/index.ts` | Session operations (startSession with grade option) |
| `src/dispatch/domains/admin.ts` | MCP domain handler (admin.grade routing) |
| `src/dispatch/middleware/audit.ts` | Audit middleware (query logging in grade mode) |
| `src/cli/commands/grade.ts` | CLI command (`cleo grade`) |
| `schemas/grade.schema.json` | JSON Schema for GradeResult |

### Storage

Grade results are appended to `.cleo/metrics/GRADES.jsonl` as one JSON object per line. Each line includes an `evaluator` field set to `"auto"` for system-generated grades.

## Rubric: 5 Dimensions (100pts max)

### S1: Session Discipline (20pts)

Measures whether the agent checks existing sessions before starting work and properly ends sessions when done.

| Points | Condition | Evidence |
|--------|-----------|----------|
| +10 | `session.list` called before first `tasks.*` operation | `session.list called before first task op` |
| +10 | `session.end` called at least once | `session.end called` |

**Flags on violation:**
- `session.list never called (check existing sessions before starting)` -- session.list was never issued
- `session.list called after task ops (should check sessions first)` -- session.list exists but came after task operations
- `session.end never called (always end sessions when done)` -- no session.end found in audit

**Scoring logic:** Starts at 0, adds points for each condition met. Range: 0-20.

### S2: Discovery Efficiency (20pts)

Measures whether the agent uses `tasks.find` (lightweight, minimal fields) instead of `tasks.list` (heavy, full notes arrays) for task discovery.

| Points | Condition | Evidence |
|--------|-----------|----------|
| +15 | `find / (find + list)` ratio >= 80% | `find:list ratio N% >= 80%` |
| partial | Proportional score if ratio < 80%: `round(15 * ratio)` | -- |
| +10 | Zero discovery calls needed (no find or list) | `No discovery calls needed` |
| +5 | `tasks.show` used at least once for detail | `tasks.show used Nx for detail` |

**Flags on violation:**
- `tasks.list used Nx (prefer tasks.find for discovery)` -- excessive list usage detected

**Scoring logic:** If no discovery calls at all, starts at 10 (benefit of doubt). Otherwise scores proportionally on find ratio (up to 15), then adds 5 for show usage. Capped at 20.

### S3: Task Hygiene (20pts)

Measures whether tasks are created with proper descriptions and whether subtask creation verifies parent existence.

| Points | Condition | Evidence |
|--------|-----------|----------|
| -5 each | `tasks.add` succeeded without a description (empty or missing) | flag per violation |
| -3 | Subtasks created (`parent` param) without a preceding `tasks.exists` call | `Subtasks created without tasks.exists parent check` |
| (none) | Subtasks created with `tasks.exists` verification | `Parent existence verified before subtask creation` |
| (none) | All add calls have descriptions | `All N tasks.add calls had descriptions` |

**Flags on violation:**
- `tasks.add without description (taskId: <id>)` -- per-task flag for missing description
- `Subtasks created without tasks.exists parent check` -- no parent verification detected

**Scoring logic:** Starts at 20, deducts penalties. Floor at 0.

### S4: Error Protocol (20pts)

Measures whether the agent properly recovers from errors (especially `E_NOT_FOUND` with exit code 4) and avoids duplicate task creation.

| Points | Condition | Evidence |
|--------|-----------|----------|
| -5 each | `E_NOT_FOUND` (exit code 4) not followed by recovery lookup (`tasks.find` or `tasks.exists`) within next 4 entries | flag per violation |
| -5 | Duplicate task creates detected (same title within session) | `N potentially duplicate task create(s) detected` |
| (none) | Error followed by recovery | `E_NOT_FOUND followed by recovery lookup` |
| (none) | No violations | `No error protocol violations` |

**Duplicate detection:** Compares lowercased, trimmed titles of all successful `tasks.add` calls. Count of duplicates = `total titles - unique titles`.

**Recovery window:** After an `E_NOT_FOUND` error, the grader checks the next 4 audit entries (slice `[errIdx+1, errIdx+5)`) for a `tasks.find` or `tasks.exists` call.

**Scoring logic:** Starts at 20, deducts penalties. Floor at 0.

### S5: Progressive Disclosure Use (20pts)

Measures whether the agent uses CLEO's progressive disclosure system (help, skills) and the MCP query gateway.

| Points | Condition | Evidence |
|--------|-----------|----------|
| +10 | At least one help/skill call: `admin.help`, `tools.skill.show`, `tools.skill.list`, `skills.list`, or `skills.show` | `Progressive disclosure used (Nx)` |
| +10 | At least one MCP query gateway call (metadata.gateway === `cleo_query`) | `cleo_query (MCP) used Nx` |

**Flags on violation:**
- `No admin.help or skill lookup calls (load ct-cleo for guidance)` -- no help/skill calls found
- `No MCP query calls (prefer cleo_query over CLI for programmatic access)` -- no MCP gateway usage

**Scoring logic:** Starts at 0, adds 10 per condition met. Range: 0-20.

## Grade Letter Mapping

The CLI command (`src/cli/commands/grade.ts`) maps total percentage to letter grades:

| Grade | Threshold |
|-------|-----------|
| A | >= 90% |
| B | >= 75% |
| C | >= 60% |
| D | >= 45% |
| F | < 45% |

## Interface: CLI

### Grade a session

```bash
cleo grade <sessionId>
```

Output includes: sessionId, score, maxScore, percent, grade letter, per-dimension breakdown (name, score/max, evidence), flags, entryCount, timestamp.

### List all grades

```bash
cleo grade --list
cleo grade              # (no sessionId also lists)
```

Output includes: sessionId, score (e.g. `85/100`), percent, timestamp, flag count.

## Interface: MCP

### Grade a session

```
cleo_query admin grade { "sessionId": "<session-id>" }
```

- **Gateway:** query
- **Domain:** admin
- **Operation:** grade
- **Required params:** `sessionId` (string)
- **Tier:** 2
- **Returns:** Full `GradeResult` object

### List all grades

```
cleo_query admin grade.list
```

- **Gateway:** query
- **Domain:** admin
- **Operation:** grade.list
- **Required params:** none
- **Tier:** 2
- **Returns:** Array of `GradeResult` objects from `GRADES.jsonl`

## Environment Variables

| Variable | Set By | Purpose |
|----------|--------|---------|
| `CLEO_SESSION_GRADE` | `session.start(grade: true)` | When `"true"`, audit middleware logs query operations (not just mutations) |
| `CLEO_SESSION_GRADE_ID` | `session.start(grade: true)` | Session ID used by audit middleware to tag entries |
| `CLEO_SESSION_ID` | `session.start` | General session ID (set for all sessions, not just graded ones) |

These variables are set in `startSession()` when `options.grade` is truthy. They are **not** cleared by `endSession()` because `gradeSession()` needs them to query audit entries after session end. Cleanup is the caller's responsibility.

## Schema

Grade results conform to `schemas/grade.schema.json` (schema version `1.0.0`).

### GradeResult Structure

```json
{
  "sessionId": "session-1709...-abc123",
  "taskId": "T1234",
  "totalScore": 85,
  "maxScore": 100,
  "dimensions": {
    "sessionDiscipline": { "score": 20, "max": 20, "evidence": [...] },
    "discoveryEfficiency": { "score": 15, "max": 20, "evidence": [...] },
    "taskHygiene": { "score": 20, "max": 20, "evidence": [...] },
    "errorProtocol": { "score": 20, "max": 20, "evidence": [...] },
    "disclosureUse": { "score": 10, "max": 20, "evidence": [...] }
  },
  "flags": ["No MCP query calls (prefer cleo_query over CLI for programmatic access)"],
  "timestamp": "2026-03-01T12:00:00.000Z",
  "entryCount": 47,
  "evaluator": "auto"
}
```

### DimensionScore Structure

```json
{
  "score": 15,
  "max": 20,
  "evidence": ["find:list ratio 85% >= 80%", "tasks.show used 3x for detail"]
}
```

## Edge Cases

- **No audit entries:** If `sessionEntries.length === 0`, all dimensions score 0, a flag is added (`No audit entries found for session`), and the result is still persisted.
- **No task operations:** S1 session.list check passes if `firstListTime <= Infinity` (no task ops means list is always "before" task ops).
- **No discovery calls:** S2 awards 10 baseline points (benefit of doubt that no discovery was needed).
- **No adds:** S3 starts at 20 with no deductions.
- **No errors:** S4 starts at 20 with no deductions.
- **Grade file missing:** `readGrades()` returns `[]` if `GRADES.jsonl` does not exist.
- **Write failure:** `appendGradeResult()` catches errors silently (best-effort persistence).
