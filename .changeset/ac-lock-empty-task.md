---
id: ac-lock-empty-task
tasks: [T12153]
kind: fix
summary: a task with no acceptance criteria is no longer locked against gaining its first (gh#1235)
---

`enforceAcceptanceImmutability` had four early-returns and no case for "the
existing acceptance list is empty". A task that reached a locked pipeline stage
with no criteria was therefore locked against ever gaining any, and the error
told the operator that "reframing AC after implementation is anti-pattern"
about criteria that did not exist.

The guard exists to stop criteria being REFRAMED once you know what you built.
A task with no criteria has no goalposts to move — supplying them for the first
time is what the acceptance model wants, not what it protects against. Without
the empty case the guard inverted its own purpose.

The only escape was `--reason`, which writes an audit record asserting a
deliberate override of a protection that was never protecting anything. Audit
entries that mean nothing are how an audit trail stops being read.

A fifth early-return covers `undefined`, `null`, `[]` and whitespace-only
strings. A structured `AcceptanceGate` is never treated as blank, so a task
whose criteria are all gates keeps the guard.
