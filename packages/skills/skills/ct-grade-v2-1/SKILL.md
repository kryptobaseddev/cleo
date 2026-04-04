---
name: ct-grade
description: >-
  CLEO session grading and A/B behavioral analysis with token tracking. Evaluates agent
  session quality via a 5-dimension rubric (S1 session discipline, S2 discovery efficiency,
  S3 task hygiene, S4 error protocol, S5 progressive disclosure). Supports three modes:
  (1) scenario — run playbook scenarios S1-S5 via CLI; (2) ab — blind A/B
  comparison of different CLI configurations for same domain operations with token cost
  measurement; (3) blind — spawn two agents with different configurations, blind-comparator
  picks winner, analyzer produces recommendation. Use when grading agent sessions, running
  grade playbook scenarios, comparing behavioral differences, measuring token
  usage across configurations, or performing multi-run blind A/B evaluation with statistical
  analysis and comparative report. Triggers on: grade session, evaluate agent behavior,
  A/B test CLEO configurations, run grade scenario, token usage analysis, behavioral rubric,
  protocol compliance scoring.
argument-hint: "[mode=scenario|ab|blind] [scenario=s1-s5|all] [runs=N] [session-id=<id>]"
allowed-tools: ["Bash(python *)", "Bash(cleo-dev *)", "Bash(cleo *)", "Bash(kill *)", "Bash(lsof *)", "Agent", "Read", "Write", "Glob"]
---

# ct-grade v2.1 — CLEO Grading and A/B Testing

Session grading and A/B behavioral analysis for CLEO protocol compliance. Three operating modes cover everything from single-session scoring to multi-run blind comparisons between different CLI configurations.

## On Every /ct-grade Invocation

Before parsing arguments, start the grade viewer server:

```bash
# Kill any existing viewer on port 3119
lsof -ti :3119 | xargs kill -TERM 2>/dev/null || true

# Start grade viewer in background
python $CLAUDE_SKILL_DIR/grade-viewer/generate_grade_review.py . \
  --port 3119 --no-browser &
echo "Grade viewer: http://localhost:3119"
```

When user says "end grading", "stop", "done", or "close viewer":
```bash
lsof -ti :3119 | xargs kill -TERM 2>/dev/null || true
echo "Grade viewer stopped."
```

---

## Operating Modes

| Mode | Purpose | Key Output |
|---|---|---|
| `scenario` | Run playbook scenarios S1-S5 as graded sessions | GradeResult per scenario |
| `ab` | Run same domain operations with two configurations, compare | comparison.json + token delta |
| `blind` | Two agents run same task, blind comparator picks winner | analysis.json + winner |

## Parameters

| Parameter | Values | Default | Description |
|---|---|---|---|
| `mode` | `scenario\|ab\|blind` | `scenario` | Operating mode |
| `scenario` | `s1\|s2\|s3\|s4\|s5\|all` | `all` | Grade playbook scenario(s) to run |
| `interface` | `cli` | `cli` | Interface to exercise (CLI only) |
| `domains` | comma list | `tasks,session` | Domains to test in `ab` mode |
| `runs` | integer | `3` | Runs per configuration for statistical confidence |
| `session-id` | string | — | Grade a specific existing session (skips execution) |
| `output-dir` | path | `ab_results/<ts>` | Where to write all run artifacts |

## Quick Start

**Grade an existing session:**
```
/ct-grade session-id=<id>
```

**Run scenario S4 (Full Lifecycle):**
```
/ct-grade mode=scenario scenario=s4
```

**A/B compare two configurations for tasks + session domains (3 runs each):**
```
/ct-grade mode=ab domains=tasks,session runs=3
```

**Full blind A/B test across all scenarios:**
```
/ct-grade mode=blind scenario=all runs=3
```

---

## Execution Flow

### Mode: scenario

1. Set up output dir with `python $CLAUDE_SKILL_DIR/scripts/setup_run.py --mode scenario --scenario <id> --output-dir <dir>`
2. For each scenario, spawn a `scenario-runner` agent:
   - Agent start: `cleo session start --scope global --name "<scenario-id>" --grade`
   - Agent executes the scenario operations (see [references/playbook-v2.md](references/playbook-v2.md))
   - Agent end: `cleo session end`
   - Agent runs: `ct grade <sessionId>`
   - Agent saves: `GradeResult` to `<output-dir>/<scenario>/grade.json`
3. Capture `total_tokens` + `duration_ms` from task notification → `timing.json`
4. Run: `python $CLAUDE_SKILL_DIR/scripts/generate_report.py --run-dir <dir> --mode scenario`

### Mode: ab

1. Set up run dir with `python $CLAUDE_SKILL_DIR/scripts/setup_run.py --mode ab --output-dir <dir>`
2. For each target domain, spawn TWO agents in the SAME turn:
   - **Arm A**: `agents/scenario-runner.md` with configuration A
   - **Arm B**: `agents/scenario-runner.md` with configuration B
   - Capture tokens from both task notifications immediately
