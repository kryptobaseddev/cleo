---
id: t13128-remove-dead-adapter-install
tasks: [T13128]
kind: fix
summary: The provider-adapter install step that never ran is removed from cleo init, cleo upgrade and the global bootstrap; CLEO never writes the user-global Claude settings
---

`cleo init`, `cleo upgrade` and the global bootstrap each had an "adapter discovery,
activation and install" step. Its discovery read `<root>/packages/adapters/<dir>/manifest.json`,
but the manifests ship at `packages/adapters/src/providers/<provider>/manifest.json` inside
CLEO, so discovery found nothing in any project, any installed package or the CLEO repo
itself (measured: 0 everywhere), and the step never ran. Repaired as written, it would
have run the Claude Code install provider on every upgrade, which enables a plugin and
adds a hook in the user-global `~/.claude/settings.json`, against the rule that CLEO
installs into project-level configs only.

The step is removed rather than repaired. Provider hooks are delivered per project by the
step T13124 added to `cleo init` and `cleo upgrade`, which reports every outcome
(installed, updated, skipped with a reason, failed). A test pins that `cleo init` with
Claude Code detected leaves the user-global settings untouched.
