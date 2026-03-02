---
name: ct-grade
description: Session grading for agent behavioral analysis. Use when evaluating agent session quality, running grade scenarios, or interpreting grade results. Triggers on grading tasks, session quality checks, or behavioral analysis needs.
version: 1.0.0
tier: 2
core: false
category: quality
protocol: null
dependencies: []
sharedResources: []
compatibility:
  - claude-code
  - cursor
  - windsurf
  - gemini-cli
license: MIT
---

# Session Grading Guide

Session grading evaluates agent behavioral patterns against the CLEO protocol. It reads the audit log for a completed session and applies a 5-dimension rubric to produce a score (0-100), letter grade (A-F), and diagnostic flags.

## When to Use Grade Mode

Use grading when you need to:
- Evaluate how well an agent followed CLEO protocol during a session
- Identify behavioral anti-patterns (skipped discovery, missing session.end, etc.)
- Track improvement over time across multiple sessions
- Validate that orchestrated subagents followed protocol

Grading requires audit data. Sessions must be started with the `--grade` flag to enable audit log capture.

## Starting a Grade Session

### CLI

```bash
# Start a session with grading enabled
ct session start --scope epic:T001 --name "Feature work" --grade

# The --grade flag enables detailed audit logging
# All MCP and CLI operations are recorded for later analysis
```

### MCP

```
cleo_mutate({ domain: "session", operation: "start",
  params: { scope: "epic:T001", name: "Feature work", grade: true }})
```

## Running Scenarios

The grading rubric evaluates 5 behavioral scenarios that map to protocol compliance:

### 1. Fresh Discovery
Tests whether the agent checks existing sessions and tasks before starting work. Evaluates `session.list` and `tasks.find` calls at session start.

### 2. Task Hygiene
Tests whether task creation follows protocol: descriptions provided, parent existence verified before subtask creation, no duplicate tasks.

### 3. Error Recovery
Tests whether the agent handles errors correctly: follows up `E_NOT_FOUND` with recovery lookups (`tasks.find` or `tasks.exists`), avoids duplicate creates after failures.

### 4. Full Lifecycle
Tests session discipline end-to-end: session listed before task ops, session properly ended, MCP-first usage patterns.

### 5. Multi-Domain Analysis
Tests progressive disclosure: use of `admin.help` or skill lookups, preference for `cleo_query` (MCP) over CLI for programmatic access.

## Evaluating Results

### CLI

```bash
# Grade a specific session
ct grade <sessionId>

# List all past grade results
ct grade --list
```

### MCP

```
# Grade a session
cleo_query({ domain: "admin", operation: "grade",
  params: { sessionId: "abc-123" }})

# List past grades
cleo_query({ domain: "admin", operation: "grade.list" })
```

## Understanding the 5 Dimensions

Each dimension scores 0-20 points, totaling 0-100.

### S1: Session Discipline (20 pts)

| Points | Criteria |
|--------|----------|
| 10 | `session.list` called before first task operation |
| 10 | `session.end` called when work is complete |

**What it measures**: Does the agent check existing sessions before starting, and properly close sessions when done?

### S2: Discovery Efficiency (20 pts)

| Points | Criteria |
|--------|----------|
| 0-15 | `find:list` ratio >= 80% earns full 15; scales linearly below |
| 5 | `tasks.show` used for detail retrieval |

**What it measures**: Does the agent prefer `tasks.find` (low context cost) over `tasks.list` (high context cost) for discovery?

### S3: Task Hygiene (20 pts)

Starts at 20 and deducts for violations:

| Deduction | Violation |
|-----------|-----------|
| -5 each | `tasks.add` without a description |
| -3 | Subtasks created without `tasks.exists` parent check |

**What it measures**: Does the agent create well-formed tasks with descriptions and verify parents before creating subtasks?

### S4: Error Protocol (20 pts)

Starts at 20 and deducts for violations:

| Deduction | Violation |
|-----------|-----------|
| -5 each | `E_NOT_FOUND` error not followed by recovery lookup within 5 ops |
| -5 | Duplicate task creates detected (same title in session) |

