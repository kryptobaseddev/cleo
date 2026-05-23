---
"@cleocode/core": patch
---

feat(T10116): saga auto-close integrated into completeTask

Mirrors the epic auto-close pattern at complete.ts:498-539 but resolves members via
task_relations.type='groups'. When the last group member transitions to done, the
saga's status auto-flips to done with synthesized evidence. Root-cause fix for T10090.
Saga: T10113. Epic: T10210.
