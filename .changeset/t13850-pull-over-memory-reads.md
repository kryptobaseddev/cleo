---
id: t13850-pull-over-memory-reads
tasks: [T13850]
kind: fix
summary: "cloud pull no longer refuses a store whose only changes since its last sync are what memory reads wrote (retrieval log, citation counters)"
---

`cleo memory fetch` and `memory find` record a `brain_retrieval_log` row and
bump `citation_count`/`updated_at` on the entries they return. The vault's
local-changes check counted those as edits, so any device that had read
memory refused the next `cloud pull` with `E_NEXUS_VAULT_LOCAL_CHANGES` and
needed `--force`.

Each snapshot manifest now carries a `zz_vault_authored` annotation (0 rows,
like the format record): one keyed hash over every `cleo.db` table with the
retrieval log left out and those read-side columns nulled. When a store's
digest equals the one of the snapshot it last synced, its table changes are
read telemetry and the pull takes the newer snapshot. Any other change still
refuses. Reads keep logging, and a push still carries the telemetry.

A snapshot pushed by an older CLEO has no digest, so the first pull over it
behaves as before; older CLEO builds see the annotation as an empty table and
ignore it.
