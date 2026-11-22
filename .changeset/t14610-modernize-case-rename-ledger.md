---
id: t14610-modernize-case-rename-ledger
tasks: [T14610]
kind: fix
summary: "cleo docs modernize keeps case-only renamed files on case-insensitive filesystems and moves a moved mirror's publication row"
---

On a case-insensitive filesystem (macOS APFS, Windows NTFS), a tree apply
that renamed `adr/ADR-068-x.md` to `adr/adr-068-x.md` wrote the new bytes
into the old entry (both names are one file) and then removed the old name,
which deleted the file. Apply now removes the old name first when both names
are the same file on disk, so the write creates the new one, and it never
removes a path that resolves to a file it keeps. Both steps are journaled, so
`--rollback` restores the old name.

A tree move of a published mirror also left its `docs_publications` row on
the old path, so `cleo docs status` reported it deleted and the new path
unpublished. Apply now moves the row to the new path as a journaled
`move-publication` step, and `--rollback` moves it back.
