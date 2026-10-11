---
id: t13438-session-hygiene
tasks: [T13438]
kind: feat
summary: "`cleo doctor system` reports every agent session with its project, harness, age, terminal idle time and RSS: the owner's close list"
---
The report gains `sessions[]`, one entry per top-level harness session (claude, codex, opencode, kimi), sorted idlest first. Each entry gives the git project of the session's working directory, the harness, its age, the time since its terminal last saw input or output (what `w` reports) and the RSS of its whole tree, MCP servers included.

The data comes from one `lsof` on macOS or `/proc/<pid>/cwd` on Linux, one `stat` per tty and per directory, and two `ps` CPU-time samples taken 2 s apart.

A session is reported **quiet**, never "idle", and only when every signal is quiet (T13460):
- its terminal has been silent for at least an hour (or it has no tty);
- its process tree used no CPU across the sample;
- nothing runs under it besides MCP servers and their launch wrappers;
- nothing in its directory or git dir was written in the last hour.

Terminal silence alone never decides it. The owner found three sessions reported "idle" on silence alone that were in fact working, coordinating, or waiting on a plan.

The `sessions` finding groups the sessions per project, lists each quiet session with its signals, and tells the agent to ask the owner whether each quiet session is still needed. Quiet is not dead, and nothing is closed automatically. Harness helpers (`codex app-server` and `exec-server`, `claude --chrome-native-host`) no longer count as sessions.

Guidance for running 5 or 6 projects with 2 to 6 agents each within a RAM budget is in doc `multi-project-ram-budget`.
