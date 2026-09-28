---
id: init-nested-git-root
tasks: [T12562]
kind: fix
summary: "`cleo init` in a git repo nested under a CLEO project now initializes that repo. It no longer targets the parent or advises `--force` against it, and `--force` refuses any root other than cwd and snapshots first"
---
**P1 data-loss vector: `cleo init` could re-initialize an ancestor project.**
From a child git repository under an initialized CLEO root, init resolved the
target through the ancestor walk (`resolveProjectByCwd` crosses `.git`
boundaries), found the PARENT `.cleo/`, and failed with "Project already
initialized. DANGER ZONE: use --force to wipe and re-init." Following that
hint re-initialized the parent store (its `config.json` was overwritten and
its `cleo.db` rewritten).

- New `resolveInitTarget` picks init's target. In order: `--here` targets cwd.
  An explicit pin (worktree scope, absolute `CLEO_DIR`, `CLEO_ROOT`) is
  honoured. A cwd that is its own git root (`.git` is a directory) targets
  itself. Anything else keeps the existing resolution. Other commands still
  walk up from subdirectories; only init's target selection changed.
- A plain (non-git) subdirectory of a CLEO project still resolves to that
  ancestor. Init reports it by absolute path, changes nothing, never suggests
  `--force`, and points at `cleo init --here` for a separate project.
- `--force` refuses any target that is not cwd (compared by realpath). Before
  a forced re-init of cwd it takes a `VACUUM INTO` snapshot of the project
  databases into `.cleo/backups/sqlite/`, and refuses when none was written.
- Every "already initialized" error names the resolved root as an absolute path.
- The scaffolding steps run inside a project scope pinned to the chosen
  target, so none of them resolves back up to the ancestor while the target's
  `.cleo/` is still being created.
