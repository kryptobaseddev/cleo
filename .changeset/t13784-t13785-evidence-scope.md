---
id: t13784-t13785-evidence-scope
tasks: [T13784, T13785]
kind: fix
summary: "Unrelated commits on main no longer stale a test-run, and a parent task closes on its done children's PRs instead of pr-ambiguous"
---

**T13784.** A targeted `test-run:` went stale whenever main moved. An unrelated
commit landing after the run (VidaPeps: a print-bridge commit 90 s later) made
`cleo verify` refuse the report, and a tree move after verify made the
post-merge stand-in refuse it. Staleness now looks only at the change's own
files, the test files the report ran and the root test configs. On the default
branch, a run followed by a pull of main records `runHeadSha` (HEAD as of the
run); `cleo done --plan` and `cleo complete` refuse the report only when the
commits it did not see touched those paths. A commit of the change itself, any
local edit after the run, and `qa-run:` receipts keep the strict rule.

**T13785.** When several merged PRs cited a parent task whose work was split
across its children, `cleo done --plan` stopped with `pr-ambiguous`. A PR that
also cites one of the parent's done children now counts as the parent's own
work: each is recorded as an `implemented` attempt carrying the parent's
criteria, as for a task shipped across several of its own PRs (D11151). A PR
of a child that is not done still leaves the candidates ambiguous.
