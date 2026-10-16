---
id: t13649-typed-gate-evidence-root
tasks: [T13649]
kind: fix
summary: typed gates honour CLEO_EVIDENCE_GIT_ROOT, so a worktree's run is cached under the worktree's HEAD, not the primary checkout's
---

Typed gates chose their tree (where they run, and the git HEAD and tree their
cache is keyed to) from the invocation directory only. When that directory was
the store root, a gate run for a linked worktree was keyed to the primary
checkout's HEAD even though the caller named the worktree with
`CLEO_EVIDENCE_GIT_ROOT`. The only workaround was to export `GIT_DIR` and
`GIT_WORK_TREE`.

The typed-gate tree now consults the evidence declaration first
(`CLEO_EVIDENCE_GIT_ROOT`, `GIT_WORK_TREE`, or `evidence.gitRoot` in
`.cleo/project-context.json`), as evidence tools already do, and then the
invocation directory. A declared tree is used only when it is this project's
checkout or one of its linked worktrees. `cleo verify --run` also reports the
HEAD the cache is actually keyed to.
