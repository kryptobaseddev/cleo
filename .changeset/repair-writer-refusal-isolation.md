---
id: repair-writer-refusal-isolation
tasks: [T14566]
kind: fix
summary: "Repair-store: wait for exiting Linux processes before requiring quiescence"
---

An exiting sibling Node process can briefly have unreadable Linux descriptors.
Repair previously threw a plain error at that point, bypassing its bounded
teardown wait and spuriously refusing repair. Unknown inspections now use the
existing 15-second wait and rescan the processes and locks; zombies and vanished
processes are skipped, while persistent unknown inspections still refuse repair.

The writer-lock and foreign-lease tests retain their real lock or persisted lease
and unchanged refusal and original-file hash assertions. Controlled exit and
zombie fixtures cover the production race, and a fake clock verifies that a
dead process with a still-live lease cannot bypass the teardown deadline.
