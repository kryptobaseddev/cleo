---
id: t13693-gate-cache-miss-diagnostic
tasks: [T13693]
kind: fix
summary: a typed-gate cache miss now names what changed since cleo verify --run cached the pass
---

An evidence write reads typed-gate passes that `cleo verify --run` cached. When
the read missed, the refusal said only "no cached pass for the current HEAD,
working tree and inputs", so a moved HEAD, a test that rewrote a tracked file,
a different execution root and an environment that changed between the two
commands all looked the same (axiom T1968 could not tell which).

A stored pass now keeps the parts behind its inputs digest (the environment
hash and each captured file's sha256), outside its MAC and used only to
explain a miss. On a miss the refusal names what differs from the newest stored
pass of the same gate: HEAD (old → new), tracked uncommitted changes, the
execution root, or the inputs, with the environment told apart from each task
file that changed.
