# Token Tracking Methodology

How to measure and report token usage for CLEO grade sessions and A/B tests.

---

## Measurement Methods (priority order)

### Method 1: Claude Code Agent task notification (canonical)

When running scenarios via Agent tasks, `total_tokens` is available in the task completion notification. This is the actual API token count — the most accurate available.

```python
# Capture immediately when the agent task completes:
timing = {
  "total_tokens": task.total_tokens,    # actual API count
  "duration_ms": task.duration_ms,
}
# Write to timing.json — this data is EPHEMERAL and cannot be recovered later
```

**Setup:** No configuration needed. Works whenever Claude Code spawns an Agent task.

### Method 2: OTel `claude_code.token.usage`

When Claude Code is configured with OpenTelemetry, actual token counts are available at `~/.cleo/metrics/otel/`.

```bash
# Enable (add to shell profile):
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT="file://${HOME}/.cleo/metrics/otel/"
```

Fields of interest from `claude_code.token.usage` metric:
- `input_tokens` — tokens consumed by the prompt
- `output_tokens` — tokens generated in response
- `cache_read_input_tokens` — tokens served from cache
- `session_id` — links to CLEO session

### Method 3: output_chars / 3.5 (JSON estimate)

When neither task notification nor OTel is available, estimate from response character counts:

```
estimated_tokens ≈ output_chars / 3.5   (JSON responses — denser than prose)
estimated_tokens ≈ output_chars / 4     (mixed content)
```

**Accuracy:** ±15-20% for typical JSON responses. Consistent enough for relative comparisons.

### Method 4: Audit entry count (coarse proxy)

Each audit entry represents one operation invocation. As a very rough proxy:
- One MCP `query` call ≈ 300–800 tokens total (request + response)
- One MCP `mutate` call ≈ 400–1200 tokens total
- CLI call ≈ 200–600 tokens (less envelope overhead)

`entryCount × 150` gives a session-level estimate. Accuracy ±50%.

---

## Token Fields in Results

### GRADES.jsonl token metadata

The v2.1 grade scripts append `_tokenMeta` to each grade result:

```json
{
  "sessionId": "session-abc123",
  "totalScore": 85,
  "_tokenMeta": {
    "estimationMethod": "otel",
    "totalEstimatedTokens": 4200,
    "inputTokens": 3100,
    "outputTokens": 1100,
    "cacheReadTokens": 800,
    "perDomain": {
      "tasks": 1800,
      "session": 600,
      "admin": 400,
      "memory": 0,
      "check": 0,
      "pipeline": 0,
      "orchestrate": 0,
      "tools": 200,
      "nexus": 0,
      "sticky": 0
    },
    "perGateway": {
      "query": 2100,
      "cli": 1100,
      "untracked": 1000
    },
    "auditEntries": 47,
    "avgTokensPerEntry": 89
  }
}
```

### A/B test token fields

In `ab-result.json`:
```json
{
  "operation": "tasks.find",
  "runs": [
    {
      "run": 1,
      "mcp": {
        "output_chars": 1240,
        "estimated_tokens": 310,
        "duration_ms": 145
      },
      "cli": {
        "output_chars": 980,
        "estimated_tokens": 245,
        "duration_ms": 88
      },
      "token_delta": "+65",
      "token_delta_pct": "+26.5%"
    }
  ]
}
```

---

## Per-Domain Token Estimation

Typical token ranges per operation type (output only, output_chars / 4):

| Domain | Operation | Typical output_chars | Est. tokens |
|--------|-----------|---------------------|-------------|
| tasks | `tasks.find` (10 results) | 2000–4000 | 500–1000 |
| tasks | `tasks.show` (single) | 800–1500 | 200–375 |
| tasks | `tasks.list` (full) | 5000–20000+ | 1250–5000+ |
| session | `session.list` | 1000–3000 | 250–750 |
| session | `session.status` | 400–800 | 100–200 |
| admin | `admin.dash` | 1200–2500 | 300–625 |
| admin | `admin.help` | 2000–5000 | 500–1250 |
| memory | `memory.find` | 1500–4000 | 375–1000 |

**Key insight:** `tasks.list` is 4–10x more expensive than `tasks.find` for same result set. This is why S2 Discovery Efficiency penalizes list-heavy agents.

---

## Using token_tracker.py

```bash
# Estimate tokens for a specific session from GRADES.jsonl
python scripts/token_tracker.py \
  --session-id "session-abc123" \
  --grades-file .cleo/metrics/GRADES.jsonl

# Use OTEL data if available
python scripts/token_tracker.py \
  --session-id "session-abc123" \
  --otel-dir ~/.cleo/metrics/otel \
  --grades-file .cleo/metrics/GRADES.jsonl

# Aggregate breakdown across all sessions
python scripts/token_tracker.py \
  --grades-file .cleo/metrics/GRADES.jsonl \
  --breakdown-by domain \
  --output domain-token-report.json

# Compare two grade sessions
python scripts/token_tracker.py \
  --compare session-abc123 session-def456 \
  --grades-file .cleo/metrics/GRADES.jsonl
```

---

## Token Efficiency Score

The `generate_report.py` script computes a `tokenEfficiencyScore` for each session:

```
tokenEfficiencyScore = (entriesCompleted / estimatedTokens) * 1000
```

Higher = more work per token. Use to compare:
- MCP-heavy sessions vs CLI-heavy sessions
- Pre/post skill improvements
- Different agent configurations

---

## OTEL File Format

OTEL files written by Claude Code are JSONL (one metric per line):

```json
{"name": "claude_code.token.usage", "value": 4200, "attributes": {"session_id": "...", "model": "claude-sonnet-4-6"}, "timestamp": "2026-03-07T..."}
{"name": "claude_code.api_request", "value": 1, "attributes": {"input_tokens": 3100, "output_tokens": 1100, "cache_read_input_tokens": 800}, "timestamp": "..."}
```

`token_tracker.py` reads these files and matches `session_id` to CLEO session IDs stored in `GRADES.jsonl`.
