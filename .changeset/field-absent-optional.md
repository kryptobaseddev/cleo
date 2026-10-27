---
id: field-absent-optional
tasks: [T14043]
kind: fix
summary: "--field on a declared optional field the record omits prints [] or null and succeeds"
---

`cleo show <id> --full --field /data/task/notes` failed `E_FIELD_NOT_FOUND` on
a task with no notes, while the same pointer worked on tasks that had some.
The `tasks.show` output contract now declares the optional task fields
(notes, labels, files, depends, relates, acceptance, description, size, kind,
verification, completedAt, cancelledAt), and a pointer the contract declares
but the record omits prints its empty value (`[]` for a list, `null`
otherwise) with exit 0. A pointer the contract does not declare still fails
`E_FIELD_NOT_FOUND` with the valid pointers.
