---
id: t13525-keep-stored-typed-pass
tasks: [T13525]
kind: fix
summary: "a cache-only gate write (--no-run, or cleo complete's merged-CI record) no longer wipes a typed gate's stored pass after HEAD moves; a pass that still proves the gate on the same inputs is kept"
---

A gate write replaces all of a task's stored typed results with the results
of its own run. In a cache-only write (`--no-run`, or `cleo complete`
recording `ci:<pr>`), a typed gate with no cache entry for the current HEAD was
recorded as not run. The cache is keyed on HEAD, so after any commit an
unrelated write turned earlier passes into errors, and `cleo complete` then
refused the task.

Such a write now keeps the stored pass when it still proves the same thing a
cache entry would: same gate kind and REQ-ID, criterion id and text, gate
definition, invocation and input bytes. It is re-bound to the write and marked
`source: cache`. A pass whose inputs changed is not reused, and the gate stays
unmet.
