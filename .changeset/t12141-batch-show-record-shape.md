---
id: t12141-batch-show-record-shape
tasks: [T12141]
kind: fix
summary: Showing several tasks at once returns the tasks, not empty wrappers around them
---

Asking for several tasks in one call returned the right number of elements and none of their content. Each element was the whole single-task answer rather than the task inside it, so nothing in the collection carried an identifier or a title: the table renderer printed a header over blank rows, and the identifier projection refused outright.

That refusal is the only reason this was visible. It declines to emit an empty stream precisely because an empty stream is indistinguishable from a result set with no rows — so a batch that had silently lost every field announced itself instead of looking like a query that matched nothing.

Each element is now the task record itself. The unwrapping is deliberately tolerant of an answer that is already a bare record, so it cannot strip a level that was never added.

Found on the installed build immediately after release, by asking the feature for something a caller would actually want rather than checking that the command exited zero.

Code placed in packages/cleo/ for the thin command surface per Package-Boundary Check — verified against AGENTS.md.
