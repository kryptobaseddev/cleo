---
id: machine-output-no-prose
tasks: [T12170]
kind: fix
summary: Machine-readable output modes emit an empty stream for zero results, not an English sentence
---

**gh#1317.** `cleo list --output id` printed the sentence **`No ids.`** on
**stdout** when nothing matched. `--output id` is contracted to emit one task ID
per line, so the pipeline CLEO's own protocol documents —

```
cleo list --parent EPIC --output id | while read c; do … ; done
```

— ran its body twice against a childless parent, with `c` set to `No` and then
`ids.`: two task IDs that do not exist.

The asymmetry that made it obvious is that `--output count` already answered `0`
for the same query, correctly and machine-readably.

**The issue named `--output id`; the same defect was in three more places.**
`--output table` returned `No rows.` into a TSV stream, `--summary` did the same,
and a null payload returned the literal `(empty)`. Prose in a TSV stream is
exactly as wrong as prose in an ID stream.

An empty result is now an **empty stream**, and the reason is not discarded — it
goes to **stderr**, where an interactive caller still sees it and a pipeline does
not consume it. That is the split ADR-086 already requires of every log line.

Measured against a compiled CLI, the issue's own reproduction:

```
before:  stdout = "No ids.\n"      loop ran 2 times (c='No', c='ids.')
after:   stdout = 0 bytes           loop ran 0 times
         stderr = "No output (no-renderable-ids)."
         exit   = 100  (unchanged)
```

and a parent **with** children still streams its IDs unchanged.

Three existing tests asserted the prose — they were **pinning the defect**, so a
fix read as a regression. Rewritten to assert the contract (empty text, typed
`emptyReason`) rather than the sentence. 34/34 in that file, 230/230 across the
renderer suite.
