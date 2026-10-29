---
id: merged-cleanup-regenerable
tasks: [T14146]
kind: fix
summary: "Merged cleanup reclaims rebuildable build output, bounds its comparisons per run, and holds nested repo copies to every ref and reflog"
---

A merged, clean task worktree no longer stays on disk just because it holds
rebuildable output. `dist/`, `.turbo/`, `coverage/` and `*.tsbuildinfo` count
as redundant there, because the merged source rebuilds them. Every other
ignored path still has to match the main checkout byte for byte.

Two limits now apply across the whole run:
- **Comparisons:** a run proves trees identical within a shared budget of
  200,000 entries and 2 GiB, and never reads a single file over 64 MiB. A read
  error, a spent budget or an oversized file keeps that checkout, and the rest
  of the run continues.
- **Nested repository copies:** a copy gets no `node_modules` or build-output
  exemption. Every ref it holds, its own `origin` tracking refs included, and
  every reflog entry must be reachable from the project's `origin`.

Each worktree and copy is checked again immediately before it is removed.

Nested copies are now looked for only inside the worktree of a task that is
in scope (stored done or cancelled, and named when task ids are given). A
copy inside an active task's worktree may be someone's working directory, so
it is reported as kept with the reason `task active`.
