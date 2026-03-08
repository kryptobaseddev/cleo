# CLEO Grade Specification (Current)

**Source**: `src/core/sessions/session-grade.ts`
**Spec**: `docs/specs/CLEO-GRADE-SPEC.md`
**Status**: Active

This document reflects the **current rubric implementation** as of v2026.3.x. It is derived from the live source code, not the original spec (which may be outdated).

---

## Data Flow

```
session.start(grade: true)
  -> CLEO_SESSION_GRADE=true (env)
  -> audit middleware logs ALL ops (query + mutate)
session.end
  -> query check grade { sessionId }   # canonical registry surface
  -> query admin grade { sessionId }   # runtime compatibility alias
  -> Reads audit_log from tasks.db
  -> Applies 5-dimension rubric
  -> Appends to .cleo/metrics/GRADES.jsonl
```

Audit log entries in `tasks.db` contain:
- `domain`, `operation`, `timestamp`
- `params` (the operation parameters)
- `result.success` (boolean)
- `result.exitCode` (number; 4 = E_NOT_FOUND)
- `metadata.gateway` (`"query"` | `"mutate"`)
- `metadata.taskId` (if set)

---

## Dimension 1: Session Discipline (20 pts)

**Source**: Lines 73-105 in session-grade.ts

```
sessionListCalls = entries where domain='session' AND operation='list'
sessionEndCalls  = entries where domain='session' AND operation='end'
taskOps          = entries where domain='tasks'
```

| Points | Condition |
|--------|-----------|
| +10 | `session.list` called AND first list timestamp ≤ first tasks op timestamp |
| +10 | `session.end` called at least once |

**Flags on violation:**
- `session.list never called (check existing sessions before starting)` — no session.list found
- `session.list called after task ops (should check sessions first)` — exists but wrong order
- `session.end never called (always end sessions when done)` — no session.end

**Edge cases:**
- No task ops: `firstTaskTime = Infinity`, so session.list always satisfies the ordering check
- Range: 0-20

---

## Dimension 2: Discovery Efficiency (20 pts)

**Source**: Lines 107-144

```
findCalls  = entries where domain='tasks' AND operation='find'
listCalls  = entries where domain='tasks' AND operation='list'
showCalls  = entries where domain='tasks' AND operation='show'
totalDiscoveryCalls = findCalls.length + listCalls.length
```

| Points | Condition |
|--------|-----------|
| +10 baseline | `totalDiscoveryCalls === 0` (no discovery needed) |
| proportional 0-15 | `round(15 * findRatio)` where `findRatio = findCalls / totalDiscoveryCalls` |
| full 15 | when `findRatio >= 0.80` |
| +5 | `tasks.show` used at least once |

**Cap**: `Math.min(20, score)` — maximum 20 points

**Flags on violation:**
- `tasks.list used Nx (prefer tasks.find for discovery)` — when findRatio < 0.80

**Note**: `tasks.list` with filters (for known parent children) is acceptable but still counted toward the ratio.

---

## Dimension 3: Task Hygiene (20 pts)

**Source**: Lines 146-180

```
addCalls     = entries where domain='tasks' AND operation='add' AND result.success=true
existsCalls  = entries where domain='tasks' AND operation='exists'
subtaskAdds  = addCalls where params.parent is truthy
```

**Starts at 20, deducts penalties:**

| Deduction | Condition |
|-----------|-----------|
| -5 per add | `tasks.add` succeeded but `params.description` is empty/missing |
| -3 | subtaskAdds > 0 AND existsCalls = 0 (no parent verification) |

**Evidence (no deduction):**
- `All N tasks.add calls had descriptions` — when no description violations
- `Parent existence verified before subtask creation` — subtask adds with exists check

**Floor**: `Math.max(0, score)` — cannot go below 0

---

## Dimension 4: Error Protocol (20 pts)

**Source**: Lines 182-215

```
notFoundErrors = entries where result.success=false AND result.exitCode=4
```

