---
id: gate36-merge-base
tasks: [T13294]
kind: fix
summary: Gate 36 rule 7 compares migrations with the merge-base, so a new main migration no longer fails every older PR
---

Rule 7 of `scripts/lint-sync-schema.mjs` compared the branch's migration files
with the base tip. When a migration landed on main, every open PR cut earlier
failed with "released migration deleted". The check fired on a CI re-run, on a
stacked PR, and locally in `cleo check arch`. Each of those cost a main merge
and a re-review.

"Released" now means present at `git merge-base HEAD <base>`. A migration the
base gained after the branch was cut is not on the branch yet, and that is not
a deletion. Deleting or editing a migration that was released at the merge-base
still fails. Without shared history (a shallow clone) the gate falls back to the
base tip and says so. The arch-boundary job's checkout now fetches full history,
so CI always has a merge-base.
