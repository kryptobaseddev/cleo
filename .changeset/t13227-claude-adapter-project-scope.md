---
id: t13227-claude-adapter-project-scope
tasks: [T13227]
kind: fix
summary: the Claude Code adapter writes its hooks, plugin enable and hook scripts to the project's .claude/ only and can no longer write the user-global ~/.claude/settings.json
---

The Claude Code adapter used to write the user-global `~/.claude/settings.json` (or
`$CLAUDE_HOME` / `$CLAUDE_SETTINGS`) from three places:

- `ClaudeCodeAdapter.initialize` added `Stop` (`cleo session end`) and `PostToolUse`
  (`cleo observe` / `cleo nexus analyze`) hooks.
- The install provider enabled the `cleo@cleocode` plugin and added a `PreCompact`
  hook.
- The install provider copied `precompact-safestop.sh` and `cleo-precompact-core.sh`
  into `~/.claude/hooks/`.

All of these now go to the project instead, with the same purpose:

- the hooks and the plugin enable go to `<project>/.claude/settings.local.json`;
- the scripts go to `<project>/.claude/hooks/`;
- each file that git does not already ignore is kept out of git with a marked
  `info/exclude` block. This is the rule the heavy-command hook already follows.

A single guard refuses any target that is the user-global settings file, lies inside
the user-global Claude directory, or belongs to a project that is the home directory.
That covers the `.claude/commands` copy too. A refused step is reported as `skipped`,
and nothing is written. `dispose` now removes only the adapter's own hook objects, so
the heavy-command hook and your own hooks in the same file stay. Entries an older CLEO
already left in the user-global settings are untouched; `cleo doctor` reports them
(T13221).
