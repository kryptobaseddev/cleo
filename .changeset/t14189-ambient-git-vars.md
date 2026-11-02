---
id: t14189-ambient-git-vars
tasks: [T14189]
kind: fix
summary: "every CLEO git call that must act on its own checkout ignores the full set of repository variables a git hook exports"
---

`discoveryEnv()` is CLEO's one strip of the git variables that name a
repository, an index or an object store. It now also removes
`GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`, `GIT_PREFIX`,
`GIT_SHALLOW_FILE` and `GIT_QUARANTINE_PATH`, so a `cleo` call inside a git hook
never acts on the hook's repository through any of them. The cloud vault's
git-tracking read and `cleo audit reconstruct` used their own copies of the
list and now share it.
