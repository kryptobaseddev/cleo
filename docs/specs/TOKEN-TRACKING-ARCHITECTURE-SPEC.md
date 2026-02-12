# Token Tracking Architecture Specification

**Task**: T2897
**Epic**: T2163
**Date**: 2026-02-01
**Status**: complete
**Schema Version**: 1.0.0

---

## Summary

This specification defines a hybrid token tracking architecture with two tracking layers: session-level for total consumption (actual Claude Code data) and spawn-level for task attribution (estimated tokens). The system integrates with Claude Code's OpenTelemetry metrics when available, falling back to estimation when not.

## 1. Architecture Overview

### 1.1 Two-Tier Tracking System

The architecture implements **two independent tracking layers**:

```
┌─────────────────────────────────────────────────────────────┐
│ TIER 1: Session Lifecycle Tracking                         │
│ Purpose: TOTAL token consumption per session                │
│ Source: Claude Code context state (actual data)             │
│ Output: .cleo/metrics/SESSIONS.jsonl                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ TIER 2: Spawn Boundary Attribution                         │
│ Purpose: Per-task token attribution                         │
│ Source: Estimated from prompt/output size                   │
│ Output: .cleo/metrics/TOKEN_USAGE.jsonl                     │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 Why NOT File-Ops Level

File operations tracking was **explicitly rejected** because:

- **Too noisy**: Every `atomic_write()` call generates metrics
- **Wrong granularity**: File writes don't correlate to task work
- **Performance impact**: Would slow down all write operations
- **No value signal**: Cannot attribute tokens to specific tasks

---

## 2. Session-Level Tracking (Tier 1)

### 2.1 Requirements

**SESS-001**: Session start MUST initialize token tracking state

**SESS-002**: Session start MUST capture starting token count from Claude Code context state

**SESS-003**: Session end MUST capture final token count from Claude Code context state

**SESS-004**: Token data MUST be written to `.cleo/metrics/SESSIONS.jsonl`

**SESS-005**: Session metrics SHOULD include `input_tokens` and `output_tokens` when available from OpenTelemetry data

**SESS-006**: When OpenTelemetry data is unavailable, MUST fall back to context state `currentTokens` value

**SESS-007**: Token fields MUST use consistent naming: `start`, `end`, `consumed`

### 2.2 Data Source

**Primary**: Claude Code context state files (`.cleo/context-states/context-state-session_*.json`)

**Schema**:
```json
{
  "version": "1.0.0",
  "timestamp": "2026-01-27T05:14:04Z",
  "contextWindow": {
    "maxTokens": 200000,
    "currentTokens": 196643,
    "percentage": 98
  },
  "sessionId": "session_20260126_203408_e61a5c"
}
```

**Secondary**: OpenTelemetry metrics (when `CLAUDE_CODE_ENABLE_TELEMETRY=1`)

- Metric: `claude_code.token.usage`
- Attributes: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`

### 2.3 Integration Points

**File**: `lib/sessions.sh`

**Function**: `start_session()`

**Location**: Line 422

**Modification**:
```bash
# After line 471 (active session count check)
# Add token tracking initialization

# Capture starting token state from context
local start_tokens=0
local context_state_file="${CLEO_DIR}/context-states/context-state-${session_id}.json"
if [[ -f "$context_state_file" ]]; then
    start_tokens=$(jq -r '.contextWindow.currentTokens // 0' "$context_state_file" 2>/dev/null || echo 0)
fi

# Store in session start metrics
local start_metrics
start_metrics=$(jq -n \
    --arg task "$focus_task" \
    --argjson tokens "$start_tokens" \
    '{
        focusTask: $task,
        timestamp: (now | strftime("%Y-%m-%dT%H:%M:%SZ")),
        tokens: {
            start: $tokens,
            max: 200000
        }
    }')
```

**Function**: `end_session()`

**Location**: Line 898

