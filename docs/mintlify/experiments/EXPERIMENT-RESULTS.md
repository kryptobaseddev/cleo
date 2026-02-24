# CLEO Value Experiment - Initial Results

**Date**: 2026-02-01
**Status**: Partial - requires manual A/B testing for full validation

---

## Key Finding: Experiment Limitation

Subagents spawned via the Claude `Task` tool share context with the parent session. This means we cannot isolate CLEO vs non-CLEO environments from within a single Claude session.

**To run a proper A/B test, separate terminal sessions are required.**

---

## What We Measured

### 1. Context Injection Overhead

| Component | Size (bytes) | Estimated Tokens |
|-----------|--------------|------------------|
| CLAUDE.md (CLEO) | 13,593 | ~3,398 |
| AGENT-INJECTION.md | 5,786 | ~1,446 |
| CLEO-INJECTION.md (global) | 18,328 | ~4,582 |
| **Total CLEO overhead** | **37,707** | **~9,426** |
| CLAUDE.md (Baseline) | 432 | ~108 |

**CLEO injects 87x more context than a minimal baseline.**

### 2. Manifest System Efficiency

| Metric | Value |
|--------|-------|
| Manifest entries | 538 |
| Total manifest size | 438,537 bytes (~110K tokens) |
| Total research files | 5,679,367 bytes (~1.4M tokens) |
| Savings (manifest vs files) | 92.3% |

### 3. Break-Even Analysis

```
CLEO overhead per session:     ~9,426 tokens
Potential savings per lookup:  ~1,310,207 tokens

Break-even: 0.007 manifest lookups per session
```

**Interpretation**: If an agent uses the manifest even ONCE instead of reading all research files, CLEO pays for itself. But if the agent never uses the manifest, CLEO is pure overhead.

---

## Honest Assessment

### When CLEO Provides Value

✓ **Multi-session projects**: State persists across context window resets
✓ **Research-heavy workflows**: Manifest summaries prevent re-reading full documents
✓ **Orchestrator pattern**: Subagents read key_findings, not full files
✓ **Audit requirements**: Immutable todo-log tracks all changes
✓ **Anti-hallucination**: Validation catches invalid operations

### When CLEO Is Overhead

✗ **Single-session simple tasks**: No state to persist
✗ **No prior research**: Nothing to manifest-lookup
✗ **Direct implementation**: No delegation pattern
✗ **Quick fixes**: 9K token overhead not justified

---

## To Run Proper A/B Test

The experiment framework is ready. Run from a **fresh terminal** (not inside Claude):

```bash
# Step 1: Set up environments
./experiments/setup-experiment.sh

# Step 2: Run manual test (same task in 3 environments)
./experiments/manual-test.sh

# Step 3: Analyze results
./experiments/analyze-results.sh
```

### What the Test Will Measure

| Metric | Method |
|--------|--------|
| Input tokens | Claude API transcript |
| Output tokens | Claude API transcript |
| Cache efficiency | cache_read / total_input |
| API calls | Assistant message count |
| Task completion | Manual verification |

---

## Next Steps

1. [ ] Run manual A/B test in separate terminals
2. [ ] Collect token metrics from each condition
3. [ ] Verify task completion quality
4. [ ] Calculate statistical significance
5. [ ] Update this document with real results

---

## Files Created

- `experiments/setup-experiment.sh` - Creates isolated test environments
- `experiments/run-quick-validation.sh` - Interactive quick test
- `experiments/manual-test.sh` - Non-interactive batch test
- `experiments/analyze-results.sh` - Results aggregation
- `docs/experiments/CLEO-VALUE-EXPERIMENT.md` - Full methodology
