# Anatomy of One IVT Iteration

This file walks through a single iteration of the IVT loop, from the failure diagnosis to the regenerated fix. Read it before modifying the loop logic.

## Scenario

Task T5142 requires a function `normalizeEmail(input: string): string` with the following spec:

| MUST | Requirement |
|------|-------------|
| MUST-1 | Trim leading and trailing whitespace. |
| MUST-2 | Lowercase the local part and the domain. |
| MUST-3 | Reject empty strings by throwing `ValidationError`. |
| MUST-4 | Reject strings with more than one `@` by throwing `ValidationError`. |

The implementer has produced an initial patch. The loop enters iteration 1.

## Iteration 1: Implement

The patch adds the function skeleton:

```ts
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}
```

Provenance tags are present (`@task T5142`). The Implement phase ends.

## Iteration 1: Validate

The lint phase passes. The type check passes. No errors yet. The Validate phase ends.

## Iteration 1: Test

The framework (vitest) is invoked:

```
$ pnpm vitest run --reporter=json
PASS  tests/normalize-email.test.ts
  normalizeEmail
    ✓ trims whitespace
    ✓ lowercases local and domain
    ✗ throws on empty string
    ✗ throws on double @
```

Raw result: `testsRun=4, testsPassed=2, testsFailed=2`.

### Spec-to-test trace

| Spec MUST | Test | Passing? |
|-----------|------|----------|
| MUST-1 | `trims whitespace` | yes |
| MUST-2 | `lowercases local and domain` | yes |
| MUST-3 | `throws on empty string` | **no** |
| MUST-4 | `throws on double @` | **no** |

Two failures, both tied to MUST requirements. Convergence = false. The Test phase ends.

## Iteration 1: Diagnose

The diagnose step reads each failure and maps it to a spec clause:

| Failure | Spec Clause | Root cause |
|---------|-------------|------------|
| `throws on empty string` | MUST-3 | Implementation does not throw on empty input |
| `throws on double @` | MUST-4 | Implementation does not validate `@` count |

A fix is generated:

```ts
export function normalizeEmail(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new ValidationError('email cannot be empty');
  }
  if ((trimmed.match(/@/g) ?? []).length !== 1) {
    throw new ValidationError('email must contain exactly one @');
  }
  return trimmed.toLowerCase();
}
```

The loop increments `iteration` to 2 and re-enters Implement.

## Iteration 2: Implement, Validate, Test

Patch applies cleanly. Lint and type check pass. Vitest runs:

```
PASS  tests/normalize-email.test.ts
  normalizeEmail
    ✓ trims whitespace
    ✓ lowercases local and domain
    ✓ throws on empty string
    ✓ throws on double @

Tests  4 passed (4)
```

Spec trace is complete. All four MUST requirements map to passing tests.

## Convergence

The loop writes:

```json
{
  "agent_type": "testing",
  "framework": "vitest",
  "testsRun": 4,
  "testsPassed": 4,
  "testsFailed": 0,
  "ivtLoopConverged": true,
  "ivtLoopIterations": 2,
  "key_findings": [
    "4/4 tests pass",
    "all 4 MUST requirements covered",
    "converged in 2 iterations"
  ]
}
```

Exit code 0. The task advances to the next stage.

## What This Iteration Teaches

1. **The loop is spec-driven, not test-driven.** If iteration 1 had produced a fifth test that passes but does not map to any MUST, it would still not count toward convergence. Convergence is defined by spec coverage, not raw pass count.

2. **Lint and type check run every iteration.** Even though they passed in iteration 1, they run again in iteration 2. Regressions are possible and must be caught inside the loop, not after it.

3. **The diagnose step maps failures to spec clauses, not to tests.** This is how the loop avoids the anti-pattern of deleting assertions: you cannot satisfy a spec clause by removing the test that checks it, because the trace still shows the clause as uncovered.

4. **Iterations end with a single atomic manifest write.** The manifest is not appended to during the loop — only at the end, once convergence is decided. This keeps the canon immutable and the loop deterministic.

## Pathological Cases

### Fake convergence via assertion deletion

An untrained implementer might delete the failing assertion:

```ts
// was:  expect(() => normalizeEmail('')).toThrow();
// now:  expect(() => normalizeEmail('')).not.toThrow();
```

Tests now pass. The spec trace, however, still lists MUST-3 as uncovered: the assertion no longer checks the MUST clause. Convergence fails and the loop continues until MAX_ITERATIONS, then escalates. Do not accept this pattern.

### Coverage inflation

An implementer adds 50 trivial tests to hit a coverage number. The spec trace still has gaps. Convergence fails. Coverage is advisory; the spec trace is authoritative.

### Fix regression

Iteration 2's fix breaks the test that iteration 1 made pass. Validate or Test catches this and the loop re-diagnoses. This is normal; the iteration cap exists precisely to bound it.