**Modification**:
```bash
# After line 947 (timestamp creation)
# Add token tracking finalization

# Capture ending token state from context
local end_tokens=0
local context_state_file="${CLEO_DIR}/context-states/context-state-${session_id}.json"
if [[ -f "$context_state_file" ]]; then
    end_tokens=$(jq -r '.contextWindow.currentTokens // 0' "$context_state_file" 2>/dev/null || echo 0)
fi

# Extract start tokens from session start metrics
local start_tokens
start_tokens=$(echo "$session_info" | jq -r '.startMetrics.tokens.start // 0')

# Calculate consumed
local consumed_tokens=$((end_tokens - start_tokens))

# Write to SESSIONS.jsonl
local sessions_metrics="${CLEO_DIR}/metrics/SESSIONS.jsonl"
mkdir -p "$(dirname "$sessions_metrics")"
jq -n \
    --arg sid "$session_id" \
    --arg start_ts "$(echo "$session_info" | jq -r '.startedAt')" \
    --arg end_ts "$timestamp" \
    --argjson start "$start_tokens" \
    --argjson end "$end_tokens" \
    --argjson consumed "$consumed_tokens" \
    --argjson tasks_done "$(echo "$session_info" | jq '.stats.tasksCompleted // 0')" \
    --argjson focus_changes "$(echo "$session_info" | jq '.stats.focusChanges // 0')" \
    '{
        session_id: $sid,
        start_timestamp: $start_ts,
        end_timestamp: $end_ts,
        tokens: {
            start: $start,
            end: $end,
            consumed: $consumed,
            max: 200000
        },
        stats: {
            tasks_completed: $tasks_done,
            focus_changes: $focus_changes
        }
    }' >> "$sessions_metrics"
```

### 2.4 Output Schema

**File**: `.cleo/metrics/SESSIONS.jsonl`

**Format**: One JSON object per line (JSONL)

**Schema**:
```json
{
  "session_id": "session_20260201_070000_abc123",
  "start_timestamp": "2026-02-01T07:00:00Z",
  "end_timestamp": "2026-02-01T09:30:00Z",
  "tokens": {
    "start": 0,
    "end": 98542,
    "consumed": 98542,
    "max": 200000
  },
  "stats": {
    "tasks_completed": 5,
    "focus_changes": 7,
    "suspend_count": 0,
    "resume_count": 0
  },
  "efficiency": {
    "session_efficiency_score": 0.8750,
    "human_intervention_rate": 0.2000,
    "context_utilization": 0.4927
  }
}
```

**Required Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier (format: `session_YYYYMMDD_HHMMSS_hash`) |
| `start_timestamp` | string | ISO 8601 session start time |
| `end_timestamp` | string | ISO 8601 session end time |
| `tokens.start` | integer | Token count at session start |
| `tokens.end` | integer | Token count at session end |
| `tokens.consumed` | integer | Tokens used during session (`end - start`) |
| `tokens.max` | integer | Maximum context window size (200000) |

**Optional Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `tokens.input_tokens` | integer | Input tokens (from OTel if available) |
| `tokens.output_tokens` | integer | Output tokens (from OTel if available) |
| `tokens.cache_read_tokens` | integer | Cache read tokens (from OTel) |
| `tokens.cache_creation_tokens` | integer | Cache creation tokens (from OTel) |
| `stats.tasks_completed` | integer | Tasks completed during session |
| `stats.focus_changes` | integer | Number of focus changes |
| `efficiency.*` | number | Efficiency metrics (existing fields) |

---

## 3. Spawn-Level Attribution (Tier 2)

### 3.1 Requirements

**SPAWN-001**: Orchestrator spawn MUST estimate and record prompt token count before spawning

**SPAWN-002**: Orchestrator return processing MUST estimate and record output token count

**SPAWN-003**: Token attribution MUST link to `task_id`

**SPAWN-004**: Attribution data MUST be written to `.cleo/metrics/TOKEN_USAGE.jsonl`

**SPAWN-005**: Estimation MUST use existing `estimate_tokens()` function from `lib/token-estimation.sh`

