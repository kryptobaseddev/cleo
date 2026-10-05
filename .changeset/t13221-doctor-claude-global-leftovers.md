---
id: t13221-doctor-claude-global-leftovers
tasks: [T13221]
kind: fix
summary: cleo doctor reports what an old CLEO left in the user-global Claude settings, with the manual removal steps; it never edits that file
---

Releases whose Claude Code adapter install ran (it was removed in T13128) could enable
the `cleo@cleocode` plugin and add hooks tagged `# cleo-hook` (`Stop` → `cleo session end`,
`PostToolUse` → `cleo observe` / `cleo nexus analyze`, `PreCompact` → `precompact-safestop.sh`)
in the user-global `~/.claude/settings.json` (or `$CLAUDE_HOME`), and copy
hook scripts into its `hooks/` directory. CLEO never writes the user-global Claude
settings, and removing an entry is writing, so the new `user_global_claude_leftovers`
check in `cleo doctor` is report-only: it lists each leftover and spells out how to
remove it by hand (back the file up first): one hook object at a time, never a whole
entry that also holds your own hooks. It never edits or deletes anything there. Hooks and
plugins you added yourself are not reported. A settings file that is not valid JSON is a
warning asking you to repair it and re-run `cleo doctor`; it is left alone.
