# Orchestrator: Protocol Compliance

> Referenced from: @skills/ct-orchestrator/SKILL.md
> Load when: Need details on protocol enforcement, validation requirements, compliance verification, retry protocols, or anti-patterns

## Protocol Enforcement Requirements

### MUST Inject Protocol Block

Every Task tool spawn **MUST** include the protocol block. Verification:

```bash
# Before spawning, verify protocol injection
echo "$prompt" | grep -q "SUBAGENT PROTOCOL" || echo "ERROR: Missing protocol block!"
```

### MUST Validate Return Messages

Only accept these return message formats from subagents:

| Status | Valid Return Message |
|--------|---------------------|
| Complete | "Research complete. See MANIFEST.jsonl for summary." |
| Partial | "Research partial. See MANIFEST.jsonl for details." |
| Blocked | "Research blocked. See MANIFEST.jsonl for blocker details." |

Any other return format indicates protocol violation.

### MUST Verify Manifest Entry

After EACH subagent spawn completes, verify manifest entry exists:

```bash
# 1. Get expected research ID
research_id="${topic_slug}-${date}"  # e.g., "auth-research-2026-01-21"

# 2. Verify manifest entry exists
cleo research show "$research_id"
# OR
jq -s '.[] | select(.id == "'$research_id'")' "{{MANIFEST_PATH}}"

# 3. Block on missing manifest - DO NOT spawn next agent until confirmed
if ! cleo research show "$research_id" &>/dev/null; then
    echo "ERROR: Manifest entry missing for $research_id"
    echo "ACTION: Re-spawn with clearer protocol instructions"
    exit 1
fi
```

### MUST Verify Research Link

After subagent completion, verify research is linked to task:

```bash
# 1. Check task for linked research
linked=$(cleo show "$task_id" | jq -r '.task.linkedResearch // empty')

# 2. If missing, orchestrator MUST link
if [[ -z "$linked" ]]; then
    echo "WARN: Research not linked to task $task_id - orchestrator linking..."
    cleo research link "$task_id" "$research_id"
fi

# 3. Verify link succeeded
if ! cleo show "$task_id" | jq -e '.task.linkedResearch' &>/dev/null; then
    echo "ERROR: Failed to link research $research_id to task $task_id"
    echo "ACTION: Manual intervention required"
fi
```

**Note**: Subagents SHOULD link research during execution. Orchestrator verification ensures no orphaned research artifacts.

### Enforcement Sequence

```
1. Generate spawn prompt  ->  orchestrator_spawn_for_task() or cleo orchestrator spawn
2. VERIFY protocol block  ->  Check prompt contains "SUBAGENT PROTOCOL"
3. Spawn subagent         ->  Task tool with validated prompt
4. Receive return message ->  VALIDATE against allowed formats
5. Verify manifest entry  ->  cleo research show <id> BEFORE proceeding
5.5. Verify handoff pattern ->  Manifest key_findings used, NOT TaskOutput
5.6. Extract handoff context ->  key_findings + file path for next spawn
6. Verify research link   ->  cleo show <task> | check linkedResearch
7. Link if missing        ->  cleo research link <task> <research-id>
8. Continue or escalate   ->  Only spawn next if manifest AND link confirmed
```

---

## Anti-Patterns (Protocol Violations)

| Violation | Detection | Recovery |
|-----------|-----------|----------|
| Missing protocol block | `grep -q "SUBAGENT PROTOCOL"` fails | Re-inject via `cleo research inject` |
| Invalid return message | Not in allowed format list | Mark as violation, re-spawn |
| No manifest entry | `cleo research show` returns error | Re-spawn with explicit manifest requirement |
| No research link | `jq '.task.linkedResearch'` empty | Orchestrator links via `cleo research link` |
| Spawning before verification | Multiple agents, missing entries | Stop, verify all, then resume |
| Using TaskOutput for results | TOOL-001 violation | Read manifest key_findings only |

---

## Step 7.5: Handoff Validation

After each subagent returns, orchestrator MUST validate handoff compliance:

```bash
# 1. Verify manifest entry (already in Step 5)
manifest_entry=$(cleo research show "$research_id" --json)

# 2. Extract handoff context (NOT TaskOutput)
key_findings=$(echo "$manifest_entry" | jq -r '.key_findings[]')
output_file=$(echo "$manifest_entry" | jq -r '.file')

# 3. Build next spawn prompt with handoff
next_prompt="## Context from Previous Agent
Key Findings:
$key_findings

Reference file (if details needed): $output_file

## Your Task
..."

# 4. CRITICAL: Do NOT call TaskOutput
# TaskOutput violates TOOL-001 and breaks handoff chain
```

### Handoff Validation Checks

| Check | Constraint | Action if Failed |
|-------|------------|------------------|
| key_findings extracted | HNDOFF-001 | Re-query manifest |
| file path included | HNDOFF-003 | Add to prompt |
| TaskOutput NOT called | TOOL-001 | Block, re-spawn |

---

## Step 7: Compliance Verification

After each subagent returns, orchestrator **MUST** verify compliance:

```bash
source lib/compliance-check.sh

# 1. Score compliance (checks manifest entry, research link, return format)
metrics=$(score_subagent_compliance "$task_id" "$agent_id" "$response")

# 2. Extract pass rate
compliance_pass_rate=$(echo "$metrics" | jq -r '.compliance.compliance_pass_rate')

# 3. Log violation if not 100% pass
if [[ "$compliance_pass_rate" != "1.0" ]]; then
    log_violation "$epic_id" "$(jq -n \
        --arg task "$task_id" \
        --arg agent "$agent_id" \
        --arg rate "$compliance_pass_rate" \
        '{summary: "Subagent compliance failure", task_id: $task, agent_id: $agent, severity: "medium"}'
    )"
fi

# 4. Append metrics to COMPLIANCE.jsonl (automatic via score_subagent_compliance)
log_compliance_metrics "$metrics"
```

**Compliance Checks Performed:**
| Check | Rule | Severity if Failed |
|-------|------|-------------------|
| Manifest entry exists | OUT-002 | high |
| Research link present | Task linkage | medium |
| Return format valid | OUT-003 | low |
| Handoff via manifest | HNDOFF-001 | high |
| No TaskOutput usage | TOOL-001 | critical |

---

## Epic Completion: Compliance Report

Before marking an epic complete, orchestrator **MUST** generate compliance summary:

```bash
source lib/metrics-aggregation.sh

# 1. Get project compliance summary
summary=$(get_project_compliance_summary)

# 2. Extract key metrics
total_tasks=$(echo "$summary" | jq -r '.result.totalEntries')
pass_rate=$(echo "$summary" | jq -r '.result.averagePassRate')
violations=$(echo "$summary" | jq -r '.result.totalViolations')

# 3. Check for critical breaches
critical_count=$(echo "$summary" | jq -r '.result.bySeverity.critical // 0')
high_count=$(echo "$summary" | jq -r '.result.bySeverity.high // 0')

# 4. Block auto-complete if critical breaches exist
if [[ "$critical_count" -gt 0 || "$high_count" -gt 0 ]]; then
    echo "ERROR: Cannot auto-complete epic - critical/high violations exist"
    echo "Critical: $critical_count, High: $high_count"
    echo "ACTION: Resolve violations before completing epic"
    exit 1
fi

# 5. Report compliance summary
echo "=== Epic Compliance Report ==="
echo "Total Tasks: $total_tasks"
echo "Pass Rate: $(awk "BEGIN {printf \"%.1f\", $pass_rate * 100}")%"
echo "Violations: $violations"
```

**Auto-Complete Criteria:**
- `critical_breach_rate == 0` (no critical violations)
- `high_breach_rate == 0` (no high-severity violations)
- All subagent manifest entries validated

---

## Subagent Retry Protocol

When a subagent fails compliance checks, orchestrator **MUST** follow retry protocol:

```bash
# Retry thresholds
MAX_RETRIES=2
COMPLIANCE_THRESHOLD="0.80"

# Check if retry needed
if (( $(echo "$compliance_pass_rate < $COMPLIANCE_THRESHOLD" | bc -l) )); then
    echo "WARN: Compliance pass rate below 80% ($compliance_pass_rate)"

    # Log violation
    log_violation "$epic_id" "$(jq -n \
        --arg task "$task_id" \
        --arg agent "$agent_id" \
        --arg rate "$compliance_pass_rate" \
        '{summary: "Subagent retry triggered", task_id: $task, agent_id: $agent, severity: "medium"}'
    )"

    # Re-spawn with stricter prompt (add explicit checklist)
    stricter_prompt="$original_prompt

## COMPLIANCE CHECKLIST (VERIFY BEFORE RETURNING)
- [ ] Output file exists at {{OUTPUT_DIR}}/{{DATE}}_{{TOPIC_SLUG}}.md
- [ ] MANIFEST.jsonl entry appended with all required fields
- [ ] Return message is EXACTLY: 'Research complete. See MANIFEST.jsonl for summary.'
- [ ] Task linked via: {{TASK_LINK_CMD}} {{TASK_ID}} <research-id>
- [ ] Task completed via: {{TASK_COMPLETE_CMD}} {{TASK_ID}}
"

    # Track retry count (stored in session context)
    retry_count=$((retry_count + 1))

    if [[ $retry_count -gt $MAX_RETRIES ]]; then
        echo "ERROR: Max retries ($MAX_RETRIES) exceeded for task $task_id"
        echo "ACTION: Escalate to human review"
        # Mark task as blocked
        cleo update "$task_id" --status blocked --blocked-by "Compliance failure after $MAX_RETRIES retries"
        exit 1
    fi

    # Re-spawn with stricter prompt
    # ... Task tool invocation with $stricter_prompt ...
fi
```

**Retry Rules:**
| Condition | Action |
|-----------|--------|
| `compliance_pass_rate < 80%` | Log violation, re-spawn with explicit checklist |
| `retry_count > 2` | Escalate to human, mark task blocked |
| `critical` severity | Immediate escalation, no retry |
