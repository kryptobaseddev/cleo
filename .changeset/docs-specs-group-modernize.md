---
id: docs-specs-group-modernize
tasks: [T14108]
kind: docs
summary: "docs/specs and docs/spec modernized into docs/spec, docs/plan and docs/guide with slug names; cleo check canon and detect-drift read the moved specs"
---

T14108 group 1: `cleo docs modernize` folded the legacy `docs/specs/` folder
and the root `docs/RELEASING.md` into the kind folders with slug file names
(36 renames, 7 verbatim merges, 11 kept), re-pointed 15 inbound links from
other docs folders, and shrank the docs-name baseline by 37 entries.
`cleo check canon` and `cleo detect-drift` now read the operation constitution
and the Portable Brain spec at their new paths (one constant each in
`packages/cleo/src/cli/paths.ts`), and code comments, skills and AGENTS.md
cite the new paths.
