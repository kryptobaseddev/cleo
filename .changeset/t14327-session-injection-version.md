---
id: t14327-session-injection-version
tasks: [T14327]
kind: feat
summary: "a session records the CLEO-INJECTION version its briefing delivered, shown in cleo session status"
---

`cleo briefing` now records, on the bound session, the `Version:` of the
installed global `CLEO-INJECTION.md` template (new column
`tasks_sessions.injection_version`, migration
`t14327-session-injection-version`). `cleo session status` shows it as
`session.injectionVersion`, so a session that read an older protocol copy is
visible per session; a session that never ran the briefing shows none. The
write is best-effort, happens only when the value changes, and a whole-session
upsert never touches the column.
