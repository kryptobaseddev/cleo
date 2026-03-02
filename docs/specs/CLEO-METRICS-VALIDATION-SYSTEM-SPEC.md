# CLEO Metrics and Validation System Specification

**Version**: 1.0.0
**Status**: ACTIVE (Bash implementation references — concepts valid, code paths will be ported to TypeScript during V2 conversion)
**Created**: 2026-02-01
**Last Updated**: 2026-02-14

> **CRITICAL**: This specification documents how CLEO proves its value through measurable metrics.
> Any changes to the metrics system MUST update this specification.

---

## Executive Summary

CLEO's value proposition:
1. **Saves context tokens** - Subagent+manifest architecture uses less context than direct implementation
2. **Prevents hallucinations** - Protocol validation catches violations before completion
3. **Enables skill composition** - Multiple skills with progressive disclosure

This specification documents how these claims are **measured and proven**.

---

## Part 1: Architecture Overview

### 1.1 Metrics Components

```
┌─────────────────────────────────────────────────────────────────────┐
│                    CLEO METRICS ARCHITECTURE                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────┐    ┌─────────────────┐    ┌────────────────┐  │
│  │ Token Tracking  │    │   Validation    │    │ Skill Metrics  │  │
│  │                 │    │                 │    │                │  │
│  │ • OTel capture  │    │ • Protocol      │    │ • Composition  │  │
│  │ • Session delta │    │   validators    │    │ • Token budget │  │
│  │ • Estimation    │    │ • Manifest      │    │ • Progressive  │  │
│  │   fallback      │    │   validation    │    │   disclosure   │  │
│  └────────┬────────┘    └────────┬────────┘    └───────┬────────┘  │
│           │                      │                     │           │
│           ▼                      ▼                     ▼           │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    METRICS STORAGE                            │  │
│  │  .cleo/metrics/                                               │  │
│  │  ├── TOKEN_USAGE.jsonl    # Token events                     │  │
│  │  ├── COMPLIANCE.jsonl     # Validation results               │  │
│  │  ├── SESSIONS.jsonl       # Session metrics                  │  │
│  │  └── otel/                # OpenTelemetry data               │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                              │                                      │
│                              ▼                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                   VALUE DASHBOARD                             │  │
│  │  cleo metrics value                                          │  │
│  │  ├── Token savings %                                         │  │
│  │  ├── Violations caught                                       │  │
│  │  ├── Skill composition stats                                 │  │
│  │  └── Session efficiency                                      │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 Library Files

| Library | Purpose | Key Functions |
|---------|---------|---------------|
| `lib/otel-integration.sh` | Capture actual Claude Code tokens | `get_session_tokens`, `compare_sessions` |
| `lib/token-estimation.sh` | Fallback estimation when OTel unavailable | `estimate_tokens`, `track_file_read` |
| `lib/manifest-validation.sh` | Real manifest entry validation | `validate_and_log`, `find_manifest_entry` |
| `lib/protocol-validation.sh` | Protocol-specific validators | `validate_*_protocol` (9 validators) |
| `lib/protocol-validation-common.sh` | Shared validation functions | `check_status_valid`, `check_key_findings_count` |
| `lib/skill-dispatch.sh` | Skill selection and composition | `skill_prepare_spawn_multi` |

---

## Part 2: Token Tracking

### 2.1 OpenTelemetry Integration (Primary Method)

Claude Code exposes actual token usage via OpenTelemetry telemetry.

#### Enabling OTel

Add to your shell profile or CLAUDE.md:

```bash
# Enable Claude Code telemetry
export CLAUDE_CODE_ENABLE_TELEMETRY=1

# Option 1: Console output (debugging)
export OTEL_METRICS_EXPORTER=console
export OTEL_METRIC_EXPORT_INTERVAL=5000

# Option 2: File output (CLEO integration)
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=file://.cleo/metrics/otel/

