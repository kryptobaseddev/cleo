# CLEO Metrics Value Proof Specification

**Version**: 0.1.0
**Status**: DRAFT (Bash OTel approach — concepts valid, implementation paths will be ported to TypeScript during V2 conversion)
**Created**: 2026-02-01
**Epic**: T2833

## Problem Statement

CLEO claims to save context tokens and prevent hallucinations, but **there is no mechanism to prove these claims**:

1. **Token consumption**: All metrics show `0` because there's no data source
2. **Manifest savings**: Theory says manifest reads save tokens, but no measurement
3. **Hallucination prevention**: Validators exist but no before/after comparison
4. **Skill composition**: Single skill only, no progressive loading measurement

## Goals

1. **Measure actual token usage** - Before and after CLEO
2. **Prove manifest efficiency** - Full file vs manifest-only reads
3. **Track validation impact** - Violations caught, fixes applied
4. **Enable skill composition** - Multiple skills with progressive disclosure

---

## Part 1: Token Consumption Tracking

### The Solution: OpenTelemetry Integration

**Claude Code DOES track actual tokens** via OpenTelemetry telemetry:

```
claude_code.token.usage (tokens)
├── type: "input" | "output" | "cacheRead" | "cacheCreation"
└── model: "claude-sonnet-4-5-20250929" etc.
```

**Available data per API request:**
- `input_tokens` - Actual input tokens consumed
- `output_tokens` - Actual output tokens generated
- `cache_read_tokens` - Tokens read from cache
- `cache_creation_tokens` - Tokens used to create cache

### How to Enable Telemetry

**Option 1: Console Export (development)**
```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=console
export OTEL_METRIC_EXPORT_INTERVAL=5000
claude
```

**Option 2: CLEO Integration (production)**
```bash
# Enable telemetry with file output
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=file://.cleo/metrics/otel/

# Start session
claude
```

**Option 3: Prometheus (dashboards)**
```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=prometheus
# Metrics available at localhost:9464/metrics
```

### CLEO OTel Integration

```bash
# lib/otel-integration.sh

# Parse OTel token metrics from Claude Code
parse_token_metrics() {
    local otel_dir=".cleo/metrics/otel"

    # Find latest metrics file
    local latest=$(ls -t "$otel_dir"/*.json 2>/dev/null | head -1)
    [[ -z "$latest" ]] && return 1

    # Extract token usage
    jq -r '
        .resourceMetrics[].scopeMetrics[].metrics[] |
        select(.name == "claude_code.token.usage") |
        .sum.dataPoints[] |
        {
            type: .attributes[] | select(.key == "type") | .value.stringValue,
            model: .attributes[] | select(.key == "model") | .value.stringValue,
            tokens: .asInt
        }
    ' "$latest"
}

# Get session token summary
get_session_tokens() {
    local input=0 output=0 cache_read=0 cache_create=0

    while IFS= read -r line; do
        local type tokens
        type=$(echo "$line" | jq -r '.type')
        tokens=$(echo "$line" | jq -r '.tokens')

        case "$type" in
            input) input=$((input + tokens)) ;;
            output) output=$((output + tokens)) ;;
            cacheRead) cache_read=$((cache_read + tokens)) ;;
            cacheCreation) cache_create=$((cache_create + tokens)) ;;
        esac
    done < <(parse_token_metrics)

    jq -nc \
        --argjson input "$input" \
        --argjson output "$output" \
        --argjson cache_read "$cache_read" \
        --argjson cache_create "$cache_create" \
        '{
            input_tokens: $input,
            output_tokens: $output,
            cache_read_tokens: $cache_read,
            cache_creation_tokens: $cache_create,
            total: ($input + $output)
        }'
}
```

### Fallback: Estimation (when OTel not available)

When telemetry isn't enabled, use estimation:

```bash
# lib/token-estimation.sh (already created)

# Estimate tokens from text (rough: 1 token ≈ 4 characters)
estimate_tokens() {
    local text="$1"
    local chars=${#text}
    echo $(( chars / 4 ))
}
    local tokens=$(( size / 4 ))

    # Log to metrics
    log_token_event "$purpose" "$tokens" "$file_path"
}

# Log token event to metrics
log_token_event() {
    local purpose="$1"
    local tokens="$2"
    local source="$3"

    local entry=$(jq -nc \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --arg purpose "$purpose" \
        --argjson tokens "$tokens" \
        --arg source "$source" \
        '{timestamp: $ts, purpose: $purpose, estimated_tokens: $tokens, source: $source}')

    echo "$entry" >> .cleo/metrics/TOKEN_USAGE.jsonl
}
```

### Comparison Tracking

```bash
# Track manifest-only vs full-file reads
# Orchestrator should use manifest → low token count
# Direct implementation reads full files → high token count

# Before task:
start_token_tracking "$task_id"

# During task:
track_file_read "MANIFEST.jsonl" "manifest"  # ~100 tokens
# vs
track_file_read "full-output.md" "full_file"  # ~2500 tokens

# After task:
end_token_tracking "$task_id"
# Logs: { task_id, manifest_tokens, full_file_tokens, savings_percent }
```

---

## Part 2: Multi-Skill Composition

### Current Limitation

```bash
# skill-dispatch.sh line 1250
skill_prepare_spawn() {
    local skill_name="$1"  # SINGLE skill only
```

### Proposed Solution: Skill Recipe System

