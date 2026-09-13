---
id: heavy-tool-deadline-per-canonical
tasks: [T12126]
kind: fix
summary: per-canonical evidence-tool deadline — test/build get 30 min, lint/typecheck stay at 5 (gh#1221)
---

The single 300s spawn deadline was below a real monorepo test suite (~10 min
in the gh#1221 report), so every `tool:test` run was killed before finishing —
and the timeout path deliberately caches nothing, because an unfinished run is
not a result. The cache could therefore never hit: not because the key moved,
but because no entry was ever produced, on a path that always fired. Each
attempt still ran the suite at full parallelism for the full 300s before
discarding it.

`test` and `build` now default to 30 minutes; `lint`, `typecheck`, `audit` and
`security-scan` deliberately stay at 5. A suite is not a linter, and a lint
that has run for five minutes is hung rather than busy — letting it inherit the
heavy budget would turn a hang into a 30-minute hang.

30 min is 3x the measured suite, so a project whose suite triples still
completes on the default instead of discovering an env var after burning 5
CPU-minutes to learn its name. It is a ceiling on a pathological hang, not a
budget to plan against.

A longer deadline is only safe because heavy tools are now spawned inside a
memory-bounded scope with swap denied (T12116): duration no longer converts
into unbounded host memory, so a runaway dies inside its own boundary and CLEO
reports a failed run. A failed test run is a result; a frozen workstation is
not.

An invalid `CLEO_TOOL_TIMEOUT_<TOOL>` now names the default that applies to
THAT tool, so an operator is never told "300000" while a `test` run would have
used 1800000.
