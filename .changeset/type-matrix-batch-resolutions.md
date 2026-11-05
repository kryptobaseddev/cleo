---
id: type-matrix-batch-resolutions
tasks: [T14235]
kind: fix
summary: "cleo doctor type-matrix validates a resolutions file as one batch, so a parent re-type and its child re-type land together (T14235)"
---

`cleo doctor type-matrix --resolutions` checked each task's resolution on its
own, so a fix that needs two rows to change together was refused in either
order: re-typing an epic that is really a task to a task leaves its task child
under a task, and re-typing that child to a subtask first leaves a subtask
under an epic.

The resolutions are now applied as one batch and judged once, in their final
state. A batch that still leaves a row misplaced is refused before anything is
written, and the refusal names every such row. The apply writes the shallowest
rows first, so the type-matrix trigger checks a re-typed child against its
parent's new type.
