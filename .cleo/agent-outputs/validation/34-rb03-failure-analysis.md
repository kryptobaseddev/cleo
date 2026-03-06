# RB-03 Global Gate Failure Analysis

**Date:** 2026-03-06  
**Agent:** Diagnostic Agent  
**Task:** T5417 (RB-03) / T5467 (closure verification)  
**Scope:** Read-only diagnosis of global acceptance gate failures

---

## Executive Summary

**Root Cause:** The global acceptance gate is failing due to **stale test expectations** in three test files. **None of these failures are related to RB-03.**

**Categorization:**
- 3 failures: Pre-existing test expectation drift (registry operation counts)
- 2 failures: Pre-existing obsolete test code (calling non-existent `session.focus` operation)

**RB-03 Status:** RB-03 implementation is complete and correct. The global gate failures are blocking closure but are unrelated to RB-03's scope.

---

## Failing Test Details

### 1. parity-gate.test.ts (2 failures)

**File:** `tests/integration/parity-gate.test.ts`

#### Failure 1: Registry Total Count Mismatch
```
Test: registry has exactly 264 operations total (151q + 113m)
Error: expected 256 to be 264 // Object.is equality
Location: tests/integration/parity-gate.test.ts:70
```

| Metric | Expected | Actual | Diff |
|--------|----------|--------|------|
| Total | 264 | 256 | -8 |
| Query | 151 | 145 | -6 |
| Mutate | 113 | 111 | -2 |

#### Failure 2: Memory Domain Count Mismatch
```
Test: each domain has expected operation count
Error: memory: total mismatch: expected 18 to be 25 // Object.is equality
Location: tests/integration/parity-gate.test.ts:81
```

| Domain | Expected | Actual | Diff |
|--------|----------|--------|------|
| memory total | 25 | 18 | -7 |
| memory query | 17 | 12 | -5 |
| memory mutate | 8 | 6 | -2 |

**Root Cause:** Test expectations at lines 29-44 have stale constants that don't match the current registry. The Constitution (docs/specs/CLEO-OPERATION-CONSTITUTION.md) documents 256 operations and 18 memory operations, which matches the actual registry.

---

### 2. parity.test.ts (1 failure)

**File:** `src/dispatch/__tests__/parity.test.ts`

#### Failure: Registry Count Mismatch
```
Test: registry has the expected operation count
Error: expected 145 to be 151 // Object.is equality
Location: src/dispatch/__tests__/parity.test.ts:120
```

**Root Cause:** Same issue as parity-gate - test expects 151 query operations but registry has 145. This is the same -6 difference seen in parity-gate.

---

### 3. mutate.integration.test.ts (2 failures)

**File:** `src/mcp/gateways/__tests__/mutate.integration.test.ts`

#### Failure 1: should set focused task
```
Test: should set focused task
Error: expected false to be true // Object.is equality
Location: src/mcp/gateways/__tests__/mutate.integration.test.ts:266
```

**Test Code:**
```typescript
const result = await context.executor.execute({
  domain: 'session',
  operation: 'focus',  // ← THIS OPERATION DOES NOT EXIST
  args: ['set', taskId],
  flags: { json: true },
  sessionId: context.sessionId,
});
expect(result.success || result.exitCode === 0).toBe(true);
```

#### Failure 2: should clear focus
```
Test: should clear focus
Error: expected false to be true // Object.is equality
Location: src/mcp/gateways/__tests__/mutate.integration.test.ts:279
```

**Test Code:**
```typescript
const result = await context.executor.execute({
  domain: 'session',
  operation: 'focus',  // ← THIS OPERATION DOES NOT EXIST
  args: ['clear'],
  flags: { json: true },
  sessionId: context.sessionId,
});
expect(result.success || result.exitCode === 0).toBe(true);
```

**Root Cause:** Tests are calling `session.focus` operation which **does not exist** in the registry. The session domain has 19 operations (11 query + 8 mutate) as documented in the Constitution, but none for focus management.

**Session Domain Operations:**
- Query: status, list, show, history, decision.log, context.drift, handoff.show, briefing.show, debrief.show, chain.show, find
- Mutate: start, end, resume, suspend, gc, record.decision, record.assumption, context.inject

Focus is managed through:
- `tasks.start` / `tasks.stop` for task-level focus
- `session.start` with `--focus` option to set initial focus
- `tasks.current` query to get current focus

---

## Root Cause Categorization

### Category A: Registry Operation Count Drift (Pre-existing)

**Affected Tests:**
- `tests/integration/parity-gate.test.ts` (2 failures)
- `src/dispatch/__tests__/parity.test.ts` (1 failure)

**Analysis:**
- The Constitution documents 256 total operations (145q + 111m)
- The actual registry has 256 total operations (145q + 111m) ✓
- Test expectations are outdated (expect 264 total / 151q / 113m)
- This is a test maintenance issue, not a code bug

**Fix Required:** Update test constants to match Constitution

### Category B: Obsolete Test Code (Pre-existing)

**Affected Tests:**
- `src/mcp/gateways/__tests__/mutate.integration.test.ts` (2 failures)

