---
id: t14189-checkpoint-hook-index
tasks: [T14189]
kind: fix
summary: "a cleo call inside a git hook no longer stages .cleo state files (config.json, project-info.json) into the hook's index"
---

Git exports `GIT_INDEX_FILE` to its hooks. The `.cleo` checkpoint pointed git
at its own repository by overriding only `GIT_DIR` and `GIT_WORK_TREE`, so a
`cleo` call from a hook ran the checkpoint's `git add` (and its failure
`reset`) against the HOOK's index, staging `.cleo` state files as root paths
for the next commit.

The checkpoint environment now strips every ambient repo variable
(`GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`,
`GIT_OBJECT_DIRECTORY`) before pointing git at `.cleo`'s repository. The same
applies to the other CLEO paths that stage or commit: `cleo init`'s initial
commit and checkpoint-repo setup, `cleo docs publish`, the release git helper,
the component-PR hunk check, and the self-improve and skill-patch runners.