3. Pass both outputs to `agents/blind-comparator.md` (does NOT know which configuration is which)
4. Comparator writes `comparison.json`
5. Run `python $CLAUDE_SKILL_DIR/scripts/generate_report.py --run-dir <dir> --mode ab`

### Mode: blind

Same as `ab` but configurations may differ (e.g., different session scopes, different agent prompts). The comparator is always blind to configuration identity.

---

## Token Capture — MANDATORY

After EVERY Agent task notification, immediately update `timing.json`:

```python
timing = {
  "total_tokens": task.total_tokens,     # from task notification — EPHEMERAL
  "duration_ms": task.duration_ms,       # from task notification
  "arm": "arm-A",
  "interface": "cli",
  "scenario": "s4",
  "run": 1,
  "executor_start": start_iso,
  "executor_end": end_iso,
}
# Write to: <output-dir>/<scenario>/arm-<interface>/timing.json
```

**`total_tokens` is EPHEMERAL** — it cannot be recovered if missed. Capture it immediately.

If running without task notifications (no total_tokens available):
- Fall back: `output_chars / 3.5` from operations.jsonl (JSON responses)
- Record `"method": "output_chars_estimate"` in timing.json

---

## Grade Rubric Summary

5 dimensions × 20 pts = 100 max. See [references/grade-spec-v2.md](references/grade-spec-v2.md) for full scoring logic.

| Dim | Points | What it measures |
|---|---|---|
| S1 Session Discipline | 20 | `session.list` before task ops (+10), `session.end` present (+10) |
| S2 Discovery Efficiency | 20 | `find:list` ratio ≥80% (+15), `tasks.show` used (+5) |
| S3 Task Hygiene | 20 | Starts 20, -5 per add without description, -3 if subtask no exists check |
| S4 Error Protocol | 20 | Starts 20, -5 per unrecovered E_NOT_FOUND, -5 if duplicates |
| S5 Progressive Disclosure | 20 | `admin.help`/skill lookup (+10), progressive disclosure used (+10) |

**Grade letters:** A>=90, B>=75, C>=60, D>=45, F<45

---

## Output Structure

```
<output-dir>/
  run-manifest.json          # run config, arms, timing summary
  report.md                  # human-readable comparative report
  token-summary.json         # aggregated token stats across all runs
  <scenario-or-domain>/
    arm-A/
      grade.json             # GradeResult (from check.grade)
      timing.json            # token + duration data
      operations.jsonl       # operations executed (one per line)
    arm-B/
      grade.json
      timing.json
      operations.jsonl
    comparison.json          # blind comparator output
    analysis.json            # analyzer output
```

---

## Agents

| Agent | Role | Input | Output |
|---|---|---|---|
| [agents/scenario-runner.md](agents/scenario-runner.md) | Executes grade scenario | scenario, interface | grade.json, timing.json |
| [agents/blind-comparator.md](agents/blind-comparator.md) | Blind A/B judge | outputs A and B | comparison.json |
| [agents/analysis-reporter.md](agents/analysis-reporter.md) | Post-hoc synthesis | all comparison.json | analysis.json |

---

## Scripts

```bash
# Set up run directory and print execution plan
python $CLAUDE_SKILL_DIR/scripts/setup_run.py --mode <mode> --scenario <s> --output-dir <dir>

# Aggregate token data after runs complete
python $CLAUDE_SKILL_DIR/scripts/token_tracker.py --run-dir <dir>

# Generate final report (markdown)
python $CLAUDE_SKILL_DIR/scripts/generate_report.py --run-dir <dir> --mode <mode>
```

---

## Viewers

### Grade Results Viewer (A/B run artifacts) — port 3119
```bash
python $CLAUDE_SKILL_DIR/grade-viewer/generate_grade_viewer.py --run-dir <ab-run-dir>
python $CLAUDE_SKILL_DIR/grade-viewer/generate_grade_viewer.py --run-dir <ab-run-dir> --static results.html
```
Shows per-scenario grade cards with dimension bars, A/B comparison tables, token economy stats, blind comparator results, and recommendations. Refreshes on browser reload.

### General Grade Review (GRADES.jsonl browsing) — port 3119
```bash
python $CLAUDE_SKILL_DIR/grade-viewer/generate_grade_review.py <workspace>
python $CLAUDE_SKILL_DIR/grade-viewer/generate_grade_review.py <workspace> --static grade-report.html
```
Shows historical grades from GRADES.jsonl, A/B summaries from any workspace subdirectory.

---

## CLI Grade Operations

| Command | Description |
|---------|-------------|
| `ct grade <sessionId>` | Grade a specific session |
| `ct grade --list` | List past grade results |
| `ct session start --scope global --name "<n>" --grade` | Start graded session |
| `ct session end` | End session |
