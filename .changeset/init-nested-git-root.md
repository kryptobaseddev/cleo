---
id: init-nested-git-root
tasks: [T12562]
kind: fix
summary: "`cleo init` in a git repo nested under a CLEO project now initializes that repo instead of the parent. It refuses inside linked worktrees and submodules, never advises `--force` for another root, and `--force` snapshots every file it resets before touching anything"
---
**P1 data-loss vector: `cleo init` could re-initialize an ancestor project.**
From a child git repository under an initialized CLEO root, init resolved the
target through the ancestor walk (`resolveProjectByCwd` crosses `.git`
boundaries) and found the PARENT `.cleo/`. It then failed with "Project
already initialized. DANGER ZONE: use --force to wipe and re-init."
Following that hint re-initialized the parent store.

- New `resolveInitTarget` picks init's target. In order:
  1. `--here` targets cwd.
  2. An explicit pin is honoured: worktree scope, absolute `CLEO_DIR` or `CLEO_ROOT`.
  3. A cwd that is its own git root (a `.git` directory) targets itself.
  4. Anything else keeps the existing resolution.

  Other commands still walk up from subdirectories.
- **Linked worktrees.** Init refuses inside a linked worktree
  (`E_INIT_IN_WORKTREE`), with or without `--here`. A worktree shares its main
  checkout's project, and a `.cleo/` there would be an orphan store (D009).
  The only exception is `--map-codebase`, which is additive, against the
  initialized main project.
- **Submodules and `--separate-git-dir` checkouts under a CLEO project.**
  Init refuses there (`E_INIT_GITLINK_UNSUPPORTED`), with or without `--here`
  or `--force`. Project-root resolution still walks past a gitlink root, so a
  store created there would be ignored: every later command would use the
  superproject's store. The message says so. Giving submodules their own
  store is tracked separately. With no enclosing CLEO project, init behaves
  as before.
- **Worktree of a submodule.** The advice now names the submodule checkout
  (read from `core.worktree`), not the git-internal `.git/modules/<name>`
  path. When the checkout cannot be determined, the advice is omitted.
- **Non-git subdirectory of a CLEO project.** It still resolves to that
  ancestor. Init reports the ancestor by absolute path, changes nothing and
  points at `cleo init --here` (`E_INIT_ANCESTOR_PROJECT`). If an uninitialized
  git repository sits between cwd and the ancestor, the advice points at that
  repository instead.
- **`--force` refusal.** `--force` refuses any target that is not cwd
  (`E_INIT_FORCE_NOT_CWD`). No refusal ever advises `--force` for another root.
- **`--force` snapshot.** `--force` resets `config.json` and
  `project-info.json` and rewrites `.cleo/.gitignore` and the managed git
  hooks. Before any of that it takes a `cleo backup add` snapshot (restorable
  with `cleo restore backup`): `VACUUM INTO` for the databases and atomic
  copies of the JSON files. It also copies the `.gitignore`,
  `project-context.json` and the managed hooks alongside. The hooks come from
  both `.git/hooks` and the directory git actually uses: a custom
  `core.hooksPath`, or a gitlink checkout's git dir. If any of these is missing from
  this run's snapshot, init refuses and changes nothing
  (`E_INIT_SNAPSHOT_FAILED`).
- **Error codes.** Refusal codes and fixes now reach the CLI envelope
  (`codeName`, `fix`) and the dispatch engine. Previously the CLI reported
  `E_INTERNAL`, and the engine rewrote the error as "use force=true".
- **Submodule stores.** `isGitLinkedCheckout` and
  `_resolveMainRepoFromGitlink` now treat only `<common>/worktrees/<name>`
  gitlinks as linked worktrees. Before this, the submodule gitdir
  `<super>/.git/modules/<name>` was stripped to the superproject by
  coincidence. No existing data is re-routed: a submodule still resolves to
  the superproject through the ancestor walk.
- The scaffolding steps run inside a project scope pinned to the chosen target.
