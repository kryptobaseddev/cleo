---
id: prevent-store-corruption-git-and-cloud-sync
tasks: [T14549]
kind: fix
summary: "cleo doctor now catches the two known causes of a malformed store: git-tracked .cleo runtime files (with a lossless --fix) and a project inside a cloud-synced folder"
---

Two known causes corrupt a project's `.cleo/cleo.db`:

- **Git tracks a runtime file (ADR-013 §9, T5158).** A checkout or pull
  replaces the main database file while its `-wal` stays behind.
- **The project is in a file-synced folder.** iCloud Desktop & Documents,
  Dropbox, OneDrive and Google Drive upload and restore `cleo.db`, `-wal` and
  `-shm` separately.

CLEO now prevents both:

- `cleo doctor` names each `.cleo/` runtime file git tracks: an error for
  SQLite store files and their sidecars, a warning for other runtime files
  (config, logs, metrics). The runtime set is the EXPLICIT DENY block of the shipped `.cleo/.gitignore`,
  which now also denies `quarantine/`. The tracked identity files
  (`project.json`, `project-id`) are never flagged.
- `cleo doctor --fix` untracks those files with `git rm --cached` only.
  Working files stay byte-identical. The fix refreshes `.cleo/.gitignore` and
  prints the commit to make. Running it again changes nothing.
- `cleo doctor` warns when a commit on any ref (branch, tag, remote) added a
  runtime file. History is reported, never rewritten. When git cannot be
  read inside a real repository, the git checks report "check incomplete"
  (`info`, also on plain `cleo doctor`) instead of a clean result.
- `cleo doctor` warns, and never blocks, when the project root is inside a
  cloud-synced folder. Detection uses local filesystem signals only; an
  unreadable signal makes the check incomplete, never fatal.
- The managed pre-commit hook refuses a commit that adds or modifies a
  `.cleo/` path the deny list names, and names the fix. Git matches
  the runtime paths itself (embedded pathspecs), so no quote, space or newline
  in a name slips past, and renames and type changes are checked too. Staged deletions pass,
  so the repair commit goes through. A foreign pre-commit hook is no longer
  skipped. It is chained instead: its content is kept, and it runs first so
  CLEO checks the index it leaves.
- `cleo init`, `cleo upgrade` and `cleo session start` warn when git tracks
  runtime files and give the fix (`session start` returns them as
  `storeSafetyWarnings`, typed by the `SessionStartWarnings` contract). The check costs one `git ls-files` call.
  `cleo init` on a clone that tracks the store refuses with the untrack fix
  instead of recommending `--force`.
