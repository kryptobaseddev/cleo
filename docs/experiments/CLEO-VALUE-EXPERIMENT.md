# CLEO Value Experiment Design

**Purpose**: Rigorously measure whether CLEO saves tokens, improves reliability, and increases efficiency compared to no task management system.

**Status**: DRAFT - Ready for execution

---

## Hypothesis

**H1 (Token Efficiency)**: CLEO reduces total token consumption for multi-step tasks by ≥20% compared to baseline.

**H2 (Reliability)**: CLEO reduces task failure rate by ≥30% compared to baseline.

**H3 (Continuity)**: CLEO enables successful task resumption after context reset with ≥80% success rate.

---

## Experimental Design

### Conditions

| Condition | Description | CLAUDE.md Content |
|-----------|-------------|-------------------|
| **A: CLEO** | Full CLEO injection | Standard CLEO setup |
| **B: Baseline** | No task system | Minimal project description only |
| **C: Simple TODO** | Basic markdown checklist | `TODO.md` with task list |

### Test Tasks (5 standardized tasks)

Each task is designed to test different CLEO value propositions:

#### Task 1: Single-File Bug Fix (Baseline comparison)
```
Fix the off-by-one error in lib/validation.sh line 142
where array indexing starts at 1 instead of 0.
```
- **Tests**: Basic task completion
- **Expected CLEO advantage**: None (too simple)

#### Task 2: Multi-File Feature (Research reuse)
```
Add a new "priority" field to tasks with values: critical, high, medium, low.
Update schema, validation, CLI output, and tests.
```
- **Tests**: Cross-file coordination
- **Expected CLEO advantage**: Task decomposition, dependency tracking

#### Task 3: Research + Implementation (Manifest value)
```
Research best practices for bash error handling, then implement
a new error handling module in lib/error-handling.sh with:
- Structured error codes
- Stack traces
- Retry logic
```
- **Tests**: Research → Implementation pipeline
- **Expected CLEO advantage**: Manifest summaries, research persistence

#### Task 4: Context Reset Recovery (Continuity)
```
[After completing 50% of Task 3, simulate context reset]
Continue the error handling implementation from where you left off.
```
- **Tests**: State persistence across sessions
- **Expected CLEO advantage**: Session state, task notes, focus tracking

#### Task 5: Multi-Agent Coordination (Orchestration)
```
Using subagents, implement a caching layer:
1. Research caching strategies
2. Design cache interface
3. Implement cache module
4. Write tests
```
- **Tests**: Orchestrator pattern efficiency
- **Expected CLEO advantage**: Manifest handoffs, protocol compliance

---

## Metrics

### Primary Metrics

| Metric | Measurement Method | Tool |
|--------|-------------------|------|
| **Total Input Tokens** | Sum from API transcripts | `cleo otel real` |
| **Total Output Tokens** | Sum from API transcripts | `cleo otel real` |
| **Cache Efficiency** | cache_read / total_input | `cleo otel real` |
| **Task Completion** | Binary: completed correctly | Manual verification |
| **Error Count** | Validation failures + retries | Transcript analysis |

### Secondary Metrics

| Metric | Measurement Method |
|--------|-------------------|
| **API Calls** | Count of assistant messages |
| **Tool Calls** | Count of tool invocations |
| **Context Resets** | Conversation compactions |
| **Time to Complete** | Wall clock (less reliable) |

---

## Execution Protocol

### Phase 1: Environment Setup

```bash
# Create isolated test environments
mkdir -p /tmp/cleo-experiment/{cleo,baseline,simple-todo}

# Clone fresh copies
for env in cleo baseline simple-todo; do
    git clone --depth 1 . /tmp/cleo-experiment/$env/repo
done

# Configure each environment
# CLEO: Full setup
cd /tmp/cleo-experiment/cleo/repo && ./install.sh

# Baseline: Remove CLEO
cd /tmp/cleo-experiment/baseline/repo
rm -rf .cleo
cat > CLAUDE.md << 'EOF'
# Test Repository
A bash-based task management CLI.
## Structure
- scripts/: CLI commands
- lib/: Shared functions
- tests/: BATS tests
EOF

# Simple TODO: Markdown only
cd /tmp/cleo-experiment/simple-todo/repo
rm -rf .cleo
cat > CLAUDE.md << 'EOF'
# Test Repository
A bash-based task management CLI.
## Current Tasks
- [ ] Task to be defined at runtime
## Completed
- (none yet)
EOF
```

### Phase 2: Baseline Measurement

