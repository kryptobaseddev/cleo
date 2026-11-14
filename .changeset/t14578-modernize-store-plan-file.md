---
id: t14578-modernize-store-plan-file
tasks: [T14578]
kind: fix
summary: "cleo docs modernize --plan applies a reviewed store-mode plan; renames are checked against the live store before any write"
---

`cleo docs modernize --plan <file> --apply` refused every saved store-mode
plan: the plan schema allowed only `tree` and `store-only`, although
`cleo docs modernize --store` writes `mode: "store"` plans with `storeRows`.
Renaming one stored doc's slug therefore meant `--store --apply`, which
re-plans and re-slugs the whole store.

The schema now accepts `mode: "store"` with validated `storeRows`. A store
plan read from a file must carry no file rows, and every new slug must obey
the doc naming rule. Before any write, every store apply (from a file or from
`--store`) checks that each renamed doc still carries its old slug, that each
new slug is free, and that no two rows take the same slug. A stale or
colliding plan is refused whole instead of stopping half-way. Rollback with
`--rollback <runId>` is unchanged.
