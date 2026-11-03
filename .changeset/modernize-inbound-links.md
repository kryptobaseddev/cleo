---
id: modernize-inbound-links
tasks: [T14194]
kind: fix
summary: "docs modernize re-points links into moved files from --exclude'd folders as link-fix rows, without storing those files"
---

A scoped `cleo docs modernize <root> --exclude <folders>` run moved files but
never looked at the excluded folders, so their links to the moved files broke.
(T14108 group 1 found 15 such hrefs, in 26 places across 5 files.)

- The dry run now reads, never plans, every markdown file under the root that
  the scan left out. Each of its relative links to a moved file becomes a
  `link-fix` row that carries the file's sha256.
- `--apply` edits exactly those hrefs on disk, refuses a file whose bytes
  changed since the plan, and writes nothing to the store for it.
- Rollback restores it like any other written file.
- Files outside the root are still listed in a row's `refs`, never rewritten.
