---
id: t13257-injectall-home
tasks: [T13257]
kind: fix
summary: cleo init/upgrade, caamp instructions inject/update and CAAMP injectAll no longer write project instruction files in your home directory; Cursor's hooks are skipped there too
---

Providers load AGENTS.md, CLAUDE.md and GEMINI.md from the working directory up through
every parent directory. A project instruction file in `~` therefore applies to every
project under it. After T13227, the remaining writers refuse that case as well:

- `cleo init` and `cleo upgrade` run at `~` skip the injection and say why. Init reports
  it as a warning; upgrade marks the step skipped and gives the reason.
- `caamp instructions inject` and `caamp instructions update`, run in `~` without
  `--global`, exit 1 with `E_HOME_INSTRUCTION_FILE` and a remedy: run inside a project,
  or pass `--global`. Nothing is written.
- CAAMP's `injectAll` throws `HomeInstructionFileError` for project scope at `~`. Core's
  inject operations report it as `E_HOME_INSTRUCTION_FILE`. `isHomeProject` is exported
  for callers that want to check first.
- Cursor's install skips its PreCompact hook files at `~`, because `~/.cursor/hooks.json`
  is Cursor's user-global hooks file.

The `~/.agents` hub and explicit `--global` / `scope: 'global'` writes are unchanged.
