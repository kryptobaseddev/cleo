# CLEO Metrics Directory

This directory contains metrics and validation data generated during CLEO operations.

## Structure

```
.cleo/metrics/
├── otel/              # OpenTelemetry JSON exports (large, session-specific)
├── TOKEN_USAGE.jsonl  # Token tracking events (future)
├── COMPLIANCE.jsonl   # Protocol validation results
└── SESSIONS.jsonl     # Session metrics and analytics
```

## Files

### COMPLIANCE.jsonl
**Purpose**: Records protocol compliance validation results from completed tasks.

**Format**: JSONL (one JSON object per line)

**Schema**:
```json
{
  "taskId": "T####",
  "protocol": "research|consensus|specification|decomposition|implementation|contribution|release",
  "timestamp": "ISO-8601",
  "result": "pass|fail",
  "violations": ["array of violation messages"],
  "metrics": {
    "key_findings_count": 5,
    "rfc2119_keywords": ["MUST", "SHOULD"]
  }
}
```

**Retention**: Append-only, no automatic rotation. Archive manually when large.

### SESSIONS.jsonl
**Purpose**: Session lifecycle and productivity metrics.

**Format**: JSONL (one JSON object per line)

**Schema**:
```json
{
  "sessionId": "session_YYYYMMDD_HHMMSS_hash",
  "event": "start|end|suspend|resume|focus_change",
  "timestamp": "ISO-8601",
  "metrics": {
    "tasksCompleted": 0,
    "focusChanges": 2,
    "duration": 3600
  }
}
```

**Retention**: Keep last 90 days of sessions. Older data auto-archived.

### otel/
**Purpose**: OpenTelemetry JSON export directory for token usage and cost tracking.

**Contents**:
- `metrics-{timestamp}.json` - OTel metric exports
- `traces-{timestamp}.json` - Distributed trace data (future)

**Retention**: Session-specific. Delete after aggregation or analysis.

**Git Status**: IGNORED - Large files, session-specific data.

### TOKEN_USAGE.jsonl (Future)
**Purpose**: Token consumption tracking for cost analytics and optimization.

**Format**: JSONL (one JSON object per line)

**Schema** (planned):
```json
{
  "timestamp": "ISO-8601",
  "operation": "orchestrator_spawn|skill_dispatch|task_completion",
  "taskId": "T####",
  "tokens": {
    "input": 5000,
    "output": 500,
    "total": 5500
  },
  "cost": {
    "input_usd": 0.015,
    "output_usd": 0.0075,
    "total_usd": 0.0225
  }
}
```

**Retention**: Keep last 30 days. Archive monthly for historical analysis.

## Enabling OpenTelemetry

To enable token tracking via OpenTelemetry:

```bash
# Add to shell profile (.bashrc, .zshrc, etc.)
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=file://${PWD}/.cleo/metrics/otel/
```

## Retention Policies

| File | Policy | Reason |
|------|--------|--------|
| `COMPLIANCE.jsonl` | Manual archive | Historical compliance analysis |
| `SESSIONS.jsonl` | 90 days | Recent session analytics |
| `otel/*.json` | Session-specific | Large files, aggregated elsewhere |
| `TOKEN_USAGE.jsonl` | 30 days | Cost tracking window |

## Analysis

### Compliance Rate
```bash
jq -s '[.[] | select(.result == "pass")] | length' .cleo/metrics/COMPLIANCE.jsonl
jq -s 'length' .cleo/metrics/COMPLIANCE.jsonl
# Success rate = pass_count / total_count
```

### Session Productivity
```bash
jq -s '[.[] | select(.event == "end")] | map(.metrics.tasksCompleted) | add' .cleo/metrics/SESSIONS.jsonl
```

### Token Usage (Future)
```bash
jq -s 'map(.tokens.total) | add' .cleo/metrics/TOKEN_USAGE.jsonl
```

## References

- **Specification**: `docs/specs/CLEO-METRICS-VALIDATION-SYSTEM-SPEC.md`
- **Value Proof**: `docs/specs/METRICS-VALUE-PROOF-SPEC.md`
- **OpenTelemetry**: https://opentelemetry.io/docs/specs/otel/
