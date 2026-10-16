---
id: goal-close
tasks: [T13794]
kind: feat
summary: "cleo goal close <slug> --outcome <file> records a goal run's per-AC evidence and completes fully proven tasks through cleo done"
---

`cleo goal close` reads a `goal-outcome/v1` file. It refuses when the outcome's
lock does not match the sha256 of `.opencode/goals/<slug>/goal.yaml`, or when
its head commit does not exist.

Each passing criterion's evidence is recorded on the gate it demonstrates, with
`satisfies:<task>#AC<n>`, through the same write `cleo verify` and `cleo done`
use:
- a test report becomes `test-run:` on testsPassed;
- a file, contains or absent check becomes `commit:` + `files:` on implemented.

A verifier verdict never satisfies implemented or testsPassed, and neither a
diff guard nor a human sign-off maps to a gate. Close never replaces a gate a
task already holds.

A task whose criteria `cleo done --plan` all maps is completed through the
`cleo done` path. Every other task stays open, and the envelope names each open
AC with its blocker. Re-running with the same outcome records nothing new.
