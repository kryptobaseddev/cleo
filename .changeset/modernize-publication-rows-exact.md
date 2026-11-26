---
id: modernize-publication-rows-exact
tasks: [T14631]
kind: fix
summary: "cleo docs modernize: merged or deleted mirrors lose their ledger rows, a row already at a move target is kept, and rollback restores every row exactly"
---
- A tree apply that merges or deletes a published mirror now removes its
  `docs_publications` row (journaled `move-publication` with a null target), so
  `cleo docs status` no longer shows a row on a path that is gone.
- A move onto a path that already has a row for the same owner and blob keeps
  that row untouched instead of overwriting its sha; rollback leaves it there.
- The move and the rollback carry `publishedAt` unchanged, so a rolled-back
  ledger matches the one before the apply exactly.
- Case-only rename detection uses `lstat` and requires the two paths to differ
  only in case, so a hard link to a kept file is removed when it is not a survivor
  (a symlinked file stays refused before any write).
