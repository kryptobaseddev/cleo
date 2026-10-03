---
id: t13124-heavy-hook-delivery
tasks: [T13124]
kind: fix
summary: cleo init and cleo upgrade now actually install the heavy-command hook for every agent harness in use (each provider on its own, every outcome reported), cleo doctor and the briefing say when it is missing, and in Claude Code's default, acceptEdits and dontAsk modes the hook now governs every command your allow rules already approve
---

On 2026-10-03 the heavy-command hook (T12983) was installed in no project at
all, so agents ran vitest, tsc and builds outside the machine-wide budget. That
was the largest cause of the machine saturation (epic T13121).

**Root cause.** `cleo init` and `cleo upgrade` installed the hook only through
`AdapterManager.discover()`. That looks for adapter manifests at
`<project>/packages/adapters/<dir>/manifest.json`, a path that exists in no
project, cleocode included. So the install never ran anywhere, and a
try/catch hid every failure. Hook delivery is now its own step in init and
upgrade (`@cleocode/adapters/heavy-command-hook`, which core loads at run
time).

- **Every provider in use is synced on its own.** A provider counts as in use
  when the project has its config directory, its CLI is on PATH, or its user
  config directory exists. One provider failing never stops another.
- **Nothing is swallowed any more.** A stray `<project>/.codex` *file* used to
  make Codex's `mkdirSync` throw EEXIST and abort the whole install. It is now
  reported as `blocked`, with the exact remedy, and Claude Code and opencode
  still install. A malformed settings file is `failed` and left untouched.
  Kimi, which only reads its global config, is `unsupported`.
- **Codex's `.codex/hooks.json` is treated as a shared project config.**
  CLEO writes it only when it is absent, or holds nothing but CLEO's own
  hook, and git does not track it. A tracked `hooks.json`, or one with team
  hooks, is reported as `blocked` with a remedy and left untouched. Doctor
  flags CLEO's hook left as an uncommitted change in a tracked team file.
- **Every file the hook writes stays out of git.** `.claude/settings.local.json`,
  `.codex/hooks.json` and the opencode plugin get a marked line in the
  repository's `info/exclude`, unless git already ignores or tracks the file.
  An untracked plugin file had widened `cleo verify`'s evidence scope
  (gh#1805). Doctor reports a hook file that git can see as `outdated`, and
  the fix excludes it.
- **Every write and every unmet provider is in the report.** Upgrade lists
  them as `heavy_command_hook` actions, init as created entries or warnings.
  `cleo upgrade --dry-run` previews them.

**Doctor and briefing.**
- `cleo doctor` adds one `heavy_command_hook_<provider>` check per provider in
  use. Each says `installed`, `outdated`, `missing`, `blocked` or `unreadable`,
  with the remedy.
- `cleo doctor heavy-command-hook` gives the full report. `--fix` installs
  the hook. The command exits 1 while a provider in use lacks the hook.
- `cleo briefing` adds one warning line while a provider in use lacks it.
- CLEO still writes project-level configs only, never a user-global one.

**Claude Code default, acceptEdits and dontAsk modes.** Until now the hook only
warned in these modes, so most users had no admission control at all. Claude
Code evaluates permission rules against the input a hook returns, so a bare
rewrite would make an allow rule such as `Bash(pnpm test:*)` stop matching.

Now, when your Bash allow rules already approve the original command, the hook
rewrites it with `permissionDecision: "allow"`. The commands that ran without a
prompt still do, and nothing else does; they now queue for the budget. Claude
Code still applies deny and ask rules to the rewritten command, whatever the
hook answers. The check is never more permissive than Claude Code's matching:

- every subcommand must match a rule, with no ANSI-C `$'…'` quoting
  anywhere, since its escapes would hide the real argument;
- the only rule-free subcommands accepted are a `cd` within the project and a
  narrow form of Claude Code's read-only commands (`cat`, `echo`, `pwd`,
  `head`, `tail`, `grep`, `wc`, `ls`, with no paths, and no glob or brace
  character outside quotes, even in a partly quoted word);
- there is no wrapper or assignment stripping;
- the only redirections accepted are to `/dev/null` or a file descriptor.

The hook makes no such claim when it cannot see every rule that applies:

- managed settings set `allowManagedPermissionRulesOnly`, or a managed source
  cannot be read;
- a macOS configuration profile is present, or the platform is Windows;
- the session runs on the Agent SDK or under a host application;
- Claude Code was started with `--disallowedTools`, `--settings` or
  `--setting-sources`.

Plan mode and commands no allow rule approves keep the warning, and in
`bypassPermissions` and `auto` mode the hook still rewrites everything. A deny
or ask rule that matches `cleo run` itself now also stops a rewrite.