Before each task, record:
```bash
# Clear previous session data
rm -rf ~/.claude/projects/-tmp-cleo-experiment-*

# Record starting state
echo "Task: $TASK_NAME" > /tmp/experiment-log.txt
echo "Condition: $CONDITION" >> /tmp/experiment-log.txt
echo "Start: $(date -Iseconds)" >> /tmp/experiment-log.txt
```

### Phase 3: Task Execution

For each (task, condition) pair:

1. **Start fresh Claude session**
   ```bash
   cd /tmp/cleo-experiment/$CONDITION/repo
   claude
   ```

2. **Submit task prompt** (identical across conditions)

3. **Let agent work until completion or failure**

4. **Record completion status**

5. **Extract metrics**
   ```bash
   # Get token usage from transcript
   transcript_dir="$HOME/.claude/projects/-tmp-cleo-experiment-${CONDITION}-repo"
   latest_session=$(ls -t "$transcript_dir"/*.jsonl | head -1)

   jq -s '
     [.[] | select(.type == "assistant") | .message.usage] |
     {
       input_tokens: (map(.input_tokens) | add),
       output_tokens: (map(.output_tokens) | add),
       cache_read: (map(.cache_read_input_tokens) | add),
       cache_creation: (map(.cache_creation_input_tokens) | add),
       api_calls: length
     }
   ' "$latest_session" > "/tmp/results/${CONDITION}_${TASK_NAME}.json"
   ```

### Phase 4: Context Reset Test (Task 4 only)

```bash
# After 50% completion, force context reset
# (Send /compact or reach token limit)

# Then continue with prompt:
"Continue the work you were doing on error handling."

# Measure:
# - Did agent recover context?
# - How many tokens to re-establish state?
# - Did agent duplicate work?
```

---

## Data Collection Template

### Per-Task Results

```json
{
  "task_id": "task_1",
  "task_name": "single_file_bug_fix",
  "condition": "cleo",
  "timestamp": "2026-02-01T10:00:00Z",
  "metrics": {
    "input_tokens": 12500,
    "output_tokens": 3200,
    "cache_read_tokens": 45000,
    "cache_creation_tokens": 8000,
    "api_calls": 8,
    "tool_calls": 15,
    "context_resets": 0
  },
  "outcome": {
    "completed": true,
    "correct": true,
    "errors": 0,
    "retries": 0
  },
  "notes": "Completed in single session"
}
```

### Aggregate Analysis

```bash
# Calculate per-condition averages
jq -s '
  group_by(.condition) |
  map({
    condition: .[0].condition,
    avg_input_tokens: ([.[].metrics.input_tokens] | add / length),
    avg_output_tokens: ([.[].metrics.output_tokens] | add / length),
    completion_rate: ([.[].outcome.completed] | map(if . then 1 else 0 end) | add / length),
    error_rate: ([.[].outcome.errors] | add / length)
  })
' /tmp/results/*.json
```

---

## Success Criteria

### H1: Token Efficiency (Primary)

| Metric | CLEO must show | Significance |
|--------|----------------|--------------|
| Total tokens (input + output) | ≥20% reduction vs baseline | p < 0.05 |
| For research tasks (3, 5) | ≥40% reduction | Manifest value |
| For simple tasks (1) | No penalty (±10%) | Overhead acceptable |

### H2: Reliability

| Metric | CLEO must show |
|--------|----------------|
| Task completion rate | ≥90% (vs ≥60% baseline) |
| Correct implementation | ≥85% (vs ≥50% baseline) |
| Error/retry rate | ≤50% of baseline |

### H3: Continuity

| Metric | CLEO must show |
|--------|----------------|
| Context recovery success | ≥80% |
| Duplicate work after reset | ≤10% |
| Tokens to recover state | ≤1000 tokens |

---

## Execution Script

