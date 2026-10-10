---
id: t13489-self-update-new-code
tasks: [T13489]
kind: fix
summary: self-update runs post-update maintenance in the new CLI; upgrade never writes machine paths into tracked files or re-detects project-context.json
---

`cleo self-update` called `runUpgrade` inside its own process. That process had
loaded the previous version's code before `npm install -g` replaced it, so the
fixed maintenance in 2026.10.6 never ran on 10.5 → 10.6. The old code reset the
tracked `.cleo/.gitignore` (dropping `!release-config.json`), `.worktreeinclude`
and `project-context.json`. self-update now spawns the installed CLI
(`cleo self-update --post-update`) for that step.

- In a git checkout, upgrade keeps `@path` references inside the CAAMP block of
  a tracked instruction file. An embedded delivery writes this machine's
  absolute paths into the repository, and an existing embedded block in a
  tracked file is turned back into references. Untracked files still get the
  self-contained delivery, and `injection.delivery` in `.cleo/config.json`
  overrides both.
- Upgrade creates `.cleo/project-context.json` only when it is missing.
  `cleo upgrade --detect` re-detects it, keeping its keys and order.

If you are on 2026.10.5 or older, your first self-update to this release still
runs the old maintenance, because that code is in the binary you run it with.
Update with `cleo self-update --no-auto-upgrade`, then run `cleo upgrade`.
