# Blind A/B Testing Protocol

Methodology for blind comparison of MCP vs CLI interface usage in CLEO.

---

## Agent-Based Execution (Canonical)

The canonical A/B approach uses Claude Code Agents to run scenarios end-to-end via the live MCP/CLI interfaces. This avoids subprocess initialization issues and captures real token data from task notifications.

### Execution Flow

1. Run `python scripts/setup_run.py` to create run structure and print the execution plan
2. Follow the plan: spawn scenario-runner agents in parallel (arm-A MCP, arm-B CLI)
3. Immediately capture `total_tokens` from each task notification → `timing.json`
4. Spawn blind-comparator agent after both arms complete
5. Run `python scripts/token_tracker.py --run-dir <dir>` to aggregate tokens
6. Run `python scripts/generate_report.py --run-dir <dir>` for final report

### Token Data from Task Notifications

```python
# After EACH agent task completes, fill timing.json immediately:
timing = {
  "total_tokens": task.total_tokens,   # EPHEMERAL — capture now or lose it
  "duration_ms": task.duration_ms,
  "arm": "arm-A",
  "interface": "mcp",
  "scenario": "s4",
  "run": 1,
}
```

Token data priority:
1. `total_tokens` from Claude Code Agent task notification (canonical)
2. OTel `claude_code.token.usage` (when `CLAUDE_CODE_ENABLE_TELEMETRY=1`)
3. `output_chars / 3.5` (JSON response estimate)
4. `entryCount × 150` (coarse proxy from GRADES.jsonl)

---

## Subprocess-Based Execution (Fallback)

For automated testing without agent delegation, use `run_ab_test.py`. This invokes CLEO via subprocess and requires a migrated `tasks.db`.

---

## What We're Testing

| Side | Interface | Mechanism |
|------|-----------|-----------|
| **A** (MCP) | JSON-RPC via stdio to CLEO MCP server | `node dist/mcp/index.js` with JSON-RPC messages |
| **B** (CLI) | Shell commands via subprocess | `cleo-dev <domain> <operation> [params]` |

Both sides call the same underlying `src/dispatch/` layer. The A/B test isolates:
- **Output format differences** — MCP returns structured JSON envelopes; CLI may add ANSI/formatting
- **Response size** — character counts as token proxy
- **Latency** — wall-clock time per operation
- **Data equivalence** — do they return the same logical data?

Blind assignment means the comparator does not know which result came from MCP vs CLI when producing the quality verdict.

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
- Output labeled "A" (could be MCP or CLI)
- Output labeled "B" (could be MCP or CLI)
- The original request prompt

The `meta.json` records the true identity (`a_is_mcp: true|false`) per run. `generate_report.py` de-blinds after all comparisons are done.

---

## Metrics Captured Per Run

| Metric | How captured |
|--------|-------------|
| `output_chars` | `len(response_json_str)` |
| `estimated_tokens` | `output_chars / 4` (approximation) |
| `duration_ms` | wall clock from subprocess start to end |
| `success` | `response.success === true` (MCP) or exit code 0 (CLI) |
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
  "wins": { "mcp": 0, "cli": 0, "tie": 0 },
  "win_rate": { "mcp": 0.0, "cli": 0.0 },
  "token_delta": {
    "mean_mcp_chars": 0,
    "mean_cli_chars": 0,
    "delta_chars": 0,
    "delta_pct": "+0%"
  },
  "latency_delta": {
    "mean_mcp_ms": 0,
    "mean_cli_ms": 0,
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
| **Verbosity** | Lower is better — same data, fewer chars = more efficient |

Rubric scores are 1–5 per criterion. Winner is the side with higher weighted total.

---

## MCP Server Invocation Details

The `run_ab_test.py` script calls the CLEO MCP server via stdio JSON-RPC:

```python
# Protocol sequence
# 1. Send initialize
# 2. Send tools/call (query or mutate)
# 3. Read response lines until tool result found
# 4. Terminate process

MCP_INIT = {
  "jsonrpc": "2.0", "id": 0, "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": {"name": "ct-grade-ab-test", "version": "2.1.0"}
  }
}

MCP_CALL = {
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "query",  # or "mutate"
    "arguments": {
      "domain": "<domain>",
      "operation": "<operation>",
      "params": {}
    }
  }
}
```

**CLI equivalent:**
```bash
cleo-dev <domain> <operation> [args] --json
```

---

## Interpreting Results

| Outcome | Meaning | Action |
|---------|---------|--------|
| MCP wins consistently | MCP output is cleaner/more complete | Recommend MCP-first in agent protocols |
| CLI wins consistently | CLI output is more complete or parseable | Investigate MCP envelope overhead |
| Tie | Both equivalent | Focus on latency and token cost |
| MCP tokens > CLI tokens | MCP envelope adds overhead | Quantify and document in CLEO-GRADE-SPEC |
| Data divergence detected | MCP and CLI returning different data | File bug — should be dispatch-level consistent |

---

## Parity Scenarios

The P1-P3 parity scenarios (see playbook-v2.md) run a curated set of operations specifically chosen to stress:
- **P1**: tasks domain — high-frequency agent operations
- **P2**: session domain — lifecycle operations agents use at start/end
- **P3**: admin domain — help, dash, health (first calls in any session)
