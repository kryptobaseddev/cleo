---
id: docs-modernize
tasks: [T14113]
kind: feat
summary: "new cleo docs modernize <path>: turns a messy docs folder into clean, linked CleoDocs, with a dry-run plan, System One judgments, an apply receipt and rollback"
---

`cleo docs modernize <path>` composes the existing docs pieces (the import
scanner, slug normalisation, the attachment store, `docs update`,
`docs supersede` and the wikilinks graph) into one flow:

- **Dry run (default).** For every `.md` and `.txt` file the plan proposes a
  kind, a stable slug with no task, session or date tokens, and a disposition
  (`keep`, `rename`, `merge-into` or `delete`), with reasons. `--out plan.json`
  saves it for review; `--apply --plan plan.json` applies a reviewed plan as
  written.
- **System One.** Ambiguous calls go to two new registered decision sites:
  `docs.modernize.classify` (a kind the folder, name and heading rules could
  not settle) and `docs.modernize.merge` (two docs sharing a slug with middling
  line similarity). The rule answers when System One is unreachable. Every
  judgment is recorded on the plan row and in `decisions.jsonl`. Both sites
  default to `shadow`.
- **Apply.** Survivors are stored under their slug. A survivor whose slug the
  store already holds updates that doc instead of adding a twin. Duplicates
  fold their new sections into the survivor and are stored under their old
  name, then superseded by it. Files move to `<kind folder>/<slug>.md` and
  emptied folders are removed. Relative `.md` links become `[[slug]]`
  wikilinks. Each step and the bytes it replaced go into a receipt under
  `.cleo/modernize/`. `--rollback <runId>` reverses the run.
- **Safety.** Apply refuses a root git cannot vouch for (`--allow-dirty`
  overrides), checks every plan and receipt against a schema, and refuses paths
  that leave the root or are symlinks. Every step is written to a write-ahead
  journal (`<runId>.ops.jsonl`) before it acts. Rollback restores the replaced
  rows and pointers exactly, resumes where it stopped, and refuses to overwrite
  a file edited since. Merging never drops content, and same-named docs in
  different folders are never merged by rule.

The docs graph gains a `links-to` relation. Body `[[slug]]` wikilinks are now
recorded as edges on every docs write (`docs add`, `docs update`, modernize),
and a graph rebuild keeps them.