# Option 3: Prometheus (dashboards)
export OTEL_METRICS_EXPORTER=prometheus
```

#### Available Metrics

| Metric | Attributes | Description |
|--------|------------|-------------|
| `claude_code.token.usage` | `type`, `model` | Aggregated token counts |
| `claude_code.api_request` (event) | `input_tokens`, `output_tokens`, `cache_*` | Per-request details |

**Token Types**:
- `input` - Tokens sent to the model
- `output` - Tokens generated by the model
- `cacheRead` - Tokens read from prompt cache
- `cacheCreation` - Tokens used to create cache

#### Using OTel Data

```bash
source lib/otel-integration.sh

# Get current session token counts
get_session_tokens

# Output:
# {
#   "tokens": {
#     "input": 45230,
#     "output": 12450,
#     "cache_read": 8000,
#     "total": 57680,
#     "effective": 49680
#   }
# }

# Compare two sessions
compare_sessions "with_subagents" "direct_implementation"
```

### 2.2 Estimation Fallback

When OTel isn't available, use estimation:

```bash
source lib/token-estimation.sh

# Estimate tokens from text (~4 chars/token)
estimate_tokens "Hello world"  # Returns: 3

# Track file reads
track_file_read "output.md" "full_file" "T1234"

# Session tracking
start_token_session "session_123"
# ... do work ...
end_token_session  # Returns summary with savings
```

### 2.3 Proving Token Savings

The manifest system saves tokens by reading summaries instead of full files:

```bash
# Compare manifest vs full file approach
compare_manifest_vs_full 10  # 10 manifest entries read

# Output:
# {
#   "manifest_entries_read": 10,
#   "manifest_tokens": 2000,
#   "full_file_equivalent": 20000,
#   "tokens_saved": 18000,
#   "savings_percent": 90
# }
```

---

## Part 3: Protocol Validation

### 3.1 Validators

CLEO has 9 protocol validators:

| Validator | Exit Code | Validates |
|-----------|-----------|-----------|
| `validate_research_protocol` | 60 | Research output (no code mods, key_findings) |
| `validate_consensus_protocol` | 61 | Voting matrix, confidence scores |
| `validate_specification_protocol` | 62 | RFC 2119 keywords, version |
| `validate_decomposition_protocol` | 63 | Sibling limits, clear descriptions |
| `validate_implementation_protocol` | 64 | @task tags, code modifications |
| `validate_contribution_protocol` | 65 | Attribution tags |
| `validate_release_protocol` | 66 | Semver, changelog |
| `validate_validation_protocol` | 68 | Test results, validation_result field |
| `validate_testing_protocol` | 69/70 | BATS tests, pass rates |

### 3.2 Real Manifest Validation

Validation happens at task completion using actual subagent output:

```bash
source lib/manifest-validation.sh

# Find manifest entry for a task
entry=$(find_manifest_entry "T1234")

# Validate the actual entry
result=$(validate_manifest_entry "T1234" "$entry")
# {
#   "valid": true,
#   "score": 95,
#   "violations": [{"requirement": "RSCH-002", "severity": "warning", ...}]
# }

# Validate AND log to compliance metrics
validate_and_log "T1234"
```

### 3.3 Compliance Logging

All validations are logged to `.cleo/metrics/COMPLIANCE.jsonl`:

```json
{
  "timestamp": "2026-02-01T01:23:45Z",
  "source_id": "T1234",
  "source_type": "subagent",
  "compliance": {
    "compliance_pass_rate": 0.95,
    "rule_adherence_score": 0.95,
    "violation_count": 1,
    "violation_severity": "warning",
    "manifest_integrity": "valid"
  },
  "_context": {
    "agent_type": "research",
    "validation_score": 95,
    "violations": [...]
  }
}
```

**Key Difference from Previous System**:
- OLD: Hardcoded 100% pass rate at spawn time
- NEW: Real validation scores at completion time

---

## Part 4: Multi-Skill Composition

### 4.1 Progressive Disclosure

Skills are loaded with different detail levels based on priority:

| Mode | Description | Token Usage |
|------|-------------|-------------|
| **Full** | Complete SKILL.md content | 100% |
| **Progressive** | Frontmatter + first section only | ~5-10% |

### 4.2 Composing Multiple Skills

```bash
source lib/skill-dispatch.sh

