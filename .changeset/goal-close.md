---
id: goal-close
tasks: [T13794]
kind: feat
summary: "cleo goal close <slug> --outcome <file> records a goal run's per-AC evidence and completes fully proven tasks through cleo done"
---

`cleo goal close` reads a `goal-outcome/v1` file. It refuses when the outcome's
lock does not match the sha256 of `.opencode/goals/<slug>/goal.yaml`, or when
its head or base commit does not exist.

The outcome's pass flags, exit codes and verdicts are treated as claims. Before
recording anything, CLEO re-checks what it can:
- file, contains and absent checks re-run against the head commit's tree, and
  become `commit:<head>` + `files:` on implemented;
- a test report must hash to its `reportSha256` and becomes `test-run:` on
  testsPassed;
- the project's typecheck or lint command becomes `tool:typecheck` /
  `tool:lint` on qaPassed, run by CLEO's own tool runner;
- a drafted `cleo verify --run --req` check and a human sign-off record
  nothing; they count only when CLEO's own typed-gate or manual record maps
  the AC;
- a verifier verdict (its quotes re-read at head) and a diff guard never
  satisfy a gate.

Evidence goes through the same write `cleo verify` and `cleo done` use, with
`satisfies:` in the contract's own reference form (positional, uuid or pinned).
It never replaces a gate a task already holds.

A task whose criteria `cleo done --plan` all maps is completed through the
`cleo done` path. Every other task stays open, and the envelope names each open
AC with its blocker. Re-running with the same outcome records nothing new.
