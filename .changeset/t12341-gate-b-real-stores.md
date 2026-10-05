---
id: t12341-gate-b-real-stores
tasks: [T12341, T12749]
kind: test
summary: real-store Gate B harness for row identity; the release recipe passes on five stores
---

`scripts/row-identity-real-store-gate-b.mjs` runs row-identity Gate B on a backup of one real store,
and never on the live store. In each project, the installed `cleo backup add` makes the backup
through the store's own chokepoint. The harness then opens four independent copies through the
runtime path, each in a sandboxed child process: one with the fill off, and three with it on (two
in UTC, one in America/Los_Angeles). It checks:

- replay with `--omit-row-identity`, which covers Gate B plus Gate C;
- determinism and timezone independence, with identity hashed;
- a negative control showing the fingerprint sees the identity columns;
- fill completeness;
- that the fill-off open writes no identity value.

On 2026-10-04 the recipe on main passed every check on cleocode, llmtxt, axiom-app, cleo-nexus and
axiom-instrument-studio. The results are recorded in spec `t12341-uid-scheme` v12, §15.0. This was
the last T12749 precondition for defaulting `CLEO_ROW_UID_FILL` on.
