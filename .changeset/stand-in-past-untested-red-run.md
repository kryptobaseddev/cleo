---
id: stand-in-past-untested-red-run
tasks: [T14176]
kind: fix
summary: "The ci: stand-in looks past a later main run whose failing jobs tested nothing (runner cancel or worker crash)"
---

The `ci:` stand-in for a superseded merge-commit run (T12742) walks later main
commits, and the first decisive one decides. A run red only because its runner was
cancelled, or because a test worker crashed with no test failed, decided nothing
about the PR. It already counted as superseded on the merge commit (T14049, T14074),
but on a later commit it refused the stand-in.

The walk now passes over such a run, records it in `passedOverRuns` with the cause,
and goes on to the next candidate, which must still keep the PR's change intact.
This was T14157's shape: main 6450effe7's Scripts Tests job died on a runner shutdown
during the build. A run with any failed test, or any other error, still refuses: a
green run is never shopped for past a failure that could be the PR's.
