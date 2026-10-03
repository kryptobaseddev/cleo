---
id: t13135-evidence-scope-excludes
tasks: [T13135]
kind: fix
summary: Evidence scoping ignores CLEO's own hook files and project-declared runtime state, so they no longer force a full suite
---

Evidence scoping (the affected `tool:test` scope and the `test-run:` binding) treated every changed path
outside a workspace package as workspace-wide, which forces a full-suite run. In an opencode project
(gh#1805, CLEO 2026.10.3) that included runtime state under `.opencode/goals/` and the untracked
`.opencode/plugins/cleo-heavy-command.js`, the heavy-command hook plugin, which the task never touched: every
evidence recording was pushed to a whole-suite `tool:test`, the machine-saturation path.

- CLEO's own installed hook files (`.claude/settings.local.json`, `.codex/hooks.json`,
  `.opencode/plugins/cleo-heavy-command.js`) never count as part of a change, tracked or untracked. (The
  installer keeps them out of git with `info/exclude`, T13124.)
- A project can declare `evidence.scopeExcludes` in `.cleo/project-context.json`: repo-relative paths or
  globs (`**` crosses directories), e.g. `[".opencode/goals/**"]`, that evidence scoping ignores.