**Analysis:**
- Tests attempt to call `session.focus` which was never registered as an MCP operation
- Focus management is handled differently (via `tasks.start`/`tasks.stop`, `session.start --focus`)
- These tests are testing a non-existent API

**Fix Required:** Update tests to use correct focus management operations

### Category C: RB-03 Related (None)

**Analysis:**
- RB-03 (T5417) scope: "Add direct unit tests for session-memory bridge behavior"
- RB-03 files touched: `src/core/sessions/__tests__/session-memory-bridge.test.ts`, `src/core/sessions/__tests__/index.test.ts`
- None of the failing test files are in RB-03's scope
- RB-03's targeted tests pass (see 30-rb03-closure.md evidence)

---

## Recommended Fix Strategy

### Immediate Fixes (Required for Gate Green)

#### Fix 1: Update parity-gate.test.ts expectations
```typescript
// tests/integration/parity-gate.test.ts lines 29-44
const EXPECTED_TOTAL = 256;   // was 264
const EXPECTED_QUERY = 145;   // was 151
const EXPECTED_MUTATE = 111;  // was 113

const EXPECTED_DOMAIN_COUNTS = {
  // ... other domains ...
  memory: { query: 12, mutate: 6, total: 18 },  // was 17/8/25
  // ... other domains ...
};
```

#### Fix 2: Update parity.test.ts expectations
```typescript
// src/dispatch/__tests__/parity.test.ts lines 120-122
expect(queryCount).toBe(145);   // was 151
expect(mutateCount).toBe(111);  // was 113
expect(OPERATIONS.length).toBe(256);  // was 264
```

#### Fix 3: Fix mutate.integration.test.ts focus tests
Replace obsolete `session.focus` calls with correct operations:

**Option A:** Use `tasks.start` to focus on a task:
```typescript
const result = await context.executor.execute({
  domain: 'tasks',
  operation: 'start',
  params: { taskId },
  sessionId: context.sessionId,
});
```

**Option B:** Use `tasks.stop` to clear focus:
```typescript
const result = await context.executor.execute({
  domain: 'tasks',
  operation: 'stop',
  params: {},
  sessionId: context.sessionId,
});
```

**Option C:** Skip/remove these tests if focus management is tested elsewhere

---

## Estimated Scope of Fixes

| Fix | Files | Lines | Complexity |
|-----|-------|-------|------------|
| Update parity-gate expectations | 1 | 6 constants | Trivial |
| Update parity.test expectations | 1 | 3 assertions | Trivial |
| Fix mutate.integration focus tests | 1 | 2 test cases | Low |
| **Total** | **3** | **~20 lines** | **Low** |

**Estimated Time:** This is a small maintenance task (update stale constants + fix obsolete test code), not a regression fix.

---

## Files RB-03 Touched

Verified via `git diff` analysis:
- `src/core/sessions/__tests__/session-memory-bridge.test.ts` (NEW)
- `src/core/sessions/__tests__/index.test.ts` (minimal changes)
- Documentation updates

**Failing files NOT touched by RB-03:**
- `tests/integration/parity-gate.test.ts` ❌
- `src/dispatch/__tests__/parity.test.ts` ❌
- `src/mcp/gateways/__tests__/mutate.integration.test.ts` ❌

---

## Conclusion

**The global acceptance gate failures are 100% pre-existing issues unrelated to RB-03.**

1. **Registry count drift:** Test expectations are stale (expect 264 ops, have 256)
2. **Obsolete test code:** Tests call non-existent `session.focus` operation
3. **RB-03 is clean:** Implementation is correct and its targeted tests pass

**Recommendation:** 
- Fix the 5 failing tests (2 parity-gate + 1 parity + 2 mutate.integration)
- These are test maintenance tasks, not code regressions
- RB-03 closure can proceed once these unrelated tests are fixed

---

## Appendix: Actual vs Expected Registry Counts

### By Gateway
| Gateway | Constitution | Actual | Test Expects |
|---------|--------------|--------|--------------|
| Query | 145 | 145 ✓ | 151 ❌ |
| Mutate | 111 | 111 ✓ | 113 ❌ |
| **Total** | **256** | **256** ✓ | **264** ❌ |

### By Domain
| Domain | Constitution | Actual | Test Expects |
|--------|--------------|--------|--------------|
| tasks | 32 | 32 ✓ | 32 ✓ |
| session | 19 | 19 ✓ | 19 ✓ |
| memory | 18 | 18 ✓ | 25 ❌ |
| check | 19 | 19 ✓ | 19 ✓ |
| pipeline | 37 | 37 ✓ | 38 ❌ |
| orchestrate | 19 | 19 ✓ | 19 ✓ |
| tools | 32 | 32 ✓ | 32 ✓ |
| admin | 43 | 43 ✓ | 43 ✓ |
| nexus | 31 | 31 ✓ | 31 ✓ |
| sticky | 6 | 6 ✓ | 6 ✓ |

**Verdict:** Registry matches Constitution exactly. Test expectations are stale.
