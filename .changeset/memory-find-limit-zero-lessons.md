---
id: memory-find-limit-zero-lessons
tasks: [T14320, T14321]
kind: fix
summary: "memory find --limit 0 returns every match, and lessons are findable through memory find (--type lesson)"
---

`cleo memory find <q> --limit 0` returned nothing, although `--limit 0`
means every match everywhere else. It now returns every match, up to a
ceiling of 1000 hits; the pattern and learning finds read it the same way.

Lessons are observations whose rule and why rarely contain the word
"lesson", so `memory find lesson` found none and only `memory lessons` listed
them. A query naming the lesson type now lists the lessons it matches,
filtered by its other words over the rule and the why, and `--type lesson`
returns lessons only, from both brains.
