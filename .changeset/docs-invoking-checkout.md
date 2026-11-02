---
id: docs-invoking-checkout
tasks: [T14188]
kind: fix
summary: "docs status, doctor and modernize run from a CLEO worktree read that worktree's docs/, with the store kept at the project root"
---

Run from a CLEO worktree, `cleo docs status`, `cleo docs doctor` and
`cleo docs modernize` read docs/ from the root checkout, which can sit on
another branch.

- `docs status` and the doctor's publication-ledger check compare the project
  store against the invoking checkout's mirrors, and ask that checkout's git
  whether a missing mirror is gone.
- `docs modernize` resolves its folder, `--plan`, `--overrides` and `--out`
  against the invoking checkout, and reads, renames and writes files there.
  Its plan and receipt may name a root inside that checkout, and rollback
  accepts it.
- The docs store, publication ledger, modernize journal, receipts and backups
  stay at the project root, and an explicit `CLEO_ROOT` still wins for both.
- `docs triage` reads only the store, so it is unchanged.
