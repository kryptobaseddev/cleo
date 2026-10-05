---
id: t13221-doctor-claude-global-leftovers
tasks: [T13221]
kind: fix
summary: cleo doctor reports what an old CLEO left in the user-global Claude settings, with the manual removal steps; it never edits that file
---

Releases whose Claude Code adapter install ran (it was removed in T13128) could enable
the `cleo@cleocode` plugin and add a `PreCompact` hook (`precompact-safestop.sh`, tagged
`# cleo-hook`) in the user-global `~/.claude/settings.json` (or `$CLAUDE_HOME`), and copy
hook scripts into its `hooks/` directory. CLEO never writes the user-global Claude
settings, and removing an entry is writing, so the new `user_global_claude_leftovers`
check in `cleo doctor` is report-only: it lists each leftover and spells out how to
remove it by hand (back the file up first), and never edits or deletes anything there.
Hooks and plugins you added yourself are not reported. A malformed settings file is
reported as not checked and left alone.
