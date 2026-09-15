---
id: gh1440-dryrun-refuses-instead-of-writing
tasks: [T12196]
kind: fix
summary: "release reconcile --dry-run refuses instead of performing the write it promises not to, and the provenance remedy no longer recommends a flag that cannot apply (gh#1440 follow-up)"
---

Two defects found by *running* the diagnostic added in #1442 — both of them
consequences of that change meeting reality, and one of them introduced by it.

## `--dry-run` was accepted and not applied

The dry-run early-return lives **inside** the tag-driven synthesis branch. With
a plan file present, `--dry-run` was accepted and then silently ignored, so
`cleo release reconcile <version> --dry-run` performed the full provenance
write. Measured 2026-09-15 against v2026.9.4: it attempted the INSERT and failed
on the same `UNIQUE constraint failed: tasks_releases.version` as the real run.

A caller asking not to mutate got a mutation. That is worse than the flag not
existing.

It now **refuses** with `E_DRY_RUN_UNSUPPORTED` rather than writing. Refusal is
the honest stop-gap; actually honouring `--dry-run` on the plan-file path
(deriving the row and skipping the transaction) is the better end state and is a
design call on the provenance path, deliberately left open.

Verified against the real repo: the command that previously wrote now refuses,
and `cleo release list` is byte-for-byte unchanged across the run.

## The remedy string recommended the flag that cannot apply

#1442 replaced an empty `fix` with a real one — and that string recommended
`cleo release reconcile <version> --dry-run` unconditionally. But this error can
only fire *after* a write was attempted, which is exactly the path where
`--dry-run` does nothing.

So the fix for "an error whose remedy is the thing that just failed" (gh#1440
item 1) reintroduced that same shape one layer in. The remedy now branches on
which path is live: on the plan-file path it points at `cleo release show` /
`cleo release list`, because a row may already exist from `cleo release plan` —
which is what the `UNIQUE` collision was.

## Not fixed here

The underlying collision is **not** addressed. `plan` writes a row at
`status=planned`; `reconcile` inserts a fresh row for the same version, and its
upsert conflict target is `id` while the uniqueness that collides is `version`,
so the upsert never fires. v2026.9.1 has been stuck at `planned` since
2026-09-13 for the same reason, while v2026.9.3 reached `reconciled` — so a
working path exists and the difference between them is the shape of the correct
fix. That is a conflict-target change on a provenance table plus a possible
`plan`/`reconcile` id-derivation reconciliation, and it stays open on gh#1440.

v2026.9.4's provenance remains unrecorded. Stating that rather than papering
over it: the release is published, installed and verified working, and its
`tasks_releases` row says `planned`.
