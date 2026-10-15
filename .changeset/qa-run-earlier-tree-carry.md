---
id: qa-run-earlier-tree-carry
tasks: [T13644]
kind: fix
summary: A qa-run receipt recorded on an earlier tree carries while its checked roots, the task's current change and the shared tool configs are byte-identical; a refusal names the paths that changed
---

`cleo done --plan` and `cleo complete` refused every `qa-run:` receipt as soon
as the whole tree moved, before comparing anything, so an unrelated later
commit (a docs edit, another PR on main) voided a typecheck or lint receipt
whose checked files never changed. The refusal named no file.

The moved-tree check now runs `git diff` between the tree the receipt ran on
and the current tree over three path sets: the receipt's checked `roots`, the
task's current changed and deleted files (from the change set, or after merge
the landed carry target), and root-level tool inputs (`tsconfig*.json`,
`biome.json[c]`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`).
All identical: the receipt stands, and the existing after-merge rules still
apply. Any difference refuses and names the paths, so a file the change gained
outside the receipt's roots refuses rather than slipping past the
verify-time coverage check. With no change set known, or when git cannot
compare the trees, it refuses as before.
