---
id: t14492-orca-reserved-retry-key
tasks: [T14492]
kind: fix
summary: "Orca retry: recover crashes before launch with a durable request key"
---

Reserve the same keyed request before committing the retry successor and replay it with its original Run, Task and predecessor; preserve legacy uncertainty, claims and checkout custody.
