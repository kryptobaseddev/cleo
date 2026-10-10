---
id: t13409-upgrade-no-global-writes
tasks: [T13409]
kind: fix
summary: self-update and upgrade no longer write user-global instruction files or rewrite the project's own text; upgrade is idempotent and backs up what it changes
---

`cleo self-update` rewrote the owner's `~/.claude/CLAUDE.md` into an inlined
CAAMP block. The writer was caamp `syncGlobalInstructions`, the global
regenerator. Three paths reached it: the npm postinstall that `npm install -g`
runs (`bootstrapGlobalCleo`), `cleo install-global`, and the staleness refresh
at every `cleo session start` and `cleo briefing`. The earlier guards
(#1885 to #1935) covered the adapters and the agent installer, but not this
writer.

- `syncGlobalInstructions` now writes only when a caller passes
  `userRequested: true`. Only `caamp instructions update --global` passes it.
  Any other caller gets `refused` and nothing is written. The bootstrap and the
  session-start refresh now report stale provider files and name that command.
- The postinstall (and so self-update) and `cleo upgrade` no longer link core
  skills into provider skill dirs under HOME, and no longer rewrite an existing
  `~/.agents/AGENTS.md`. `cleo install-global` still does both when you run it.
- In a project, `cleo upgrade` changes AGENTS.md / CLAUDE.md / GEMINI.md only
  inside an existing CAAMP block, and keeps the block's form: `@path`
  references are not inlined unless `.cleo/config.json` sets
  `injection.delivery: "embedded"`. It skips a file without markers and does
  not create missing provider files.
- `.cleo/.gitignore` and `.worktreeinclude` only gain the CLEO-required lines
  they are missing. Your lines are never dropped or reordered, and a bare `*`
  is never appended.
- `project-context.json` keeps every key and its order (`build.outputDir`
  survives). If nothing but `detectedAt` would change, the file is not written.
- Every file upgrade changes is first copied to
  `.cleo/backups/upgrade/<stamp>/`, and listed in the result as `fileChanges`.
- A second `cleo upgrade` applies nothing. `config.json` is no longer
  force-regenerated with defaults. `project-info.json`, global schemas,
  signaldock and the starter bundle report `skipped` when nothing changed.
