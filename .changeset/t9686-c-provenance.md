---
id: t9686-c-provenance
tasks: [T9686-C]
kind: fix
prs: [325]
summary: "Provenance backfill — tag enumeration, --since empty handling, foreign-key insertion order."
---

Shipped on `main` via PR #325 (merge commit `659ef62c2`).

Three correctness fixes inside `cleo provenance backfill`:

- Tag enumeration now walks the full `refs/tags/v*` namespace instead of
  stopping at the first non-matching entry.
- `--since` accepting an empty string no longer treats it as the epoch — it
  now resolves to the latest reconciled tag.
- Insertion order respects foreign-key dependencies — parent rows are
  written before children so the SQLite FK enforcer doesn't reject the
  transaction.
