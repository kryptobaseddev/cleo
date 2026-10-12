---
id: t13582-init-root-only
tasks: [T13582]
kind: fix
summary: "The 'initial: cleo init' task-ID allowance applies only to a project's first, parentless commit"
---

T13577 let commit-msg and pre-push accept the exact subject `initial: cleo init`. That allowed any commit to use the subject to skip the task-ID check. Pre-push now accepts it only for a root commit (`git rev-list --parents` shows no parent), and commit-msg only while HEAD does not resolve yet, which means the commit being made is the first one. A later commit with that subject is refused like any other untagged commit. The previous template hashes join `legacy-hashes.json`, so `cleo upgrade` refreshes installed copies.
