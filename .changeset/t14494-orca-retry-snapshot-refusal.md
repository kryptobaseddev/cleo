---
id: t14494-orca-retry-snapshot-refusal
tasks: [T14494]
kind: fix
summary: "Orca retry: a cross-process reservation loser gets the documented refusal"
---

When two processes retry the same Orca Dispatch, the one whose reservation read went stale before its write is now refused with "Orca retry reservation lost; no new launch is authorized." instead of a raw SQLite `database is locked` error. Exactly one retry still launches. A two-process test proves this by parking both processes at the reservation write.
