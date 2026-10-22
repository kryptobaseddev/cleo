---
id: t13891-one-project-snapshot
tasks: [T13891, T13897]
kind: fix
summary: "session-end and pre-op snapshots write one tasks-*.db per run for the unified project cleo.db; brain and conduit are covered by it instead of getting hard links that diverged under per-prefix retention (or full copies where links are unsupported); listBrainBackups and backup verify read the project snapshot, and older brain-*/conduit-* files stay listed; the project cleo.db snapshot is always named tasks-*, whichever prefix the gate admitted"
---
