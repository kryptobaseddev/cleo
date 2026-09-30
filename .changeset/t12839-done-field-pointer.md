---
id: t12839-done-field-pointer
tasks: [T12839]
kind: fix
summary: "cleo done --field <pointer> no longer leaks the output pointer into its internal tasks.complete step, which refused completion after every gate was recorded"
---

`--field` is process-global CLI state. `cleo done` dispatches `tasks.complete` as an internal step, and the mutate-projection middleware prevalidates the global pointer against that operation's output contract. A pointer that names a field of the `done` envelope (`--field /data/completed`) is not a `tasks.complete` pointer, so the middleware answered `E_FIELD_NOT_FOUND` before the completion ran: gates were recorded and the task stayed pending. The internal step (single and batch) now runs with the pointer suspended (`withoutOutputPointer`), and `--field` applies only to the final `done` envelope.
