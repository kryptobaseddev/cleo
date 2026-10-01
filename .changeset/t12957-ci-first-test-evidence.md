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
- After the PR merges, record `testsPassed`/`qaPassed` with `ci:<pr>`.
- Before merge, record `tool:test-affected` or a targeted `test-run:<json>`.
- While iterating, run only the failing or changed test files.
- A full `tool:test` is only for changes to root config.

CLEO-REFERENCE.md also describes the tool cache as keyed on the command and
the tree content under test, with failed-first and flaky reruns (T12958).

**Worker re-verification is scoped (T12962).** `defaultRunProjectTests`, used
by the sentient daemon to re-check a worker's exit, runs `tool:test-affected`
first. It runs the full `tool:test` only when affected planning refuses. Both
go through the ADR-061 cache, so a result the worker already recorded for the
same tree is reused. Mismatch audit rows name the scope that failed.

**Machine-wide heavy-run admission (T12963).** A `test` or `build` evidence run
that misses the cache now also takes a slot of the resource governor's
`test-run` or `scoped-build` class, after its tool slot, and releases both
together. On macOS, which has no PSI to scale the budget down under pressure,
`test` and `build` default to one slot machine-wide.
`CLEO_TOOL_CONCURRENCY_TEST` / `_BUILD` still set the count, and an explicit
override skips the governor.

**Evidence ergonomics (T12964).**
- `cleo verify --fresh` bypasses the tool cache for one call. It sets
  `CLEO_EVIDENCE_FRESH=1`, which still works on its own.
- `test-affected` is in `listValidToolNames()` / `VALID_TOOLS` and in the
  `--evidence` help.
- `cleo done` resolves tool commands in the execution root, as `cleo verify`
  does.