# Compose multiple skills for a task
result=$(skill_prepare_spawn_multi "T1234" \
  "ct-task-executor" \    # Primary (full mode)
  "drizzle-orm" \         # Secondary (progressive)
  "svelte5-sveltekit"     # Secondary (progressive)
)

# Output:
# {
#   "composition": {
#     "skillCount": 3,
#     "primarySkill": "ct-task-executor",
#     "skills": [
#       {"skill": "ct-task-executor", "tier": 2, "mode": "full", "tokens": 3179},
#       {"skill": "drizzle-orm", "tier": 2, "mode": "progressive", "tokens": 200},
#       {"skill": "svelte5-sveltekit", "tier": 2, "mode": "progressive", "tokens": 180}
#     ],
#     "totalEstimatedTokens": 3559
#   }
# }
```

### 4.3 Token Savings from Progressive Loading

Primary skill: 3179 tokens (full)
Secondary skills: 200 + 180 = 380 tokens (progressive)
If all were full: ~9500 tokens

**Savings: ~64%** from progressive disclosure alone.

---

## Part 5: Metrics Dashboard

### 5.1 Command: `cleo metrics value`

```
=== CLEO Value Metrics ===

TOKEN EFFICIENCY (last 7 days):
  ┌────────────────────────────────────────────────────┐
  │ Manifest reads:     12,450 tokens                  │
  │ If full files:     145,000 tokens (estimated)      │
  │ SAVINGS:           132,550 tokens (91%)            │
  └────────────────────────────────────────────────────┘

VALIDATION IMPACT:
  ┌────────────────────────────────────────────────────┐
  │ Total validations:  47                             │
  │ Violations caught:   8 (17%)                       │
  │ By type:                                           │
  │   - Research modified code: 3                      │
  │   - Missing key_findings: 2                        │
  │   - Invalid status: 3                              │
  └────────────────────────────────────────────────────┘

SKILL COMPOSITION:
  ┌────────────────────────────────────────────────────┐
  │ Spawns with multi-skill: 12                        │
  │ Avg skills per spawn: 1.8                          │
  │ Progressive disclosure savings: ~60%               │
  └────────────────────────────────────────────────────┘
```

### 5.2 Dashboard Implementation

Location: `scripts/metrics.sh` (subcommand: `value`)

---

## Part 6: A/B Testing Protocol

### 6.1 Test Scenarios

To prove CLEO's value, run identical tasks with two approaches:

| Scenario | Description |
|----------|-------------|
| **Baseline** | Direct implementation without CLEO task tracking |
| **With CLEO** | Orchestrator + subagents + manifest |

### 6.2 Metrics to Compare

| Metric | Baseline | With CLEO | Expected |
|--------|----------|-----------|----------|
| Total tokens consumed | Higher | Lower | -50%+ |
| Files read | Many | Few (manifest) | -80%+ |
| Validation failures | N/A | Caught | >0 |
| Task traceability | None | Full | Yes |

### 6.3 Running A/B Tests

```bash
# Session A: With CLEO
source lib/otel-integration.sh
record_session_start "with_cleo"
# ... implement feature using subagents ...
record_session_end "with_cleo"

# Session B: Baseline
record_session_start "baseline"
# ... implement same feature directly ...
record_session_end "baseline"

# Compare
compare_sessions "with_cleo" "baseline"
```

---

## Part 7: Configuration

### 7.1 Enabling Metrics (CLAUDE.md)

Add to project CLAUDE.md:

```markdown
## Metrics Configuration

# Enable OpenTelemetry for token tracking
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=file://.cleo/metrics/otel/