```bash
# skill_prepare_spawn_multi - Compose multiple skills with progressive disclosure
# Usage: skill_prepare_spawn_multi "T1234" "ct-research-agent" "drizzle-orm" "svelte5-sveltekit"
# Returns: Combined prompt with skills in priority order

skill_prepare_spawn_multi() {
    local task_id="$1"
    shift
    local skills=("$@")

    # Validate all skills exist
    for skill in "${skills[@]}"; do
        if ! skill_exists "$skill"; then
            _sd_error "Skill not found: $skill"
            return "$EXIT_NOT_FOUND"
        fi
    done

    # Load skills with progressive disclosure
    # Tier 1 skills: Full content
    # Tier 2+ skills: Frontmatter + first section only (progressive)
    local combined_prompt=""
    local skill_manifest=()
    local total_tokens=0

    for skill in "${skills[@]}"; do
        local tier=$(skill_get_tier "$skill")
        local content=""

        if [[ "$tier" -eq 1 ]]; then
            # Full skill content for primary skill
            content=$(skill_load_full "$skill")
        else
            # Progressive: frontmatter + summary for secondary skills
            content=$(skill_load_progressive "$skill")
        fi

        local tokens=$(estimate_tokens "$content")
        total_tokens=$((total_tokens + tokens))

        combined_prompt+="
---

## Skill: ${skill} (Tier ${tier})

${content}
"
        skill_manifest+=("{\"skill\":\"$skill\",\"tier\":$tier,\"tokens\":$tokens}")
    done

    # Build output JSON
    jq -n \
        --arg task "$task_id" \
        --arg prompt "$combined_prompt" \
        --argjson total_tokens "$total_tokens" \
        --argjson skills "$(printf '%s\n' "${skill_manifest[@]}" | jq -s '.')" \
        '{
            taskId: $task,
            skillCount: ($skills | length),
            skills: $skills,
            totalEstimatedTokens: $total_tokens,
            prompt: $prompt
        }'
}

# Load full skill content
skill_load_full() {
    local skill="$1"
    local path=$(skill_get_path "$skill")
    cat "${path}/SKILL.md"
}

# Load progressive skill content (frontmatter + first section)
skill_load_progressive() {
    local skill="$1"
    local path=$(skill_get_path "$skill")

    # Extract frontmatter and first section only
    awk '
        /^---$/ && !in_fm { in_fm=1; print; next }
        /^---$/ && in_fm { in_fm=0; print; print ""; next }
        in_fm { print; next }
        /^##? / && !first_section { first_section=1; print; next }
        /^##? / && first_section { exit }
        first_section { print }
    ' "${path}/SKILL.md"
}
```

---

## Part 3: Value Proof Dashboard

### New Command: `cleo metrics value`

```bash
cleo metrics value

=== CLEO Value Metrics ===

TOKEN SAVINGS (last 7 days):
  Manifest reads:     12,450 tokens (estimated)
  If full files:     145,000 tokens (estimated)
  SAVINGS:           132,550 tokens (91%)

VALIDATION IMPACT:
  Total validations:  47
  Violations caught:   8 (17%)
  - Research modified code: 3
  - Missing key_findings: 2
  - Invalid status: 3

SKILL COMPOSITION:
  Average skills/spawn: 1.2
  Most used combos:
  - ct-research-agent + drizzle-orm: 5 spawns
  - ct-task-executor + svelte5-sveltekit: 3 spawns

EFFICIENCY:
  Tasks completed per session: 4.2 avg
  Subagent success rate: 92%
```

---

## Part 4: A/B Testing Framework

### Compare: With CLEO vs Without

```bash
# lib/ab-test.sh

# Start A/B test session
start_ab_test() {
    local test_name="$1"
    local variant="$2"  # "cleo" | "baseline"

    export CLEO_AB_TEST="$test_name"
    export CLEO_AB_VARIANT="$variant"

    # Log start
    log_ab_event "start" "$test_name" "$variant"
}

# Track event in A/B test
log_ab_event() {
    local event="$1"
    local test="$2"
    local variant="$3"

    jq -nc \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --arg event "$event" \
        --arg test "$test" \
        --arg variant "$variant" \
        '{timestamp: $ts, event: $event, test: $test, variant: $variant}' \
    >> .cleo/metrics/AB_TESTS.jsonl
}

# End A/B test with summary
end_ab_test() {
    local summary="$1"
    log_ab_event "end" "$CLEO_AB_TEST" "$CLEO_AB_VARIANT" "$summary"
    unset CLEO_AB_TEST CLEO_AB_VARIANT
}
```

### Test Protocol

1. **Baseline (no CLEO)**:
   - Direct implementation without task tracking
   - Read all files directly
   - No manifest system
   - Track: total files read, estimated tokens, time to complete

2. **With CLEO**:
   - Orchestrator with subagents
   - Manifest-only reads
   - Protocol validation
   - Track: same metrics for comparison

3. **Compare**:
   ```bash
   cleo metrics ab-compare "feature-x-test"

   === A/B Test: feature-x-test ===

   Metric              Baseline    CLEO      Improvement
   ────────────────────────────────────────────────────
   Files read          47          12        74% fewer
   Est. tokens         45,000      8,500     81% savings
   Validations         0           8         8 issues caught
   Task tracking       none        full      audit trail
   ```

---

## Implementation Priority

| Phase | Component | Value |
|-------|-----------|-------|
| 1 | Token estimation library | Enables measurement |
| 2 | Multi-skill composition | Enables skill recipes |
| 3 | Value dashboard | Proves CLEO helps |
| 4 | A/B testing framework | Scientific comparison |

## Success Criteria

1. **Token savings > 70%** - Manifest reads vs full files
2. **Violations caught > 10%** - Real issues prevented
3. **Skill composition works** - Multiple skills per spawn
4. **Before/after measurable** - Clear improvement data

---

## References

- T2832: Real manifest validation (implemented)
- T2724: Protocol metrics framework
- skill-dispatch.sh: Current single-skill implementation
