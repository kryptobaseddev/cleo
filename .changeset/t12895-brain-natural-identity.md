---
id: t12895-brain-natural-identity
tasks: [T12895]
kind: feat
summary: "Brain natural-key tables get row uids derived from their keys in both stores"
---

The brain tables keyed by a natural composite key now carry a row uid: page edges
and memory links (project and global), sticky tags (global; the project table
waits on the twin collapse) and brain release links (project). The uid is a
UUIDv8 over the primary key, so every device derives the same uid for the same
edge or link whenever it was filled. A memory link follows its task's uid in the
project store, and a sticky tag follows its note's uid. Page edges key on their
raw node ids, because most edges point at code symbols or tasks with no
page-node row. The migration `20261010130000_t12895-brain-natural-uids` adds the
columns and unique indexes. On a 1.3 GB cleocode store copy, re-filling all
168,180 page edges took about 1.7 s.
