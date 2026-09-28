---
id: project-move-reroot
tasks: [T12552, T12553, T12555, T12556, T12558]
kind: fix
summary: "`cleo project move` now RENAMES the project root on one device (no copy, no torn DB, no stale copy); dry runs are pure, structured plans; failures are real `success:false` envelopes; new resumable `cleo project reroot <childDir>` with an E_PROJECT_MOVED tombstone"
---
**`cleo project move` copied a live project and could leave two diverging copies.**
The copy dropped `.git`. It also snapshotted `cleo.db` while a WAL writer was
active, so moved databases came out malformed or missing rows. In testing, a
copy made under a concurrent writer held 723 of 29,796 committed rows. The
source stayed live, so the registry could later bind to the stale copy.

- **Move is a rename (T12555, T12556).** `moveProject` now renames the whole
  root on the same device. `.git`, the database, its WAL sidecars and the
  checkout nonce move atomically, and nothing is left at the old path.
  - It refuses a target on another device (by `st_dev`, or EXDEV from the
    rename) with `E_CROSS_DEVICE`. The fix points to a plain `mv` followed by
    `cleo nexus reconcile`. There is no copy mode.
  - It refuses while a session, CLEO worktree or git worktree is bound
    (`E_MOVE_BLOCKED`, exit 21).
  - It takes the `cleo backup add` checkpoint and copies it to
    `<cleoHome>/backups/<projectId>/`, outside the tree it protects.
  - The registry rebind runs with the project scope pinned to the new root.
    The old path becomes `missing`.
  - `project-info.json` is not rewritten, so `projectHash` stays byte-identical
    and no `projectRoot` is written.
- **Dry run (T12552).** `--dry-run` was dropped by the CLI, so a "dry run"
  copied and rebound. It now returns a typed `ProjectRelocationPlan` under
  `/data`: source, target, entries, writes, registry action, checkpoint
  location, blockers (including `E_CROSS_DEVICE`) and deferred checks. It
  writes nothing and opens no database.
- **Error envelopes (T12553).** `project move`, `rename` and `re-register`
  printed failures as SUCCESS sections and then exited 1. Every failure now
  goes through `cliError` with the engine's code, fix and exit class.
  `scripts/lint-envelope-compliance.mjs` encoded the old rule; it now requires
  the new one, and a test covers it.
- **Reroot (T12558).** New `cleo project reroot <childDir>`.
  - It renames CLEO's own top-level entries into the child: `.cleo/`,
    `.worktreeinclude`, and `.github/` only when it holds nothing but CLEO's
    init templates. Everything else stays in place.
  - It is refused while bound (`E_REROOT_BLOCKED`, exit 21). The fix gives
    `CLEO_SESSION_ID=<id> cleo session end` for each session.
  - It takes the same outside checkpoint. It confirms or writes
    `.cleo/project-id` with the same id, rebinds the registry, and demotes the
    old root to `missing`.
  - An identity-write failure after the rename rolls the rename back. A crash
    between the rename and the rebind is finished by running
    `cleo project reroot .` from the child, which leaves exactly one live row.
- **Old-root refusal (T12558).** Reroot leaves `<oldRoot>/.cleo-moved.json`.
  Project resolution at the old root, and a first-time store open there, now
  refuse with `E_PROJECT_MOVED` and name the new root. Before, they silently
  created an empty `cleo.db` that answered every read with nothing. The
  refusal also applies after `git checkout -- .` restores the tracked
  `.cleo/project-id`, and when the tombstone is gone but the registry marks
  that location `missing`.
- `move` refuses a target inside the project or containing it
  (`E_INVALID_TARGET`) before any IO. For a directory target the fix hint
  points to `reroot`. Both verbs resolve the project root the way other
  commands do, so `move` works from a subdirectory and `reroot .` works from
  the child.