# Validation settings
export CLEO_VALIDATION_MODE=strict  # strict|advisory|off
```

### 7.2 Metrics Files

| File | Purpose | Retention |
|------|---------|-----------|
| `.cleo/metrics/COMPLIANCE.jsonl` | Validation results | 30 days |
| `.cleo/metrics/SESSIONS.jsonl` | Session metrics | 30 days |
| `.cleo/metrics/TOKEN_USAGE.jsonl` | Token tracking | 30 days |
| `.cleo/metrics/otel/*.json` | Raw OTel data | 7 days |

---

## Part 8: Troubleshooting

### 8.1 No Token Data

**Symptom**: `get_session_tokens` returns all zeros

**Causes**:
1. OTel not enabled: `export CLAUDE_CODE_ENABLE_TELEMETRY=1`
2. Wrong exporter: Check `OTEL_METRICS_EXPORTER`
3. No API calls made yet

### 8.2 All Validations Pass

**Symptom**: 100% compliance, zero violations

**Causes**:
1. OLD: Hardcoded values (fixed in v0.77+)
2. Actually valid outputs (good!)
3. Validators not running

**Check**: Look for `validation_score` in `_context`:
```bash
tail -5 .cleo/metrics/COMPLIANCE.jsonl | jq '._context.validation_score'
```

### 8.3 Multi-Skill Not Working

**Symptom**: Only one skill in composition

**Causes**:
1. Skill not in manifest.json
2. Skill file missing
3. Function not exported

**Check**:
```bash
source lib/skill-dispatch.sh
skill_get_metadata "skill-name"
```

---

## Part 9: References

### 9.1 Related Specifications

- [METRICS-VALUE-PROOF-SPEC.md](METRICS-VALUE-PROOF-SPEC.md) - Initial design
- [PROJECT-LIFECYCLE-SPEC.md](PROJECT-LIFECYCLE-SPEC.md) - RCSD-IVTR protocols
- [PROTOCOL-STACK-SPEC.md](PROTOCOL-STACK-SPEC.md) - 7 conditional protocols

### 9.2 Library Documentation

- `lib/otel-integration.sh` - OpenTelemetry integration
- `lib/token-estimation.sh` - Token estimation fallback
- `lib/manifest-validation.sh` - Real manifest validation
- `lib/skill-dispatch.sh` - Multi-skill composition

### 9.3 Task References

- T2724: Protocol Metrics Framework (original epic)
- T2832: Real Manifest Validation (fixes hardcoded compliance)
- T2833: Token Tracking and Multi-Skill (this work)

---

## Appendix A: Exit Codes

| Code | Name | Description |
|------|------|-------------|
| 60 | EXIT_PROTOCOL_RESEARCH | Research protocol violation |
| 61 | EXIT_PROTOCOL_CONSENSUS | Consensus protocol violation |
| 62 | EXIT_PROTOCOL_SPECIFICATION | Specification protocol violation |
| 63 | EXIT_PROTOCOL_DECOMPOSITION | Decomposition protocol violation |
| 64 | EXIT_PROTOCOL_IMPLEMENTATION | Implementation protocol violation |
| 65 | EXIT_PROTOCOL_CONTRIBUTION | Contribution protocol violation |
| 66 | EXIT_PROTOCOL_RELEASE | Release protocol violation |
| 68 | EXIT_PROTOCOL_VALIDATION | Validation protocol violation |
| 69 | EXIT_PROTOCOL_TESTING_MILD | Testing protocol mild failure (60-70 score) |
| 70 | EXIT_PROTOCOL_TESTING_SEVERE | Testing protocol severe failure (<50 score) |

---

## Appendix B: Metrics Schema

### COMPLIANCE.jsonl Entry

```json
{
  "timestamp": "ISO8601",
  "source_id": "T####",
  "source_type": "subagent",
  "compliance": {
    "compliance_pass_rate": 0.0-1.0,
    "rule_adherence_score": 0.0-1.0,
    "violation_count": number,
    "violation_severity": "none|warning|error",
    "manifest_integrity": "valid|violations_found"
  },
  "efficiency": {
    "input_tokens": number,
    "output_tokens": number,
    "context_utilization": 0.0-1.0,
    "token_utilization_rate": number
  },
  "_context": {
    "agent_type": string,
    "validation_score": 0-100,
    "violations": array
  }
}
```

### TOKEN_USAGE.jsonl Entry

```json
{
  "timestamp": "ISO8601",
  "event_type": "manifest_read|full_file_read|skill_inject|prompt_build",
  "estimated_tokens": number,
  "source": string,
  "task_id": "T####|null",
  "session_id": string,
  "context": object
}
```
