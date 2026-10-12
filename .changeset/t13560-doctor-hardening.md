---
id: t13560-doctor-hardening
tasks: [T13560, T13561, T13562]
kind: fix
summary: cleo docs doctor apply envelope reports post-repair state, provenance backfill chains a wikilinks rebuild, and dangling detection excludes archived rows plus re-points blob rows with live content
---

`cleo docs doctor --apply` echoed the PRE-repair diagnostics snapshot in its
envelope — after archiving 47 dangling rows the report still said 295, and
after fixing 92 doc-version-skew rows it still said 92. The apply run now
re-scans the store after the repairs, so the envelope's diagnostics and
summary describe POST-repair state and agree with a follow-up dry run
(T13560). Dry-run behavior is unchanged.

The `empty-provenance` backfill wrote `topics`/`related_tasks` columns but
never the corresponding `docs_wikilinks` rows, so the `wikilinks-drift`
diagnostic jumped from 0 to thousands on the next dry-run (3 797 on
axiom-app, 50 821 on cleocode). The rebuild decision was driven by the
pre-repair drift, which is zero when the columns are empty — exactly the
state a backfill changes. The planner now chains a `rebuild-wikilinks`
repair whenever an applied backfill changes the derived edge set, so the
rebuild runs inside the same apply pass and the re-run drift is 0 (T13561).

The dangling-pointers diagnostic counted rows already
`lifecycle_status = 'archived'`, so the post-apply count never dropped.
Archived rows are now excluded (T13562a). And blob-kind payloads carrying a
stale legacy `path` (e.g. Linux paths recorded on another machine) whose
content still resolves in the content-addressed blob store got no repair at
all — only 47 of 295 dangling rows were archivable on axiom-app. Such rows
now get a `clear-stale-path` repair that re-points the metadata at the blob
store by dropping the stale `path` field, chosen only after a read-only
probe confirms the bytes exist (primary file or a live keep-link); the doc
stays live instead of being archived (T13562b).
