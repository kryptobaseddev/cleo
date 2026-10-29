---
id: env-drift-write-refuses
tasks: [T14147]
kind: test
summary: "a test pins that an evidence write linking a typed gate whose cached pass was made under another environment refuses and persists nothing"
---

`cleo done --plan` can report a typed gate as `cached` (T14138), and the
environment can change before the next write. A new test caches a pass with
`cleo verify --run`, changes `LANG` (a hashed gate input), and writes
evidence that links the gate. The write refuses with E_GATE_NOT_CACHED,
executes nothing, and leaves the task's verification unchanged.
