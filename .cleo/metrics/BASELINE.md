# Metrics Baseline

**Date**: 2026-02-01T06:11:00Z
**Task**: T2876 - Purge legacy metrics data and create clean baseline
**Epic**: T2163 - Token Usage Tracking and Cost Analytics

---

## Purge Summary

All legacy/fake metrics data has been removed and archived. This establishes a clean baseline for collecting real metrics going forward.

### Why Legacy Data Was Removed

1. **Fake Scores**: COMPLIANCE.jsonl contained 1005 entries with fabricated compliance scores
2. **Commit-Hash IDs**: TOKEN_USAGE.jsonl used commit hashes as task IDs instead of proper T#### format
3. **Invalid Structure**: Legacy data did not match current schema requirements
4. **No Real Data**: All previous entries were test/example data, not actual measurements

### What Was Archived

Legacy data preserved in `.cleo/metrics/archive/pre-cleanup-20260201/`:

| File | Line Count | Size | Content |
|------|------------|------|---------|
| COMPLIANCE.jsonl | 1005 | 365KB | Fake compliance scores |
| TOKEN_USAGE.jsonl | 4 | 585B | Commit-hash task IDs |
| SESSIONS.jsonl | 219 | 76KB | Legacy session data |

### Clean Baseline

As of 2026-02-01T06:11:00Z:

- **COMPLIANCE.jsonl**: 0 entries (empty, ready for real validation data)
- **TOKEN_USAGE.jsonl**: 0 entries (empty, ready for real OTel data)
- **otel/**: Empty directory, ready for OpenTelemetry exports

---

## Collecting Real Data Going Forward

### Prerequisites

1. **Enable OpenTelemetry in Claude Code**:
   ```bash
   export CLAUDE_CODE_ENABLE_TELEMETRY=1
   export OTEL_METRICS_EXPORTER=otlp
   export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
   export OTEL_EXPORTER_OTLP_ENDPOINT=file://.cleo/metrics/otel/
   ```

2. **Verify environment variables**:
   ```bash
   env | grep -E '(CLAUDE_CODE|OTEL)'
   ```

### Data Flow

```
Claude Code Session
    │
    ├─► OpenTelemetry Export
    │   └─► .cleo/metrics/otel/metrics-*.json
    │
    ├─► lib/otel-integration.sh
    │   └─► parse_otel_data()
    │       └─► .cleo/metrics/TOKEN_USAGE.jsonl
    │
    └─► scripts/compliance.sh
        └─► validate_protocol_compliance()
            └─► .cleo/metrics/COMPLIANCE.jsonl
```

### Validation

After each session, verify real data:

```bash
# Check OTel exports
ls -la .cleo/metrics/otel/

# Check parsed token data
jq -c . .cleo/metrics/TOKEN_USAGE.jsonl | head -5

# Check compliance records
jq -c . .cleo/metrics/COMPLIANCE.jsonl | head -5

# Verify no fake scores
jq 'select(.complianceScore == 0.95)' .cleo/metrics/COMPLIANCE.jsonl
# Should return nothing
```

### What Real Data Looks Like

**TOKEN_USAGE.jsonl** (real format):
```json
{"timestamp":"2026-02-01T06:15:00Z","taskId":"T2876","sessionId":"session_20260131_220919_ab0fcc","inputTokens":1500,"outputTokens":800,"cacheCreationTokens":0,"cacheReadTokens":0,"totalTokens":2300}
```

**COMPLIANCE.jsonl** (real format):
```json
{"timestamp":"2026-02-01T06:15:30Z","taskId":"T2876","protocol":"implementation","validationsPassed":["BASE-001","BASE-002","BASE-003"],"validationsFailed":[],"score":1.0,"exitCode":0}
```

---

## Troubleshooting

### No OTel Data After Session

**Symptom**: `.cleo/metrics/otel/` remains empty

**Causes**:
1. OpenTelemetry not enabled in Claude Code
2. Environment variables not set in shell profile
3. File exporter path incorrect

**Fix**:
```bash
# Verify environment
env | grep CLAUDE_CODE_ENABLE_TELEMETRY
env | grep OTEL_EXPORTER_OTLP_ENDPOINT

# Add to shell profile for persistence
echo 'export CLAUDE_CODE_ENABLE_TELEMETRY=1' >> ~/.bashrc
echo 'export OTEL_METRICS_EXPORTER=otlp' >> ~/.bashrc
echo 'export OTEL_EXPORTER_OTLP_PROTOCOL=http/json' >> ~/.bashrc
echo 'export OTEL_EXPORTER_OTLP_ENDPOINT=file://.cleo/metrics/otel/' >> ~/.bashrc
source ~/.bashrc
```

### TOKEN_USAGE.jsonl Still Has Commit Hashes

**Symptom**: Task IDs like `"taskId": "a3f2c1b"`

**Cause**: lib/otel-integration.sh not properly extracting task IDs from context

**Fix**: See T2881 for OTel parsing fixes

### COMPLIANCE.jsonl Has Fake Scores

**Symptom**: All entries show `"score": 0.95`

**Cause**: scripts/compliance.sh returning hardcoded scores instead of real validation

**Fix**: See T2860 for validation implementation

---

## References

- **Epic**: T2163 - Token Usage Tracking and Cost Analytics
- **Purge Task**: T2876 - Purge legacy metrics data and create clean baseline
- **Next Steps**: T2877 - Enable OTel in shell environment and verify capture
- **Specification**: docs/specs/CLEO-METRICS-VALIDATION-SYSTEM-SPEC.md
