---
id: t12983-heavy-command-hook
tasks: [T12983]
kind: feat
summary: a provider hook that CLEO installs routes agents' heavy shell commands (tests, builds, typechecks, installs) through `cleo run`, so agents share one machine-wide budget without being told to
---

`cleo init` and `cleo upgrade` now install a pre-exec hook for the providers
they detect. It goes in project-level config only, and never in your home
directory's provider configs.

- **Claude Code**: a `PreToolUse` / `Bash` hook in
  `<project>/.claude/settings.local.json`. That file is per machine, which fits
  a per-machine budget. When git does not ignore the file yet, a marked block in
  the repository's `info/exclude` keeps it out of git. The block names that
  project's own path, so each CLEO project in one repository gets its own
  line, and `off` removes only that block. A hook that an earlier build put in the shared `settings.json` is
  removed.
- **Codex**: the same hook in `<project>/.codex/hooks.json`. Codex asks you to
  trust a new project hook in `/hooks` before it runs it. Codex runs hook
  commands through your login shell (`$SHELL -lc`), so the entry hands its
  script to `/bin/sh -c`.
- **opencode**: a plugin at `<project>/.opencode/plugins/cleo-heavy-command.js`.
  It appends the hook's context line to the tool's output.
- **Kimi**: not installed. Kimi reads hooks only from the user-global
  `~/.kimi/config.toml` and cannot rewrite a command.
  `cleo hook heavy-command --provider kimi` denies the call and names the
  governed command to re-run, for an entry you add by hand.

**How a command is rewritten.** The heavy command is wrapped in place, as
`cleo run --wait --passthrough --timeout <s> --class <test|build|full-build> -- <command>`,
and every operator stays with the agent's own shell. For example,
`pnpm test 2>&1 | tail` becomes
`cleo run … -- pnpm test 2>&1 | tail`, and `cd pkg && pnpm test` becomes
`cd pkg && cleo run … -- pnpm test`. So pipelines, `pipefail`, `|&`, `&>`,
globs and `time` keep their meaning in zsh, bash or dash. Deny rules still see
every other stage. `--passthrough` keeps the command's stdio and exit code. It
came to `cleo run` with #1777.

**When it rewrites.** The hook rewrites only in `bypassPermissions` and `auto`
modes, where the user is not approving each command. In `default`,
`acceptEdits`, `plan` and `dontAsk` modes, a rewrite would change which
permission rules match: an allow rule such as `Bash(pnpm test:*)` would stop
matching, and a "don't ask again" on `cleo run` would become a broad allow. In
those modes the hook adds a context line with the governed command instead.

Even in those two modes, the hook first reads the provider's Bash deny
and ask rules: Claude Code's managed, user, project and local
`permissions.deny`/`permissions.ask`, and Codex's `forbidden`/`prompt` rule
files. If one names the heavy command, the hook warns instead of rewriting,
because a rewrite would hide the command from that rule. A bare `Bash` or
`Bash(*)` rule counts as matching every command. A settings file that exists
but cannot be parsed makes the hook warn rather than rewrite. Only the
permission arrays are read, and only the matched word is ever shown.

**What counts as heavy.** The hook uses the same dependency-free recognizer as
`cleo run` (`resources/run-class`).
- Never rewritten: watch, dev, serve and ui modes, `--version`/`--help`, and a
  tool name that is only an argument.
- Never re-wrapped: a command that is already governed (`cleo run …`,
  `~/.cleo-heavy/run.sh …`).
- Reported instead of rewritten: a heavy command in a subshell, inside `$(…)`,
  in the background, inside a compound command, or reading a heredoc. The same
  goes for a pipeline holding two heavy commands, which would start at once.
- At yellow or red machine pressure, a heavy command also gets one context
  line.

**The Bash timeout.** The `timeout` keeps its own budget and the queue wait is
added on top. The wait matches the command's own budget, within 30-300 s and
within the room left under the maximum. The hook honours
`BASH_DEFAULT_TIMEOUT_MS` and `BASH_MAX_TIMEOUT_MS`, and never lowers the
timeout a call already had.

**The hook command is cheap and fails open.**
- When no tool name appears as a whole word, it starts no `cleo` at all. This
  is most shell calls, and costs one `sed`.
- It always exits 0 and prints only JSON.
- With no `cleo` on PATH, it says nothing.
- An older CLEO (no `cleo hook`, so no `cleo run`) is asked once. It is
  recognised by its exit 127 and "Unknown command". The result is cached,
  keyed on that binary and the directory, for at most an hour or until CLEO is
  upgraded. A current CLEO that crashes or is killed fails open and is simply
  asked again next time. The cache marker is created safely and is never
  followed through a symlink.
- Refreshing or removing the hook touches only CLEO's own hook object. A user
  hook in the same matcher group stays.

**Opting out.** Set `CLEO_HEAVY_COMMAND_HOOK=off`, or `warn` to get the context
line only. You can also set `resources.heavyCommandHook` to `off` or `warn` in
the CLEO config. With `off`, the next `cleo upgrade` also removes the installed
hook.