**What it measures**: Does the agent recover gracefully from errors and avoid creating duplicate tasks?

### S5: Progressive Disclosure Use (20 pts)

| Points | Criteria |
|--------|----------|
| 10 | `admin.help` or skill lookup calls made |
| 10 | `cleo_query` (MCP gateway) used for programmatic access |

**What it measures**: Does the agent use progressive disclosure (help/skills) and prefer MCP over CLI?

## Interpreting Scores

### Letter Grades

| Grade | Score Range | Meaning |
|-------|-----------|---------|
| **A** | 90-100 | Excellent protocol adherence. Agent follows all best practices. |
| **B** | 75-89 | Good. Minor gaps in one or two dimensions. |
| **C** | 60-74 | Acceptable. Several protocol violations need attention. |
| **D** | 45-59 | Below expectations. Significant anti-patterns present. |
| **F** | 0-44 | Failing. Major protocol violations across multiple dimensions. |

### Reading the Output

The grade result includes:
- **score/maxScore**: Raw numeric score (e.g., `85/100`)
- **percent**: Percentage score
- **grade**: Letter grade (A-F)
- **dimensions**: Per-dimension breakdown with score, max, and evidence
- **flags**: Specific violations or improvement suggestions
- **entryCount**: Number of audit entries analyzed

### Flags

Flags are actionable diagnostic messages. Each flag identifies a specific behavioral issue:

- `session.list never called` -- Check existing sessions before starting new ones
- `session.end never called` -- Always end sessions when done
- `tasks.list used Nx` -- Prefer `tasks.find` for discovery
- `tasks.add without description` -- Always provide task descriptions
- `Subtasks created without tasks.exists parent check` -- Verify parent exists first
- `E_NOT_FOUND not followed by recovery lookup` -- Follow errors with `tasks.find` or `tasks.exists`
- `No admin.help or skill lookup calls` -- Load `ct-cleo` for protocol guidance
- `No MCP query calls` -- Prefer `cleo_query` over CLI

## Common Anti-patterns

| Anti-pattern | Impact | Fix |
|-------------|--------|-----|
| Skipping `session.list` at start | -10 S1 | Always check existing sessions first |
| Forgetting `session.end` | -10 S1 | End sessions when work is complete |
| Using `tasks.list` instead of `tasks.find` | -up to 15 S2 | Use `find` for discovery, `list` only for known parent children |
| Creating tasks without descriptions | -5 each S3 | Always provide a description with `tasks.add` |
| Ignoring `E_NOT_FOUND` errors | -5 each S4 | Follow up with `tasks.find` or `tasks.exists` |
| Creating duplicate tasks | -5 S4 | Check for existing tasks before creating new ones |
| Never using `admin.help` | -10 S5 | Use progressive disclosure for protocol guidance |
| CLI-only usage (no MCP) | -10 S5 | Prefer `cleo_query`/`cleo_mutate` for programmatic access |

## Grade Result Schema

Grade results are stored in `.cleo/metrics/GRADES.jsonl` as append-only JSONL. Each entry conforms to `schemas/grade.schema.json` with these fields:

- `sessionId` (string, required) -- Session that was graded
- `taskId` (string, optional) -- Associated task ID
- `totalScore` (number, 0-100) -- Aggregate score
- `maxScore` (number, default 100) -- Maximum possible score
- `dimensions` (object) -- Per-dimension `{ score, max, evidence[] }`
- `flags` (string[]) -- Specific violations or suggestions
- `timestamp` (ISO 8601) -- When the grade was computed
- `entryCount` (number) -- Audit entries analyzed
- `evaluator` (`auto` | `manual`) -- How the grade was computed

## MCP Operations

| Gateway | Domain | Operation | Description |
|---------|--------|-----------|-------------|
| `cleo_query` | `admin` | `grade` | Grade a session (`params: { sessionId }`) |
| `cleo_query` | `admin` | `grade.list` | List all past grade results |
