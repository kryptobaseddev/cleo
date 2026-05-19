# Anti-Patterns

The instant-rejection list for executor work — from AGENTS.md
"Anti-Patterns (INSTANT REJECTION)" plus session-observed additions.
Each anti-pattern is testable by the orchestrator's reviewer; do not
ship work that contains any of these.

## 1. Test Theater

**Anti-pattern.** Claiming "tests pass" without actually running
`pnpm run test`.

**Detection.** Manifest reports `testsPassed: true` but no
`tool:test` evidence atom; or evidence atom references a stale cache
key.

**Cost.** Reviewer must reject and re-spawn the work, doubling the
token spend on the task.

**Correct pattern.** Always run tests, capture the exit code, and pass
`--evidence "tool:test"` to `cleo verify`. The cache will skip re-running
if state is unchanged; running it is free.

## 2. Workaround Over Root Cause

**Anti-pattern.** Adding `// @ts-ignore`, `eslint-disable-next-line`, or
`as unknown as X` chains to suppress an error rather than fixing it.

**Detection.** Suppression comments or escape-hatch casts in the diff.

**Cost.** Technical debt accumulates; the actual contract violation
remains; the next worker encounters the same problem.

**Correct pattern.** Diagnose the type/lint failure; update the
contract in `packages/contracts/` or fix the source. Suppression is
permitted only with an inline TODO referencing a follow-up task ID,
e.g., `// @ts-ignore — TODO(T9999): legacy adapter pending refactor`.

## 3. Skipped Lint/Format

**Anti-pattern.** Committing without `pnpm biome check --write .`,
producing a diff with unrelated whitespace or import-order churn that
biome would normalize.

**Detection.** Reviewer's `pnpm biome check .` (in CI) reports
violations on lines the worker did not intentionally touch.

**Cost.** Biome's auto-fix produces large drive-by diffs in the next
PR; review noise drowns the actual change.

**Correct pattern.** Run `pnpm biome check --write .` BEFORE every
commit. Make biome's output part of the commit, not a follow-up cleanup.

## 4. New File Where Existing Suffices

**Anti-pattern.** Creating a new helper file when the existing utility
module could be extended.

**Detection.** Diff contains a new file in `src/` that exports a single
function which logically belongs alongside existing functions in a
sibling file.

**Cost.** Code duplication; future maintainers do not find the helper
because the search lands on the older file.

**Correct pattern.** Before creating any new file, run
`Grep "<related-keyword>" packages/<pkg>/src/` and add to the most
related existing module. NEVER create files unless they are absolutely
necessary.

## 5. `catch (err: unknown)`

**Anti-pattern.** Wrapping a function body in `try { ... } catch (err:
unknown) { ... }` and then casting `err` to read its `.message`.

**Detection.** Grep for `catch (err: unknown)` or `catch (e: unknown)`.

**Cost.** Defeats type narrowing; hides real error types; AGENTS.md
explicitly bans this.

**Correct pattern.** Use the contract's typed error classes from
`packages/contracts/src/errors.ts`. Throw and catch by class, not by
the generic `Error` shape.

```typescript
import { TaskNotFoundError, ValidationError } from "@cleocode/contracts";
try {
  ...
} catch (err) {
  if (err instanceof TaskNotFoundError) { ... }
  if (err instanceof ValidationError) { ... }
  throw err; // re-throw unknown
}
```

## 6. console.log in Production Code

**Anti-pattern.** Leftover `console.log("debug:", x)` after debugging.

**Detection.** `pnpm biome check .` flags it; grep for `console.log`
in `src/` (test files may legitimately log).

**Cost.** Spam in user-facing CLI output; potential PII leakage.

**Correct pattern.** Remove debug logs before commit. For genuine
operational logging, use the project's logger (LAFS envelope meta
field, or `packages/core/src/log/` if present).

## 7. Import Without Boundary Check

**Anti-pattern.** Adding an import that creates a circular dependency
or crosses a package boundary the consumer does not declare.

**Detection.** `pnpm run build` fails with module-resolution error, or
the build succeeds locally but CI's clean install fails.

**Cost.** CI-only failure; PR cannot land.

**Correct pattern.** Before adding an import: (a) check if the source
package is in the consumer's `package.json` dependencies; (b) if it's
a relative import within the same package, check for cycles by reading
the source's imports too.

## 8. Test Expectation Modification

**Anti-pattern.** A test fails; instead of fixing the implementation,
the worker modifies the test's expected value to match the actual
output.

**Detection.** Diff modifies `expect(x).toBe(...)` or `toMatchSnapshot()`
inputs in a test file without corresponding implementation changes.

**Cost.** Test no longer guards the original contract; the regression
ships silently.

**Correct pattern.** Determine which is wrong — the test or the
implementation. If the test was wrong (spec changed, contract updated),
update the test AND the source AND the spec. Never change the test
alone.

## 9. Worktree Boundary Violation

**Anti-pattern.** Editing files outside the worktree path the spawn
prompt assigned.

**Detection.** The git shim blocks most operations; if it slips
through, the change does not land in the PR.

**Cost.** Lost work; integration confusion; potential corruption of
sibling worker's branch.

**Correct pattern.** First action is `cd <worktree-path>`. All
subsequent paths SHOULD be absolute within the worktree. Use
`git rev-parse --show-toplevel` to confirm cwd if uncertain.

## 10. Self-Attestation Without Proof

**Anti-pattern.** "I completed the task" returned to the orchestrator
without `cleo verify` evidence atoms.

**Detection.** Manifest entry lacks evidence; `cleo show <id>` shows
gates pending; orchestrator cannot programmatically confirm completion.

**Cost.** Orchestrator must re-verify manually; if the work was not
actually done, the rollback is much more expensive.

**Correct pattern.** ADR-051 ritual. Every gate gets evidence; verify
re-validates programmatically. Self-attestation without atoms is
rejected by the post-ADR-051 system.

## 11. Skipped Memory Observation

**Anti-pattern.** Non-trivial task completed; session ends; nothing
new in BRAIN.

**Detection.** `cleo memory find <task-topic>` returns no new
observations from this session.

**Cost.** The next session relearns the same lesson; institutional
knowledge does not accumulate.

**Correct pattern.** After every non-trivial complete:

```bash
cleo memory observe "<learning, 1-2 sentences>" --title "<short title>"
```

The CLEO-INJECTION.md trigger row says this explicitly. Honor it.

## 12. Premature `cleo complete`

**Anti-pattern.** Calling `cleo complete` before all gates have been
verified, on the theory that the worker can verify in parallel.

**Detection.** Exit code 80 (`E_LIFECYCLE_GATE_FAILED`) or
`E_EVIDENCE_MISSING`.

**Cost.** Failed complete; worker must back out, re-verify, re-complete.

**Correct pattern.** Verify all six gates first; complete last. The
verify steps are fast (cached) and idempotent. No reason to skip.
