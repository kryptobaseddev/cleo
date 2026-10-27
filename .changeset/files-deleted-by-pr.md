---
id: files-deleted-by-pr
tasks: [T14030]
kind: fix
summary: "A files: path the cited PR deleted is refused by name instead of as an unfetched merge"
---

With `pr:<n>`, a `files:` list that named a path the PR deleted failed
`E_EVIDENCE_INSUFFICIENT` with "Cannot inspect <path> at PR merge …; fetch
that commit", which sent the author to fetch a commit they already had. The
path is absent from the merge tree because the PR deleted it. It is now
refused with `E_EVIDENCE_INVALID`, naming the PR that deleted it and telling
the author to leave it out of `files:` (and name the deletion in `note:` if it
matters). `cleo done --plan` already lists deleted paths under `deletedFiles`,
never in the `files:` of `implementedEvidence`.
