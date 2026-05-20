---
id: t9686-b2-unification
tasks: [T9686-B2]
kind: breaking
prs: [328]
summary: Unify releases tables — drop release_manifests + releases_view, hard-rename to canonical "releases".
breaking: |
  `release_manifests` is dropped and `releases_view` is removed. Readers that
  previously queried either name must switch to the canonical `releases`
  table. The migration handles the data move in-place; consumers that touch
  the SQLite schema directly (e.g. raw queries outside the DataAccessor) need
  to update their statements.
---

Shipped on `main` via PR #328.

Follows up the T9686-B band-aid by performing the structural unification:

- The legacy `release_manifests` table is dropped.
- The `releases_view` UNION that papered over the split is removed.
- Rows are migrated into the canonical `releases` table.
- Three parity test assertions ("legacy release_manifests untouched") are
  inverted to assert the new invariant — that legacy reads no longer succeed.

After this lands, `releases` is the single source of truth and the dual-table
era ends.
