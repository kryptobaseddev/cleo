---
id: global-brain-write
tasks: [T13720]
kind: feat
summary: "cleo memory observe and decision-store take --scope global to write the main brain (global store), and memory find, fetch and the briefing list global entries tagged scope: global"
---

Nothing wrote brain rows into the global `cleo.db`, so the `home:<user>`
stream that syncs them had no content path.

`cleo memory observe --scope global` and `cleo memory decision-store --scope
global` now write the global store's `brain_observations` and
`brain_decisions`, each in one capture frame, so capture records the row and
the sealer seals it onto the home stream. `--linked-task` and `--supersedes`
are project-only and are refused with `--scope global`.

`cleo memory find` and `cleo memory fetch` now also return main-brain entries,
tagged `scope: "global"`, after the project's (find gives them their own
limit). The briefing's current guidance includes accepted global decisions. An
unreadable global store warns and leaves project results intact.
