---
id: memory-import-lessons
tasks: [T13949]
kind: feat
summary: "`cleo memory import-lessons` plans, then (with `--apply --expect-digest`) imports a Claude Code memory directory as BRAIN lessons with provenance per row"
---

`cleo memory import-lessons` brings a Claude Code memory directory into the
main brain as lessons. It reads `~/.claude/projects/<project root>/memory` by
default, or the directory given with `--from`.

- **Dry run by default.** It lists each planned lesson with its source file,
  memory type, rule and content hash, and each skipped file with the reason.
  It also prints a plan digest.
- **What becomes a lesson.** `feedback` and `project` memories do: the
  frontmatter description is the one-line rule and the body is the why.
  `user` and `reference` memories are skipped, as are memories whose rule is
  missing or longer than 200 characters, and memories with no body.
- **`--apply` needs `--expect-digest`** from the approved dry run. The apply
  re-plans the directory and writes nothing when the digest has changed. It
  writes a receipt (file, content hash, lesson id) to
  `.cleo/backups/migrations/` before the first write and updates it after
  each one.
- **Re-runs are safe.** Each lesson's text ends with its provenance line, so
  importing the same file again is reported as already present and nothing
  new is stored.
- **Source files are untouched.** The import never deletes or edits a source
  file.