**SPAWN-006**: Attribution records MUST include session context when session is active

**SPAWN-007**: Event timestamps MUST use ISO 8601 format in UTC

### 3.2 Data Source

**Estimation**: Uses `lib/token-estimation.sh::estimate_tokens()`

**Heuristic**: 1 token ≈ 4 characters (varies by content type)

**Accuracy**: Estimates are approximate; session totals from Tier 1 are authoritative

### 3.3 Integration Points

**File**: `lib/orchestrator-spawn.sh`

**Function**: `orchestrator_spawn_for_task()`

**Location**: Line 232

**Modification Point 1** (Before spawn, after prompt generation):

```bash
# After Step 6: Generate final prompt (around line 400)
# Add token estimation and logging

# Estimate prompt tokens
local prompt_tokens
prompt_tokens=$(estimate_tokens "$final_prompt")

# Log spawn event
local session_id="${SESSION_ID:-$(get_current_session_id || echo "")}"
track_spawn_tokens "$task_id" "$prompt_tokens" "prompt" "$session_id"
```

**Modification Point 2** (After subagent return):

```bash
# After subagent completes (new logic needed)
# Add output token estimation

# Estimate output tokens from subagent return
local output_tokens
output_tokens=$(estimate_tokens "$subagent_output")

# Log return event
track_spawn_tokens "$task_id" "$output_tokens" "output" "$session_id"
```

**New Function** (Add to `lib/token-estimation.sh`):

```bash
# track_spawn_tokens - Record token usage for orchestrator spawn/return
# Args: $1 = task_id
#       $2 = token_count (estimated)
#       $3 = event_type (prompt|output)
#       $4 = session_id (optional)
track_spawn_tokens() {
    local task_id="$1"
    local token_count="$2"
    local event_type="$3"
    local session_id="${4:-}"

    _te_ensure_metrics_dir

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    jq -n \
        --arg ts "$timestamp" \
        --arg event "orchestrator_$event_type" \
        --argjson tokens "$token_count" \
        --arg task "$task_id" \
        --arg session "$session_id" \
        '{
            timestamp: $ts,
            event_type: $event,
            estimated_tokens: $tokens,
            task_id: $task,
            session_id: ($session | if . == "" then null else . end),
            context: {
                tier: 0,
                operation: $event
            }
        }' >> "$_TE_TOKEN_FILE"
}
```

### 3.4 Output Schema

**File**: `.cleo/metrics/TOKEN_USAGE.jsonl`

**Format**: One JSON object per line (JSONL)

**Schema**:
```json
{
  "timestamp": "2026-02-01T07:15:23Z",
  "event_type": "orchestrator_prompt",
  "estimated_tokens": 8542,
  "task_id": "T2897",
  "session_id": "session_20260201_070000_abc123",
  "context": {
    "tier": 0,
    "operation": "orchestrator_prompt"
  }
}
```

