---
id: doc-identical-heads
tasks: [T14288]
kind: fix
summary: "Updating a doc to bytes another doc already holds no longer takes that doc's slug; both docs stay fetchable under their own slugs"
---

Stored content is shared between docs that hold identical bytes. A
`cleo docs update` that wrote bytes another doc already held moved the updated
doc's slug onto that doc's stored row, so the other doc lost its slug and its
metadata. The updated doc now keeps its own row and points its latest version
at the shared content, and the other doc is left as it was.
