---
id: memory-import-lessons
tasks: [T13949]
kind: feat
summary: "`cleo memory import-lessons` plans, then (with `--apply --expect-digest`) imports a Claude Code memory directory as BRAIN lessons with provenance per row"
---

`cleo memory import-lessons` brings a Claude Code memory directory into BRAIN
as lessons. It reads `~/.claude/projects/<project root>/memory` by default, or
`--from <dir>`.

**What becomes a lesson, and where:**
- A `feedback` memory is a process rule, so it becomes a lesson in the main
  (global) brain.
- A `project` memory is a fact about one project, so it becomes a lesson in
  that project's brain and never reaches other projects or devices.
- In both cases the frontmatter description is the one-line rule and the body
  is the why.

**What is skipped, each with its reason:**
- `user` and `reference` memories.
- Memories whose description or first body line starts with PARTLY WRONG,
  WRONG or SUPERSEDED.
- Missing rules and rules over 200 characters.
- Empty bodies.
- Files named with `--exclude a.md,b.md` or listed in `--exclude-from <file>`.

**How it runs:**
- A dry run is the default. It lists each lesson with its target scope,
  source file and content hash, and prints a digest over file, content hash
  and scope, taken after the exclusions. Only that exact set and those scopes
  can be applied.
- `--apply` needs `--expect-digest` and the same exclusions. It re-plans and
  writes nothing on a mismatch.
- The apply writes a receipt (file, content hash, scope, lesson id) to
  `.cleo/backups/migrations/` before the first write and after each one.
- Each lesson's text ends with a provenance line, so importing the same file
  again is reported as already present.
- The import never deletes or edits a source file.