```bash
#!/usr/bin/env bash
# experiments/run-cleo-value-experiment.sh

set -euo pipefail

EXPERIMENT_DIR="/tmp/cleo-experiment"
RESULTS_DIR="$EXPERIMENT_DIR/results"
TASKS=("single_file_fix" "multi_file_feature" "research_implement" "context_recovery" "multi_agent")
CONDITIONS=("cleo" "baseline" "simple_todo")

mkdir -p "$RESULTS_DIR"

# Task prompts (identical for all conditions)
declare -A TASK_PROMPTS
TASK_PROMPTS[single_file_fix]="Fix the off-by-one error in lib/validation.sh line 142 where array indexing starts at 1 instead of 0."
TASK_PROMPTS[multi_file_feature]="Add a new 'priority' field to tasks with values: critical, high, medium, low. Update schema, validation, CLI output, and tests."
TASK_PROMPTS[research_implement]="Research best practices for bash error handling, then implement a new error handling module in lib/error-handling.sh with structured error codes, stack traces, and retry logic."
TASK_PROMPTS[context_recovery]="Continue the error handling implementation from where you left off."
TASK_PROMPTS[multi_agent]="Using subagents, implement a caching layer: 1) Research caching strategies, 2) Design cache interface, 3) Implement cache module, 4) Write tests."

run_task() {
    local condition=$1
    local task=$2
    local repo_dir="$EXPERIMENT_DIR/$condition/repo"

    echo "Running: $condition / $task"

    # Clear previous transcripts for this repo
    local transcript_pattern="$HOME/.claude/projects/-tmp-cleo-experiment-${condition}-repo"
    rm -rf "$transcript_pattern"

    # Run Claude with the task (headless mode)
    cd "$repo_dir"
    echo "${TASK_PROMPTS[$task]}" | claude --print 2>&1 | tee "$RESULTS_DIR/${condition}_${task}_output.txt"

    # Extract metrics from transcript
    local transcript_dir="$HOME/.claude/projects/-tmp-cleo-experiment-${condition}-repo"
    if [[ -d "$transcript_dir" ]]; then
        local latest=$(ls -t "$transcript_dir"/*.jsonl 2>/dev/null | head -1)
        if [[ -n "$latest" ]]; then
            jq -s '
              [.[] | select(.type == "assistant") | .message.usage // {}] |
              {
                input_tokens: (map(.input_tokens // 0) | add),
                output_tokens: (map(.output_tokens // 0) | add),
                cache_read: (map(.cache_read_input_tokens // 0) | add),
                cache_creation: (map(.cache_creation_input_tokens // 0) | add),
                api_calls: length
              }
            ' "$latest" > "$RESULTS_DIR/${condition}_${task}_metrics.json"
        fi
    fi
}

# Main execution loop
for task in "${TASKS[@]}"; do
    for condition in "${CONDITIONS[@]}"; do
        run_task "$condition" "$task"
        sleep 5  # Rate limiting
    done
done

# Generate summary
echo "Generating summary..."
jq -s '.' "$RESULTS_DIR"/*_metrics.json > "$RESULTS_DIR/all_metrics.json"

echo "Experiment complete. Results in: $RESULTS_DIR"
```

---

## Analysis Template

After experiment completion:

```bash
# Generate comparison report
cat > /tmp/analyze-results.jq << 'EOF'
group_by(.condition) | map({
  condition: .[0].condition,
  total_input: [.[].input_tokens] | add,
  total_output: [.[].output_tokens] | add,
  total_cache_read: [.[].cache_read] | add,
  avg_api_calls: ([.[].api_calls] | add / length)
}) | sort_by(.total_input)
EOF

jq -f /tmp/analyze-results.jq "$RESULTS_DIR/all_metrics.json"
```

---

## Expected Outcomes

Based on theoretical analysis:

| Task | CLEO Advantage | Baseline Risk |
|------|----------------|---------------|
| 1. Simple fix | None (overhead = cost) | None |
| 2. Multi-file | Dependency tracking | Missed files |
| 3. Research | Manifest saves re-read | Duplicate research |
| 4. Recovery | Session state | Complete restart |
| 5. Multi-agent | Handoff efficiency | Context blowup |

**Prediction**: CLEO will show clear advantage on tasks 3-5, break-even on task 2, slight disadvantage on task 1.

---

## Limitations

1. **Single model**: Only tests Claude, not other agents
2. **Specific task types**: May not generalize
3. **Researcher bias**: Experiment designed by CLEO developers
4. **Sample size**: 5 tasks × 3 conditions = 15 runs (low statistical power)

**Mitigation**: Run each task 3× per condition for 45 total runs.

---

## Next Steps

1. [ ] Review and approve experiment design
2. [ ] Set up isolated test environments
3. [ ] Create standardized task prompts
4. [ ] Run experiment (estimated: 2-3 hours)
5. [ ] Analyze results
6. [ ] Publish findings (positive or negative)

---

## Appendix: Quick Validation Run

For a quick proof-of-concept before full experiment:

```bash
# Single task comparison
TASK="Add a --verbose flag to the 'cleo show' command"

# Run with CLEO (normal setup)
cd /mnt/projects/claude-todo
echo "$TASK" | claude --print > /tmp/cleo-run.txt
cleo otel real --format json > /tmp/cleo-tokens.json

# Run without CLEO (fresh repo)
cd /tmp/baseline-repo  # Prepared without CLEO
echo "$TASK" | claude --print > /tmp/baseline-run.txt
# Extract tokens from transcript manually

# Compare
echo "CLEO tokens: $(jq '.total_tokens' /tmp/cleo-tokens.json)"
echo "Baseline tokens: $(jq '.total_tokens' /tmp/baseline-tokens.json)"
```
