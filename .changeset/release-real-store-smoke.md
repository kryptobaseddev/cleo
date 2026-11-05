---
id: release-real-store-smoke
tasks: [T14250]
kind: feat
summary: "the release smoke now runs each durability phase's write paths on real-store copies and blocks the stable cut when one fails"
---

`scripts/release-mac-smoke.mjs` (T14104) already ran the built CLI on a
read-only copy of the real stores. Each durability phase now runs it before
its stable cut, and it covers what those phases change:

- a cancel cascade, `done --plan` on an epic whose children are all settled,
  a docs fetch (blobs and attachments are copied too) and an admission report
  from `cleo run`, after the existing reads and task write;
- the copy's test commands are replaced by one that exits 97, so no step can
  start a test suite from the sandbox;
- `--project <dir>` (repeatable) smokes more than one project's store;
- a step also fails on store-failure text in stderr (no such table, error in
  view, malformed, migration failure), or on a `success:false` envelope;
- `results.json` records the commands, each store, the CLI version and the
  result, and `--record <taskId>` attaches it to the release epic with the
  installed cleo.

A non-zero exit blocks the stable cut. Ledger: adds a release checklist step;
deletes nothing.
