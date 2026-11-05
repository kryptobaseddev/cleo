---
id: memory-dream-refuses-by-default
tasks: [T14237]
kind: fix
summary: "bare cleo memory dream refuses and writes nothing; --apply runs the destructive cycle, and the help names what it deletes"
---

`cleo memory dream` ran the full consolidation cycle on the live BRAIN store,
which deduplicates and evicts rows (some hard-deleted, their deletions
synced) and rewrites scores, tiers and edges, while its help said
"Idempotent — safe to run multiple times". A bare run now refuses with
`E_VALIDATION`, exits 1 and writes nothing; `--apply` runs the cycle and
`--status` stays a read-only liveness check. The help names the destructive
effects and the flag, and the remediation hints point at `--apply`.
