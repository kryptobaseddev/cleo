---
id: t9686-b-band-aid
tasks: [T9686-B]
kind: fix
prs: [323]
summary: releaseShow + releaseList read from releases_view SSoT — eliminates dual-table split between releases and release_manifests.
---

Shipped on `main` via PR #323 (merge commit `69e58e332`).

Interim band-aid that points the two read paths (`releaseShow`, `releaseList`)
at the unified `releases_view` UNION so callers see one logical table. Sets
up the harder unification in T9686-B2 (PR #328) which drops the legacy
`release_manifests` table entirely.
