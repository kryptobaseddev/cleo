# A/B Test Methodology

## Overview

The ct-grade A/B framework compares two configurations (arms) of CLEO agent behavior using the 5-dimension behavioral rubric as the scoring criterion. The framework is blind: the comparator agent does not know which arm is which configuration.

---

## Core Concepts

### Arms

An "arm" is a specific test configuration. In CLEO A/B tests, the two most common arms are:

| Arm | Typical Config | Example |
|-----|---------------|---------|
| A | MCP gateway | Uses `query`/`mutate` for all operations |
| B | CLI fallback | Uses `cleo-dev` CLI for equivalent operations |

Arms can also differ by:
- Session scope (`global` vs `epic:T500`)
- Tier escalation (with/without `admin.help`)
- Agent persona (orchestrator vs task-executor)
- Prompt configuration (with/without ct-cleo skill)

### Slots

A "slot" is one test unit — either a grade scenario (s1-s5) or a domain (tasks, session, etc.) depending on mode. Each slot produces one comparison.

### Runs

The number of times each arm executes each slot. Multiple runs increase statistical confidence. Minimum recommended: 3 runs.

---

## Blind Protocol

1. **Orchestrator spawns both arms in the same turn** — this is critical for parallel execution and prevents the orchestrator's context from being polluted by one arm's output before spawning the other.

2. **Arm outputs are labeled A and B only** — the arm label (A/B) is used, not the configuration label (mcp/cli). The comparator never sees "MCP" or "CLI" in the output it receives.

3. **Comparator reads only grade.json and operations.jsonl** — not timing.json (which contains the `interface` field). This enforces blindness.

4. **Analysis-reporter de-blinds** — after all comparisons are done, the reporter reveals which arm was which configuration and synthesizes patterns.

---

## Token Tracking Protocol

Token data comes from Claude Code task notifications. You MUST capture it immediately — it is ephemeral.

### Capture Point

When an Agent task completes, the notification includes:
- `total_tokens`: Total tokens consumed by the subagent task
- `duration_ms`: Wall clock time for the task

### Storage

Immediately on task completion, update the arm's `timing.json`:

```python
# Pseudocode — actual capture is in main context
timing = load_json(arm_dir + "/timing.json")
timing["total_tokens"] = task.total_tokens    # from notification
timing["duration_ms"] = task.duration_ms      # from notification
timing["executor_end"] = now_iso()
timing["executor_duration_seconds"] = task.duration_ms / 1000
save_json(arm_dir + "/timing.json", timing)
```

### Why This Matters

Token cost is the primary economic metric for comparing interfaces:
- MCP operations may use more tokens (richer responses, metadata)
- CLI operations may use fewer tokens but score lower on S5
- Score-per-token tells you which interface is more efficient for protocol work

### Missing Token Data

If you forgot to capture tokens, you cannot recover them. Mark `total_tokens: null` in timing.json. The token_tracker.py script will warn about missing data. Run statistics will exclude null values.

---

## Statistical Interpretation

### Minimum Confidence

- **1 run**: No statistical confidence, anecdotal
- **3 runs**: Low confidence, sufficient for directional signal
- **5+ runs**: Moderate confidence, suitable for decisions
- **10+ runs**: High confidence, publication-grade

### Score Interpretation

| Score Delta | Interpretation |
|-------------|----------------|
| 0-5 pts | Noise level — likely equivalent |
| 5-15 pts | Meaningful difference — investigate flags |
| 15-25 pts | Significant — one interface clearly better |
| 25+ pts | Extreme — likely S5 differential (MCP vs CLI) |

### Expected MCP vs CLI Delta

Based on the rubric implementation:
- S5 Progressive Disclosure: always +20 for MCP (if admin.help called), +10 MCP no help, 0 CLI
- S1-S4: approximately equal if agent follows same protocol steps
- Total expected delta: **+10 to +20 points** in favor of MCP for equivalent protocols

If delta exceeds 20 points, investigate whether the CLI agent is also skipping other protocol steps (session.list, descriptions, etc.) due to lack of guidance.

---

## Git Tree Comparison

The "git tree" metaphor: each A/B run produces a branch in the results tree. Multiple runs of the same configuration are like commits on the same branch.

```
ab_results/
  run-001/           ← first full A/B run
    s4/
      run-01/arm-A/  ← first run, MCP arm
      run-01/arm-B/  ← first run, CLI arm
      run-01/comparison.json
      run-02/arm-A/
      ...
    token-summary.json
    report.md
  run-002/           ← second full A/B run (compare against run-001)
    ...
```

To compare **across A/B runs** (e.g., after making a protocol change):
1. Generate report for run-001
2. Make protocol change
3. Run run-002
4. Compare report.md files

---

## Anti-patterns in A/B Testing

| Anti-pattern | Problem | Fix |
|---|---|---|
| Sequential arms | Arm B's spawn might be influenced by A's output | Spawn both arms in same message |
| Comparator sees config | Breaks blindness | Pass only grade.json + operations.jsonl |
| Single run | No variance data | Minimum 3 runs |
| Same session scope | Arms share audit data | Each arm starts a new `session.start { grade: true }` |
| Forgetting to capture tokens | Cannot reconstruct | Write timing.json IMMEDIATELY on task completion |
| Comparing different scenarios | Apples vs oranges | Fix scenario parameter, vary interface only |
