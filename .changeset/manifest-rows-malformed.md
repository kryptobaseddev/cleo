---
id: manifest-rows-malformed
tasks: [T12686]
kind: fix
summary: "orchestrate roll-up skips a manifest row whose metadata breaks the stored field contract (warning W_MANIFEST_ROW_MALFORMED names it and the repair) instead of failing; new cleo doctor manifest-rows lists such rows, plans a repair (--repair), applies it with a receipt (--apply) and rolls it back"
---
- **Roll-up no longer fails on one bad row.** Before, a single stored
  manifest row with a malformed field (on this repo, `T1171-w2a-10-audit`,
  whose `actionable` is stored as an array) made `cleo orchestrate roll-up`
  fail with an uncaught error. Roll-up now reads with
  `readManifestEntriesSkippingMalformed`: it skips that row and reports every
  other worker. A `W_MANIFEST_ROW_MALFORMED` warning names the row, the bad
  field and the repair command. The strict reader is unchanged everywhere
  else.
- **New `cleo doctor manifest-rows`.** By default it lists malformed rows,
  archived ones included, and exits 1 while any remain.
  - `--repair` shows the plan and writes nothing. `--repair --apply` (or
    `--apply`) rewrites each malformed row so it reads again, without losing
    anything: the bad field moves under `_malformed.<field>`, and metadata
    that is not valid JSON is kept whole as `_malformed_raw`. It writes a
    receipt to `.cleo/backups/manifest-repair/` before changing any row. Each
    row update only applies if the stored metadata still matches what was
    read, and all updates run in one transaction. A row changed since the
    read is skipped and reported, not listed as changed; a row stored in both
    tables whose two copies no longer both match aborts the whole repair.
    `--dry-run` is kept as an alias for the plan and overrides `--apply`, as
    in `cleo doctor projects`.
  - `--rollback <receipt>` restores the old bytes of every row that has not
    changed since the repair.
