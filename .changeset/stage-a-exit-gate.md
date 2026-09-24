---
id: stage-a-exit-gate
tasks: [T12328]
kind: test
summary: "Stage A exit gate: `scripts/stage-a-exit-gate.mjs` checks a backup by restoring it into a clean root at a new path and comparing counts, hashes, projectId and reconciled legacy data"
---

A backup only counts as lossless once a restore of it has been checked. This
gate checks one for each store it is given:

1. **Export.** It runs `cleo backup export --scope project` with the store's
   root as the working directory. The on-open legacy migration is switched
   off, and `CLEO_HOME`/`CLEO_CONFIG_HOME` point at temp dirs, so the real
   store is only read and no global state is written.
2. **Import.** It restores into a clean root at a different path, with a temp
   `HOME`, `CLEO_HOME` and `CLEO_CONFIG_HOME`. It requires `data.lossless`,
   which means every table re-counts to the manifest and every entry not
   rewritten by relocation is byte-identical.
3. **projectId.** It checks that the restored `project-info.json` has the same
   `projectId` as the source.
4. **Legacy data.** For stores whose data lives only in legacy files, it runs
   `cleo doctor superseded-store --reconcile` on the restored copy. It then
   requires `tasks_tasks` and `brain_observations` to equal the restored legacy
   counts (`tasks.db` `tasks` and `brain.db` `brain_observations`).
5. **`cleo list`.** It records whether `cleo list` works on the restored copy.
   This is informational only: claude-todo's list defect is tracked separately
   in T12346.

The gate prints one JSON summary and exits non-zero on any failure:

```bash
node scripts/stage-a-exit-gate.mjs                    # the four Stage A stores
node scripts/stage-a-exit-gate.mjs --store name=/abs/root --reconcile name --keep
```

`scripts/__tests__/stage-a-exit-gate.test.mjs` runs the real gate against a
fixture whose data exists only in legacy stores. The fixture's empty
`cleo.db` is created by the CLI itself. The same file also unit-tests the
gate's pass/fail decisions.
