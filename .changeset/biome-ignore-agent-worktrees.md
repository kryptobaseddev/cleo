---
id: biome-ignore-agent-worktrees
tasks: [T12386]
kind: fix
summary: biome check no longer fails while Claude Code agent worktrees exist under .claude/worktrees
---

Claude Code agent worktrees live at `<repo>/.claude/worktrees/<id>` and each
carries its own `biome.json`. `biome check .` at the repo root then failed with
"Found a nested root configuration", which failed every `tool:lint` evidence
gate while an agent was working. `biome.json` now excludes `**/.claude`, which
holds no source that biome covers; the checked file count is unchanged.
