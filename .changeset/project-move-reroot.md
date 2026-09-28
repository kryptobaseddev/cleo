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
  - The tombstone is honoured only when it is provably current. It must
    name the project the root declares, and `movedTo` must hold a `.cleo/`
    for that same project. Any other tombstone (committed, copied into a
    clone, stale or forged) is ignored with a `W_TOMBSTONE_IGNORED` warning,
    so it cannot brick a project.
  - Reroot lists the tombstone in the old root's `.git/info/exclude`, and
    this repository's `.gitignore` ignores it.
  - A command-time encounter no longer flips a `missing` location back to
    `candidate` while the project is live elsewhere on the device. That flip
    had disarmed the store guard in the real CLI.
  - `E_PROJECT_MOVED` is a registered code: exit 9 (`PROJECT_MOVED`), with
    a `cd "<movedTo>"` fix and `details.movedTo` on every path. Errors
    thrown outside dispatch keep their typed code instead of becoming
    `E_CLI_UNCAUGHT`, and `init` failures keep theirs instead of becoming
    `E_INTERNAL`.
  - The registry arm only fires in reroot geometry, where the live path is
    strictly inside the refused root. A fresh clone into a directory a
    project was MOVED away from is therefore a normal checkout.
  - A tombstone is valid only when `movedTo` is absolute and strictly inside
    the tombstone's own directory. That defeats a committed tombstone in a
    same-machine second clone and a relative decoy.
  - The exclude line is written through
    `git rev-parse --git-path info/exclude`, anchored at `--show-prefix`, so
    it works for subdirectory roots and when `.git` is a file.
  - A hand-undone reroot reconciles to exactly one live row. A location
    counts only while it still holds `.cleo/` for the id.
  - Each ignored tombstone warns once.
  - `cleo doctor *` is never blocked by the tombstone. At a refused root,
    `doctor project-identity` points to the live root or to `init --here`.
  - The relocation checks integrate with #1605's init target resolution
    (T12562). They write nothing and run BEFORE the already-initialized and
    worktree guards, so a relocated root is never told to use `--force`.
    `E_PROJECT_MOVED` (exit 9) never collides with the `INIT_ERROR_CODES`
    refusals (exit 1 with `details.codeName`), and it keeps its code on both
    the CLI and dispatch init paths.
  - #1605's target refusals (worktree, gitlink, force-not-cwd, ancestor) run
    before the relocation refusals, so a relocation opt-out can never reopen a
    target CLEO cannot use. A gitlink checkout's enclosing project is found
    by walking up from its parent, never from its own `.cleo/`, so a
    submodule that carries reroot relocation state is still refused with
    `E_INIT_GITLINK_UNSUPPORTED`.
  - An id minted by `--new-identity` gets a `projectHash` derived from that
    id, never from the path. Two projects that share a path therefore never
    share a hash.
  - At a relocated root, `cleo init --here` alone is refused. It would adopt
    the live project's id and create a second store for one project.
    `cleo init --here --new-identity` starts a genuinely DIFFERENT project
    there instead: it mints a new id, retires the restored
    `.cleo/project-id`, warns that the new id needs committing and that the
    project name is now ambiguous (suggesting `cleo project rename`, without
    renaming anything), and logs to `.cleo/audit/relocation-override.jsonl`. Every refusal text and the
    doctor remedy name `cd "<movedTo>"` first.
  - An unreadable checkout (EACCES, EPERM) is not treated as vanished; only
    ENOENT on `.cleo/` is. So a same-nonce backup copy cannot take the row
    from a `chmod 000` original.
  - An original checkout that returns is never stuck at `missing`. It becomes
    a `candidate`, and it re-takes the row when the holder's recorded nonce
    differs from its own.
  - A refused `init` scaffolds nothing. `cleo nexus reconcile` at a refused
    root returns `E_PROJECT_MOVED` (exit 9), not `E_INTERNAL`.
  - `init` refuses before writing anything, so it never reports success with
    a "deferred" store. The new `cleo init --here` starts a new project in a
    directory below a rerooted root.
- Cross-device relocations: `reroot`'s dry run also compares `st_dev`, and
  EXDEV from either verb is `E_CROSS_DEVICE`, not a permissions error. The
  fix says to end sessions, stop writers and run `cleo backup add` before a
  cross-device `mv`. A git-worktree blocker suggests `git worktree prune`.
- `move` refuses a target inside the project or containing it
  (`E_INVALID_TARGET`) before any IO. For a directory target the fix hint
  points to `reroot`. Both verbs resolve the project root the way other
  commands do, so `move` works from a subdirectory and `reroot .` works from
  the child.
