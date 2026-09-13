---
id: task-id-ssot-and-repair
tasks: [T12128]
kind: fix
summary: the task id is validated at the write path, and rows already written with a malformed id can finally be removed (gh#1249)
---

A project path reached the `id` column of `tasks_tasks` — `id='/mnt/projects/cleocode'`,
`title='Task /mnt/projects/cleocode'`, `type=null` — and the row became
**immortal**. `cleo list` enumerates it, while `cleo show`, `cleo update` and
`cleo delete` all reject the id as malformed *before* reaching the store. The
read-side validators that should have prevented the write are exactly what make
the result unfixable: the row can be enumerated forever and addressed never.

Four validators check the id shape on read paths. None ran on the write path.
They also disagree with each other — five different patterns across the repo,
differing on digit bounds and on anchoring. `TASK_ID_REGEX` and `isTaskId` in
`@cleocode/contracts` become the one shape (adopting the `{1,7}` form already
used at eight sites rather than inventing a sixth opinion), and `insertTaskRow`
— the chokepoint every task insert passes through — enforces it.

`cleo doctor malformed-ids` closes the other half: the rows already written.
Read-only by default; `--fix` deletes them and their dependency edges in one
transaction. Deletion rather than re-iding, because a row whose id is not an id
has no identity — nothing can reference it, and inventing one would silently
change what any existing reference means.
