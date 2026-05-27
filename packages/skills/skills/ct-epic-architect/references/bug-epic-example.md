# Bug Epic Example: Data Corruption in User Sessions

This example demonstrates a bug fix epic with severity mapping and root cause analysis.

---

## Scenario

Users report intermittent data loss when switching between tabs. Investigation reveals:
- Session data corrupted when concurrent requests occur
- Race condition in session update logic
- Affects ~5% of users during peak hours

**Severity**: High (core feature broken, workaround difficult)

---

## Step 1: Create the Bug Epic

```bash
{{TASK_ADD_CMD}} "Fix: Session Data Corruption on Concurrent Requests" \
  --type epic \
  --size medium \
  --priority high \
  --phase maintenance \
  --labels "bug,severity:high,session,race-condition" \
  --description "Fix race condition causing session data corruption when multiple requests occur simultaneously. Root cause: non-atomic session updates. Impact: ~5% of users during peak hours experiencing data loss." \
  --acceptance "Race condition eliminated" \
  --acceptance "Session updates atomic" \
  --acceptance "Regression tests added" \
  --acceptance "No data corruption in stress test" \
  --notes "Bug report: SUPPORT-1234. First reported 2026-01-15."
```

**Annotation**: Priority `high` maps from severity `high`. Labels include `severity:high` for filtering. Phase is `maintenance` for bug fixes.

---

## Step 2: Create Tasks

### Wave 0: Investigation

```bash
# T1: Root cause analysis (Wave 0)
{{TASK_ADD_CMD}} "Investigate session corruption root cause" \
  --type task \
  --size medium \
  --priority high \
  --parent {{EPIC_ID}} \
  --phase maintenance \
  --labels "investigation,root-cause" \
  --description "Analyze session handling code, identify race condition triggers, document reproduction steps." \
  --acceptance "Race condition identified in code" \
  --acceptance "Reproduction steps documented" \
  --acceptance "Affected code paths mapped" \
  --files "src/lib/session/manager.ts,src/lib/session/store.ts"
```

**Annotation**: Bug epics ALWAYS start with investigation. Never jump to fixing without understanding root cause.

### Wave 1: Fix Implementation

```bash
# T2: Implement atomic session updates (Wave 1 - depends on T1)
{{TASK_ADD_CMD}} "Implement atomic session update mechanism" \
  --type task \
  --size medium \
  --priority high \
  --parent {{EPIC_ID}} \
  --phase maintenance \
  --depends {{T1_ID}} \
  --labels "fix,atomic,session" \
  --description "Replace non-atomic session updates with transaction-based approach using optimistic locking or mutex." \
  --acceptance "Session updates use transactions" \
  --acceptance "Concurrent writes handled correctly" \
  --acceptance "No deadlock scenarios" \
  --files "src/lib/session/manager.ts,src/lib/session/lock.ts"

# T3: Add session versioning (Wave 1 - depends on T1, parallel with T2)
{{TASK_ADD_CMD}} "Add session version tracking" \
  --type task \
  --size small \
  --priority medium \
  --parent {{EPIC_ID}} \
  --phase maintenance \
  --depends {{T1_ID}} \
  --labels "versioning,session,integrity" \
  --description "Add version field to session schema to detect and reject stale updates." \
  --acceptance "Version field added to session" \
  --acceptance "Stale updates rejected with retry hint" \
  --acceptance "Version increment on each update" \
  --files "src/lib/session/schema.ts,src/lib/session/manager.ts"
```

### Wave 2: Regression Testing

```bash
# T4: Add concurrency regression tests (Wave 2 - depends on T2, T3)
{{TASK_ADD_CMD}} "Write concurrency regression tests" \
  --type task \
  --size medium \
  --priority high \
  --parent {{EPIC_ID}} \
  --phase testing \
  --depends {{T2_ID}},{{T3_ID}} \
  --labels "testing,regression,concurrency" \
  --description "Write tests that reproduce the original bug and verify fix under concurrent load." \
  --acceptance "Test reproduces original race condition" \
  --acceptance "Test passes with fix applied" \
  --acceptance "Stress test with 100 concurrent requests" \
  --files "tests/session-concurrency.test.ts"

# T5: Update documentation (Wave 2 - depends on T2, parallel with T4)
{{TASK_ADD_CMD}} "Document session handling changes" \
  --type task \
  --size small \
  --priority low \
  --parent {{EPIC_ID}} \
  --phase polish \
  --depends {{T2_ID}} \
  --labels "docs,session" \
  --description "Update session handling documentation with new atomic update patterns and versioning." \
  --acceptance "README updated" \
  --acceptance "Code comments added" \
  --files "docs/SESSION.md,src/lib/session/README.md"
```

---

## Step 3: Start Session

```bash
{{TASK_SESSION_START_CMD}} \
  --scope epic:{{EPIC_ID}} \
  --name "Session Bug Fix" \
  --agent ct-epic-architect \
  --auto-start
```

---

## Dependency Graph

```
T1 (Investigation)
├──> T2 (Atomic Updates)
│    ├──> T4 (Regression Tests)
│    └──> T5 (Documentation)
└──> T3 (Versioning)
     └──> T4 (Regression Tests)
```

---

## Wave Analysis

| Wave | Tasks | Purpose |
|------|-------|---------|
| 0 | T1 | Root cause analysis |
| 1 | T2, T3 | Fix implementation (parallel) |
| 2 | T4, T5 | Verification and docs (parallel) |

---

## Bug Severity Mapping Reference

| Severity | Priority | Indicators |
|----------|----------|------------|
| Critical | critical | Data loss, security breach, system down |
| High | high | Core feature broken, workaround difficult |
| Medium | medium | Feature degraded, workaround exists |
| Low | low | Cosmetic, edge case, annoyance |
