---
id: reconcile-deleted-files-atom
tasks: [T13364]
kind: fix
summary: release reconcile judges a files atom against the tag's history, so a file deleted later in the release is not stale
---

`cleo release reconcile v2026.10.5` failed with E_EVIDENCE_STALE. T13158's
`files:` atom names two files that T13167 deleted before the tag, and the
staleness check only asked whether each path exists in the working tree.
Re-verifying a task could not repair this, because reconcile reads the atoms
from the committed plan.

A `files:` path now counts as accounted for when it exists in the working
tree, or when a commit reachable from the release tag touched it. A path with
no history up to the tag is still stale. `cleo release verify-provenance`
applies the same rule.