For each E_NOT_FOUND error at index `errIdx`:
```
nextEntries = sessionEntries[errIdx+1 .. errIdx+5]
hasRecovery = nextEntries contains (domain='tasks' AND operation IN ['find','exists'])
```

**Duplicate detection:**
```
creates = entries where domain='tasks' AND operation='add' AND result.success=true
titles  = creates.map(e => e.params.title.toLowerCase().trim())
duplicates = titles.length - new Set(titles).size
```

**Starts at 20, deducts penalties:**

| Deduction | Condition |
|-----------|-----------|
| -5 per error | E_NOT_FOUND not followed by `tasks.find` or `tasks.exists` within 4 entries |
| -5 | Any duplicate task creates detected (title collision within session) |

**Floor**: `Math.max(0, score)`

---

## Dimension 5: Progressive Disclosure Use (20 pts)

**Source**: Lines 217-249

```
helpCalls = entries where:
  (domain='admin' AND operation='help')
  OR (domain='tools' AND operation IN ['skill.show','skill.list'])
  OR (domain='skills' AND operation IN ['list','show'])

mcpQueryCalls = entries where metadata.gateway = 'query'
```

| Points | Condition |
|--------|-----------|
| +10 | `helpCalls.length > 0` |
| +10 | `mcpQueryCalls.length > 0` |

**Flags on violation:**
- `No admin.help or skill lookup calls (load ct-cleo for guidance)`
- `No MCP query calls (prefer query over CLI for programmatic access)`

**Important**: The `metadata.gateway` field equals `'query'` for MCP query operations. CLI operations do not set this field. This is how MCP vs CLI usage is distinguished in the grade.

---

## Grade Letter Mapping

| Grade | Threshold | Score Range |
|-------|-----------|-------------|
| A | ≥90% | 90-100 |
| B | ≥75% | 75-89 |
| C | ≥60% | 60-74 |
| D | ≥45% | 45-59 |
| F | <45% | 0-44 |

---

## GradeResult Schema

```typescript
interface GradeResult {
  sessionId: string;
  taskId?: string;
  totalScore: number;          // 0-100
  maxScore: number;            // 100
  dimensions: {
    sessionDiscipline:   DimensionScore; // score, max:20, evidence[]
    discoveryEfficiency: DimensionScore;
    taskHygiene:         DimensionScore;
    errorProtocol:       DimensionScore;
    disclosureUse:       DimensionScore;
  };
  flags: string[];
  timestamp: string;           // ISO 8601
  entryCount: number;
  evaluator?: 'auto' | 'manual';
}
```

---

## Edge Cases

| Case | Behavior |
|------|----------|
| No audit entries | All scores 0, flag: `No audit entries found for session` |
| No task ops | S1 list check always passes (firstTaskTime=Infinity) |
| No discovery calls | S2 awards 10 baseline points |
| No task.add calls | S3 starts at 20 with no deductions |
| No errors | S4 starts at 20 with no deductions |
| GRADES.jsonl missing | readGrades() returns [] |
| Write failure | Silently ignored (best-effort persistence) |

---

## MCP vs CLI Detection in S5

The grading system detects MCP usage via `metadata.gateway === 'query'`. This means:
- **MCP interface**: All query operations set `metadata.gateway = 'query'` → S5 gets +10
- **CLI interface**: CLI operations do NOT set metadata.gateway → S5 loses +10
- **Mixed**: Any single MCP query call is enough for the +10

This is why A/B tests between MCP and CLI interfaces will reliably show S5 differences.


## API Surface Update

- Canonical reads now live under `check.grade` and `check.grade.list`.
- `admin.grade` and `admin.grade.list` remain compatibility handlers during the registry transition.
- Token telemetry should be read through `admin.token` with `action=summary|list|show` rather than inferring split legacy operations.
- Web clients should use `POST /api/query` and `POST /api/mutate`; default HTTP responses carry LAFS metadata in `X-Cleo-*` headers.
