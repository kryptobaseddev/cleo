---
id: stale-focus-pointer
tasks: [T12660]
kind: fix
summary: "`cleo complete` clears the focus pointer to the completed task, and `cleo current` and the briefing never report a done or cancelled task as current. Handoff suggestions carry their live status"
---

Field report (axiom-analytics). With no active session, `cleo current`
returned T458, which had been done since 2026-09-18. Completion never touched
`focus_state`. The legacy global key was never cleared, and `currentTask`, the
briefing and the handoff's `nextSuggested` all returned recorded pointers
without checking the task's status.

- `cleo complete` clears every focus pointer to the completed task, and to
  any parents auto-completed with it. That covers the bound session's key,
  the env session's key and the legacy global key. Notes and phase are kept.
  The envelope reports `focusCleared` and `nextSuggested`, including in the
  default projected envelope. An idempotent re-run also clears a pointer
  left behind by a timed-out complete.
- `cleo current` and the briefing's `currentTask` check the pointer against
  the task's live status. A done, cancelled, archived or missing task is
  reported as `staleFocus` and never as the current task. A `W_STALE_FOCUS`
  warning names the task, its status and the next ready task.
- `briefing.lastSession.nextSuggestedLive` gives the live status of each
  handoff suggestion and flags done, cancelled and missing ids as stale. A
  warning lists them. The recorded handoff itself stays verbatim.
- `analyze --auto-start`, phase rename, `inject` and the orchestration
  bootstrap read and write focus through the per-session focus store
  instead of the raw `focus_state` key.
