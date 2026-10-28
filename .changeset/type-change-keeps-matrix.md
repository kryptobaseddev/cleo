---
id: type-change-keeps-matrix
tasks: [T12883]
kind: fix
summary: "A task's type change keeps the parent/child type matrix for its parent and its children (T12883 R4)"
---

`cleo update --type` checked only that the new type is a valid type; the DB
trigger checks the row against its own parent, never against its children. An
epic re-typed to a task orphaned its tasks under a parent that cannot contain
them. A type change is now refused (`E_INVALID_PARENT_TYPE`) when the task's
parent cannot contain the new type (unless the same update re-parents it) or
when any child cannot sit under the new type.
