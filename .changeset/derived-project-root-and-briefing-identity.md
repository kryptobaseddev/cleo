---
id: derived-project-root-and-briefing-identity
tasks: [T12557, T12559]
kind: fix
summary: "Moving a project no longer breaks `cleo docs add`. A persisted projectRoot is ignored, `doctor project-identity --resolve` strips it with a receipt, projectHash stays a write-once identity key, and `cleo briefing` warns about identity problems"
---
**`cleo docs add` failed projection after any move.** `.cleo/project-info.json`
can hold an absolute `projectRoot`. `cleo project move` writes one, and older
Linux stores have `/mnt/...` values. `captureDocumentProjection` and five
knowledge-repair scope checks compared that string with the real root. After a
`mv`, every docs projection returned `coverage: missing` with "Canonical
project-info root differs from the captured project root".

- Identity is the `projectId`. Docs projection and `doctor knowledge` no longer
  compare against a persisted `projectRoot`, which is a path fact derived at
  runtime.
- `projectHash` is an identity key, not a path fact. It keys audit rows,
  idempotency and release ids. `cleo init` writes it once and keeps an existing
  value on `--force`. The project-info regenerator keeps an existing value
  instead of recomputing it. A legacy file without one gets a value computed
  from the real path of the main checkout and saved once. A task worktree and
  a symlinked spelling such as `/tmp` vs `/private/tmp` therefore get the same
  hash as the main checkout.
- Release ids use that same persisted hash everywhere. Before this, `plan`
  used the persisted value while `reconcile` and the release-manifest writers
  hashed the current path. A moved project got split release ids, and its
  `release_commits` pointed at a missing `releases` row. Portable-bundle
  relocation no longer recomputes the hash.
- `cleo upgrade` and other `init --force` callers keep `previousProjectIds`,
  `strippedFields` and `description`. Before, they erased these receipts. The
  schema now declares `previousProjectIds` and `strippedFields`, each with
  `maxItems` 50, so a resolved project stays schema-valid.
- `renameProject` keeps the stored `projectHash`; before, it re-derived it from
  the path. It no longer writes `projectRoot` back: a legacy value is recorded
  in `strippedFields` and removed.
- The hashless backfill is a compare-and-swap. It writes only if the file still
  has no hash and still has the same `projectId`, so a concurrent re-key is
  never overwritten.
- `cleo doctor project-identity` lists a persisted `projectRoot` in
  `project-info.json` or `project-context.json` under `derivedFields`.
  `--resolve` strips it (`--dry-run` shows the plan) and keeps each removed
  value in `project-info.json` `strippedFields`. The plan says when
  `project-context.json` is git-tracked, because the strip then changes a
  tracked file. `projectHash` is never touched.
- On a CLEO root that is not a git work tree, the `missing` and `invalid`
  remedies no longer tell you to run git commands. The git probes now have a
  timeout.
- `cleo briefing` adds one warning with the remedy when project identity is not
  `ok`, for example when `.cleo/project-id` is missing or conflicts.
