---
id: t11977-tag-driven-reconcile-synthesis
tasks: [T11977]
kind: fix
summary: "DHQ-080: `cleo release reconcile` now synthesises a minimal plan on the tag-driven path (no prior `cleo release plan`)"
---

Closes DHQ-080 (T11977): `cleo release reconcile <version>` previously failed
with `E_PLAN_NOT_FOUND` when published via the pure tag-push path (git tag +
push → GHA publishes to npm, no `cleo release plan` ever run), leaving the
`releases` and `release_changes` provenance tables empty for that version.

**Fix — minimal plan synthesis at reconcile time:**

When `reconcile` finds no `.cleo/release/<version>.plan.json` on disk but the
git tag is present, it now synthesises a minimal `ReleasePlan` in-memory
before proceeding with the standard provenance backfill. The synthesis derives
the release-set from three sources in priority order:

1. `CHANGELOG.md` section for the version (`## [<VERSION>]`, ADR-028 §2.5) —
   task-ID tokens + summary lines extracted from the section body.
2. Merge-commit subjects (`Merge pull request #NNN`) in the `prevTag..tag` git
   log — discovered PR numbers for best-effort title/task-ID resolution.
3. All commit subjects + bodies in the `prevTag..tag` range — T#### token
   extraction as a fallback when CHANGELOG data is sparse.

The previous git tag is inferred automatically via `git tag --sort=creatordate`.

**Provenance flag — distinguishable from honest plans:**

The synthesised plan carries `meta.origin = 'tag-reconcile-synthesized'` and
`plan.createdBy = 'tag-reconcile-synthesized'` so queries against the
`releases` table can distinguish synthesised rows from plans that went through
`cleo release plan` → `cleo release open` → `cleo release reconcile`.

**New `--dry-run` flag:**

`cleo release reconcile <version> --dry-run` prints the synthesised plan
derivation (prevTag, changelogTaskIds, commitTaskIds, discoveredPrNumbers,
planTaskCount) WITHOUT writing to the DB. Safe to run against the live project.
The result envelope carries `dryRun: true` and a `synthesized` sub-object.

**Acceptance proof for v2026.6.14 (live npm, no prior plan):**

```
prevTag               : v2026.6.13
changelogSectionFound : true
changelogTaskIds      : 21 IDs (T11556, T11785, T11786, T11947, T11951, T11962, …)
commitTaskIds         : 107 IDs
discoveredPrNumbers   : 43 PRs (#1049–#1064)
planTaskCount         : 107 tasks in synthesised plan
plan.createdBy        : tag-reconcile-synthesized
plan.meta.origin      : tag-reconcile-synthesized
```

**Behaviour when a plan file already exists:** unchanged — synthesis is
completely skipped and the original reconcile flow runs as before. No drift.

**Behaviour when neither tag nor plan exists:** unchanged — `E_PLAN_NOT_FOUND`
is returned as before.
