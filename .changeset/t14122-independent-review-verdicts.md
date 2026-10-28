---
id: t14122-independent-review-verdicts
tasks: [T14122]
kind: feat
summary: "cleo review packet / verdict / check: a non-author reviewer judges each acceptance criterion from the PR diff alone and records a verdict bound to the PR head"
---

Council run 20261028T155822Z-293ed9f0 (D11211, blocking amendment 2) found
that both the old completion ritual and ADR-099 let the author alone decide
an acceptance criterion is met.

- `cleo review packet <pr> --task <id>` prints the PR diff at its head and the
  task's criteria. The PR title, body, comments, commit messages and
  changesets are withheld, so the author's `Closes:` lines and summary cannot
  steer the reviewer. The packet carries a sha256 of what it contains.
- `cleo review verdict <pr> --task <id> --ac ACn --met|--unmet --reason <text>
  --packet <sha256>` records the verdict as a `review.verdict` task audit row
  under the reviewer's own CLEO session, bound to the PR head. It is refused
  when the reviewer's session or agent id is an author of the task (its
  claim holders and creating session), when the task has no recorded author,
  or when the packet no longer matches the PR head. Nothing parses PR text.
- `cleo review check <pr> --task <ids>` reports, before merge, each
  criterion's state on the current head: met, or missing, unmet or stale
  (reviewed on an older head). It exits 1 on any gap.

`reviewVerdictsFor` and `judgeReviewVerdicts` are exported for the merge
sweep (T14101), which records `satisfies:` only from met verdicts.
