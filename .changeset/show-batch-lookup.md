---
id: show-batch-lookup
tasks: [T12141]
kind: feat
summary: cleo show accepts several ids and pays CLI startup once instead of per task (gh#1207)
---

CLI startup is a fixed ~1.31s floor, measured and dominated by module loading
rather than by the query. So the reporter's 25-task status sweep spent roughly
33 seconds of its 2.5 minutes simply starting Node 25 times — a cost no amount
of query optimisation can touch.

`cleo show T1 T2 T3` now returns all three in one envelope from one process.
The floor is paid once.

A SINGLE id produces the exact prior envelope, byte for byte. Batching must not
change the shape every existing script and agent already parses, so the
single-id path is untouched and pinned by a test.

A failed id does not discard the rest — that would make the batch strictly
worse than the loop it replaces. Failures are collected in `notFound` alongside
the successes, and the command exits non-zero so a script cannot read a partial
batch as a complete one.

Ids are de-duplicated order-preserving, and flag-shaped or empty positionals
are ignored.

This is the second of the two levers named in the issue; the first removed the
barrel import that made the floor 1.31s in the first place. The remaining
~0.17s is still unexplained.
