---
id: project-move-reroot
tasks: [T12552, T12553, T12555, T12556, T12558]
kind: fix
summary: "`cleo project move --dry-run` is now a pure plan; move failures are real `success:false` envelopes; nested `.git`/`node_modules` survive a move; a moved copy gets a fresh checkout nonce; new `cleo project reroot <childDir>`"
---
**`cleo project move` did not do what it said, and it could hand the registry to a stale copy.**

- **Dry run (T12552).** `project.ts` read `--dry-run` and then dropped it, and
  `moveProject` had no dry-run parameter. A "dry run" copied the tree, rewrote
  `project-info.json` and changed the registry. `moveProject(newPath, root,
  { dryRun: true })` now returns a `ProjectRelocationPlan` (source, target,
  entries copied and excluded, files written, registry action). It writes
  nothing and opens no database.
- **Error envelopes (T12553).** `project move`, `rename` and `re-register`
  rendered engine failures as a SUCCESS section and then called
  `process.exit(1)`. They now emit `cliError` with the engine's code, message
  and fix, and exit with the engine's exit code. For example, `E_MOVE_FAILED`
  exits 3 and `E_INVALID_TARGET` exits 2.
- **Copy filter (T12555).** The `cp` filter tested the basename at every depth,
  so a nested repository's `.git` and every workspace `node_modules` were
  dropped. Only the ROOT-level `.git` and `node_modules` are skipped now, and
  the result lists them in `excluded`. Symlinks are copied verbatim
  (`verbatimSymlinks`), so a relative link does not point back into the source.
- **Nonce (T12556).** The copy kept the source's `checkoutNonce`. If the real
  project was later moved by hand, running any command in the stale copy
  promoted the copy to live and demoted the real project to a candidate. The
  copy now gets a fresh nonce. `move` rebinds the registry to the copy
  explicitly, and the old tree becomes a `candidate` location.
- **Reroot and target checks (T12558).** `move` refuses a target inside the
  project or containing it (`E_INVALID_TARGET`) before any IO, and the fix
  hint points to `cleo project reroot`. That new command makes a subdirectory
  the project root. It refuses while a session or CLEO worktree is active,
  takes a required checkpoint (`cleo backup add`), and closes every handle.
  It then RENAMES `.cleo/` and `.worktreeinclude` into the child. It confirms
  or writes `.cleo/project-id` with the same id and writes no absolute
  `projectRoot`. Finally it promotes the child to `live` and demotes the old
  root to `missing`. `--dry-run` is pure. The registry rebind runs with the
  project scope pinned to the new root, so no empty `cleo.db` is recreated at
  the old one.
