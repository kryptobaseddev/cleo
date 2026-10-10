---
id: t13438-session-hygiene
tasks: [T13438]
kind: feat
summary: "`cleo doctor system` reports every agent session with its project, harness, age, terminal idle time and RSS: the owner's close list"
---
The report gains `sessions[]`, one entry per top-level harness session (claude, codex, opencode, kimi), sorted idlest first. Each entry gives the git project of the session's working directory, the harness, its age, the time since its terminal last saw input or output (what `w` reports) and the RSS of its whole tree, MCP servers included.

The data comes from one `lsof` on macOS or `/proc/<pid>/cwd` on Linux, plus one `stat` per tty. A session is idle when its terminal has been silent for at least an hour. Without a tty, a session counts as idle when its CPU is near zero.

The `sessions` finding groups the sessions per project and tells the agent to offer the idle ones to the owner as a close list through the ask tool. Nothing is closed automatically. Harness helpers (`codex app-server` and `exec-server`, `claude --chrome-native-host`) no longer count as sessions.

Guidance for running 5 or 6 projects with 2 to 6 agents each within a RAM budget is in doc `multi-project-ram-budget`.
