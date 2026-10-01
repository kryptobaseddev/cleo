---
id: t12957-ci-first-test-evidence
tasks: [T12957, T12962, T12963, T12964]
kind: feat
summary: Agent instructions recommend cleo done --plan, ci:<pr> after merge and tool:test-affected before it; worker re-verification runs affected tests first; heavy tool runs take a governor slot and default to one machine-wide slot on macOS; cleo verify --fresh; test-affected is a listed tool name.
---

**CI-first, scoped test guidance (T12957).** CLEO-INJECTION.md,
CLEO-REFERENCE.md, the spawn prompt and the ct-cleo, ct-task-executor,
ct-orchestrator and ct-ivt-looper skills no longer tell agents to run
`pnpm run test` and then record `tool:test`, which ran the suite twice. They
now say:
- Start with `cleo done <id> --plan`.
- When the PR has merged and the project sets `evidence.ciSatisfies`, record
  `testsPassed`/`qaPassed` with `ci:<pr>`.
- Otherwise record `tool:test-affected` when `testing.affectedCommand` is
  configured, else a targeted `test-run:<json>` or `tool:test`.
- While iterating, run only the failing or changed test files.
- With an affected command configured, a full `tool:test` is only for changes
  to root config.

CLEO-REFERENCE.md also describes the tool cache as keyed on the command and
the tree content under test, with failed-first and flaky reruns (T12958).

**Worker re-verification is scoped (T12962).** `defaultRunProjectTests`, used
by the sentient daemon to re-check a worker's exit, now runs in the worker's
own worktree (`WorkerReport.worktreePath`, or the canonical task worktree),
never in the daemon's checkout. There it runs `tool:test-affected` first, and
the full `tool:test` only when affected planning refuses. A busy test slot is a
retry-later rejection, not a full run. When the worker's tree is unknown, the
full suite runs in the project root. Every run goes through the ADR-061 cache,
so a result the worker already recorded for the same tree is reused. Mismatch
audit rows name the scope that failed, and `git status` is also read in the
worker's tree.

**Machine-wide heavy-run admission (T12963).** A `test` or `build` evidence run
that misses the cache now also takes a slot of the resource governor's
`test-run` or `scoped-build` class, after its tool slot, and releases both
together. On macOS, which has no PSI to scale the budget down under pressure,
`test` and `build` default to one slot machine-wide.
`CLEO_TOOL_CONCURRENCY_TEST` / `_BUILD` still set the count, and an explicit
override skips the governor.

**Evidence ergonomics (T12964).**
- `cleo verify --fresh` bypasses the tool cache for one call. It sets
  `CLEO_EVIDENCE_FRESH=1` for the command and restores it afterwards; the
  variable still works on its own.
- `test-affected` is in `listValidToolNames()` / `VALID_TOOLS` and in the
  `--evidence` help.
- `cleo done` resolves tool commands in the execution root, as `cleo verify`
  does.
