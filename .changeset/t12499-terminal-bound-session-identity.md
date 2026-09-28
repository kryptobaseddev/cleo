---
id: t12499-terminal-bound-session-identity
tasks: [T12499]
kind: fix
summary: bind sessions to the terminal or agent harness that started them, resolved before the newest-active fallback
---

`cleo session start` (and `session resume`) now record which terminal started the
session, in a new project table `session_terminal_bindings`. The terminal is
identified from a key map held as data (`TERMINAL_KEY_SOURCES`):
`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, `GEMINI_SESSION_ID`, tmux / zellij /
WezTerm panes, Windows Terminal, iTerm2, macOS Terminal, kitty, GNOME Terminal and
Konsole. When none of these is set, the nearest non-launcher parent process is
used instead. Session resolution checks, in order: connection handle, env session
id (only if its row exists), terminal binding, newest active row. Two terminals
that each start a session now resolve their own sessions. `session end` removes
the binding. The CLI's `lookupCliSession` no longer accepts a `CLEO_SESSION_ID`
that has no session row.
