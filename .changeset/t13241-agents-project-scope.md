---
id: t13241-agents-project-scope
tasks: [T13241]
kind: fix
summary: the core agent installer links a project's agents into the project's .claude/agents and can no longer write the user-global ~/.claude/agents
---

`installAgent`, `installAllAgents` and `uninstallAgent`, exported from the core skills
API, used to symlink agents into the user-global `~/.claude/agents` (or
`$CLAUDE_HOME/agents`). They now use the project's `.claude/agents`. Each takes an
optional `cwd` naming a directory in the project.

A target that would be user-global is refused, and nothing is written or removed. That
covers a project that is the home directory, and a `.claude/` that resolves into the
Claude config directory, including a differently cased spelling on a case-insensitive
volume. Install reports the reason as its `error`; uninstall returns `false`.
`projectAgentInstallDir` reports where agents would go, or why that location is refused.
