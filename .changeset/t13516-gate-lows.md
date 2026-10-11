---
id: t13516-gate-lows
tasks: [T13516]
kind: fix
summary: "a typed test gate fails on a non-zero failed count even with exit 0, and cleo complete names cleo verify --run (not --no-run) when typed gates have no cached pass"
---

- A typed test gate with `expect: "pass"` now fails when the output reports a
  non-zero `N failed` or `N failure(s)` count, even if the runner exited 0.
  Before, only `FAIL`, `failing` or `Error:` counted, so `3 failed` passed.
- When `cleo complete` cannot record merged CI because a typed gate has no
  usable cached pass (`E_GATE_CACHE_DISABLED` or `E_GATE_NOT_CACHED`), its
  reason now names `cleo verify <id> --run`. It no longer repeats the gate
  write's `--no-run` wording, which the user never passed.
