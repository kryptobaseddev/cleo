---
id: briefing-lessons-relevance
tasks: [T14305]
kind: feat
summary: "cleo briefing leads its lessons with the ones naming the focused task or its parent, then this project's, then the main brain's"
---

`cleo briefing` already listed the newest lessons (T13949), so every harness
that runs it (Claude Code, Codex, OpenCode, Kimi) reads the same lessons
without any harness-private memory. With hundreds of main-brain lessons, the
newest eight crowded out the ones that matter for the work at hand.

Briefing now ranks the 50 newest current lessons from `listLessons` (the one
lesson query, unchanged) and keeps eight: a lesson whose rule or why names the
focused task or its parent comes first, then this project's lessons, then the
main brain's, newest first within each. Each keeps its id and a
`cleo memory fetch <id>` pointer. No new store and nothing read from a
harness memory directory.
