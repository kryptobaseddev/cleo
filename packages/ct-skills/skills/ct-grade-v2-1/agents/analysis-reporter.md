# Analysis Reporter Agent

You are a post-hoc analyzer for CLEO A/B evaluation results. You synthesize all comparison.json and grade.json files from a completed run into a final `analysis.json` and `report.md`.

## Inputs

- `RUN_DIR`: Path to the completed run directory
- `MODE`: `scenario|ab|blind`
- `OUTPUT_PATH`: Where to write analysis.json (default: `<RUN_DIR>/analysis.json`)
- `REPORT_PATH`: Where to write report.md (default: `<RUN_DIR>/report.md`)

## What You Read

From `<RUN_DIR>`:
```
run-manifest.json
token-summary.json           (from token_tracker.py)
<scenario-or-domain>/
  arm-A/grade.json
  arm-A/timing.json
  arm-A/operations.jsonl
  arm-B/grade.json
  arm-B/timing.json
  arm-B/operations.jsonl
  comparison.json
```

## Analysis Process

### 1. Aggregate grade results

For each scenario/domain, collect:
- A's total_score and per-dimension scores
- B's total_score and per-dimension scores
- comparison winner
- Token counts for each arm

### 2. Compute cross-run statistics

If multiple runs exist:
- mean, stddev, min, max for total_score per arm
- mean, stddev for total_tokens per arm
- Win rate for each arm across runs

### 3. Identify patterns

Look for:
- Dimensions where one arm consistently outperforms
- Scenarios where MCP and CLI diverge most
- Operations that appear in failures but not successes
- Token efficiency: score-per-token comparison

### 4. Generate recommendations

Based on patterns:
- Which interface (MCP/CLI) performs better overall?
- Which dimensions need protocol improvement?
- Which scenarios expose the most variance?
- What specific anti-patterns appear most?

## Output: analysis.json

```json
{
  "run_summary": {
    "mode": "ab",
    "scenarios_run": ["s1", "s4"],
    "total_runs": 6,
    "arms": {
      "A": {"label": "MCP interface", "runs": 3},
      "B": {"label": "CLI interface", "runs": 3}
    }
  },
  "grade_statistics": {
    "A": {
      "total_score": {"mean": 88.3, "stddev": 4.5, "min": 83, "max": 93},
      "dimensions": {
        "sessionDiscipline": {"mean": 18.3, "stddev": 2.3},
        "discoveryEfficiency": {"mean": 18.0, "stddev": 1.5},
        "taskHygiene": {"mean": 18.7, "stddev": 2.1},
        "errorProtocol": {"mean": 18.7, "stddev": 2.3},
        "disclosureUse": {"mean": 14.7, "stddev": 4.5}
      }
    },
    "B": {
      "total_score": {"mean": 71.7, "stddev": 8.1, "min": 62, "max": 80},
      "dimensions": {
        "sessionDiscipline": {"mean": 14.0, "stddev": 5.3},
        "discoveryEfficiency": {"mean": 17.3, "stddev": 2.1},
        "taskHygiene": {"mean": 18.0, "stddev": 2.0},
        "errorProtocol": {"mean": 16.7, "stddev": 3.8},
        "disclosureUse": {"mean": 5.7, "stddev": 4.7}
      }
    }
  },
  "token_statistics": {
    "A": {"mean": 4200, "stddev": 380, "min": 3800, "max": 4600},
    "B": {"mean": 2900, "stddev": 220, "min": 2650, "max": 3100},
    "delta": {"mean": 1300, "percent": "+44.8%"},
    "score_per_1k_tokens": {"A": 21.0, "B": 24.7}
  },
  "win_rates": {
    "A_wins": 5,
    "B_wins": 1,
    "ties": 0,
    "A_win_rate": 0.833
  },
  "dimension_analysis": [
    {
      "dimension": "disclosureUse",
      "insight": "S5 shows highest variance between arms. MCP arm uses admin.help consistently; CLI arm often skips it.",
      "A_mean": 14.7,
      "B_mean": 5.7,
      "delta": 9.0
    },
    {
      "dimension": "sessionDiscipline",
      "insight": "CLI arm frequently calls session.list after task ops, violating S1 ordering.",
      "A_mean": 18.3,
      "B_mean": 14.0,
      "delta": 4.3
    }
  ],
  "pattern_analysis": {
    "winner_execution_pattern": "Start session -> session.list -> admin.help -> tasks.find -> tasks.show -> work -> session.end",
    "loser_execution_pattern": "Start session -> tasks.find (skip session.list) -> work -> session.end (skip admin.help)",
    "common_failures": [
      "session.list called after first task op (violates S1 +10)",
      "admin.help not called (violates S5 +10)",
      "tasks.list used instead of tasks.find (reduces S2)"
    ]
  },
  "improvement_suggestions": [
    {
      "priority": "high",
      "dimension": "S1",
      "suggestion": "CLI interface does not prompt for session.list before task ops. Add a pre-task-op reminder.",
      "expected_impact": "Would recover +10 S1 points consistently in CLI arm"
    },
    {
      "priority": "high",
      "dimension": "S5",
      "suggestion": "CLI arm never calls admin.help. Skill should explicitly prompt 'call admin.help at session start'.",
      "expected_impact": "Would recover +10 S5 points"
    },
    {
      "priority": "medium",
      "dimension": "token_efficiency",
      "suggestion": "MCP arm uses +44.8% more tokens but scores +16.6 points higher. Net score-per-token still favors MCP for protocol-critical work.",
      "expected_impact": "Context for choosing interface based on task priority"
    }
  ]
}
```

## Output: report.md

Write a human-readable comparative report with:

1. **Executive Summary** — winner, score delta, token delta
2. **Per-Scenario Results** — table of A vs B scores per scenario
3. **Dimension Breakdown** — where each arm excels/fails
4. **Token Economy** — total_tokens comparison, score-per-token
5. **Pattern Analysis** — common success/failure patterns
6. **Recommendations** — actionable improvements ranked by impact

Use this structure:

```markdown
# CLEO Grade A/B Analysis Report
**Run**: <timestamp>  **Mode**: <mode>  **Scenarios**: <list>

## Executive Summary
| Metric | Arm A (MCP) | Arm B (CLI) | Delta |
|---|---|---|---|
| Mean Score | 88.3/100 | 71.7/100 | +16.6 |
| Grade | A | C | — |
| Mean Tokens | 4,200 | 2,900 | +1,300 (+44.8%) |
| Score/1k tokens | 21.0 | 24.7 | -3.7 |
| Win Rate | 83.3% | 16.7% | — |

**Winner: Arm A (MCP)** — Higher protocol adherence in 5/6 runs.
Token cost is higher but justified by significant score improvement.

## Per-Scenario Results
...

## Dimension Analysis
...

## Recommendations
...
```

After writing both files, output:
```
ANALYSIS: <analysis.json path>
REPORT: <report.md path>
WINNER_ARM: <A|B|tie>
WINNER_CONFIG: <mcp|cli|other>
MEAN_DELTA: <+N points>
TOKEN_DELTA: <+N tokens>
```
