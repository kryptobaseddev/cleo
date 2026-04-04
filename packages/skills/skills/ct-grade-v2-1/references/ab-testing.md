# Blind A/B Testing Protocol

Methodology for blind comparison of grade scenario results in CLEO.

> **Note**: MCP support was removed. All operations now use the CLI exclusively.
> This protocol compares different CLI configurations, binary versions, or parameter sets.

---

## Agent-Based Execution (Canonical)

The canonical A/B approach uses Claude Code Agents to run scenarios end-to-end via the CLI. This captures real token data from task notifications.

### Execution Flow

1. Run `python scripts/setup_run.py` to create run structure and print the execution plan
2. Follow the plan: spawn scenario-runner agents in parallel (arm-A, arm-B with different configurations)
3. Immediately capture `total_tokens` from each task notification to `timing.json`
4. Spawn blind-comparator agent after both arms complete
5. Run `python scripts/token_tracker.py --run-dir <dir>` to aggregate tokens
6. Run `python scripts/generate_report.py --run-dir <dir>` for final report

### Token Data from Task Notifications

```python
# After EACH agent task completes, fill timing.json immediately:
timing = {
  "total_tokens": task.total_tokens,   # EPHEMERAL -- capture now or lose it
  "duration_ms": task.duration_ms,
  "arm": "arm-A",
  "interface": "cli",
  "scenario": "s4",
  "run": 1,
}
```

Token data priority:
1. `total_tokens` from Claude Code Agent task notification (canonical)
2. OTel `claude_code.token.usage` (when `CLAUDE_CODE_ENABLE_TELEMETRY=1`)
3. `output_chars / 3.5` (JSON response estimate)
4. `entryCount x 150` (coarse proxy from GRADES.jsonl)

---

## Test Structure

```
ab-results/
  <timestamp>/
    meta.json               -- test parameters, domain, operations, runs
    run-001/
      side-a/
        request.json        -- what was sent
        response.json       -- raw response
        metrics.json        -- output_chars, duration_ms, success
      side-b/
        request.json
        response.json
        metrics.json
      comparison.json       -- blind comparator output (winner: A|B|TIE)
    run-002/
      ...
    summary.json            -- aggregated stats across all runs
    report.md               -- human-readable comparative analysis
```

---

## Blind Assignment

The `run_ab_test.py` script randomly shuffles which side gets labeled "A" vs "B" for each run. The comparator agent sees only:
- Output labeled "A"
- Output labeled "B"
- The original request prompt

The `meta.json` records the true identity per run. `generate_report.py` de-blinds after all comparisons are done.

---

## Metrics Captured Per Run

| Metric | How captured |
|--------|-------------|
| `output_chars` | `len(response_json_str)` |
| `estimated_tokens` | `output_chars / 4` (approximation) |
| `duration_ms` | wall clock from subprocess start to end |
| `success` | exit code 0 |
| `data_equivalent` | compare key fields between A and B response |

---

## Data Equivalence Check

For each operation, define "equivalent" as the key response fields matching:

```python
EQUIVALENCE_FIELDS = {
    "tasks.find":   ["data.tasks[].id", "data.total"],
    "tasks.show":   ["data.id", "data.status", "data.title"],
    "tasks.list":   ["data.tasks[].id"],
    "session.list": ["data.sessions[].id"],
    "session.status": ["data.currentSession.id", "data.hasActiveSession"],
    "admin.dash":   ["data.stats.total", "data.stats.active"],
    "admin.health": ["data.healthy"],
    "admin.stats":  ["data.totalTasks"],
}
```

Equivalence is checked before the blind comparison to flag data divergence independently of quality judgment.

---

## Statistical Analysis

After N runs, `generate_report.py` computes:

```json
{
  "wins": { "arm_a": 0, "arm_b": 0, "tie": 0 },
  "win_rate": { "arm_a": 0.0, "arm_b": 0.0 },
  "token_delta": {
    "mean_a_chars": 0,
    "mean_b_chars": 0,
    "delta_chars": 0,
    "delta_pct": "+0%"
  },
  "latency_delta": {
    "mean_a_ms": 0,
    "mean_b_ms": 0,
    "delta_ms": 0
  },
  "data_equivalence_rate": 1.0,
  "per_operation": { ... }
}
```

**Recommended minimum runs:** 3 per operation for trend detection, 10+ for statistical confidence.

---

## Comparator Rubric

The blind comparator evaluates each side on:

| Criterion | Description |
|-----------|-------------|
| **Completeness** | Does the response contain all expected fields? |
| **Structure** | Is the response well-formed JSON? Clean envelope? |
| **Usability** | Can an agent consume this without post-processing? |
| **Verbosity** | Lower is better -- same data, fewer chars = more efficient |

Rubric scores are 1-5 per criterion. Winner is the side with higher weighted total.

---

## CLI Invocation

All operations use the CLI:

```bash
cleo-dev <command> [args] --json
```

---

## Interpreting Results

| Outcome | Meaning | Action |
|---------|---------|--------|
| Arm A wins consistently | Configuration A output is cleaner/more complete | Investigate differences |
| Arm B wins consistently | Configuration B output is more complete or parseable | Investigate differences |
| Tie | Both equivalent | Focus on latency and token cost |
| Data divergence detected | Arms returning different data | File bug -- should be consistent |
