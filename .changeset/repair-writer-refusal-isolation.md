---
id: repair-writer-refusal-isolation
tasks: [T14566]
kind: fix
summary: "Repair-store tests: isolate writer-lock and lease refusals from unrelated runner processes"
---

The writer-lock and foreign-lease tests now use the existing controlled Linux
process fixture instead of scanning unrelated runner processes, whose private
descriptors could cause an earlier refusal. The synthetic lease owner also has
a fixed command identity so host PID reuse or teardown polling cannot affect the
assertion. Both tests retain their real lock or persisted lease and unchanged
refusal and original-file hash assertions; production safety checks are unchanged.
