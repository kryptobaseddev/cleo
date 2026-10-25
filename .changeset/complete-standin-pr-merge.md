---
id: complete-standin-pr-merge
tasks: [T14026]
kind: fix
summary: "cleo complete judges an after-merge test-run at the merge a recorded pr: atom names, leads its refusal with why the evidence does not stand, and stops blaming the PR for a re-run or late failing merge-commit job"
---

`cleo complete` refused a merged task whose `testsPassed` was a `test-run:`
recorded on the default branch after the merge, with "the merge commit is not
known here", whenever the task was implemented by a `pr:` atom. The T13623
refusal re-judged the stand-in against the derived change set only, which a
`pr:`-implemented task never has. It now uses the same carry target as the
shared rule, so the refusal names the real reason the run does not stand in.

The inherited-failure attribution said "the PR introduced this failure" for any
merge-commit job that failed where its base passed. A re-run, or a run started
after a later default-branch commit landed, still refuses but now says it may
have failed on something that changed after the merge, such as secrets.
