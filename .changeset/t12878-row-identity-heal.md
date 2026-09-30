---
id: t12878-row-identity-heal
tasks: [T12878]
kind: fix
summary: Every project open restores the row-identity tables and columns a stamped uid migration left out, with row uids on or off; no row value changes
---

On a store that a pre-release build had opened, 9.25 recorded the row-uid
migration (`20260928120000_t12341-row-uids`) as applied from the columns it
found, and never ran the migration's CREATE statements. This happened on
live cleocode. The store was left without `tasks_uid_aliases`,
`tasks_ac_uid_graveyard` and its trigger, `tasks_row_identity_meta` and
`tasks_identity_quarantine`, and its display-id alias table lacked
`displaced_hlc` and `entity_birth_fp`. The repair only ran with row uids
turned on (`CLEO_ROW_UID_FILL=1`), which is off by default.

Every project open now restores that schema, whatever the flag. It is DDL
only: the identity tables, the graveyard trigger, the missing columns, and
the uid columns and indexes. No row value is read or written. Filling
values, the refill of stale values and the per-connection triggers stay
opt-in.
