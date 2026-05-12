# T1859-TEST-FIX: Align tasks.test.ts getSupportedOperations query array

## Summary

Added `'deps.validate'` and `'deps.tree'` to the hardcoded `ops.query` array in
`packages/cleo/src/dispatch/domains/__tests__/tasks.test.ts` at the `getSupportedOperations`
assertion (after `'depends'`, matching the order in the live source).

## Commit

`320a901307453ec4136e8fac7a4230f4367a75b9` on branch `task/T1859-test-fix`

## Test Result

44 tests passed (0 failures) in `tasks.test.ts` after fix.

## Pattern Note (T1926 evidence)

This is the THIRD instance of test-array drift from the T1923-finalize cascade:
- T1923 added `deps.validate` + `deps.tree` to `getSupportedOperations()`
- The hardcoded array in the test was not updated
- This pattern (3 drift incidents) further validates T1926's goal: derive the
  array from a `Set` constant (single source of truth) to eliminate the 3-way
  source-of-truth between: source impl, QUERY_OPS constant, and test assertion.
