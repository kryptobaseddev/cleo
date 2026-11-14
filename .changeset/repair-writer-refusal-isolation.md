---
id: repair-writer-refusal-isolation
tasks: [T14566, T14571]
kind: fix
summary: "Repair-store: wait for exiting Linux processes and scope macOS mount warnings"
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

On macOS, repair now queries lsof directly for the target files, retaining its
exit status instead of relying on the fuser wrapper. A complete mount warning
is accepted only when its mount-table device differs from every target file
device, and the warning is retained in diagnostics. Warnings for the target
filesystem, unclassified output, and failed probes remain unknown within the
same bounded wait and refuse repair at the deadline. An unreachable Time Machine
SMB mount no longer prevents repair of a local store on another device.

The persistent-holder deadline test advances its clock only after the real holder
is identified, preserving the handle probe budget on macOS.
