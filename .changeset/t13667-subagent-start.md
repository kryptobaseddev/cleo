---
id: t13667-subagent-start
tasks: [T13667]
kind: feat
summary: SubagentStart hook gives Claude Code Agent-tool subagents the ct-lean rules at the effective level
---

Session-start context reaches the main thread only, so harness-spawned
subagents ran without the lean rules (CLEO-spawned agents already get them
from the spawn prompt). This mirrors Ponytail 5.1.0's `ponytail-subagent.js`
(MIT).

`cleo hook subagent-start --provider claude-code` emits the level-specific
`## Lean Change` block as `hookSpecificOutput.additionalContext`, and nothing
at level `off`. `CLEO_LEAN_SUBAGENT_MATCHER` scopes it with a
case-insensitive regex over `agent_type`. Every doubt injects, and every
error fails open.

It is installed as a `hooks.SubagentStart` entry in
`.claude/settings.local.json` alongside the heavy-command hook and the Stop
dispatcher, and removed when the heavy-command mode is `off`.