**Required Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | string | ISO 8601 event timestamp (UTC) |
| `event_type` | string | Event type (orchestrator_prompt, orchestrator_output) |
| `estimated_tokens` | integer | Estimated token count |
| `task_id` | string | Task identifier (T####) |
| `session_id` | string\|null | Session ID if in session context |

**Optional Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `context.tier` | integer | Architecture tier (0=orchestrator, 1=subagent) |
| `context.operation` | string | Operation name |
| `context.skill` | string | Skill name (for tier 1) |
| `source` | string | Source file/entity |

---

## 4. Activation Mechanism

### 4.1 Requirements

**ACTIVATE-001**: Token tracking MUST be controlled by environment variable `CLEO_TRACK_TOKENS`

**ACTIVATE-002**: When disabled, tracking MUST have zero performance overhead

**ACTIVATE-003**: Default SHOULD be enabled (`CLEO_TRACK_TOKENS=1`)

**ACTIVATE-004**: Tracking MUST NOT fail silently; errors SHOULD be logged to stderr

**ACTIVATE-005**: Missing metrics directory MUST be created automatically

### 4.2 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLEO_TRACK_TOKENS` | `1` | Enable token tracking (0=off, 1=on) |
| `TOKEN_METRICS_PATH` | `.cleo/metrics/TOKEN_USAGE.jsonl` | Token usage log file |
| `OTEL_METRICS_DIR` | `.cleo/metrics/otel` | OpenTelemetry capture directory |
| `TOKEN_ESTIMATION_DEBUG` | `0` | Enable debug logging (0=off, 1=on) |

### 4.3 Activation Check Pattern

**All tracking functions MUST use this guard**:

```bash
# At start of tracking function
if [[ "${CLEO_TRACK_TOKENS:-1}" != "1" ]]; then
    return 0  # Silent return when disabled
fi
```

### 4.4 Error Handling

**ACTIVATE-006**: Metrics directory creation failure MUST NOT block operations

**ACTIVATE-007**: File write failures SHOULD log to stderr but return success (0)

**Example**:
```bash
_te_ensure_metrics_dir() {
    local dir
    dir=$(dirname "$_TE_TOKEN_FILE")
    if ! mkdir -p "$dir" 2>/dev/null; then
        _te_debug "Failed to create metrics directory: $dir" >&2
        return 0  # Don't fail, just skip tracking
    fi
}
```

---

## 5. Integration Timeline

### 5.1 Phase 1: Session Tracking (T2898)

**Files Modified**:
- `lib/sessions.sh` (start_session, end_session)

**Tests Required**:
- Session start captures token count
- Session end calculates consumed tokens
- SESSIONS.jsonl format validation
- Tracking disabled when `CLEO_TRACK_TOKENS=0`

### 5.2 Phase 2: Spawn Attribution (T2899)

**Files Modified**:
- `lib/orchestrator-spawn.sh` (orchestrator_spawn_for_task)
- `lib/token-estimation.sh` (track_spawn_tokens - new function)

**Tests Required**:
- Spawn event records prompt tokens
- Return event records output tokens
- TOKEN_USAGE.jsonl format validation
- Session linkage when in session context

### 5.3 Phase 3: OTel Integration (T2900)

**Files Modified**:
- `lib/otel-integration.sh` (parse_token_metrics - enhancement)
- `lib/sessions.sh` (end_session - OTel fallback)

**Tests Required**:
- OTel data parsing when available
- Fallback to context state when OTel disabled
- Input/output token extraction from OTel

---

## 6. Validation Gates

### 6.1 Schema Compliance

**VALIDATE-001**: All JSONL entries MUST validate against `schemas/metrics.schema.json`

**VALIDATE-002**: Token counts MUST be non-negative integers

**VALIDATE-003**: Timestamps MUST be valid ISO 8601 format

**VALIDATE-004**: Session IDs MUST match pattern `session_YYYYMMDD_HHMMSS_[a-f0-9]{6}`

**VALIDATE-005**: Task IDs MUST match pattern `T[0-9]+`

### 6.2 Integrity Checks

**INTEGRITY-001**: `tokens.consumed` MUST equal `tokens.end - tokens.start`

**INTEGRITY-002**: `tokens.end` MUST be greater than or equal to `tokens.start`

**INTEGRITY-003**: `tokens.end` MUST NOT exceed `tokens.max`

**INTEGRITY-004**: Session timestamps: `end_timestamp >= start_timestamp`

### 6.3 Test Coverage

**TEST-001**: Unit tests MUST verify activation/deactivation

**TEST-002**: Integration tests MUST verify end-to-end session tracking

**TEST-003**: Integration tests MUST verify spawn attribution

**TEST-004**: Golden tests MUST verify JSONL output format

**TEST-005**: Tests MUST verify metrics directory auto-creation

---

## 7. Performance Requirements

### 7.1 Overhead Limits

**PERF-001**: Token estimation MUST complete in < 10ms for typical prompts (< 50KB)

**PERF-002**: JSONL append operations MUST complete in < 5ms

**PERF-003**: When tracking is disabled, overhead MUST be < 1ms (guard check only)

**PERF-004**: Metrics file I/O MUST NOT block session operations

### 7.2 File Size Management

**PERF-005**: TOKEN_USAGE.jsonl SHOULD be rotated when exceeding 10MB

**PERF-006**: SESSIONS.jsonl rotation threshold SHOULD be 5MB

**PERF-007**: Rotation SHOULD preserve last 90 days of data

**PERF-008**: Compressed archives SHOULD use gzip with `.jsonl.gz` extension

---

## 8. Security and Privacy

### 8.1 Data Protection

**SECURITY-001**: Token metrics MUST NOT contain sensitive task content

**SECURITY-002**: Metrics files MUST be excluded from version control (`.gitignore`)

**SECURITY-003**: File permissions MUST be user-only (600) for metrics files

**SECURITY-004**: Session IDs MAY be pseudonymized in shared metrics exports

### 8.2 Exclusions

**EXCLUDE-001**: `.cleo/metrics/*.jsonl` MUST be in `.gitignore`

**EXCLUDE-002**: Metrics MUST NOT capture task descriptions or notes

**EXCLUDE-003**: Metrics MUST NOT capture file contents

**EXCLUDE-004**: Only aggregate counts and metadata MAY be tracked

---

## 9. Migration Strategy

### 9.1 Backward Compatibility

**MIGRATE-001**: Existing SESSIONS.jsonl entries without token fields MUST remain valid

**MIGRATE-002**: New token fields MUST be optional for schema validation

**MIGRATE-003**: Legacy `tokens.start=0, tokens.end=0` entries MUST be supported

### 9.2 Upgrade Path

**UPGRADE-001**: No migration script required (append-only architecture)

**UPGRADE-002**: Users MAY delete existing SESSIONS.jsonl to start fresh

**UPGRADE-003**: Documentation MUST explain how to enable OTel capture

---

## 10. Success Criteria

### 10.1 Functional Requirements

**SUCCESS-001**: Session tracking captures start and end tokens from context state

**SUCCESS-002**: Spawn attribution logs prompt and output token estimates

**SUCCESS-003**: All metrics validate against JSON schemas

**SUCCESS-004**: Tracking can be disabled with zero overhead

**SUCCESS-005**: OTel integration works when telemetry is enabled

### 10.2 Quality Requirements

**SUCCESS-006**: Test coverage ≥ 80% for new functions

**SUCCESS-007**: No session operation latency increase > 5ms

**SUCCESS-008**: Documentation includes setup instructions and examples

**SUCCESS-009**: Error messages provide actionable guidance

---

## 11. Future Extensions

### 11.1 Potential Enhancements (Not in Scope)

- **Real-time dashboards**: Live token consumption visualization
- **Cost analytics**: Token-to-cost conversion based on API pricing
- **Budget alerts**: Notify when session approaches token limit
- **Multi-project aggregation**: Cross-project token usage comparison
- **A/B testing integration**: Token savings measurement for experiments

### 11.2 Research Areas

- **Cache token tracking**: Differentiate prompt cache hits from full reads
- **Model-specific estimation**: Adjust heuristics per model (Sonnet vs Opus)
- **Skill efficiency profiling**: Which skills are most token-efficient?

---

## References

- **Epic**: T2163 - Token Usage Tracking and Cost Analytics
- **Research**: MANIFEST.jsonl entry for T2897 research phase
- **Consensus**: T2897 consensus notes (hybrid architecture decision)
- **Existing Libraries**:
  - `lib/token-estimation.sh` - Token estimation utilities
  - `lib/otel-integration.sh` - OpenTelemetry capture
  - `lib/sessions.sh` - Session lifecycle management
  - `lib/orchestrator-spawn.sh` - Orchestrator spawning
- **Schemas**:
  - `schemas/metrics.schema.json` - Metrics validation
  - `schemas/sessions.schema.json` - Sessions data structure
  - `schemas/context-state.schema.json` - Claude Code context state

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-02-01 | Initial specification based on consensus decision |
